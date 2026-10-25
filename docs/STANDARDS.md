# penagent · 项目强制标准

> 适用：`D:\penagent` 的轻量 LLM agent harness；目标首台设备 Y02-3562 / 固件 4.9.7。
> 技术路线：aiot-vue-cli、Vue 2 SFC、Falcon / QuickJS；可选 native 网络适配器。
> 「必须 / 禁止」是审查和验收门槛；现有代码不自动视为符合本标准。

## 0. 决策、事实与证据

- 用户已批准的范围与约束优先。设备事实来自根目录 `DEVICE_PROFILE.md`、`DEVICE_PROBING.md` 及可追溯原始证据；工程约束由本文件规定；实施顺序见 `PLAN.md`。
- 每项能力标记为 **已验证**（本项目、指定 profile 的可重复实测）、**静态确认不合格**（已识别实现的控制流明确违反门槛）、**继承线索**（其他应用、符号表、旧文档或移植实现）、**待验证**（未测、证据冲突或探针无效）。记录 profile、固件、版本 / SHA、方法、预期、观察与证据位置；静态不合格不能模糊成仅未测，也不能冒称已做动态证书测试。静态符号存在不等于第三方 JS 可调用；其他应用能加载库不等于本项目库能加载。
- 证据冲突时先记录更正和待验证范围，再实现依赖该能力的代码。不能按文档优先级把缺陷探针升级为事实，也不能把新规范表述为现有实现已通过。
- 正确 JSON POST 真机送达仍待验；旧 wrapper 只转发 body、旧嵌套 `{}` 为 Promise，使 GET-only 推断无效。**但 flat http.request 生产安全已静态确认不合格**：TLS peer/host 校验关闭、自动 redirect、连接 10s / 总计 100s、无 caller TLS/redirect/timeout/signal、成功不回传 HTTP status，未发现该路径 abort。生产须 native 或其他独立验证安全 adapter，不是因 POST 不支持才需 native。证据绑定 libfalcon.so SHA-256 `91e23dcef405d849e17757656cd2603ecc21cc9d20437bf38937c6b13b664a58`；ADB 断开，本轮未重 hash 或做证书测试。地址与合同见 `tools/post-contract-notes.md`；旧敏感日志 helper 已移除，禁止照搬。旧勾选 / 已改写页面不构成 M0 验收，详见 PLAN §4 / SPIKE §3。
- `profiles/y02-4.9.7.env` 仅保存设备校准 / 能力线索和 index 入口；发布 appid/version 来自 `app/package.json`，不得重新混入抖音身份、feed、DOUYIN_* 或业务 endpoint。remote 默认按该 package 取 appid。设备 serial、IP 和日志路径不得复制进通用业务代码或公开产物。

## 1. 全部几何使用 vw / vh

### 1.1 可检查的单位规则

所有 UI 长度必须输出为 `vw` / `vh`，包括组件 style、公共 LESS、内联 / 动态 style、图片尺寸、宽高及 min/max、位置、间距、边框、圆角、字号、行高、字距和动画位移。禁止 `px/rpx/wx/pt/em/rem/dp/sp/%` 长度、裸数字长度以及把像素字符串藏在 JS / props 中。零可写无单位 `0`；flex、opacity、z-index、行数等无量纲值及时间 `ms/s` 不属于长度。`auto` 仅用于已验证的固有布局，不用于替代显式 scroller 尺寸。

- 统一从 `app/src/styles/viewport.less` 导出相对设计 token；颜色 / 字体族归 `var.less`，公共导入归 `base.less`。组件不得自行定义像素换算基准。
- token 直接以视口比例定义；禁止通用 token 中的 `100vw / 936`、`@px1` 或固定设计宽高。设备逻辑宽高只存入对应 profile，传给 viewport API；新 profile 必须有自己的证据。
- 无 px 降级开关。新固件若不支持 vw/vh，记为适配阻塞，不得生成像素布局后声称满足本约束。
- 运行时 / IME / 触控协议若要求数值坐标，由 device/input adapter 将相对 token 按 profile 转为该 API 要求的数值；这不是组件布局单位的例外，数值不得回流为像素 style。

建议的初始 token 合同（最终视觉效果仍须验收）：

