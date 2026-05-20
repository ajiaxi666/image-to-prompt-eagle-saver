import { PROVIDER_TYPES, BUILTIN_PROVIDERS, guessVisionSupport } from './providers.js';
import { getActiveTemplate, getTemplate } from './prompt-templates.js';

const EAGLE_BASE = 'http://localhost:41595/api';
const EAGLE_TOKEN_KEY = 'eagleApiToken';
const MENU_ROOT_ID = 'eps-menu-root';
const MENU_ANALYZE_ID = 'eps-analyze-image';
const MENU_SAVE_ID = 'save-to-eagle';
const REQUEST_TIMEOUT_MS = 30000;
const MODEL_TIMEOUT_MS = 15000;
const IMAGE_FETCH_TIMEOUT_MS = 20000;

async function getEagleToken() {
  const { [EAGLE_TOKEN_KEY]: token } = await chrome.storage.local.get(EAGLE_TOKEN_KEY);
  return token || '';
}

async function eagleFetch(url, options = {}) {
  const token = await getEagleToken();
  const sep = url.includes('?') ? '&' : '?';
  const fullUrl = token ? `${url}${sep}token=${encodeURIComponent(token)}` : url;
  return fetch(fullUrl, options);
}

function registerContextMenus() {
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) {
      console.warn('Failed to clear context menus:', chrome.runtime.lastError.message);
    }
    chrome.contextMenus.create({
      id: MENU_ROOT_ID,
      title: 'Eagle 提示词助手',
      // Some sites render images as CSS backgrounds or intercept image context.
      // Showing the menu on all page contexts lets the content script provide a fallback image URL.
      contexts: ['all'],
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('Failed to create root context menu:', chrome.runtime.lastError.message);
        return;
      }
      chrome.contextMenus.create({
        id: MENU_ANALYZE_ID,
        parentId: MENU_ROOT_ID,
        title: '识别图片提示词',
        contexts: ['all'],
      });
      chrome.contextMenus.create({
        id: MENU_SAVE_ID,
        parentId: MENU_ROOT_ID,
        title: chrome.i18n?.getMessage('menuSaveEagle') || '保存到 Eagle（生成提示词）',
        contexts: ['all'],
      });
    });
  });
}

registerContextMenus();
chrome.runtime.onInstalled.addListener(registerContextMenus);
chrome.runtime.onStartup.addListener(registerContextMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (![MENU_ANALYZE_ID, MENU_SAVE_ID].includes(info.menuItemId)) return;
  const { imageUrl, pageUrl } = await getClickedImageInfo(info, tab);
  if (!imageUrl) {
    notifyError('未找到图片，请在网页图片或背景图上右键后再试');
    return;
  }

  if (info.menuItemId === MENU_ANALYZE_ID) {
    await openAnalyzerPanel(tab, { imageUrl, pageUrl });
    return;
  }

  const provider = await getActiveProvider();
  if (!provider || !provider.apiKey) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: '需要配置 AI 提供商',
      message: '请先在设置页面选择并配置 AI 提供商的 API Key',
    });
    chrome.runtime.openOptionsPage();
    return;
  }

  notifyProgress('正在分析图片并生成提示词…');

  let analysisResult = null;
  try {
    const template = await getActiveTemplate();
    analysisResult = await analyzeImage(imageUrl, provider, template);
  } catch (err) {
    notifyError('AI 分析失败：' + err.message);
    return;
  }

  await handleEagleSave(imageUrl, pageUrl, analysisResult);
});

async function getClickedImageInfo(info, tab) {
  const contextImage = info.srcUrl ? null : await getContextImageFromTab(tab);
  return {
    imageUrl: info.srcUrl || contextImage?.imageUrl || '',
    pageUrl: info.pageUrl || contextImage?.pageUrl || tab?.url || '',
  };
}

async function openAnalyzerPanel(tab, payload) {
  if (!tab?.id) {
    notifyError('无法打开识别面板：当前页面不可用');
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'OPEN_EPS_PANEL',
      imageUrl: payload.imageUrl,
      pageUrl: payload.pageUrl,
      autoAnalyze: true,
    });
  } catch (err) {
    notifyError(`无法打开识别面板，请刷新页面后重试：${err.message}`);
  }
}

