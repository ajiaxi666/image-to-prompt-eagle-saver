import { BUILTIN_PROVIDERS, PROVIDER_TYPES, guessVisionSupport } from '../providers.js';
import { BUILTIN_TEMPLATES } from '../prompt-templates.js';

const state = {
  providers: [],
  providerKeys: {},
  activeProviderId: null,
  templates: [],
  activeTemplateId: null,
  editingTemplate: null,
};

async function init() {
  await loadAll();
  bindEvents();
  chrome.runtime.sendMessage({ type: 'REGISTER_CONTEXT_MENUS' }).catch(() => {});
  await loadEagleFolders();
}

async function loadAll() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get([
      'activeProviderId', 'customProviders', 'providerModelOverrides',
      'activeTemplateId', 'customTemplates',
      'eagleFolderId', 'defaultTagPrefix',
      'captionMode', 'captionProviderId', 'captionExternalUrl',
      'feishuEnabled', 'feishuAppId', 'feishuAppToken', 'feishuTableId',
    ]),
    chrome.storage.local.get(['providerKeys', 'feishuAppSecret', 'eagleApiToken', 'captionExternalKey']),
  ]);

  state.providers = [...BUILTIN_PROVIDERS, ...(sync.customProviders || [])];
  const overrides = sync.providerModelOverrides || {};
  state.providers = state.providers.map(p =>
    p.builtin && overrides[p.id] ? { ...p, model: overrides[p.id] } : p
  );
  state.providerKeys = local.providerKeys || {};
  state.activeProviderId = sync.activeProviderId || BUILTIN_PROVIDERS[0].id;

  state.templates = [...BUILTIN_TEMPLATES, ...(sync.customTemplates || [])];
  state.activeTemplateId = sync.activeTemplateId || BUILTIN_TEMPLATES[0].id;
  state.editingTemplate = state.templates.find(t => t.id === state.activeTemplateId);

  renderProviderSelect();
  renderProviderForm();
  renderTemplateSelect();
  renderTemplateForm();

  if (local.eagleApiToken) document.getElementById('eagleApiToken').value = local.eagleApiToken;
  if (sync.defaultTagPrefix) document.getElementById('defaultTagPrefix').value = sync.defaultTagPrefix;
  if (sync.captionMode) document.getElementById('captionMode').value = sync.captionMode;
  if (sync.captionProviderId) {
    // will be applied in renderCaptionProviderSelect
    state._captionProviderId = sync.captionProviderId;
  }
  if (sync.captionExternalUrl) document.getElementById('captionExternalUrl').value = sync.captionExternalUrl;
  if (local.captionExternalKey) document.getElementById('captionExternalKey').value = local.captionExternalKey;

  renderCaptionProviderSelect();
  applyCaptionModeVisibility();

  // Feishu
  if (sync.feishuEnabled) document.getElementById('feishuEnabled').value = sync.feishuEnabled;
  if (sync.feishuAppId) document.getElementById('feishuAppId').value = sync.feishuAppId;
  if (local.feishuAppSecret) document.getElementById('feishuAppSecret').value = local.feishuAppSecret;
  if (sync.feishuAppToken) document.getElementById('feishuAppToken').value = sync.feishuAppToken;
  if (sync.feishuTableId) {
    state._feishuTableId = sync.feishuTableId;
    const sel = document.getElementById('feishuTableId');
    sel.innerHTML = `<option value="${sync.feishuTableId}">${sync.feishuTableId}</option>`;
    sel.value = sync.feishuTableId;
  }
  applyFeishuVisibility();
}

function renderProviderSelect() {
  const sel = document.getElementById('activeProvider');
  sel.innerHTML = '';
  state.providers.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.builtin ? p.name : `${p.name} (自定义)`;
    if (p.id === state.activeProviderId) opt.selected = true;
    sel.appendChild(opt);
  });
}

function renderProviderForm() {
  const provider = state.providers.find(p => p.id === state.activeProviderId);
  if (!provider) return;
  document.getElementById('providerBaseUrl').value = provider.baseUrl;
  document.getElementById('providerModel').value = provider.model;
  document.getElementById('providerApiKey').value = state.providerKeys[provider.id] || '';
  document.getElementById('providerBaseUrl').readOnly = !!provider.builtin;
  document.getElementById('deleteProviderBtn').hidden = !!provider.builtin;
  document.getElementById('fetchModelsBtn').style.display =
    provider.type === PROVIDER_TYPES.CLAUDE ? 'none' : '';
  hideModelList();
  clearStatus('providerStatus');
}

function renderTemplateSelect() {
  const sel = document.getElementById('activeTemplate');
  sel.innerHTML = '';
  state.templates.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.builtin ? t.name : `${t.name} (自定义)`;
    if (t.id === state.activeTemplateId) opt.selected = true;
    sel.appendChild(opt);
  });
}

