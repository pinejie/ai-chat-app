// --- 动态加载 highlight.js 缺失的语言定义 ---
// highlight.min.js 只内置 37 种常见语言，以下语言需要从 CDN 额外加载
(function loadExtraHljsLangs() {
  var extraLangs = ['groovy','scala','dockerfile','cmake','dart','toml'];
  var base = 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.12.0/build/languages/';
  extraLangs.forEach(function(lang) {
    var s = document.createElement('script');
    s.src = base + lang + '.min.js';
    document.head.appendChild(s);
  });
})();

// --- Sidebar Tab Switching ---
let currentSidebarTab = 'chat';

function switchSidebarTab(tab) {
  currentSidebarTab = tab;
  document.getElementById('tabChat').classList.toggle('active', tab === 'chat');
  document.getElementById('tabProjects').classList.toggle('active', tab === 'projects');
  document.getElementById('chatList').style.display = tab === 'chat' ? '' : 'none';
  document.getElementById('projectList').style.display = tab === 'projects' ? 'block' : 'none';
  document.getElementById('newChatBtn').style.display = tab === 'chat' ? '' : 'none';
  if (tab === 'projects') loadProjects();
}

// --- Project Documents ---
let currentDocPath = '';

/**
 * Load the root-level directory listing and render the tree.
 */
async function loadProjects() {
  try {
    const data = await (await fetch(API + '/api/browse?rel_path=')).json();
    renderProjectTree(data);
  } catch (err) {
    console.error('Failed to load projects:', err);
  }
}

/**
 * Render the tree from a browse response.
 * data = { files: [...], dirs: [...] }
 * parentEl = container to append nodes into
 * depth  = current nesting depth (0 = root)
 * basePath = relative path prefix for children (e.g. "科创项目管理" or "科创项目管理/123")
 */
function renderBrowseItems(data, parentEl, depth, basePath) {
  const ROOT_PROJECT = '根目录';
  // For files at root level (depth 0), projectName is "根目录"
  // For files inside a top-level folder, projectName is that folder's name
  const projectName = (depth === 0) ? ROOT_PROJECT : basePath.split('/')[0];

  // Directories first, then files
  for (const dirName of data.dirs) {
    const dirRelPath = basePath ? basePath + '/' + dirName : dirName;
    const node = createFolderNode(dirName, dirRelPath, projectName, depth);
    parentEl.appendChild(node);
  }
  for (const fileName of data.files) {
    const fileRelPath = basePath ? basePath + '/' + fileName : fileName;
    const node = createFileNode(fileName, fileRelPath, projectName, depth);
    parentEl.appendChild(node);
  }
}

/**
 * Create a folder tree node. Click to expand/collapse (lazy-load on first expand).
 */
function createFolderNode(dirName, dirRelPath, projectName, depth) {
  const group = document.createElement('div');
  group.className = 'proj-group';

  const header = document.createElement('div');
  header.className = 'proj-name';
  header.style.paddingLeft = (12 + depth * 16) + 'px';
  header.innerHTML = '<span class="arrow">&#9654;</span><span class="folder-icon">&#128193;</span>' + escapeHtml(dirName);

  const childrenEl = document.createElement('div');
  childrenEl.className = 'proj-files';
  let loaded = false;

  header.onclick = function() {
    const isOpen = this.classList.toggle('open');
    childrenEl.classList.toggle('open', isOpen);
    if (isOpen && !loaded) {
      // Lazy load children
      loaded = true;
      childrenEl.innerHTML = '<div class="proj-loading" style="padding:6px 12px 6px ' + (28 + depth * 16) + 'px;font-size:11px;color:var(--text4)">加载中...</div>';
      fetch(API + '/api/browse?rel_path=' + encodeURIComponent(dirRelPath))
        .then(r => r.json())
        .then(data => {
          childrenEl.innerHTML = '';
          if (data.dirs.length === 0 && data.files.length === 0) {
            childrenEl.innerHTML = '<div style="padding:6px 12px 6px ' + (28 + depth * 16) + 'px;font-size:11px;color:var(--text4)">空文件夹</div>';
          } else {
            renderBrowseItems(data, childrenEl, depth + 1, dirRelPath);
          }
        })
        .catch(err => {
          childrenEl.innerHTML = '<div style="padding:6px 12px;font-size:11px;color:var(--danger2)">加载失败</div>';
          loaded = false; // allow retry
        });
    }
  };

  group.appendChild(header);
  group.appendChild(childrenEl);
  return group;
}

