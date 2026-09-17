// Global state & constants
const API = 'http://' + window.location.hostname + ':8000';
const WS = 'ws://' + window.location.hostname + ':8000';

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