function renderTemplateForm() {
  const t = state.editingTemplate;
  if (!t) return;
  document.getElementById('templateName').value = t.name;
  document.getElementById('templateDescription').value = t.description || '';
  document.getElementById('templateContent').value = t.content;
  const readOnly = !!t.builtin;
  document.getElementById('templateName').readOnly = readOnly;
  document.getElementById('templateDescription').readOnly = readOnly;
  document.getElementById('templateContent').readOnly = readOnly;
  document.getElementById('deleteTemplateBtn').hidden = readOnly;
  document.getElementById('saveTemplateBtn').textContent = readOnly ? '复制为自定义模板' : '保存模板';
}

function bindEvents() {
  document.getElementById('activeProvider').addEventListener('change', onProviderSwitch);
  document.getElementById('addProviderBtn').addEventListener('click', addCustomProvider);
  document.getElementById('deleteProviderBtn').addEventListener('click', deleteProvider);
  document.getElementById('testProvider').addEventListener('click', testProvider);
  document.getElementById('fetchModelsBtn').addEventListener('click', fetchModels);
  document.getElementById('modelList').addEventListener('change', onModelSelected);

  document.getElementById('activeTemplate').addEventListener('change', onTemplateSwitch);
  document.getElementById('newTemplateBtn').addEventListener('click', newTemplate);
  document.getElementById('saveTemplateBtn').addEventListener('click', saveTemplate);
  document.getElementById('deleteTemplateBtn').addEventListener('click', deleteTemplate);

  document.getElementById('feishuEnabled').addEventListener('change', applyFeishuVisibility);
  document.getElementById('testFeishu').addEventListener('click', testFeishuConnection);
  document.getElementById('captionMode').addEventListener('change', applyCaptionModeVisibility);
  document.getElementById('saveBtn').addEventListener('click', saveAll);
  document.getElementById('resetBtn').addEventListener('click', resetAll);
}

function onProviderSwitch() {
  state.activeProviderId = document.getElementById('activeProvider').value;
  renderProviderForm();
}

function addCustomProvider() {
  const name = prompt('自定义提供商名称（如：我的本地 vLLM）');
  if (!name) return;
  const id = `custom-${Date.now()}`;
  const provider = {
    id, name,
    type: PROVIDER_TYPES.OPENAI_COMPATIBLE,
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-4o',
    builtin: false,
  };
  state.providers = [...state.providers, provider];
  state.activeProviderId = id;
  renderProviderSelect();
  renderProviderForm();
}

async function deleteProvider() {
  const p = state.providers.find(p => p.id === state.activeProviderId);
  if (!p || p.builtin) return;
  if (!confirm(`删除自定义提供商 "${p.name}"？`)) return;
  state.providers = state.providers.filter(x => x.id !== p.id);
  delete state.providerKeys[p.id];
  state.activeProviderId = BUILTIN_PROVIDERS[0].id;
  await saveProviders();
  renderProviderSelect();
  renderProviderForm();
  showToast('已删除');
}

async function testProvider() {
  const provider = collectProviderFromForm();
  if (!provider.apiKey) { setStatus('providerStatus', 'err', '请先填写 API Key'); return; }
  setStatus('providerStatus', 'checking', '测试中…');
  try {
    const res = await sendRuntimeMessage({ type: 'TEST_PROVIDER', provider }, 25000);
    if (res.ok) setStatus('providerStatus', 'ok', '连接成功');
    else setStatus('providerStatus', 'err', '失败：' + (res.error || '未知错误'));
  } catch (err) {
    setStatus('providerStatus', 'err', '失败：' + err.message);
  }
}