async function getContextImageFromTab(tab) {
  if (!tab?.id) return null;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTEXT_IMAGE' });
    return res?.ok ? res : null;
  } catch {
    return null;
  }
}

async function getActiveProvider() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(['activeProviderId', 'customProviders', 'providerModelOverrides']),
    chrome.storage.local.get('providerKeys'),
  ]);
  const all = [...BUILTIN_PROVIDERS, ...(sync.customProviders || [])];
  const overrides = sync.providerModelOverrides || {};
  const activeId = sync.activeProviderId || BUILTIN_PROVIDERS[0].id;
  const provider = all.find(p => p.id === activeId);
  if (!provider) return null;
  const apiKey = (local.providerKeys || {})[activeId];
  const model = provider.builtin && overrides[activeId] ? overrides[activeId] : provider.model;
  return { ...provider, model, apiKey };
}

async function analyzeImage(imageUrl, provider, template) {
  await ensureHostPermission(provider.baseUrl);

  // Check if main provider supports vision
  if (providerSupportsVision(provider)) {
    if (provider.type === PROVIDER_TYPES.CLAUDE) {
      return analyzeWithClaude(imageUrl, provider, template);
    }
    if (provider.type === PROVIDER_TYPES.GEMINI) {
      return analyzeWithGemini(imageUrl, provider, template);
    }
    return analyzeWithOpenAI(imageUrl, provider, template);
  }

  // Main model doesn't support vision — use caption fallback
  notifyProgress('主模型不支持图片理解，正在通过 Caption 源分析…');
  const captionText = await getImageCaption(imageUrl);
  return analyzeWithTextOnly(captionText, imageUrl, provider, template);
}

function providerSupportsVision(provider) {
  return provider?.supportsVision === true || guessVisionSupport(provider?.model);
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function buildProviderUrl(provider, path) {
  return `${trimTrailingSlash(provider.baseUrl)}${path}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      let target = String(url);
      try { target = new URL(url).origin; } catch {}
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）：${target}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`接口返回的不是 JSON：${text.slice(0, 200)}`);
  }
}

function getApiError(data, fallback) {
  return data?.error?.message || data?.message || fallback;
}

async function callGeminiGenerateContent(provider, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  const res = await fetchWithTimeout(
    buildProviderUrl(provider, `/models/${encodeURIComponent(provider.model)}:generateContent`),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': provider.apiKey,
      },
      body: JSON.stringify(body),
    },
    timeoutMs
  );
  const data = await readJsonResponse(res);
  if (!res.ok) throw new Error(getApiError(data, `HTTP ${res.status}`));
  return data;
}

function extractGeminiText(data) {
  const parts = (data.candidates || []).flatMap(candidate => candidate.content?.parts || []);
  const text = parts.map(part => part.text || '').filter(Boolean).join('\n').trim();
  if (text) return text;
  const reason = data.candidates?.[0]?.finishReason;
  throw new Error(reason ? `Gemini 未返回文本内容（${reason}）` : 'Gemini 未返回文本内容');
}

async function analyzeWithClaude(imageUrl, provider, template) {
  const imagePayload = await getImagePayload(imageUrl);
  const res = await fetchWithTimeout(`${provider.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: buildClaudeImageSource(imagePayload, imageUrl) },
          { type: 'text', text: template.content },
        ],
      }],
    }),
  });
  const data = await readJsonResponse(res);
  if (!res.ok) {
    throw new Error(getApiError(data, `HTTP ${res.status}`));
  }
  return extractJson(data.content?.[0]?.text || '');
}

async function analyzeWithOpenAI(imageUrl, provider, template) {
  const imagePayload = await getImagePayload(imageUrl);
  const primaryImageUrl = imagePayload.dataUrl || imageUrl;
  try {
    return await analyzeWithOpenAIImageUrl(primaryImageUrl, provider, template);
  } catch (err) {
    if (imagePayload.dataUrl && err.providerResponse) {
      return analyzeWithOpenAIImageUrl(imageUrl, provider, template);
    }
    throw err;
  }
}

