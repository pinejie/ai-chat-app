// --- Trace Panel ---

let tracePanelOpen = false;
let traceEvents = [];  // current round's trace events
let traceCollapsed = true;

function toggleTracePanel() {
  tracePanelOpen = !tracePanelOpen;
  const panel = document.getElementById('tracePanel');
  const toggle = document.getElementById('traceToggle');
  panel.style.display = tracePanelOpen ? 'flex' : 'none';
  toggle.textContent = tracePanelOpen ? '▲' : '▼';
}

function showTracePanel() {
  if (!tracePanelOpen) {
    tracePanelOpen = true;
    const panel = document.getElementById('tracePanel');
    const toggle = document.getElementById('traceToggle');
    panel.style.display = 'flex';
    toggle.textContent = '▲';
  }
}

// Called from handleMsg when a trace event arrives
function handleTraceEvent(msg) {
  const events = msg.events || [];
  const event = msg.event;

  // Always show trace panel when we get trace data
  const bar = document.getElementById('traceBar');
  bar.style.display = 'flex';

  if (event === 'trace_complete') {
    renderTraceComplete(msg.summary, msg.spans || []);
    return;
  }

  for (const ev of events) {
    traceEvents.push(ev);
    if (ev.event === 'tool_start') {
      addTraceItem(ev, 'running');
    } else if (ev.event === 'tool_end') {
      updateTraceItem(ev);
    } else if (ev.event === 'llm_call') {
      addTraceLLMItem(ev);
    }
  }
  updateTraceStats();
}

function addTraceItem(ev, status) {
  const timeline = document.getElementById('traceTimeline');
  const item = document.createElement('div');
  item.className = 'trace-item trace-' + status;
  item.id = 'trace-' + (ev.tool_id || ev.step || Date.now());
  item.innerHTML = `
    <span class="trace-item-icon">${_toolIcon(ev.name)}</span>
    <span class="trace-item-name">${_esc(ev.name)}</span>
    <span class="trace-item-input">${_esc(ev.input_summary || '')}</span>
    <span class="trace-item-status trace-status-running">执行中...</span>
  `;
  timeline.appendChild(item);
  // Scroll trace body to bottom
  const body = document.getElementById('traceBody');
  body.scrollTop = body.scrollHeight;
}

function updateTraceItem(ev) {
  const el = document.getElementById('trace-' + ev.tool_id);
  if (!el) return;
  const status = ev.status || 'success';
  el.className = 'trace-item trace-' + status;
  const statusEl = el.querySelector('.trace-item-status');
  if (status === 'error') {
    statusEl.className = 'trace-item-status trace-status-error';
    statusEl.textContent = '✗ 失败';
    if (ev.error) {
      el.title = ev.error;
    }
  } else {
    statusEl.className = 'trace-item-status trace-status-success';
    statusEl.textContent = '✓ ' + (ev.duration || '?') + 's';
  }
  // Update duration display
  if (ev.duration) {
    let dur = el.querySelector('.trace-item-duration');
    if (!dur) {
      dur = document.createElement('span');
      dur.className = 'trace-item-duration';
      el.appendChild(dur);
    }
    dur.textContent = ev.duration + 's';
  }
  const body = document.getElementById('traceBody');
  body.scrollTop = body.scrollHeight;
}

function addTraceLLMItem(ev) {
  const timeline = document.getElementById('traceTimeline');
  const item = document.createElement('div');
  item.className = 'trace-item trace-llm';
  item.innerHTML = `
    <span class="trace-item-icon">🧠</span>
    <span class="trace-item-name">LLM #${ev.step}</span>
    <span class="trace-item-input">in=${ev.input_tokens} out=${ev.output_tokens} stop=${ev.stop_reason}</span>
    <span class="trace-item-status trace-status-llm">完成</span>
  `;
  timeline.appendChild(item);
}

function updateTraceStats() {
  const tools = traceEvents.filter(e => e.event === 'tool_end');
  const errors = tools.filter(e => e.status === 'error');
  const running = traceEvents.filter(e => e.event === 'tool_start' && !tools.find(t => t.tool_id === e.tool_id));
  const stats = document.getElementById('traceStats');
  const dot = document.getElementById('traceBarDot');
  const text = document.getElementById('traceBarText');

  let parts = [];
  if (tools.length) parts.push(`工具: ${tools.length}`);
  if (errors.length) parts.push(`错误: ${errors.length}`);
  if (running.length) parts.push(`执行中: ${running.length}`);
  stats.textContent = parts.join(' | ');

  if (running.length > 0) {
    dot.className = 'trace-bar-dot dot-running';
    text.textContent = '链路追踪 · 执行中';
  } else if (errors.length > 0) {
    dot.className = 'trace-bar-dot dot-error';
    text.textContent = '链路追踪 · 有错误';
  } else {
    dot.className = 'trace-bar-dot dot-done';
    text.textContent = '链路追踪 · 完成';
  }
}

function renderTraceComplete(summary, spans) {
  const stats = document.getElementById('traceStats');
  const dot = document.getElementById('traceBarDot');
  const text = document.getElementById('traceBarText');

  let statParts = [
    `LLM: ${summary.total_llm_calls}次`,
    `工具: ${summary.total_tools}次`,
    `Token: ${summary.total_input_tokens}→${summary.total_output_tokens}`,
  ];
  if (summary.errors > 0) statParts.push(`错误: ${summary.errors}`);
  statParts.push(`耗时: ${summary.duration}s`);
  stats.textContent = statParts.join(' | ');

  dot.className = 'trace-bar-dot ' + (summary.errors > 0 ? 'dot-error' : 'dot-done');
  text.textContent = '链路追踪 · 完成';

  // Show issues if any
  if (summary.issues && summary.issues.length > 0) {
    const timeline = document.getElementById('traceTimeline');
    for (const issue of summary.issues) {
      const item = document.createElement('div');
      item.className = 'trace-item trace-issue';
      item.innerHTML = `<span class="trace-item-icon">⚠️</span><span class="trace-item-name">${_esc(issue)}</span>`;
      timeline.appendChild(item);
    }
    showTracePanel();
  }
}

function resetTrace() {
  traceEvents = [];
  document.getElementById('traceTimeline').innerHTML = '';
  document.getElementById('traceStats').textContent = '';
  const bar = document.getElementById('traceBar');
  // Keep bar visible but reset dot
  document.getElementById('traceBarDot').className = 'trace-bar-dot';
  document.getElementById('traceBarText').textContent = '链路追踪';
}

function _toolIcon(name) {
  const icons = {
    'Bash': '⌨', 'Read': '📖', 'Write': '✏', 'Edit': '🔧',
    'Grep': '🔍', 'Glob': '📂', 'LSP': '🔗',
  };
  return icons[name] || '🔧';
}

function _esc(s) {
  if (!s) return '';
  const d = document.createElement('span');
  d.textContent = s;
  return d.innerHTML;
}
