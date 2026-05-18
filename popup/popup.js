async function init() {
  document.getElementById('settingsBtn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  document.getElementById('galleryBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('gallery/gallery.html') });
  });

  checkStatuses();
  loadFolders();
  loadHistory();

  const savedFolder = (await chrome.storage.sync.get('eagleFolderId')).eagleFolderId || '';
  document.getElementById('folderSelect').value = savedFolder;

  document.getElementById('folderSelect').addEventListener('change', (e) => {
    chrome.storage.sync.set({ eagleFolderId: e.target.value });
  });
}

async function checkStatuses() {
  setDot('eagleDot', 'checking');

  const eagleOk = await chrome.runtime.sendMessage({ type: 'CHECK_EAGLE' });
  setDot('eagleDot', eagleOk ? 'online' : 'offline');
  document.getElementById('eagleLabel').textContent = eagleOk ? 'Eagle 已连接' : 'Eagle 未运行';
}

async function loadFolders() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_EAGLE_FOLDERS' });
  if (!res?.ok || !res.folders?.length) return;

  const select = document.getElementById('folderSelect');
  const savedId = (await chrome.storage.sync.get('eagleFolderId')).eagleFolderId || '';

  res.folders.forEach(folder => {
    const opt = document.createElement('option');
    opt.value = folder.id;
    opt.textContent = folder.name;
    if (folder.id === savedId) opt.selected = true;
    select.appendChild(opt);

    (folder.children || []).forEach(child => {
      const childOpt = document.createElement('option');
      childOpt.value = child.id;
      childOpt.textContent = `  └ ${child.name}`;
      if (child.id === savedId) childOpt.selected = true;
      select.appendChild(childOpt);
    });
  });
}

async function loadHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  const list = document.getElementById('historyList');

  if (!history.length) return;

  list.innerHTML = '';
  history.slice(0, 5).forEach(item => {
    const el = document.createElement('div');
    el.className = 'history-item';

    const img = document.createElement('img');
    img.className = 'history-thumb';
    img.src = item.imageUrl;
    img.onerror = () => { img.style.display = 'none'; };

    const info = document.createElement('div');
    info.className = 'history-info';

    const desc = document.createElement('div');
    desc.className = 'history-desc';
    desc.textContent = item.analysis?.description || item.imageUrl.split('/').pop() || '未命名';

    const meta = document.createElement('div');
    meta.className = 'history-meta';

    const badge = document.createElement('span');
    badge.className = `history-target ${item.target}`;
    badge.textContent = 'Eagle';

    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = formatTime(item.savedAt);

    meta.appendChild(badge);
    meta.appendChild(time);
    info.appendChild(desc);
    info.appendChild(meta);
    el.appendChild(img);
    el.appendChild(info);
    list.appendChild(el);
  });
}

function setDot(id, state) {
  const dot = document.getElementById(id);
  dot.className = `dot ${state}`;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

document.addEventListener('DOMContentLoaded', init);
