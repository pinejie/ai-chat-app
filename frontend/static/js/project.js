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
  var toolbar = document.querySelector('.project-toolbar');
  if (toolbar) toolbar.style.display = tab === 'projects' ? 'flex' : 'none';
  var filter = document.getElementById('projectFilter');
  if (filter) filter.style.display = tab === 'projects' ? 'flex' : 'none';
  if (tab !== 'projects') {
    // 切回对话时把快捷入口/根提示一起收掉，否则会压在新列表上
    ['projectLinks', 'projectRootLabel'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  }
  if (tab === 'projects') loadProjects();
}

// --- Project Documents ---
let currentDocPath = '';
let currentFolder = '';
let docsOnly = false;   // 「只看文档」开关，跨会话条目常驻
// 写权限来自后端白名单（project/ 与各项目 docs/）：路径 → 可写。前端只做按钮显隐，
// 真正的拦截在后端，这里不重复推导规则。
let writablePaths = {};
let currentFolderCreatable = false;

/**
 * Load the root-level directory listing and render the tree.
 */
async function loadProjects() {
  try {
    const data = await (await fetch(API + '/api/browse?rel_path=' + sessionQS() + docsOnlyQS())).json();
    writablePaths = {};                       // 整棵树重画，名单一起重建
    currentFolderCreatable = !!data.self_creatable;
    renderProjectTree(data);
    renderDocRootLabel();
    renderQuickLinks(data);
    updateToolbarState();
  } catch (err) {
    console.error('Failed to load projects:', err);
  }
}

/** 工具栏按钮按当前选中目录/文件的可写状态启停，避免点了才被后端拒。 */
function updateToolbarState() {
  var newDoc = document.getElementById('projectNewDocBtn');
  var newFolder = document.getElementById('projectNewFolderBtn');
  var del = document.getElementById('projectDeleteBtn');
  var creatable = currentFolderCreatable;   // 没选目录时按根目录（只读）
  if (newDoc) newDoc.disabled = !creatable;
  if (newFolder) newFolder.disabled = !creatable;
  if (del) del.disabled = !currentFolder || !writablePaths[currentFolder];
}

function isWritablePath(path) {
  return !!writablePaths[path];
}

function docsOnlyQS() {
  return docsOnly ? '&docs_only=true' : '';
}

/** 面板顶部的根目录提示：根已提到工作目录，得让人看出不是 project/ 了。 */
function renderDocRootLabel() {
  const el = document.getElementById('projectRootLabel');
  if (!el) return;
  const dir = _currentWorkspacePath();
  el.textContent = dir ? '根目录：' + dir : '';
  el.title = dir;
  el.style.display = dir ? '' : 'none';
}

function _currentWorkspacePath() {
  const s = (typeof chatListCache !== 'undefined' ? chatListCache : [])
    .filter(function (c) { return c.id === currentSessionId; })[0];
  return (s && s.workspace_path) || '';
}

/** 「常用目录」快捷入口：后端在根列表里给出 shortcuts（各项目的 docs/ 等），一键直达。 */
function renderQuickLinks(data) {
  const el = document.getElementById('projectLinks');
  if (!el) return;
  el.innerHTML = '';
  const links = data.shortcuts || [];
  el.style.display = links.length ? '' : 'none';
  links.forEach(function (item) {
    const b = document.createElement('button');
    b.className = 'pf-link';
    b.textContent = item.label;
    b.title = item.path;
    b.onclick = function () { expandTo(item.path); };
    el.appendChild(b);
  });
}

