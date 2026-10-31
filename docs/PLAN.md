# penagent · 笔上轻量化 Agent Harness 总规划

> 立项：2026-10-07 ｜ 首台目标：Y02-3562 / 固件 4.9.7。
> 当前：M0 部分验证；flat http.request 已被静态确认不满足生产安全合同，正确 JSON POST 真机送达、IME 取消 / 内存 / 多分辨率仍待验。生产需 native 或其他独立验证的安全 adapter；不宣布 M0 或 native 完成。
> 用户决策优先；设备事实按 `DEVICE_PROFILE.md` / `DEVICE_PROBING.md` 和可追溯实测核对；工程约束见 `STANDARDS.md`。
> 实测推翻文档时先记录更正，再改依赖实现；每一步记录证据，不把历史推断当已验证能力。

## 0. 目标、范围与已定决策

在有道词典笔运行轻量 LLM agent harness，完整保留：对话界面、会话列表 / 历史持久化、可配置 OpenAI 兼容 API、有限工具循环、五类安全工具、受限 execShell、系统输入法、全 vw/vh 适配、真机 AMR 验收与逐步证据记录。

| # | 决策 | 内容与证据边界 |
|---|---|---|
| 1 | LLM 协议 | OpenAI `/chat/completions`、tools/tool_calls；设置 baseUrl/apiKey/model/temperature/maxTokens；首版非流式，不宣称已验证 SSE 不支持 |
| 2 | 工具范围 | clock / calculator / note CRUD / device_info / net_probe，加默认关闭的受限 execShell；只接受预设 commandId + 严格 params，不允许自由命令 |
| 3 | 技术底座 | aiot-vue-cli + Vue 2 SFC + Falcon / QuickJS；已识别 flat HTTP 不合生产安全要求，生产必须使用经过独立验证的 native httpx 或其他安全 adapter。不是因 POST 不支持而要求 native。`miniapp-app-template/` 仅参考，pendouyin 仅提供待适配线索 |
| 4 | C/C++ 构建 | 用户已决定统一 GitHub Actions。明确锁定 toolchain/sysroot/SDK 和 ELF/SHA 验证；具体仓库发布 / 上传 / 远程运行另需针对 owner/repo 的用户授权 |
| 5 | appid | 用户给出 `800Guzhuooo0001`，是 **14 个字符**（含字母），不是 15 位数字。按已批准计划选择 `8002026100700001`，已有安装与 index 挂载证据；字母是否可用、固定数字格式是否强制均未证明。显示名 Guzhuooo Agent |
| 6 | 几何 | 所有 UI 几何均 vw/vh，包括动态 style、字体、描边、圆角；相对 token，通用配置不得硬编码 936 或像素换算 token。Y02 的 936×280 只属于该 profile；无 px 降级 |
| 7 | 凭据 | key 默认内存；用户可选择明文持久化并明确知晓风险，UI 遮罩。所有日志 / mock / native / CI 禁止记录 key 与请求响应 payload |
| 8 | 请求安全 | HTTPS 与 SSL peer/hostname 验证；POST 不自动重试，避免重复计费 / 工具效果。取消不保证服务端撤销，UI 如实显示未知结果 |

## 1. 项目布局与分层

以下是实施目标结构，不表示目录或实现均已完成；优先保留现有 app 和 services 边界。

```text
D:\penagent\
  DEVICE_PROFILE.md  DEVICE_PROBING.md   # 身份 / ABI / 屏幕与动态线索
  docs/
    STANDARDS.md                        # 强制工程标准
    PLAN.md                             # 总计划、实现快照与验收边界
    PROGRESS.md                         # 日常每步记录
    SPIKE_REPORT.md                      # 历史探针、更正与未关闭项
  profiles/                             # 设备参数与能力证据；发布身份以 package 为准
  app/
    package.json                        # appid / version / 项目 scripts
    api-mock/                           # 规划中的平台 mocks；存在不等于真机通过
    src/
      app.js app.json base-page.js       # 生命周期与显式规范入口 index
      pages/chat/                       # 会话栏 + 对话区
      pages/settings/                   # API、工具开关、密钥保存选择
      components/                       # 纯展示 msg-bubble / tool-call-card 等
      core/                             # llm/client、loop、context、session、config
      tools/                            # registry、五安全工具、exec 预设 schema
      services/                         # net/storage/input/device/exec/log adapters
      styles/viewport.less var.less base.less
    test/                               # 协议 / 参数 / 状态 / 取消 / 存储测试
    artifacts/                          # 脱敏真机证据与校验值
  tools/                                # 开发 mock 与远控，不暴露给 LLM
  native/sdk/iot-miniapp-sdk/            # 已有 SDK；不代表 toolchain/sysroot 就绪
  native/src/                           # 已有可选 httpx 源码；M0.5 未通过
  .github/workflows/                    # 必要时准备显式 native 构建配置
```

页面组装 core 与纯 components；components 仅 props/events；core 通过注入使用 adapters 与 tools，不访问 Vue / Falcon；tools 接受窄 adapters 与取消上下文；平台检测 / 转换只在 services。App/BasePage 仅负责平台生命周期。设备差异收口 profiles/adapters，禁止跨层循环依赖。