```less
@u: 1vw;
@v: 1vh;
@font-xs: 7vh;
@font-sm: 8vh;
@font-md: 10vh;
@font-lg: 12vh;
@space-xs: 1.5vh;
@space-sm: 3vh;
@space-md: 5vh;
@radius-sm: 1.5vh;
@radius-md: 3vh;
@hairline: 0.1vh;
@stroke: 0.2vh;
@sidebar-w: 26vw;
@content-w: 74vw;
@touch-min: 18vh;
```

### 1.2 响应式与取证

- 首台 Y02 使用横向会话栏 + 对话区，26vw / 74vw 是初始骨架；全部尺寸来自相对 token。按钮触控热区两个轴均至少 18vh，不能只扩大文字。
- App 首帧前用所选 profile 的已验证逻辑宽调用 `setViewPort`，禁止通用代码写死 936。物理面板、逻辑视口和触控方向是不同字段。
- 两种以上逻辑分辨率 / 比例验证字号、换行、触控热区、scroller 和错误状态，不只拉伸截图。模拟 / mock 结果标为模拟证据；每个声明支持的真实 profile 都要独立真机验证。
- 936×280、vw/vh 单位语义的既有 Y02 证据不能证明多分辨率兼容。多分辨率验证当前待完成。
- 采集截图、读取 PNG 尺寸、capture ret:0 或页面挂载日志不等于视觉验收。未经具备视觉能力的查看者实际核验，不得声称比例正确、无裁切 / 重叠、可读性或布局通过；须记录视觉未验，触控结果另取交互证据。

## 2. 分层与依赖

保留 `app/src/services/` 作为平台 adapters 的落点，业务拆入 `app/src/core/`，工具定义拆入 `app/src/tools/`；这是目标结构，当前目录不代表迁移已经完成。

| 层 | 职责与允许依赖 | 禁止 |
|---|---|---|
| `pages/` | 页面状态、调用 core、props / events 组装 components | 直接 JSAPI、工具实现、HTTP 协议解析 |
| `components/` | 纯展示；显式 props、业务事件；computed 无副作用 | import core/services/tools，持有平台资源，`$parent` 取数据 |
| `core/` | 配置 / 会话 / OpenAI 归一化、上下文、有限循环；依赖注入 adapters 和工具 registry | Vue、页面引用、`$falcon`、平台模块或 shell |
| `tools/` | 工具 schema、参数验证、纯计算或注入的窄 adapter | 反向 import loop / pages；任意平台访问 |
| `services/` | net/storage/input/device/exec/log 平台 adapters；能力检测、错误归一化 | Vue、UI 更新、把原始平台结果交给页面 |
| `app.js / base-page.js / 页面类` | Falcon 生命周期注册及资源管理入口 | 混入业务循环和凭据持久化实现 |

业务依赖由启动 / service composition 入口注入；adapters 可共享纯校验与错误类型，不形成循环依赖。设备差异只进入 profiles 和 adapters。`tools/remote/`、mock server 和 native 构建脚本是开发工具，不作为 LLM 任意执行入口。

命名：文件 / 目录 kebab-case，组件 / 类 PascalCase，函数 camelCase，常量 UPPER_SNAKE_CASE，storage key `pa.*`，日志 tag `[pa:<module>]`。移植代码必须删除抖音认证、Referer、媒体重试与 appid 假设。

## 3. Vue 2 / QuickJS 与 UI

- 使用目标 Vue 2.6.12 / QuickJS 20200705 和已验证 Falcon CSS 子集；禁用浏览器 DOM、Node API、动态代码执行及未经验证的 Web API。宿主 Node 测试通过不等于 QuickJS 兼容。
- 文字放 `<text>`；图片明确 src 和 vw/vh 尺寸；scroller 明确 vw/vh 宽高及方向；flex-direction 显式声明。SFC 使用 scoped、单 class 选择器，状态 class 不改变控件几何。
- 页面名与 `app.json` / 页面脚本一致，所有页面类继承 BasePage；根 Vue 的 `onShow/onHide/onUnload` 使用当前实际支持的 method 钩子，不假定 `$page.on('show')`。
- 列表使用稳定业务 ID；分批渲染不丢弃持久化数据。模板只做展示，能力判断收口到 adapter。未经验证的 calc、media query、复杂选择器不得用于生产布局。
- 对话 / 工具卡必须覆盖 idle、loading、empty、error、cancelled、completed 和限额终止状态；发送中可停止，错误有明确动作。错误提示不直接展示原始服务端正文 / stack。

