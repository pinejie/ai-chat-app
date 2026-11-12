// --- Per-Session Context: each session owns its COMPLETE DOM ---
// Messages + Input area + Buttons — all per-session.
// Switching = show/hide. No save/restore needed.

// 输入框高度：自动模式上限 + 手动拖拽模式（全局共享，存 localStorage）
const INPUT_MAX_H = 280;                      // 与 style.css .input-box textarea 的 max-height 保持一致
const INPUT_MANUAL_MIN_H = 80;                // 手动拖拽的下限（一行 + 工具栏）
const INPUT_MANUAL_KEY = 'zd_input_manual_h'; // 拖拽结果（px）；无该键 = 自动增高模式

// 长对话渲染参数
// HISTORY_PAGE_SIZE：首屏/每次向上加载的消息条数。历史数组完整留在内存，DOM 只保留已加载窗口。
// STREAM_RENDER_INTERVAL_MS：流式渲染节流间隔。CLI 每个内容块一个 assistant 事件，不节流会每次全量重解析。
// STREAM_TAIL_MAX：流式气泡尾部保留的最大未定稿字符数；此前的内容按空行切段增量追加，避免 O(n²)。
const HISTORY_PAGE_SIZE = 40;
const STREAM_RENDER_INTERVAL_MS = 80;
const STREAM_TAIL_MAX = 4096;
const SCROLL_BOTTOM_SLACK = 80;               // 距底部小于该值视为“用户还在看最新内容”

const SESSION_HTML = `
  <div class="header"><span class="header-title">ZD Code</span></div>
  <div class="messages"><div class="messages-inner"></div></div>
  <div class="input-area">
    <div class="input-resize-handle" title="拖动调整输入区高度，双击恢复自动增高"></div>
    <div class="input-inner">
      <div class="send-hint"></div>
      <div class="input-box">
        <textarea class="chat-textarea" rows="1" placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"></textarea>
        <div class="input-toolbar">
          <button class="upload-btn" title="上传文件">&#128206;</button>
          <div class="toolbar-spacer"></div>
          <select class="model-select" title="选择模型（同 CLI /model）"><option value="default">默认模型</option></select>
          <select class="mode-select" title="权限模式"><option value="acceptEdits">自动编辑</option></select>
          <button class="stop-btn" style="display:none" title="停止生成">&#9632;</button>
          <button class="send-btn" disabled>&#8593;</button>
        </div>
        <div class="file-preview" style="display:none"></div>
      </div>
    </div>
  </div>`;

function newSessionCtx(sid) {
  const container = document.createElement('div');
  container.className = 'session-container';
  container.innerHTML = SESSION_HTML;
  document.getElementById('chatMain').appendChild(container);
  container.style.display = 'none';

  const q = sel => container.querySelector(sel);
  const ctx = {
    sid,
    container,
    q,
    // Messages
    messagesEl: q('.messages'),
    messagesInner: q('.messages-inner'),
    // Input
    inputEl: q('.chat-textarea'),
    sendBtn: q('.send-btn'),
    stopBtn: q('.stop-btn'),
    uploadBtn: q('.upload-btn'),
    filePreview: q('.file-preview'),
    sendHint: q('.send-hint'),
    modeSelect: q('.mode-select'),
    modelSelect: q('.model-select'),
    // Streaming state
    streamingText: '',
    streamingThinking: '',
    isGenerating: false,
    assistantEl: null,
    finalAssistantHtml: '',
    // Input state
    inputState: { history: [], index: -1, tempInput: '' },
    inputManualH: null,   // 非 null = 手动拖拽高度（px），自动增高暂停
    // History state：history 保留服务端全量消息，DOM 只渲染 [historyStart, end) 这一段
    history: [],
    historyStart: 0,
    historyLoaded: false,
    loadEarlierEl: null,
    // Scroll 状态：用户主动上翻后不再被流式更新拽回底部
    atBottom: true,
    scrollForce: false,
    // Pending scroll-to-bottom frame id
    scrollRaf: 0,
  };

  // Wire up per-session event listeners
  _attachSessionListeners(ctx);
  populateSettingSelects(ctx);
  return ctx;
}

