# 设备探测成果速查（Y02 · 2026-10-05 ~ 10-07）

> 定位：`DEVICE_PROFILE.md` 是**静态画像**（身份/ABI/屏幕/JSAPI 名录），
> 本文件汇总**动态探测与运维成果**——怎么操控设备、怎么取证、什么能用什么不能用。
> 跨设备对照来自 `D:\douyin\douyin\douyin\HANDOFF.md`（CV1826 机型）与 `_recon/penbili`。

---

## 1. 笔上工具箱盘点（能直接用的）

| 工具 | 状态 | 用途 |
|---|---|---|
| `perl` | ✅ **有**（系统自带） | **触控注入**（见 §2）、临时脚本；跑时加 `LC_ALL=C LANG=C` 压掉 locale 告警 |
| `busybox` | ✅ | 全套 applet（`awk/sed/xxd/printf/...`） |
| `evtest` | ✅ | 看输入设备能力（轴范围/键值） |
| `gst-inspect-1.0` / `gst-launch-1.0` / `gst-discoverer-1.0` | ✅（1.22.0） | 解码链路验证（`tools/remote/gstprobe.sh`） |
| `ffmpeg` | ✅ | 格式/流探测 |
| `curl` 7.79.1（OpenSSL 1.1.1l） | ✅ | HEAD 探测、带 header 的接口测试 |
| `modetest` | ✅ | DRM/connector 枚举（miniapp 持 master 时外部画不上去） |
| `python3` / `lua` / `xxd` / gcc 系 | ❌ 无 | 复杂脚本逻辑放宿主机跑，笔上只留最小 glue |
| `/bin/sh` | busybox ash | 脚本要用 POSIX 语法，`function`/数组不可用 |

**输入设备清单**（`/proc/bus/input/devices`）：触摸屏 = `sitronix_ts_spi` →
`/dev/input/event4`（`/dev/input/by-path/sitronix_ts_spi`）；另有 pwrkey、gpio-keys、
`fake-keys`（event8）、gsensor 等。节点权限 0666，**注入无需提权**。

## 2. 触控注入（远控点击/滑动，已校准可用）

- 原理：向 `event4` 写 24 字节 `input_event`（perl `pack 'qqSSl'`，即
  `tv_sec/tv_usec/type/code/value`），发 ABS_MT 系列 + `BTN_TOUCH` + `EV_SYN`。
- 轴范围：**X 0..279，Y 0..935**（面板原生竖向），多指 slot 0..1。
- **坐标映射（实测校准）**：逻辑 (lx,ly) 936×280 → 面板 (rx,ry) 用
  **`rx = ly; ry = 935 - lx`**（即 270° 旋转，cfg.json `tp_direction=270`）。
  校准方法：对四个映射假设各点同一个按钮、看日志哪个假设触发了对应行为。
- 事件序列：`SLOT 0 / TRACKING_ID 1 / X / Y / TOUCH_MAJOR / PRESSURE / BTN_TOUCH 1 / SYN`
  → 保持 60ms → `TRACKING_ID -1 / BTN_TOUCH 0 / SYN`；滑动按 12 步插值发 move。
- 封装：`tools/remote/pen.sh tap|swipe`（逻辑坐标）、脚本在 `tools/remote/pentap.pl`。
- `miniapp_cli injectKey <keyCode>` 也存在（按键级，未用于触控）。

## 3. `miniapp_cli` 命令速查（`--help` 实录 + 实测）

```text
install <amrPath>        覆盖安装；A/B 槽位(/pkg/<appid>/a|b)交替展开，日志报哪个槽
uninstall <appid>
start <appId> <page>     ⚠️ page 必须显式传且不能带 -- 前缀（--index → 找 --index.js → 黑屏）
startService <appId> <service>   三方应用对系统服务未授权（实测 not authorized）
debugApp/debugService <appId>    设定 devtool/内存调试目标
memoryUsage / memoryUsageGC      QuickJS 内存（GC 前后差值做泄漏判据）
dumpMemory                       快照到 /tmp/httpdump.snapshot
capture <path>                   截图 {"ret":0}，936×280 PNG（只截 UI 层，见 §5）
captureFB <path>                 本机不可用（无 /dev/fb0），恒 ret=-1
beginMonkey / stopMonkey         猴子测试
injectKey <keyCode>
setRenderConfig <key> <value>
```

- **`start` 返回 `{"ret":0}` ≠ 页面挂载成功**——必须截图或看日志
  `PageLifecycle->onStart ... _pageName=<page>` 确认。
- 安装后日志里 `/pkg/<appid>/x/libs/ is not a directory` 是**常态**（我们不打 .so），勿误判。

## 4. 应用数据落盘格式（可 adb 直接读写）

- 路径：`/userdisk/secondary/miniapp/data/mini_app/pkg/<appid>/data/sharedpreferences/preferences.json`
- 格式：**扁平 JSON 对象**，`{ "<key>": "<字符串值>" }`；我们存的是
  `{version:1, data:...}` 的 JSON 字符串（`storage/schema.js`）。
- 用途：PC 登录工具直接往里写 `pd.douyin.auth`（`tools/login/douyin_qr_login.py`）。
  ⚠️ 写回必须**整体重写文件**且保持合法 JSON，脚本已做「读回校验」。

## 5. 截图与「是否在播」取证

