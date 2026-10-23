// Global state & constants
// 同源访问：页面由后端托管，不再写死 host:8000，也不需要 CORS
const API = '';
const WS = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

// 所有 Markdown 输出都必须经过净化，防止模型或文档里的恶意 HTML/脚本执行
function safeMd(text) {
  return DOMPurify.sanitize(marked.parse(text == null ? '' : String(text)));
}

// --- Auth ---
const _nativeFetch = window.fetch.bind(window);
// 任何业务接口返回 401（口令失效/过期）时回到登录页
window.fetch = function(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  return _nativeFetch(input, init).then(function(res) {
    if (res.status === 401 && url.indexOf('/api/') !== -1 && url.indexOf('/api/auth/') === -1) {
      location.reload();
    }
    return res;
  });
};

function showLogin() {
  return new Promise(function(resolve) {
    const ov = document.getElementById('loginOverlay');
    const input = document.getElementById('loginInput');
    const err = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');
    ov.classList.add('show');
    input.value = '';
    setTimeout(function() { input.focus(); }, 50);
    async function submit() {
      btn.disabled = true; err.textContent = '';
      try {
        const res = await _nativeFetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: input.value }),
        });
        if (!res.ok) throw new Error('口令错误，请重试');
        ov.classList.remove('show');
        resolve();
      } catch (e) {
        err.textContent = e.message;
        input.select();
      } finally {
        btn.disabled = false;
      }
    }
    btn.onclick = submit;
    input.onkeydown = function(e) { if (e.key === 'Enter') submit(); };
  });
}

async function ensureLogin() {
  const res = await _nativeFetch('/api/auth/status');
  const st = await res.json();
  if (!st.authenticated) await showLogin();
}

let currentSessionId = '';
let wsMap = new Map();
let sessionConnected = new Map();
let messageHistory = [];
let historyIndex = -1;
let tempInput = '';
let streamingText = '';
let streamingThinking = '';
let currentAssistantEl = null;
let isGenerating = false;

// --- Workspace registry（多工作目录）---
// 设计：目录集中在注册表，对话创建时绑定路径快照、之后不可改；
// "换目录"= fork 出新目录的新对话。旧的 editWorkspace 直接改全局路径已废弃。
let wsRegistry = { items: [], default_id: '' };
let chatListCache = [];
let wsPickCb = null;

/* 文档/项目 API 跟随当前对话的目录 */
function sessionQS() { return '&session=' + encodeURIComponent(currentSessionId || ''); }

async function loadWorkspaces() {
  try {
    const res = await fetch(API + '/api/workspaces');
    wsRegistry = await res.json();
  } catch (e) { console.error('加载工作目录注册表失败:', e); }
}

function renderWorkspaceDir() {
  const elx = document.getElementById('workspaceDir');
  if (!elx) return;
  const s = chatListCache.filter(function (c) { return c.id === currentSessionId; })[0];
  const path = s && s.workspace_path ? s.workspace_path : '';
  const hit = s ? wsRegistry.items.filter(function (it) { return it.path === path; })[0] : null;
  elx.textContent = path ? ((hit ? hit.name + ' · ' : '') + path) : '（未选对话）';
  elx.title = path || '';
}

/* 目录选择弹层：新建（mode='new'）与换目录（mode='fork'，带警示）复用 */
async function wsPickOpen(mode, cb) {
  // 注册表实时性：管理动作可能刚在另一个页面发生过，弹前先拉一次
  await loadWorkspaces();
  if (!wsRegistry.items.length) { addSystemMsg('工作目录列表为空，请先在侧栏「目录管理」新增'); return; }
  wsPickCb = cb;
  document.getElementById('wsPickTitle').textContent = mode === 'fork' ? '换目录（创建新对话）' : '新对话 · 选择工作目录';
  document.getElementById('wsPickWarn').style.display = mode === 'fork' ? '' : 'none';
  const list = document.getElementById('wsPickList');
  list.innerHTML = '';
  // 换目录弹层：预选并标注当前对话所在目录，点同目录不算换
  const curS = mode === 'fork' ? chatListCache.filter(function (c) { return c.id === currentSessionId; })[0] : null;
  const curWsId = curS && curS.workspace_id ? curS.workspace_id : '';
  wsRegistry.items.forEach(function (it) {
    const label = document.createElement('label');
    label.className = 'ws-pick-item';
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'wsPick'; radio.value = it.id;
    radio.checked = mode === 'fork' && curWsId ? it.id === curWsId : it.id === wsRegistry.default_id;
    label.appendChild(radio);
    const span = document.createElement('span');
    span.textContent = it.name + '　' + it.path
      + (it.is_default ? '（默认）' : '') + (mode === 'fork' && curWsId && it.id === curWsId ? '（当前）' : '');
    label.appendChild(span);
    list.appendChild(label);
  });
  document.getElementById('wsPickModal').classList.add('show');
}
function wsPickClose() { document.getElementById('wsPickModal').classList.remove('show'); wsPickCb = null; }
// 目录选择弹层：点遮罩或按 Escape 关闭，行为对齐确认弹窗
document.getElementById('wsPickModal').addEventListener('click', function(e) {
  if (e.target.id === 'wsPickModal') wsPickClose();
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && document.getElementById('wsPickModal').classList.contains('show')) wsPickClose();
});
async function wsPickConfirm() {
  const sel = document.querySelector('input[name="wsPick"]:checked');
  if (!sel) return;
  const cb = wsPickCb; wsPickCb = null;
  wsPickClose();
  if (cb) await cb(sel.value);
}