## 4. 生命周期、取消与输入法

- 所有 timer、订阅、网络任务、工具任务和 native 句柄必须有 owner 与幂等 stop/destroy；BasePage 在 unload 的 finally 兜底清理，禁止裸 timer 或未登记订阅。
- 每个 run 有本地 runId 和 generation。新发送、切会话、真正离页或 stop：先递增 generation，再清 timer/订阅/待执行队列，再中止底层请求 / native，等待释放；新 run 等 pendingStop 完成。
- 每次 await 后及更新 UI / 会话前检查 generation、runId、owner 是否仍活跃。取消不仅屏蔽 UI，也必须阻止后续请求与工具副作用。无法物理 abort 的通道要标明逻辑取消、仍在回收；不能声称服务端已撤销请求或账单。
- IME 复用 Global 实例，保存 handler，on/off 成对；打开前关闭旧 UUID，保存返回 UUID，回调只处理当前 UUID。仅 `editConfirmed === true` 写回；取消、过期、未知回调不改文本。结果归一化支持 string / `{value}` / `{text}`。
- 输入法可能触发 onHide，用显式「输入会话中」守卫；真正卸载仍先 off 再关闭会话，不能被守卫跳过。禁止调用内部 requestIMAppShow。
- 确认路径已有窄范围证据；取消 / close / 重复进入 / 前后台交错仍须真机验证。不能用 mock 代替 IME 验收。

## 5. 网络、TLS 与错误

- 唯一请求出口是 net adapter。已识别 flat http.request 不满足生产安全合同，必须拒绝生产凭据 / 用户 payload；不能仅靠 HTTPS URL 或 JS 选项恢复。生产采用经过 M0.5 验证的 native httpx 或其他独立验证安全 adapter；其他 API 名称 / 符号类似不能替代参数、TLS/redirect/status/期限/取消合同验证。
- OpenAI 请求为 POST JSON，`Content-Type: application/json`，按用户配置添加 Bearer，禁止把 key 改放 query。baseUrl 明确为 API 根（通常含 `/v1`），规范化尾斜杠后追加 `/chat/completions`，禁止重复拼路径。
- 生产 endpoint 必须 HTTPS，SSL peer 和 hostname 验证必须开启；禁 `-k`、verify=false、跳过 CA 校验。无可用 CA 时显式失败。仅显式开发模式允许本地 mock HTTP 和假 key，禁止发送真实凭据。
- 校验 URL scheme、host、长度及控制字符，禁止 URL userinfo、fragment 和敏感 query。redirect 默认禁用；若明确支持，限制次数并禁止跨 origin 携带 Authorization。模型不能改变用户选定 API 地址或凭据。
- **POST 以及任何计费 / 有副作用的操作禁止自动重试**，包括超时、断线、5xx、429、空正文和 JSON 解析失败；不得调用继承的 requestJson/withRetry 形成隐藏重试。用户主动重发是新请求，UI 提示上次结果未知、可能重复计费 / 效果。无服务端已验证的幂等协议，不假定 requestId 能防重。
- 无副作用 GET/HEAD 可按明确 adapter policy 有限重试（最多 3 次，总时限内，可取消），不得嵌套两层重试。严禁移植「随机 query 换连接」到 LLM POST。
- 初始预算：安全 adapter 单请求默认超时 20s；请求、响应分别不超过 2 MiB UTF-8；每 run 总预算见 §6。flat 固定 CONNECTTIMEOUT_MS=10000（连接 10s）与 TIMEOUT_MS=100000（总计 100s），未读取 caller timeout；JS 等待超时不是 native deadline / abort，旧“总计 10s”说法作废。预算是项目上限，设备承载能力仍须实测。能在读取阶段限制就提前停止；只能返回后检查的通道记录峰值风险。
- 归一化 status、正文、transport / TLS / timeout / cancellation 错误；未知 HTTP 状态必须标 unknown/null，禁止伪造 200。flat 仅接受 200/201 而成功只返回 `{result:'response text'}`，无 HTTP status；错误 `{result:{errorMessage}}` 和 proxy error 3 均非 HTTP 状态，禁止 scrape/regex 错误文本或信任正文自报状态。正文类型和 UTF-8 正确处理，禁止用 ASCII 占比拒绝中文或用字符串 length 当字节数。
- 使用稳定错误码（NET_TIMEOUT、NET_TRANSPORT、TLS_ERROR、HTTP_ERROR、PARSE_ERROR、CAPABILITY_UNAVAILABLE、LIMIT_REACHED、CANCELLED、STORAGE_ERROR），日志只记受控 metadata。不吞错误；预期取消可静默显示取消状态。