// --- 输入区拖动调整高度（VSCode 式分割线） ---
// 按住输入区顶部的热区上下拖动手动固定高度；双击恢复自动增高。
// 高度经 localStorage 全局记忆；手动模式下上方 input 监听跳过自增高。
function _bindInputResizeHandle(ctx) {
  const handle = ctx.container.querySelector('.input-resize-handle');
  if (!handle) return;

  // 用兼容鼠标事件（mousedown 系）而非 pointer 事件驱动拖拽：
  // pointer 链路可能被门户注入/扩展整体吞掉（症状：hover 正常但拖不动且无任何报错），
  // mousedown/mousemove/mouseup 是桌面浏览器最不可能缺席的一条路。move/up 挂 window 防丢失。
  handle.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const input = ctx.inputEl;
    const startY = e.clientY;
    const startH = input.getBoundingClientRect().height;
    const maxH = Math.floor(window.innerHeight * 0.6);
    let moved = false;
    handle.classList.add('dragging');
    document.body.classList.add('input-resizing');

    function onMove(ev) {
      moved = true;
      const h = Math.min(Math.max(Math.round(startH - (ev.clientY - startY)), INPUT_MANUAL_MIN_H), maxH);
      ctx.inputManualH = h;
      input.style.maxHeight = 'none';   // 手动高度可以超过自动上限
      input.style.height = h + 'px';
    }
    function onUp() {
      handle.classList.remove('dragging');
      document.body.classList.remove('input-resizing');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (!moved) return;               // 纯点击（含双击的第一击）不改状态、不写存储
      _saveManualInputH(ctx.inputManualH);
      _syncInputHeightToAllSessions(ctx);
      input.focus();
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  handle.addEventListener('dblclick', function() {
    ctx.inputManualH = null;
    _saveManualInputH(null);
    ctx.inputEl.style.height = '';
    ctx.inputEl.style.maxHeight = '';
    ctx.inputEl.dispatchEvent(new Event('input'));  // 触发一次自增高，回到当前内容应有的高度
    _syncInputHeightToAllSessions(ctx);
  });

  _applyManualInputH(ctx);
}

// 输入区高度是全局设置（localStorage 记忆）；已创建的各会话 DOM 也立即同步，不等刷新
function _syncInputHeightToAllSessions(src) {
  for (const c of sessionCtxs.values()) {
    if (c === src) continue;
    if (src.inputManualH != null) {
      c.inputManualH = src.inputManualH;
      c.inputEl.style.maxHeight = 'none';
      c.inputEl.style.height = src.inputManualH + 'px';
    } else {
      c.inputManualH = null;
      c.inputEl.style.height = '';
      c.inputEl.style.maxHeight = '';
      c.inputEl.dispatchEvent(new Event('input'));
    }
  }
}

function _saveManualInputH(h) {
  try {
    if (h == null) localStorage.removeItem(INPUT_MANUAL_KEY);
    else localStorage.setItem(INPUT_MANUAL_KEY, String(Math.round(h)));
  } catch {}
}

function _applyManualInputH(ctx) {
  let raw = null;
  try { raw = localStorage.getItem(INPUT_MANUAL_KEY); } catch {}
  if (raw == null) return;
  const h = parseInt(raw, 10);
  if (!Number.isFinite(h)) return;
  ctx.inputManualH = Math.min(Math.max(h, INPUT_MANUAL_MIN_H), Math.floor(window.innerHeight * 0.6));
  ctx.inputEl.style.maxHeight = 'none';
  ctx.inputEl.style.height = ctx.inputManualH + 'px';
}

function _attachSessionListeners(ctx) {
  // Keyboard: Enter to send, ArrowUp/Down for history
  ctx.inputEl.addEventListener('keydown', function(e) {
    if (currentCtx !== ctx) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (messageHistory.length === 0) return;
      if (historyIndex === -1) tempInput = this.value;
      if (historyIndex < messageHistory.length - 1) {
        historyIndex++;
        this.value = messageHistory[messageHistory.length - 1 - historyIndex];
      }
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex === -1) return;
      historyIndex--;
      if (historyIndex === -1) this.value = tempInput;
      else this.value = messageHistory[messageHistory.length - 1 - historyIndex];
    }
  });
  // Auto-resize textarea（手动拖拽模式下不生效）
  ctx.inputEl.addEventListener('input', function() {
    if (ctx.inputManualH != null) return;
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, INPUT_MAX_H) + 'px';
  });
  _bindInputResizeHandle(ctx);
  // 权限模式 / 模型：改动后立即保存到当前对话
  ctx.modeSelect.addEventListener('change', function() {
    saveSessionSetting(ctx, 'mode', this.value);
  });
  ctx.modelSelect.addEventListener('change', function() {
    saveSessionSetting(ctx, 'model', this.value);
  });
  // Upload button → trigger global file input
  ctx.uploadBtn.addEventListener('click', function() {
    if (currentCtx !== ctx) return;
    document.getElementById('fileInput').click();
  });
  // Send / Stop buttons
  ctx.sendBtn.addEventListener('click', function() {
    if (currentCtx !== ctx) return;
    sendMessage();
  });
  ctx.stopBtn.addEventListener('click', function() {
    if (currentCtx !== ctx) return;
    stopGeneration();
  });
  // Drag & drop
  ctx.container.querySelector('.input-area').addEventListener('dragover', e => {
    e.preventDefault(); e.stopPropagation();
  });
  ctx.container.querySelector('.input-area').addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation();
    if (currentCtx !== ctx || isGenerating) return;
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    const maxSize = 20 * 1024 * 1024;
    for (const file of files) {
      if (file.size > maxSize) { alert(`文件 ${file.name} 超过 20MB 限制`); return; }
    }
    selectedFiles = selectedFiles.concat(files);
    renderFilePreview();
  });
  // 滚动位置决定流式更新是否继续跟随底部；接近顶部时按页加载更早历史
  ctx.messagesEl.addEventListener('scroll', function() {
    const el = ctx.messagesEl;
    ctx.atBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < SCROLL_BOTTOM_SLACK;
    if (ctx === currentCtx && el.scrollTop < 120 && el.scrollHeight > el.clientHeight + 40) {
      scheduleLoadEarlier(ctx);
    }
  }, { passive: true });
}

let sessionCtxs = new Map();
let currentCtx = null;

function switchCtx(targetSid) {
  cancelStreamRender();
  // Save globals back to current ctx
  if (currentCtx) {
    currentCtx.isGenerating = isGenerating;
    currentCtx.streamingText = streamingText;
    currentCtx.streamingThinking = streamingThinking;
    currentCtx.assistantEl = currentAssistantEl;
    currentCtx.messagesInner.style.display = 'none';
    currentCtx.container.style.display = 'none';
  }
  // Create or get target ctx
  if (!sessionCtxs.has(targetSid)) {
    sessionCtxs.set(targetSid, newSessionCtx(targetSid));
  }
  currentCtx = sessionCtxs.get(targetSid);
  currentSessionId = targetSid;
  currentCtx.messagesInner.style.display = '';
  currentCtx.container.style.display = '';
  // Restore globals from target ctx
  isGenerating = currentCtx.isGenerating;
  streamingText = currentCtx.streamingText;
  streamingThinking = currentCtx.streamingThinking;
  currentAssistantEl = currentCtx.assistantEl;
}

function removeCtx(sid) {
  const ctx = sessionCtxs.get(sid);
  if (ctx) {
    ctx.container.remove();
    sessionCtxs.delete(sid);
  }
}

// --- Chat List ---

async function loadChatList() {
  const res = await fetch(API + '/api/sessions');
  const list = await res.json();
  refreshSessionSettings(list);
  chatListCache = list;
  renderChatList(list);
  renderWorkspaceDir();
  return list;
}

