# 插件规范（penagent-plugin/1）

0.6.0 起支持“先装应用本体，再装插件/工具”：插件是**数据包**，不是可执行代码。
不需要重装 AMR，也不需要重新编译；把插件 JSON 放进工作区 `plugins/` 后，在
“工具”页点“重新加载插件”即可热加载。

## 1. 文件位置

```text
<应用私有工作区>/plugins/<name>.json
```

工作区根路径在“文件工作区”页显示（例如
`/userdisk/secondary/miniapp/data/mini_app/pkg/8002026100700001/data/penagent-workspace`）。
只扫描该目录下一层的 `*.json`，最多 64 个文件，每个 ≤ 64 KiB；不递归、不执行 JS。

## 2. 插件 JSON

```json
{
  "schema": "penagent-plugin/1",
  "id": "com.example.weekday",
  "name": "Weekday Pack",
  "version": "1.0.0",
  "description": "Adds a weekday lookup tool.",
  "prompt": "When asked for a weekday, use weekday_cn.",
  "tools": [
    {
      "name": "weekday_cn",
      "description": "Map an English weekday to Chinese.",
      "kind": "lookup",
      "spec": {
        "entries": [
          { "key": "monday", "value": "星期一" },
          { "key": "tuesday", "value": "星期二" }
        ]
      }
    }
  ]
}
```

字段约束：

| 字段 | 约束 |
|---|---|
| `schema` | 必须是 `penagent-plugin/1` |
| `id` | `[a-z0-9][a-z0-9._-]{2,63}`，全局唯一 |
| `name` | 1–64 字符，仅字母/数字/点/下划线/连字符/空格 |
| `version` | `x.y.z` 数字段 |
| `description` | 1–200 字符 |
| `prompt` | 0–4096 字符；加载后追加到系统提示词（不覆盖用户提示词） |
| `tools` | 1–32 个，名称全局唯一且不能与内置/元工具冲突 |

工具 recipe 与 `define_tool` 完全相同，仅支持五种安全类型：

- `lookup`：`spec.entries[]`（key 1–64 字符，value ≤512，最多 32 项）
- `compute`：`spec.expression` + `spec.variables[]`（只允许数字/括号/`+ - * / %`）
- `template`：`spec.template`，只允许 `{value}` 占位符
- `text`：`spec.operation`，支持 trim/lower/upper/length/reverse 等固定操作
- `convert`：`spec.family`，固定单位族

插件不能包含脚本、eval、动态 import、网络地址、文件路径或原生库；`tools[].spec` 里的
未知字段一律拒绝。插件工具仍受全局工具开关、参数 schema、结果长度和执行期限约束。

## 3. 安装 / 热加载

1. 通过文件工具、`adb push` 或工作区页面把插件 JSON 写到 `plugins/`；
2. 打开“工具”页 → “重新加载插件”；
3. 页面显示插件数、工具名、错误列表；插件工具出现在“插件工具”区；
4. 下一轮对话/模型请求会带上插件工具和插件 `prompt`，无需重启应用。

一个坏插件不会让应用崩溃：该文件会显示错误（`ARGUMENT_ERROR` / `LIMIT_REACHED` 等），
其它插件继续加载。删除插件文件后再点重新加载即可卸载。

## 4. API（应用内部）

`getApplication()` 暴露：

```js
await application.loadPlugins();      // 首次加载（幂等）
await application.reloadPlugins();    // 热重载，返回 {available, plugins, errors}
application.pluginCatalog();          // 当前插件/错误快照
application.listTools();              // 包含 origin='plugin' 的工具
```

插件工具在内部仍以 `origin: 'plugin'` + `pluginId` 标记，便于工具页和审计区分。

## 5. 边界

- 插件是声明式工具/提示词，不是任意 JS 代码；要新增原生能力必须走 native JSAPI + CI 审计。
- 热加载只改变当前应用的插件快照；会话历史里已经发生的工具调用不会被改写。
- 插件 `prompt` 会进入每次模型请求；不要把密钥、设备隐私或不可信指令放进插件文件。
- 插件目录属于应用私有工作区，不应放入系统敏感文件；卸载 AMR 时随之删除。
