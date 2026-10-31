# 0.6.1 验证状态（可用预览）

更新：2026-10-31。**0.6.1 增加配置文件导入，避免在笔上逐字输入 key；导入 Claude/DeepSeek
harness 的 env JSON 后自动得到 Anthropic 地址/密钥/模型。业务限额按 DeepSeek Harness 方式
放开（应用不设模型/工具/批量/总时长配额，服务端为配额权威），只保留设备物理安全边界。**

## 最终结果

| 检查 | 结果 / 证据 |
|---|---|
| JS 全量 | legacy **5/5** + Node **144/144**，0 fail；`docs/evidence/js-tests-0.6.1.txt`；公开仓库 CI run [41196561891](https://github.com/Guzhuooo/penagent/actions/runs/41196561891) 绿 |
| Python 策略 | **22/22** |
| AMR | debug **650420 B / SHA `2b496550…d866a`**；production **636776 B / SHA `a021319e…392775`**；`verify-amr.py --native-sha256` 通过 |
| 真机导入 | 把 harness env JSON 放到工作区 `import/config.json`，probe“导入配置”显示 `已导入并保存 · workspace/import/config.json · baseUrl, apiKey, model, apiFormat`；设置读回 baseUrl/model/apiFormat 正确，key 已保存 |
| 真实 endpoint | 0.6.0 已验证 Anthropic 对话+clock 闭环；0.6.1 导入的是同一配置格式，导入后的设置读回已确认（本轮未重复完整对话） |
| 设备状态 | 测试后恢复空白设置，删除导入文件/key |

## 文件导入（0.6.1）

- 路径：`/tmp/penagent-config.json`（或 `.txt`）或应用工作区 `import/config.json`；设置页顶部按钮、probe“导入配置”；地址和密钥都为空时设置页自动尝试一次。
- 格式：Claude Code / DeepSeek Harness `{"env":{ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN,ANTHROPIC_MODEL}}`、penagent 设置 JSON、`{"pa.settings":...}` 包装、`key=value` 文本或裸 key。
- 详见 [IMPORT](IMPORT.md)。导入文件 ≤64 KiB；固定候选路径；不使用模型/页面提供的任意路径。
- key 导入后明文保存在本机（产品要求），导入文件需用户自行删除。

## 限额

- 不再有 6 次模型 / 24 次工具 / 8 个批量 / 240s 业务阈值；1e6 等值只是防爆护栏，不是用户配额。
- 保留单次请求 60s、单工具 600s、请求/响应 2 MiB、上下文/结果/存储字节上限；这些是设备稳定性边界，不是 API 配额。
- DeepSeek Harness/服务端仍可自行限流（429）；应用把非 2xx 报为 HTTP_ERROR。

## 未完成 / 边界

- 设置页顶部导入按钮在真机触控测试中未命中（probe 导入路径已验证；按钮存在但需修正触控/滚动命中）；自动导入在“地址+密钥为空”时执行。
- 真实 endpoint 本轮未重复完整对话；0.5/0.6 的 Anthropic clock 闭环仍是最近一次真实网络证据。
- 折叠 UI 真机视觉、插件 reload 点击、Falcon 线程/取消、IME/内存/多分辨率仍未验证。
- `native-manual.yml` + `ci-policy.json` 仍 disabled；正式发布仍需获批 vendor bundle。

## 证据

- `docs/evidence/js-tests-0.6.1.txt` / `ci-policy-tests-0.6.1.txt`
- `docs/evidence/build-debug-0.6.1.txt` / `build-production-0.6.1.txt`
- `docs/evidence/amr-debug-0.6.1.json` / `amr-production-0.6.1.json`
- `docs/evidence/native-device-0.6.1.txt`
- `app/artifacts/0.6.1/`（AMR、导入结果截图）
- `docs/evidence/source-sha256-0.6.1.json`