/* 顶栏标题：有对话显示会话标题（超长由 CSS 省略，悬停 title 看全称），
   无对话回退品牌字"ZD Code"。改名/自动改标题/删除都汇到 renderChatList 刷新。 */
function renderHeaderTitle() {
  if (!currentCtx) return;
  const h = currentCtx.container.querySelector('.header-title');
  if (!h) return;
  const s = chatListCache.filter(function (c) { return c.id === currentSessionId; })[0];
  const title = currentSessionId ? ((s && s.title) || '新对话') : 'ZD Code';
  h.textContent = title;
  h.title = title;
}

function renderChatList(list) {
  dragAbort();                                      // 列表重建先中止在途拖拽，防 pointerup 落空导致状态悬挂
  const el = document.getElementById('chatList');
  el.innerHTML = '';
  for (const item of list) {
    const div = document.createElement('div');
    div.className = 'chat-item' + (item.id === currentSessionId ? ' active' : '');
    const titleSpan = document.createElement('span');
    titleSpan.className = 'chat-title';
    titleSpan.textContent = item.title || '新对话';
    titleSpan.ondblclick = function(e) { e.stopPropagation(); if (dragSuppressClick()) return; enableRename(this, item.id); };
    const delSpan = document.createElement('span');
    delSpan.className = 'chat-delete';
    delSpan.innerHTML = '\u00d7';
    // 删除不可逆，点 × 先弹全局确认层（showConfirm 在 project.js），确认才真删
    delSpan.onclick = function(e) {
      e.stopPropagation();
      if (dragSuppressClick()) return;
      showConfirm('删除对话', '确定删除「' + (item.title || '新对话') + '」？删除后不可恢复。',
        function () { deleteChat(item.id); });
    };
    div.innerHTML = '';
    div.dataset.sid = item.id;                     // 拖拽排序的数据锚点
    div.appendChild(titleSpan);
    div.appendChild(delSpan);
    div.title = item.workspace_path || '默认目录';   // 悬停可见每条对话的目录
    div.onclick = () => { if (!dragSuppressClick()) switchChat(item.id); };
    attachDragSort(div);
    el.appendChild(div);
  }
  renderHeaderTitle();
}

/* --- 手动排序（整行拖拽，纯 Pointer Events 不引库）---
   按下竖移不足 5px 完全不进入拖拽（点击打开/双击改名/× 删除零影响）；
   超阈值拖起：本行跟手，from..to 之间兄弟行让位，松手提交 reorder 后以服务端为准。
   与移动端 mobile.js 把手拖拽互为镜像，改动必须两端同步：
   - move/up 绑 window，capture 拖起后才设——按下即 capture 会把 click 重定向到整行，× 删除、双击改名全被吞；
   - 列表重建（loadChatList）先中止在途拖拽；
   - 目标位计入滚动偏移 + 边缘自动滚动；兄弟行仅在目标槽位变化时重排。 */
const DRAG_THRESHOLD_PX = 5, DRAG_EDGE_PX = 28, DRAG_SCROLL_PX = 6;
let dragCtx = null;
let dragSuppressUntil = 0;
function dragSuppressClick() { return Date.now() < dragSuppressUntil; }

function dragScrollParent(node) {
  let p = node ? node.parentElement : null;
  while (p) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) return p;
    p = p.parentElement;
  }
  return null;
}
function dragAbort() {
  if (!dragCtx) return;
  const d = dragCtx; dragCtx = null;
  if (d.raf) cancelAnimationFrame(d.raf);
  window.removeEventListener('pointermove', pcMove);
  window.removeEventListener('pointerup', pcUp);
  window.removeEventListener('pointercancel', pcUp);
}
function dragUpdate(clientY) {
  const d = dragCtx; if (!d) return;
  const shift = d.scroller ? d.scroller.scrollTop - d.startScroll : 0;
  const eff = clientY - d.startY + shift;           // 滚动补偿入 transform，行始终跟手
  d.row.style.transform = 'translateY(' + eff + 'px)';
  const maxIdx = d.rows.length - 1;
  d.toIdx = Math.max(0, Math.min(maxIdx, d.fromIdx + Math.round(eff / (d.step || 1))));
  if (d.toIdx === d.appliedTo) return;
  d.appliedTo = d.toIdx;
  d.rows.forEach(function (r, i) {
    if (r === d.row) return;
    let t = 0;
    if (d.toIdx > d.fromIdx && i > d.fromIdx && i <= d.toIdx) t = -d.step;
    else if (d.toIdx < d.fromIdx && i >= d.toIdx && i < d.fromIdx) t = d.step;
    r.style.transform = t ? 'translateY(' + t + 'px)' : '';
  });
}
function dragAutoScroll(e) {
  const d = dragCtx; if (!d || !d.scroller) return;
  const rect = d.scroller.getBoundingClientRect();
  let dir = 0;
  if (e.clientY < rect.top + DRAG_EDGE_PX) dir = -1;
  else if (e.clientY > rect.bottom - DRAG_EDGE_PX) dir = 1;
  else if (e.clientX < rect.left || e.clientX > rect.right) dir = 0;
  if (dir === 0) { if (d.raf) { cancelAnimationFrame(d.raf); d.raf = null; } return; }
  if (d.raf) return;
  d.lastY = e.clientY;
  const tick = function () {
    if (!dragCtx || !dragCtx.raf) return;
    dragCtx.scroller.scrollTop += dir * DRAG_SCROLL_PX;
    dragUpdate(dragCtx.lastY);
    dragCtx.raf = requestAnimationFrame(tick);
  };
  d.raf = requestAnimationFrame(tick);
}
function pcMove(e) {
  const d = dragCtx; if (!d || e.pointerId !== d.pointerId) return;
  if (!d.dragging) {
    if (Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD_PX) return;
    d.dragging = true;
    d.row.classList.add('dragging');
    try { d.row.setPointerCapture(d.pointerId); } catch (err) {}   // 确认是拖拽才 capture，纯点击不设
  }
  d.lastY = e.clientY;
  dragUpdate(e.clientY);
  dragAutoScroll(e);
}
function pcUp(e) {
  const d = dragCtx; if (!d || (e && e.pointerId !== d.pointerId)) return;
  window.removeEventListener('pointermove', pcMove);
  window.removeEventListener('pointerup', pcUp);
  window.removeEventListener('pointercancel', pcUp);
  if (d.raf) cancelAnimationFrame(d.raf);
  dragCtx = null;
  if (!d.dragging) return;                          // 没超阈值：一次普通点击，交给原 onclick
  dragSuppressUntil = Date.now() + 350;             // 拖尾 click 不是用户意图，压掉
  d.row.classList.remove('dragging');
  d.rows.forEach(function (r) { r.style.transform = ''; });
  if (d.toIdx !== d.fromIdx) commitOrder(d);
}