profile 当前不复制 APPID / APP_NAME，入口为 `index`，无 DOUYIN_* 或业务 endpoint；`app/package.json` 是 appid/version 唯一业务来源。remote 默认从该 package 读取 appid，显式 PEN_APPID 可覆盖。设备 936×280、旋转与触控 map c 属 Y02 已校准事实，保留在 profile / 开发远控，不回流为通用像素布局。

### 1.1 当前实现快照（源码阅读，不是验收）

| 边界 | 已有实现证据 | 尚不能据此宣称 |
|---|---|---|
| App / 页面 / 展示 | `app.js` 从 device profile 设置 viewport；BasePage 统一 release；chat/settings/probe 与四个 components 已存在；viewport.less 已是相对 vw/vh token | 首帧视觉通过、多分辨率 / 热区通过、两次进出无泄漏 |
| core / tools | 已有 client、runner、context、schema、settings、分块 session / storage 与 registry / calculator / exec 预设；0.3.0 增加声明式自造工具、工具识别、工作区文件/执行工具与动态 registry；通过注入接 adapter | 真实 endpoint 的生产安全通道、全量真机 LLM 闭环仍未通过；工作区与开发模式工具环已有 Y02 窄范围证据 |
| 设置 / IME | 设置页已有密钥遮罩、明文保存确认 / 清除入口与文件工具开关；input 有 UUID / on-off / close 和 hide 守卫 | 系统 IME 遮罩、取消 / close / 前后台、持久化实际落盘已验 |
| composition / net | 既有集成记录：composition 接 core；net 对象 data / 单次 POST / UTF-8 / 未知 status=null / 日志约束有宿主合同测试覆盖；0.3.0 增加仅开发模式的 curl 传输 | flat 二进制关闭 peer/host 校验、自动 redirect、不回传 HTTP status、无 caller timeout/signal，未发现该路径 abort；**静态不合格**，非仅未验。生产保持 fail closed；curl 传输不是生产 adapter |

源码表不代替设备证据。历史记录中的“待创建 / 固定 936 token”不再描述当前源码。R06/R07 后的页面、ledger、排队取消及 transition/send 竞态已在 R08 修复并限定复核关闭：旧 5 项 + Node 93 项、Python 策略 22 项通过，debug/production 预览包已重建及只读校验。真实 core+UI 的持久、重启防重放、取消回归属于宿主证据；设备与安全 adapter 出口仍未关闭。最终 SHA 和证据见 VALIDATION。

## 2. 核心设计

### 2.1 LLM 客户端与网络 adapter

- 用户配置 API 根 baseUrl（通常含 `/v1`）；规范化后 POST `/chat/completions`，JSON body、Content-Type、可选配置 Bearer、`stream:false`。首版明确思考 / 错误 / 取消状态。
- 已识别 flat HTTP 可构造 JSON POST，但关闭 TLS peer/hostname 校验并自动跟随 redirect，不能选作生产 adapter。生产须经过 M0.5 的 httpx 或其他独立验证安全合同的通道；JS 增加 verifyPeer/verifyHost/redirect 字段不能修补 native 未读取的选项。缺鉴权 / body / TLS 不静默降级，不把密钥放 query。
- 校验 choices/message/content/finish_reason/tool_calls；工具参数必须 JSON 字符串。未知包装 / 未知状态显式失败或标 unknown，禁止默认伪造 HTTP 200；兼容中文 UTF-8，不继承 ASCII 占比过滤。
- 安全 adapter 的项目单请求预算为 20s，请求 / 响应各至多 2 MiB UTF-8；须可执行期限和回收，不只限制 UI 等待。该 flat 实现固定连接 10s、总计 100s，忽略 caller timeout；JS 20s timer 不能把它变为符合预算。native 尽早在接收阶段限额，事后检查须记录峰值风险；预算需真机内存验证。
- 生产 HTTPS，peer/hostname 校验开启，CA 不可用即报错。开发 HTTP 仅本地 mock + 假 key。redirect 不得跨 origin 泄露 Authorization。
- POST 在超时 / 断线 / 5xx / 429 / 空响应 / 解析失败时均不自动重试；用户重发是新请求，告知上次可能已执行并计费。GET/HEAD 的有限重试独立配置并可取消，不嵌套重试 / 随机 query。
- net/mock 的 POST 单次发送、无 parse head/payload 日志、中文 UTF-8 与未知状态拒绝已有最终宿主回归及敏感哨兵覆盖；旧 adapter 的缺陷不再作为当前源码缺陷。生产仍因上述 flat 安全合同不足被禁用，宿主测试不能替代安全 adapter 与真机验收。

### 2.2 有限工具环、ID 与上下文