function _cssEscape(value) {
  return (typeof CSS !== 'undefined' && CSS.escape)
    ? CSS.escape(value)
    : value.replace(/([\\#.:\[\]>+~])/g, '\\$1');
}

/** 逐层展开树到指定目录（快捷入口用）。子目录是懒加载的，所以一层层等回来。 */
async function expandTo(path) {
  const parts = path.split('/').filter(Boolean);
  let base = '';
  for (let i = 0; i < parts.length; i++) {
    base = base ? base + '/' + parts[i] : parts[i];
    const group = document.querySelector('.proj-group[data-dir="' + _cssEscape(base) + '"]');
    if (!group) return;
    const header = group.querySelector(':scope > .proj-name');
    const children = group.querySelector(':scope > .proj-files');
    if (header && !header.classList.contains('open')) {
      header.click();          // 触发选中 + 展开 + 懒加载
      await _waitChildren(children);
    }
  }
  const leaf = document.querySelector('.proj-group[data-dir="' + _cssEscape(path) + '"] > .proj-name');
  if (leaf) {
    currentFolder = path;
    document.querySelectorAll('.proj-name').forEach(function (x) { x.classList.remove('active'); });
    leaf.classList.add('active');
    leaf.scrollIntoView({block: 'nearest'});
  }
}

/** 等懒加载结束：子节点出现、或空目录/加载失败占位出现。最多 3 秒。 */
function _waitChildren(childrenEl) {
  return new Promise(function (resolve) {
    const deadline = Date.now() + 3000;
    (function poll() {
      if (!childrenEl) return resolve();
      if (childrenEl.querySelector('.proj-group, .proj-file') ||
          !childrenEl.querySelector('.proj-loading') ||
          Date.now() > deadline) {
        return resolve();
      }
      setTimeout(poll, 50);
    })();
  });
}

function toggleDocsOnly() {
  docsOnly = !docsOnly;
  document.getElementById('docsOnlyBtn').classList.toggle('active', docsOnly);
  loadProjects();
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
  // 可写名单由后端给出（白名单只有 project/ 和各项目 docs/），前端不重复推导规则
  const writableDirs = data.writable_dirs || [];
  const writableFiles = data.writable_files || [];
  const creatableDirs = data.creatable_dirs || [];

  // Directories first, then files
  for (const dirName of data.dirs) {
    const dirRelPath = basePath ? basePath + '/' + dirName : dirName;
    const ok = writableDirs.indexOf(dirName) >= 0;
    if (ok) writablePaths[dirRelPath] = true;
    const node = createFolderNode(dirName, dirRelPath, projectName, depth, ok);
    const creatable = creatableDirs.indexOf(dirName) >= 0;
    // project/ 和 xxx/docs/ 自身不可删，但里面能新建，不该打「只读」标
    node.setAttribute('data-creatable', creatable ? '1' : '0');
    if (!ok && !creatable) {
      const tag = node.querySelector('.ro-tag');
      if (tag) tag.style.display = '';
    }
    parentEl.appendChild(node);
  }
  for (const fileName of data.files) {
    const fileRelPath = basePath ? basePath + '/' + fileName : fileName;
    const ok = writableFiles.indexOf(fileName) >= 0;
    if (ok) writablePaths[fileRelPath] = true;
    const node = createFileNode(fileName, fileRelPath, projectName, depth, ok);
    parentEl.appendChild(node);
  }
}

/**
 * Create a folder tree node. Click to expand/collapse (lazy-load on first expand).
 */
function createFolderNode(dirName, dirRelPath, projectName, depth, writable) {
  const group = document.createElement('div');
  group.className = 'proj-group';
  group.setAttribute('data-dir', dirRelPath);
  group.setAttribute('data-depth', depth);
  group.setAttribute('data-writable', writable ? '1' : '0');

  const header = document.createElement('div');
  header.className = 'proj-name';
  header.style.paddingLeft = (12 + depth * 16) + 'px';
  header.innerHTML = '<span class="arrow">&#9654;</span><span class="folder-icon">&#128193;</span>'
    + escapeHtml(dirName) + '<span class="ro-tag" title="只读：不能删除或新建" style="display:none">只读</span>';

  const childrenEl = document.createElement('div');
  childrenEl.className = 'proj-files';
  let loaded = false;

  header.onclick = function() {
    // 选中文件夹
    currentFolder = dirRelPath;
    currentFolderCreatable = (group.getAttribute('data-creatable') === '1');
    document.querySelectorAll('.proj-name').forEach(function(x) { x.classList.remove('active'); });
    this.classList.add('active');
    updateToolbarState();
    // 展开/折叠
    const isOpen = this.classList.toggle('open');
    childrenEl.classList.toggle('open', isOpen);
    if (isOpen && !loaded) {
      // Lazy load children
      loaded = true;
      childrenEl.innerHTML = '<div class="proj-loading" style="padding:6px 12px 6px ' + (28 + depth * 16) + 'px;font-size:11px;color:var(--text4)">加载中...</div>';
      fetch(API + '/api/browse?rel_path=' + encodeURIComponent(dirRelPath) + sessionQS() + docsOnlyQS())
        .then(r => r.json())
        .then(data => {
          currentFolderCreatable = !!data.self_creatable;
          updateToolbarState();
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
function createFileNode(fileName, fileRelPath, projectName, depth, writable) {
  const fileEl = document.createElement('div');
  fileEl.className = 'proj-file';
  fileEl.style.paddingLeft = (28 + depth * 16) + 'px';
  fileEl.setAttribute('data-file', fileRelPath);
  fileEl.setAttribute('data-project', projectName);
  fileEl.setAttribute('data-writable', writable ? '1' : '0');
  fileEl.innerHTML = '<span class="file-icon">&#128196;</span>' + escapeHtml(fileName)
    + (writable ? '' : '<span class="ro-tag" title="只读：不能编辑或删除">只读</span>');
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

/**
 * 局部刷新某个目录的子树：保持该文件夹的展开/折叠状态，只替换其子节点。
 * dirRelPath 为空字符串时表示根目录，此时整棵树刷新（无法保留展开状态）。
 */
function refreshDir(dirRelPath) {
  if (!dirRelPath && dirRelPath !== '') {
    return loadProjects();
  }
  // 根目录：整棵树刷新
  if (dirRelPath === '') {
    return loadProjects();
  }
  const escaped = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(dirRelPath) : dirRelPath.replace(/([\\#.:\[\]>+~])/g, '\\$1');
  const group = document.querySelector('.proj-group[data-dir="' + escaped + '"]');
  if (!group) {
    return loadProjects();  // 兜底：找不到对应节点就全树刷新
  }
  const childrenEl = group.querySelector(':scope > .proj-files');
  const depth = parseInt(group.getAttribute('data-depth'), 10) || 0;
  const indent = (28 + depth * 16) + 'px';
  childrenEl.innerHTML = '<div class="proj-loading" style="padding:6px 12px 6px ' + indent + ';font-size:11px;color:var(--text4)">加载中...</div>';
  fetch(API + '/api/browse?rel_path=' + encodeURIComponent(dirRelPath) + sessionQS() + docsOnlyQS())
    .then(r => r.json())
    .then(data => {
      childrenEl.innerHTML = '';
      if (data.dirs.length === 0 && data.files.length === 0) {
        childrenEl.innerHTML = '<div style="padding:6px 12px 6px ' + indent + ';font-size:11px;color:var(--text4)">空文件夹</div>';
      } else {
        renderBrowseItems(data, childrenEl, depth + 1, dirRelPath);
      }
    })
    .catch(err => {
      console.error('refreshDir failed:', err);
      childrenEl.innerHTML = '<div style="padding:6px 12px;font-size:11px;color:var(--danger2)">加载失败</div>';
    });
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
    inner.innerHTML = '<div class="doc-img-wrap"><img class="doc-img" src="' + API + '/api/projects/image?path=' + encodeURIComponent(currentDocPath) + sessionQS() + '"></div>';
  } else if (isOfficeFile(data.filename)) {
    setFullscreenBtn(true);
    await renderOfficePreview(data);
  } else if (isBinaryFile(data.filename)) {
    const dlUrl = API + '/api/projects/download?path=' + encodeURIComponent(currentDocPath) + sessionQS();
    inner.innerHTML = '<div class="doc-binary-card">'
      + '<div class="doc-binary-icon">&#128230;</div>'
      + '<div class="doc-binary-name">' + escapeHtml(data.filename) + '</div>'
      + '<div class="doc-binary-tip">该文件类型暂不支持在线预览</div>'
      + '<a class="doc-btn" href="' + dlUrl + '" download>&#11015; 下载文件</a>'
      + '</div>';
  } else if (isPdfFile(data.filename)) {
    document.getElementById('docContentArea').classList.add('previewing');
    inner.innerHTML = '<iframe class="doc-iframe" src="' + API + '/api/projects/image?path=' + encodeURIComponent(currentDocPath) + sessionQS() + '"></iframe>';
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
    inner.innerHTML = '<div class="bubble">' + safeMd(data.content) + '</div>';
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
  // editDoc() 会把内容区隐藏，这里必须恢复，否则保存/切换文档后页面空白
  document.getElementById('docContentArea').style.display = '';
  document.getElementById('docEditArea').style.display = 'none';
  document.getElementById('docTitle').textContent = docPath;
  // 图片/二进制文件不能文本编辑；白名单外的文件只读，编辑/删除按钮一起藏掉
  const readOnlyPath = !isWritablePath(docPath);
  document.getElementById('docEditBtn').style.display =
    (isImageFile(filename) || isBinaryFile(filename) || isOfficeFile(filename) || readOnlyPath) ? 'none' : '';
  const delBtn = document.getElementById('docDeleteBtn');
  if (delBtn) delBtn.style.display = readOnlyPath ? 'none' : '';
  setPreviewBtn(false);
  setFullscreenBtn(false);
  if (slideState.active) closeSlideViewer();
  document.getElementById('docContentInner').innerHTML = '<span style="color:var(--text4)">加载中...</span>';
  // Show doc view, hide chat
  document.getElementById('chatMain').style.display = 'none';
  document.getElementById('docView').classList.add('active');
  try {
    const res = await fetch(API + '/api/projects/content?path=' + encodeURIComponent(docPath) + sessionQS());
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
  const dlUrl = API + '/api/projects/download?path=' + encodeURIComponent(currentDocPath) + sessionQS();

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

  const previewUrl = API + '/api/projects/preview?path=' + encodeURIComponent(currentDocPath) + sessionQS();
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
    const res = await fetch(API + '/api/projects/slides?path=' + encodeURIComponent(docPath) + sessionQS());
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || '准备幻灯片失败 (' + res.status + ')');
    }
    const data = await res.json();
    slideState.total = data.total;
    counterEl.textContent = '1 / ' + data.total;
    // Load first slide image
    const firstUrl = API + '/api/projects/slide_page?path=' + encodeURIComponent(docPath) + '&page=1' + sessionQS();
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
  var url = API + '/api/projects/slide_page?path=' + encodeURIComponent(slideState.docPath) + '&page=' + page + sessionQS();
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
  if (!isWritablePath(currentDocPath)) {
    showConfirm('只读文件', '该文件不在可写区域，仅 project/ 与各项目 docs/ 下的内容可以编辑。', function(){});
    document.getElementById('confirmBtn').style.display = 'none';
    return;
  }
  isEditing = true;
  // Fetch raw content
  fetch(API + '/api/projects/content?path=' + encodeURIComponent(currentDocPath) + sessionQS())
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
  fetch(API + '/api/projects/content?path=' + encodeURIComponent(currentDocPath) + sessionQS(), {
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
  const dlUrl = API + '/api/projects/download?path=' + encodeURIComponent(currentDocPath) + sessionQS();
  const a = document.createElement('a');
  a.href = dlUrl;
  a.download = currentDocPath.split('/').pop();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}


function deleteDoc() {
  if (!currentDocPath) return;
  if (!isWritablePath(currentDocPath)) {
    showConfirm('只读文件', '该文件不在可写区域，仅 project/ 与各项目 docs/ 下的内容可以删除。', function(){});
    document.getElementById('confirmBtn').style.display = 'none';
    return;
  }
  const filename = currentDocPath.split('/').pop();
  const lastSlash = currentDocPath.lastIndexOf('/');
  const parentDir = (lastSlash >= 0) ? currentDocPath.substring(0, lastSlash) : '';
  if (!confirm('确定删除 ' + filename + '？此操作不可恢复。')) return;
  fetch(API + '/api/projects/content?path=' + encodeURIComponent(currentDocPath) + sessionQS(), {
    method: 'DELETE'
  })
  .then(r => { if(!r.ok) throw new Error('Delete failed'); return r.json(); })
  .then(() => {
    closeDocView();
    refreshDir(parentDir);
  })
  .catch(err => alert('删除失败: ' + err.message));
}

function showNewFolderModal(dirPath) {
  if (dirPath === undefined) {
    if (!currentDocPath) { showConfirm('提示', '请先选择一个文件', function(){}); document.getElementById('confirmBtn').style.display = 'none'; return; }
    var lastSlash2 = currentDocPath.lastIndexOf('/');
    dirPath = (lastSlash2 >= 0) ? currentDocPath.substring(0, lastSlash2) : '';
  }
  if (!_canCreateInPath(dirPath)) {
    showConfirm('只读位置', '只能在工作目录的 project/ 或各项目 docs/ 下新建内容。', function(){});
    document.getElementById('confirmBtn').style.display = 'none';
    return;
  }
  var dirLabel = dirPath || '根目录';

  document.getElementById('modalTitle').textContent = '新建文件夹 - ' + dirLabel;
  document.getElementById('modalInput').value = '';
  document.getElementById('modalInput').placeholder = '输入文件夹名（如 03-设计方案）';
  modalCallback = function(folderName) {
    fetch(API + '/api/projects/folder?dir=' + encodeURIComponent(dirPath) + sessionQS(), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name: folderName})
    })
    .then(function(r) { if(!r.ok) return r.json().then(function(d){ throw new Error(d.detail || 'Create failed'); }); return r.json(); })
    .then(function() { refreshDir(dirPath); })
    .catch(function(err) { alert('创建失败: ' + err.message); });
  };
  document.getElementById('modalOverlay').classList.add('show');
  setTimeout(function() { document.getElementById('modalInput').focus(); }, 100);
}

/** 该目录里能不能新建。根目录、以及白名单外的目录都不行。 */
function _canCreateInPath(dirPath) {
  if (!dirPath) return false;                     // 工作目录根本身只读
  const parts = dirPath.split('/');
  if (parts[0] === 'project') return true;         // project/ 及其子目录
  return parts.length >= 2 && parts[1] === 'docs'; // 项目名/docs/ 及其子目录
}

function showNewDocModal(dirPath) {
  if (dirPath === undefined) {
    if (!currentDocPath) { showConfirm('提示', '请先选择一个文件', function(){}); document.getElementById('confirmBtn').style.display = 'none'; return; }
    var lastSlash2 = currentDocPath.lastIndexOf('/');
    dirPath = (lastSlash2 >= 0) ? currentDocPath.substring(0, lastSlash2) : '';
  }
  if (!_canCreateInPath(dirPath)) {
    showConfirm('只读位置', '只能在工作目录的 project/ 或各项目 docs/ 下新建内容。', function(){});
    document.getElementById('confirmBtn').style.display = 'none';
    return;
  }
  const dirLabel = dirPath || '根目录';

  document.getElementById('modalTitle').textContent = '新建文档 - ' + dirLabel;
  document.getElementById('modalInput').value = '';
  document.getElementById('modalInput').placeholder = '输入文件名（如 05-新文档.md）';
  modalCallback = function(filename) {
    const newFilename = filename.endsWith('.md') ? filename : filename + '.md';
    // Create file via /api/projects/content?dir=...
    fetch(API + '/api/projects/content?dir=' + encodeURIComponent(dirPath) + sessionQS(), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({filename: filename, content: '# ' + filename.replace('.md','') + '\n'})
    })
    .then(r => { if(!r.ok) throw new Error('Create failed'); return r.json(); })
    .then(() => {
      refreshDir(dirPath);
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
  await ensureLogin();
  await loadModes();
  const list = await loadChatList();
  await loadWorkspaces();   // 目录注册表先于任何目录展示加载（app.js）
  if (list.length > 0) await switchChat(list[0].id); else await newChat();
})();

// === 项目文档工具栏按钮 ===

function projectNewDoc() {
  // 在选中的文件夹下新建，没选文件夹则在根目录新建
  showNewDocModal(currentFolder || '');
}

function projectNewFolder() {
  // 在选中的文件夹下新建，没选文件夹则在根目录新建
  showNewFolderModal(currentFolder || '');
}

function projectDelete() {
  if (!currentFolder) {
    showConfirm('提示', '请先选择要删除的文件夹', function(){});
    document.getElementById('confirmBtn').style.display = 'none';
    return;
  }
  // 白名单外的目录（代码库、根上文件所在目录）后端会拒，这里先说清楚，省得白点一趟
  if (!isWritablePath(currentFolder)) {
    showConfirm('只读位置', '「' + currentFolder + '」不在可写区域，仅 project/ 与各项目 docs/ 下的内容可以删除。', function(){});
    document.getElementById('confirmBtn').style.display = 'none';
    return;
  }
  document.getElementById('confirmBtn').style.display = '';
  var folderName = currentFolder.split('/').pop();
  // 先查询文件夹内容
  fetch(API + '/api/browse?rel_path=' + encodeURIComponent(currentFolder) + sessionQS())
  .then(function(r) { return r.json(); })
  .then(function(data) {
    var fileCount = data.files ? data.files.length : 0;
    var dirCount = data.dirs ? data.dirs.length : 0;
    var total = fileCount + dirCount;
    var msg = '';
    if (total === 0) {
      msg = '确定删除文件夹 "' + folderName + '"？';
    } else {
      var parts = [];
      if (dirCount > 0) parts.push(dirCount + ' 个子文件夹');
      if (fileCount > 0) parts.push(fileCount + ' 个文件');
      msg = '文件夹 "' + folderName + '" 下有' + parts.join('和') + '，确定要全部删除吗？';
    }
    showConfirm('确认删除', msg, function() {
      fetch(API + '/api/projects/content?path=' + encodeURIComponent(currentFolder) + sessionQS(), { method: 'DELETE' })
      .then(function(r) { if(!r.ok) return r.json().then(function(d){ throw new Error(d.detail || 'failed'); }); return r.json(); })
      .then(function() {
        var folderPath = currentFolder;
        currentFolder = '';
        var p = folderPath.lastIndexOf('/');
        refreshDir(p >= 0 ? folderPath.substring(0, p) : '');
      })
      .catch(function(err) { alert('删除失败: ' + err.message); });
    });
  })
  .catch(function(err) { alert('查询文件夹内容失败: ' + err.message); });
}

// === 自定义确认弹窗 ===
var _confirmCallback = null;

function showConfirm(title, message, onConfirm) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMessage').textContent = message;
  _confirmCallback = onConfirm;
  document.getElementById('confirmOverlay').classList.add('show');
}

function closeConfirm() {
  document.getElementById('confirmOverlay').classList.remove('show');
  document.getElementById('confirmBtn').style.display = '';
  _confirmCallback = null;
}

function confirmAction() {
  if (_confirmCallback) _confirmCallback();
  closeConfirm();
}

// 确认弹窗：点遮罩或按 Escape 关闭，行为对齐新建文档弹层（modalOverlay 已有同款）
document.getElementById('confirmOverlay').addEventListener('click', function(e) {
  if (e.target.id === 'confirmOverlay') closeConfirm();
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && document.getElementById('confirmOverlay').classList.contains('show')) closeConfirm();
});
