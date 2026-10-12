// --- Per-session permission mode & model ---
// 设置由服务端按对话保存（data/sessions/index.json），前端只做展示与提交。
let modeOptions = [];        // [{id,name,description}] 来自 /api/modes（即 CLI --permission-mode 取值）
let modelOptions = [];       // ['default','sonnet',...] 来自 /api/models（即 CLI --model，default=不传）
let defaultMode = 'acceptEdits';
const sessionSettings = new Map(); // sid -> {permission_mode, model}

function _fillSelect(select, items) {
  select.innerHTML = '';
  for (const it of items) {
    const opt = document.createElement('option');
    opt.value = it.value;
    opt.textContent = it.label;
    if (it.title) opt.title = it.title;
    select.appendChild(opt);
  }
}

function populateSettingSelects(ctx) {
  if (!ctx || !modeOptions.length) return;
  _fillSelect(ctx.modeSelect, modeOptions.map(m => ({ value: m.id, label: m.name, title: m.description })));
  _fillSelect(ctx.modelSelect, modelOptions.map(id => ({
    value: id,
    label: id === 'default' ? '默认模型' : id,
    title: id === 'default' ? '不传 --model，由 CLI 决定（等同 /model 未选择）' : '--model ' + id,
  })));
  applySettingsToCtx(ctx);
}

function applySettingsToCtx(ctx) {
  if (!ctx) return;
  const s = sessionSettings.get(ctx.sid) || {};
  if (ctx.modeSelect) ctx.modeSelect.value = s.permission_mode || defaultMode;
  if (ctx.modelSelect) ctx.modelSelect.value = s.model || 'default';
}

// 从对话列表刷新缓存（列表里每一项都带 permission_mode / model）
function refreshSessionSettings(list) {
  for (const item of list) {
    sessionSettings.set(item.id, { permission_mode: item.permission_mode, model: item.model });
  }
  for (const ctx of sessionCtxs.values()) applySettingsToCtx(ctx);
}

async function loadModes() {
  try {
    const [modes, models] = await Promise.all([
      fetch(API + '/api/modes').then(r => r.json()),
      fetch(API + '/api/models').then(r => r.json()),
    ]);
    modeOptions = modes;
    modelOptions = models.options || ['default'];
    for (const ctx of sessionCtxs.values()) populateSettingSelects(ctx);
  } catch (err) {
    console.error('loadModes failed:', err);
  }
}

// 用户改动下拉框 → 立即保存到服务端；失败则回滚显示
async function saveSessionSetting(ctx, kind, value) {
  const url = API + '/api/sessions/' + ctx.sid + (kind === 'mode' ? '/mode' : '/model');
  const body = kind === 'mode' ? { mode: value } : { model: value };
  const prev = sessionSettings.get(ctx.sid) || {};
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.detail || ('HTTP ' + res.status));
    }
    const cur = sessionSettings.get(ctx.sid) || {};
    if (kind === 'mode') cur.permission_mode = value; else cur.model = value;
    sessionSettings.set(ctx.sid, cur);
  } catch (err) {
    sessionSettings.set(ctx.sid, prev);
    applySettingsToCtx(ctx);
    addSystemMsg('保存设置失败: ' + err.message);
  }
}