- 合同 `{name, description, parameters, execute(args, context) -> Promise<string>}`，registry 与 schema 同源。context 提供 generation、runId、期限及窄 adapters。
- 每 run 最多 **6 次模型 POST（含首问 / 最终答复）**、每响应最多 8 个 tool_calls、总工具执行最多 24 次、总预算 120s；参数最多 8 KiB UTF-8，结果最多 4 KiB UTF-8并标截断。限额集中定义，达到上限停止，不偷偷加总结请求。
- 执行前解析并验证 JSON Schema 支持子集、required/type/enum/range/length/additionalProperties；拒绝未知字段、原型污染字段、超深 / 超长内容。不能只把 schema 发给模型而不本地验证。
- 整批 tool_call.id / type / envelope 在任何执行前验证：非空、长度有界、唯一，工具名精确匹配。ID 缺失 / 重复则拒绝整批并终止，不编造 ID；有效 ID 的未知 / 禁用工具或参数 / 执行错误返回受控 tool 错误。
- 默认串行工具，每个有效调用恰好一个 `role:tool` 且 `tool_call_id` 一一匹配；执行前再查权限与取消。相同 ID 不重执行，崩溃后副作用状态未知不自动重放。
- 一个 assistant tool_calls + 所有对应 tool 结果组成**完整原子工具组**。pending 组不发给模型；取消时未完成组隔离为本地记录，后续请求排除整组；禁止孤立 tool、只保留部分结果或带缺结果 assistant。
- 发送上下文初始上限 100 条 / 256 KiB UTF-8，保留系统指令 / 当前输入，从最旧完整 turn 或工具组裁剪；仍超限则明确拒绝，不能截断 JSON 或拆组。上下文裁剪不删除持久化历史。
- stop、新 run、切会话、真正离页先作废 generation 再清资源；每 await 后验证归属，阻止后续请求 / 工具与过期 UI 更新。物理 abort 不可用时记录逻辑取消局限。

### 2.3 工具与 execShell

- `clock`：受限时间输出；`calculator`：tokenizer / 文法求值、长度 / 深度 / 除零 / 非有限数验证，禁 eval / Function / shell 求值。
- `note`：仅 `pa.note.*` CRUD，校验 ID、操作、内容限额，效果可审计；`device_info`：经过筛选的 profile 信息，无 serial / key；`net_probe`：用户登记允许目标的 HEAD，无 key / 正文下载。
- M4 execShell schema 仅 `{commandId, params}`；初始候选 `head_probe`、`system_arch`、`device_time`，各自固定 executable/argv 与字段约束。禁止自由 shell、通用 cat / busybox、任意 echo、路径读写、pipe/redirection/命令替换、curl POST / 媒体 GET / -k。
- 参数先语义校验（URL scheme/host/控制字符、枚举、范围），再逐项 argv 或正确 POSIX 引用；用户 / 模型不可选 flags、命令模板、输出路径、headers。开关默认关闭，执行时重查。
- UI 展示受控操作、脱敏参数 / 命令和状态。execShell 当前仅有 bool / 状态线索，不能伪造 stdout；同步阻塞 / 无可靠期限取消的预设不得启用。
- 0.3.0 新增 `define_tool` / `delete_tool` / `list_tools`：模型只能提交 lookup/compute/template/text/convert 声明式 recipe，不能提交代码；recipe 持久化在 `pa.customTools`，上限 8 个 / 单条 2 KiB，损坏显式失败。工具识别为有界确定性排序（名称/关键字/描述/中文二元组），不改权限。
- 0.3.0 新增 `file_list/file_read/file_write/file_delete/file_exec`：路径只能是 app 私有工作区相对路径；写入经 POSIX 引用 shell + fs 校验；执行由 `/bin/timeout` 硬限时、输出限幅，`file_exec` 默认关闭。真机 Y02 已用运行自检与开发模式 AI 文件测试验证（见 VALIDATION / WORKSPACE_TOOLS）。

### 2.4 配置、凭据与存储

`pa.settings` 版本化 envelope 保留 baseUrl/apiKey/model/temperature/maxTokens/tools/execShellEnabled，增加 `persistApiKey` 默认 false；不保存时持久化 schema 排除 apiKey。

用户选择记住密钥时明确「本地明文保存」并确认；设置页默认遮罩，清除 / 取消保存要串行删除旧值并读回验证。IME 敏感输入是否可遮罩需验证，截图仅用假 key / 脱敏证据。

所有 pa.* 对象带 version，处理空 / 损坏 / 旧版 / 类型错误；写删迁移走统一串行队列，失败保留 dirty 内存状态、提示可恢复动作。单值初始至多 256 KiB UTF-8，会话分块与总容量策略明确，多键更新采用版本索引 / commit 标记及恢复方案，不假定事务。read-after-write、重启、断写和覆盖安装必须验证。

日志只允许状态 / 次数 / 字节 / 耗时 / 受控码 / 本地关联 ID；禁止 payload、key、auth、消息 / 工具原文、parse head、storage 值，规则也适用于 mock/native/CI。

### 2.5 UI、输入法与响应式

首台 Y02 横向会话栏 26vw + 对话区 74vw，settings 使用同一相对 token；全部几何 vw/vh，禁 `@px1:100vw/936` 或通用硬编码设计宽。每个 profile 在 App 首帧前配置自身已验证 viewport。纯 components、文字 `<text>`、图片与 scroller 明确相对尺寸、显式 flex-direction、单 class、稳定几何、业务 ID key。

