export const BUILTIN_TEMPLATES = [
  {
    id: 'sd-midjourney',
    name: 'Stable Diffusion / Midjourney',
    description: '逗号分隔的标签式提示词，适配 SD/MJ/NovelAI',
    builtin: true,
    content: `You are an expert AI image prompt engineer specializing in Stable Diffusion and Midjourney. Analyze this image and produce a prompt that, when used to regenerate, would yield a visually similar result.

Return ONLY a JSON object (no markdown fences, no explanation) with these exact fields:
{
  "prompt_en": "comma-separated descriptors in this order: (1) quality tags like 'masterpiece, best quality, 8k' (2) subject and pose (3) clothing and accessories (4) facial features and expression (5) environment and background (6) lighting (golden hour, rim light, soft lighting, etc.) (7) composition and camera angle (close-up, wide shot, dutch angle) (8) artistic style and medium (9) color palette. Use parenthesis weights like (keyword:1.2) for critical elements.",
  "prompt_zh": "对应的中文逗号分隔提示词",
  "tags": ["8-12 english tags covering style, medium, mood"],
  "tags_zh": ["4-8 个中文关键词标签"],
  "style": "one of: photography | illustration | anime | 3d | painting | sketch | pixel-art | ui-design | other",
  "description": "一句话中文概括图片内容（不超过 25 字）"
}`,
  },
  {
    id: 'flux-natural',
    name: 'Flux / DALL-E 自然语言',
    description: '流畅英文自然语言描述，适配 Flux、DALL-E 3、Ideogram',
    builtin: true,
    content: `You are an expert AI image prompt engineer for modern natural-language models (Flux, DALL-E 3, Ideogram, Imagen). Analyze this image and write a flowing English paragraph that describes it precisely enough to regenerate.

Return ONLY a JSON object with these exact fields:
{
  "prompt_en": "a single coherent English paragraph of 2-4 sentences. Start with the subject and action. Layer in: composition and framing, environment, lighting quality and direction, color palette and mood, materials and textures, artistic style or medium, and camera characteristics (lens, depth of field). Avoid keyword stuffing — write natural, specific, sensory prose.",
  "prompt_zh": "同等信息密度的中文自然语言段落",
  "tags": ["8-12 english descriptors"],
  "tags_zh": ["4-8 个中文关键词"],
  "style": "one of: photography | illustration | anime | 3d | painting | sketch | pixel-art | ui-design | other",
  "description": "一句话中文概括图片内容（不超过 25 字）"
}`,
  },
  {
    id: 'concise-zh',
    name: '简洁中文描述',
    description: '以中文为主，轻量关键词，适合素材整理和检索',
    builtin: true,
    content: `分析这张图片，为素材管理库生成精简的中文描述和检索标签。

仅返回 JSON 对象（无 markdown 代码块、无额外说明），包含以下字段：
{
  "prompt_en": "a concise English tag list, comma-separated, covering subject, style, lighting, mood — 15 descriptors max",
  "prompt_zh": "中文自然语言描述，约 60-100 字，涵盖主体、风格、氛围、构图",
  "tags": ["6-10 english keywords"],
  "tags_zh": ["6-10 个中文检索标签，优先选择可搜索的名词和风格词"],
  "style": "one of: photography | illustration | anime | 3d | painting | sketch | pixel-art | ui-design | other",
  "description": "一句话中文摘要（不超过 20 字，用于文件名）"
}`,
  },
  {
    id: 'design-ui',
    name: 'UI / 设计稿分析',
    description: '针对 UI 界面、插画海报、品牌视觉的设计维度拆解',
    builtin: true,
    content: `You are a senior visual designer analyzing a design artifact (UI screen, poster, illustration, brand visual). Decompose it along design dimensions usable for inspiration and reproduction.

Return ONLY a JSON object with these exact fields:
{
  "prompt_en": "structured design brief covering: (1) artifact type and purpose (2) layout pattern (bento, z-pattern, hero+grid, etc.) (3) color palette with hex values when identifiable (4) typography character (serif/sans, geometric/humanist, weight hierarchy) (5) spacing rhythm and density (6) visual style direction (neo-brutalism, glassmorphism, editorial, swiss, etc.) (7) imagery treatment (8) signature details that define the look",
  "prompt_zh": "同等深度的中文设计拆解",
  "tags": ["8-12 design-system descriptors in english"],
  "tags_zh": ["6-10 个中文设计风格标签"],
  "style": "ui-design",
  "description": "一句话中文概括这个设计的核心特征（不超过 30 字）"
}`,
  },
];

export async function getAllTemplates() {
  const { customTemplates = [] } = await chrome.storage.sync.get('customTemplates');
  return [...BUILTIN_TEMPLATES, ...customTemplates];
}

export async function getTemplate(id) {
  const all = await getAllTemplates();
  return all.find(t => t.id === id) || BUILTIN_TEMPLATES[0];
}

export async function getActiveTemplate() {
  const { activeTemplateId } = await chrome.storage.sync.get('activeTemplateId');
  return getTemplate(activeTemplateId || BUILTIN_TEMPLATES[0].id);
}

export async function saveCustomTemplate(template) {
  const { customTemplates = [] } = await chrome.storage.sync.get('customTemplates');
  const idx = customTemplates.findIndex(t => t.id === template.id);
  const next = idx >= 0
    ? customTemplates.map((t, i) => i === idx ? template : t)
    : [...customTemplates, template];
  await chrome.storage.sync.set({ customTemplates: next });
}

export async function deleteCustomTemplate(id) {
  const { customTemplates = [] } = await chrome.storage.sync.get('customTemplates');
  const next = customTemplates.filter(t => t.id !== id);
  await chrome.storage.sync.set({ customTemplates: next });
}
