# ST Cache Helper

SillyTavern 第三方前端扩展，用于改善 Claude / NewAPI 链路的 prompt cache 命中问题。

## 核心功能

本扩展会在浏览器前端拦截 SillyTavern 发往：

```text
/api/backends/chat-completions/generate
```

的请求，并在不修改 SillyTavern 后端源码、不修改 NewAPI 的情况下做缓存友好化处理。

当前默认策略为：

```text
稳定前缀缓存修复 stable_prefix_cache
```

它会：

- 把稳定的 `system` 提示词固定到请求最前面；
- 把 ST 中后段静态提示词提前为稳定前缀，避免随聊天轮次滑动；
- 自动识别并补回“预设里显示存在、但实际没进请求体”的自定义 `system_prompt: true` 提示词；
- 避免 Strict 后处理重新移动提示词；
- 可选使用 Claude Code 同款原生请求形态，为自定义 OpenAI 的 Claude 模型写入 `1h` 缓存；
- 给请求加可选调试头：`X-ST-Cache-Helper: stable-prefix-cache-v4`。

## 为什么需要它

SillyTavern 的某些 OpenAI/Claude 预设组合下，常见问题是：

- `Strict` 后处理会移动或改写 system 块；
- depth 注入块可能随对话轮次滑动；
- 某些导入预设的自定义 `system_prompt: true` 模块会显示在 Prompt Manager 里，但不会进入最终请求体；
- 静态 assistant/user 提示词可能混在聊天历史后面，导致 Claude prompt cache 只写不读。

本扩展的目标是让角色卡、世界书、长预设、样例等稳定前缀尽量保持一致，从而提高后续请求的 `cache_tokens`。

## 安装方法

进入 SillyTavern 目录：

```bash
cd /path/to/SillyTavern
mkdir -p data/default-user/extensions
git clone https://github.com/haveagoodday1205-png/st-cache-helper.git \
  data/default-user/extensions/st-cache-helper
```

然后重启 SillyTavern，刷新浏览器页面。

目录结构应为：

```text
st-cache-helper/
├─ manifest.json
├─ index.js
├─ style.css
└─ README.md
```

## 默认设置

```text
启用请求修复：开
策略：稳定前缀缓存修复
仅作用于自定义 OpenAI 源：开
控制台调试日志：开
给请求加调试头：开
自动补回丢失的自定义 system 提示词：开
Claude 原生 1 小时缓存（Claude Code 方式）：关
```

## 验证是否生效

浏览器控制台应出现：

```text
[ST Cache Helper] loaded
```

发送请求时，如果发生优化，会出现类似：

```text
[ST Cache Helper] optimized request
```

理想状态下，配合 NewAPI 日志应看到第二轮开始：

```text
cache_tokens 很高
cache_creation_tokens 很低
```

启用“Claude 原生 1 小时缓存”后，首次写入还应在接口 usage / NewAPI 日志中看到：

```text
cache_creation.ephemeral_1h_input_tokens > 0
```

后续相同稳定前缀应出现 `cache_read_input_tokens > 0`。

## 注意

- 这是前端请求级修复。
- 不修改 NewAPI。
- 不修改 SillyTavern 后端源码。
- 不能保证所有动态预设 100% 命中缓存；如果预设每轮把时间、随机数、summary、动态世界书放到前缀，仍可能降低缓存命中。


## 0.6.0

- 新增“保守提升稳定世界书/深度注入块”：把明显是长期设定、Lorebook、Memory、World Info 的中段 user/assistant 注入块提升到 system 缓存前缀。
- 动态状态栏/本轮/最新/当前状态类内容默认不提升，避免破坏剧情与缓存前缀。

## 0.7.0

- 新增“中段动态 system 不提前”：如果世界书/深度注入以 system 角色出现在聊天中段，且内容像“当前状态/本轮/上一轮/最新”等动态状态栏，会转成普通上下文留在原位置，不再被强制提升到缓存前缀。
- 新增稳定前缀 system 去重：同一请求里重复出现的 system 块只保留第一份，减少无意义 token 并提高前缀稳定性。
- 调试头升级为 `X-ST-Cache-Helper: stable-prefix-cache-v4`。

## 0.8.0

- 新增稳定前缀规范化：对提升到缓存前缀的 system/preset/lore 文本统一 CRLF/LF、尾随空格和过多空行，减少同一提示词因换行差异导致的缓存断点。
- 新增稳定世界书顺序记忆：稳定 depth/lore 块按首次出现顺序记忆；后续新增世界书尽量追加到已知世界书后面，避免新条目插到前面导致整段前缀失效。
- 调试头升级为 `X-ST-Cache-Helper: stable-prefix-cache-v4`。

## 0.8.1

- 修正稳定世界书顺序记忆范围：开头主预设/角色卡 system 不再参与 depth/lore 顺序记忆，避免长期跨角色排序影响角色卡原始顺序；只有聊天中段/深度插入的稳定 system 和 user/assistant lore 会参与。

## 0.9.0

- 新增可选的 Claude 1 小时缓存请求：仅处理自定义 OpenAI 且模型名包含 `claude` 的请求。
- 在稳定 system 前缀最后一个文本块注入 `cache_control: { type: "ephemeral", ttl: "1h" }`。
- 自动合并 `prompt-caching-2024-07-31` 与 `extended-cache-ttl-2025-04-11` beta header。
- 该选项默认关闭；是否产生 `ephemeral_1h_input_tokens` 由上游代理的协议转换和实际 Claude 渠道决定。

## 0.10.0

- 按 Claude Code `ENABLE_PROMPT_CACHING_1H=1` 的真实请求形态重做一小时缓存：使用 `prompt-caching-scope-2026-01-05` 与 `extended-cache-ttl-2025-04-11`。
- 自定义 OpenAI 请求会通过同一网关的原生 `/v1/messages` 路径发送，绕过 NewAPI 在 OpenAI → Claude 转换时丢弃 `ttl` 的问题；密钥仍由 SillyTavern 后端读取，不进入浏览器设置。
- 在稳定 system 前缀末尾放置两个 `cache_control: { type: "ephemeral", ttl: "1h" }` 断点，并按 Claude Code 的请求形态给最后一条 user 内容增加第三个 1h 断点；单个大 system 块会在稳定边界拆成两个内容块。
- 新增 Anthropic 原生响应转换：同时支持普通 JSON、SSE 文本流、thinking 和 tool use，酒馆前端仍按原 OpenAI-compatible 格式消费。
- 图片、JSON Schema、Claude 4.6+ assistant prefill 等不适合原生隧道的请求会自动退回兼容注入模式。

## 0.10.1

- 补齐 Claude Code 的消息级缓存断点：除两个稳定 system 断点外，最后一条 user 内容也会标记 `ttl=1h`。
- 修复部分 Claude Haiku / Claude Code 专用网关忽略仅有 system 断点、导致完全不写缓存的问题。