/**
 * Create a file tree node. Click to open in doc view.
 */
function createFileNode(fileName, fileRelPath, projectName, depth) {
  const fileEl = document.createElement('div');
  fileEl.className = 'proj-file';
  fileEl.style.paddingLeft = (28 + depth * 16) + 'px';
  fileEl.setAttribute('data-file', fileRelPath);
  fileEl.setAttribute('data-project', projectName);
  fileEl.innerHTML = '<span class="file-icon">&#128196;</span>' + escapeHtml(fileName);
  fileEl.onclick = function(e) {
    e.stopPropagation();
    openDocView(fileRelPath);
    document.querySelectorAll('.proj-file').forEach(x => x.classList.remove('active'));
    this.classList.add('active');
  };
  return fileEl;
}

/**
 * Render the root-level tree (called by loadProjects).
 */
function renderProjectTree(data) {
  const el = document.getElementById('projectList');
  el.innerHTML = '';
  if (data.dirs.length === 0 && data.files.length === 0) {
    el.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--text4)">暂无项目文档</div>';
    return;
  }
  renderBrowseItems(data, el, 0, '');
}

// --- 文件类型辅助 ---
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
let docHtmlSource = '';
let docPreviewMode = false;

function isImageFile(name) { const s = name.toLowerCase(); return IMAGE_EXTS.some(e => s.endsWith(e)); }
function isHtmlFile(name) { const s = name.toLowerCase(); return s.endsWith('.html') || s.endsWith('.htm'); }
const BINARY_EXTS = ['.ppt', '.doc', '.xls', '.zip', '.rar', '.7z'];
const OFFICE_EXTS = ['.pptx', '.docx', '.xlsx'];
function isBinaryFile(name) { const s = name.toLowerCase(); return BINARY_EXTS.some(e => s.endsWith(e)); }
function isOfficeFile(name) { const s = name.toLowerCase(); return OFFICE_EXTS.some(e => s.endsWith(e)); }
function isPdfFile(name) { return name.toLowerCase().endsWith('.pdf'); }

function setPreviewBtn(show) {
  const btn = document.getElementById('docPreviewBtn');
  btn.style.display = show ? '' : 'none';
  if (show) btn.textContent = '预览';
}

function setFullscreenBtn(show) {
  document.getElementById('docFullscreenBtn').style.display = show ? '' : 'none';
}


// --- LibreOffice feature detection (cached) ---
let _featuresCache = null;
async function getFeatures() {
  if (_featuresCache) return _featuresCache;
  try {
    const res = await fetch(API + '/api/features');
    _featuresCache = await res.json();
  } catch (e) {
    _featuresCache = { libreoffice: false };
  }
  return _featuresCache;
}

// --- 代码行号 ---
function addLineNumbers(codeEl) {
  var lines = codeEl.innerHTML.split('\n');
  // 去掉末尾空行
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  var html = '';
  for (var i = 0; i < lines.length; i++) {
    html += '<span class="ln">' + (i + 1) + '</span>' + lines[i] + '\n';
  }
  codeEl.innerHTML = html;
}

// --- 代码语言检测 ---
const CODE_EXT_MAP = {
  '.js': 'javascript', '.mjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.java': 'java', '.py': 'python', '.go': 'go',
  '.rs': 'rust', '.c': 'c', '.cpp': 'cpp', '.h': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.rb': 'ruby', '.php': 'php', '.swift': 'swift',
  '.kt': 'kotlin', '.scala': 'scala', '.r': 'r', '.sql': 'sql',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.xml': 'xml', '.html': 'xml', '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.lua': 'lua', '.pl': 'perl', '.groovy': 'groovy', '.dart': 'dart',
  '.vue': 'xml', '.svelte': 'xml', '.tsx': 'typescript',
  '.md': 'markdown', '.txt': 'plaintext', '.log': 'plaintext',
  '.properties': 'ini', '.conf': 'ini', '.cfg': 'ini', '.env': 'ini',
  '.dockerfile': 'dockerfile', '.makefile': 'makefile', '.cmake': 'cmake',
  '.gradle': 'groovy', '.pom': 'xml',
};
function detectCodeLang(filename) {
  var s = filename.toLowerCase();
  if (s.startsWith('dockerfile')) return 'dockerfile';
  if (s === 'makefile' || s.startsWith('makefile.')) return 'makefile';
  for (var ext in CODE_EXT_MAP) {
    if (s.endsWith(ext)) return CODE_EXT_MAP[ext];
  }
  return null;
}

