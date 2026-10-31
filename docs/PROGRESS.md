# penagent · 工作日志（PROGRESS）

> 规则：**每做一步必记录**——时间、做了什么、命令、证据、结论/下一步。
> 新条目加在最上面。设备实测推翻文档时：先改文档，再改代码，并在本文件记一条 `[修正]`。

---

## 2026-10-31 · 0.3.0：emoji/图标、自造工具、工作区文件执行与设备验收

### R09 · 恢复现场、AI 文件工具闭环与最终预览包
- **用户新要求**：继续完成应用，验收至少让 AI 编辑/删除/执行文件；目标机已用 ADB 连接；避免占用电脑资源导致卡死。执行策略：少并行、短命令、C/C++ 仍只在 GitHub Actions；设备侧用 ADB 完成安装/自检/截图/日志取证。
- **恢复现场与基线修正**：上轮工作区遗留 `services/device/development.js` 的临时 LAN 地址 `http://<device-lan-ip>:8787`，导致 source-contract 测试失败（预期 127.0.0.1）。先改回 `http://127.0.0.1:8787`，基线恢复 legacy 5/5 + Node 93/93；随后并入上轮已完成但未收尾的 emoji 替换（`assets/icons.js` 内联 PNG、settings/session-rail、测试 fixture 4-byte 非 emoji 码点、`✅❌⚠⛔` 文档文字化、source-contract 禁 emoji）与自定义工具/识别（`custom.js`、`define_tool/delete_tool/list_tools`、`pa.customTools`、tools 页）。
- **平台能力实测（只读/诊断）**：临时 `pages/fsprobe` 在 Y02 实测 `import('fs')` 可用（readFile/readdir/stat/exists/mkdir/rm/statfs，**无 open/write/rename**）、`import('process')` 可用（Promise `exec(file,args,options)` → `{code,signal,stdout,stderr}`，execFile 语义）、`/bin/timeout` 存在、`$workspace` 为安装槽目录；无 fs 写 API，写文件用 `/bin/sh -c "printf '%s' <quoted> > <path>"` + fs 校验。探针页在取证后从最终包移除，原始记录见 `docs/evidence/fs-probe-0.3.0.txt`；DEVICE_PROBING §12 归档。
- **实现**：新增 `core/workspace.js`（纯路径/命令/限额）、`services/device/workspace.js`（唯一接触 fs/process 的适配器，可注入 module loader）、`tools/workspace.js`（file_list/file_read/file_write/file_delete/file_exec）、`pages/workspace`（根目录/列表/自检/开发模式 AI 测试）；`config.js` 增加 5 个工具开关（file_exec 默认关闭）、`runner.js` 注入 `ctx.workspace`、settings 页增加开关与高风险提示、tools 页增加文件工作区入口。开发模式真实网络：`services/net/dev.js` 仅对 developmentMode + 回环/私网 + 合成 key 用设备 curl，返回真实 status，带 `-m`+`/bin/timeout`、响应上限、`.net` 临时文件清理，不记录 body/header/key；生产/其他路径继续 fail closed。
- **TDD / 失败修正**：(1) dev adapter 把 20000ms 传给工作区执行，超过工具 5000ms 上限→`ARGUMENT_ERROR`；拆分 `execTimeoutAdapterMaxMs=25000`，工具 schema 仍 5000。(2) 工作区页把 file_read 结果误显示为“写入”；调整判断顺序为删除/读取/写入/执行。(3) `Set-Content` 在 `app/package.json` 与 `app/test/net-dev.test.mjs` 写入 UTF-8 BOM，`verify-amr.py` 报 Unexpected UTF-8 BOM；剥离 BOM 后两个 AMR 校验通过。(4) 测试 fixture 新出现 😀，替换为 U+1D11E 保留 4-byte 覆盖。(5) 覆盖安装后未重启旧 realm 的一次 AI 重试返回 error/toolCalls=0；干净卸载/安装后同一包闭环成功，记录为运行态限制，不当作产品通过。(6) `.net` 空目录清理加入 dev adapter finally。
- **宿主验证（最终源码）**：`node app/test/all.mjs` 退出0，legacy 5/5 + Node **124/124**，0 fail/cancelled/skipped（`docs/evidence/js-tests-0.3.0.txt`）；`python -m unittest discover -s tools/tests -p 'test_*.py'` **22/22**（`docs/evidence/ci-policy-tests-0.3.0.txt`）。新测试覆盖：路径穿越/命令引用/限额、工具 schema 与输出截断、适配器注入、真实 HTTP mock 3 请求 5 工具闭环、dev curl 私网/合成 key/清理/超时、自造工具持久化/识别/损坏存储。
- **构建与包**：`npm --prefix app run build` 与 `build:prod` 均退出0；`verify-amr.py` 两包均通过（10 个证书资源、无 `.so`）。debug **455247 B / SHA-256 37431def3660afbd262226ff4016c3199bd9362e7f705904f049e3ce753f49d5**；production 构建模式 **443721 B / SHA-256 86d0a93298359463b880aeb61ff086a6191b15799728c658af5a5b4e9f15d972**；日志 `docs/evidence/build-*-0.3.0.txt`、`amr-*-0.3.0.json`。
- **真机验收（Y02 / 4.9.7 / ADB <device-serial>）**：干净卸载/安装 0.3.0 debug 均 ret:0；启动 `workspace` 页。`运行自检` 产生 `[pa:workspace] selftest {"ok":true,"steps":9}`（写/读/追加/列目录/执行/退出码/删文件/删空目录）。开发模式 LAN 合成 mock 驱动 3 次模型 POST（mock 记录 5055/6388/7214 bytes、authorized=true），设备 `[pa:devnet] curl` 3 次后 `[pa:workspace] ai-file-test {"status":"completed","toolCalls":5}`；实际执行 file_write/file_read/file_exec/file_write/file_delete，最终 `notes/keep.txt` 内容 `kept by synthetic AI` 留存、`notes/ai.txt` 不存在。截图 `app/artifacts/0.3.0/final-selftest.png`、`final-ai-lines2.png`、`settings-file-tools.png`、`tools.png`、`chat.png`；证据 `docs/evidence/workspace-selftest-0.3.0.txt`、`workspace-ai-test-0.3.0.txt`、`workspace-device-0.3.0.txt`。取证后把设备设置恢复为空生产配置（无 key/URL/dev 模式、file_exec=false），清理 notes/.net，并停止 mock。
- **文档**：README/PLAN/STANDARDS/VALIDATION/DEVICE_PROBING 更新；新增 `docs/CUSTOM_TOOLS.md`、`docs/WORKSPACE_TOOLS.md`、`app/src/core/README.md` 工具/适配器/限额章节；`tools/verify-amr.py` 必需页加入 tools/workspace；`tools/mock-openai.mjs` 增加 `synthetic-files` 场景；`docs/evidence/source-sha256-0.3.0.json` 记录 142 个源文件 SHA。
- **GitHub Actions / native**：私有仓库 `Guzhuooo/penagent` 与 `.github/workflows/native-compile.yml` 已有三次绿色 run（40168576908 / 40168752041 / 40169416478；JS 93/93、策略 22/22、宿主 CTest 1/1、AArch64 compile-only ELF64/AArch64）。所有 C/C++ 编译仅在 Actions，未在本机执行；设备 `.so` 仍阻塞于获批 toolchain/sysroot bundle，native-manual 保持 disabled。
- **结论 / 仍未关闭**：0.3.0 的 AI 编辑/删除/执行文件能力在真机（合成开发流量）完成闭环；生产真实 endpoint、生产安全 network adapter、TLS/redirect/status/期限、IME 取消/重复开关、两次进出内存差、多分辨率、native `.so` 构建/加载均未通过。开发 curl 仅限合成/私网，不能解锁生产。下一步：最终源码推送 + CI 复跑、继续生产安全通道与设备矩阵验收。
- **最终推送与 CI（网络恢复后）**：本机 hosts 曾把 `github.com` 解析到 `127.0.0.1`，push/gh 被拒；
  网络恢复后 `git push origin main` 成功（`824ffaf..bc01903`），触发 `native-compile.yml`。
  手动 run [41175666914](https://github.com/Guzhuooo/penagent/actions/runs/41175666914)
  两 job 全绿：JS **124/124**、Python 策略 22/22、宿主 CTest 1/1、AArch64 compile-only
  ELF64/AArch64；同为该 commit 的 push run 41175661246 被并发策略取消（cancelled，非失败）。
  证据下载到 `docs/evidence/ci-native-0.3.0/run-41175666914/`。设备 `.so` 仍阻塞于获批
  toolchain/sysroot bundle，native-manual 保持 disabled。

---

## 2026-10-17 · 续接核验与纠错

### R08 · 页面交错回归、最终宿主验证与预览包归档
- **先红后绿**：新增 `app/test/ui-regression.test.mjs`；首次发送原文由预期 FIRST-DRAFT 变空、等待 cleanup 后 stop 仍请求 1 次均实测失败。修首 await 前快照文本与预约 generation/busy、内部创建初始会话不清草稿、完整事件同步 session/dirty、按原 session 保存停止收尾、settings loaded/loading 门禁与 hide/show 重读后回归通过。
- **真实 core+UI**：以实际 createHarness 与内存 adapter 验证 reservation 在 note 效果前落盘、重启 audit 防 ID 重放、保存 pending 时 stop 的 note 写 0 次与 cancelled ledger。VM/SFC 测试和 core 分属不同 realm，测试边界显式 structuredClone，与设备同 realm 运行区别记录在用例注释；不放松生产普通对象验证。
- **二次审查发现与修复**：独立复核新增旧 newSession 等待 stop 后借用新 send generation、清空消息的 Important；回归先出现 created=2（预期1），修 newSession/selectSession/openSettings 首 await 前 token、send 使用固定 session history 后通过。独立复核用同 realm SFC+真实 core 重现较早新建/切换/设置被后发 send 替代，完整原文请求/落盘正确，无迟到导航；原六项及新增项均关闭，限定范围无未关闭 Critical/Important。
- **最终实际命令与观察**：`node D:/penagent/app/test/all.mjs > docs/evidence/js-tests-0.2.0.txt 2>&1` 退出0，完整日志已读：旧 runner **5/5**，Node **93/93**，0 fail/cancelled/skipped。`python -m unittest discover -s D:/penagent/tools/tests -p 'test_*.py'` 退出0，完整日志已读 **22/22**。独立复核定向81/81不是额外总数。whitespace源码检查0错误；根目录不是git仓库，未声称git diff/check或工作树干净。
- **构建**：最终源码修复后依次执行 `npm --prefix D:/penagent/app run build:prod` 和 `run build` 均退出0；保存两份CLI原产物，不用ZIP重打包。保留 theme-default 缺失、外部native模块global、Node http_parser警告；测试MockTimers有实验性警告。`python tools/verify-amr.py <包>` 两份均通过身份/入口/图标/6脚本size+MD5/无so校验，hardwareAcceptance=pending。
- **最终产物**：debug `app/artifacts/0.2.0/penagent-0.2.0-debug.amr`，426756字节，SHA-256 `bed013a789cade131dbc5203001597c024425e2d4ce30e6b9c926b4a2ab56029`；production构建模式 `penagent-0.2.0-production.amr`，420045字节，SHA-256 `fe24f677d202efeb3fd572515ab7d89072c2114599f071d1fd18b116e349dbb5`。两包均为0.2.0预览，不代表生产能力或真机通过。生成source SHA快照；dev origin再次确认为127.0.0.1，无临时LAN地址。
- **清理**：成功stop临时0.0.0.0:8787 mock task，并只读检查监听数0。只读确认历史防火墙 Name `{750A4680-D434-48CF-AD2E-70ADF02FD95A}` / `penagent-mock-8787`、TCP8787、remote<lan-subnet>；严格匹配后 Remove-NetFirewallRule 失败Windows Error5拒绝访问，未提权/重试，规则仍需管理员清理。
- **文档/边界**：同步README/VALIDATION/PLAN及core adapter合同，逐步证据含 review-0.2.0.md、source-sha256-0.2.0.json。记录孤立chunk非阻塞限制：index commit失败会留下未索引数据，4MiB是索引历史预算，不是底层物理配额；无自动GC。
- **仍阻塞**：再次 `adb devices -l` 为空，本轮新版未push/install/start；没有真实key/endpoint对话、IME/内存/多尺寸真机验收。flat安全静态不合格，生产仍fail closed。native policy disabled，未获具体repo/可见性/上传范围授权；未创建仓库、push、上传、触发Actions，未执行任何本地C/C++ configure/build/link/test。Actions方案准备完成不等于native完成。
- **最终归档复核**：重新运行两份 `verify-amr.py` 均通过；Python核对测试日志93/93+旧5、manifest字节/SHA与VALIDATION/PROGRESS一致、native policy仍disabled，源码/文档whitespace通过。更新源SHA快照仅为对应源码指纹，不充当锁定重建或设备证据。
- **结论**：本轮可完成的宿主修复/测试/预览构建与文档记录已归档。完整设备可运行及安全生产网络目标尚未交付，不用宿主成功或production构建名称替代真机/安全验收。

### R07 · 页面 / 审计 / 排队取消分项修复与独立验证（待 R08 最终集成）
- **来源 / 边界**：协调者在本轮文档编辑期间提供的已实施修复和独立验证结果；文档编辑者未重跑这些测试，不代表最终汇总或真机通过。R06 的“待修”保留为当时状态，由本条分项续接，不回写成 review 当时已修。
- **页面已修复**：chat 文本在首个 await 前快照，并用 send reservation 防止 stop 后再发起；完整 event 同步 session dirty，stop 按 session owner 保存历史；loaded settings 门禁与 hide/show retry 已补。
- **ledger / 审计已修复**：hook 在任何副作用前为整批 audit reservation 串行落盘；core 新增 toolAudit，容量 256 且不淘汰，防止删除旧 ID 后重放。hook 保存失败、返回 false 或取消均零执行。新 usedToolIds/hook/storage guard 的详细接口由主 agent 更新 core README。
- **排队取消已修复**：storage 二次排队在 cancel/timeout 后原生写调用为 0，避免已失效排队任务继续写入。
- **独立验证快照（非最终总数）**：核心代理终验 69/69（core 53、storage 9、core-integration 7），另有旧 5/5；主 agent UI 8/8 通过。这些是来源明确的分组结果，不能合并推导当前全套数量。
- **仍待关闭**：真实 core+UI 的持久 / 重启 / 取消回归及全测正在补，由主 agent 在 R08 记录最终命令、结果、数量和 AMR SHA；本条不填最终总数或产物 SHA。
- **设备 / 操作边界**：协调者再次 `adb devices -l` 为空。无新版真机验收；本轮文档编辑未连接 / 重 hash、未做证书测试、未编译 / 上传 / 触发远程 run。

### R06 · [修正] flat HTTP 静态安全不合格；review 待修发现
- **目标 / 方法**：读取当前七份授权文档及提供的最新只读反汇编结果，纠正“仅未验证”和“总 timeout 10s”；未重新反汇编、未执行请求。当前 ADB 断开，未重新核对设备 hash。
- **绑定证据**：历史匹配设备的 `libfalcon.so` SHA-256 `91e23dcef405d849e17757656cd2603ecc21cc9d20437bf38937c6b13b664a58`；`HttpApiExtension::request @0x7577f0`、size `0x3ce8`，flat 注册 `0x753728`。
- **静态发现**：FOLLOWLOCATION(52)=1 @0x757934；SSL_VERIFYPEER(64)=0 @0x75794c；SSL_VERIFYHOST(81)=0 @0x757964；CONNECTTIMEOUT_MS(156)=10000 @0x75797c；TIMEOUT_MS(155)=100000 @0x757998。连接 **10s**、总计 **100s**，旧“总计 10s”作废。只读 url/header/method/data，无 caller TLS/redirect/timeout/signal，未发现该路径 abort。
- **状态合同**：CURLINFO_RESPONSE_CODE @0x75a19c 后仅接受 200/201；success `{result:'response text'}` 无 HTTP status。error `{result:{errorMessage}}` 与 proxy error 3 非 HTTP 状态，禁止 scrape / regex 错误文本、默认 200 或用正文自报状态补造。
- **安全结论**：正确对象 data POST 有静态支持但真机送达待验；该 flat 通道已静态确认**生产安全不合格**，不是仅未验。生产必须 native httpx 或其他独立验证安全 adapter，原因不是 POST 不支持。静态证据不等于实际有效 / 无效证书测试，不证明当前断开设备已重新 hash。
- **review 发现（当时待修）**：页面四类问题、ledger 与排队取消问题待修。本轮最初只收到上述类别而非完整问题清单，未自行猜测细项或宣布修复；其后协调者提供的具体已修内容另记 R07，最终回归仍待 R08。
- **文档改动**：同步 PLAN / STANDARDS / SPIKE / VALIDATION / README，重写 post-contract-notes 的安全地址与 10/100s 结论并移除未执行的敏感 payload/echo 日志 helper；旧 appid、密钥、自动重试规划由当前 docs 覆盖。未更新最终测试数量或 AMR SHA；历史分组结果不作为当前汇总。
- **验证 / 下一步**：本轮只做文档一致性、地址 / 常量 / 边界与格式检查，具体结果由文档任务交付回报；不运行应用测试、编译、安装或上传。主 agent 完成 R07 后续真实 core+UI 回归及最终收尾，设备恢复后另取真机证据。

### R05 · 并行核心/存储/文档/CI 集成记录
- **核心**：空配置可编辑保存、发送前 CONFIG_ERROR 零请求；client 透传开发模式与取消；run 输入同步快照；修复信号超时、同步进入adapter取消、cleanup重复调用；损坏存储显式失败，失败设置保留dirty并防旧读覆盖。
- **平台存储**：JSON原样、core单层envelope；只读兼容旧双层；所有读写串行、逐写readback、5s期限、无日志；写超时到迟到ack前fail closed，避免旧写覆盖新写。
- **主线复验**：`npm --prefix D:/penagent/app test` 退出0，旧5/5及当时65/65 Node测试通过（后续增加测试另记最终数）。真实net/storage配模拟Falcon不等于真机。
- **文档/配置**：SPIKE撤回GET-only/native必需；PLAN/STANDARDS删除错误子任务限制、14字符appid、多分辨率/视觉/IME证据边界。profile/remote清除继承业务身份，默认appid由package读取；agent回报bash/mock检查通过，未做设备验收。
- **native/CI**：仅手动触发workflow、固定actions SHA、disabled policy、明确repo/可见性/范围/bundle SHA才能执行；新增安全下载/归档/ELF精确导出校验、CI本机core test+目标module构建方案。`python -m unittest discover -s tools/tests -v` 主线复验22/22通过（纯Python，无C/C++）。未授权repo/SDK/sysroot发布，未push或触发，未本地C/C++ configure/compile/CTest；action SHA在线复核因证书链错误待完成。
- **包检查**：新增只读 `tools/verify-amr.py`，当时0.2.0包manifest/version/6份脚本size+MD5/无so通过；该包在后续source修正前生成，不作为最终SHA，最终重建另记。

### R04 · 安全 mock 与跨平台全套测试入口
- **改动**：mock 不再打印/回显 key、请求正文或用户输入；只接收合成测试 key。新增 shape-only echo 和 calculator+clock 两工具场景。`app/test/integration.test.mjs` 走真实宿主 HTTP 模型→工具→模型，2/2 通过，实际2次POST、2个工具、完整组/会话恢复、日志哨兵均通过。
- **测试入口**：package `test` 初次用 Node20 Windows 不展开的 `test/*.test.mjs`，退出1；改为 `test/all.mjs` 用 Node 枚举文件传给测试进程，避免依赖 shell glob。旧5项不是新增全套测试。
- **命令**：`npm --prefix D:/penagent/app run check` 退出0，仅CLI环境检查（不是源码lint）；`npm --prefix D:/penagent/app run build` 退出0，QuickJS 0.2.0 AMR生成。保留警告：缺省 theme-default、原生外部模块 global、Node http_parser deprecation，不据此声称运行成功。
- **开发网络**：启动只处理合成内容的mock（临时 0.0.0.0:8787），只读确认设备 curl 到当前宿主地址可达，返回 models，rc0。该操作不验证 Falcon HTTP。
- **真机阻断**：随后新版 push 失败 `device not found`，再次 `adb devices -l` 列表为空。本次0.2.0未安装/启动，正确data POST仍待真机复测；未重启ADB/设备或更改系统以掩盖断连。


### R01 · [修正] 原 M0 POST / 视觉结论不能作为验收
- **目标**：复核旧探针是否真的测试了所有 body 字段。
- **证据**：当前旧 net 源码只转发 `opts.body`；`tools/post-contract-notes.md` 记录匹配设备 `libfalcon.so` 的静态控制流：扁平 `http.request`、单数 `header`、对象型 `data`。
- **结论（后由 R06 安全证据补充）**：下方历史「四种字段全部不透传」「纯 JS 无法调 OpenAI」「POST 不支持所以必须 native」「M0 全部完成」均撤回。旧嵌套 Promise 被序列化为 `{}` 也不是 HTTP 结果。R06 已静态确认该 flat 生产安全不合格，生产必须 native 或其他独立安全 adapter；不是再等一次成功 POST 就可决定启用该 flat。
- **范围**：截图文件存在不等于已经视觉审查。IME cancel/重复开关、多分辨率、内存等仍未验收。用户原 appid 是 14 字符，未证明字母被禁止。

### R02 · 当前源码、设备与测试入口核对
- **方法**：读取核心 client/runner、composition、net、UI、package/test 入口；`adb devices -l`，指定目标执行只读 `printf shell-ok; miniapp_cli --help`。
- **观察**：shell 实际可用（不是仅依据 devices 列表）；核心/UI 文件已存在；`npm test` 仍只执行旧五项；mock 8787 已停。网络层仍有错误 body 字段、POST 隐藏重试、ASCII 比例判断、伪造 200 与 parse 正文日志。
- **结论**：先修复合同与回归测试，不把并行实现等同集成通过。无 C/C++ 编译、无远程仓库写入。

### R03 · 网络 adapter 回归：先失败，再修复
- **改动**：新增 `app/test/net.test.mjs`；替换 `app/src/services/net/index.js`。
- **实际命令**：`node --test app/test/net.test.mjs`。初次退出 1（缺能力声明导出）；修复后退出 0，7/7 通过。
- **覆盖**：JSON envelope 的 `data` 是对象且 header 单数；POST 每次仅发一次；中文/emoji 与 UTF-8 byte 上限；未知状态保持 null；无正文/URL/key 日志；取消/迟到回调/超时释放。
- **约束（后由 R06 升级为静态不合格）**：当时尚无真实 HTTP 状态/TLS/redirect/物理取消证据；现已静态确认证书校验关闭、自动 redirect、成功无 status、总期限 100s、无 caller timeout/signal，且未发现该路径 abort。当前仅受控私网/回环开发 mock 与合成内容 / 假凭据，生产 fail closed。逻辑取消/超时后原 native 请求仍可能运行；in-flight guard 等真实回调释放，不伪称撤销计费。
- **待验证**：正确 data 对象真机 POST、核心/全套集成测试、平台安全能力调查、正式构建/安装。

## 2026-10-07（下午）

> 以下原始立项 / 探针记录保留历史，不代表当前验收状态。POST 不支持推断、M0 完成、数字格式限制、密钥和重试旧规划均由当前 PLAN/STANDARDS/SPIKE 及 R01/R06/R07 更正覆盖；生产通道阻塞原因见 R06，最终集成结果待主 agent R08。

### M0 探针真机实测（历史原记录，过强结论已撤回；详见 SPIKE）
- **做了**：mock 服务器起 8787；Windows 防火墙加规则放行 8787（限内网段）；构建/安装/启动探针 app（appid `8002026100700001`）；用 `tools/remote/pen.sh`（pendouyin 移植）注入触控逐项跑探针。
- **证据**：`app/artifacts/probe1-10.png`；DictPen 日志 `grep pa:probe`。
- **结论**：
  - GET + Bearer 自定义 header [通过] 端到端可达；**POST body 四种字段名全部不透传 [失败]**；execShell 只有退出码无 stdout [失败] → 纯 JS 无法调 OpenAI 接口。
  - 存储 set/get [通过]、系统输入法 startTextEdit 确认路径 [通过]（键入 S → 确认 → 写回）、vw/vh [通过]、console.warn 落日志 [通过]（console.log [失败]）。
  - 设备上三方 aarch64 native jsapi 模块（reciter 等）实测存在 → native 路线可行。
- **[修正]** `DEVICE_PROBING.md` §6 的 `global.Global.execShell` 契约需补充：「返回 bool 退出码，无 stdout」已实测确认。
- **下一步**：M0.5 native `libjsapi_httpx` 模块（POST body + 自定义 header + 响应回传），交叉编译走 GitHub Actions（SDK 已由用户提供至 `native/sdk/`）。

### M0 环境与构建链 [通过]
- adb 认证恢复（人工 `adb shell auth`）。
- 宿主 node 20.18.0 / aiot-vue-cli@1.0.32；`aiot-cli -q -p` 出包成功；数字 appid 安装/启动/截图链路全通。
- `app/` 骨架建成（BasePage/net/storage/input 移植自 pendouyin，tag `[pa:]`）；单测 5/5 通过。

### M0：环境确认 [通过]
- **做了**：`adb devices -l` → `<device-serial>  device`（在线，与 DEVICE_PROFILE §1 一致）。
- **做了**：宿主工具链确认：node v20.18.0 / pnpm 10.12.4 / 全局 `aiot-vue-cli@1.0.32`（提供 `aiot-cli`，即 pendouyin 出包所用）。
- **结论**：JS 构建链可用，M0 网关 3（构建链）关闭。设备实测 IP/连通性待探针验证。

### 用户决策补充
- **C/C++ 交叉编译统一走 GitHub Actions**（宿主无 aarch64 工具链）。主线仍为纯 JS；
  该决策解除 native JSAPI 的工具链阻塞，已写入 PLAN.md 决策 #3。

### 立项与规划
- **做了**：通读 `haasui-falcon-app` skill、`DEVICE_PROFILE.md`、`DEVICE_PROBING.md`、
  `D:\pendouyin\docs\STANDARDS.md`、falcon-runtime 参考、`miniapp-app-template/` 结构。
- **结论**：设备画像完整（Y02 / 4.9.7 / aarch64 / 逻辑屏 936×280 / vw+vh 已实测可用 /
  httpbridge 支持自定义 header 待真机复验 / 无宿主交叉工具链 → 纯 JS 路线）。
- **用户决策**：OpenAI 兼容协议；安全工具 + 受限 execShell；纯 JS + httpbridge 底座；
  appid 用户给出 `800Guzhuooo0001`（含字母，与设备 16 位数字格式不符，暂用
  `8002026100700001` 实测，显示名 "Guzhuooo Agent"）。
- **产出**：`docs/PLAN.md`（总规划）。下一步：M0 环境确认与真机探针。
