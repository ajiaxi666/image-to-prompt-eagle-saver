---
name: image-prompt-reverse
description: 反推图片生成提示词的工程方法论。用于设计、调优和评估多模态模型的图片→提示词（image-to-prompt）分析模板。
---

# 图片反推提示词工程（Image Prompt Reverse）

## 何时使用

- 设计一个新的图片反推 prompt 模板（如适配 Flux、SDXL、DALL-E 3、NovelAI）
- 调优现有模板的输出质量（提示词太泛、信息密度不够、JSON 格式不稳定）
- 评估不同 VLM（Claude、GPT-4V、Gemini、GLM-4V、Qwen-VL）在反推任务上的表现差异
- 设计素材管理场景下的自动打标/描述系统

## 核心方法论

### 1. 输出目标决定模板结构

不同下游用途需要不同的提示词风格：

| 下游模型 | 提示词风格 | 示例 |
|---------|----------|------|
| Stable Diffusion / MJ / NAI | 逗号分隔标签 + 权重 | `masterpiece, 1girl, (detailed eyes:1.2), golden hour` |
| Flux / DALL-E 3 / Ideogram | 自然语言段落 | `A young woman stands in golden hour light, her face half-turned...` |
| 素材检索 | 关键词标签 | `photography, portrait, natural-light, warm-tone` |
| 设计参考 | 结构化拆解 | 颜色 / 字体 / 布局 / 风格方向 |

**设计原则：先定下游，再写模板。** 模板的字段定义、语言密度、专业术语都应该服务于下游的重新生成或检索。

### 2. 图片的可描述维度

一张图片可以拆解为 10 个维度，优秀的反推模板应该覆盖其中至少 6 个：

1. **主体**（subject）— 人物、物体、场景的核心
2. **动作与姿态**（action / pose）— 动态、静态、构图关系
3. **外观细节**（appearance）— 服装、表情、材质、纹理
4. **环境背景**（environment）— 室内/室外、时间、天气
5. **光照**（lighting）— 方向、硬度、色温、特殊光源（rim light、god ray）
6. **构图**（composition）— 三分法、对称、引导线、留白
7. **镜头语言**（camera）— 焦段、景深、视角、畸变
8. **色彩**（color）— 主色、补色、饱和度、色调偏移
9. **风格与媒介**（style / medium）— 摄影、插画、3D、水彩、赛博朋克
10. **氛围与情绪**（mood）— 宁静、紧张、神秘、怀旧

缺失维度是最常见的提示词缺陷来源。SD 标签式模板应按维度分组排列（quality → subject → environment → lighting → camera → style），让标签在 token 层面形成清晰的语义段落。

### 3. 强制 JSON 输出的 3 个技巧

VLM 常常在 JSON 外附加说明文字，破坏解析。

- **明确禁止语**：`Return ONLY the JSON object, no markdown, no explanation.`
- **示范字段值**：给出具体而非抽象的值示例（`"8-12 english tags covering style, medium, mood"` 比 `"tags array"` 更稳定）
- **对 OpenAI 兼容 API 启用 `response_format: { type: "json_object" }`**，Claude 则依赖 prompt 约束

始终在程序侧加**双保险**：先 `JSON.parse` 原文，失败再用正则 `/\{[\s\S]*\}/` 提取第一个 JSON 对象，再失败则抛错。

### 4. 中英双语策略

素材管理场景下中英双语是刚需：英文提示词供 AI 生成，中文标签供检索。

- **不要让 VLM 翻译**：要求它直接基于图片生成两套独立文本，避免"英翻中"式的僵硬表达
- **中文标签优先选可检索的名词**：`"油画质感"` > `"有油画的感觉"`
- **描述字段控制在 20-30 字**：用于文件名和卡片标题

### 5. 模型差异与选型

| 模型 | 反推优势 | 短板 |
|------|---------|------|
| Claude Sonnet 4.6 | 视觉细节密度高，长文本组织能力强，JSON 稳定 | 成本较高 |
| GPT-4o | 通用、速度快、多语言 | 细节有时不够专业 |
| Gemini 2.5 Pro | 价格低，长图/多图优势 | 中文风格描述略弱 |
| GLM-4V / Qwen-VL | 中文场景本地化好，价格低 | 西方艺术史术语覆盖弱 |

**选型建议**：素材管理用 GLM-4V / Qwen-VL 性价比最高；设计参考分析用 Claude；多语种生态内容用 GPT-4o。

## 模板骨架

```text
You are an expert [ROLE specific to downstream use].
Analyze this image and produce [OUTPUT specification].

Return ONLY a JSON object (no markdown fences, no explanation) with these exact fields:
{
  "prompt_en": "[detailed specification of style, length, structure, token order]",
  "prompt_zh": "[same information density in Chinese, not translated]",
  "tags": ["[count constraint] english descriptors covering [dimensions]"],
  "tags_zh": ["[count constraint] 中文检索标签"],
  "style": "one of: photography | illustration | anime | 3d | painting | sketch | pixel-art | ui-design | other",
  "description": "[length constraint] 中文摘要"
}
```

## 评估方法

评估一个反推模板的质量，用 3 个指标：

1. **回生成相似度** — 用反推得到的 prompt_en 喂回 SD/Flux，生成图与原图的 CLIP similarity
2. **字段完整率** — 批量跑 100 张图，统计 JSON 解析成功率和字段非空率
3. **人工标签相关性** — 抽样检查 tags 是否真的描述了图片而非泛泛而谈

目标：相似度 > 0.75，完整率 > 95%，标签相关性 > 0.85。

## 反模式

- **让模型"自由发挥"** — 不给字段定义和长度约束，输出会退化成无结构段落
- **一个模板打天下** — SD 标签式提示词喂给 Flux 会退化，反之亦然
- **忽略 token 顺序** — SD/MJ 对标签顺序敏感，前 75 token 权重最高，必须按重要性排列
- **中文提示词用英文术语硬凑** — `"1girl, 站立, solo"` 不如 `"独立女性人像，站立姿势"` 或干脆保持全英文
- **描述包含主观评价** — `"美丽的夕阳"` 对生成无帮助，应该写客观特征：`"暖金色低角度侧光，天空渐变粉橙到深紫"`

## 参考模板

本扩展内置 4 个工程化模板，位于 `prompt-templates.js`：

- `sd-midjourney` — SD/MJ/NAI 标签式
- `flux-natural` — Flux/DALL-E 自然语言
- `concise-zh` — 素材管理中文优先
- `design-ui` — UI/设计稿维度拆解

用户可在设置页面复制任一内置模板作为起点，或从空白新建。
