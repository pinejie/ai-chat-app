// --- Permission Mode Selector ---
let currentMode = 'bypassPermissions';

async function loadModes() {
  try {
    const res = await fetch(API + '/api/modes');
    const modes = await res.json();
    const select = document.getElementById('modeSelect');
    select.innerHTML = '';
    modes.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      opt.title = m.description;
      select.appendChild(opt);
    });
    select.value = currentMode;
  } catch {}
}

document.getElementById('modeSelect').addEventListener('change', async function() {
  if (!currentSessionId) return;
  const mode = this.value;
  currentMode = mode;
  try {
    await fetch(API + '/api/sessions/' + currentSessionId + '/mode', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({mode: mode})
    });
  } catch (err) {
    addSystemMsg('切换模式失败: ' + err.message);
  }
});