## 6. OpenAI 协议与有限工具循环

### 6.1 协议与预算

首版非流式 `stream:false`；SSE 是否可用仍属待验证能力，不据旧通道推断永久不支持。校验响应 envelope、choices/message、content（允许 tool_calls 时为 null）、finish_reason、tool_calls 类型与数量；不支持的结构显式报错。

每 run 默认至多 **6 次模型 POST**（含首问 / 最终回答）、每响应至多 8 个 tool_calls、每 run 至多 24 次工具执行、总耗时至多 120s。每工具参数 JSON 至多 8 KiB UTF-8、结果至多 4 KiB UTF-8（保留截断标记），另有工具自己的时间 / 输入限额。限额须集中定义、全路径执行；达到任一上限停止，不额外发「总结」突破预算，也不把被截断内容声称为完整结果。

### 6.2 参数、ID 与权限

工具合同：`{name, description, parameters, execute(args, context) -> Promise<string>}`；context 提供 generation / 取消、期限及窄 adapters。工具 registry 与发给模型的 schema 同源。

- arguments 必须是合法 JSON 字符串并解析为普通对象，禁止 eval / Function、原型污染字段（`__proto__/constructor/prototype`）、未知字段、超深嵌套及超限字符串 / 数组。
- 对 required、type、enum、范围、长度和 additionalProperties 逐项验证；仅提供实现支持的 JSON Schema 子集，不得「只声明不校验」。ID 和 URL 另做业务校验。
- tool_call.id 必须非空、长度有界且在当前会话协议历史与本地 toolAudit 的并集中唯一；tool_call 类型必须为 function，工具名精确匹配。整批 ID / envelope 验证在任何执行前完成；缺失 / 重复 ID 时拒绝整批并终止，禁止编造 ID 或先执行部分工具。
- 有效 ID 对应的未知 / 关闭工具、参数错误或执行错误，返回受限结构化错误 tool 结果；每个调用恰好一个结果，`tool_call_id` 精确匹配。执行前再查当前开关与取消状态，不能仅信请求时 tools 列表。
- 工具默认串行执行，保持顺序；禁止把模型输出当授权。相同 ID 不重执行；副作用工具记录本地执行状态，崩溃后未知状态不得自动补执行。当前合同为本地 toolAudit `{id,name,status,result?}`，最多256个唯一ID、结果最多4096 UTF-8字节，无args/额外字段；ID不得淘汰或在保存时删除/更名。每批执行前通过 beforeToolBatch 持久化整批 reservation，失败/false/取消均不执行；每run传完整 usedToolIds，审计不进入模型history。

### 6.3 原子工具组与上下文裁剪

- 一个 assistant tool_calls 消息与其**全部**对应 role:tool 结果是不可拆分组；多工具响应不得只保留部分结果，也不得留下孤立 tool 或没有结果的 assistant。
- 每次发请求前校验历史组完整。执行中组保留为 pending，本地可记录执行进度，但不能提交给模型；完成或以受控错误结束后整组提交。取消时未完成组隔离为未完成本地记录，后续请求排除整个组，不自动重放工具。
- 请求上下文初始双上限：100 条消息、256 KiB UTF-8（另计完整请求 2 MiB）；保留系统指令和当前用户输入，从最旧完整 turn / 工具组裁剪。不可裁掉活动组的一部分；保留内容仍超限则显式拒绝 / 请求用户缩短，不静默截断 JSON / IDs。
- 上下文裁剪只影响发送视图，不等于删除用户历史。历史持久化容量另有明确策略和 UI 提示。

## 7. 内置工具与受限 execShell

M3 保持 `clock`、`calculator`、`note`、`device_info`、`net_probe` 五类工具；clock / device_info 只返回必要字段，排除 serial、凭据与私密配置。note 仅访问 `pa.note.*`，ID / 操作枚举 / 内容长度验证，CRUD 操作在 UI 可见。

