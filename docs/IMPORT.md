# 文件导入配置/密钥（0.6.1）

在笔上逐字输入 API key 很麻烦，0.6.1 提供文件导入。

## 最快用法（ADB）

```sh
# 1) 在电脑上准备 /tmp/penagent-config.json（见下面格式）
adb push penagent-config.json /tmp/penagent-config.json

# 2) 打开笔上的“设置”页，点顶部“从文件导入配置/密钥”
#    或在“能力探针”页点“导入配置”
```

若 `/tmp` 不可读，可放到应用私有工作区：

```sh
adb push penagent-config.json \
  /userdisk/secondary/miniapp/data/mini_app/pkg/8002026100700001/data/penagent-workspace/import/config.json
```

设置页在**地址和密钥都为空**时会自动尝试导入一次；顶部按钮可随时手动重试。

## 支持的格式

### 1. Claude Code / DeepSeek Harness settings（推荐）

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.yunqing.asia",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_MODEL": "deepseek-v4.1-flash"
  }
}
```

导入后自动设为 `apiFormat=anthropic`，地址/密钥/模型填入设置并保存。

### 2. penagent 设置 JSON

```json
{
  "baseUrl": "https://api.example.com/v1",
  "apiKey": "sk-...",
  "model": "deepseek-v4.1-flash",
  "apiFormat": "openai",
  "maxTokens": 8192,
  "systemPrompt": "回答简洁，不要使用 Markdown。"
}
```

也接受应用导出的 `{"pa.settings":{"version":1,"data":{...}}}` 包装。

### 3. key=value 文本

```text
baseUrl=https://api.yunqing.asia
apiKey=sk-...
model=deepseek-v4.1-flash
apiFormat=anthropic
```

只放一行 `sk-...` 也可以，只导入密钥；其余字段保留当前设置。

## 限制与安全

- 文件最多 64 KiB；只读固定候选路径，页面/模型不能指定任意路径。
- 导入后 key 以本机明文保存（用户要求自动保存）；导入文件不会被应用删除，**请自行删除** `/tmp/penagent-config.json` 或工作区 `import/config.json`。
- 不在日志、截图、证据或提交中记录 key。
- 业务限额：应用不再设置模型请求/工具/批量/总时长配额（与 DeepSeek Harness 对齐，配额由服务端控制）；仅保留单次请求 60s、单工具 600s、请求/响应/存储字节上限等物理安全边界。