触控热区两个轴至少 18vh。系统 startTextEdit 复用 Global、校验 UUID、仅 editConfirmed 真值写回，on/off 成对、完成 close；输入法引发 onHide 用会话守卫，真正 unload 不跳过清理。确认路径窄范围通过，取消 / close / 前后台仍待真机验证。两种以上分辨率 / 比例做布局取证，每个声明支持的真机 profile 独立验证；不能以 Y02 一张截图宣称多分辨率兼容。

### 2.6 0.3.0 自造工具、工具识别与工作区执行

用户 2026-10-31 继续要求：让 harness 能自己创造/识别工具，并至少让 AI 能编辑、删除、执行文件。实现与证据：

- 自造工具：声明式 recipe（见 §2.3 与 `docs/CUSTOM_TOOLS.md`），元工具定义/删除/识别，`pa.customTools` 持久化；无 eval / 自由代码。
- 工作区：`$workspace` 推导私有根，五个 file_* 工具，路径穿越拒绝，写回经 shell + fs 校验，执行经 `/bin/timeout`；`file_exec` 默认关闭。详见 `docs/WORKSPACE_TOOLS.md`。
- 开发模式真实网络：`services/net/dev.js` 仅在 developmentMode + 回环/私网 + 合成 key 时用设备 curl 获得真实 HTTP status；含 -m 与 /bin/timeout、响应上限、临时文件清理，不记录 body/header/key。生产路径仍 fail closed，不能被该开发通道解锁。
- 真机证据（Y02 / 4.9.7 / ADB）：工作区自检 ok=true（9 步）；开发模式 AI 测试由 LAN 合成 mock 驱动 3 次模型请求 / 5 次工具调用，最终 keep.txt 留存、ai.txt 删除，状态 completed。证据见 `docs/evidence/workspace-device-0.3.0.txt` 与 `docs/WORKSPACE_TOOLS.md`。
- 未通过：真实 endpoint 生产对话、生产安全 adapter、TLS/redirect/status 的生产级验收；native `.so` 仍依赖 GitHub Actions 的获批 toolchain/sysroot bundle，本轮无设备 `.so`。

### 2.7 0.3.1 组件高度单位与 native 2018 工具链 + 真机 sysroot

用户 2026-10-31 追加要求：组件高度全部 vh/vw；vendor toolchain 用 aarch64、尽量 2018 工具链；glibc
从真机确认；sysroot bundle 从真机采集；SDK 用 `iot-miniapp-sdk.zip`。

- UI：12 个样式文件 154 条尺寸声明全部已是 vh/vw 或 viewport token；补两个内容高度组件根的
  vh min-height；source-contract 增加严格门禁（height 家族必须 vh 源、width 家族必须 vw 源、根节点
  必须声明宽高），测试 126/126 + 5/5 全绿。0.3.1 两包构建/校验通过并真机安装截图。
- 真机 ABI：glibc 2.36、libstdc++ 6.0.29（GLIBCXX 3.4.29）、curl 7.79.1、aarch64 LE、loader
  `/lib/ld-linux-aarch64.so.1`。sysroot bundle 由 ADB 采集并按设备 `sha256sum` 交叉校验（25/25），
  含 SDK、curl 7.79.1 headers、24 个设备运行库闭包、libfalcon.so、manifest/provenance。
- 工具链：GitHub Actions 内 `ubuntu:18.04` 容器 + GCC 7.5.0 AArch64 cross + cmake 3.18.4 +
  glibc 2.27 dev headers；容器 sysroot = 工具链 dev 文件 ∪ 设备库覆盖（设备同名库优先）。
  `.github/workflows/native-device-build.yml` 构建插件并做 fail-closed ELF/ABI 审计。
- 结果：`libjsapi_httpx.so` 488,520 B / SHA-256 `22d4e811…4fcf5cd`，两次 run SHA 一致；
  ELF64 LE AArch64 DYN、SONAME 正确、无 PT_INTERP/RPATH/RUNPATH/TEXTREL、导出
  `custom_init_jsapis`、DT_NEEDED 与设备 provider SHA/SONAME 匹配、所需版本符号 ≤ 设备上限。
- 边界：`.so` 未打进 AMR、未在真机加载，不声称加载/TLS/取消/运行时兼容；`native-manual.yml` +
  `ci-policy.json` 保持 disabled，正式发布仍需获批 vendor bundle。详见
  `docs/VALIDATION.md`、`native/README.md`、`docs/evidence/ci-native-0.3.0/`。

### 2.8 0.4.0 可用版本：native transport 进 AMR 与真机验证

- 为对齐 core 2 MiB request 预算，`native/src/httpx_core.h` 的 `kMaxBody` 提升到 2 MiB，Actions
  run 41180136061 重建 `.so`（488,520 B / SHA `970b6a33…10b4a6`），静态审计保持通过。
- `app/libs/libjsapi_httpx.so` 被 aiot-cli 自动打入 AMR；新增 `app/src/services/net/native.js`
  动态 `import('httpx')`，把 native 真实 status/body、TLS 校验、禁 redirect、timeout、cancelAll
  接入 core requestJson；production 优先 native，缺失时 fail closed，dev 模式回退 curl。
  `tools/verify-amr.py --native-sha256` 对 AMR 内唯一 `.so` 做 ELF64/AArch64/SHA fail-closed 校验。
