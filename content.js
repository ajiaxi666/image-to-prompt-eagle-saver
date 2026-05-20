const imageCache = new Map();
let currentImage = null;
let contextImageInfo = null;
let panelData = { shortEN: '', shortZH: '', fullEN: '', fullZH: '', style: '', tags: [], description: '' };
let detail = 'full';
let lang = 'zh';
let busy = false;

// ---- Floating hover button ----
const hoverBtn = document.createElement('button');
hoverBtn.id = 'eps-hover-btn';
hoverBtn.title = '分析图片并生成提示词';
hoverBtn.type = 'button';
hoverBtn.innerHTML = '🔍';

// ---- Panel ----
const panel = document.createElement('aside');
panel.id = 'eps-panel';
panel.innerHTML = `
  <div class="eps-shell">
    <div class="eps-header">
      <strong>🦅 Eagle 提示词助手</strong>
      <div>
        <button class="eps-icon-btn" id="eps-open-options" title="设置">⚙</button>
        <button class="eps-close" id="eps-close">&times;</button>
      </div>
    </div>
    <div class="eps-row">
      <div class="eps-preview"><img id="eps-preview-img" alt=""></div>
      <div class="eps-img-info">
        <strong id="eps-img-name">选择图片</strong>
        <span id="eps-img-url"></span>
      </div>
    </div>
    <section class="eps-section">
      <div class="eps-section-head">
        <strong>提示词</strong>
        <div class="eps-chips">
          <button class="eps-chip active" id="eps-detail-full">完整版</button>
          <button class="eps-chip" id="eps-detail-short">精简版</button>
          <button class="eps-chip" id="eps-toggle-lang">中/EN</button>
        </div>
      </div>
      <textarea class="eps-textarea" id="eps-prompt-text" placeholder="点击识别后这里会显示提示词，可直接编辑…"></textarea>
      <div class="eps-meta">
        <span id="eps-status">就绪</span>
        <span id="eps-char-count">0 字</span>
      </div>
      <div class="eps-actions">
        <button class="eps-btn" id="eps-analyze">🔍 识别图片</button>
        <button class="eps-btn eps-btn-copy" id="eps-copy">📋 复制</button>
      </div>
      <div class="eps-save-row" id="eps-save-row" style="display:none">
        <button class="eps-btn eps-btn-save" id="eps-save-local">💾 保存到本地库</button>
        <div class="eps-third-party">
          <button class="eps-btn eps-btn-save" id="eps-third-toggle">📤 第三方 ▾</button>
          <div class="eps-third-dropdown" id="eps-third-dropdown" style="display:none">
            <button class="eps-dropdown-item" data-target="eagle">🦅 Eagle</button>
            <button class="eps-dropdown-item" data-target="feishu">🌐 飞书</button>
          </div>
        </div>
      </div>
    </section>
  </div>
`;

document.documentElement.append(hoverBtn, panel);

// ---- Events ----
document.addEventListener('pointermove', e => {
  if (panel.classList.contains('eps-open')) return;
  const img = getImageElement(e.target);
  if (!img) { hideHover(); return; }
  const src = img.currentSrc || img.src;
  const rect = img.getBoundingClientRect();
  if (!src || rect.width < 80 || rect.height < 80) { hideHover(); return; }
  currentImage = img;
  hoverBtn.style.display = 'flex';
  hoverBtn.style.top = Math.max(4, rect.top + 4) + 'px';
  hoverBtn.style.left = Math.max(4, rect.left + 4) + 'px';
});

document.addEventListener('contextmenu', e => {
  contextImageInfo = getImageInfoFromTarget(e.target);
  if (contextImageInfo?.element) currentImage = contextImageInfo.element;
}, true);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_CONTEXT_IMAGE') {
    const info = contextImageInfo;
    if (!info?.imageUrl) {
      sendResponse({ ok: false });
      return false;
    }
    sendResponse({
      ok: true,
      imageUrl: info.imageUrl,
      pageUrl: location.href,
    });
    return false;
  }
  if (msg.type === 'OPEN_EPS_PANEL') {
    const info = contextImageInfo?.imageUrl === msg.imageUrl
      ? contextImageInfo
      : { imageUrl: msg.imageUrl, element: null, alt: '网页图片' };
    openPanelFromInfo(info, { autoAnalyze: !!msg.autoAnalyze }).then(() => {
      sendResponse({ ok: true });
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }
});

document.addEventListener('scroll', () => { if (currentImage) hideHover(); }, true);
function hideHover() { currentImage = null; hoverBtn.style.display = 'none'; }

