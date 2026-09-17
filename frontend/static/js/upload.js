// --- File Upload ---
let selectedFiles = [];

// handleFileSelect is called from the global #fileInput (shared across sessions)
function handleFileSelect(event) {
  const files = Array.from(event.target.files);
  if (!files.length) return;
  const maxSize = 20 * 1024 * 1024;
  for (const file of files) {
    if (file.size > maxSize) { alert(`文件 ${file.name} 超过 20MB 限制`); return; }
  }
  selectedFiles = selectedFiles.concat(files);
  renderFilePreview();
  event.target.value = '';
}

function renderFilePreview() {
  if (!currentCtx) return;
  const preview = currentCtx.filePreview;
  if (!selectedFiles.length) {
    preview.style.display = 'none';
    preview.innerHTML = '';
    return;
  }
  preview.style.display = 'flex';
  preview.innerHTML = '';
  selectedFiles.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'file-preview-item';
    const isImage = file.type.startsWith('image/');
    if (isImage) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.onload = () => URL.revokeObjectURL(img.src);
      item.appendChild(img);
    } else {
      const icon = document.createElement('div');
      icon.className = 'file-icon';
      icon.textContent = getFileIcon(file.name);
      item.appendChild(icon);
    }
    const name = document.createElement('div');
    name.className = 'file-name'; name.textContent = file.name; name.title = file.name;
    item.appendChild(name);
    const remove = document.createElement('button');
    remove.className = 'file-remove'; remove.innerHTML = '×';
    remove.onclick = () => removeFile(index);
    item.appendChild(remove);
    preview.appendChild(item);
  });
}

function getFileIcon(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const icons = { 'pdf':'📄','doc':'📝','docx':'📝','xls':'📊','xlsx':'📊','csv':'📊','ppt':'📑','pptx':'📑','txt':'📃','md':'📃','json':'📃','js':'💻','ts':'💻','py':'💻','java':'💻','html':'🌐','css':'🎨' };
  return icons[ext] || '📎';
}

function removeFile(index) {
  selectedFiles.splice(index, 1);
  renderFilePreview();
}

async function uploadFiles(files) {
  if (!files.length) return [];
  const formData = new FormData();
  for (const file of files) formData.append('files', file);
  try {
    const res = await fetch(API + '/api/upload', { method: 'POST', body: formData });
    if (!res.ok) throw new Error('Upload failed');
    const data = await res.json();
    return data.files.map(f => f.path);
  } catch (err) {
    console.error('Upload error:', err);
    alert('文件上传失败: ' + err.message);
    return [];
  }
}

async function sendMessage() {
  if (isGenerating) { notifyBlockedSend(); return; }
  if (!currentCtx) return;
  const input = currentCtx.inputEl;
  const text = input.value.trim();
  const _conn = sessionConnected.get(currentSessionId);
  if (!text || !_conn) return;

  let filePaths = [];
  if (selectedFiles.length) {
    filePaths = await uploadFiles(selectedFiles);
    if (!filePaths.length && selectedFiles.length) return;
    selectedFiles = [];
    renderFilePreview();
  }

  messageHistory.push(text); historyIndex = -1; tempInput = '';
  input.value = '';
  input.style.height = 'auto';
  resetTrace();
  addUserMsg(text);

  // Reset streaming state
  streamingText = ''; streamingThinking = ''; currentAssistantEl = null; isGenerating = true;
  if (currentCtx) {
    currentCtx.streamingText = '';
    currentCtx.streamingThinking = '';
    currentCtx.assistantEl = null;
    currentCtx.isGenerating = true;
    currentCtx.finalAssistantHtml = '';
    currentCtx.inputState.history = [...messageHistory];
    currentCtx.inputState.index = historyIndex;
    currentCtx.inputState.tempInput = tempInput;
  }

  showStopBtn(true);
  ensureAssistantBubble();
  currentAssistantEl.querySelector('.bubble').innerHTML = '<span class="typing">思考中<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></span>';

  const wsConn = wsMap.get(currentSessionId);
  if (wsConn && wsConn.readyState === WebSocket.OPEN) {
    wsConn.send(JSON.stringify({ type: 'message', content: text, files: filePaths }));
  }
}
