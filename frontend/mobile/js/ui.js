/* ZD Code 移动端 UI 层（阶段二第 1 步）
   职责边界：只管抽屉、主题、视口高度、输入框自增高、轻提示。
   鉴权探测 / 会话 / WebSocket / 消息渲染在 js/mobile.js（第 2 步），本文件不碰网络。
   与 PC 端 frontend/static/js 完全隔离，改这里不影响 PC（需求文档 §3.1 D1）。 */
(function () {
  'use strict';

  const THEME_KEY = 'cc-theme';            // 与 PC 端 theme.js 同名：同源下共享偏好
  const ALLOWED_THEMES = ['dark', 'light', 'warm'];
  const HLJS_LINK = {
    dark: '/static/highlight-theme-dark.css',
    light: '/static/highlight-theme-light.css',
    warm: '/static/highlight-theme-light.css',
  };
  const MAX_INPUT_H = 132;                 // 与 style.css 的 .input max-height 保持一致

  const $ = (id) => document.getElementById(id);
  const el = {
    root: document.documentElement,
    login: $('loginOverlay'), tokenInput: $('tokenInput'), btnLogin: $('btnLogin'),
    loginError: $('loginError'), btnTogglePw: $('btnTogglePw'),
    btnMenu: $('btnMenu'), btnCloseDrawer: $('btnCloseDrawer'),
    drawer: $('drawer'), mask: $('drawerMask'),
    btnTheme: $('btnTheme'), themeSeg: $('mThemeSeg'), modeSeg: $('mModeSeg'),
    btnModel: $('btnModel'), sheet: $('modelSheet'), btnCloseSheet: $('btnCloseSheet'),
    btnDocs: $('btnDocs'), docsPane: $('docsPane'),
    input: $('mInput'), messages: $('mMessages'), msgList: $('mMsgList'),
    empty: $('emptyState'), thinking: $('thinking'), toast: $('toast'),
    // 以下由第 2 步的 mobile.js 使用，统一在此注册，避免两个文件各拿一半
    btnSend: $('btnSend'), btnStop: $('btnStop'), mFileInput: $('mFileInput'),
    mSessionList: $('mSessionList'), sessionTitle: $('sessionTitle'), connState: $('connState'),
    offlineBar: $('offlineBar'), offlineText: $('offlineText'), btnReconnect: $('btnReconnect'),
    renameOverlay: $('renameOverlay'), renameInput: $('renameInput'), renameError: $('renameError'),
    btnRenameCancel: $('btnRenameCancel'), btnRenameSave: $('btnRenameSave'),
    docsList: $('docsList'), docsPath: $('docsPath'),
    btnNewSession: $('btnNewSession'), btnLogout: $('btnLogout'),
    modelList: $('modelList'), attachBar: $('attachBar'),
  };

  /* ---------------- 主题 ---------------- */

  function readStoredTheme() {
    try {
      const t = localStorage.getItem(THEME_KEY);
      return ALLOWED_THEMES.indexOf(t) >= 0 ? t : 'dark';
    } catch (e) {
      return 'dark';                       // 隐私模式 / WebView 禁用 storage
    }
  }

  function applyTheme(theme) {
    el.root.setAttribute('data-theme', theme);
    const link = $('hljsTheme');
    if (link) link.href = HLJS_LINK[theme] || HLJS_LINK.dark;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#0a0a0f' : (theme === 'warm' ? '#f5f0e8' : '#f5f5f5');
    markSeg(el.themeSeg, 'theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* 存不下不影响本次使用 */ }
  }

  function currentTheme() {
    return el.root.getAttribute('data-theme') || 'dark';
  }

  function nextTheme() {
    const i = ALLOWED_THEMES.indexOf(currentTheme());
    return ALLOWED_THEMES[(i + 1) % ALLOWED_THEMES.length];
  }

  /* 段选按钮的高亮态：按 data-<attr> 匹配 */
  function markSeg(seg, attr, value) {
    if (!seg) return;
    seg.querySelectorAll('.seg-item').forEach(function (b) {
      const on = b.getAttribute('data-' + attr) === value;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  /* ---------------- 抽屉 ---------------- */

  let drawerOpen = false;

  function setDrawer(open) {
    drawerOpen = open;
    el.drawer.classList.toggle('open', open);
    el.mask.classList.toggle('open', open);
    el.drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    el.btnMenu.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function bindDrawer() {
    el.btnMenu.addEventListener('click', function () { setDrawer(!drawerOpen); });
    el.btnCloseDrawer.addEventListener('click', function () { setDrawer(false); });
    el.mask.addEventListener('click', function () { setDrawer(false); });

    // 向右滑关闭（§5.2 三种关闭方式之一）。位移阈值 40px，避免与列表滚动误判
    let x0 = null, y0 = null;
    el.drawer.addEventListener('touchstart', function (e) {
      const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY;
    }, { passive: true });
    el.drawer.addEventListener('touchend', function (e) {
      if (x0 === null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;
      x0 = null;
      if (dx < -40 && Math.abs(dy) < 60) setDrawer(false);
    }, { passive: true });
  }

  /* ---------------- 底部弹层 / 文档面板 ---------------- */

  function bindSheet() {
    if (el.btnModel) el.btnModel.addEventListener('click', function () {
      el.sheet.classList.remove('hidden');
    });
    if (el.btnCloseSheet) el.btnCloseSheet.addEventListener('click', closeSheet);
    if (el.sheet) el.sheet.addEventListener('click', function (e) {
      if (e.target === el.sheet) closeSheet();
    });
  }

  function closeSheet() { if (el.sheet) el.sheet.classList.add('hidden'); }

  function bindDocs() {
    if (!el.btnDocs) return;
    el.btnDocs.addEventListener('click', function () {
      const show = el.docsPane.classList.toggle('hidden') === false;
      el.btnDocs.setAttribute('aria-expanded', show ? 'true' : 'false');
    });
  }

  /* ---------------- R1 视口高度与软键盘 ---------------- */
  /* 三层兜底（§9 R-2：泛微 WebView 内核未知）：
     1) style.css 已给 100vh 兜底、@supports 给 100dvh
     2) 内核支持 visualViewport 时，这里用真实可见高度覆盖 --vvh（inline 优先级最高）
     3) 不支持 visualViewport 时不设 inline，让 CSS 的 100vh/100dvh 生效 */
  function syncViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    const h = Math.round(vv.height);
    if (h > 0) el.root.style.setProperty('--vvh', h + 'px');
    // 键盘弹起时输入框必须仍在可视区内，否则用户看不见自己打的字
    if (document.activeElement === el.input) scrollToBottom();
  }

  function bindViewport() {
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', syncViewport);
      vv.addEventListener('scroll', syncViewport);
    }
    window.addEventListener('orientationchange', function () {
      setTimeout(syncViewport, 260);        // 旋转后 WebView 上报高度有延迟
    });
    syncViewport();
  }

  /* ---------------- 输入框 ---------------- */

  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, MAX_INPUT_H) + 'px';
  }

  function bindInput() {
    el.input.addEventListener('input', autoGrow);
    // 回车发送、Shift+回车换行。触屏键盘没有 Shift，所以 enterkeyhint 保留换行能力靠
    // 输入法自身；这里仅在非 composing 状态发送，避免中文输入法选词时误发
    el.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !isComposing(e)) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('m:send'));
      }
    });
    el.input.addEventListener('focus', function () { setTimeout(syncViewport, 120); });
  }

  function isComposing(e) {
    return e.isComposing === true || e.keyCode === 229;
  }

  /* ---------------- 登录遮罩（第 2 步接入真实探测，这里只做显隐与口令显隐） ---------------- */

  function setLoginVisible(visible) {
    el.login.classList.toggle('hidden', !visible);
    if (visible) setTimeout(function () { el.tokenInput.focus(); }, 120);
  }

  function bindLogin() {
    if (el.btnTogglePw) el.btnTogglePw.addEventListener('click', function () {
      const show = el.tokenInput.type === 'password';
      el.tokenInput.type = show ? 'text' : 'password';
      el.btnTogglePw.textContent = show ? '隐藏' : '显示';
    });
  }

  /* 重命名弹层：mobile.js 管数据与保存，这里只管显隐和初始聚焦（同登录套路） */
  function setRenameVisible(visible) {
    if (!el.renameOverlay) return;
    el.renameOverlay.classList.toggle('hidden', !visible);
    if (visible && el.renameInput) {
      setTimeout(function () { try { el.renameInput.focus(); } catch (e) {} }, 120);
    }
  }

  /* ---------------- 通用反馈 ---------------- */

  let toastTimer = null;
  function toast(msg, isError) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.toggle('err', isError === true);
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 2400);
  }

  function scrollToBottom() {
    if (!el.messages) return;
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function setEmptyVisible(visible) {
    if (el.empty) el.empty.classList.toggle('hidden', !visible);
  }

  function setThinking(visible) {
    if (el.thinking) el.thinking.classList.toggle('hidden', !visible);
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    applyTheme(readStoredTheme());
    bindDrawer();
    bindSheet();
    bindDocs();
    bindViewport();
    bindInput();
    bindLogin();
    setDrawer(false);
    if (el.themeSeg) el.themeSeg.addEventListener('click', function (e) {
      const b = e.target.closest('.seg-item');
      if (b) applyTheme(b.getAttribute('data-theme'));
    });
    if (el.btnTheme) el.btnTheme.addEventListener('click', function () { applyTheme(nextTheme()); });
  }

  // 暴露给第 2 步的 js/mobile.js：命名空间唯一，避免与 PC 端 window.* 全局函数冲突
  window.MUI = {
    el: el, $: $,
    applyTheme: applyTheme, currentTheme: currentTheme,
    setDrawer: setDrawer, closeSheet: closeSheet,
    setLoginVisible: setLoginVisible, setRenameVisible: setRenameVisible,
    isComposing: isComposing,
    syncViewport: syncViewport, autoGrow: autoGrow,
    scrollToBottom: scrollToBottom, setEmptyVisible: setEmptyVisible,
    setThinking: setThinking, toast: toast, markSeg: markSeg,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