hoverBtn.addEventListener('click', async e => {
  e.preventDefault(); e.stopPropagation();
  if (!currentImage) return;
  openPanel(currentImage);
});

document.getElementById('eps-close').addEventListener('click', () => panel.classList.remove('eps-open'));
document.getElementById('eps-open-options').addEventListener('click', () =>
  chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }));

document.getElementById('eps-analyze').addEventListener('click', runAnalysis);
document.getElementById('eps-detail-full').addEventListener('click', () => switchDetail('full'));
document.getElementById('eps-detail-short').addEventListener('click', () => switchDetail('short'));
document.getElementById('eps-toggle-lang').addEventListener('click', toggleLang);
document.getElementById('eps-copy').addEventListener('click', copyPrompt);
document.getElementById('eps-save-local').addEventListener('click', saveToLocal);
document.getElementById('eps-third-toggle').addEventListener('click', toggleThirdDropdown);
document.getElementById('eps-third-dropdown').addEventListener('click', e => {
  const btn = e.target.closest('[data-target]');
  if (!btn) return;
  if (btn.dataset.target === 'eagle') saveToEagle();
  else if (btn.dataset.target === 'feishu') saveToFeishu();
  document.getElementById('eps-third-dropdown').style.display = 'none';
});

document.addEventListener('click', e => {
  if (!e.target.closest('.eps-third-party'))
    document.getElementById('eps-third-dropdown').style.display = 'none';
});

document.getElementById('eps-prompt-text').addEventListener('input', () => {
  const text = document.getElementById('eps-prompt-text').value;
  if (detail === 'full') { if (lang === 'zh') panelData.fullZH = text; else panelData.fullEN = text; }
  else { if (lang === 'zh') panelData.shortZH = text; else panelData.shortEN = text; }
  updateMeta();
});

// ---- Functions ----
function getImageElement(target) {
  const el = getElement(target);
  if (!el?.closest) return null;
  const img = el.closest('img');
  if (img) return img;
  const picture = el.closest('picture');
  return picture?.querySelector('img') || null;
}

function getImageInfoFromElement(img) {
  const src = img?.currentSrc || img?.src || '';
  if (!src) return null;
  return {
    imageUrl: normalizeImageUrl(src),
    element: img,
    alt: img.alt?.trim() || img.getAttribute('aria-label') || '',
  };
}

function getImageInfoFromTarget(target) {
  const img = getImageElement(target);
  const imgInfo = getImageInfoFromElement(img);
  if (imgInfo) return imgInfo;

  const bgUrl = getBackgroundImageUrl(getElement(target));
  if (!bgUrl) return null;
  return {
    imageUrl: normalizeImageUrl(bgUrl),
    element: null,
    alt: getElement(target)?.getAttribute?.('aria-label') || getElement(target)?.textContent?.trim()?.slice(0, 40) || '网页背景图',
  };
}

function getElement(target) {
  if (!target) return null;
  return target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
}

function getBackgroundImageUrl(startEl) {
  let el = startEl;
  while (el && el !== document.documentElement) {
    const bg = getComputedStyle(el).backgroundImage;
    const match = bg && bg.match(/url\((['"]?)(.*?)\1\)/);
    if (match?.[2]) return match[2];
    el = el.parentElement;
  }
  return '';
}

function normalizeImageUrl(url) {
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }
}

async function openPanel(img) {
  const info = getImageInfoFromElement(img);
  if (!info) return;
  return openPanelFromInfo(info);
}

async function openPanelFromInfo(info, options = {}) {
  hideHover();
  panel.classList.add('eps-open');
  currentImage = info.element || null;
  const src = info.imageUrl;
  document.getElementById('eps-preview-img').src = src;
  document.getElementById('eps-img-name').textContent = info.alt || '网页图片';
  document.getElementById('eps-img-url').textContent = src.length > 50 ? src.slice(0, 47) + '…' : src;
  document.getElementById('eps-save-row').style.display = 'none';

  const cached = imageCache.get(src);
  if (cached) { panelData = { ...cached }; syncUI(); return; }
  panelData = { shortEN: '', shortZH: '', fullEN: '', fullZH: '', style: '', tags: [], description: '' };
  detail = 'full'; lang = 'zh';
  syncUI();
  setStatus('就绪');
  if (options.autoAnalyze) {
    runAnalysis();
  }
}

async function runAnalysis() {
  if (busy) return;
  busy = true;
  setStatus('分析中…', 'working');
  document.getElementById('eps-analyze').classList.add('eps-busy');
  try {
    const src = currentImage?.currentSrc || currentImage?.src || document.getElementById('eps-preview-img').src;
    const res = await sendRuntimeMessage({ type: 'ANALYZE_IMAGE', imageUrl: src, pageUrl: location.href }, 70000);
    if (!res?.ok) throw new Error(res?.error || '分析失败');
    panelData = {
      shortEN: res.shortEN || '',
      shortZH: res.shortZH || '',
      fullEN: res.fullEN || '',
      fullZH: res.fullZH || '',
      style: res.style || '',
      tags: res.tags || [],
      description: res.description || '',
    };
    const cacheSrc = currentImage?.currentSrc || currentImage?.src;
    if (cacheSrc) imageCache.set(cacheSrc, { ...panelData });
    document.getElementById('eps-save-row').style.display = '';
    setStatus('识别完成', 'success');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    busy = false;
    document.getElementById('eps-analyze').classList.remove('eps-busy');
    syncUI();
  }
}

function sendRuntimeMessage(message, timeoutMs = 45000) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`后台没有响应（${Math.round(timeoutMs / 1000)} 秒超时）`)), timeoutMs);
  });
  return Promise.race([chrome.runtime.sendMessage(message), timeout])
    .finally(() => clearTimeout(timeoutId));
}