async function renderDocContent(data) {
  const inner = document.getElementById('docContentInner');
  if (isImageFile(data.filename)) {
    inner.innerHTML = '<div class="doc-img-wrap"><img class="doc-img" src="' + API + '/api/projects/image?path=' + encodeURIComponent(currentDocPath) + '"></div>';
  } else if (isOfficeFile(data.filename)) {
    setFullscreenBtn(true);
    await renderOfficePreview(data);
  } else if (isBinaryFile(data.filename)) {
    const dlUrl = API + '/api/projects/download?path=' + encodeURIComponent(currentDocPath);
    inner.innerHTML = '<div class="doc-binary-card">'
      + '<div class="doc-binary-icon">&#128230;</div>'
      + '<div class="doc-binary-name">' + escapeHtml(data.filename) + '</div>'
      + '<div class="doc-binary-tip">该文件类型暂不支持在线预览</div>'
      + '<a class="doc-btn" href="' + dlUrl + '" download>&#11015; 下载文件</a>'
      + '</div>';
  } else if (isPdfFile(data.filename)) {
    document.getElementById('docContentArea').classList.add('previewing');
    inner.innerHTML = '<iframe class="doc-iframe" src="' + API + '/api/projects/image?path=' + encodeURIComponent(currentDocPath) + '"></iframe>';
    setFullscreenBtn(true);
  } else if (isHtmlFile(data.filename)) {
    docHtmlSource = data.content;
    inner.innerHTML = '<pre class="doc-pre"><code class="language-html">' + escapeHtml(data.content) + '</code></pre>';
    var codeEl = inner.querySelector('pre code');
    if (codeEl && typeof hljs !== 'undefined') {
      hljs.highlightElement(codeEl);
      addLineNumbers(codeEl);
    }
    setPreviewBtn(true);
  } else if (/\.md$/i.test(data.filename)) {
    inner.innerHTML = '<div class="bubble">' + marked.parse(data.content) + '</div>';
  } else {
    var lang = detectCodeLang(data.filename);
    var cls = lang ? ' class="language-' + lang + '"' : '';
    inner.innerHTML = '<pre class="doc-pre"><code' + cls + '>' + escapeHtml(data.content) + '</code></pre>';
    var codeEl = inner.querySelector('pre code');
    if (codeEl && typeof hljs !== 'undefined') {
      hljs.highlightElement(codeEl);
      addLineNumbers(codeEl);
    }
  }
}

function toggleHtmlPreview() {
  if (!docHtmlSource) return;
  docPreviewMode = !docPreviewMode;
  const inner = document.getElementById('docContentInner');
  const contentArea = document.getElementById('docContentArea');
  const btn = document.getElementById('docPreviewBtn');
  if (docPreviewMode) {
    inner.innerHTML = '<iframe class="doc-iframe" sandbox></iframe>';
    inner.querySelector('.doc-iframe').srcdoc = docHtmlSource;
    contentArea.classList.add('previewing');
    btn.textContent = '源码';
  } else {
    inner.innerHTML = '<pre class="doc-pre"><code class="language-html">' + escapeHtml(docHtmlSource) + '</code></pre>';
    contentArea.classList.remove('previewing');
    btn.textContent = '预览';
    var codeEl = inner.querySelector('pre code');
    if (codeEl && typeof hljs !== 'undefined') {
      hljs.highlightElement(codeEl);
      addLineNumbers(codeEl);
    }
  }
}

