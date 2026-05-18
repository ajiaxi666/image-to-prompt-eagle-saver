import { PROVIDER_TYPES, BUILTIN_PROVIDERS, guessVisionSupport } from './providers.js';
import { getActiveTemplate, getTemplate } from './prompt-templates.js';

const EAGLE_BASE = 'http://localhost:41595/api';
const EAGLE_TOKEN_KEY = 'eagleApiToken';
const MENU_ID = 'save-to-eagle';

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
      id: MENU_ID,
      title: '保存到 Eagle（生成提示词）',
      // Some sites render images as CSS backgrounds or intercept image context.
      // Showing the menu on all page contexts lets the content script provide a fallback image URL.
      contexts: ['all'],
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('Failed to create context menu:', chrome.runtime.lastError.message);
      }
    });
  });
}

registerContextMenus();
chrome.runtime.onInstalled.addListener(registerContextMenus);
chrome.runtime.onStartup.addListener(registerContextMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const contextImage = info.srcUrl ? null : await getContextImageFromTab(tab);
  const imageUrl = info.srcUrl || contextImage?.imageUrl || '';
  const pageUrl = info.pageUrl || contextImage?.pageUrl || tab?.url || '';
  if (!imageUrl) {
    notifyError('未找到图片，请在网页图片或背景图上右键后再试');
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

async function analyzeWithClaude(imageUrl, provider, template) {
  const imagePayload = await getImagePayload(imageUrl);
  const res = await fetch(`${provider.baseUrl}/messages`, {
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
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
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
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${provider.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const wrapped = new Error(err.error?.message || `HTTP ${res.status}`);
    wrapped.providerResponse = true;
    throw wrapped;
  }
  return res.json();
}

// ---- Gemini Vision ----

async function fetchImageAsBase64(imageUrl) {
  if (/^data:/i.test(imageUrl)) return parseDataUrl(imageUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(imageUrl, {
      signal: controller.signal,
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`下载图片失败：HTTP ${res.status}`);
    const contentType = normalizeMimeType(res.headers.get('content-type')) || guessImageMimeType(imageUrl);
    if (!contentType.startsWith('image/')) {
      throw new Error(`目标不是图片资源：${contentType}`);
    }
    const buf = await res.arrayBuffer();
    const data = arrayBufferToBase64(buf);
    return { mimeType: contentType, data, dataUrl: `data:${contentType};base64,${data}` };
  } finally {
    clearTimeout(timeout);
  }
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
        { inlineData: { mimeType, data } },
      ],
    }],
    generationConfig: { maxOutputTokens: 1500, temperature: 0.7 },
  };
  const res = await fetch(`${provider.baseUrl}/models/${provider.model}:generateContent?key=${encodeURIComponent(provider.apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return extractJson(data.candidates?.[0]?.content?.parts?.[0]?.text || '');
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
    const res = await fetch(`${cp.baseUrl}/messages`, {
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
    if (!res.ok) throw new Error(`Caption 提供商请求失败：HTTP ${res.status}`);
    const data = await res.json();
    return data.content?.[0]?.text || '';
  }

  if (cp.type === PROVIDER_TYPES.GEMINI) {
    const { mimeType, data: imgData } = await getImagePayload(imageUrl, { required: true });
    const res = await fetch(`${cp.baseUrl}/models/${cp.model}:generateContent?key=${encodeURIComponent(cp.apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        contents: [{ parts: [{ text: captionPrompt }, { inlineData: { mimeType, data: imgData } }] }],
        generationConfig: { maxOutputTokens: 400 },
      }),
    });
    if (!res.ok) throw new Error(`Caption 提供商请求失败：HTTP ${res.status}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
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
  const res = await fetch(settings.captionExternalUrl, {
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
    const res = await fetch(`${provider.baseUrl}/messages`, {
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
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    return extractJson(data.content?.[0]?.text || '');
  }

  if (provider.type === PROVIDER_TYPES.GEMINI) {
    const res = await fetch(`${provider.baseUrl}/models/${provider.model}:generateContent?key=${encodeURIComponent(provider.apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        contents: [{ parts: [{ text: textPrompt }] }],
        generationConfig: { maxOutputTokens: 1500 },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return extractJson(data.candidates?.[0]?.content?.parts?.[0]?.text || '');
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
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${provider.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
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
  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (granted) return;
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
    notifyError('Eagle 未运行，请先打开 Eagle 应用');
    return;
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
  } catch (err) {
    notifyError('保存到 Eagle 失败：' + err.message);
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
  if (msg.type === 'CHECK_EAGLE') {
    checkEagle().then(sendResponse);
    return true;
  }
  if (msg.type === 'GET_EAGLE_FOLDERS') {
    eagleFetch(`${EAGLE_BASE}/folder/list`)
      .then(r => r.json())
      .then(d => sendResponse({ ok: true, folders: d.data || [] }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'TEST_PROVIDER') {
    testProvider(msg.provider).then(sendResponse);
    return true;
  }
  if (msg.type === 'FETCH_MODELS') {
    fetchModels(msg.provider).then(sendResponse);
    return true;
  }
  if (msg.type === 'ANALYZE_IMAGE') {
    handleAnalyzeImage(msg.imageUrl, msg.pageUrl).then(sendResponse);
    return true;
  }
  if (msg.type === 'SAVE_LOCAL') {
    saveToHistory({ imageUrl: msg.imageUrl, pageUrl: msg.pageUrl, analysis: msg.analysis, target: 'local' });
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'SAVE_TO_EAGLE') {
    handleEagleSave(msg.imageUrl, msg.pageUrl, msg.analysis);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'SAVE_TO_FEISHU') {
    saveToFeishuIfEnabled(msg.imageUrl, msg.pageUrl, msg.analysis)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'TEST_FEISHU') {
    testFeishu(msg).then(sendResponse);
    return true;
  }
  if (msg.type === 'LIST_FEISHU_RECORDS') {
    listFeishuRecords(msg).then(sendResponse);
    return true;
  }
  if (msg.type === 'PREVIEW_PROMPT') {
    previewPrompt(msg.imageUrl, msg.templateId).then(sendResponse);
    return true;
  }
});

async function testProvider(provider) {
  try {
    await ensureHostPermission(provider.baseUrl);
    if (provider.type === PROVIDER_TYPES.CLAUDE) {
      const res = await fetch(`${provider.baseUrl}/messages`, {
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
      });
      const data = await res.json();
      if (data.error) return { ok: false, error: data.error.message };
      return { ok: true };
    }
    if (provider.type === PROVIDER_TYPES.GEMINI) {
      const res = await fetch(`${provider.baseUrl}/models/${provider.model}:generateContent?key=${encodeURIComponent(provider.apiKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 10 },
        }),
      });
      const data = await res.json();
      if (data.error) return { ok: false, error: data.error.message };
      return { ok: true };
    }
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
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
    });
    const data = await res.json();
    if (data.error) return { ok: false, error: data.error.message };
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
      const res = await fetch(`${provider.baseUrl}/models?key=${encodeURIComponent(provider.apiKey)}`, {
        headers: { 'content-type': 'application/json' },
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        return { ok: false, error: errData.error?.message || `HTTP ${res.status}` };
      }
      const data = await res.json();
      const models = (data.models || [])
        .map(m => (m.name || '').replace('models/', ''))
        .filter(Boolean).sort();
      return { ok: true, models };
    }
    const res = await fetch(`${provider.baseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${provider.apiKey}`,
        'content-type': 'application/json',
      },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: err.error?.message || `HTTP ${res.status}` };
    }
    const data = await res.json();
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