function switchDetail(d) {
  detail = d;
  document.getElementById('eps-detail-full').classList.toggle('active', d === 'full');
  document.getElementById('eps-detail-short').classList.toggle('active', d === 'short');
  syncUI();
}
function toggleLang() {
  lang = lang === 'zh' ? 'en' : 'zh';
  document.getElementById('eps-toggle-lang').textContent = lang === 'zh' ? '中/EN' : 'EN/中';
  syncUI();
}
function syncUI() {
  const text = detail === 'full'
    ? (lang === 'zh' ? panelData.fullZH : panelData.fullEN)
    : (lang === 'zh' ? panelData.shortZH : panelData.shortEN);
  document.getElementById('eps-prompt-text').value = text || '';
  updateMeta();
}
function updateMeta() {
  document.getElementById('eps-char-count').textContent = document.getElementById('eps-prompt-text').value.length + ' 字';
}
function setStatus(msg, tone) {
  const el = document.getElementById('eps-status');
  el.textContent = msg;
  el.setAttribute('data-tone', tone || '');
}

async function copyPrompt() {
  const text = document.getElementById('eps-prompt-text').value.trim();
  if (!text) { setStatus('没有可复制的内容', 'error'); return; }
  await navigator.clipboard.writeText(text);
  setStatus('已复制', 'success');
}
function toggleThirdDropdown() {
  const dd = document.getElementById('eps-third-dropdown');
  dd.style.display = dd.style.display === 'none' ? '' : 'none';
}

async function saveToLocal() {
  setStatus('保存中…', 'working');
  try {
    const src = currentImage?.currentSrc || currentImage?.src || document.getElementById('eps-preview-img').src;
    const res = await chrome.runtime.sendMessage({
      type: 'SAVE_LOCAL',
      imageUrl: src,
      pageUrl: location.href,
      analysis: { ...panelData, prompt_en: panelData.fullEN, prompt_zh: panelData.fullZH },
    });
    if (!res?.ok) throw new Error(res?.error || '保存失败');
    setStatus('已保存到本地库', 'success');
  } catch (err) { setStatus(err.message, 'error'); }
}

async function saveToEagle() {
  setStatus('保存中…', 'working');
  try {
    const src = currentImage?.currentSrc || currentImage?.src || document.getElementById('eps-preview-img').src;
    const res = await chrome.runtime.sendMessage({
      type: 'SAVE_TO_EAGLE',
      imageUrl: src,
      pageUrl: location.href,
      analysis: { ...panelData, prompt_en: panelData.fullEN, prompt_zh: panelData.fullZH },
    });
    if (!res?.ok) throw new Error(res?.error || '保存失败');
    setStatus('已保存到 Eagle', 'success');
  } catch (err) { setStatus(err.message, 'error'); }
}
async function saveToFeishu() {
  setStatus('保存中…', 'working');
  try {
    const src = currentImage?.currentSrc || currentImage?.src || document.getElementById('eps-preview-img').src;
    const res = await chrome.runtime.sendMessage({
      type: 'SAVE_TO_FEISHU',
      imageUrl: src,
      pageUrl: location.href,
      analysis: { ...panelData, prompt_en: panelData.fullEN, prompt_zh: panelData.fullZH },
    });
    if (!res?.ok) throw new Error(res?.error || '保存失败');
    setStatus('已保存到飞书', 'success');
  } catch (err) { setStatus(err.message, 'error'); }
}