async function fetchModels() {
  const provider = collectProviderFromForm();
  if (!provider.apiKey) { setStatus('modelListStatus', 'err', '请先填写 API Key'); return; }
  hideModelList();
  setStatus('modelListStatus', 'checking', '拉取中…');
  try {
    const res = await sendRuntimeMessage({ type: 'FETCH_MODELS', provider }, 25000);
    if (!res.ok) { setStatus('modelListStatus', 'err', res.error); return; }
    const models = res.models || [];
    if (!models.length) { setStatus('modelListStatus', 'err', '未找到可用模型'); return; }
    renderModelList(models);
  } catch (err) {
    setStatus('modelListStatus', 'err', err.message);
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

// Known vision-capable model name patterns (case-insensitive partial match)
const VISION_PATTERNS = /vision|vl|gemini|claude|gpt-5|gpt-4|gpt-4o|sonnet|opus|haiku|llava|qwen|cogvlm|glm-4v|pixtral|llama.*vision/i;

function renderModelList(models) {
  const sel = document.getElementById('modelList');
  sel.innerHTML = '';
  models.forEach(id => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    if (VISION_PATTERNS.test(id)) opt.className = 'vision-model';
    sel.appendChild(opt);
  });
  sel.style.display = '';
  document.getElementById('modelListStatus').style.display = 'none';
}

function hideModelList() {
  document.getElementById('modelList').style.display = 'none';
  const st = document.getElementById('modelListStatus');
  st.style.display = 'none';
  st.innerHTML = '';
}

function onModelSelected() {
  const sel = document.getElementById('modelList');
  if (sel.value) {
    document.getElementById('providerModel').value = sel.value;
    hideModelList();
  }
}

function collectProviderFromForm() {
  const current = state.providers.find(p => p.id === state.activeProviderId);
  return {
    ...current,
    baseUrl: document.getElementById('providerBaseUrl').value.trim(),
    model: document.getElementById('providerModel').value.trim(),
    apiKey: document.getElementById('providerApiKey').value.trim(),
  };
}

async function saveProviders() {
  const custom = state.providers.filter(p => !p.builtin);
  await chrome.storage.sync.set({
    customProviders: custom,
    activeProviderId: state.activeProviderId,
  });
  await chrome.storage.local.set({ providerKeys: state.providerKeys });
}

function onTemplateSwitch() {
  state.activeTemplateId = document.getElementById('activeTemplate').value;
  state.editingTemplate = state.templates.find(t => t.id === state.activeTemplateId);
  renderTemplateForm();
}

function newTemplate() {
  const id = `tpl-${Date.now()}`;
  const tpl = {
    id, name: '新模板', description: '', content: '在这里写你的提示词…',
    builtin: false,
  };
  state.templates = [...state.templates, tpl];
  state.activeTemplateId = id;
  state.editingTemplate = tpl;
  renderTemplateSelect();
  renderTemplateForm();
}

async function saveTemplate() {
  const current = state.editingTemplate;
  if (!current) return;

  if (current.builtin) {
    const id = `tpl-${Date.now()}`;
    const copy = {
      id,
      name: document.getElementById('templateName').value + ' (副本)',
      description: document.getElementById('templateDescription').value,
      content: document.getElementById('templateContent').value,
      builtin: false,
    };
    state.templates = [...state.templates, copy];
    state.activeTemplateId = id;
    state.editingTemplate = copy;
  } else {
    const updated = {
      ...current,
      name: document.getElementById('templateName').value.trim() || '未命名',
      description: document.getElementById('templateDescription').value,
      content: document.getElementById('templateContent').value,
    };
    state.templates = state.templates.map(t => t.id === updated.id ? updated : t);
    state.editingTemplate = updated;
  }

  await saveTemplates();
  renderTemplateSelect();
  renderTemplateForm();
  showToast('模板已保存');
}

async function deleteTemplate() {
  const t = state.editingTemplate;
  if (!t || t.builtin) return;
  if (!confirm(`删除模板 "${t.name}"？`)) return;
  state.templates = state.templates.filter(x => x.id !== t.id);
  state.activeTemplateId = BUILTIN_TEMPLATES[0].id;
  state.editingTemplate = BUILTIN_TEMPLATES[0];
  await saveTemplates();
  renderTemplateSelect();
  renderTemplateForm();
  showToast('已删除');
}

async function saveTemplates() {
  const custom = state.templates.filter(t => !t.builtin);
  await chrome.storage.sync.set({
    customTemplates: custom,
    activeTemplateId: state.activeTemplateId,
  });
}

async function loadEagleFolders() {
  const folderSelect = document.getElementById('eagleFolderId');
  try {
    const { eagleApiToken } = await chrome.storage.local.get('eagleApiToken');
    let url = 'http://localhost:41595/api/folder/list';
    if (eagleApiToken) url += `?token=${encodeURIComponent(eagleApiToken)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    if (data.status !== 'success') throw new Error('Eagle 返回错误');
    const savedId = (await chrome.storage.sync.get('eagleFolderId')).eagleFolderId || '';
    const folders = data.data || [];
    folders.forEach(f => {
      appendFolderOption(folderSelect, f, '', savedId);
      (f.children || []).forEach(c => appendFolderOption(folderSelect, c, '  └ ', savedId));
    });
    setStatus('eagleStatus', 'ok', `Eagle 已连接，${folders.length} 个文件夹`);
  } catch {
    setStatus('eagleStatus', 'err', 'Eagle 未运行');
  }
}

function appendFolderOption(select, folder, prefix, savedId) {
  const opt = document.createElement('option');
  opt.value = folder.id;
  opt.textContent = prefix + folder.name;
  if (folder.id === savedId) opt.selected = true;
  select.appendChild(opt);
}

function renderCaptionProviderSelect() {
  const sel = document.getElementById('captionProviderId');
  sel.innerHTML = '';
  state.providers.forEach(p => {
    // Prefer vision-capable providers for captioning
    const supportsV = p.supportsVision === true || guessVisionSupport(p.model);
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} (${p.model})${supportsV ? ' 👁' : ''}`;
    if (supportsV) opt.style.fontWeight = '500';
    if (p.id === (state._captionProviderId || '')) opt.selected = true;
    sel.appendChild(opt);
  });
  // Default to first vision provider
  if (!state._captionProviderId && sel.options.length > 0) {
    sel.selectedIndex = 0;
  }
}

