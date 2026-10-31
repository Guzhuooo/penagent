# 0.5.0 验证状态（可用预览）

更新：2026-10-31。**0.5.0 增加 Anthropic Messages 支持，并在 Y02 真机用真实 endpoint
（`https://api.yunqing.asia` / `deepseek-v4.1-flash`）完成“模型调用 clock 工具 → 返回 UTC 时间”
的完整闭环。** native transport、TLS 校验、openai 兼容路径、工作区文件工具均保留。

## 最终结果

| 检查 | 结果 / 证据 |
|---|---|
| JS 全量 | legacy **5/5** + Node **136/136**，0 fail；`docs/evidence/js-tests-0.5.0.txt` |
| Python 策略 | **22/22**；`docs/evidence/ci-policy-tests-0.5.0.txt` |
| CI native-compile | run [41183485514](https://github.com/Guzhuooo/penagent/actions/runs/41183485514) @ `1e4d12a` 绿：JS **136/136**、策略 22/22、宿主 CTest 1/1、AArch64 smoke |
| AMR 构建/校验 | 0.5.0 debug **641126 B / SHA `584124ce…af6a`**，production **628708 B / SHA `f0aa5896…493b`**；均含 `libs/libjsapi_httpx.so`（SHA `970b6a33…`），`verify-amr.py --native-sha256` 通过 |
| 真机安装 | 0.5.0 debug，uninstall/install/start ret:0 |
| 真机真实对话 | probe → 真实对话：`完成 · 工具 1 · 当前 UTC 时间是 2026-10-31 08:04:53。 · 10647 ms`；Anthropic Messages + x-api-key + tool_use/tool_result 全链路成功 |
| TLS 拒绝 | 过期证书仍为 `TLS_ERROR`；原生 HTTPS POST 200 证据保留在 0.4.0/0.5.0 探针 |
| UI 高度 | 154 条尺寸声明全部 vh/vw，严格门禁保留 |

## API 格式（0.5.0 新增）

- 设置页新增“接口格式”：`OpenAI`（默认）或 `Anthropic`。Anthropic 模式：
  - 地址填根地址或 `/v1`，请求发往 `/v1/messages`；
  - headers `x-api-key` + `anthropic-version: 2023-06-01`；
  - 工具调用转换为 `tool_use` blocks，工具结果转换为 `tool_result` blocks；
  - `thinking`/`redacted_thinking` 块丢弃；文本/工具调用映射回内部 OpenAI 形状；
  - `max_tokens`、温度上限 1、60s 请求超时、240s 单次运行预算。
- 该 endpoint 的 `/v1/chat/completions` 为 404；`/v1/models` 返回 deepseek-v4-flash/pro、
  deepseek-v4.1-flash，因此必须使用 Anthropic 格式。OpenAI 兼容服务仍走原路径。
- 真实测试期间 provider 曾短暂返回 429/503（与 app 无关）；冷却后完整闭环成功。非 2xx
  映射为 `HTTP_ERROR`，不会伪造成功。

## Native transport（沿用 0.4.0）

`app/src/services/net/native.js` 动态 `import('httpx')`；TLS peer/hostname、禁 redirect、真实
status、timeout、cancelAll；模块缺失时 production fail closed；`allowInsecureHttp` 仅显式开发
私网。`.so` 由 Actions run 41180136061/41181149672 构建，SHA `970b6a33…`，已打进 0.5.0 AMR。

## 仍未完成 / 阻塞

- 其它 OpenAI/Anthropic-compatible 服务的协议差异、流式输出、多 provider 错误语义；
- Falcon 线程/取消全链路、真实 endpoint 长对话/限流/2 MiB 上限压力；
- IME 取消/重复、两次进出内存、`memoryUsageGC`、多分辨率；
- `native-manual.yml` + `ci-policy.json` 正式发布链路仍 disabled；
- 干净机器依赖锁定重建；孤立 session chunk 清理；历史防火墙规则管理员清理。

## 证据

- `docs/evidence/js-tests-0.5.0.txt` / `ci-policy-tests-0.5.0.txt`
- `docs/evidence/build-debug-0.5.0.txt` / `build-production-0.5.0.txt`
- `docs/evidence/amr-debug-0.5.0.json` / `amr-production-0.5.0.json`
- `docs/evidence/real-anthropic-0.5.0.txt`（真实 endpoint，无 key）
- `app/artifacts/0.5.0/probe-real-chat.png`
- `docs/evidence/ci-native-0.3.0/`、`native/README.md`
- `docs/evidence/source-sha256-0.5.0.json`

真实 key 仅用于本次临时测试，未写入仓库/证据/日志，测试后设备设置已恢复空白。
