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
- 给请求加可选调试头：`X-ST-Cache-Helper: stable-prefix-cache-v1`。

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

## 注意

- 这是前端请求级修复。
- 不修改 NewAPI。
- 不修改 SillyTavern 后端源码。
- 不能保证所有动态预设 100% 命中缓存；如果预设每轮把时间、随机数、summary、动态世界书放到前缀，仍可能降低缓存命中。