async function openDocView(docPath) {
  currentDocPath = docPath;
  isEditing = false;
  docHtmlSource = '';
  docPreviewMode = false;
  const filename = docPath.split('/').pop();
  const dirPath = docPath.includes('/') ? docPath.substring(0, docPath.lastIndexOf('/')) : '';
  document.getElementById('docContentArea').classList.remove('previewing');
  document.getElementById('docEditArea').style.display = 'none';
  document.getElementById('docTitle').textContent = docPath;
  // 图片/二进制文件不能文本编辑，隐藏编辑按钮
  document.getElementById('docEditBtn').style.display = (isImageFile(filename) || isBinaryFile(filename) || isOfficeFile(filename)) ? 'none' : '';
  setPreviewBtn(false);
  setFullscreenBtn(false);
  if (slideState.active) closeSlideViewer();
  document.getElementById('docContentInner').innerHTML = '<span style="color:var(--text4)">加载中...</span>';
  // Show doc view, hide chat
  document.getElementById('chatMain').style.display = 'none';
  document.getElementById('docView').classList.add('active');
  try {
    const res = await fetch(API + '/api/projects/content?path=' + encodeURIComponent(docPath));
    const data = await res.json();
    await renderDocContent(data);
  } catch (err) {
    document.getElementById('docContentInner').innerHTML = '<span style="color:var(--danger2)">加载失败: ' + escapeHtml(err.message) + '</span>';
  }
}

function closeDocView() {
  document.getElementById('docView').classList.remove('active');
  document.getElementById('chatMain').style.display = '';
  // Clear active file highlight
  document.querySelectorAll('.proj-file').forEach(function(x) { x.classList.remove('active'); });
  currentDocPath = '';
  docHtmlSource = '';
  docPreviewMode = false;
  document.getElementById('docContentArea').classList.remove('previewing');
  setPreviewBtn(false);
  setFullscreenBtn(false);
  if (slideState.active) closeSlideViewer();
}



async function renderOfficePreview(data) {
  const inner = document.getElementById('docContentInner');
  const contentArea = document.getElementById('docContentArea');
  const features = await getFeatures();
  const dlUrl = API + '/api/projects/download?path=' + encodeURIComponent(currentDocPath);

  if (!features.libreoffice) {
    // Show install guide + download button
    inner.innerHTML = '<div class="doc-binary-card">'
      + '<div class="doc-binary-icon">&#128196;</div>'
      + '<div class="doc-binary-name">' + escapeHtml(data.filename) + '</div>'
      + '<div class="doc-binary-tip" style="margin-bottom:12px">预览 Office 文件需要安装 LibreOffice</div>'
      + '<div class="doc-install-guide">'
      + '<div style="font-size:12px;color:var(--text3);margin-bottom:6px;font-weight:600">安装命令：</div>'
      + '<code class="doc-install-cmd">sudo apt install -y libreoffice</code>'
      + '<code class="doc-install-cmd">sudo yum install -y libreoffice</code>'
      + '<code class="doc-install-cmd">brew install --cask libreoffice</code>'
      + '</div>'
      + '<a class="doc-btn" href="' + dlUrl + '" download style="margin-top:12px">&#11015; 先下载文件</a>'
      + '</div>';
    return;
  }

  // LibreOffice available - show loading then preview
  inner.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text3)">'
    + '<span>&#9203; 正在转换文件，请稍候...</span></div>';

  const previewUrl = API + '/api/projects/preview?path=' + encodeURIComponent(currentDocPath);
  try {
    const res = await fetch(previewUrl);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || '转换失败 (' + res.status + ')');
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    contentArea.classList.add('previewing');
    inner.innerHTML = '<iframe class="doc-iframe" src="' + objectUrl + '"></iframe>';
  } catch (err) {
    inner.innerHTML = '<div class="doc-binary-card">'
      + '<div class="doc-binary-icon" style="color:var(--danger2)">&#9888;</div>'
      + '<div class="doc-binary-name">' + escapeHtml(data.filename) + '</div>'
      + '<div class="doc-binary-tip">' + escapeHtml(err.message) + '</div>'
      + '<a class="doc-btn" href="' + dlUrl + '" download>&#11015; 下载文件</a>'
      + '</div>';
  }
}

// --- 幻灯片全屏阅读器 ---
let slideState = { active: false, current: 1, total: 0, docPath: '' };

function toggleSlideViewer() {
  if (slideState.active) { closeSlideViewer(); return; }
  openSlideViewer(currentDocPath);
}

