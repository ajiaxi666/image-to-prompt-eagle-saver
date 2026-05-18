# Eagle 图片提示词助手

Chrome 扩展：浏览网页时右键任意图片 → AI 反推为专业提示词 → 自动保存到 Eagle 素材库。

## 功能

- **多 AI 提供商**：内置 Claude、OpenAI、智谱 GLM-4V、阿里 Qwen-VL、OpenRouter，支持添加任意 OpenAI 兼容端点（本地 vLLM、OneAPI、LM Studio 等）
- **可编辑提示词模板**：内置 4 个工程化模板（SD/Midjourney 标签式、Flux/DALL-E 自然语言、简洁中文、UI 设计拆解），用户可复制修改或从空白新建
- **Eagle 集成**：一键入库 Eagle（图片 + 标签 + 提示词 annotation），自动附加中英文标签和风格分类
- **结构化 JSON 输出**：每个模板约束 AI 返回 `prompt_en` / `prompt_zh` / `tags` / `tags_zh` / `style` / `description` 字段

## 安装

1. 下载此目录
2. 打开 `chrome://extensions` → 打开开发者模式 → 加载已解压的扩展 → 选择 `eagle-prompt-saver/`
3. 点击扩展图标 → 设置，填入：
   - **AI 提供商 API Key**（必需）
   - **Eagle**：确保本地 Eagle 应用运行中（默认端口 41595）

## API Key 获取

| 提供商 | 获取地址 | 推荐模型 |
|-------|---------|---------|
| Claude | https://console.anthropic.com/settings/keys | `claude-sonnet-4-6` |
| OpenAI | https://platform.openai.com/api-keys | `gpt-4o` |
| 智谱 | https://open.bigmodel.cn/usercenter/apikeys | `glm-4v-plus` |
| 阿里通义 | https://dashscope.console.aliyun.com | `qwen-vl-max` |
| OpenRouter | https://openrouter.ai/keys | `anthropic/claude-sonnet-4` |

## 使用

1. 浏览任意网页，右键图片
2. 选择 "保存到 Eagle（生成提示词）"
3. 弹出"分析中…"通知 → 分析完成后自动入库

## 提示词模板

打开设置页 → 提示词模板区域：
- 切换 **当前模板** 下拉框选择模板
- 内置模板只读，点 **保存模板** 会自动复制为自定义模板
- 自定义模板可直接编辑/删除
- 模板必须要求 AI 返回 JSON，字段至少包含 `prompt_en` 和 `description`

关于模板设计方法，见 [skills/image-prompt-reverse.md](skills/image-prompt-reverse.md)。

## 文件结构

```
eagle-prompt-saver/
├── manifest.json              # MV3 清单
├── background.js              # Service Worker（核心逻辑）
├── content.js                 # 内容脚本（图片信息捕获）
├── providers.js               # AI 提供商抽象
├── prompt-templates.js        # 提示词模板 CRUD
├── options/                   # 设置页
├── popup/                     # 弹出窗口
├── skills/
│   └── image-prompt-reverse.md # 反推工程方法论
├── _locales/zh_CN/
└── icons/
```

## 技术要点

- Chrome MV3，Service Worker + ES Modules（`type: "module"`）
- 敏感密钥存 `chrome.storage.local`，非敏感配置存 `chrome.storage.sync`
- 自定义 provider 的域名通过 `optional_host_permissions` 运行时动态申请

## 隐私

- API Key 仅存本地，不同步到云端
- 图片 URL 仅发送给你配置的 AI 提供商
- 扩展不收集任何遥测数据
