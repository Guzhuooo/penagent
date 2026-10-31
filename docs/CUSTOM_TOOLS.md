# 自造工具与工具识别（0.3.0）

本文件记录 penagent 在 0.3.0 加入的“模型自己创造工具 / 识别工具”能力。代码入口：

- `app/src/tools/custom.js`：声明式 recipe 校验、执行器、持久化、识别排序。
- `app/src/tools/registry.js`：`define_tool`、`delete_tool`、`list_tools` 三个元工具。
- `app/src/core/index.js`：动态 registry 与 `loadCustomTools/listTools/findTools/...`。
- `app/src/pages/tools/tools.vue`：工具目录、识别搜索、自定义工具删除。

## 安全边界

模型只能提交**声明式 recipe**，不能提交 JS 源码、`eval`、`Function`、shell 或任意 import。
所有参数先在本地按 JSON Schema 子集校验，再执行固定实现。recipe 自身有独立限额：

| 项 | 限制 |
|---|---|
| 自定义工具数量 | 8 |
| 单条 recipe JSON | 2048 UTF-8 bytes |
| 工具目录 | 16384 bytes |
| 名称 | `^[a-z][a-z0-9_]{2,31}$`，不得与内置/元工具重名 |
| 描述 / 关键字 | 200 chars / 8 × 32 chars |

持久化位置为 storage key `pa.customTools`，版本化 envelope：

```json
{ "version": 1, "tools": [ { "version": 1, "name": "bmi", "description": "...",
  "kind": "compute", "spec": { ... }, "keywords": ["bmi"], "createdAt": 1790000000000 } ] }
```

损坏、超限、未知字段、旧版本都显式失败为 `STORAGE_ERROR`，不会静默丢弃或覆盖。

## recipe 类型

| kind | spec | 调用参数 | 行为 |
|---|---|---|---|
| `lookup` | `{ entries: [{ key, value }] }`，1–32 条，key/value 1–64 / 0–512 | `{ key }` | 精确查表，返回 `{found,value}` |
| `compute` | `{ expression, variables: [{name,min?,max?}] }`，≤4 变量；表达式中用 `{name}` 占位 | 每个变量一个 number | 校验有限数值后替换占位符，交给受限 calculator 求值 |
| `template` | `{ template }`（≤300，含 `{value}`） | `{ value }` | 字符串模板替换 |
| `text` | `{ operation }` ∈ `upper/lower/length/reverse/trim` | `{ text }` | 文本变换；length 返回码点长度 |
| `convert` | `{ family }` ∈ `length/mass/temperature` | `{ value, from, to }` | 固定单位表 / 温度公式，结果保留有限性 |

示例（模型可一次调用 `define_tool` 创建）：

```json
{"name":"bmi","description":"Calculate BMI from weight (kg) and height (m).",
 "kind":"compute","spec":{"expression":"{weight}/({height}*{height})",
 "variables":[{"name":"weight","minimum":1,"maximum":500},
              {"name":"height","minimum":0.3,"maximum":3}]},
 "keywords":["bmi","体重","身高"]}
```

## 工具识别

`list_tools({query?})` 是识别入口：

- 无 `query`：返回有界工具目录（名称 / 描述 / 来源 builtin|meta|custom）。
- 有 `query`：返回相关度最高的至多 5 个工具，含 `score` 与 `reason`（name / keyword / description）。
  排序规则确定：名称精确命中 100，名称子串 60；关键字、名称、描述分别加权；
  中文按二元组匹配，输入上限 256 chars，工具数有界，因此无阻塞搜索。

页面还会在“工具”页展示识别结果；识别只是给模型/用户候选，不改变权限开关。

## Harness API

`createHarness` 新增方法：

```js
await harness.loadCustomTools();          // 读取并校验 pa.customTools
await harness.createCustomTool(record);   // 与 define_tool 同源校验 + 持久化
await harness.deleteCustomTool(name);     // 只能删自定义工具
await harness.listTools();                // 工具目录
await harness.findTools('换算 单位');       // 识别结果
```

`run()` 每次模型迭代重新解析 registry，因此同一轮里定义的 recipe 会在下一次模型请求的
`tools` 中出现；自定义工具默认启用，删除即禁用。`toolEnabled` 对显式 `false` 仍返回 false，
`execShell` 还要求独立的 `execShellEnabled` 总开关。浏览器/宿主测试不证明 QuickJS 兼容。

## UI

- 工具页按 builtin / meta / custom 分组；自定义工具二次点击确认删除。
- 识别按钮走系统输入法，只显示受控结果。
- 自定义工具参数与结果仍受每批 8 调用、每轮 24 调用、4 KiB 结果截断和 120s 预算约束。

## 验证

- `app/test/custom-tools.test.mjs`：recipe 校验、执行、持久化重启、损坏存储、限额、
  目录/识别排序、3 次模型请求的 define→调用→回答闭环、禁用与未知工具错误。
- `app/test/source-contract.test.mjs` 与 UI 测试：无 emoji、无平台直调、页面输入法清理。
- 0.3.0 宿主全量测试通过（121/121 node + 5/5 legacy，见 `docs/VALIDATION.md`）。
- 未在真机上用真实 LLM 验证 recipe 创建；设备侧验证受生产网络闸门限制，见 VALIDATION。
