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

// --- Workspace ---
async function editWorkspace() {
  const el = document.getElementById('workspaceDir');
  if (el.querySelector('input')) return;
  const current = el.textContent;
  el.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text'; input.value = current;
  input.style.cssText = 'width:100%;background:var(--bg3);border:1px solid var(--accent);border-radius:4px;padding:2px 6px;color:var(--text);font-size:12px;outline:none;font-family:inherit;box-sizing:border-box;';
  el.appendChild(input); input.focus(); input.select();
  async function save() {
    const val = input.value.trim();
    if (val && val !== current) {
      try { const res = await fetch(API + '/api/workspace', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({workspace: val}) }); const data = await res.json(); el.textContent = data.workspace; updateConnectedUI(); return; } catch (err) { addSystemMsg('更新工作目录失败: ' + err.message); }
    }
    el.textContent = current;
  }
  input.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') { el.textContent = current; } });
  input.addEventListener('blur', save);
}

// scrollBottom — scoped to currentCtx
function scrollBottom(force) {
  if (!currentCtx || !currentCtx.messagesEl) return;
  const el = currentCtx.messagesEl;
  if (force === true) { el.scrollTop = el.scrollHeight; return; }
  const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  if (isNearBottom) el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// --- Init is in project.js (last loaded) ---