- 真机（Y02）：0.4.0 debug 安装 ret:0；probe 原生 HTTPS POST 200 / 420 B；过期证书被拒绝为
  `TLS_ERROR`；native transport 驱动 LAN 合成 mock 的 3 次模型请求 / 5 次 file_* 工具调用，
  `status=completed`，keep.txt 留存、ai.txt 删除。证据 `docs/evidence/native-device-0.4.0.txt`。
- 0.4.0 包：debug 638697 B / SHA `4ad0aac9…958cf`，production 626825 B / SHA
  `b2f7621a…b9eff`；均含 SHA `970b6a33…` 的 native 库。最终 CI：native-compile 41181149627
  （JS 131/131、策略 22/22、CTest 1/1）、native-device 41181149672 均绿。
- 边界：未用真实 OpenAI endpoint/key 对话；Falcon 线程/取消全链路、IME/内存/多分辨率与正式
  native-manual 发布链路仍未通过。

### 2.9 0.5.0 Anthropic Messages 与真实 endpoint 闭环

- 用户提供 `https://api.yunqing.asia` 测试配置；探测确认它只支持 Anthropic Messages
  （`/v1/messages`），`/v1/chat/completions` 404，模型为 deepseek-v4-flash/pro、deepseek-v4.1-flash。
- 新增 `apiFormat=openai|anthropic`（设置页可切）；Anthropic 模式 `x-api-key` +
  `anthropic-version: 2023-06-01`，把内部 OpenAI-shaped 历史转换为 `tool_use`/`tool_result`
  blocks，thinking 块丢弃，响应映射回内部 tool_calls。请求超时升到 60s，run 预算 240s。
- 协议测试 5 项；全套 136/136 + legacy 5/5 + Python 22/22。
- 真机 0.5.0：真实 endpoint + deepseek-v4.1-flash 完成“调用 clock → 返回 UTC 时间”，
  `完成 · 工具 1 · 10647 ms`；证据 `docs/evidence/real-anthropic-0.5.0.txt`。
- 包：debug 641126 B / SHA `584124ce…af6a`，production 628708 B / SHA `f0aa5896…493b`。
- 边界：仅一个真实账户/模型/endpoint；其它兼容服务、流式、Falcon 线程/取消、限流/长对话、
  IME/内存/多分辨率与正式发布链路仍未验证；测试 key 已从设备清除。

### 2.10 0.6.0 持久 key、无限额、折叠、提示词与插件热载

- key 自动保存：输入即保存，更新设置不丢；只有显式清除。
- 旧业务循环限额移除（模型/工具/批量/总时长），保留单次请求/工具/字节安全边界。
- 系统提示词设置注入请求；Anthropic thinking / OpenAI reasoning 作为可折叠“思考过程”，
  工具调用/工具结果可折叠，reasoning 仅显示不回传。
- 轻量 Markdown → 纯文本显示（`utils/plain-text.js`）。
- 插件规范 `penagent-plugin/1`：工作区 `plugins/*.json`，声明式 recipe 工具 + prompt，
  工具页热重载；不允许代码/原生库。
- 真机：0.6.0 真实 endpoint clock 闭环 completed/toolCalls 1/5598ms；插件 `weekday_cn` 在
  工具页出现。折叠 UI 真机视觉与插件 reload 点击仍未截图验证。
- 包：debug 646182 B / SHA `a9990ca0…eadfd`，production 633053 B / SHA `817a4956…9f000`。

## 3. 里程碑与出口

