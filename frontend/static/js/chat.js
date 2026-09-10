// --- Chat List ---

async function loadChatList() {
  const res = await fetch(API + '/api/sessions');
  const list = await res.json();
  renderChatList(list);
  return list;
}

function renderChatList(list) {
  const el = document.getElementById('chatList');
  el.innerHTML = '';
  for (const item of list) {
    const div = document.createElement('div');
    div.className = 'chat-item' + (item.id === currentSessionId ? ' active' : '');
    const titleSpan = document.createElement('span');
    titleSpan.className = 'chat-title';
    titleSpan.textContent = item.title || '新对话';
    titleSpan.ondblclick = function(e) { e.stopPropagation(); enableRename(this, item.id); };
    const delSpan = document.createElement('span');
    delSpan.className = 'chat-delete';
    delSpan.innerHTML = '\u00d7';
    delSpan.onclick = function(e) { e.stopPropagation(); deleteChat(item.id); };
    div.innerHTML = '';
    div.appendChild(titleSpan);
    div.appendChild(delSpan);
    div.onclick = () => switchChat(item.id);
    el.appendChild(div);
  }
}

async function deleteChat(sessionId) {
  await fetch(API + '/api/sessions/' + sessionId, { method: 'DELETE' });
  if (wsMap.has(sessionId)) { wsMap.get(sessionId).close(); wsMap.delete(sessionId); }
  sessionConnected.delete(sessionId);
  sessionMsgs.delete(sessionId);
  if (sessionId === currentSessionId) {
    currentSessionId = '';
    document.getElementById('messagesInner').innerHTML = '';
    updateConnectedUI();
  }
  await loadChatList();
  if (!currentSessionId) { newChat(); }
}

// --- Session Management ---

async function newChat() {
  if (currentSessionId && wsMap.has(currentSessionId)) {
    wsMap.get(currentSessionId).close();
    wsMap.delete(currentSessionId);
  }
  sessionConnected.set(currentSessionId, false);
  updateConnectedUI();
  document.getElementById('messagesInner').innerHTML = '';
  // 新对话时重置输入区
  document.getElementById('input').value = '';
  document.getElementById('input').style.height = 'auto';
  selectedFiles = [];
  renderFilePreview();
  messageHistory = [];
  historyIndex = -1;
  tempInput = '';
  resetTrace();
  document.getElementById('traceBar').style.display = 'none';
  document.getElementById('tracePanel').style.display = 'none';
  tracePanelOpen = false;
  try {
    const res = await fetch(API + '/api/sessions', { method: 'POST' });
    const data = await res.json();
    currentSessionId = data.session_id;
    document.getElementById('sessionId').textContent = currentSessionId.slice(0, 8) + '...';
    connectWS();
    await loadChatList();
  } catch (err) {
    addSystemMsg('创建对话失败: ' + err.message);
  }
}

async function switchChat(sessionId) {
  if (sessionId === currentSessionId) return;
  // Save current session streaming state and input state
  if (currentSessionId) {
    sessionStreamingText.set(currentSessionId, streamingText);
    sessionStreamingThinking.set(currentSessionId, streamingThinking);
    sessionIsGenerating.set(currentSessionId, isGenerating);
    sessionAssistantEl.set(currentSessionId, null);
    // 保存输入状态（含权限模式、输入框高度）
    const _inputEl = document.getElementById('input');
    sessionInputState.set(currentSessionId, {
      history: [...messageHistory],
      index: historyIndex,
      tempInput: tempInput,
      value: _inputEl.value,
      mode: currentMode,
      textareaHeight: _inputEl.style.height || ''
    });
    // 清空文件预览（File 对象不可跨会话保持）
    selectedFiles = [];
    renderFilePreview();
  }
  // DO NOT close old WebSocket - keep it alive
  currentSessionId = sessionId;
  document.getElementById('sessionId').textContent = sessionId.slice(0, 8) + '...';
  document.getElementById('messagesInner').innerHTML = '';
  try {
    const res = await fetch(API + '/api/sessions/' + sessionId + '/history');
    const history = await res.json();
    for (const msg of history) {
      if (msg.role === 'user') addUserMsg(msg.content);
      else if (msg.role === 'assistant') addAssistantMsg(msg.content);
    }
    scrollBottom();
  } catch (err) {
    addSystemMsg('加载历史失败: ' + err.message);
  }
  // Restore streaming state for this session
  streamingText = sessionStreamingText.get(sessionId) || '';
  streamingThinking = sessionStreamingThinking.get(sessionId) || '';
  isGenerating = sessionIsGenerating.get(sessionId) || false;
  currentAssistantEl = null;
  if (isGenerating && (streamingText || streamingThinking)) {
    ensureAssistantBubble();
    updateStreamingBubble();
    showStopBtn(true);
  } else {
    showStopBtn(false);
  }
  // 恢复输入状态
  const savedInput = sessionInputState.get(sessionId);
  const _restoreInput = document.getElementById('input');
  if (savedInput) {
    messageHistory = savedInput.history;
    historyIndex = savedInput.index;
    tempInput = savedInput.tempInput;
    _restoreInput.value = savedInput.value;
    // 恢复权限模式
    if (savedInput.mode) {
      currentMode = savedInput.mode;
      const modeSelect = document.getElementById('modeSelect');
      if (modeSelect) modeSelect.value = currentMode;
    }
    // 恢复输入框高度
    _restoreInput.style.height = savedInput.textareaHeight || 'auto';
  } else {
    messageHistory = [];
    historyIndex = -1;
    tempInput = '';
    _restoreInput.value = '';
    _restoreInput.style.height = 'auto';
  }
  // 根据目标对话的生成状态设置输入区 disabled
  showStopBtn(isGenerating);
  if (!wsMap.has(sessionId)) { connectWS(); }
  updateConnectedUI();
  await loadChatList();
  // Load trace for this session
  _loadSessionTrace(sessionId);
}

