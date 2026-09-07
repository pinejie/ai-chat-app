// Global state & constants
const API = 'http://' + window.location.hostname + ':8000';
const WS = 'ws://' + window.location.hostname + ':8000';

let currentSessionId = '';
let wsMap = new Map();
let sessionConnected = new Map();
let sessionStreamingText = new Map();
let sessionStreamingThinking = new Map();
let sessionAssistantEl = new Map();
let sessionIsGenerating = new Map();
let sessionMsgs = new Map();
let messageHistory = [];
let historyIndex = -1;
let tempInput = '';
// 按会话隔离输入状态
const sessionInputState = new Map(); // sessionId -> { history: [], index: -1, tempInput: '', value: '' }
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

// --- Keyboard & Input Listeners ---
document.getElementById('input').addEventListener('keydown', function(e) {
  const input = e.target;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (messageHistory.length === 0) return;
    if (historyIndex === -1) tempInput = input.value;
    if (historyIndex < messageHistory.length - 1) {
      historyIndex++;
      input.value = messageHistory[messageHistory.length - 1 - historyIndex];
    }
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (historyIndex === -1) return;
    historyIndex--;
    if (historyIndex === -1) input.value = tempInput;
    else input.value = messageHistory[messageHistory.length - 1 - historyIndex];
  }
});
document.getElementById('input').addEventListener('input', function() { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 120) + 'px'; });

// --- Init is in project.js (last loaded) ---

function scrollBottom(force) {
  const el = document.getElementById('messages');
  if (force === true) { el.scrollTop = el.scrollHeight; return; }
  // Only auto-scroll if user is near bottom (within 80px)
  const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  if (isNearBottom) el.scrollTop = el.scrollHeight;
}
function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
