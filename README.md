# ST Cache Helper

SillyTavern 本地第三方扩展，用于改善 `提示词后处理 = 严格 / Strict` 时 Claude / NewAPI 链路的 prompt cache 命中问题。

## 作用

SillyTavern 的 `Strict` 后处理会把多段 system 合并，并可能插入 `[Start a new chat]` 占位消息。对于 Claude prompt cache，这会让稳定前缀变动，导致缓存反复写入但无法读取。

本扩展在浏览器前端拦截发往：

```text
/api/backends/chat-completions/generate
```

的请求，并默认把：

```text
strict       -> merge
strict_tools -> merge_tools
```

从而尽量保留更稳定的前缀结构，提高缓存命中率。

## 安装方法

### 方法 1：放到当前用户扩展目录

进入 SillyTavern 目录：

```bash
cd /path/to/SillyTavern
```

创建本地扩展目录：

```bash
mkdir -p data/default-user/extensions
```

把本仓库克隆进去：

```bash
git clone https://github.com/haveagoodday1205-png/st-cache-helper.git \
  data/default-user/extensions/st-cache-helper
```

然后重启 SillyTavern，刷新浏览器页面。

### 方法 2：手动复制

把整个 `st-cache-helper` 文件夹复制到：

```text
SillyTavern/data/default-user/extensions/st-cache-helper
```

目录结构应为：

```text
st-cache-helper/
├─ manifest.json
├─ index.js
├─ style.css
└─ README.md
```

然后重启 SillyTavern，刷新页面。

## 使用方法

进入 SillyTavern 后，在扩展列表中应看到：

```text
ST Cache Helper
```

默认配置：

```text
启用请求修复：开
策略：Strict → Merge
仅作用于自定义 OpenAI 源：开
控制台调试日志：开
```

推荐保持默认：

```text
Strict → Merge
```

如果想更接近 Strict 行为，可以试：

```text
Strict → Semi
```

## 验证是否加载

浏览器控制台应出现：

```text
[ST Cache Helper] loaded
```

发送请求时，如果发生改写，会出现：

```text
[ST Cache Helper] post-processing rewritten
```

## 注意

- 不修改 NewAPI。
- 不修改 SillyTavern 后端源码。
- 只在前端发送请求前改写请求体。
- 默认只作用于 `自定义 OpenAI / custom` 来源。
