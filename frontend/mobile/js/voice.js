/* ZD Code 移动端语音输入（微信式「按住 说话」）
   交互对齐微信聊天输入区：
     点工具栏 🎤 → 输入框整条替换为「按住 说话」大按钮，图标变键盘（再点切回文字）；
     按住大条 = 录音，松开 = 识别上传，按住上滑 = 取消；识别文字填入输入框并自动切回文字态由用户确认再发。
   两条路径自动降级（沿用 P3 结论）：
     A 网页录音 getUserMedia+MediaRecorder —— 支持按住手势，体验最好；
     B 系统录音器 <input accept="audio/*"> —— 网页权限被泛微 WebView 拒时启用，无按住语义，点大条即唤起系统录音器。
   A 权限一旦被拒就记入 localStorage，之后点大条直接走 B，不再反复撞墙。
   识别端点：后端 POST /api/asr（ffmpeg 解码 → FunASR offline），返回 {text, truncated}。
   只依赖 window.MUI（ui.js 导出），与 mobile.js 协议层互不干涉。 */
(function () {
  'use strict';
  if (!window.MUI) { console.error('ui.js 未加载，voice.js 终止'); return; }
  const MUI = window.MUI;
  const el = MUI.el;

  const PREFER_B_KEY = 'm-voice-prefer-b';
  const MAX_RECORD_S = 60;        // 与后端 ASR_MAX_SECONDS 一致，到时自动停止上传
  const MAX_UPLOAD_B = 10 * 1024 * 1024;
  const MIN_HOLD_MS = 400;        // 短于此视为误触（微信「说话时间太短」）
  const CANCEL_PX = 80;           // 按住上滑超过此像素 → 进入取消区

  const btnVoice = document.getElementById('btnVoice');
  const voiceFile = document.getElementById('mVoiceFile');
  const voiceHint = document.getElementById('voiceHint');
  const holdTalk = document.getElementById('mHoldTalk');
  const input = el.input;
  const icMic = btnVoice ? btnVoice.querySelector('.ic-mic') : null;
  const icKbd = btnVoice ? btnVoice.querySelector('.ic-kbd') : null;
  if (!btnVoice || !voiceFile || !voiceHint || !holdTalk || !input) return;

  let state = 'idle';             // idle | recording | busy
  let voiceMode = false;          // 是否处于「按住说话」大条态
  let recorder = null, stream = null, chunks = [], tick = null, recSec = 0;
  // 一次按住的生命周期（与录音异步启动解耦：手指状态即时，recorder 待权限）
  let hold = { active: false, pid: null, startY: 0, cancel: false, discard: false, t0: 0 };

  function preferB() { try { return localStorage.getItem(PREFER_B_KEY) === '1'; } catch (e) { return false; } }
  function channel() { return (preferB() || !hasWebRecorder()) ? 'B' : 'A'; }

  function setHoldLabel(t) { holdTalk.textContent = t; }
  function setHint(text) {
    voiceHint.textContent = text || '';
    voiceHint.classList.toggle('hidden', !text);
  }
  function setState(s) {
    state = s;
    btnVoice.classList.toggle('recording', s === 'recording');
    btnVoice.classList.toggle('busy', s === 'busy');
    holdTalk.classList.toggle('recording', s === 'recording' && !hold.cancel);
    holdTalk.classList.toggle('cancel', s === 'recording' && hold.cancel);
    holdTalk.classList.toggle('busy', s === 'busy');
  }

  function releaseStream() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  }
  function hasWebRecorder() {
    return !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }
  function pickMime() {
    const list = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];
    for (let i = 0; i < list.length; i++) {
      try { if (MediaRecorder.isTypeSupported(list[i])) return list[i]; } catch (e) { /* 老内核忽略 */ }
    }
    return '';
  }

  /* ---------------- 模式切换 ---------------- */

  function setVoiceMode(on) {
    voiceMode = on;
    input.classList.toggle('hidden', on);
    holdTalk.classList.toggle('hidden', !on);
    if (icMic) icMic.classList.toggle('hidden', on);
    if (icKbd) icKbd.classList.toggle('hidden', !on);
    btnVoice.classList.toggle('active', on);
    if (on) { setHoldLabel('按住 说话'); if (input.blur) input.blur(); }
    MUI.syncInput();                                // 清空钮随模式联动：语音态藏、文字态按内容恢复
  }

  /* ---------------- 上传与回填 ---------------- */

  function upload(data, name) {
    setHint('识别中…'); setState('busy');
    const fd = new FormData();
    fd.append('file', data, name);
    fetch('/api/asr', { method: 'POST', body: fd })
      .then(function (res) {
        if (res.status === 401) {
          setHint(''); setState('idle');
          MUI.setLoginVisible(true);
          MUI.toast('请先登录 ZD Code，再使用语音', true);
          return null;
        }
        return res.json().then(function (j) {
          if (!res.ok) throw new Error((j && j.detail) || ('HTTP ' + res.status));
          return j;
        });
      })
      .then(function (j) {
        if (!j) return;
        setHint(''); setState('idle');
        const text = (j.text || '').trim();
        if (!text) { setHoldLabel('按住 说话'); MUI.toast('没听清内容，请再说一次', true); return; }  // 留在语音态便于重试
        // 先切回文字态再回填：appendText 里的 autoGrow 要在「可见」的输入框上量高度，
        // 若趁隐藏态（display:none，scrollHeight=0）去量会把输入框压塌，文字只剩下半截可见
        setVoiceMode(false);
        appendText(text);                          // 回填后由用户编辑确认再发
        MUI.toast(j.truncated ? '已识别（超 60 秒部分被截断）' : '识别完成，可编辑后发送');
      })
      .catch(function (e) {
        setHint(''); setState('idle');
        MUI.toast('识别失败：' + (e.message || '未知错误'), true);
      });
  }

  function appendText(text) {
    const cur = input.value;
    // 框内只剩空白（如输入法候选态按回车残留的换行）→ 视作空框直接填，
    // 否则那个换行会被原样保留，识别文字就掉到第二行（首行空白 bug）
    if (!cur.trim()) { input.value = text; }
    else { input.value = cur + (/[ \n]$/.test(cur) ? '' : '\n') + text; }
    MUI.syncInput();
    const pos = input.value.length;
    try { input.setSelectionRange(pos, pos); } catch (e) { /* 个别内核禁用 selection */ }
  }

  /* ---------------- 路径 A：按住网页录音 ---------------- */

  function onWebStopped() {
    clearInterval(tick); tick = null;
    releaseStream();
    const wasDiscard = hold.discard; hold.discard = false;
    const mime = (recorder && recorder.mimeType) || '';
    const blob = new Blob(chunks, { type: mime || 'audio/webm' });
    chunks = [];
    setState('idle');
    setHint('');
    setHoldLabel('按住 说话');
    if (wasDiscard) return;                                   // 上滑取消：静默丢弃
    if (blob.size < 1000) { MUI.toast('没采集到声音，请再说一次', true); return; }
    upload(blob, 'voice.' + (mime.indexOf('mp4') > -1 ? 'm4a' : 'webm'));
  }

  function stopRecording() {
    clearInterval(tick); tick = null;
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); }
    catch (e) { hold.discard = true; releaseStream(); setState('idle'); setHint(''); MUI.toast('停止录音失败', true); }
  }

  function startWebRecording() {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
      if (!hold.active) {                                     // 权限返回前手指已抬起 → 丢弃，不留录音
        s.getTracks().forEach(function (t) { t.stop(); });
        return;
      }
      stream = s; chunks = []; recSec = 0;
      const mime = pickMime();
      recorder = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s);
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = onWebStopped;
      setState('recording');
      holdTalk.classList.remove('armed');            // 真正开始录了，撤掉「待启动」按压态
      setHoldLabel(hold.cancel ? '松手 取消' : '松开 发送');
      setHint('录音 0s · 上滑可取消');               // 立刻显示，不等 1 秒的 tick
      tick = setInterval(function () {
        recSec++;
        if (recSec >= MAX_RECORD_S) { hold.discard = false; stopRecording(); MUI.toast('已到 60 秒上限，自动停止'); return; }
        setHint('录音 ' + recSec + 's · 上滑可取消');
      }, 1000);
      recorder.start();
    }).catch(function (e) {
      hold.active = false; holdTalk.classList.remove('armed'); setState('idle'); setHint(''); setHoldLabel('按住 说话');
      const name = (e && e.name) || '';
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDenied') {
        try { localStorage.setItem(PREFER_B_KEY, '1'); } catch (err) { /* 无痕模式忽略 */ }
        MUI.toast('网页录音被限制，请再点一次「按住 说话」用系统录音');
      } else if (name === 'NotFoundError') {
        MUI.toast('没找到麦克风设备', true);
      } else {
        MUI.toast('无法开始录音：' + (name || e.message || '未知错误'), true);
      }
    });
  }

  function onHoldDown(e) {
    if (state === 'busy') { return; }
    if (channel() === 'B') { return; }          // B 由 click 处理
    e.preventDefault();
    hold.active = true; hold.pid = e.pointerId; hold.startY = e.clientY;
    hold.cancel = false; hold.discard = false; hold.t0 = Date.now();
    try { holdTalk.setPointerCapture(e.pointerId); } catch (_) { /* 老内核忽略 */ }
    holdTalk.classList.add('armed');               // 按下即刻有反馈：授权弹窗/设备启动可能挡几秒
    setHint('正在启动录音…');
    startWebRecording();
  }

  function onHoldMove(e) {
    if (!hold.active || e.pointerId !== hold.pid) { return; }
    if (state !== 'recording') { return; }
    const up = hold.startY - e.clientY;
    const wantCancel = up > CANCEL_PX;
    if (wantCancel !== hold.cancel) {
      hold.cancel = wantCancel;
      setState('recording');                    // 仅刷类
      setHoldLabel(wantCancel ? '松手 取消' : '松开 发送');
    }
  }

  function onHoldUp(e) {
    if (!hold.active || (e && e.pointerId !== hold.pid)) { return; }
    hold.active = false;
    holdTalk.classList.remove('armed');
    if (state !== 'recording') { setHint(''); return; }   // 尚未真正开始录音：由 startWebRecording 的 !hold.active 分支兜底
    if (hold.cancel) { hold.discard = true; stopRecording(); return; }   // 上滑取消
    if (Date.now() - hold.t0 < MIN_HOLD_MS) { hold.discard = true; stopRecording(); MUI.toast('说话时间太短'); return; }
    hold.discard = false; stopRecording();                                // 正常：松手 → 识别
  }

  holdTalk.addEventListener('pointerdown', onHoldDown);
  holdTalk.addEventListener('pointermove', onHoldMove);
  holdTalk.addEventListener('pointerup', onHoldUp);
  holdTalk.addEventListener('pointercancel', function () {
    if (hold.active) {
      hold.active = false; holdTalk.classList.remove('armed'); setHint('');
      if (state === 'recording') { hold.discard = true; stopRecording(); }
    }
  });
  // 长按系统菜单/选择：一律拦掉（配合 CSS touch-action:none）
  holdTalk.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  /* ---------------- 路径 B：点大条 → 系统录音器 ---------------- */

  function openSystemRecorder() {
    voiceFile.value = '';
    voiceFile.click();
  }

  holdTalk.addEventListener('click', function () {
    if (state === 'busy') { MUI.toast('识别中，请稍候'); return; }
    if (channel() === 'B') openSystemRecorder();   // 路径 A 已走 pointer 手势，click 在此空转
  });

  voiceFile.addEventListener('change', function () {
    const f = voiceFile.files && voiceFile.files[0];
    if (!f) return;
    if (f.size > MAX_UPLOAD_B) { MUI.toast('录音过大，请控制在 60 秒内', true); return; }
    upload(f, f.name || 'voice.bin');
  });

  /* ---------------- 开关入口 ---------------- */

  btnVoice.addEventListener('click', function () {
    if (state === 'busy') { MUI.toast('识别中，请稍候'); return; }
    if (state === 'recording') { return; }         // 手指应在大条上，理论到不了这里，防御
    setVoiceMode(!voiceMode);
  });
})();