| 里程碑 | 内容 | 出口判据与当前状态 |
|---|---|---|
| M0 环境与能力复核 | adb / 构建 / 身份 / viewport；有效 Bearer POST 与 TLS；storage；IME 全流程；两次进出与内存、多分辨率 | **部分验证，未关闭**。逐项证据表；POST 有效复测、IME cancel/close、memoryUsageGC 基线 / 趋势、多分辨率仍待完成 |
| M0.5 安全网络通道（native 或替代） | flat 已静态确证安全不合格；采用 httpx 则 GitHub Actions 锁定 toolchain/sysroot/SDK、ELF/依赖/SHA、异步 I/O / cancel / TLS | **生产阻塞，未完成**。native 须具体 repo/上传范围授权及 CI/真机验证；只有另一条独立验证 TLS/redirect/status/期限/取消的安全 adapter 才可替代，不能凭 flat POST 成功跳过安全门槛 |
| M1 骨架与配置 | App/BasePage、纯 components、相对 viewport tokens、adapters/core/tools 边界、settings / 密钥策略、迁移 profile 残留 | AMR 安装→显式 index→截图/SHA；布局无非 vw/vh 长度；设置遮罩 / 验证 / 保存清除；timer 与订阅回收证据 |
| M2 LLM 通道与 chat | client、收发状态、单次 POST、TLS、取消、日志清理、UTF-8 / 超时限额 | mock 与真实 endpoint 各完成一次主动对话；各失败仅一次发送；断网/取消/迟到回调、TLS fail 测试；无真实 key/payload 日志 |
| M3 五工具与有限循环 | registry、五类工具、JSON schema/IDs、原子组裁剪、预算、tool-call UI | 纯逻辑测试含坏参数 / 重复ID / 禁用工具 / 上限 / 取消 / 整组裁剪；真机工具调用，多个结果准确关联；calculator 禁 eval |
| M4 execShell + 历史持久化 | 预设只读执行器、关闭开关、审计；会话列表、分块历史、可靠串行保存 | 注入拒绝与正确 quoting、关闭/允许用例；不伪造 stdout / 取消；重启读回、断写恢复、连续保存不乱序；两次进出无累积 |
| M6 自造工具 / 识别 / 工作区文件执行（0.3.0 新增） | recipe 元工具、pa.customTools、动态 registry、工具识别、file_* 工具、工作区适配器、设置开关、开发模式 curl 传输、工具/工作区页面 | 0.3.0 宿主 121/121 + legacy 5/5 + Python 22/22；Y02 真机安装、自检 9 步 ok、开发模式 AI 文件测试 completed（keep.txt 留存 / ai.txt 删除）；真实 endpoint 与生产安全 network adapter 仍未通过 |
| M7 组件高度门禁 + native 2018 工具链/真机 sysroot（0.3.1 新增） | 154 条尺寸声明审计与严格 source-contract 门禁；0.3.1 AMR；真机采集 sysroot bundle；ubuntu:18.04 GCC 7.5.0 AArch64 交叉工具链；Actions 构建 + ELF/ABI 审计 | 0.3.1 宿主 126/126 + 5/5 + Python 22/22；两包构建/校验/真机安装；native run 41179283105/41179509958 绿，`.so` 488,520 B / SHA 22d4e811…，静态审计通过；未打进 AMR/未真机加载，发布链路仍需获批 vendor bundle |
| M8 可用版本：native transport 进 AMR + 真机验证（0.4.0 新增） | `.so` 打进 AMR；native requestJson（TLS/真实 status/禁 redirect/timeout/cancelAll）；verify-amr native SHA；probe 原生 HTTPS/TLS 拒绝；native + file_* 工具闭环 | 0.4.0 宿主 131/131 + 5/5 + Python 22/22；两包 638697/626825 B 且含 `970b6a33…`；Y02 原生 HTTPS POST 200、过期证书 TLS_ERROR、AI 文件闭环 completed；真实 endpoint/真实 key 仍未验证，native-manual 仍 disabled |
| M9 Anthropic Messages + 真实 endpoint 闭环（0.5.0 新增） | `apiFormat=anthropic`；/v1/messages、x-api-key、tool_use/tool_result 转换、thinking 丢弃；60s 超时/240s run；设置页切换；真实 endpoint 测试 | 0.5.0 宿主 136/136 + 5/5 + Python 22/22；Y02 真实 `api.yunqing.asia` + deepseek-v4.1-flash 完成 clock 工具闭环（工具 1、10647ms）；包 641126/628708 B；其它 provider/流式/Falcon 线程等仍未验证 |
| M10 持久 key、无限额、折叠、提示词、纯文本与插件（0.6.0 新增） | key 自动保存；业务循环限额取消；systemPrompt；reasoning/tool 折叠；Markdown→纯文本；插件规范 + 工作区热载 + 工具页重载 | 0.6.0 宿主 141/141 + 5/5 + Python 22/22；真机真实 endpoint clock 闭环 completed/1 call/5598ms；插件工具 weekday_cn 出现；折叠 UI 真机视觉与插件 reload 点击未验 |
| M5 验收交付 | STANDARDS §13 完整矩阵、版本递增、AMR / 可选 `.so` SHA、逐步日志与限制说明 | 声明支持的功能/profile 对应证据齐全；未测能力明确标注，不把 mock 当真机。GitHub 发布仅在具体仓库授权内执行 |

M1 的纯展示 / mock 与 M0 待办可并行；M2 生产真机 LLM 依赖 M0.5 安全通道完整通过，flat JSON POST 即使送达也不解锁。M3 纯逻辑可先用 mock，真机闭环依赖 M2。M4 依赖 M1 存储边界和 M3 参数 / 权限；M5 不能跳过 R06→R07 修复的 R08 最终集成回归及任何未关闭门槛。

## 4. 当前能力与网关复核

### 4.1 已知、继承与待验证

