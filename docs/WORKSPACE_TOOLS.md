# 工作区文件与执行工具（0.3.0）

面向“让 AI 编辑、删除、执行文件”的需求，0.3.0 增加了沙箱工作区与五个工具。所有操作都作用
在词典笔本机的 app 私有工作区，`file_exec` 默认关闭，需要用户在设置页显式开启。

## 能力与工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `file_list` | `{path?}` | 列出目录（≤100 项，返回 name/type/size，截断标记） |
| `file_read` | `{path}` | 读取 UTF-8 文本，拒绝二进制/超大文件，输出 ≤2400 bytes |
| `file_write` | `{path,content,append?}` | 覆盖或追加写入，自动建父目录，≤8192 UTF-8 bytes |
| `file_delete` | `{path}` | 删除文件或空目录；工作区根不可删除 |
| `file_exec` | `{command}` 或 `{file,args}`，可选 `cwd/timeoutMs` | 在工作区内执行 shell 命令或可执行文件，输出有界，默认关闭 |

所有路径都是工作区相对路径：拒绝绝对路径、`..`、控制字符、反斜杠、`~`，段长 ≤80、
深度 ≤8、总长 ≤200。执行超时 100–5000 ms（默认 2000），命令文本 ≤512 chars，参数
≤16×200 chars。结果是结构化 JSON，最终仍受 harness 的 4 KiB 结果截断。

## 工作区位置

运行时 `$workspace` 是 app 安装槽目录 `.../mini_app/pkg/<appid>/<slot>/`。工作区推导为：

```text
.../mini_app/pkg/<appid>/data/penagent-workspace
```

这样 app 覆盖安装替换 slot 时不会删除 AI 文件；真实根目录会在“文件工作区”页显示。
若运行时没有 `$workspace`，回退到 `/tmp/penagent-workspace`。

## 平台能力依据（Y02 4.9.7 实测）

- `import('fs')` 可用：`readFile/readdir/stat/exists/mkdir/rm/statfs`；**无 open/write/rename**。
- `import('process')` 可用：Promise 风格 `exec(file, args, options)`，返回
  `{code, signal, stdout, stderr}`，支持 `cwd/timeout/maxBuffer/killSignal`。
- 写入由 `/bin/sh -c` 的 `printf '%s' <quoted> > <quoted path>` 完成（内容经 POSIX
  单引号转义），随后用 `fs.stat/readFile` 校验；没有直接 fs 写 API。
- `/bin/timeout` 存在，所有命令/文件执行都由它限制真实墙钟时间，防止 JS 侧取消
  不能中止子进程的问题。
- 详细原始探针见 `docs/evidence/fs-probe-0.3.0.txt`。

## 实现分层

- `app/src/core/workspace.js`：纯路径/命令/限额校验（可在 Node 单测，无平台依赖）。
- `app/src/services/device/workspace.js`：唯一接触 `fs`/`process` 的适配器；可注入 module
  loader 以便宿主测试；对外暴露 `list/read/write/remove/exec/selftest`。
- `app/src/tools/workspace.js`：五个工具的 schema、validate、输出限幅；不 import 平台模块。
- `app/src/core/runner.js`：把 `workspace` 适配器以窄接口注入工具 context。
- `app/src/pages/workspace/workspace.vue`：根目录、文件列表、运行自检、开发模式 AI 测试。

## 设置与安全

`pa.settings.tools` 新增 `file_list/file_read/file_write/file_delete/file_exec`。前四个默认
开启；`file_exec` 默认关闭。开启后模型仍受每批/每轮/时延/输出预算约束，并且：

- 工作区是唯一可访问根；不接受绝对路径或越界路径。
- 执行命令以工作区为 cwd；不注入 API key；不把 stdout/stderr 直接当协议状态。
- 命令是高风险能力：设置页有明确提示。生产环境按用户开关执行，不做自动重放。
- 执行超时由 `/bin/timeout` 兜底；已经开始的子进程无法保证立即物理撤销，UI 不宣称
  成功撤销。
- 路径检查是字符串规范化 + 目录内约束，不解析符号链接；工作区由 app 自己写入，
  当前不接收不可信第三方写入。后续若共享工作区需补充 realpath 校验。

## 开发模式的真实网络

生产网络仍因 flat HTTP 关闭 TLS 校验、无 HTTP status 而 fail closed（见 VALIDATION）。
为了让 0.3.0 的 AI 文件能力可在真机用合成内容验证，新增了**仅开发模式**的 curl adapter
（`app/src/services/net/dev.js`）：

- 只有 `settings.developmentMode === true`、私有/回环 host、合成 key
  (`test-/mock-/fake-`) 才使用；其他路径继续走 fail-closed 生产 adapter。
- curl 由 `process.exec` 以参数数组调用，`-m` 与 `/bin/timeout` 双重限时；响应写入
  工作区临时文件后读回并删除；只接受真实三位 HTTP status。
- 不记录 URL query、body、headers 或 key；验证后删除 `.net` 临时目录。
- 这不是生产安全 network adapter，也不解锁真实 endpoint。生产仍需要 native/独立验证
  安全 adapter。

## 验证

宿主：

- `app/test/workspace.test.mjs`：路径/命令纯函数、工具 schema、适配器注入、harness
  工具环、真实 HTTP mock 的 3 次请求 5 次工具闭环。
- `app/test/net-dev.test.mjs`：开发 curl adapter 的状态、清理、私有 host/合成 key 闸门、
  超时与取消错误。
- 0.3.0 全量：legacy 5/5 + node 121/121，Python 策略 22/22。

真机（Y02 / 4.9.7 / appid 8002026100700001，ADB 连接）：

- `运行自检`：写入、读取、追加、列目录、执行、退出码、删除文件/空目录，
  `[pa:workspace] selftest {"ok":true,"steps":9}`。
- 开发模式“AI 文件测试”：LAN 合成 mock 返回 3 次模型响应，模型调用
  `file_write/file_read/file_exec/file_write/file_delete`；最终 `notes/keep.txt` 内容为
  `kept by synthetic AI`，`notes/ai.txt` 已删除，`toolCalls=5`、状态 `completed`。
- 证据：`docs/evidence/workspace-device-0.3.0.txt`，截图在 `app/artifacts/`（0.3.0 轮）。

真机未验证：真实 endpoint 的 AI 文件操作（生产网络闸门未开）、多 profile、IME 下的
文件路径编辑（当前路径由模型参数提供，不需要键盘）。