async function openSlideViewer(docPath) {
  const viewer = document.getElementById('slideViewer');
  const body = document.getElementById('slideViewerBody');
  const loading = document.getElementById('slideViewerLoading');
  const titleEl = document.getElementById('slideViewerTitle');
  const counterEl = document.getElementById('slideViewerCounter');
  const filename = docPath.split('/').pop();

  slideState = { active: true, current: 1, total: 0, docPath: docPath };
  titleEl.textContent = filename;
  counterEl.textContent = '';
  body.style.display = 'none';
  loading.style.display = 'flex';
  viewer.classList.add('active');

  try {
    const res = await fetch(API + '/api/projects/slides?path=' + encodeURIComponent(docPath));
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || '准备幻灯片失败 (' + res.status + ')');
    }
    const data = await res.json();
    slideState.total = data.total;
    counterEl.textContent = '1 / ' + data.total;
    // Load first slide image
    const firstUrl = API + '/api/projects/slide_page?path=' + encodeURIComponent(docPath) + '&page=1';
    const img = document.getElementById('slideImg');
    img.onload = function() {
      body.style.display = 'flex';
      loading.style.display = 'none';
      updateSlideNav();
    };
    img.src = firstUrl;
  } catch (err) {
    loading.innerHTML = '<div style="text-align:center"><div style="color:#ef4444;font-size:24px;margin-bottom:8px">&#9888;</div><div style="margin-bottom:12px">' + escapeHtml(err.message) + '</div><button class="doc-btn" onclick="closeSlideViewer()">关闭</button></div>';
  }
}

function closeSlideViewer() {
  slideState.active = false;
  document.getElementById('slideViewer').classList.remove('active');
  var loading = document.getElementById('slideViewerLoading');
  loading.style.display = 'none';
  loading.innerHTML = '<span>&#9203; 正在准备幻灯片，请稍候...</span>';
  document.getElementById('slideViewerBody').style.display = 'flex';
  document.getElementById('slideImg').src = '';
}

function goToSlide(page) {
  if (page < 1 || page > slideState.total) return;
  slideState.current = page;
  var url = API + '/api/projects/slide_page?path=' + encodeURIComponent(slideState.docPath) + '&page=' + page;
  document.getElementById('slideImg').src = url;
  document.getElementById('slideViewerCounter').textContent = page + ' / ' + slideState.total;
  updateSlideNav();
}

function updateSlideNav() {
  var prevBtn = document.querySelector('.slide-nav-prev');
  var nextBtn = document.querySelector('.slide-nav-next');
  if (prevBtn) prevBtn.style.opacity = slideState.current <= 1 ? '0.3' : '1';
  if (nextBtn) nextBtn.style.opacity = slideState.current >= slideState.total ? '0.3' : '1';
}

function prevSlide() { goToSlide(slideState.current - 1); }
function nextSlide() { goToSlide(slideState.current + 1); }

function slideKeyHandler(e) {
  if (!slideState.active) return;
  switch (e.key) {
    case 'ArrowUp': case 'ArrowLeft': case 'PageUp':
      e.preventDefault(); prevSlide(); break;
    case 'ArrowDown': case 'ArrowRight': case 'PageDown':
      e.preventDefault(); nextSlide(); break;
    case 'Escape':
      e.preventDefault(); closeSlideViewer(); break;
    case 'Home':
      e.preventDefault(); goToSlide(1); break;
    case 'End':
      e.preventDefault(); goToSlide(slideState.total); break;
  }
}

document.addEventListener('keydown', slideKeyHandler);

// --- Document Edit/Delete/New ---
let isEditing = false;
let modalCallback = null;

function editDoc() {
  if (!currentDocPath || isEditing) return;
  isEditing = true;
  // Fetch raw content
  fetch(API + '/api/projects/content?path=' + encodeURIComponent(currentDocPath))
    .then(r => r.json())
    .then(data => {
      document.getElementById('docContentArea').style.display = 'none';
      document.getElementById('docEditArea').style.display = 'flex';
      document.getElementById('docEditText').value = data.content;
      document.getElementById('docEditText').focus();
    })
    .catch(err => { alert('加载失败: ' + err.message); isEditing = false; });
}

function cancelEdit() {
  isEditing = false;
  document.getElementById('docEditArea').style.display = 'none';
  document.getElementById('docContentArea').style.display = '';
}