function attachDragSort(div) {
  div.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || dragCtx) return;
    if (e.target.closest('.chat-delete')) return;   // × 上的按下交给删除流程，不进拖拽
    if (e.target.tagName === 'INPUT') return;       // 改名输入编辑中，不抢文本选择
    const box = document.getElementById('chatList');
    const rows = Array.prototype.slice.call(box.children);
    const fromIdx = rows.indexOf(div);
    if (fromIdx < 0) return;
    dragCtx = { row: div, rows: rows, fromIdx: fromIdx, toIdx: fromIdx, appliedTo: fromIdx,
                startY: e.clientY, lastY: e.clientY, pointerId: e.pointerId, dragging: false, raf: null,
                scroller: dragScrollParent(box), startScroll: 0,
                step: rows.length > 1 ? rows[1].offsetTop - rows[0].offsetTop : 0 };
    dragCtx.startScroll = dragCtx.scroller ? dragCtx.scroller.scrollTop : 0;
    window.addEventListener('pointermove', pcMove);
    window.addEventListener('pointerup', pcUp);
    window.addEventListener('pointercancel', pcUp);
  });
}

async function commitOrder(d) {
  const ids = d.rows.map(function (r) { return r.dataset.sid; });
  const moved = ids.splice(d.fromIdx, 1)[0];
  ids.splice(d.toIdx, 0, moved);
  try {
    const res = await fetch(API + '/api/sessions/reorder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids }),
    });
    if (!res.ok) { const j = await res.json().catch(function () { return {}; }); throw new Error(j.detail || res.status); }
  } catch (e) { addSystemMsg('排序失败：' + e.message); }
  await loadChatList();                             // 成功同步、失败借重拉回滚视觉
}

async function deleteChat(sessionId) {
  await fetch(API + '/api/sessions/' + sessionId, { method: 'DELETE' });
  if (wsMap.has(sessionId)) { wsMap.get(sessionId).close(); wsMap.delete(sessionId); }
  sessionConnected.delete(sessionId);
  removeCtx(sessionId);
  if (sessionId === currentSessionId) {
    currentSessionId = '';
    currentCtx = null;
    streamingText = ''; streamingThinking = ''; isGenerating = false; currentAssistantEl = null;
    updateConnectedUI();
  }
  await loadChatList();
}

// --- Session Management ---

async function newChat() {
  // 多工作目录：创建前先弹目录选择（默认项预选），确认后才真正建对话
  wsPickOpen('new', createSessionWith);
}

async function createSessionWith(workspaceId) {
  // Save current state
  if (currentCtx) {
    currentCtx.isGenerating = isGenerating;
    currentCtx.streamingText = streamingText;
    currentCtx.streamingThinking = streamingThinking;
    currentCtx.assistantEl = currentAssistantEl;
    currentCtx.messagesInner.style.display = 'none';
    currentCtx.container.style.display = 'none';
  }
  // Reset globals
  messageHistory = []; historyIndex = -1; tempInput = '';
  selectedFiles = [];
  streamingText = ''; streamingThinking = ''; isGenerating = false; currentAssistantEl = null;

  try {
    const res = await fetch(API + '/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
    const data = await res.json();
    switchCtx(data.session_id);
    currentCtx.historyLoaded = true; // New session, no history to load
    document.getElementById('sessionId').textContent = currentSessionId.slice(0, 8) + '...';
    connectWS();
    await loadChatList();
    renderWorkspaceDir();
    loadProjects();   // 文档面板跟随新对话的目录
  } catch (err) {
    addSystemMsg('创建对话失败: ' + err.message);
  }
}

async function switchChat(sessionId) {
  if (sessionId === currentSessionId) return;

  // Save current globals + switch container
  switchCtx(sessionId);
  renderHeaderTitle();   // 切换即刷新顶栏（此路径不经过 renderChatList）

  // Update sidebar
  document.getElementById('sessionId').textContent = sessionId.slice(0, 8) + '...';
  renderWorkspaceDir();
  loadProjects();   // 文档面板跟随当前对话的目录

  // Reset shared resources
  selectedFiles = [];
  renderFilePreview();

  // Restore button state from ctx
  showStopBtn(currentCtx.isGenerating);

  // Only load history if this container hasn't been populated yet (lazy loading)
  if (!currentCtx.historyLoaded) {
    try {
      const res = await fetch(API + '/api/sessions/' + sessionId + '/history');
      const history = await res.json();
      currentCtx.history = Array.isArray(history) ? history : [];
      renderHistoryWindow(currentCtx, true);
      currentCtx.historyLoaded = true;
    } catch (err) {
      addSystemMsg('加载历史失败: ' + err.message);
    }
  }

  // Re-attach to existing streaming bubble in DOM, or create if needed
  if (currentCtx.isGenerating && (currentCtx.streamingText || currentCtx.streamingThinking)) {
    // Try to find existing bubble in DOM first (from before we switched away)
    var existingBubble = currentCtx.messagesInner.querySelector('.msg-assistant:last-child');
    if (existingBubble) {
      currentCtx.assistantEl = existingBubble;
      currentAssistantEl = existingBubble;
    } else {
      currentCtx.assistantEl = null;
      ensureAssistantBubble();
    }
    updateStreamingBubble();
  } else if (!currentCtx.isGenerating && currentCtx.finalAssistantHtml) {
    // Check if bubble was already updated in DOM (by non-current result handler)
    var existingBubble = currentCtx.messagesInner.querySelector('.msg-assistant:last-child');
    if (!existingBubble) {
      // No existing bubble — create one with final content
      const el = document.createElement('div');
      el.className = 'msg msg-assistant';
      el.innerHTML = '<div class="bubble">' + currentCtx.finalAssistantHtml + '</div>';
      currentCtx.messagesInner.appendChild(el);
    }
    currentCtx.finalAssistantHtml = '';
  }

  scrollBottom(true);

  // Re-assert button state
  showStopBtn(currentCtx.isGenerating);

  // Check backend generating status on switch
  fetch(API + "/api/sessions/" + sessionId + "/generating")
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (currentCtx && currentCtx.sid === sessionId && data.generating !== currentCtx.isGenerating) {
        if (!data.generating && currentCtx.isGenerating) {
          // Backend done but result was lost — force finalize
          streamingText = currentCtx.streamingText;
          streamingThinking = currentCtx.streamingThinking;
          isGenerating = false;
          currentAssistantEl = currentCtx.assistantEl;
          finalizeStreaming(true);
          currentCtx.isGenerating = false;
          currentCtx.streamingText = ''; currentCtx.streamingThinking = '';
          currentCtx.assistantEl = null;
          currentAssistantEl = null;
        }
        showStopBtn(data.generating);
      }
    })
    .catch(function() {});

  // 权限模式 / 模型：来自服务端保存的对话设置
  applySettingsToCtx(currentCtx);

  if (!wsMap.has(sessionId)) { connectWS(); }
  updateConnectedUI();
  await loadChatList();
}