| 能力 | 当前分类 | 可用结论 / 限制 |
|---|---|---|
| Y02 ABI / 屏幕 / framework | 指定设备既有证据 | AArch64 ELF64 little-endian、glibc、QuickJS 20200705、Vue 2.6.12、逻辑 936×280；不推导新固件或 sysroot 兼容 |
| JS 构建 / 数字 appid / index 挂载 | 本项目窄范围已验证记录 | Node 20.18.0、aiot-vue-cli 1.0.32、安装及 PageLifecycle 证据；production / 干净锁定重建仍需验收 |
| vw/vh / 首帧截图 | Y02 既有校准 + 历史色条截图位置 | 单位校准来自 DEVICE_*，本次没有视觉查看；截图存在 / 尺寸 / ret:0 不证明布局比例、无裁切、触控或多分辨率通过 |
| GET + Bearer | 本项目窄范围已验证记录 | mock 记录 header 送达；不证明 POST/TLS/状态码/取消 |
| storage set/get | 本项目一次读回已验证记录 | 不证明重启持久化、写序、断写恢复与事务 |
| startTextEdit 确认 | 本项目窄范围已验证记录 | 输入 S / editConfirmed:true；取消、close、旧UUID、前后台交错未验 |
| execShell | 有存在 / bool 返回线索 | 无 stdout；可靠超时 / 取消 / UI 阻塞未验，不能作为 LLM 响应通道 |
| flat http.request JSON POST | 静态合同支持，真机送达待验 | 旧四字段 / Promise 探针无效，不证明 POST 不支持 |
| flat http.request 生产安全 | **静态确认不合格** | peer=0、host=0、follow=1；连接 10s / 总计 100s；无 caller TLS/redirect/timeout/signal；成功无 HTTP status，proxy error 3 非状态，未发现该路径 abort。需独立安全 adapter |
| 第三方 native / SDK | 继承可行性线索 | 其他应用 aarch64 `.so` 与 SDK 已有；本项目 httpx、匹配 sysroot、CI toolchain、加载契约仍未验 |
| 内存回收 / 多分辨率 | 待验证 | 无 GC 基线 / 阈值 / 两次退出趋势和完整响应式证据 |

### 4.2 POST 合同与已确认的生产安全阻塞

1. flat 合同为 `$falcon.jsapi['http.request'](JSON.stringify(payload), cb)`、单数 `header`、对象型 `data` 和 `method:'POST'`。JSON Content-Type 下 `Json::dump(data)`，字符串 data 会二次编码。旧 wrapper 只转发 body，旧嵌套同步 `{}` 是 Promise；因此旧 GET-only 结论仍撤回，但正确对象 POST 真机送达仍待验。
2. 最新只读反汇编指向历史匹配的 `libfalcon.so` SHA-256 `91e23dcef405d849e17757656cd2603ecc21cc9d20437bf38937c6b13b664a58`；`HttpApiExtension::request` 为 `0x7577f0`、size `0x3ce8`，flat 注册 `0x753728`。当前 ADB 断开，本轮未重新 hash 或执行证书测试；地址证据详见 `tools/post-contract-notes.md`。
3. 该函数固定 `FOLLOWLOCATION(52)=1 @0x757934`、`SSL_VERIFYPEER(64)=0 @0x75794c`、`SSL_VERIFYHOST(81)=0 @0x757964`；`CONNECTTIMEOUT_MS(156)=10000 @0x75797c`，`TIMEOUT_MS(155)=100000 @0x757998`。**连接 10 秒、总计 100 秒**，不是旧称“总计 10 秒”。仅读取 url/header/method/data，无 caller TLS/redirect/timeout/signal 控制，未发现该 flat 路径 abort。JS 等待超时 / 逻辑取消不能修补或停止 native 请求。
4. `CURLINFO_RESPONSE_CODE @0x75a19c` 后仅认 200/201；成功 `{result:'response text'}` 不回传 HTTP status，错误 `{result:{errorMessage}}` 与 proxy error 3 不是 HTTP 状态。禁止从错误文本 scrape / regex 伪造状态，未知保持 null/unknown；正文宣称的 status 同样不能充当真实状态。
5. **该 flat 实现静态安全不合格，不是仅未验证。生产必须 native httpx 或另一条独立验证安全 adapter**，理由是 TLS/redirect/status/期限/取消合同不足，不是 POST 不支持。替代通道仍须真实有效 / 无效证书、redirect、状态、超时、取消、迟到回调与接收限额验收；不得把静态发现说成已执行证书测试。
6. ADB 恢复后如另获授权，可用本地 mock、固定合成内容与假 key 复测 JSON POST 送达，不能解锁生产。仅留 method、UTF-8 字节数、匹配 bool、受控状态 / 耗时 / ID；notes 的旧敏感 payload/echo helper 已移除，禁止复制。

### 4.3 网关处置

- 生产网络：flat 已静态确证安全不足，保持 fail closed；正确 POST 送达测试不改变此结论。先取得独立安全 adapter 的完整证据再解锁真实 LLM；禁止用 query key、execShell curl + 临时文件或关闭 SSL 绕过。
- appid：数字方案已通；不再把「字母与强制格式不符」当事实。未来确有需要才测字母方案，保留用户原始名称记录。
- 构建：JS debug/production 预览均已成功并通过 manifest 校验；干净机器锁定重建仍需做。任何 C/C++ 交付必须 GitHub Actions；缺明确 toolchain/sysroot 时阻塞 native，不从 host 凑库。
- native 构建 / 发布：用户同意 Actions 路线尚未指定 owner/repo、可见性、SDK/sysroot 上传许可。可先完成本地可审查配置；上传、推送、创建仓库、触发远程 run 或 release 前取得具体授权，不推定公开仓库。
- M0 尾项：IME cancel/close、memoryUsageGC 基线和第二次退出趋势、两种以上布局尺寸 / 比例是明确未完成项；历史勾选不关闭这些门槛。SPIKE / PROGRESS 结合最新安全更正阅读。截图未经具备视觉能力的查看者核验时仅算采集证据，不算视觉验收。

