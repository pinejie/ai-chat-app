// --- Trace Panel (all DOM scoped to currentCtx) ---

function toggleTracePanel() {
  if (!currentCtx) return;
  currentCtx.tracePanelOpen = !currentCtx.tracePanelOpen;
  currentCtx.tracePanel.style.display = currentCtx.tracePanelOpen ? 'flex' : 'none';
  currentCtx.traceToggle.textContent = currentCtx.tracePanelOpen ? '▲' : '▼';
}

function showTracePanel() {
  if (!currentCtx) return;
  if (!currentCtx.tracePanelOpen) {
    currentCtx.tracePanelOpen = true;
    currentCtx.tracePanel.style.display = 'flex';
    currentCtx.traceToggle.textContent = '▲';
  }
}

function handleTraceEvent(msg) {
  if (!currentCtx) return;
  const events = msg.events || [];
  const event = msg.event;

  currentCtx.traceBar.style.display = 'flex';

  if (event === 'trace_complete') {
    renderTraceComplete(msg.summary, msg.spans || []);
    return;
  }

  for (const ev of events) {
    if (ev.event === 'tool_start') {
      addTraceItem(ev, 'running');
    } else if (ev.event === 'tool_end') {
      updateTraceItem(ev);
    } else if (ev.event === 'llm_call') {
      addTraceLLMItem(ev);
    }
  }
}

function addTraceItem(ev, status) {
  if (!currentCtx) return;
  const item = document.createElement('div');
  item.className = 'trace-item trace-' + status;
  item.dataset.traceId = ev.tool_id || ev.step || Date.now();
  item.innerHTML = `
    <span class="trace-item-icon">${_toolIcon(ev.name)}</span>
    <span class="trace-item-name">${_esc(ev.name)}</span>
    <span class="trace-item-input">${_esc(ev.input_summary || '')}</span>
    <span class="trace-item-status trace-status-running">执行中...</span>
  `;
  currentCtx.traceTimeline.appendChild(item);
  currentCtx.traceBody.scrollTop = currentCtx.traceBody.scrollHeight;
}

function updateTraceItem(ev) {
  if (!currentCtx) return;
  const id = ev.tool_id;
  const el = currentCtx.traceTimeline.querySelector(`[data-trace-id="${id}"]`);
  if (!el) return;
  const status = ev.status || 'success';
  el.className = 'trace-item trace-' + status;
  const statusEl = el.querySelector('.trace-item-status');
  if (status === 'error') {
    statusEl.className = 'trace-item-status trace-status-error';
    statusEl.textContent = '✗ 失败';
    if (ev.error) el.title = ev.error;
  } else {
    statusEl.className = 'trace-item-status trace-status-success';
    statusEl.textContent = '✓ ' + (ev.duration || '?') + 's';
  }
  if (ev.duration) {
    let dur = el.querySelector('.trace-item-duration');
    if (!dur) {
      dur = document.createElement('span');
      dur.className = 'trace-item-duration';
      el.appendChild(dur);
    }
    dur.textContent = ev.duration + 's';
  }
  currentCtx.traceBody.scrollTop = currentCtx.traceBody.scrollHeight;
}

function addTraceLLMItem(ev) {
  if (!currentCtx) return;
  const item = document.createElement('div');
  item.className = 'trace-item trace-llm';
  item.innerHTML = `
    <span class="trace-item-icon">🧠</span>
    <span class="trace-item-name">LLM #${ev.step}</span>
    <span class="trace-item-input">in=${ev.input_tokens} out=${ev.output_tokens} stop=${ev.stop_reason}</span>
    <span class="trace-item-status trace-status-llm">完成</span>
  `;
  currentCtx.traceTimeline.appendChild(item);
}

function renderTraceComplete(summary, spans) {
  if (!currentCtx) return;
  const hasErrors = !!(summary && summary.errors > 0);
  currentCtx.traceBarDot.className = 'trace-bar-dot ' + (hasErrors ? 'dot-error' : 'dot-done');
  currentCtx.traceBarText.textContent = '链路追踪 · 完成';

  if (summary && summary.issues && summary.issues.length > 0) {
    for (const issue of summary.issues) {
      const item = document.createElement('div');
      item.className = 'trace-item trace-issue';
      item.innerHTML = `<span class="trace-item-icon">⚠️</span><span class="trace-item-name">${_esc(issue)}</span>`;
      currentCtx.traceTimeline.appendChild(item);
    }
    showTracePanel();
  }

  // 强制收尾所有仍在"执行中"的明细条目
  const runningItems = currentCtx.traceTimeline.querySelectorAll('.trace-status-running');
  for (const el of runningItems) {
    el.className = 'trace-item-status trace-status-success';
    el.textContent = '✓ 完成';
  }
  // 同时修正父级 trace-item 的 class（去掉 running 样式）
  for (const el of runningItems) {
    if (el.parentElement && el.parentElement.classList.contains('trace-running')) {
      el.parentElement.classList.remove('trace-running');
      el.parentElement.classList.add('trace-success');
    }
  }
}

function resetTrace() {
  if (!currentCtx) return;
  currentCtx.traceTimeline.innerHTML = '';
  currentCtx.traceBarDot.className = 'trace-bar-dot';
  currentCtx.traceBarText.textContent = '链路追踪';
}

function _toolIcon(name) {
  const icons = { 'Bash': '⌨', 'Read': '📖', 'Write': '✏', 'Edit': '🔧', 'Grep': '🔍', 'Glob': '📂', 'LSP': '🔗' };
  return icons[name] || '🔧';
}

function _esc(s) {
  if (!s) return '';
  const d = document.createElement('span');
  d.textContent = s;
  return d.innerHTML;
}
