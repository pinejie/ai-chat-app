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

marked.setOptions({
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    return hljs.highlightAuto(code).value;
  },
  breaks: true
});
