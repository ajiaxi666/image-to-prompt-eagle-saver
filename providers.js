export const PROVIDER_TYPES = {
  CLAUDE: 'claude',
  OPENAI_COMPATIBLE: 'openai_compatible',
  GEMINI: 'gemini',
};

export const BUILTIN_PROVIDERS = [
  {
    id: 'claude-official',
    name: 'Claude (Anthropic 官方)',
    type: PROVIDER_TYPES.CLAUDE,
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-20250514',
    supportsVision: true,
    builtin: true,
  },
  {
    id: 'openai-official',
    name: 'OpenAI (GPT-4 Vision)',
    type: PROVIDER_TYPES.OPENAI_COMPATIBLE,
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    supportsVision: true,
    supportsJsonMode: true,
    builtin: true,
  },
  {
    id: 'zhipu',
    name: '智谱 GLM-4V',
    type: PROVIDER_TYPES.OPENAI_COMPATIBLE,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4v-plus',
    supportsVision: true,
    supportsJsonMode: false,
    builtin: true,
  },
  {
    id: 'qwen',
    name: '阿里通义千问 Qwen-VL',
    type: PROVIDER_TYPES.OPENAI_COMPATIBLE,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-max',
    supportsVision: true,
    supportsJsonMode: false,
    builtin: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    type: PROVIDER_TYPES.OPENAI_COMPATIBLE,
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4',
    supportsVision: true,
    supportsJsonMode: true,
    builtin: true,
  },
  {
    id: 'google-gemini',
    name: 'Google Gemini',
    type: PROVIDER_TYPES.GEMINI,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.0-flash',
    supportsVision: true,
    supportsJsonMode: false,
    builtin: true,
  },
];

// Heuristic to guess vision support from model name
export function guessVisionSupport(model) {
  if (!model) return false;
  return /vision|vl|gemini|claude|gpt-5|gpt-4|gpt-4o|sonnet|opus|haiku|llava|qwen|cogvlm|glm-4v|pixtral|llama.*vision/i.test(model);
}