calculator 使用 tokenizer + 明确文法 / 求值器，只允许数字、括号及批准运算符；限制表达式长度、token 数和嵌套深度，处理除零、非有限数和越界。**禁止 eval、new Function、动态 import 或借 shell / JS 引擎求值**。

net_probe 仅 HEAD，校验用户允许的目标 / host，限制时间，不携带 API key，不下载正文。不能把任意内网探测交给模型；允许目标在设置中明确登记。

execShell 默认关闭，启用也只能调用**项目预设的只读操作**。schema 是 `{commandId, params}`，绝不是 `{command: string}`。

| 初始候选 commandId | 固定行为 | 参数约束 |
|---|---|---|
| `head_probe` | 固定 curl HEAD，`-f -s -I --max-time 6 --output /dev/null` | 仅已允许 HTTPS URL；不接收 headers、额外 flags、method 或输出路径 |
| `system_arch` | 固定 uname 架构查询 | 无参数，仅 status 能力如实显示 |
| `device_time` | 固定 date 格式查询 | 无参数；格式由项目固定 |

- allowlist 由 commandId 到固定 executable + argv 模板映射。调用执行器内部尽量使用 argv；平台只能接收 shell 字符串时，所有动态参数在语义验证后逐项 POSIX 单引号引用（内部单引号按标准方式转义），不得把整条不可信字符串「quote 一下」当验证。
- 禁止自由命令、通用 cat / busybox、echo 任意内容、任意路径读写、重定向、管道、分号、命令替换、换行及模型指定 shell 语法。禁止 curl POST、媒体 GET、凭据 headers、禁 SSL 校验和写系统目录。
- 设置页开关和每次执行前权限检查必须同时存在。UI 审计展示 commandId、非敏感参数 / 脱敏生成命令、耗时、受控状态；系统日志不保存命令参数或原始输出。
- 当前 execShell 只见 bool / 退出状态线索，无 stdout 契约。工具不得伪造设备时间 / 架构结果，不得用临时文件读取 stdout 绕过边界；需要信息时优先窄 device adapter。
- Global.execShell 同步阻塞与取消 / 超时能力待验证。无法满足执行期限、UI 响应和停止要求的预设必须禁用，不能因为 allowlist 就放行阻塞执行。

## 8. 配置、凭据与隐私

`pa.settings` 使用版本化 envelope；字段保留 baseUrl、model、temperature、maxTokens、tools、execShellEnabled，增加 `persistApiKey`（默认 false）。各字段有长度 / 范围 / 枚举验证；模型不得更改设置。

- apiKey 默认仅驻内存。用户主动选择记住并确认「设备本地以明文保存，能够读取设备数据的人可获取密钥」后，才持久化到运行时私有 storage；不声称加密。取消记住 / 清除密钥必须串行删除旧持久化值并验证读回。
- 配置 UI 默认遮罩 key；不得在列表、工具卡、错误页或截图暴露。若平台输入法无法遮罩敏感输入，先真机验证并告知实际可见性，不伪称输入链路已保护。取证使用假 key / 脱敏副本。
- **不记录请求 / 响应 payload、key、Authorization、用户消息、工具参数 / 结果原文、存储值或环境对象**，包括调试、mock server、native、CI 日志和解析失败时的正文前缀。只允许状态码、字节数、次数、耗时、受控错误码和本地关联 ID。
- API key 不进入工具 context、命令、query、公共 artifact 或源码。UI 正常展示对话内容不等于允许复制到运维日志；发送给配置的模型仅限用户对话及批准的工具结果。
- 既有续接记录有 mock auth/body 输出、raw echo、net parse head 与隐藏重试清理及宿主敏感哨兵覆盖，本轮不重跑或填最终数量。flat 生产安全不是仅未验收，而是已静态确认不合格，真实请求保持 fail closed；日志测试或本地 POST 通过不能代替独立安全通道验收。

## 9. 可靠存储

