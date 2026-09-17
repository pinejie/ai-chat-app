// --- Permission Mode Selector ---
let currentMode = 'bypassPermissions';
const sessionModeMap = new Map(); // sessionId -> mode

async function loadModes() {
  try {
    const res = await fetch(API + '/api/modes');
    const modes = await res.json();
    // Update ALL session mode selects (current + future ones get updated on creation)
    document.querySelectorAll('.mode-select').forEach(select => {
      select.innerHTML = '';
      modes.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        opt.title = m.description;
        select.appendChild(opt);
      });
      // Set to the session's saved mode, or currentMode
      const sid = select.closest('.session-container')?.dataset?.sid;
      const savedMode = sid ? sessionModeMap.get(sid) : null;
      select.value = savedMode || currentMode;
    });
    // Wire up change listener for each select
    document.querySelectorAll('.mode-select').forEach(select => {
      if (select.dataset.listenerAttached) return;
      select.dataset.listenerAttached = '1';
      select.addEventListener('change', async function() {
        const container = this.closest('.session-container');
        const ctx = container ? Array.from(sessionCtxs.values()).find(c => c.container === container) : null;
        if (!ctx) return;
        const mode = this.value;
        if (ctx === currentCtx) currentMode = mode;
        sessionModeMap.set(ctx.sid, mode);
        try {
          await fetch(API + '/api/sessions/' + ctx.sid + '/mode', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({mode: mode})
          });
        } catch (err) {
          addSystemMsg('切换模式失败: ' + err.message);
        }
      });
    });
  } catch {}
}

// Also call loadModes when a new session is created (to populate its select)
const _origNewSessionCtx = newSessionCtx;
// Actually, let's just call loadModes from switchCtx after creating a new ctx.
// The simplest approach: call loadModes() after each newChat/switchChat.
// This is already handled because switchChat calls it indirectly.