async function _loadSessionTrace(sessionId) {
  try {
    const res = await fetch(API + '/api/sessions/' + sessionId + '/trace');
    const data = await res.json();
    if (data.spans && data.spans.length > 0) {
      resetTrace();
      const bar = document.getElementById('traceBar');
      bar.style.display = 'flex';
      // Replay spans into trace panel
      for (const span of data.spans) {
        if (span.type === 'tool') {
          const ev = { ...span, event: 'tool_start' };
          addTraceItem(ev, span.status || 'success');
          if (span.end) {
            updateTraceItem({ ...span, event: 'tool_end' });
          }
        } else if (span.type === 'llm') {
          addTraceLLMItem({ ...span, event: 'llm_call' });
        }
      }
      if (data.issues && data.issues.length > 0) {
        const timeline = document.getElementById('traceTimeline');
        for (const issue of data.issues) {
          const item = document.createElement('div');
          item.className = 'trace-item trace-issue';
          item.innerHTML = '<span class="trace-item-icon">⚠️</span><span class="trace-item-name">' + _esc(issue) + '</span>';
          timeline.appendChild(item);
        }
      }
      // Update stats
      const tools = data.spans.filter(s => s.type === 'tool');
      const llms = data.spans.filter(s => s.type === 'llm');
      const errs = tools.filter(s => s.status === 'error');
      const totalIn = llms.reduce((a, s) => a + (s.input_tokens || 0), 0);
      const totalOut = llms.reduce((a, s) => a + (s.output_tokens || 0), 0);
      document.getElementById('traceStats').textContent =
        'LLM: ' + llms.length + '次 | 工具: ' + tools.length + '次 | Token: ' + totalIn + '→' + totalOut + (errs.length ? ' | 错误: ' + errs.length : '');
      const dot = document.getElementById('traceBarDot');
      dot.className = 'trace-bar-dot ' + (errs.length > 0 ? 'dot-error' : 'dot-done');
      document.getElementById('traceBarText').textContent = '链路追踪 · ' + (data.live ? '活跃' : '历史');
    } else {
      // No trace data - hide the bar
      document.getElementById('traceBar').style.display = 'none';
      document.getElementById('tracePanel').style.display = 'none';
      tracePanelOpen = false;
    }
  } catch (e) {
    // Silently fail - trace is optional
  }
}


// --- WebSocket ---