function saveDoc() {
  if (!currentDocPath) return;
  const newContent = document.getElementById('docEditText').value;
  fetch(API + '/api/projects/content?path=' + encodeURIComponent(currentDocPath), {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({content: newContent})
  })
  .then(r => { if(!r.ok) throw new Error('Save failed'); return r.json(); })
  .then(() => {
    isEditing = false;
    // Refresh view
    openDocView(currentDocPath);
  })
  .catch(err => alert('保存失败: ' + err.message));
}
function downloadDoc() {
  if (!currentDocPath) return;
  const dlUrl = API + '/api/projects/download?path=' + encodeURIComponent(currentDocPath);
  const a = document.createElement('a');
  a.href = dlUrl;
  a.download = currentDocPath.split('/').pop();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}


function deleteDoc() {
  if (!currentDocPath) return;
  const filename = currentDocPath.split('/').pop();
  if (!confirm('确定删除 ' + filename + '？此操作不可恢复。')) return;
  fetch(API + '/api/projects/content?path=' + encodeURIComponent(currentDocPath), {
    method: 'DELETE'
  })
  .then(r => { if(!r.ok) throw new Error('Delete failed'); return r.json(); })
  .then(() => {
    closeDocView();
    loadProjects();
  })
  .catch(err => alert('删除失败: ' + err.message));
}

function showNewDocModal() {
  if (!currentDocPath) {
    alert('请先选择一个文件');
    return;
  }
  // Determine the directory for the new file (same directory as current file)
  const lastSlash = currentDocPath.lastIndexOf('/');
  const dirPath = (lastSlash >= 0) ? currentDocPath.substring(0, lastSlash) : '';
  const dirLabel = dirPath || '根目录';

  document.getElementById('modalTitle').textContent = '新建文档 - ' + dirLabel;
  document.getElementById('modalInput').value = '';
  document.getElementById('modalInput').placeholder = '输入文件名（如 05-新文档.md）';
  modalCallback = function(filename) {
    const newFilename = filename.endsWith('.md') ? filename : filename + '.md';
    // Create file via /api/projects/content?dir=...
    fetch(API + '/api/projects/content?dir=' + encodeURIComponent(dirPath), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({filename: filename, content: '# ' + filename.replace('.md','') + '\n'})
    })
    .then(r => { if(!r.ok) throw new Error('Create failed'); return r.json(); })
    .then(() => {
      loadProjects();
      // Open the new doc
      const newDocPath = dirPath ? dirPath + '/' + newFilename : newFilename;
      openDocView(newDocPath);
    })
    .catch(err => alert('创建失败: ' + err.message));
  };
  document.getElementById('modalOverlay').classList.add('show');
  setTimeout(() => document.getElementById('modalInput').focus(), 100);
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('show');
  modalCallback = null;
}

function modalConfirm() {
  const val = document.getElementById('modalInput').value.trim();
  if (!val) return;
  if (modalCallback) modalCallback(val);
  closeModal();
}

document.getElementById('modalInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); modalConfirm(); }
  if (e.key === 'Escape') { closeModal(); }
});

// Close modal on overlay click
document.getElementById('modalOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

// --- Chat Rename ---
function enableRename(element, sessionId) {
  if (element.querySelector('input')) return;
  const current = element.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chat-title-edit';
  input.value = current;
  element.textContent = '';
  element.appendChild(input);
  input.focus();
  input.select();
  
  function save() {
    const val = input.value.trim();
    if (val && val !== current) {
      fetch(API + '/api/sessions/' + sessionId + '/title', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({title: val})
      })
      .then(r => { if(!r.ok) throw new Error('Rename failed'); return r.json(); })
      .then(() => { loadChatList(); })
      .catch(err => { alert('重命名失败: ' + err.message); element.textContent = current; });
    } else {
      element.textContent = current;
    }
  }
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { element.textContent = current; }
  });
  input.addEventListener('blur', save);
}

// --- Init (must be last since it calls functions from all modules) ---
(async function init() {
  await loadModes();
  const list = await loadChatList();
  try { const h = await fetch(API + '/api/health'); const hd = await h.json(); document.getElementById('workspaceDir').textContent = hd.workspace || '-'; } catch {}
  if (list.length > 0) await switchChat(list[0].id); else await newChat();
})();