// --- WebSocket ---

function connectWS() {
  if (wsMap.has(currentSessionId)) { wsMap.get(currentSessionId).close(); }
  const socket = new WebSocket(WS + '/ws/' + currentSessionId);
  wsMap.set(currentSessionId, socket);
  const sid = currentSessionId;
  // 旧 socket 被 close() 后，其 onclose 是异步触发的，可能晚于新 socket 的 onopen。
  // 不加此判断会把新连接错误地显示为"未连接"并禁用发送按钮。
  const isStale = () => wsMap.get(sid) !== socket;
  socket.onopen = () => {
    if (isStale()) return;
    sessionConnected.set(sid, true);
    if (sid === currentSessionId) updateConnectedUI();
  };
  socket.onclose = () => {
    if (isStale()) return;
    sessionConnected.set(sid, false);
    if (sid === currentSessionId) updateConnectedUI();
    // If this conversation was generating, check backend for real status
    if (sessionCtxs.has(sid)) {
      var ctx = sessionCtxs.get(sid);
      if (ctx.isGenerating) {
        setTimeout(function() {
          fetch(API + "/api/sessions/" + sid + "/generating")
            .then(function(r) { return r.json(); })
            .then(function(data) {
              if (!data.generating && ctx.isGenerating) {
                // Result was lost — force finalize for this conversation
                if (sid === currentSessionId) {
                  streamingText = ctx.streamingText;
                  streamingThinking = ctx.streamingThinking;
                  currentAssistantEl = ctx.assistantEl;
                  finalizeStreaming(true);
                } else if (ctx.assistantEl && (ctx.streamingText || ctx.streamingThinking)) {
                  var html = '';
                  if (ctx.streamingThinking) html += '<details open><summary class="thinking-summary">思考过程</summary><div class="thinking-content">' + safeMd(ctx.streamingThinking) + '</div></details>';
                  if (ctx.streamingText) html += safeMd(ctx.streamingText);
                  ctx.assistantEl.querySelector('.bubble').innerHTML = html;
                }
                ctx.isGenerating = false;
                ctx.streamingText = ''; ctx.streamingThinking = '';
                ctx.assistantEl = null;
                if (sid === currentSessionId) {
                  isGenerating = false;
                  currentAssistantEl = null;
                  showStopBtn(false);
                }
              }
            })
            .catch(function() {});
        }, 1000);
      }
    }
  };
  socket.onerror = () => {
    if (isStale()) return;
    sessionConnected.set(sid, false);
    if (sid === currentSessionId) updateConnectedUI();
  };
  socket.onmessage = e => {
    try { handleMsg(JSON.parse(e.data), sid); } catch {}
  };
}

function updateConnectedUI() {
  const v = sessionConnected.get(currentSessionId) || false;
  document.getElementById('statusDot').className = 'status-dot ' + (v ? 'on' : 'off');
  document.getElementById('statusText').textContent = v ? '已连接' : '未连接';
  if (currentCtx) currentCtx.sendBtn.disabled = !v;
}

function reconnect() {
  if (wsMap.has(currentSessionId)) { wsMap.get(currentSessionId).close(); wsMap.delete(currentSessionId); }
  connectWS();
}

// --- Streaming ---

function resetStreaming() {
  cancelStreamRender();
  streamingText = ''; streamingThinking = ''; currentAssistantEl = null; isGenerating = false;
  if (currentCtx) {
    currentCtx.streamingText = '';
    currentCtx.streamingThinking = '';
    currentCtx.assistantEl = null;
    currentCtx.isGenerating = false;
  }
  showStopBtn(false);
}

function showStopBtn(show) {
  isGenerating = show;
  if (currentCtx) currentCtx.isGenerating = show;
  if (!currentCtx) return;
  currentCtx.stopBtn.style.display = show ? 'inline-block' : 'none';
  currentCtx.sendBtn.style.display = show ? 'none' : 'flex';
  currentCtx.inputEl.placeholder = show ? '等待回复中，可继续输入但不能发送' : '输入消息... (Enter 发送, Shift+Enter 换行)';
  currentCtx.uploadBtn.disabled = show;
}

