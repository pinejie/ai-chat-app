/* ZD Code 移动端协议层（阶段二第 2 步）
   职责：鉴权探测、会话、WebSocket 收发与流式渲染、设置、附件上传、项目文档只读浏览。
   协议载荷与 PC 端 frontend/static/js/{app,chat,upload,mode}.js 完全一致 —— 字段名来自
   对后端 main.py 与各 JS 的实际读取，不是推测。
   与 PC 端代码隔离（需求文档 §3.1 D1）；代价是协议层存在两份，改后端 WS 事件需同步两处（§9 R-4）。 */
(function () {
  'use strict';

  if (!window.MUI) { console.error('ui.js 未加载，mobile.js 终止'); return; }
  const MUI = window.MUI;
  const el = MUI.el;

  const API = '';                                                   // 同源：页面由后端托管
  const WS_BASE = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  const MOBILE_MODES = ['manual', 'plan'];                          // §10-D1 白名单
  const MODE_NAME = { manual: '逐步确认', plan: '仅计划' };
  const MAX_FILE = 20 * 1024 * 1024;                                // 与 PC/upload.js 一致
  const RECONNECT_MIN_GAP = 5000;                                   // §9 R-6 重连节流
  const SID_KEY = 'm-current-sid';
  const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

  /* ---------------- 状态 ---------------- */
  let sid = '';
  let ws = null;
  let connected = false;
  let generating = false;
  let streamText = '', streamThink = '', streamEl = null;
  let picked = [];                       // 待发送的 File 列表
  let modelOptions = ['default'];
  let curMode = 'manual', curModel = 'default';
  let lastReconnectAt = 0;
  let sessionsCache = [];                // 校验 localStorage 里的旧 sid 是否仍存在
  let docTrail = '';                     // 文档浏览器当前相对路径

  /* ---------------- 文本渲染 ---------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* marked / DOMPurify 缺失时降级成纯文本，而不是抛错。
     PC 端从 CDN 取 marked，一旦 WebView 拦外域脚本，safeMd() 抛错会让整条回复空白；
     移动端已把 marked 本地化（/static/js/marked.min.js），这里是第二道保险。 */
  function safeMd(text) {
    const raw = text == null ? '' : String(text);
    try {
      if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
        return '<pre>' + esc(raw) + '</pre>';
      }
      return DOMPurify.sanitize(marked.parse(raw));
    } catch (e) {
      return '<pre>' + esc(raw) + '</pre>';
    }
  }

  function highlightIn(root) {
    if (typeof hljs === 'undefined' || !root) return;
    root.querySelectorAll('pre code').forEach(function (b) {
      if (b.dataset.hlDone) return;
      b.dataset.hlDone = '1';
      try { hljs.highlightElement(b); } catch (e) { /* 高亮失败不影响内容可读 */ }
    });
  }

  /* ---------------- HTTP ---------------- */

  async function api(path, opts) {
    const res = await fetch(API + path, opts);
    if (res.status === 401 && path.indexOf('/api/auth/') !== 0) {
      onUnauthorized();
      throw new Error('未登录或口令已失效');
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.status === 204 ? null : res.json();
  }

  function postJSON(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }

  /* PC 端遇 401 是 location.reload()。移动端不照搬：WebView 里 reload 可能反复
     掉进同一个 401 → 死循环白屏。改为回到登录页并给明确提示（§9 R-1 容错）。 */
  function onUnauthorized() {
    connected = false;
    setConn('err');
    MUI.setLoginVisible(true);
    MUI.toast('口令已失效，请重新登录', true);
  }

  /* ---------------- 登录 ---------------- */

  async function ensureLogin() {
    try {
      const st = await api('/api/auth/status');
      if (st && st.authenticated) { MUI.setLoginVisible(false); return true; }
    } catch (e) { /* 探测失败也要能登录，不能白屏 */ }
    MUI.setLoginVisible(true);
    return false;
  }

  function bindLogin() {
    let busy = false;
    async function submit() {
      if (busy) return;
      const token = el.tokenInput.value.trim();
      if (!token) { el.loginError.textContent = '请输入访问口令'; return; }
      busy = true;
      el.btnLogin.disabled = true;
      el.loginError.textContent = '';
      try {
        await postJSON('/api/auth/login', { token: token });
        MUI.setLoginVisible(false);
        await startUp();
      } catch (e) {
        el.loginError.textContent = '口令错误，请重试';
        el.tokenInput.select();
      } finally {
        busy = false;
        el.btnLogin.disabled = false;
      }
    }
    el.btnLogin.addEventListener('click', submit);
    el.tokenInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    if (el.btnLogout) el.btnLogout.addEventListener('click', async function () {
      try { await postJSON('/api/auth/logout'); } catch (e) { /* 退出失败也回到登录态 */ }
      teardown();
      MUI.setLoginVisible(true);
    });
  }

  /* ---------------- 会话列表 ---------------- */

  async function loadSessions() {
    try {
      const list = await api('/api/sessions');
      sessionsCache = Array.isArray(list) ? list : [];
      renderSessionList(sessionsCache);
    } catch (e) {
      MUI.toast('会话列表加载失败：' + e.message, true);
    }
  }

  function dayLabel(ts) {
    if (!ts) return '更早';
    const d = new Date(ts * 1000), now = new Date();
    const same = function (a, b) {
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    };
    if (same(d, now)) return '今天';
    const y = new Date(now.getTime() - 86400000);
    if (same(d, y)) return '昨天';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function renderSessionList(list) {
    const box = el.mSessionList;
    box.innerHTML = '';
    if (!list.length) {
      const d = document.createElement('div');
      d.className = 'docs-empty';
      d.textContent = '还没有对话';
      box.appendChild(d);
      return;
    }
    let lastGroup = '';
    for (const item of list) {
      const g = dayLabel(item.updated_at);
      if (g !== lastGroup) {
        lastGroup = g;
        const h = document.createElement('div');
        h.className = 'session-date';
        h.textContent = g;
        box.appendChild(h);
      }
      box.appendChild(sessionRow(item));
    }
  }

  function sessionRow(item) {
    const row = document.createElement('div');
    row.className = 'session-item' + (item.id === sid ? ' active' : '');
    const t = document.createElement('span');
    t.className = 'session-item-title';
    t.textContent = item.title || '新对话';
    row.appendChild(t);
    row.addEventListener('click', function () { openSession(item.id); });
    return row;
  }

  /* ---------------- 会话生命周期 ---------------- */

  async function newSession() {
    try {
      await ensureSession();
      MUI.setDrawer(false);
      MUI.toast('已新建对话');
    } catch (e) {
      MUI.toast('创建对话失败：' + e.message, true);
    }
  }

  /* 方案 B（§11）：无会话时保证一个「可发送」的会话存在。顺序严格：
     创建 → 进入 → 刷新抽屉列表 → 等 WS 连上 → 设 manual，缺一不发第一条消息。
     后两步不可交换：后端新会话默认 acceptEdits（自动编辑），manual 未生效前
     首条消息会绕过 §10-D1 白名单。任一步失败即回滚到无会话态并把错误抛给调用方。 */
  async function ensureSession() {
    try {
      const data = await postJSON('/api/sessions');
      await enterSession(data.session_id);
      await loadSessions();
      if (!(await waitOpen(5000))) throw new Error('连接未就绪');
      if (!(await enforceManual(data.session_id))) throw new Error('权限模式设置失败');
    } catch (e) {
      teardown();   // 创建失败/半途失败都退回无会话态；下次发送会重新走完整流程
      throw e;
    }
  }

  /* connect() 是异步的，enterSession 返回 ≠ WS 已建立。轮询到 open / closed / 超时。 */
  function waitOpen(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 5000);
    return new Promise(function (resolve) {
      const timer = setInterval(function () {
        if (connected) { clearInterval(timer); resolve(true); return; }
        if (!ws || ws.readyState === WebSocket.CLOSED || Date.now() >= deadline) {
          clearInterval(timer); resolve(false);
        }
      }, 120);
    });
  }

  /* 新建会话专用：无条件 POST manual。不能复用 enforceModeWhitelist 的判断——
     它看的是 curMode，而 loadSettings 恰可能还没把这个新会话读进列表，
     curMode 停在旧值 'manual' 时会误判「已是 manual」，后端实际仍是 acceptEdits。 */
  async function enforceManual(id) {
    curMode = 'manual';
    MUI.markSeg(el.modeSeg, 'mode', 'manual');
    try {
      await postJSON('/api/sessions/' + id + '/mode', { mode: 'manual' });
      return true;
    } catch (e) {
      MUI.toast('权限模式设置失败：' + e.message, true);
      return false;
    }
  }

  async function openSession(id) {
    if (id === sid) { MUI.setDrawer(false); return; }
    await enterSession(id);
    await enforceModeWhitelist(id, false);
    MUI.setDrawer(false);
  }

  async function enterSession(id) {
    teardownWS();
    sid = id;
    try { localStorage.setItem(SID_KEY, id); } catch (e) { /* 存不下不影响本次 */ }
    clearMessages();
    picked = []; renderAttachBar();
    await loadHistory(id);
    await loadSettings(id);
    connect(id);
    refreshHeader();
  }

  async function loadHistory(id) {
    try {
      const history = await api('/api/sessions/' + id + '/history');
      (Array.isArray(history) ? history : []).forEach(function (m) {
        if (m.role === 'user') addUserMsg(m.content);
        else if (m.role === 'assistant') addAssistantMsg(m.content);
      });
      MUI.setEmptyVisible(el.msgList.childElementCount === 0);
    } catch (e) {
      addSystemMsg('历史加载失败：' + e.message);
    }
  }

  /* §10-D1：会话若带着 PC 端存的自动类模式，移动端主动改成 manual 并说明。
     不在界面上假装「已经是 manual」——那是骗用户，后端实际仍是 acceptEdits。 */
  /* 返回 true = 该会话现在确定处于白名单内、可以发送；false = 设置失败。 */
  async function enforceModeWhitelist(id, silent) {
    if (MOBILE_MODES.indexOf(curMode) >= 0) return true;
    const from = MODE_NAME[curMode] ? MODE_NAME[curMode] : curMode;
    curMode = 'manual';
    MUI.markSeg(el.modeSeg, 'mode', 'manual');
    try {
      await postJSON('/api/sessions/' + id + '/mode', { mode: 'manual' });
      if (!silent) MUI.toast('权限模式已从「' + from + '」改为逐步确认');
      return true;
    } catch (e) {
      MUI.toast('权限模式切换失败：' + e.message, true);
      return false;
    }
  }

  async function loadSettings(id) {
    try {
      const list = await api('/api/sessions');
      const me = (Array.isArray(list) ? list : []).filter(function (s) { return s.id === id; })[0];
      curMode = (me && me.permission_mode) || 'manual';
      curModel = (me && me.model) || 'default';
      MUI.markSeg(el.modeSeg, 'mode', MOBILE_MODES.indexOf(curMode) >= 0 ? curMode : 'manual');
      refreshModelChip();
    } catch (e) { /* 设置读不到时保持当前显示，不阻塞进入会话 */ }
  }

  function refreshHeader() {
    el.sessionTitle.textContent = sid ? ('对话 ' + sid.slice(0, 6)) : 'ZD Code';
  }

  function teardownWS() {
    if (ws) { try { ws.close(); } catch (e) {} }
    ws = null; connected = false;
    generating = false;
    streamText = ''; streamThink = ''; streamEl = null;
    setConn('idle'); setGenerating(false);
  }

  function teardown() {
    teardownWS();
    sid = '';
    try { localStorage.removeItem(SID_KEY); } catch (e) {}
    clearMessages();
  }

  /* ---------------- WebSocket ---------------- */

  function connect(target) {
    let socket;
    try {
      socket = new WebSocket(WS_BASE + '/ws/' + target);
    } catch (e) {
      setConn('err');
      addSystemMsg('连接失败：' + e.message);
      return;
    }
    ws = socket;
    setConn('reconnecting');

    socket.onopen = function () {
      if (ws !== socket) return;                 // 旧 socket 的回调可能晚于新连接到达（同 PC 端注释）
      connected = true;
      setConn('ok');
      verifyGenerating(target);
    };
    socket.onclose = function () {
      if (ws !== socket) return;
      connected = false;
      setConn('err');
      if (generating) verifyGenerating(target);  // 掉线不等于停止：以后端真实状态为准
      else setGenerating(false);
    };
    socket.onerror = function () {
      if (ws !== socket) return;
      connected = false;
      setConn('err');
    };
    socket.onmessage = function (e) {
      let msg = null;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      handleMsg(msg);
    };
  }

  /* 后端是唯一事实来源：WS 断了不代表生成结束（§5.3 R5） */
  async function verifyGenerating(target) {
    if (!target) return;
    try {
      const st = await api('/api/sessions/' + target + '/generating');
      if (target !== sid) return;
      if (st && st.generating) {
        setGenerating(true);
        ensureStreamBubble();
      } else if (generating) {
        finalize(true);
        setGenerating(false);
        await reloadHistoryQuiet();
      }
    } catch (e) { /* 探测失败不打扰用户 */ }
  }

  async function reloadHistoryQuiet() {
    clearMessages();
    await loadHistory(sid);
  }

  function handleMsg(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'system' || msg.type === 'trace') return;   // Trace 已按 §10-D3 砍掉
    if (msg.type === 'assistant') return onAssistant(msg);
    if (msg.type === 'result') { finalize(true); setGenerating(false); loadSessions(); return; }
    if (msg.type === 'stopped') { finalize(false); setGenerating(false); addSystemMsg('已中断'); return; }
    if (msg.type === 'error') { finalize(false); setGenerating(false); addErrorMsg(msg.content || '未知错误'); return; }
    if (msg.type === 'recovery_start' || msg.type === 'recovery_complete' || msg.type === 'recovery_failed') {
      addSystemMsg(msg.content || '上下文恢复中…');
    }
  }

  /* stream-json 是「每个内容块一个 assistant 事件」，必须在既有状态上累加，
     否则思考内容会被后续文本覆盖丢失（同 PC 端 chat.js 的处理） */
  function onAssistant(msg) {
    const content = msg.message && msg.message.content;
    if (!content) return;
    for (const block of content) {
      if (block.type === 'thinking') streamThink += (block.thinking || block.text || '');
      else if (block.type === 'text') streamText += (block.text || '');
      else if (block.type === 'tool_use') {
        commitStream();                       // 工具调用前的文本先定稿成独立气泡
        addToolMsg(block.name, block.input ? JSON.stringify(block.input, null, 2) : '');
      }
      else if (block.type === 'tool_result') {
        commitStream();
        addToolMsg('result', typeof block.content === 'string' ? block.content : JSON.stringify(block.content || ''));
      }
    }
    updateStream();
  }

  function commitStream() {
    if (!streamText && !streamThink) return;
    finalize(true);
    streamText = ''; streamThink = ''; streamEl = null;
  }

  /* ---------------- 消息 DOM ---------------- */

  function push(cls, html) {
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    if (html !== undefined) d.innerHTML = html;
    el.msgList.appendChild(d);
    MUI.setEmptyVisible(false);
    MUI.scrollToBottom();
    return d;
  }

  function addUserMsg(text) {
    push('msg-user', '<div class="bubble">' + esc(text) + '</div>');
  }

  function addAssistantMsg(text) {
    const d = push('msg-assistant', safeMd(text));
    highlightIn(d);
  }

  function addToolMsg(name, content) {
    const body = content
      ? '<pre>' + esc(content.length > 400 ? content.slice(0, 400) + '…' : content) + '</pre>'
      : '';
    push('msg-tool', '<span class="tool-name">' + esc(name || '工具') + '</span>' + body);
  }

  function addSystemMsg(text) { push('msg-system', esc(text)); }
  function addErrorMsg(text) { push('msg-error', esc(text)); }

  function ensureStreamBubble() {
    if (streamEl || !el.msgList) return;
    streamEl = push('msg-assistant', '<span class="typing">思考中<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></span>');
  }

  function updateStream() {
    ensureStreamBubble();
    if (!streamEl) return;
    let html = '';
    if (streamThink) html += '<details open><summary class="thinking-summary">思考中…</summary><div class="thinking-content">' + safeMd(streamThink) + '</div></details>';
    if (streamText) html += safeMd(streamText);
    if (!html) html = '<span class="typing">思考中<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></span>';
    streamEl.innerHTML = html;
    highlightIn(streamEl);
    MUI.scrollToBottom();
  }

  function finalize(keep) {
    const has = streamText || streamThink;
    if (!has) {
      if (streamEl) { streamEl.remove(); streamEl = null; }
      return;
    }
    ensureStreamBubble();   // 有内容就必须有落点，不能因为气泡缺失把回复吞掉
    if (keep) {
      let html = '';
      if (streamThink) html += '<details><summary class="thinking-summary">思考过程</summary><div class="thinking-content">' + safeMd(streamThink) + '</div></details>';
      html += safeMd(streamText);
      streamEl.innerHTML = html;
      highlightIn(streamEl);
    }
    streamEl = null; streamText = ''; streamThink = '';
  }

  function clearMessages() { el.msgList.innerHTML = ''; streamEl = null; MUI.setEmptyVisible(true); }

  /* ---------------- 发送 / 停止 ---------------- */

  async function send() {
    if (generating) { MUI.toast('回复还在路上，稍等一下'); return; }
    const text = el.input.value.trim();
    if (!text) return;
    if (!sid) {   // 方案 B（§11）：无活跃会话直接发送，自动新建；失败保留输入
      try { await ensureSession(); }
      catch (e) { MUI.toast('新建对话失败：' + e.message + '，已保留你输入的内容', true); return; }
    }
    if (!connected) { await reconnectNow('手动重连'); if (!connected) return; }

    let paths = [];
    if (picked.length) {
      paths = await uploadAll(picked);
      if (!paths.length && picked.length) return;   // 上传失败就不发，避免消息内容与附件不一致
    }

    // 上传是异步的，期间连接可能已断；此时继续会让界面进入「生成中」而消息根本没发出去
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addSystemMsg('连接已断开，消息未发送，请重连后重试');
      return;
    }

    picked = []; renderAttachBar();
    el.input.value = ''; MUI.autoGrow();
    addUserMsg(text);
    streamText = ''; streamThink = ''; streamEl = null;
    setGenerating(true);
    ensureStreamBubble();
    updateStream();
    ws.send(JSON.stringify({ type: 'message', content: text, files: paths }));
  }

  async function uploadAll(files) {
    const fd = new FormData();
    files.forEach(function (f) { fd.append('files', f); });      // 字段名与后端 /api/upload 一致
    try {
      const res = await fetch(API + '/api/upload', { method: 'POST', body: fd });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return (data.files || []).map(function (f) { return f.path; });
    } catch (e) {
      MUI.toast('附件上传失败：' + e.message, true);
      return [];
    }
  }

  async function stop() {
    if (!sid) return;
    finalize(false);
    setGenerating(false);
    try { await postJSON('/api/sessions/' + sid + '/stop'); }
    catch (e) { addSystemMsg('停止请求失败：' + e.message); }
  }

  function setGenerating(on) {
    generating = on;
    el.btnStop.classList.toggle('hidden', !on);
    el.btnSend.classList.toggle('hidden', on);
    MUI.setThinking(false);
    el.input.disabled = false;
    syncInputUi();
  }

  function setConn(state) {
    if (el.connState) el.connState.setAttribute('data-state', state);
    syncInputUi();
  }

  /* 无会话时发送按钮可点（点了会静默新建并发送，§11）；有会话仍要求 WS 已连。
     placeholder 同步换文案，避免「按钮能按、提示却让你先建对话」的分裂感。 */
  function syncInputUi() {
    el.btnSend.disabled = generating || (!!sid && !connected);
    el.input.placeholder = generating ? '回复中，可继续输入但不能发送' : (sid ? '输入消息…' : '直接说，自动开始新对话…');
  }

  /* ---------------- 附件（§5.3 R7） ---------------- */

  function bindFiles() {
    el.mFileInput.addEventListener('change', function (e) {
      const added = Array.prototype.slice.call(e.target.files || []);
      if (!added.length) return;
      for (const f of added) {
        if (f.size > MAX_FILE) { MUI.toast(f.name + ' 超过 20MB 限制', true); e.target.value = ''; return; }
      }
      picked = picked.concat(added);
      renderAttachBar();
      e.target.value = '';
    });
  }

  function renderAttachBar() {
    const bar = el.attachBar;
    bar.innerHTML = '';
    bar.classList.toggle('hidden', picked.length === 0);
    picked.forEach(function (f, i) {
      const item = document.createElement('div');
      item.className = 'attach-item';
      if (f.type.indexOf('image/') === 0) {
        const img = document.createElement('img');
        img.className = 'attach-thumb';
        img.src = URL.createObjectURL(f);
        img.onload = function () { URL.revokeObjectURL(img.src); };
        item.appendChild(img);
      }
      const name = document.createElement('span');
      name.textContent = f.name;
      item.appendChild(name);
      const del = document.createElement('button');
      del.className = 'attach-del';
      del.type = 'button';
      del.textContent = '×';
      del.setAttribute('aria-label', '移除附件');
      del.addEventListener('click', function () { picked.splice(i, 1); renderAttachBar(); });
      item.appendChild(del);
      bar.appendChild(item);
    });
  }

  /* ---------------- 设置：模式与模型（§10-D1） ---------------- */

  async function loadModels() {
    try {
      const d = await api('/api/models');
      modelOptions = (d && Array.isArray(d.options)) ? d.options : ['default'];
      renderModelList();
    } catch (e) { /* 用默认列表，不阻塞主流程 */ }
  }

  function renderModelList() {
    if (!el.modelList) return;
    el.modelList.innerHTML = '';
    modelOptions.forEach(function (m) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'model-item' + (m === curModel ? ' active' : '');
      b.textContent = m === 'default' ? '默认模型' : m;
      b.addEventListener('click', async function () {
        curModel = m;
        MUI.closeSheet();
        renderModelList(); refreshModelChip();
        try { await postJSON('/api/sessions/' + sid + '/model', { model: m }); MUI.toast('已切换到 ' + (m === 'default' ? '默认模型' : m)); }
        catch (e) { MUI.toast('模型切换失败：' + e.message, true); }
      });
      el.modelList.appendChild(b);
    });
  }

  function refreshModelChip() {
    if (el.btnModel) el.btnModel.textContent = curModel === 'default' ? '模型' : curModel;
  }

  function bindModeSeg() {
    if (!el.modeSeg) return;
    el.modeSeg.addEventListener('click', async function (e) {
      const b = e.target.closest('.seg-item');
      if (!b) return;
      const mode = b.getAttribute('data-mode');
      if (MOBILE_MODES.indexOf(mode) < 0 || !sid) return;
      MUI.markSeg(el.modeSeg, 'mode', mode);
      curMode = mode;
      try {
        await postJSON('/api/sessions/' + sid + '/mode', { mode: mode });
        MUI.toast('权限模式：' + MODE_NAME[mode]);
      } catch (err) {
        MUI.markSeg(el.modeSeg, 'mode', 'manual');
        curMode = 'manual';
        MUI.toast('切换失败：' + err.message, true);
      }
    });
  }

  /* ---------------- 项目文档只读（§10-D2） ----------------
     只发 GET，前端不提供任何写入口。注意这是体验层裁剪，不是访问控制（§4.1）。 */

  async function loadDocs() {
    try {
      const d = await api('/api/browse?rel_path=' + encodeURIComponent(docTrail));
      renderDocs(d || {});
    } catch (e) {
      el.docsList.innerHTML = '<div class="docs-empty">读取失败：' + esc(e.message) + '</div>';
    }
  }

  function renderDocs(d) {
    el.docsPath.textContent = 'project/' + (docTrail ? docTrail + '/' : '');
    el.docsList.innerHTML = '';
    const dirs = d.dirs || [], files = d.files || [];
    if (!dirs.length && !files.length) {
      el.docsList.innerHTML = '<div class="docs-empty">空目录</div>';
      return;
    }
    if (docTrail) el.docsList.appendChild(docRow('↩ 上一级', goUp));
    dirs.forEach(function (n) {
      el.docsList.appendChild(docRow('▸ ' + n, function () {
        docTrail = docTrail ? docTrail + '/' + n : n;
        loadDocs();
      }));
    });
    files.forEach(function (n) {
      el.docsList.appendChild(docRow('  ' + n, function () { openDoc(join(docTrail, n)); }));
    });
  }

  function join(dir, name) { return dir ? dir + '/' + name : name; }

  function goUp() {
    const parts = docTrail.split('/');
    parts.pop();
    docTrail = parts.join('/');
    loadDocs();
  }

  function docRow(label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'doc-row';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  async function openDoc(path) {
    const box = el.docsList;
    if (IMG_RE.test(path)) {
      box.innerHTML = '';
      const v = document.createElement('div');
      v.className = 'docs-viewer';
      const img = document.createElement('img');
      img.src = API + '/api/projects/image?path=' + encodeURIComponent(path);
      img.alt = path;
      v.appendChild(img);
      box.appendChild(v);
      return;
    }
    try {
      const d = await api('/api/projects/content?path=' + encodeURIComponent(path));
      box.innerHTML = '';
      const v = document.createElement('div');
      v.className = 'docs-viewer';
      const body = document.createElement('div');
      body.className = 'docs-viewer-body';
      body.textContent = (d && d.content) || '（空文件）';
      v.appendChild(docRow('↩ 返回列表', loadDocs));
      v.appendChild(body);
      box.appendChild(v);
    } catch (e) {
      MUI.toast('打开失败：' + e.message, true);
    }
  }

  function bindDocs() {
    // ui.js 已绑定展开/收起；这里补上首次展开时拉取列表
    if (!el.btnDocs) return;
    el.btnDocs.addEventListener('click', function () {
      if (el.docsPane.classList.contains('hidden')) return;
      if (!el.docsList.childElementCount) loadDocs();
    });
  }

  /* ---------------- 回前台自动重连（§5.3 R5 / §9 R-6） ---------------- */

  function bindReconnect() {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      MUI.syncViewport();
      if (!sid) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) reconnectNow('回到前台');
      else verifyGenerating(sid);
    });
  }

  async function reconnectNow(reason) {
    const now = Date.now();
    if (now - lastReconnectAt < RECONNECT_MIN_GAP) return;   // 弱网下反复重连会重复触发 --resume 子进程
    lastReconnectAt = now;
    if (!sid) return;
    MUI.toast('正在重连…');
    teardownWSKeepSid();
    connect(sid);
    await verifyGenerating(sid);
  }

  function teardownWSKeepSid() {
    if (ws) { try { ws.close(); } catch (e) {} }
    ws = null; connected = false;
  }

  /* ---------------- 启动 ---------------- */

  async function startUp() {
    await loadModels();
    await loadSessions();
    let last = '';
    try { last = localStorage.getItem(SID_KEY) || ''; } catch (e) {}
    // WebView 可能被清缓存而留下一个已被服务端删除的 sid；直接进会连出一个空会话
    if (last && !sessionsCache.some(function (s) { return s.id === last; })) {
      try { localStorage.removeItem(SID_KEY); } catch (e) {}
      last = '';
    }
    if (last) {
      await enterSession(last);
      setGenerating(false);
    } else {
      el.msgList.innerHTML = '';
      MUI.setEmptyVisible(true);
    }
  }

  function bindSend() {
    el.btnSend.addEventListener('click', send);
    el.btnStop.addEventListener('click', stop);
    document.addEventListener('m:send', send);
    if (el.btnNewSession) el.btnNewSession.addEventListener('click', newSession);
    if (el.btnModel) el.btnModel.addEventListener('click', renderModelList);
  }

  function init() {
    bindLogin();
    bindSend();
    bindFiles();
    bindModeSeg();
    bindDocs();
    bindReconnect();
    setConn('idle');
    setGenerating(false);
    ensureLogin().then(function (ok) { if (ok) startUp(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