- adapter 归一化当前实际 storage 契约，schema `{version, data}`；覆盖未命中、损坏 JSON、未知 / 旧版本、类型错误、边界与迁移失败。损坏值不能静默覆盖唯一历史。
- 写、删、迁移和设置更新走统一串行队列，后一操作等待前一 settle；失败不能毒死队列，也不能回报已保存。幂等版本/revision 防止旧回调覆盖新状态。带工具取消guard的写必须透传到adapter，并在其内部队列出队及紧贴native调用前重查；已经发出的写不可撤销，未发出的取消写不得迟到开始。
- 单值初始上限 256 KiB UTF-8；会话分块并定义总容量 / 清理策略，禁止无界增长。多键历史更新用版本索引 / commit 标记或已验证等价方案，恢复时不读半写记录；不能假定 preferences 提供事务。
- 验证写入完成语义、read-after-write、重启 / 覆盖安装恢复、失败 / 断写；失败保留内存 dirty 状态，UI 给重试 / 导出 / 清理动作，队列可 flush 并报告结果。未取得读回 / 恢复证据不得宣称持久化可靠。
- runtime 管理应用数据目录；业务 / LLM 不直接改 preferences 文件或系统路径。上下文裁剪与历史删除分开。

## 10. 每一步证据记录

每个可独立审查的动作完成即记录，不等到里程碑末尾。通常追加 `docs/PROGRESS.md`，内容包括：step ID、时间、目标、改动文件、实际命令 / 方法、预期与观察、退出状态、证据路径 / SHA、profile / 版本、结论（通过 / 失败 / 待验证）、下一步。命令和证据不得含真实 key / payload；失败与修正也必须记录。

- 记录必须区分已执行、仅阅读的历史证据与未来待办；不能把计划写成完成日志，不能用 ret:0 代替截图 / 生命周期证据。
- 每次修正列出被替代的结论及原因。无效探针结论应立即撤回，不以尚未复测为由继续保留为事实；新合同静态线索与真实复测结果分开记录，当前 POST 更正见 SPIKE §3。

## 11. 生产安全 adapter 与 GitHub Actions

该 flat 实现已经静态确认不满足 TLS/redirect/status/期限/取消合同；生产必须 native httpx 或其他独立验证的安全 adapter。native 不是因旧 POST 探针失败而必需，也不是已完成：若其他安全通道完整通过可替代，不能凭 flat POST 送达跳过 M0.5。SDK 已存在不等于目标 sysroot / 链接 ABI 或项目模块已验证。

- **所有 C/C++ 编译与链接统一在 GitHub Actions**，不得以本机 / 设备生成的二进制替代交付；宿主可做源码检查与 artifact 检验。
- workflow 明确锁定 runner、依赖 action revision、编译器路径 / 版本 / target triple、工具链下载 SHA-256、SDK revision / 内容 SHA、sysroot 来源 / revision / SHA、目标 libc / libstdc++ / curl / TLS 版本。缺字段失败，不自动选「第一个」编译器、不用 runner host 库。
- target 为本 profile 的 AArch64 ELF64 little-endian glibc；显式 CMake toolchain / sysroot，记录链接命令、依赖和符号版本。只允许经 SDK / 目标库核实的宿主导出未解析符号，禁止盲用 ignore-all 掩盖缺依赖。
- 模块三名一致：`libjsapi_httpx.so`、loader `httpx`、JS import `httpx`；导出 `extern "C" custom_init_jsapis()`。阻塞 I/O 在 SDK Promise / 工作线程，禁止跨线程直接访问 QuickJS；异常转换稳定错误，cancel/stop/destroy 幂等、全部句柄回收。
- CI 对产物运行 file、readelf -h/-l/-d/--version-info、nm -D；确认 ELF class/machine/endian、依赖 / RPATH、所需 GLIBC / GLIBCXX 不高于目标、入口符号。共享库通常无 PT_INTERP；附带 executable 则校验 loader。与目标可用符号逐项比对，不能仅凭「GLIBC_2.17+」推断兼容。
- artifact 必须带 SHA-256、构建日志和 profile / source revision；下载后、进入 AMR 前、AMR 解包后复核 `.so` SHA 一致。CI 通过后仍需真机加载日志和全部导出功能 / 错误 / 取消 / TLS 测试；看到别的应用 aarch64 `.so` 不能替代。
- 发布源码、SDK / sysroot、推送 workflow、创建 repo、触发远程构建或 release 前，须有用户对**具体 owner/repo 及可见性 / 上传范围**的授权。采用 GitHub Actions 的决策不等于任意仓库发布授权；未获授权可先准备可审查配置，不上传 SDK、凭据或设备数据。

## 12. 构建、包与安装