/* 换目录 = 后端在新目录 fork 新对话（不带历史），完成后切过去；目录没变则只提示不复制 */
function forkChat() {
  if (!currentSessionId) return;
  wsPickOpen('fork', async function (wsId) {
    const curS = chatListCache.filter(function (c) { return c.id === currentSessionId; })[0];
    if (curS && curS.workspace_id && curS.workspace_id === wsId) {
      addSystemMsg('目录未变化，无需换目录');
      return;
    }
    try {
      const res = await fetch(API + '/api/sessions/' + currentSessionId + '/fork', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: wsId }),
      });
      if (!res.ok) { const d = await res.json().catch(function () { return {}; }); throw new Error(d.detail || res.status); }
      const data = await res.json();
      if (data.forked === false) { addSystemMsg('目录未变化，无需换目录'); return; }
      await loadChatList();
      await switchChat(data.session_id);
    } catch (e) { addSystemMsg('换目录失败: ' + e.message); }
  });
}

/* 注册表管理：列表 + 新增/编辑/删除/设默认 */
async function wsMgrOpen() { await loadWorkspaces(); renderWsMgr(); document.getElementById('wsMgrModal').classList.add('show'); }
function wsMgrClose() { document.getElementById('wsMgrModal').classList.remove('show'); }

function renderWsMgr() {
  const box = document.getElementById('wsMgrList');
  box.innerHTML = '';
  wsRegistry.items.forEach(function (it) {
    const row = document.createElement('div');
    row.className = 'ws-mgr-row';
    const main = document.createElement('div');
    main.className = 'ws-mgr-main';
    const nm = document.createElement('div'); nm.className = 'ws-mgr-name';
    nm.textContent = it.name + (it.is_default ? '　★默认' : '');
    const pth = document.createElement('div'); pth.className = 'ws-mgr-path'; pth.textContent = it.path;
    main.appendChild(nm); main.appendChild(pth);
    row.appendChild(main);
    const usage = document.createElement('span'); usage.className = 'ws-mgr-usage';
    usage.textContent = (it.usage || 0) + ' 对话';
    row.appendChild(usage);
    if (!it.is_default) {
      const b0 = document.createElement('button'); b0.className = 'ws-mgr-btn'; b0.textContent = '设默认';
      b0.onclick = function () { wsApi('PUT', it.id, { is_default: true }); };
      row.appendChild(b0);
    }
    const b2 = document.createElement('button'); b2.className = 'ws-mgr-btn'; b2.textContent = '编辑';
    b2.onclick = function () { renderWsMgrForm(it); };
    row.appendChild(b2);
    const b3 = document.createElement('button'); b3.className = 'ws-mgr-btn danger'; b3.textContent = '删除';
    b3.onclick = function () { wsApi('DELETE', it.id, null); };
    row.appendChild(b3);
    box.appendChild(row);
  });
  renderWsMgrForm(null);
}

function renderWsMgrForm(item) {
  document.getElementById('wsMgrError').textContent = '';
  document.getElementById('wsMgrName').value = item ? item.name : '';
  document.getElementById('wsMgrPath').value = item ? item.path : '';
  document.getElementById('wsMgrDefault').checked = item ? !!item.is_default : wsRegistry.items.length === 0;
  const save = document.getElementById('wsMgrSave');
  save.dataset.editId = item ? item.id : '';
  save.textContent = item ? '保存修改' : '新增';
  document.getElementById('wsMgrCancel').style.display = item ? '' : 'none';
}
function wsMgrCancelEdit() { renderWsMgrForm(null); }

async function wsApi(method, id, body) {
  const errEl = document.getElementById('wsMgrError');
  errEl.textContent = '';
  try {
    const url = id ? API + '/api/workspaces/' + id : API + '/api/workspaces';
    const res = await fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) { const d = await res.json().catch(function () { return {}; }); throw new Error(typeof d.detail === 'string' ? d.detail : 'HTTP ' + res.status); }
    await loadWorkspaces();
    renderWsMgr();
    renderWorkspaceDir();
  } catch (e) { errEl.textContent = e.message; }
}

function wsMgrSave() {
  const editId = document.getElementById('wsMgrSave').dataset.editId;
  const body = {
    name: document.getElementById('wsMgrName').value,
    path: document.getElementById('wsMgrPath').value,
    is_default: document.getElementById('wsMgrDefault').checked,
  };
  if (editId) wsApi('PUT', editId, body); else wsApi('POST', null, body);
}

// scrollBottom — scoped to currentCtx
// Called whenever new content is added to the message list: jump to the newest content.
// Coalesced per animation frame so frequent streaming updates stay smooth.
function scrollBottom() {
  const ctx = currentCtx;
  if (!ctx || !ctx.messagesEl) return;
  if (ctx.scrollRaf) return;
  ctx.scrollRaf = requestAnimationFrame(function() {
    ctx.scrollRaf = 0;
    const el = ctx.messagesEl;
    el.scrollTop = el.scrollHeight;
  });
}

function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// --- Init is in project.js (last loaded) ---