let blockedHintTimer = null;
function notifyBlockedSend() {
  if (!currentCtx) return;
  const inputEl = currentCtx.inputEl;
  const hint = currentCtx.sendHint;
  inputEl.classList.remove('shake');
  void inputEl.offsetWidth;
  inputEl.classList.add('shake');
  if (hint) {
    hint.textContent = '回复还在路上，发不出去哦，再等等～';
    hint.classList.add('show');
    clearTimeout(blockedHintTimer);
    blockedHintTimer = setTimeout(() => hint.classList.remove('show'), 1500);
  }
}

async function stopGeneration() {
  if (!currentSessionId) return;
  cancelStreamRender();
  isGenerating = false;
  if (currentCtx) currentCtx.isGenerating = false;
  if (currentAssistantEl) {
    currentAssistantEl.remove();
    currentAssistantEl = null;
    if (currentCtx) currentCtx.assistantEl = null;
  }
  streamingText = ""; streamingThinking = "";
  if (currentCtx) { currentCtx.streamingText = ''; currentCtx.streamingThinking = ''; }
  showStopBtn(false);
  try {
    await fetch(API + "/api/sessions/" + currentSessionId + "/stop", { method: "POST" });
  } catch (err) {
    console.error("Failed to stop:", err);
  }
}

// --- Message Handling ---

function handleMsg(msg, sid) {
  sid = sid || currentSessionId;
  if (msg.type === 'system' && msg.subtype === 'init') return;
  if (msg.type === 'trace') return;   // 链路追踪已移除，旧后端/缓存的 trace 事件直接丢弃
  if (!sessionCtxs.has(sid)) return;
  const ctx = sessionCtxs.get(sid);
  const isCurrent = (sid === currentSessionId);

  if (isCurrent) {
    streamingText = ctx.streamingText;
    streamingThinking = ctx.streamingThinking;
    isGenerating = ctx.isGenerating;
    currentAssistantEl = ctx.assistantEl;
  }

  if (msg.type === 'assistant') {
    const content = msg.message?.content;
    if (!content) return;
    // CLI 的 stream-json 是「每个内容块一个 assistant 事件」，所以必须在已有的流式状态上累加，
    // 不能每次从空字符串重新开始，否则前面的思考/文本会被覆盖丢失。
    let st = ctx.streamingText || '', sth = ctx.streamingThinking || '';
    for (const block of content) {
      if (block.type === 'thinking') { sth += (block.thinking || block.text || ''); }
      else if (block.type === 'text') { st += (block.text || ''); }
      else if (block.type === 'tool_use') {
        // 工具调用前的文本先定稿成独立气泡，之后的文本开新气泡
        if (isCurrent) {
          streamingText = st; streamingThinking = sth;
          ctx.streamingText = st; ctx.streamingThinking = sth;
          finalizeStreaming(false);
          addToolMsg(block.name, block.input ? JSON.stringify(block.input, null, 2) : '');
        }
        st = ''; sth = '';
      }
      else if (block.type === 'tool_result') {
        if (isCurrent) addToolMsg('result', typeof block.content === 'string' ? block.content : JSON.stringify(block.content || ''));
      }
    }
    ctx.streamingText = st;
    ctx.streamingThinking = sth;
    if (isCurrent) {
      streamingText = st; streamingThinking = sth;
      ctx.assistantEl = currentAssistantEl;
      updateStreamingBubble();
    }
    return;
  }

  if (msg.type === 'result') {
    if (isCurrent) { finalizeStreaming(true); showStopBtn(false); }
    else {
      if (ctx.streamingText || ctx.streamingThinking) {
        let html = '';
        if (ctx.streamingThinking) html += '<details open><summary class="thinking-summary">思考过程</summary><div class="thinking-content">' + safeMd(ctx.streamingThinking) + '</div></details>';
        html += safeMd(ctx.streamingText);
        // If streaming bubble exists in DOM, update it with final content
        if (ctx.assistantEl) {
          ctx.assistantEl.querySelector('.bubble').innerHTML = html;
        } else {
          ctx.finalAssistantHtml = html;
        }
      } else if (ctx.assistantEl) {
        // No content — remove empty bubble
        ctx.assistantEl.remove();
      }
    }
    ctx.isGenerating = false;
    ctx.streamingText = ''; ctx.streamingThinking = ''; ctx.assistantEl = null;
    loadChatList();
    return;
  }
  if (msg.type === 'stopped') {
    if (isCurrent) { finalizeStreaming(false); showStopBtn(false); addStoppedMsg(); }
    else if (ctx.assistantEl) { ctx.assistantEl.remove(); }
    ctx.isGenerating = false; ctx.streamingText = ''; ctx.streamingThinking = ''; ctx.assistantEl = null;
    return;
  }
  if (msg.type === 'error') {
    if (isCurrent) { finalizeStreaming(false); showStopBtn(false); addSystemMsg(msg.content || 'Unknown error'); }
    else if (ctx.assistantEl) { ctx.assistantEl.remove(); }
    ctx.isGenerating = false; ctx.streamingText = ''; ctx.streamingThinking = ''; ctx.assistantEl = null;
    return;
  }

  // Recovery status messages
  if (msg.type === 'recovery_start') {
    console.log('[WS] recovery_start received, isCurrent:', isCurrent, 'currentCtx:', !!currentCtx);
    if (isCurrent) addSystemMsg(msg.content || '正在恢复上下文，请稍候...');
    return;
  }
  if (msg.type === 'recovery_complete') {
    if (isCurrent) addSystemMsg(msg.content || '上下文恢复完成');
    return;
  }
  if (msg.type === 'recovery_failed') {
    if (isCurrent) addSystemMsg(msg.content || '恢复失败，已开始新会话');
    return;
  }
}

function ensureAssistantBubble() {
  if (!currentAssistantEl && currentCtx) {
    currentAssistantEl = document.createElement('div');
    currentAssistantEl.className = 'msg msg-assistant';
    currentAssistantEl.innerHTML = '<div class="bubble"></div>';
    currentCtx.messagesInner.appendChild(currentAssistantEl);
    currentCtx.assistantEl = currentAssistantEl;
    scrollBottom();
  }
}