async function analyzeWithOpenAIImageUrl(imageUrl, provider, template) {
  const body = {
    model: provider.model,
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageUrl } },
        { type: 'text', text: template.content },
      ],
    }],
  };
  if (provider.supportsJsonMode === true) {
    body.response_format = { type: 'json_object' };
  }
  const data = await postOpenAIChat(provider, body);
  return extractJson(data.choices?.[0]?.message?.content || '');
}

async function postOpenAIChat(provider, body) {
  const res = await fetchWithTimeout(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${provider.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await readJsonResponse(res);
  if (!res.ok) {
    const wrapped = new Error(getApiError(data, `HTTP ${res.status}`));
    wrapped.providerResponse = true;
    throw wrapped;
  }
  return data;
}

// ---- Gemini Vision ----

async function fetchImageAsBase64(imageUrl) {
  if (/^data:/i.test(imageUrl)) return parseDataUrl(imageUrl);

  const res = await fetchWithTimeout(imageUrl, { credentials: 'include' }, IMAGE_FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`下载图片失败：HTTP ${res.status}`);
  const contentType = normalizeMimeType(res.headers.get('content-type')) || guessImageMimeType(imageUrl);
  if (!contentType.startsWith('image/')) {
    throw new Error(`目标不是图片资源：${contentType}`);
  }
  const buf = await res.arrayBuffer();
  const data = arrayBufferToBase64(buf);
  return { mimeType: contentType, data, dataUrl: `data:${contentType};base64,${data}` };
}

async function getImagePayload(imageUrl, options = {}) {
  try {
    return await fetchImageAsBase64(imageUrl);
  } catch (err) {
    if (options.required) throw new Error(`读取图片失败：${err.message}`);
    console.warn('Falling back to remote image URL:', err.message);
    return { url: imageUrl, error: err };
  }
}

function buildClaudeImageSource(imagePayload, imageUrl) {
  if (imagePayload?.data) {
    return {
      type: 'base64',
      media_type: imagePayload.mimeType || 'image/jpeg',
      data: imagePayload.data,
    };
  }
  return { type: 'url', url: imagePayload?.url || imageUrl };
}

function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
  if (!match) throw new Error('无效的 data URL 图片');
  const mimeType = normalizeMimeType(match[1]) || 'image/jpeg';
  const rawData = match[3] || '';
  const data = match[2]
    ? rawData.replace(/\s/g, '')
    : btoa(decodeURIComponent(rawData).replace(/\+/g, ' '));
  return { mimeType, data, dataUrl: `data:${mimeType};base64,${data}` };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function normalizeMimeType(value) {
  return (value || '').split(';')[0].trim().toLowerCase();
}

function guessImageMimeType(url) {
  const path = String(url || '').split('?')[0].toLowerCase();
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.avif')) return 'image/avif';
  return 'image/jpeg';
}

async function analyzeWithGemini(imageUrl, provider, template) {
  const { mimeType, data } = await getImagePayload(imageUrl, { required: true });
  const body = {
    contents: [{
      parts: [
        { text: template.content },
        { inline_data: { mime_type: mimeType, data } },
      ],
    }],
    generationConfig: { maxOutputTokens: 1500, temperature: 0.4, responseMimeType: 'application/json' },
  };
  const result = await callGeminiGenerateContent(provider, body);
  return extractJson(extractGeminiText(result));
}

// ---- Caption Fallback Pipeline ----

async function getCaptionSettings() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(['captionMode', 'captionProviderId', 'captionExternalUrl']),
    chrome.storage.local.get('captionExternalKey'),
  ]);
  return {
    mode: sync.captionMode || 'same',
    captionProviderId: sync.captionProviderId || '',
    captionExternalUrl: sync.captionExternalUrl || '',
    captionExternalKey: local.captionExternalKey || '',
  };
}

async function getCaptionProvider() {
  const settings = await getCaptionSettings();
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(['customProviders', 'providerModelOverrides']),
    chrome.storage.local.get('providerKeys'),
  ]);
  const all = [...BUILTIN_PROVIDERS, ...(sync.customProviders || [])];
  const overrides = sync.providerModelOverrides || {};
  let cp = all.find(p => p.id === settings.captionProviderId);
  if (!cp) {
    // Fallback: find first vision-capable built-in provider with a stored key
    cp = all.find(p => providerSupportsVision(p) && (local.providerKeys || {})[p.id]);
  }
  if (!cp) throw new Error('未配置 Caption 提供商，请在设置中选择一个有 Vision 能力的提供商');
  const apiKey = (local.providerKeys || {})[cp.id];
  if (!apiKey) throw new Error('Caption 提供商未配置 API Key');
  const model = cp.builtin && overrides[cp.id] ? overrides[cp.id] : cp.model;
  return { ...cp, model, apiKey };
}