function connectWS() {
  if (wsMap.has(currentSessionId)) { wsMap.get(currentSessionId).close(); }
  const socket = new WebSocket(WS + '/ws/' + currentSessionId);
  wsMap.set(currentSessionId, socket);
  const sid = currentSessionId;
  if (!sessionMsgs.has(sid)) sessionMsgs.set(sid, []);
  socket.onopen = () => {
    sessionConnected.set(sid, true);
    if (sid === currentSessionId) updateConnectedUI();
  };
  socket.onclose = () => {
    sessionConnected.set(sid, false);
    if (sid === currentSessionId) updateConnectedUI();
  };
  socket.onerror = () => {
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
  document.getElementById('sendBtn').disabled = !v;
}

// --- Streaming ---

function resetStreaming() {
  streamingText = ''; streamingThinking = ''; currentAssistantEl = null; isGenerating = false;
  showStopBtn(false);
}

function showStopBtn(show) {
  isGenerating = show;
  if (currentSessionId) sessionIsGenerating.set(currentSessionId, show);
  document.getElementById('stopBtn').style.display = show ? 'inline-block' : 'none';
  document.getElementById('sendBtn').style.display = show ? 'none' : 'inline-block';
  // 生成中禁用输入区，防止并发发送
  const inputEl = document.getElementById('input');
  inputEl.disabled = show;
  inputEl.placeholder = show ? '等待回复中...' : '输入消息... (Enter 发送, Shift+Enter 换行)';
  document.getElementById('uploadBtn').disabled = show;
}

async function stopGeneration() {
  if (!currentSessionId) return;
  
  // Immediately update UI
  isGenerating = false;
  if (currentAssistantEl) {
    currentAssistantEl.remove();
    currentAssistantEl = null;
  }
  streamingText = "";
  streamingThinking = "";
  showStopBtn(false);
  
  // Send stop request to server
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
  // Trace events
  if (msg.type === 'trace') { handleTraceEvent(msg); return; }
  if (msg.type === 'assistant') {
    const content = msg.message?.content;
    if (!content) return;
    // stream-json 的 assistant 消息是全量的 content 数组，需要重新计算而不是累加
    let st = '';
    let sth = '';
    for (const block of content) {
      if (block.type === 'thinking') { sth += (block.thinking || block.text || ''); }
      else if (block.type === 'text') { st += block.text; }
      else if (block.type === 'tool_use') {
        if (sid === currentSessionId) { streamingText = st; streamingThinking = sth; finalizeStreaming(); }
        if (sid === currentSessionId) addToolMsg(block.name, block.input ? JSON.stringify(block.input, null, 2) : '');
      }
      else if (block.type === 'tool_result') {
        if (sid === currentSessionId) addToolMsg('result', block.content || '');
      }
    }
    sessionStreamingText.set(sid, st);
    sessionStreamingThinking.set(sid, sth);
    if (sid === currentSessionId) { streamingText = st; streamingThinking = sth; updateStreamingBubble(); }
    return;
  }
  if (msg.type === 'result') {
    if (sid === currentSessionId) { finalizeStreaming(); showStopBtn(false); }
    sessionIsGenerating.set(sid, false);
    sessionStreamingText.set(sid, '');
    sessionStreamingThinking.set(sid, '');
    sessionAssistantEl.set(sid, null);
    loadChatList();
    return;
  }
  if (msg.type === 'stopped') {
    if (sid === currentSessionId) { finalizeStreaming(); addStoppedMsg(); }
    sessionIsGenerating.set(sid, false);
    sessionStreamingText.set(sid, '');
    sessionStreamingThinking.set(sid, '');
    sessionAssistantEl.set(sid, null);
    return;
  }
  if (msg.type === 'error') { if (sid === currentSessionId) addSystemMsg(msg.content || 'Unknown error'); return; }
}

function ensureAssistantBubble() {
  if (!currentAssistantEl) {
    currentAssistantEl = document.createElement('div');
    currentAssistantEl.className = 'msg msg-assistant';
    currentAssistantEl.innerHTML = '<div class="bubble"></div>';
    document.getElementById('messagesInner').appendChild(currentAssistantEl);
    scrollBottom();
  }
}

function updateStreamingBubble() {
  ensureAssistantBubble();
  let html = '';
  if (streamingThinking) html += '<details open><summary class="thinking-summary">思考中...</summary><div class="thinking-content">' + marked.parse(streamingThinking) + '</div></details>';
  if (streamingText) html += marked.parse(streamingText);
  if (!streamingText && !streamingThinking) html = '<span class="typing">思考中<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></span>';
  currentAssistantEl.querySelector('.bubble').innerHTML = html;
  scrollBottom();
}

function finalizeStreaming() {
  if (!currentAssistantEl || (!streamingText && !streamingThinking)) { currentAssistantEl = null; streamingText = ''; streamingThinking = ''; return; }
  let html = '';
  if (streamingThinking) html += '<details><summary class="thinking-summary">思考过程</summary><div class="thinking-content">' + marked.parse(streamingThinking) + '</div></details>';
  html += marked.parse(streamingText);
  currentAssistantEl.querySelector('.bubble').innerHTML = html;
  currentAssistantEl = null; streamingText = ''; streamingThinking = '';
  if (currentSessionId) sessionAssistantEl.set(currentSessionId, null);
}

function addUserMsg(text) { const el = document.createElement('div'); el.className = 'msg msg-user'; el.innerHTML = '<div class="bubble">' + escapeHtml(text) + '</div>'; document.getElementById('messagesInner').appendChild(el); scrollBottom(true); }
function addAssistantMsg(text) { const el = document.createElement('div'); el.className = 'msg msg-assistant'; el.innerHTML = '<div class="bubble">' + marked.parse(text) + '</div>'; document.getElementById('messagesInner').appendChild(el); }
function addToolMsg(name, content) { const el = document.createElement('div'); el.className = 'msg msg-tool'; let inner = '<div class="bubble"><span class="tool-name">[' + escapeHtml(name) + ']</span>'; if (content) { const d = content.length > 500 ? content.slice(0, 500) + '...' : content; inner += '<pre>' + escapeHtml(d) + '</pre>'; } inner += '</div>'; el.innerHTML = inner; document.getElementById('messagesInner').appendChild(el); scrollBottom(); }
function addSystemMsg(text) { const el = document.createElement('div'); el.className = 'msg-system'; el.textContent = text; document.getElementById('messagesInner').appendChild(el); scrollBottom(); }
function addStoppedMsg() { const el = document.createElement('div'); el.className = 'msg-stopped'; el.textContent = '已中断'; document.getElementById('messagesInner').appendChild(el); scrollBottom(); }