// 流式渲染节流：assistant 事件按内容块到达，不节流的话每次都要把累计全文重新 parse + sanitize。
let streamRenderTimer = 0;

function cancelStreamRender() {
  if (streamRenderTimer) {
    clearTimeout(streamRenderTimer);
    streamRenderTimer = 0;
  }
}

function _typingHtml() {
  return '<span class="typing">思考中<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></span>';
}

function _buildThinkingEl() {
  const details = document.createElement('details');
  details.open = true;
  const summary = document.createElement('summary');
  summary.className = 'thinking-summary';
  summary.textContent = '思考中...';
  const content = document.createElement('div');
  content.className = 'thinking-content streaming';
  details.appendChild(summary);
  details.appendChild(content);
  return details;
}

// 气泡结构：思考区（纯文本流式）+ 稳定区（已定稿 markdown，只追加）+ 尾部区（小段重渲染）
function _resetStreamStructure(bubble) {
  bubble.innerHTML = '';
  const st = { thinkEl: null, stableEl: null, tailEl: null, renderedLen: 0, thinkText: '', tailText: '' };
  if (streamingThinking) {
    st.thinkEl = _buildThinkingEl();
    st.thinkEl.querySelector('.thinking-content').textContent = streamingThinking;
    st.thinkText = streamingThinking;
    bubble.appendChild(st.thinkEl);
  }
  st.stableEl = document.createElement('div');
  st.stableEl.className = 'stream-stable';
  st.tailEl = document.createElement('div');
  st.tailEl.className = 'stream-tail';
  bubble.appendChild(st.stableEl);
  bubble.appendChild(st.tailEl);
  return st;
}

// 在 [from, text.length - STREAM_TAIL_MAX) 内找最后一个“空行且不在代码围栏里”的切点。
// from 一定是上一次的切点（空行后），所以从这里开始扫描时围栏必为关闭状态。
function _findStableSplit(text, from) {
  const target = text.length - STREAM_TAIL_MAX;
  if (target <= from) return from;
  let i = from;
  let fence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let lastSafe = from;
  while (i < target) {
    const nl = text.indexOf('\n', i);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(i, lineEnd);
    const fm = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fm) {
      const mark = fm[1];
      if (!fence) {
        fence = true;
        fenceChar = mark.charAt(0);
        fenceLen = mark.length;
      } else if (mark.charAt(0) === fenceChar && mark.length >= fenceLen && fm[2].trim() === '') {
        fence = false;
      }
    } else if (!fence && line.trim() === '') {
      lastSafe = Math.min(lineEnd + 1, text.length);
    }
    if (nl === -1) break;
    i = nl + 1;
  }
  return lastSafe;
}

function renderStreamingBubbleIncremental() {
  if (!currentCtx) return;
  ensureAssistantBubble();
  if (!currentAssistantEl) return;
  const bubble = currentAssistantEl.querySelector('.bubble');
  if (!bubble) return;

  if (!streamingText && !streamingThinking) {
    bubble.innerHTML = _typingHtml();
    currentAssistantEl._stream = null;
    scrollBottom();
    return;
  }

  let st = currentAssistantEl._stream;
  if (!st || !st.stableEl || !bubble.contains(st.stableEl) || st.renderedLen > streamingText.length) {
    st = _resetStreamStructure(bubble);
    currentAssistantEl._stream = st;
  }

  // 思考内容流式期间按纯文本显示，避免长思考被反复全量 markdown 解析；finalize 时再统一渲染。
  if (streamingThinking) {
    if (!st.thinkEl) {
      st = _resetStreamStructure(bubble);
      currentAssistantEl._stream = st;
    }
    if (st.thinkText !== streamingThinking) {
      st.thinkEl.querySelector('.thinking-content').textContent = streamingThinking;
      st.thinkText = streamingThinking;
    }
  } else if (st.thinkEl) {
    st.thinkEl.remove();
    st.thinkEl = null;
    st.thinkText = '';
  }

  const split = _findStableSplit(streamingText, st.renderedLen);
  if (split > st.renderedLen) {
    st.stableEl.insertAdjacentHTML('beforeend', safeMd(streamingText.slice(st.renderedLen, split)));
    st.renderedLen = split;
  }

  const tail = streamingText.slice(st.renderedLen);
  if (st.tailText !== tail) {
    st.tailEl.innerHTML = tail ? safeMd(tail) : '';
    st.tailText = tail;
  }
  scrollBottom();
}

// 兼容原调用点：事件到达只调度，80ms 内多次事件合并成一次渲染。
function updateStreamingBubble() {
  if (!currentCtx) return;
  if (streamRenderTimer) return;
  const ctx = currentCtx;
  streamRenderTimer = setTimeout(function () {
    streamRenderTimer = 0;
    if (currentCtx !== ctx) return;
    renderStreamingBubbleIncremental();
  }, STREAM_RENDER_INTERVAL_MS);
}

function finalizeStreaming(save) {
  cancelStreamRender();
  const hasContent = streamingText || streamingThinking;
  if (save && currentCtx && hasContent) {
    let html = '';
    if (streamingThinking) html += '<details open><summary class="thinking-summary">思考过程</summary><div class="thinking-content">' + safeMd(streamingThinking) + '</div></details>';
    html += safeMd(streamingText);
    currentCtx.finalAssistantHtml = html;
  }
  if (!currentAssistantEl || !hasContent) {
    currentAssistantEl = null; streamingText = ''; streamingThinking = '';
    if (currentCtx) currentCtx.assistantEl = null;
    return;
  }
  let html = '';
  if (streamingThinking) html += '<details open><summary class="thinking-summary">思考过程</summary><div class="thinking-content">' + safeMd(streamingThinking) + '</div></details>';
  html += safeMd(streamingText);
  currentAssistantEl.querySelector('.bubble').innerHTML = html;
  currentAssistantEl._stream = null;
  currentAssistantEl = null; streamingText = ''; streamingThinking = '';
  if (currentCtx) currentCtx.assistantEl = null;
}