async function getImageCaption(imageUrl) {
  const settings = await getCaptionSettings();

  if (settings.mode === 'external' && settings.captionExternalUrl) {
    return callExternalCaption(imageUrl, settings);
  }

  // 'separate' mode (or fallback)
  const cp = await getCaptionProvider();
  await ensureHostPermission(cp.baseUrl);

  const captionPrompt = 'Describe this image in detail. Include: subject, composition, lighting, colors, style, mood. Write 2-4 sentences in natural English. Do NOT use markdown or JSON.';

  if (cp.type === PROVIDER_TYPES.CLAUDE) {
    const imagePayload = await getImagePayload(imageUrl);
    const res = await fetchWithTimeout(`${cp.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': cp.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: cp.model,
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: buildClaudeImageSource(imagePayload, imageUrl) },
            { type: 'text', text: captionPrompt },
          ],
        }],
      }),
    });
    const data = await readJsonResponse(res);
    if (!res.ok) throw new Error(`Caption 提供商请求失败：${getApiError(data, `HTTP ${res.status}`)}`);
    return data.content?.[0]?.text || '';
  }

  if (cp.type === PROVIDER_TYPES.GEMINI) {
    const { mimeType, data: imgData } = await getImagePayload(imageUrl, { required: true });
    const data = await callGeminiGenerateContent(cp, {
      contents: [{ parts: [{ text: captionPrompt }, { inline_data: { mime_type: mimeType, data: imgData } }] }],
      generationConfig: { maxOutputTokens: 400 },
    });
    return extractGeminiText(data);
  }

  // OpenAI-compatible caption
  const imagePayload = await getImagePayload(imageUrl);
  const primaryImageUrl = imagePayload.dataUrl || imageUrl;
  let data;
  try {
    data = await postOpenAIChat(cp, buildCaptionOpenAIBody(primaryImageUrl, cp, captionPrompt));
  } catch (err) {
    if (!imagePayload.dataUrl || !err.providerResponse) throw err;
    data = await postOpenAIChat(cp, buildCaptionOpenAIBody(imageUrl, cp, captionPrompt));
  }
  return data.choices?.[0]?.message?.content || '';
}

function buildCaptionOpenAIBody(imageUrl, provider, captionPrompt) {
  return {
    model: provider.model,
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageUrl } },
        { type: 'text', text: captionPrompt },
      ],
    }],
  };
}

async function callExternalCaption(imageUrl, settings) {
  const headers = { 'content-type': 'application/json' };
  if (settings.captionExternalKey) {
    headers['Authorization'] = `Bearer ${settings.captionExternalKey}`;
  }
  const res = await fetchWithTimeout(settings.captionExternalUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ imageUrl }),
  });
  if (!res.ok) throw new Error(`外部 Caption 端点返回 HTTP ${res.status}`);
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    return json.caption || json.description || json.text || text;
  } catch {
    return text;
  }
}

async function analyzeWithTextOnly(captionText, imageUrl, provider, template) {
  const textPrompt = [
    'You are an expert AI image prompt engineer.',
    '',
    'Below is a description of an image and its URL. Use this as the basis for your analysis.',
    '',
    '--- IMAGE DESCRIPTION ---',
    captionText,
    '',
    '--- IMAGE URL (for reference, do not fetch) ---',
    imageUrl,
    '',
    '--- YOUR TASK ---',
    template.content,
  ].join('\n');

  if (provider.type === PROVIDER_TYPES.CLAUDE) {
    const res = await fetchWithTimeout(`${provider.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 1500,
        messages: [{ role: 'user', content: textPrompt }],
      }),
    });
    const data = await readJsonResponse(res);
    if (!res.ok) {
      throw new Error(getApiError(data, `HTTP ${res.status}`));
    }
    return extractJson(data.content?.[0]?.text || '');
  }

  if (provider.type === PROVIDER_TYPES.GEMINI) {
    const data = await callGeminiGenerateContent(provider, {
      contents: [{ parts: [{ text: textPrompt }] }],
      generationConfig: { maxOutputTokens: 1500, responseMimeType: 'application/json' },
    });
    return extractJson(extractGeminiText(data));
  }

  // OpenAI-compatible
  const body = {
    model: provider.model,
    max_tokens: 1500,
    messages: [{ role: 'user', content: textPrompt }],
  };
  if (provider.supportsJsonMode === true) {
    body.response_format = { type: 'json_object' };
  }
  const res = await fetchWithTimeout(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${provider.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await readJsonResponse(res);
  if (!res.ok) {
    throw new Error(getApiError(data, `HTTP ${res.status}`));
  }
  return extractJson(data.choices?.[0]?.message?.content || '');
}

function extractJson(text) {
  const tryParse = (s) => {
    const parsed = JSON.parse(s);
    validateAnalysis(parsed);
    return parsed;
  };
  try {
    return tryParse(text);
  } catch {
    const start = text.indexOf('{');
    if (start < 0) throw new Error('AI 返回了无效的 JSON 格式');
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escapeNext = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return tryParse(text.slice(start, i + 1));
      }
    }
    throw new Error('AI 返回的 JSON 不完整');
  }
}