## 5. 验证与风险

验证以 `STANDARDS.md` §13 为出口：项目 check/test 与 debug/production AMR；协议 / schema / ID / 预算 / 取消 / 原子组裁剪；预设 shell 注入 / quoting；可靠 storage 与敏感日志测试；真机 IME、网络中断、前后台、重复 stop、两次进出 / GC；响应式多尺寸证据；可选 native 的 CI/ELF/依赖/SHA 与真机加载。

| 风险 | 应对 / 阻塞范围 |
|---|---|
| 混淆 POST 可用与生产安全 | 旧 GET-only 推断撤回；flat 已静态不合格，生产需独立安全 adapter，JSON POST 送达不能替代 TLS/status/期限验收 |
| 自动重试重复计费 / note 副作用 | POST 单次发送，用户主动重发告知未知结果，ID / 本地执行状态防重放 |
| 继承 profile / 抖音规则污染 | 身份 / 入口已按 package 与 index 收口，现有 token 已相对化；继续审查 adapters 的业务 headers / 媒体假设，不把已迁移部分仍列为待创建或推定整体合规 |
| 部分工具组裁剪使协议失配 | 完整组提交 / 裁剪，pending 隔离，每次请求前校验 |
| 中文被过滤或字节预算错误 | UTF-8 字节计数、类型解码、中文与长内容用例 |
| 明文 key / mock 正文泄露 | 默认不保存、显式告知与遮罩、日志 allowlist；真实 endpoint 前清理 mock/net 日志 |
| native toolchain/sysroot 或 SSL 不兼容 | Actions 显式版本/SHA、符号对照、真机 TLS/加载/取消验收；不以 CI 成功替代真机 |
| 存储乱序 / 半写 / 无界历史 | 串行 revision 队列、commit/recovery、分块容量、失败 dirty 提示 |
| IME hide、同步 shell 阻塞或回收不完整 | UUID/generation、严格清理、无可靠期限禁用预设、两次进出/GC 阈值预登记 |

## 6. 文档维护与证据归档

此前修订仅覆盖 PLAN / STANDARDS，是当时分工范围，不是用户对后续任务的永久限制。此前的 profile 抖音残留、固定宽度 token、旧 probe / net 缺陷均为当时源码快照；本轮已按当前文件及 `tools/post-contract-notes.md` 修正现行描述，旧记录不可当作当前缺陷仍存在或当前修复已验的证据。

以下保留原修订记录的 ID 与证据摘要，**仅为历史记录，本轮未重做这些检查**：

| 历史 step（2026-10-07） | 当时动作 / 证据 | 当前解读 |
|---|---|---|
| DOC-01 | 阅读项目 PLAN / DEVICE_* / PROGRESS / SPIKE、haasui references 与 pendouyin 文档；当时 PLAN 95 行，有能力 / appid / native 冲突 | 按证据分级，不复制抖音业务约束 |
| DOC-02 | 查 probe / net / mock / viewport / profile / package；当时发现 POST 参数 / settle 缺陷、敏感日志、抖音身份与固定 936 token | 属当时快照；当前实现见 §1.1，POST 历史缺陷解释见 §4.2 |
| DOC-03 | 当时 135 个授权外文件 SHA 汇总 `5af8e7f5b219f10a612fad1bd3e530372f13c6a8c6d35d12cff525332cf9f08b`；STANDARDS 尚不存在 | 仅当次范围基线，不用于证明本轮并行工作区未变 |
| DOC-04 | 创建 STANDARDS、重写 PLAN，明确相对几何、分层、协议 / 安全 / 取消 / 存储 / CI 与证据门槛 | 是规范成文，不是实现或验收完成 |
| DOC-05 | 当时结构 / whitespace / 九类文档检查与原有 135 文件 hash 一致；并行新增 native 配置 / 源码和 post-contract-notes 被单独识别 | 当次只写两份文档；无 runtime/build/device 验收，M0 未关闭 |

此前文档 / profile / remote 修订没有设备复测、视觉验收或真实 API 请求，其返回记录由主 agent 归档。最新文档更正只涉及 PLAN / STANDARDS / SPIKE / PROGRESS / VALIDATION、README 与 post-contract-notes：据新静态证据将 flat 生产网络从“未验”升级为“不合格”，修正连接 10s / 总计 100s；R06 保留 review 当时待修，R07 按协调者后续信息记录页面、ledger、排队取消分项修复及独立验证。文档代理未编译/上传、未重 hash 断开的设备；主协调者随后完成的最终总数、AMR SHA 与真实 core+UI 宿主回归已记 R08 / VALIDATION。原规划 appid、密钥和自动重试旧结论由当前 docs 覆盖。工程实现和运行验收分别记账，具体出口仍以 §3–5 及 STANDARDS §13 为准。