// --- History window ---
// 服务端仍是全量 history；这里只控制 DOM 渲染窗口：先渲染最近 HISTORY_PAGE_SIZE 条，
// 向上滚动或点按钮再按页插入更早消息。这样打开/切回长对话的成本与总消息数解耦。

let loadEarlierRaf = 0;

function buildHistoryMsgEl(msg) {
  if (!msg) return null;
  const text = msg.content == null ? '' : String(msg.content);
  const el = document.createElement('div');
  if (msg.role === 'user') {
    el.className = 'msg msg-user';
    el.innerHTML = '<div class="bubble">' + escapeHtml(text) + '</div>';
  } else if (msg.role === 'assistant') {
    el.className = 'msg msg-assistant';
    el.innerHTML = '<div class="bubble">' + safeMd(text) + '</div>';
  } else {
    return null;
  }
  return el;
}

function renderHistoryWindow(ctx, reset) {
  if (!ctx) return;
  const history = ctx.history || [];
  if (reset) {
    ctx.messagesInner.innerHTML = '';
    ctx.loadEarlierEl = null;
    ctx.assistantEl = null;
    ctx.historyStart = Math.max(0, history.length - HISTORY_PAGE_SIZE);
    const frag = document.createDocumentFragment();
    for (let i = ctx.historyStart; i < history.length; i++) {
      const el = buildHistoryMsgEl(history[i]);
      if (el) frag.appendChild(el);
    }
    ctx.messagesInner.appendChild(frag);
    syncLoadEarlier(ctx);
    scrollBottom(true);
    return;
  }

  if (ctx.historyStart <= 0) return;
  if (ctx.scrollRaf) { cancelAnimationFrame(ctx.scrollRaf); ctx.scrollRaf = 0; }
  ctx.scrollForce = false;

  const prevStart = Math.max(0, ctx.historyStart - HISTORY_PAGE_SIZE);
  const prevTop = ctx.messagesEl.scrollTop;
  const prevHeight = ctx.messagesEl.scrollHeight;
  const frag = document.createDocumentFragment();
  for (let i = prevStart; i < ctx.historyStart; i++) {
    const el = buildHistoryMsgEl(history[i]);
    if (el) frag.appendChild(el);
  }
  // 按钮始终留在最顶部：插在按钮之后的第一个消息之前
  const anchor = ctx.loadEarlierEl ? ctx.loadEarlierEl.nextElementSibling : ctx.messagesInner.firstElementChild;
  if (anchor) ctx.messagesInner.insertBefore(frag, anchor);
  else ctx.messagesInner.appendChild(frag);
  ctx.historyStart = prevStart;
  syncLoadEarlier(ctx);
  // 补偿插入高度，保持用户当前视口不动
  ctx.messagesEl.scrollTop = ctx.messagesEl.scrollHeight - prevHeight + prevTop;
  ctx.atBottom = false;
}

function syncLoadEarlier(ctx) {
  const remain = ctx.historyStart || 0;
  if (remain <= 0) {
    if (ctx.loadEarlierEl) {
      ctx.loadEarlierEl.remove();
      ctx.loadEarlierEl = null;
    }
    return;
  }
  if (!ctx.loadEarlierEl) {
    const wrap = document.createElement('div');
    wrap.className = 'load-earlier';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.addEventListener('click', function () { loadEarlierMessages(ctx); });
    wrap.appendChild(btn);
    ctx.messagesInner.insertBefore(wrap, ctx.messagesInner.firstChild);
    ctx.loadEarlierEl = wrap;
  }
  const btn = ctx.loadEarlierEl.querySelector('button');
  btn.textContent = '加载更早的消息（还有 ' + remain + ' 条）';
}

function loadEarlierMessages(ctx) {
  if (!ctx || ctx.historyStart <= 0) return;
  renderHistoryWindow(ctx, false);
}

function scheduleLoadEarlier(ctx) {
  if (loadEarlierRaf) return;
  loadEarlierRaf = requestAnimationFrame(function () {
    loadEarlierRaf = 0;
    if (currentCtx === ctx) loadEarlierMessages(ctx);
  });
}

// --- Message DOM helpers (all scoped to currentCtx) ---

function addUserMsg(text) {
  if (!currentCtx) return;
  const el = document.createElement('div'); el.className = 'msg msg-user';
  el.innerHTML = '<div class="bubble">' + escapeHtml(text) + '</div>';
  currentCtx.messagesInner.appendChild(el); scrollBottom(true);
}
function addAssistantMsg(text) {
  if (!currentCtx) return;
  const el = document.createElement('div'); el.className = 'msg msg-assistant';
  el.innerHTML = '<div class="bubble">' + safeMd(text) + '</div>';
  currentCtx.messagesInner.appendChild(el);
}
function addToolMsg(name, content) {
  if (!currentCtx) return;
  const el = document.createElement('div'); el.className = 'msg msg-tool';
  let inner = '<div class="bubble"><span class="tool-name">[' + escapeHtml(name) + ']</span>';
  if (content) { const d = content.length > 500 ? content.slice(0, 500) + '...' : content; inner += '<pre>' + escapeHtml(d) + '</pre>'; }
  inner += '</div>'; el.innerHTML = inner;
  currentCtx.messagesInner.appendChild(el); scrollBottom();
}
function addSystemMsg(text) {
  if (!currentCtx) return;
  const el = document.createElement('div'); el.className = 'msg-system'; el.textContent = text;
  currentCtx.messagesInner.appendChild(el); scrollBottom();
}
function addStoppedMsg() {
  if (!currentCtx) return;
  const el = document.createElement('div'); el.className = 'msg-stopped'; el.textContent = '已中断';
  currentCtx.messagesInner.appendChild(el); scrollBottom();
}
