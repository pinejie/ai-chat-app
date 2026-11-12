// --- Theme ---
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // Switch hljs stylesheet
  const isDark = theme === 'dark';
  document.getElementById('hljs-dark').disabled = !isDark;
  document.getElementById('hljs-light').disabled = isDark;
  // Update active button
  document.querySelectorAll('.theme-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.t === theme);
  });
}

function setTheme(theme) {
  localStorage.setItem('theme', theme);
  applyTheme(theme);
}

// Init theme
(function() {
  const saved = localStorage.getItem('theme') || 'dark';
  applyTheme(saved);

})();

// marked v5+ 已移除 highlight 选项（PC 端 CDN 加载的是 v18），代码高亮需走 marked-highlight 扩展。
// 这里不再传无效配置；聊天气泡的代码块高亮是独立问题，见后续处理。
marked.setOptions({ breaks: true });
