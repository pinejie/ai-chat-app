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
let projectsData = {};
let currentDocFile = '';

async function loadProjects() {
  try {
    const res = await fetch(API + '/api/projects');
    projectsData = await res.json();
    renderProjectList();
  } catch (err) {
    console.error('Failed to load projects:', err);
  }
}

function renderProjectList() {
  const el = document.getElementById('projectList');
  el.innerHTML = '';
  const names = Object.keys(projectsData);
  if (names.length === 0) {
    el.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--text4)">暂无项目文档</div>';
    return;
  }
  for (const name of names) {
    const files = projectsData[name];
    const group = document.createElement('div');
    group.className = 'proj-group';
    const nameEl = document.createElement('div');
    nameEl.className = 'proj-name';
    nameEl.innerHTML = '<span class="arrow">&#9654;</span>' + escapeHtml(name);
    nameEl.onclick = function() {
      this.classList.toggle('open');
      this.nextElementSibling.classList.toggle('open');
    };
    const filesEl = document.createElement('div');
    filesEl.className = 'proj-files';
    for (const f of files) {
      const fileEl = document.createElement('div');
      fileEl.className = 'proj-file';
      fileEl.setAttribute('data-file', f);
      fileEl.setAttribute('data-project', name);
      fileEl.innerHTML = '<span class="file-icon">&#128196;</span>' + escapeHtml(f);
      fileEl.onclick = function(e) {
        e.stopPropagation();
        openDocView(name, f);
        // Highlight active
        el.querySelectorAll('.proj-file').forEach(function(x) { x.classList.remove('active'); });
        this.classList.add('active');
      };
      filesEl.appendChild(fileEl);
    }
    group.appendChild(nameEl);
    group.appendChild(filesEl);
    el.appendChild(group);
  }
}

async function openDocView(projectName, filename) {
  currentDocProject = projectName;
  currentDocFile = filename;
  isEditing = false;
  document.getElementById('docEditArea').style.display = 'none';
  document.getElementById('docContentArea').style.display = '';
  document.getElementById('docTitle').textContent = projectName + ' / ' + filename;
  document.getElementById('docContentInner').innerHTML = '<span style="color:var(--text4)">加载中...</span>';
  // Show doc view, hide chat
  document.getElementById('chatMain').style.display = 'none';
  document.getElementById('docView').classList.add('active');
  try {
    const res = await fetch(API + '/api/projects/' + encodeURIComponent(projectName) + '/content/' + encodeURIComponent(filename));
    const data = await res.json();
    document.getElementById('docContentInner').innerHTML = '<div class="bubble">' + marked.parse(data.content) + '</div>';
  } catch (err) {
    document.getElementById('docContentInner').innerHTML = '<span style="color:var(--danger2)">加载失败: ' + escapeHtml(err.message) + '</span>';
  }
}

function closeDocView() {
  document.getElementById('docView').classList.remove('active');
  document.getElementById('chatMain').style.display = '';
  // Clear active file highlight
  document.querySelectorAll('.proj-file').forEach(function(x) { x.classList.remove('active'); });
  currentDocFile = '';
}


// --- Document Edit/Delete/New ---
let currentDocProject = '';
let isEditing = false;
let modalCallback = null;

function editDoc() {
  if (!currentDocProject || !currentDocFile || isEditing) return;
  isEditing = true;
  // Fetch raw content
  fetch(API + '/api/projects/' + encodeURIComponent(currentDocProject) + '/content/' + encodeURIComponent(currentDocFile))
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
  if (!currentDocProject || !currentDocFile) return;
  const newContent = document.getElementById('docEditText').value;
  fetch(API + '/api/projects/' + encodeURIComponent(currentDocProject) + '/content/' + encodeURIComponent(currentDocFile), {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({content: newContent})
  })
  .then(r => { if(!r.ok) throw new Error('Save failed'); return r.json(); })
  .then(() => {
    isEditing = false;
    // Refresh view
    openDocView(currentDocProject, currentDocFile);
  })
  .catch(err => alert('保存失败: ' + err.message));
}

function deleteDoc() {
  if (!currentDocProject || !currentDocFile) return;
  if (!confirm('确定删除 ' + currentDocFile + '？此操作不可恢复。')) return;
  fetch(API + '/api/projects/' + encodeURIComponent(currentDocProject) + '/content/' + encodeURIComponent(currentDocFile), {
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
  if (!currentDocProject) {
    // If not viewing a doc, prompt for project name too - but for now just alert
    alert('请先选择一个项目');
    return;
  }
  document.getElementById('modalTitle').textContent = '新建文档 - ' + currentDocProject;
  document.getElementById('modalInput').value = '';
  document.getElementById('modalInput').placeholder = '输入文件名（如 05-新文档.md）';
  modalCallback = function(filename) {
    // Create empty doc
    fetch(API + '/api/projects/' + encodeURIComponent(currentDocProject) + '/content', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({filename: filename, content: '# ' + filename.replace('.md','') + '\n'})
    })
    .then(r => { if(!r.ok) throw new Error('Create failed'); return r.json(); })
    .then(() => {
      loadProjects();
      // Open the new doc for editing
      openDocView(currentDocProject, filename.endsWith('.md') ? filename : filename + '.md');
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