function applyFeishuVisibility() {
  const el = document.getElementById('feishuEnabled');
  document.getElementById('feishuSettings').style.display = el.value === '1' ? '' : 'none';
}

async function testFeishuConnection() {
  const appId = document.getElementById('feishuAppId').value.trim();
  const appSecret = document.getElementById('feishuAppSecret').value.trim();
  const appToken = document.getElementById('feishuAppToken').value.trim();
  if (!appId || !appSecret || !appToken) {
    setStatus('feishuStatus', 'err', '请填写 App ID、Secret 和 App Token');
    return;
  }
  setStatus('feishuStatus', 'checking', '连接中…');
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'TEST_FEISHU',
      appId, appSecret, appToken,
    });
    if (!res.ok) { setStatus('feishuStatus', 'err', res.error); return; }
    const sel = document.getElementById('feishuTableId');
    sel.innerHTML = '';
    (res.tables || []).forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.tableId;
      opt.textContent = `${t.name} (${t.tableId})`;
      if (t.tableId === (state._feishuTableId || '')) opt.selected = true;
      sel.appendChild(opt);
    });
    setStatus('feishuStatus', 'ok', `连接成功：${res.appName}，${res.tables.length} 个数据表`);
  } catch (err) {
    setStatus('feishuStatus', 'err', err.message);
  }
}

function applyCaptionModeVisibility() {
  const mode = document.getElementById('captionMode').value;
  document.getElementById('captionSeparateGroup').style.display = mode === 'separate' ? '' : 'none';
  document.getElementById('captionExternalGroup').style.display = mode === 'external' ? '' : 'none';
}

async function saveAll() {
  const provider = collectProviderFromForm();
  const current = state.providers.find(p => p.id === state.activeProviderId);
  if (current && !current.builtin) {
    state.providers = state.providers.map(p =>
      p.id === state.activeProviderId
        ? { ...p, baseUrl: provider.baseUrl, model: provider.model }
        : p
    );
  }
  state.providerKeys = { ...state.providerKeys, [state.activeProviderId]: provider.apiKey };

  await saveProviders();

  const syncData = {
    eagleFolderId: document.getElementById('eagleFolderId').value,
    defaultTagPrefix: document.getElementById('defaultTagPrefix').value.trim(),
    captionMode: document.getElementById('captionMode').value,
    captionProviderId: document.getElementById('captionProviderId').value,
    captionExternalUrl: document.getElementById('captionExternalUrl').value.trim(),
    feishuEnabled: document.getElementById('feishuEnabled').value,
    feishuAppId: document.getElementById('feishuAppId').value.trim(),
    feishuAppToken: document.getElementById('feishuAppToken').value.trim(),
    feishuTableId: document.getElementById('feishuTableId').value,
  };

  // Persist model override for built-in providers
  if (current && current.builtin) {
    const { providerModelOverrides = {} } = await chrome.storage.sync.get('providerModelOverrides');
    const orig = BUILTIN_PROVIDERS.find(p => p.id === current.id);
    if (orig && provider.model !== orig.model) {
      providerModelOverrides[current.id] = provider.model;
    } else {
      delete providerModelOverrides[current.id];
    }
    syncData.providerModelOverrides = providerModelOverrides;
  }

  await chrome.storage.sync.set(syncData);
  await chrome.storage.local.set({
    captionExternalKey: document.getElementById('captionExternalKey').value.trim(),
    feishuAppSecret: document.getElementById('feishuAppSecret').value.trim(),
    eagleApiToken: document.getElementById('eagleApiToken').value.trim(),
  });
  showToast('设置已保存');
}

async function resetAll() {
  if (!confirm('确定重置所有设置？所有自定义提供商、模板和 API Key 都会被清除。')) return;
  await Promise.all([chrome.storage.sync.clear(), chrome.storage.local.clear()]);
  location.reload();
}

function setStatus(id, state, msg) {
  const el = document.getElementById(id);
  el.style.display = '';
  el.innerHTML = '';
  const badge = document.createElement('div');
  badge.className = `status-badge ${state}`;
  const dot = document.createElement('span');
  dot.className = 'dot';
  badge.appendChild(dot);
  badge.appendChild(document.createTextNode(msg));
  el.appendChild(badge);
}

function clearStatus(id) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = '';
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2200);
}

document.addEventListener('DOMContentLoaded', init);
