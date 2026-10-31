# 0.6.0 验证状态（可用预览）

更新：2026-10-31。**0.6.0 增加 API key 自动持久化、业务限额取消、系统提示词注入、
思考/工具折叠、轻量 Markdown 纯文本化、插件规范与热加载；真实 Anthropic endpoint 仍通过。**

## 最终结果

| 检查 | 结果 / 证据 |
|---|---|
| JS 全量 | legacy **5/5** + Node **141/141**，0 fail；`docs/evidence/js-tests-0.6.0.txt` |
| Python 策略 | **22/22**；`docs/evidence/ci-policy-tests-0.6.0.txt` |
| 编译/AMR | 0.6.0 debug **646182 B / SHA `a9990ca0…eadfd`**；production **633053 B / SHA `817a4956…9f000`**；`verify-amr.py --native-sha256` 通过，含唯一 native `.so` SHA `970b6a33…` |
| 真机安装 | 0.6.0 debug，uninstall/install/start ret:0 |
| 真实 endpoint | probe 真实对话：`完成 · 工具 1 · 5598 ms`，时钟工具结果被正确用于回答；截图 `app/artifacts/0.6.0/probe-real-chat.png` |
| 插件热加载 | 工作区 `plugins/weekday.json` 被工具页加载，出现 `weekday_cn`（origin plugin）；单元测试覆盖 reload/坏插件隔离；截图 `app/artifacts/0.6.0/tools-plugins.png` |
| 设置/设备状态 | 测试后恢复空白生产设置，移除临时 key 与插件/工作区测试文件 |

## 0.6.0 功能

- **API key 自动保存**：任何设置保存都会持久化当前 key；输入密钥后自动保存；只有“清除密钥”删除。`persistApiKey` 旧字段保留但不再能导致丢 key。
- **取消业务限额**：旧 6 次模型 / 24 次工具 / 8 个批量 / 240s 停止阈值已移除；保留单次请求 60s、单次工具 600s、响应/请求/存储字节上限，用于防止设备挂死和存储爆掉。
- **系统提示词注入**：设置页“系统提示词”，每轮作为 system 消息发送；插件 prompt 追加；不写入显示历史。
- **折叠**：assistant 的 `reasoning`（Anthropic thinking / OpenAI reasoning_content）在消息卡显示为“思考过程”，工具调用显示为“工具调用 n 个”，默认折叠；工具卡片结果默认折叠，点击展开。reasoning 仅显示，不回传给模型。
- **轻量 Markdown**：`utils/plain-text.js` 去除标题/粗体/代码围栏/链接语法（保留内容/URL），聊天与工具结果显示纯文本。
- **插件规范**：`penagent-plugin/1`，声明式 recipe 工具 + 提示词；工作区 `plugins/*.json`，工具页重新加载即热载，不重装 AMR。见 [PLUGINS](PLUGINS.md)。

## 验证边界

- 折叠 UI 的**真机视觉**未完成：手工 seed 的聊天会话在设备 UI 未加载（文本/单元测试覆盖 reasoning 保留与折叠标记；实际聊天滚动测试仍待做）。
- 插件热重载的真机按钮点击未截图；工具页已展示插件工具，reload/错误隔离由单元测试覆盖。
- 真实 endpoint 只验证一个账户/模型；流式、长对话限流、Falcon 线程/取消、IME/内存/多分辨率仍未验证。
- 插件不能执行代码；任意 JS/native 插件仍需走单独的安全与 CI 审计。
- `native-manual.yml` + `ci-policy.json` 仍 disabled；正式发布链路仍需获批 vendor bundle。

## 证据

- `docs/evidence/js-tests-0.6.0.txt` / `ci-policy-tests-0.6.0.txt`
- `docs/evidence/build-debug-0.6.0.txt` / `build-production-0.6.0.txt`
- `docs/evidence/amr-debug-0.6.0.json` / `amr-production-0.6.0.json`
- `docs/evidence/native-device-0.6.0.txt`
- `app/artifacts/0.6.0/`（AMR、真实对话、工具/插件截图）
- `docs/evidence/source-sha256-0.6.0.json`
