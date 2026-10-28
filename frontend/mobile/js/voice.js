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
  // 录音浮层（微信 8.0 式）：屏幕中上部气泡，声波跟音量动，取消区红态
  const overlayEl = document.getElementById('recOverlay');
  const bubbleEl = document.getElementById('recBubble');
  const waveEl = document.getElementById('recWave');
  const recText = document.getElementById('recText');
  const recTimer = document.getElementById('recTimer');
  let audioCtx = null, rafId = null, freqBuf = null;   // WebAudio 电平 → 声波柱
  const BAR_K = [0.45, 0.7, 0.55, 0.85, 1.0, 0.85, 0.55, 0.7, 0.45];   // 中间强两边弱的造型系数
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

  /* ---------------- 录音浮层（A 通道专属；B 通道无音频流也无按住语义，不出现） ---------------- */

  function showOverlay(mode) {                    // starting | live | cancel
    if (!overlayEl || !bubbleEl) return;
    overlayEl.classList.remove('hidden');
    bubbleEl.classList.toggle('starting', mode === 'starting');
    bubbleEl.classList.toggle('cancel', mode === 'cancel');
    if (recText) recText.textContent = mode === 'starting' ? '正在启动麦克风…'
      : mode === 'cancel' ? '松开 取消发送' : '松开发送 · 上滑取消';
  }
  function hideOverlay() {
    if (!overlayEl || !bubbleEl) return;
    overlayEl.classList.add('hidden');
    bubbleEl.classList.remove('starting', 'cancel');
    stopLevelViz();
  }

  function startLevelViz(stream) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') { audioCtx.resume(); }   // 个别内核创建即挂起
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      freqBuf = new Uint8Array(analyser.frequencyBinCount);
      const bars = waveEl ? waveEl.children : [];
      (function loop() {
        rafId = requestAnimationFrame(loop);
        analyser.getByteFrequencyData(freqBuf);
        let sum = 0;
        for (let i = 2; i < 40; i++) sum += freqBuf[i];      // 主要取人声频段
        const level = Math.min(1, sum / (38 * 190));
        const t = performance.now() / 130;
        for (let i = 0; i < bars.length; i++) {
          const s = 0.18 + level * BAR_K[i] * (0.62 + 0.38 * Math.sin(t + i * 1.7));
          bars[i].style.transform = 'scaleY(' + Math.max(0.12, Math.min(1, s)).toFixed(3) + ')';
        }
      })();
    } catch (e) { /* 无 WebAudio：波形走 starting 的呼吸动画兜底，不影响录音 */ }
  }
  function stopLevelViz() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (e) { /* 已关闭忽略 */ } audioCtx = null; }
  }
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
        MUI.lastAsr = { recognized: text, ts: Date.now() };   // 供 mobile.js 发送时比对「用户改了哪些字」
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
    hideOverlay();
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
      showOverlay(hold.cancel ? 'cancel' : 'live');   // 状态信息收进浮层，底部小字让位
      recTimer.textContent = '0s';
      startLevelViz(stream);
      tick = setInterval(function () {
        recSec++;
        if (recSec >= MAX_RECORD_S) { hold.discard = false; stopRecording(); MUI.toast('已到 60 秒上限，自动停止'); return; }
        if (recTimer) recTimer.textContent = recSec + 's';
      }, 1000);
      recorder.start();
    }).catch(function (e) {
      hold.active = false; holdTalk.classList.remove('armed'); setState('idle'); setHint(''); setHoldLabel('按住 说话'); hideOverlay();
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
    showOverlay('starting');                        // 浮层出现在视线落点，接住「按住了吗」的疑问
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
      showOverlay(wantCancel ? 'cancel' : 'live');   // 浮层红态+大字✕，取消意图一眼可辨
    }
  }

  function onHoldUp(e) {
    if (!hold.active || (e && e.pointerId !== hold.pid)) { return; }
    hold.active = false;
    holdTalk.classList.remove('armed');
    if (state !== 'recording') { setHint(''); hideOverlay(); return; }   // 尚未真正开始录音：由 startWebRecording 的 !hold.active 分支兜底
    if (hold.cancel) { hold.discard = true; stopRecording(); return; }   // 上滑取消
    if (Date.now() - hold.t0 < MIN_HOLD_MS) { hold.discard = true; stopRecording(); MUI.toast('说话时间太短'); return; }
    hold.discard = false; stopRecording();                                // 正常：松手 → 识别
  }

  holdTalk.addEventListener('pointerdown', onHoldDown);
  holdTalk.addEventListener('pointermove', onHoldMove);
  holdTalk.addEventListener('pointerup', onHoldUp);
  holdTalk.addEventListener('pointercancel', function () {
    if (hold.active) {
      hold.active = false; holdTalk.classList.remove('armed'); setHint(''); hideOverlay();
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

  /* ---------------- 已学热词面板（透明排气阀） ----------------
     数据由后端从「识别 vs 发送」差值自动学习，用户无需也无需手动添加；
     面板只做两件事：看得见学了什么、删掉学错的（删除后永不再学）。 */

  const btnLearned = document.getElementById('btnLearnedHotwords');
  const hwSheet = document.getElementById('hotwordsSheet');
  const hwList = document.getElementById('hotwordsList');
  const hwClose = document.getElementById('btnCloseHotwords');

  function renderLearned(words) {
    const list = Object.keys(words).sort();
    hwList.innerHTML = '';
    if (!list.length) {
      const e = document.createElement('div'); e.className = 'hw-empty';
      e.textContent = '还没学到词。识别出错时改好文字再发送，同样的错第二次就会被记住。';
      hwList.appendChild(e);
      return;
    }
    list.forEach(function (w) {
      const row = document.createElement('div'); row.className = 'hw-item';
      const name = document.createElement('span'); name.className = 'hw-word'; name.textContent = w;
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'hw-del'; del.textContent = '删除';
      del.addEventListener('click', function () {
        del.disabled = true;
        fetch('/api/asr/hotwords/' + encodeURIComponent(w), { method: 'DELETE' })
          .then(function (r) { if (!r.ok) { throw new Error('HTTP ' + r.status); } return r.json(); })
          .then(function () { row.remove(); MUI.toast('已删除，不会再自动学「' + w + '」'); })
          .catch(function () { del.disabled = false; MUI.toast('删除失败', true); });
      });
      row.appendChild(name); row.appendChild(del);
      hwList.appendChild(row);
    });
  }

  function loadLearned() {
    hwList.innerHTML = '<div class="hw-empty">加载中…</div>';
    fetch('/api/asr/hotwords/learned')
      .then(function (r) { if (!r.ok) { throw new Error('HTTP ' + r.status); } return r.json(); })
      .then(function (j) { renderLearned(j.hotwords || {}); })
      .catch(function () { hwList.innerHTML = '<div class="hw-empty">加载失败，请重开面板</div>'; });
  }

  if (btnLearned && hwSheet && hwList && hwClose) {
    btnLearned.addEventListener('click', function () {
      const bcd = document.getElementById('btnCloseDrawer');
      if (bcd) bcd.click();                       // 先收抽屉，弹层不被遮住
      hwSheet.classList.remove('hidden');
      loadLearned();
    });
    hwClose.addEventListener('click', function () { hwSheet.classList.add('hidden'); });
    hwSheet.addEventListener('click', function (e) { if (e.target === hwSheet) hwSheet.classList.add('hidden'); });
  }
})();
