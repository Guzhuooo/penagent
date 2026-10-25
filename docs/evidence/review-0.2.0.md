# 0.2.0 限定范围独立复核

日期：2026-10-17。复核为只读源码及宿主 JavaScript 行为验证，不是真机验收。

## 审查范围与结果

已复核关闭：

1. 首次发送在创建会话后丢草稿及空标题。
2. 停止后等待中的旧 send 继续启动模型请求。
3. 停止后完整工具组未进入会话持久化。
4. 配置未加载时清密钥/保存覆盖原配置，以及 hide/show 后不重新加载。
5. 已产生部分副作用的工具 ID 未持久保留，可在取消后重复执行。
6. core 到 platform storage 的第二队列未透传取消/期限 guard，停止后才发出 native 写。
7. 后续新增：旧 newSession/selectSession/openSettings 等待清理后借用新 send 的 generation，导致错误切换及文本清空。

复核报告结论：本次限定范围内无未关闭 Critical / Important；不代表整个应用不存在其他缺陷。

## 独立复现实验

- 最新定向 5 文件 81/81，0 fail，exit 0。此数是定向复核数，不是最终全套数。
- 同 realm SFC + 真实 createHarness + 内存 storage，阻塞旧清理后依次交错新建/切换/设置与发送：完整长于标题限额的文本仍进入请求及重载会话，没有迟到导航或切换，dirty=false。
- reserved 持久化阻塞时 stop，并分别叠加普通停止、hide/show、hide/unload：note 写均为 0，保存顺序为 reserved 后 cancelled，内存及重载 ledger 均 cancelled。
- 主协调者最终完整测试另见 js-tests-0.2.0.txt：旧 5 项 + Node 93 项。

## 保留的非阻塞限制

会话索引 commit 失败可能留下孤立 chunk。4 MiB 是已提交索引历史预算，不是底层全部存储的物理上限；当前没有自动孤立块垃圾回收。UI 保存失败时保留 dirty 并阻止通常的新建/切换，但不能据此声明底层存储无累积。

复核期间未修改文件、未执行 C/C++ configure/build/link/test、未上传仓库或 SDK。