- JS 构建使用项目锁定 Node / aiot-vue-cli；当前成功线索为 Node 20.18.0、aiot-vue-cli 1.0.32，依赖锁定与干净重建仍须落实。当前 package scripts 为 `npm run check/test/build/build:prod`，命令存在不等于检查已通过。
- appid / version 唯一业务来源为 `app/package.json`，manifest 由 CLI 生成；当前批准的数字 appid `8002026100700001` 已有安装 / index 挂载证据。用户原始 `800Guzhuooo0001` 是 **14 个字符**；字母是否允许、appid 是否必须固定数字长度尚未证明，不增加「禁止字母」规范。
- `.amr` 只由项目打包器生成，不用通用 ZIP 代替。检查 manifest、页面 / chunk、资源与 `.so` 引用、无旧产物；被 manifest 引用的 hash chunk 不得手删。发布版本递增，记录 AMR SHA-256 和绑定 profile。
- Y02 启动必须 `miniapp_cli start <appid> <page>`，显式位置参数页面名（不带 `--`）；规范入口当前 `index`。ret:0 之后用 PageLifecycle 确认挂载，另采截图并如实记录视觉核验状态；禁止省略 page、把挂载等同视觉通过或用整机重启掩盖问题。
- 使用 `capture`，本机 captureFB 不可用；开发 ADB 操作指定设备并处理 MSYS 路径转换。媒体 / framebuffer 特殊规则不是本 agent 项目的实现需求。

## 13. 审查与验收门槛

纯逻辑测试必须覆盖：OpenAI 结构 / JSON / schema / ID 验证、未知与禁用工具、6 次 POST / 24 次工具 / 时间预算、完整工具组裁剪、取消与旧回调、calculator 非法文法 / 除零、预设 shell 注入拒绝与 quoting、storage 排序 / 失败恢复 / 迁移、UTF-8 字节限额，以及 POST 各类失败仅一次发送。mock 验证多工具结果一一对应；敏感哨兵值不能进入任何日志 / artifact。

文档与代码审查检查所有几何路径、层间 import、硬编码尺寸、无 eval / 自由 shell、无隐藏 POST 重试、TLS 校验、每步记录。还须覆盖页面输入首 await 前快照、send reservation 与 stop 竞争、会话 owner/dirty/history 保存、loaded settings 门禁与 hide/show 重试；副作用执行前整批 ledger/audit reservation 串行持久化，保存失败/false/cancel 零执行，审计容量不得淘汰旧 ID 使之重放；排队写在原生调用前再查 cancel/timeout。它们是审查门槛，不表示仅凭文档已修。R06/R07 历史发现与 R08 最终宿主回归/限定复核见 PROGRESS；持久/重启防重放/取消的宿主回归已通过，不表示真机出口关闭。源扫描只能辅助，不能取代动态 style、协议与运行时验证。

每个声明支持的真机 profile / 交付版本必须取得：

- [ ] debug / production 构建、项目 check / test 和 manifest / SHA 校验。
- [ ] 首次与覆盖安装、显式入口冷启动、真实 endpoint 对话（主动发一次 POST）。
- [ ] 配置遮罩、可选明文持久化告知 / 清除、日志无 key / payload。
- [ ] IME 确认、取消不写回、关闭、重复打开、前后台与真正离页清理。
- [ ] 全 vw/vh 布局及多分辨率验证；模拟与真机证据分别列出。
- [ ] 工具环正常 / 异常 / 上限、停止、切会话、迟到响应、部分工具组取消。
- [ ] 断网 / 超时 / TLS 失败 / 解析异常可恢复，POST 不自动重发。
- [ ] execShell 关闭 / 禁用 / 拒绝 / 允许预设、无 stdout 和阻塞限制如实呈现。
- [ ] 存储冷启动读回、损坏 / 写失败 / 断写恢复、快速连续保存不乱序。
- [ ] 至少两次进入 / 退出与重复 stop；timer / 订阅 / 请求 / native 线程句柄不累积。
- [ ] `memoryUsageGC` 预热基线、第二次退出差值及重复回合趋势符合预先记录的阈值；阈值不能事后调到通过。当前基线 / 阈值 / 内存验收均待验证。
- [ ] 若启用 native：GitHub Actions 构建证据、ELF / 依赖 / SHA、真机加载与取消 / TLS 验证。

未执行项明确标待验证；失败项阻止其依赖功能验收。无第二种真机时只声明已测 Y02 profile，不能宣称跨设备兼容。M0 当前仍未完整关闭。