function validateAnalysis(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('AI 返回了非对象结果');
  if (!obj.prompt_en || typeof obj.prompt_en !== 'string') {
    throw new Error('AI 返回缺少必需字段 prompt_en');
  }
  if (!obj.description || typeof obj.description !== 'string') {
    throw new Error('AI 返回缺少必需字段 description');
  }
}

async function ensureHostPermission(baseUrl) {
  let origin;
  try {
    origin = new URL(baseUrl).origin + '/*';
  } catch {
    throw new Error(`无效的 Base URL: ${baseUrl}`);
  }
  const granted = await chrome.permissions.contains({ origins: [origin] }).catch(() => false);
  const allUrlsGranted = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
  if (granted || allUrlsGranted) return;
  let ok;
  try {
    ok = await chrome.permissions.request({ origins: [origin] });
  } catch (err) {
    throw new Error(`无法请求访问 ${origin}：${err.message}。请将该域名添加到 manifest 的 optional_host_permissions。`);
  }
  if (!ok) throw new Error(`用户拒绝授权访问 ${origin}`);
}

async function handleEagleSave(imageUrl, pageUrl, analysis) {
  const eagleRunning = await checkEagle();
  if (!eagleRunning) {
    const error = 'Eagle 未运行，请先打开 Eagle 应用';
    notifyError(error);
    return { ok: false, error };
  }

  const settings = await chrome.storage.sync.get(['eagleFolderId', 'defaultTagPrefix']);
  const prefix = settings.defaultTagPrefix || '';

  const tags = [
    ...(analysis.tags || []).map(t => prefix ? `${prefix}:${t}` : t),
    ...(analysis.tags_zh || []),
    analysis.style || 'other',
  ].filter(Boolean);

  const annotation = [
    analysis.prompt_en || '',
    analysis.prompt_zh ? `\n\n中文：${analysis.prompt_zh}` : '',
  ].join('').trim();

  try {
    const addRes = await eagleFetch(`${EAGLE_BASE}/item/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: imageUrl,
        name: analysis.description || '未命名素材',
        website: pageUrl,
        annotation,
        tags,
        folders: settings.eagleFolderId ? [settings.eagleFolderId] : [],
      }),
    });
    const addData = await addRes.json();
    if (addData.status !== 'success') throw new Error(addData.message || '保存失败');
    saveToHistory({ imageUrl, pageUrl, analysis, target: 'eagle', itemId: addData.data?.id });
    notifySuccess(`已保存到 Eagle：${analysis.description || imageUrl.slice(-40)}`);

    // Also save to Feishu shared library if configured
    saveToFeishuIfEnabled(imageUrl, pageUrl, analysis).catch(() => {});
    return { ok: true };
  } catch (err) {
    notifyError('保存到 Eagle 失败：' + err.message);
    return { ok: false, error: err.message };
  }
}

async function checkEagle() {
  try {
    const res = await eagleFetch(`${EAGLE_BASE}/application/info`, { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    return data.status === 'success';
  } catch {
    return false;
  }
}

function saveToHistory(entry) {
  chrome.storage.local.get({ history: [] }, ({ history }) => {
    const updated = [{ ...entry, savedAt: Date.now() }, ...history].slice(0, 20);
    chrome.storage.local.set({ history: updated });
  });
}

function notifyProgress(msg) {
  chrome.notifications.create('progress', {
    type: 'basic', iconUrl: 'icons/icon48.png',
    title: 'Eagle 助手', message: msg,
  });
}

function notifySuccess(msg) {
  chrome.notifications.clear('progress');
  chrome.notifications.create({
    type: 'basic', iconUrl: 'icons/icon48.png',
    title: '保存成功', message: msg,
  });
}

function notifyError(msg) {
  chrome.notifications.clear('progress');
  chrome.notifications.create({
    type: 'basic', iconUrl: 'icons/icon48.png',
    title: '操作失败', message: msg,
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleRuntimeMessage(msg)
    .then(sendResponse)
    .catch(err => {
      console.error('[Eagle Prompt Saver]', err);
      sendResponse({ ok: false, error: err.message || '未知错误' });
    });
  return true;
});

async function handleRuntimeMessage(msg) {
  switch (msg.type) {
    case 'CHECK_EAGLE':
      return checkEagle();
    case 'GET_EAGLE_FOLDERS': {
      const res = await eagleFetch(`${EAGLE_BASE}/folder/list`);
      const data = await readJsonResponse(res);
      return { ok: true, folders: data.data || [] };
    }
    case 'TEST_PROVIDER':
      return testProvider(msg.provider);
    case 'FETCH_MODELS':
      return fetchModels(msg.provider);
    case 'ANALYZE_IMAGE':
      return handleAnalyzeImage(msg.imageUrl, msg.pageUrl);
    case 'SAVE_LOCAL':
      saveToHistory({ imageUrl: msg.imageUrl, pageUrl: msg.pageUrl, analysis: msg.analysis, target: 'local' });
      return { ok: true };
    case 'SAVE_TO_EAGLE':
      return handleEagleSave(msg.imageUrl, msg.pageUrl, msg.analysis);
    case 'SAVE_TO_FEISHU':
      await saveToFeishuIfEnabled(msg.imageUrl, msg.pageUrl, msg.analysis);
      return { ok: true };
    case 'OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      return { ok: true };
    case 'TEST_FEISHU':
      return testFeishu(msg);
    case 'LIST_FEISHU_RECORDS':
      return listFeishuRecords(msg);
    case 'PREVIEW_PROMPT':
      return previewPrompt(msg.imageUrl, msg.templateId);
    case 'REGISTER_CONTEXT_MENUS':
      registerContextMenus();
      return { ok: true };
    default:
      return { ok: false, error: `未知消息类型：${msg.type}` };
  }
}

async function testProvider(provider) {
  try {
    await ensureHostPermission(provider.baseUrl);
    if (provider.type === PROVIDER_TYPES.CLAUDE) {
      const res = await fetchWithTimeout(`${provider.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': provider.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: provider.model,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }, MODEL_TIMEOUT_MS);
      const data = await readJsonResponse(res);
      if (!res.ok || data.error) return { ok: false, error: getApiError(data, `HTTP ${res.status}`) };
      return { ok: true };
    }
    if (provider.type === PROVIDER_TYPES.GEMINI) {
      await callGeminiGenerateContent(provider, {
        contents: [{ parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 10 },
      }, MODEL_TIMEOUT_MS);
      return { ok: true };
    }
    const res = await fetchWithTimeout(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${provider.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }, MODEL_TIMEOUT_MS);
    const data = await readJsonResponse(res);
    if (!res.ok || data.error) return { ok: false, error: getApiError(data, `HTTP ${res.status}`) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function fetchModels(provider) {
  try {
    await ensureHostPermission(provider.baseUrl);
    if (provider.type === PROVIDER_TYPES.CLAUDE) {
      return { ok: false, error: 'Claude API 不支持拉取模型列表，请手动输入模型名称' };
    }
    if (provider.type === PROVIDER_TYPES.GEMINI) {
      const res = await fetchWithTimeout(buildProviderUrl(provider, '/models'), {
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': provider.apiKey,
        },
      }, MODEL_TIMEOUT_MS);
      const data = await readJsonResponse(res);
      if (!res.ok) {
        return { ok: false, error: getApiError(data, `HTTP ${res.status}`) };
      }
      const models = (data.models || [])
        .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
        .map(m => (m.name || '').replace('models/', ''))
        .filter(Boolean).sort();
      return { ok: true, models };
    }
    const res = await fetchWithTimeout(`${provider.baseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${provider.apiKey}`,
        'content-type': 'application/json',
      },
    }, MODEL_TIMEOUT_MS);
    const data = await readJsonResponse(res);
    if (!res.ok) {
      return { ok: false, error: getApiError(data, `HTTP ${res.status}`) };
    }
    const models = (data.data || []).map(m => m.id || m.model || m.name).filter(Boolean).sort();
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---- Feishu Shared Library ----

async function getFeishuConfig() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get([
      'feishuEnabled', 'feishuAppId', 'feishuAppToken', 'feishuTableId',
    ]),
    chrome.storage.local.get('feishuAppSecret'),
  ]);
  if (sync.feishuEnabled !== '1') return null;
  if (!sync.feishuAppId || !local.feishuAppSecret || !sync.feishuAppToken || !sync.feishuTableId) return null;
  return { ...sync, feishuAppSecret: local.feishuAppSecret };
}

async function saveToFeishuIfEnabled(imageUrl, pageUrl, analysis) {
  const config = await getFeishuConfig();
  if (!config) return;
  try {
    const { getTenantAccessToken, createRecord } = await import(chrome.runtime.getURL('feishu.js'));
    const token = await getTenantAccessToken(config.feishuAppId, config.feishuAppSecret);
    await createRecord(config.feishuAppToken, config.feishuTableId, token, {
      '描述': analysis.description || '',
      'Prompt_EN': analysis.prompt_en || '',
      'Prompt_ZH': analysis.prompt_zh || '',
      'Tags': (analysis.tags || []).join(', '),
      '风格': analysis.style || '',
      '图片URL': imageUrl,
      '来源URL': pageUrl || '',
      '创建时间': Date.now(),
    });
  } catch (err) {
    console.error('Feishu save failed:', err.message);
  }
}

async function testFeishu({ appId, appSecret, appToken }) {
  try {
    const { getTenantAccessToken, getBitableInfo, listTables } =
      await import(chrome.runtime.getURL('feishu.js'));
    const token = await getTenantAccessToken(appId, appSecret);
    const app = await getBitableInfo(appToken, token);
    const tables = await listTables(appToken, token);
    return { ok: true, appName: app.name, tables };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function listFeishuRecords({ pageToken }) {
  try {
    const config = await getFeishuConfig();
    if (!config) return { ok: false, error: '飞书共享库未配置' };
    const { getTenantAccessToken, listRecords } =
      await import(chrome.runtime.getURL('feishu.js'));
    const token = await getTenantAccessToken(config.feishuAppId, config.feishuAppSecret);
    const result = await listRecords(config.feishuAppToken, config.feishuTableId, token, pageToken);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handleAnalyzeImage(imageUrl, pageUrl) {
  try {
    const provider = await getActiveProvider();
    if (!provider?.apiKey) return { ok: false, error: '请先配置 AI 提供商和 API Key' };
    const template = await getActiveTemplate();
    let analysis;
    try {
      analysis = await analyzeImage(imageUrl, provider, template);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    return {
      ok: true,
      shortEN: (analysis.tags || []).join(', ') || analysis.prompt_en || '',
      shortZH: (analysis.tags_zh || []).join('，') || analysis.prompt_zh || '',
      fullEN: analysis.prompt_en || '',
      fullZH: analysis.prompt_zh || '',
      style: analysis.style || '',
      tags: analysis.tags || [],
      description: analysis.description || '',
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function previewPrompt(imageUrl, templateId) {
  try {
    const provider = await getActiveProvider();
    if (!provider?.apiKey) return { ok: false, error: '请先配置 AI 提供商和 API Key' };
    const template = await getTemplate(templateId);
    const result = await analyzeImage(imageUrl, provider, template);
    return { ok: true, analysis: result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
