/* ZD Code 移动端语音输入（P3）
   🎤 按钮状态机 + 识别上传。两条路径自动降级：
     A 网页录音 getUserMedia+MediaRecorder —— 泛微放行时体验最好；
     B 系统录音器 <input accept="audio/*"> —— 与附件上传同源通道（§9 R7 同理），基本必通。
   A 权限一旦被拒就记入 localStorage，后续点击直接走 B，不再反复撞墙。
   识别端点：后端 POST /api/asr（ffmpeg 解码 → FunASR offline），返回 {text, truncated}；
   识别文字**追加**进输入框末尾，由用户编辑确认后再发送，绝不自动发。
   只依赖 window.MUI（ui.js 导出），与 mobile.js 协议层互不干涉。 */
(function () {
  'use strict';
  if (!window.MUI) { console.error('ui.js 未加载，voice.js 终止'); return; }
  const MUI = window.MUI;
  const el = MUI.el;

  const PREFER_B_KEY = 'm-voice-prefer-b';
  const MAX_RECORD_S = 60;          // 与后端 ASR_MAX_SECONDS 一致，到时自动停止
  const MAX_UPLOAD_B = 10 * 1024 * 1024;

  const btnVoice = document.getElementById('btnVoice');
  const voiceFile = document.getElementById('mVoiceFile');
  const voiceHint = document.getElementById('voiceHint');
  if (!btnVoice || !voiceFile || !voiceHint) return;

  let state = 'idle';               // idle | recording | busy
  let recorder = null, stream = null, chunks = [], tick = null, recSec = 0;

  function setHint(text) {
    voiceHint.textContent = text || '';
    voiceHint.classList.toggle('hidden', !text);
  }
  function setState(s) {
    state = s;
    btnVoice.classList.toggle('recording', s === 'recording');
    btnVoice.classList.toggle('busy', s === 'busy');
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
        if (!text) { MUI.toast('没听清内容，请再说一次', true); return; }
        appendText(text);
        MUI.toast(j.truncated ? '已识别（超 60 秒部分被截断）' : '识别完成，可编辑后发送');
      })
      .catch(function (e) {
        setHint(''); setState('idle');
        MUI.toast('识别失败：' + (e.message || '未知错误'), true);
      });
  }

  function appendText(text) {
    const cur = el.input.value;
    el.input.value = cur + (cur && !/[ \n]$/.test(cur) ? '\n' : '') + text;
    MUI.autoGrow();
    const pos = el.input.value.length;
    try { el.input.setSelectionRange(pos, pos); } catch (e) { /* 个别内核禁用 selection */ }
  }

  /* ---------------- 路径 A：网页录音 ---------------- */

  function onWebStopped() {
    releaseStream();
    const mime = (recorder && recorder.mimeType) || '';
    const blob = new Blob(chunks, { type: mime || 'audio/webm' });
    chunks = [];
    if (blob.size < 1000) {
      setHint(''); setState('idle');
      MUI.toast('录音太短，没采集到声音', true);
      return;
    }
    upload(blob, 'voice.' + (mime.indexOf('mp4') > -1 ? 'm4a' : 'webm'));
  }

  function stopRecording() {
    clearInterval(tick); tick = null;
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); }
    catch (e) { releaseStream(); setHint(''); setState('idle'); MUI.toast('停止录音失败', true); }
  }

  function startWebRecording() {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
      stream = s; chunks = []; recSec = 0;
      const mime = pickMime();
      recorder = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s);
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = onWebStopped;
      setState('recording');
      setHint('录音中…再点麦克风停止');
      tick = setInterval(function () {
        recSec++;
        if (recSec >= MAX_RECORD_S) { stopRecording(); MUI.toast('已到 60 秒上限，自动停止'); return; }
        setHint('录音中 ' + recSec + 's…再点麦克风停止');
      }, 1000);
      recorder.start();
    }).catch(function (e) {
      setHint(''); setState('idle');
      const name = (e && e.name) || '';
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDenied') {
        try { localStorage.setItem(PREFER_B_KEY, '1'); } catch (err) { /* 无痕模式忽略 */ }
        MUI.toast('此应用内网页录音被限制，改用系统录音器');
        openSystemRecorder();                    // 直接降级，不逼用户点第二次
      } else if (name === 'NotFoundError') {
        MUI.toast('没找到麦克风设备', true);
      } else {
        MUI.toast('无法开始录音：' + (name || e.message || '未知错误'), true);
      }
    });
  }

  /* ---------------- 路径 B：系统录音器 ---------------- */

  function openSystemRecorder() {
    voiceFile.value = '';
    voiceFile.click();
  }

  voiceFile.addEventListener('change', function () {
    const f = voiceFile.files && voiceFile.files[0];
    if (!f) return;
    if (f.size > MAX_UPLOAD_B) { MUI.toast('录音过大，请控制在 60 秒内', true); return; }
    upload(f, f.name || 'voice.bin');
  });

  /* ---------------- 按钮入口 ---------------- */

  btnVoice.addEventListener('click', function () {
    if (state === 'busy') { MUI.toast('识别中，请稍候'); return; }
    if (state === 'recording') { stopRecording(); return; }
    let preferB = false;
    try { preferB = localStorage.getItem(PREFER_B_KEY) === '1'; } catch (e) { /* 忽略 */ }
    if (preferB || !hasWebRecorder()) openSystemRecorder();
    else startWebRecording();
  });
})();
