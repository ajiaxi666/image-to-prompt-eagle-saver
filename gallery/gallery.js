let items = [];
let filtered = [];
let activeTab = 'local';
let sharedPageToken = '';

async function init() {
  bindEvents();
  await switchTab('local');
}

async function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${tab}"]`).classList.add('active');
  document.getElementById('searchInput').value = '';
  sharedPageToken = '';

  if (tab === 'local') {
    await loadLocalItems();
  } else {
    await loadSharedItems();
  }
}

async function loadLocalItems() {
  const { history = [] } = await chrome.storage.local.get('history');
  items = history;
  applyFilter();
}

async function loadSharedItems() {
  document.getElementById('grid').innerHTML = '<div class="empty-hint">加载中…</div>';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'LIST_FEISHU_RECORDS', pageToken: '' });
    if (!res.ok) {
      document.getElementById('grid').innerHTML = `<div class="empty-hint">共享库连接失败：${res.error}</div>`;
      items = [];
      filtered = [];
      renderStats();
      return;
    }
    // Map Feishu record fields to local format
    items = (res.items || []).map(r => ({
      imageUrl: r['图片URL'] || r['imageUrl'] || '',
      pageUrl: r['来源URL'] || r['pageUrl'] || '',
      analysis: {
        description: r['描述'] || r['description'] || '',
        prompt_en: r['Prompt_EN'] || r['prompt_en'] || '',
        prompt_zh: r['Prompt_ZH'] || r['prompt_zh'] || '',
        tags: parseTags(r['Tags']),
        style: r['风格'] || r['style'] || '',
      },
      savedAt: r._createdTime || r['创建时间'],
      _recordId: r.recordId,
      _creator: r._createdBy?.name || '',
    }));
    sharedPageToken = res.pageToken || '';
    applyFilter();
  } catch (err) {
    document.getElementById('grid').innerHTML = `<div class="empty-hint">加载失败：${err.message}</div>`;
  }
}

function parseTags(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return String(val).split(/[,，]/).map(s => s.trim()).filter(Boolean);
}

function applyFilter() {
  const q = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
  if (!q) {
    filtered = items;
  } else {
    filtered = items.filter(item => {
      const a = item.analysis || {};
      const haystack = [
        a.description, a.prompt_en, a.prompt_zh,
        a.style, (a.tags || []).join(' '),
        item.pageUrl || '', item.imageUrl || '',
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }
  renderGrid();
  renderStats();
}

function renderStats() {
  const info = items.length ? `共 ${items.length} 条 · 显示 ${filtered.length} 条` : '';
  const creator = activeTab === 'shared' ? '（数据来自飞书多维表格，团队共享）' : '';
  document.getElementById('stats').textContent = info + creator;
}

function renderGrid() {
  const grid = document.getElementById('grid');
  if (!filtered.length) {
    grid.innerHTML = '<div class="empty-hint">没有匹配的记录</div>';
    return;
  }
  grid.innerHTML = filtered.map((item, idx) => {
    const a = item.analysis || {};
    const tags = (a.tags || []).slice(0, 3);
    const creator = item._creator ? ` · ${escapeHtml(item._creator)}` : '';
    return `
      <div class="card" data-index="${idx}">
        <img class="card-image" src="${escapeHtml(item.imageUrl)}" loading="lazy"
             onerror="this.style.display='none'">
        <div class="card-body">
          <div class="card-title">${escapeHtml(a.description || '未命名素材')}</div>
          <div class="card-meta">
            ${tags.map(t => `<span class="card-tag">${escapeHtml(t)}</span>`).join('')}
            ${a.style ? `<span class="card-style">${escapeHtml(a.style)}</span>` : ''}
            <span class="card-time">${formatTime(item.savedAt)}${creator}</span>
          </div>
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', () => openDetail(parseInt(card.dataset.index)));
  });
}

function openDetail(idx) {
  const item = filtered[idx];
  if (!item) return;
  const a = item.analysis || {};

  document.getElementById('modalImage').src = item.imageUrl;
  document.getElementById('modalImage').onerror = function () {
    this.src = 'icons/icon48.png';
    this.style.opacity = '0.3';
  };
  document.getElementById('modalDescription').textContent = a.description || '-';
  document.getElementById('modalPromptEN').textContent = a.prompt_en || '-';
  document.getElementById('modalPromptZH').textContent = a.prompt_zh || '-';
  document.getElementById('modalTags').innerHTML = (a.tags || []).map(t =>
    `<span class="card-tag">${escapeHtml(t)}</span>`
  ).join('');
  document.getElementById('modalStyle').textContent = a.style || '-';
  const srcEl = document.getElementById('modalSource');
  if (item.pageUrl) {
    srcEl.href = item.pageUrl;
    srcEl.textContent = item.pageUrl;
  } else {
    srcEl.href = '#';
    srcEl.textContent = '-';
    srcEl.removeAttribute('href');
  }

  document.getElementById('modal').dataset.index = idx;
  document.getElementById('modal').style.display = '';

  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const targetId = btn.dataset.target;
      const text = document.getElementById(targetId).textContent;
      copyText(text, btn);
    };
  });
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '已复制';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = '复制';
      btn.classList.remove('copied');
    }, 1500);
  }).catch(() => showToast('复制失败'));
}

async function deleteItem(idx) {
  const item = filtered[idx];
  if (!item) return;
  const globalIdx = items.indexOf(item);
  if (globalIdx < 0) return;
  items.splice(globalIdx, 1);
  await chrome.storage.local.set({ history: items });
  applyFilter();
  closeModal();
}

function closeModal() {
  document.getElementById('modal').style.display = 'none';
}

async function exportAll() {
  const data = items.map(item => ({
    description: item.analysis?.description || '',
    prompt_en: item.analysis?.prompt_en || '',
    prompt_zh: item.analysis?.prompt_zh || '',
    tags: item.analysis?.tags || [],
    style: item.analysis?.style || '',
    imageUrl: item.imageUrl,
    pageUrl: item.pageUrl || '',
    savedAt: item.savedAt ? new Date(item.savedAt).toISOString() : '',
  }));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `eagle-prompts-${activeTab}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('已导出');
}

async function clearAll() {
  if (!confirm('确定清空所有本地图库记录？此操作不可撤销。')) return;
  items = [];
  await chrome.storage.local.set({ history: [] });
  applyFilter();
  closeModal();
  showToast('已清空');
}

function bindEvents() {
  document.getElementById('searchInput').addEventListener('input', applyFilter);
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal')) closeModal();
  });
  document.getElementById('exportBtn').addEventListener('click', exportAll);
  document.getElementById('clearBtn').addEventListener('click', clearAll);

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}时前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2200);
}

document.addEventListener('DOMContentLoaded', init);