- `capture` 只截 **UI 合成层**；`<video>` 实际播放时画面在硬件叠加层 →
  **播放中视频区全黑是正常现象**；反而在「卡在首帧」时能截到那一帧。
  ⛔ 不要用「截图有画面/全黑」判断播放成败。
- **判据三件套**（adb 一条命令内取差值）：
  ```sh
  i1=$(awk '/rkvdec/{print $2}' /proc/interrupts); r1=$(awk '/wlan0/{print $2}' /proc/net/dev)
  sleep 5; i2=...; r2=...   # 在播：rx ≈ 0.9~1.9MB/5s，rkvdec IRQ +100 量级/5s
  ```
- 日志：`/userdata/applog/DictPen_*.log`（主日志，含 `GST_PLAYER`、PageLifecycle、
  console 输出、JSAPI CpuProf）、`YD_PEN_APP.log`。关键行：
  `vv: play|pause|resume|stop|onInfo|onError`、`Seek OK!|Seek failed!`、
  `video_reference`、`Error received from element source: Forbidden`（CDN 403）、
  `CpuProf JSAPI ...ms`（哪些 JSAPI 慢）。

## 6. JSAPI 实测契约（代码里已封装，改代码前对照）

| 通道 | 契约 | 备注 |
|---|---|---|
| `http.request` | 参数 **JSON 字符串** `{url,method,timeout,header,dataType,responseType}`；回调 `{result:"<正文>"}` | 必带 `Referer`+`Accept-Encoding: identity` 否则拿垃圾字节；**间歇性返回污染连接残留** → 换参重试；**响应头不回传**（拿不到 Set-Cookie） |
| `storage.set/getStorage` | 参数 JSON 字符串；set `{key,data,value}`，get 回 `[{"data":"..."}]` 等多种形态 | 未命中按空处理；写串行化 |
| `global.Global.execShell` | 同步执行 shell，返回退出码/bool | 只用于 HEAD 探测（`curl -sfI`），**永不 GET 媒体字节** |
| 视频元素 | `setSrc/setVideoSurface(x,y,h)/play(0)/pause/resume/stop/seekto`，全返回 undefined、无错误事件 | 调用时序见 `docs/VIDEO_PLAYBACK.md` §3 |
| `navTo` | `$falcon.navTo('<page>')` | 页面名区分大小写 |

## 7. 音频

- 声卡：`rockchip-aw883xx`（功放，card0）、`rockchip-pdm-rk817codec-adc`（麦克风，card1）。
- miniapp 播放时 ALSA 设备**独占**：外部进程 `aplay/gst-launch` 报
  `Could not open audio device ... Device is being used by another application`。
  → 外部管线验证视频解码时用 `video-sink=fakesink`；别指望和 app 同时出声。
- 应用内 `<video>` 出声正常（H.264 合一 mp4 自带音轨，真机可闻）。

## 8. 网络环境

- `wlan0` <device-lan-ip>/24；DNS 有**间歇性解析失败**（系统应用也中招：
  `Could not resolve host: dict.youdao.com`）→ 应用层重试是必要的。
- 抖音：网页接口 + douyinvod 直链免签名可达（契约见 `docs/API_RECON.md`）；
  部分 hot 话题的 `related` 返回空（风控按话题抽风），UI 要兜底。
- 外部 URL 探测模板：`curl -sfI -m 6 -o /dev/null '<url>'`（-f 让 4xx/5xx 非零退出）。

## 9. ADB / 宿主机环境坑

1. Git Bash 下 `adb push x /tmp/` 会被 **MSYS 路径转换**污染
   （推到 `C:/Users/.../Temp/`）→ 统一 `export MSYS_NO_PATHCONV=1`（pen.sh 已内置）。
2. USB + TCP 双端点并存会 `more than one device` → `adb disconnect <tcp地址>` 收口。
3. 设备休眠会掉 adb；`adb kill-server && adb start-server` 重连；
   若提示认证，人工跑 `adb shell auth`。
4. 笔上跑 perl 脚本先 `adb push`（Windows 路径要 `cygpath -w`，pen.sh 已处理）。

## 10. 跨设备对照（为什么结论不能照抄）

| 事实 | CV1826 机型（字节全家桶） | Y02（本机） |
|---|---|---|
| `<video>` 组件 | ❌ 无 → 必须随包 native FFmpeg 模块直写 fb0 | ✅ 有（GStreamerVideoView） |
| `/dev/fb0` | ✅ 存在 | ❌ 不存在（captureFB 恒失败） |
| 固件 FFmpeg TLS | ✅（原生模块可直连 https） | —（无 native 模块需求） |
| 32 位 .so | 能用（设备是 32 位） | **dlopen 必失败**（运行时 64 位）；PenBili 的 libjsapi_player.so 即此坑 |
| 逻辑屏 | 800×254 | 936×280（1vw=9.36px、1vh=2.8px，逐像素实测） |

**教训**：任何「某台笔上验证过」的结论，换机型必须重新探测；
`libs/*.so` 装包前必查 `file`/`readelf` 的架构与解释器。

## 11. 已探测未关闭（下一步probe清单）

- 系统输入法 `startTextEdit` / `<textarea softInput>` 的 confirm/cancel 返回形态
  （`chat` 页已接，边界值未系统测）。
- `<hole>` 组件、DRM plane 细节（当前用不上，不阻塞）。
- `memoryUsageGC` 基线与「两次进出」泄漏差值。
- `injectKey` 键值表、`setRenderConfig` 可配项。
- `beginMonkey` 是否对三方应用生效。
