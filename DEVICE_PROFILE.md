# 设备画像：有道词典笔 Y02 / 固件 4.9.7

> 全部结论来自 2026-10-05 的只读 ADB 探测。原始证据见 `_recon/`。
> 本文件是**唯一事实来源**；任何代码里的尺寸、ABI、路径都必须引用这里。
> 动态探测与运维成果（触控注入、取证判据、miniapp_cli 速查、工具箱盘点）
> 见 `DEVICE_PROBING.md`（2026-10-05 ~ 10-07 增量）。

## 1. 身份

| 项 | 值 | 证据 |
|---|---|---|
| 主机名 | `YoudaoDictionaryPen-093` | `uname -a` |
| 代号 | `Y02-3562` | `/userdisk/myhosts` |
| SoC | Rockchip RK3562，4×Cortex-A53 | `/proc/cpuinfo` |
| 板级配置 | `rockchip_rk3562_y02_defconfig` | `/etc/os-release` BUILD_INFO |
| 固件 | **4.9.7**，构建于 2025-11-13 16:16 CST | `/Version` |
| 系统 | Buildroot 2021.11，kernel 5.10.160 | `/etc/os-release`、`/proc/version` |
| adb serial | `<device-serial>` | `adb devices -l` |

## 2. ABI 与运行时

| 项 | 值 |
|---|---|
| 架构 | `aarch64`（EM_AARCH64=183），小端，**64 位** |
| 运行时进程 | `/usr/bin/miniapp`（PID 216，ELF64 aarch64） |
| libc | glibc（`libc.so.6`，符号版本 GLIBC_2.17+） |
| C++ | `libstdc++.so.6.0.29` |
| 渲染引擎 | `/usr/lib/libfalcon.so`（10,559,696 B，aarch64） |
| JS 引擎 | `/usr/lib/libquickjs.so`（952,192 B），QuickJS `20200705` |
| js-framework | `0.0.32`，build 2021-10-28，Vue `2.6.12` |
| 设备端编译器 | **无**（无 gcc/cc/make/cmake） |
| 宿主机交叉工具链 | **无**（无 aarch64-gcc / clang / 可用 WSL） |

> ⚠️ **native 结论**：本机无法交叉编译 aarch64 `.so`。任何"自定义 native JSAPI"方案都需要先解决工具链，否则不可交付。

## 3. 屏幕与输入

```yaml
screen:
  panel_native: { width: 280, height: 936 }      # DSI-1 mode #0 "280x936@60.14"
  logical:      { width: 936, height: 280 }      # cfg.json width/height
  direction: 270                                  # cfg.json direction
  xoffset: 0
  yoffset: 0
  capture: 936x280                                # miniapp_cli capture 实测 PNG
  capture_note: |
    `miniapp_cli capture <path>` → {"ret":0}，产出 936x280 PNG，可用。
    `miniapp_cli captureFB <path>` → {"ret":-1}，不产出文件（因为无 /dev/fb0）。
    截图取证一律用 `capture`，不要用 `captureFB`。
  drm:
    driver: rockchip-vop2
    connector: DSI-1 (id 124)
    crtc: 0
    plane: 未测
touch:
  device: /dev/input/by-path/sitronix_ts_spi      # /dev/input/event4
  direction: 270
  xoffset: 0
  yoffset: 0
display:
  framebuffer: 不存在（无 /dev/fb0，无 /sys/class/graphics）
  render_path: /dev/dri/card0 + card1（miniapp 持有 fd 3 / fd 5）
```

`/etc/miniapp/resources/cfg.json` 里的 `"fb": "/dev/fb0"` 是**过期配置**，实际设备无此节点。

## 4. 媒体能力

| 项 | 值 |
|---|---|
| GStreamer | 1.22.0 |
| 硬解 | `mppvideodec`（rockchipmpp）、`mppjpegdec` |
| 软解 | ffmpeg `/usr/bin/ffmpeg`（aarch64）：h264 / hevc / aac / mp3 |
| 显示 sink | `kmssink`（kms 插件）、`v4l2sink` |
| 硬件节点 | `/dev/mpp_service`、`/dev/rga` |
| 播放库 | `libgstplayer-1.0.so.0.2200.0`、`libyddal_common_videoplayer.so`、`libyoudao_player_lim.so` |
| Falcon 内置 | `JQuick::gst::GStreamerVideoView`、`JQuick::gst::VideoPlayer`、`JQuick::HoleView` / `HoleHolder` |

## 5. 包与路径

| 项 | 值 |
|---|---|
| AMR 格式 | 普通 ZIP（`PK\x03\x04`），含 `manifest.json` + `*.js.bin` + `libs/` |
| 安装 | `miniapp_cli install <amrPath>` |
| 启动 | `miniapp_cli start <appId> <page>`（**必须显式传 page，且不能带 `--` 前缀**：`--index` 会被当成页面名 `--index.js`，导致黑屏） |
| 截图 | `miniapp_cli capture <path>`（**用这个**）；`captureFB` 在本机返回 `ret=-1` |
| 三方安装根 | `/userdisk/secondary/miniapp/data/mini_app/pkg/<appid>/a/` |
| 三方数据根 | `/userdisk/secondary/miniapp/data/mini_app/pkg/<appid>/data/` |
| 系统包索引 | `/etc/miniapp/resources/local_packages.json`、`local_packages_thirdparty.json` |
| 日志 | `/userdata/applog/DictPen_*.log`、`/userdata/applog/YD_PEN_APP.log` |
| 系统 appid 段 | `8080xxxxxxxxxxx`（如桌面 `8080222437664451`） |
| 三方 appid 段 | `800xxxxxxxxxxxxx`（如 PenBili `8002026091900004`） |

## 6. 系统小程序（可参考 / 依赖）

| appid | 名称 | 用途 |
|---|---|---|
| `8080222437664451` | 桌面 | HOME |
| `8080222501178405` | 下拉面板 | 全局事件源 |
| `8080272425914438` | 设置 | — |
| `8001666679481944` | **有道输入法** | `startTextEdit` 目标 |
| `8001650599023931` | **播放器** | 官方视频播放实现参考 |
| `8001650875810195` | 播放器-测试 | — |
| `8001670668055425` | 录音服务 | — |
| `8080252464522508` | 查词翻译 | — |

## 7. 输入法

```yaml
input_method:
  appid: "8001666679481944"
  version: "未读取"
  api_available:
    - Global.startTextEdit
    - Global.closeTextEdit
    - Global.closeIMApp
    - Global.textEditFinished        # 事件
    - Global.imPanelVisbileChanged   # 事件
    - Global.inputTypeChanged        # 事件
    - Global.requestIMAppClose / requestCloseIMApp / requestIMAppClearContent
  global_text_edit: untested
  textarea_soft_input: untested
  note: |
    事件名来自 8080222501178405（下拉面板）在 DictPen 日志中打印的事件表，
    以及 libjsapi_export_core.so 中 JSGlobalProxy 的符号表。功能未在真机验证。
```

## 8. 网络

| 项 | 值 |
|---|---|
| 接口 | `wlan0` <device-lan-ip>/24，网关 <lan-gateway> |
| DNS | 211.136.192.6 / 223.5.5.5 / 114.114.114.114 |
| 工具 | `curl 7.79.1`（aarch64-buildroot-linux-gnu，OpenSSL 1.1.1l） |
| 抖音可达 | `www.douyin.com`、`imapi.douyin.com`、`sso.douyin.com`、`v26-web.douyinvod.com` 全部 TCP 可达 |

## 9. 核心 JSAPI 模块（`/etc/miniapp/jsapis/libjsapi_export_core.so`）

已确认的 native module（`jsapi_*_module.cpp`）：

```
global      httpbridge   soundplayer   brightness  volume
bluetooth   gsensor      lte           tel         userCenter
systemInfo  headSet      headCamera
```

主要 Proxy 类：`JSGlobalProxy`、`JSHttpBridgeProxy`、`JSSoundPlayerProxy`、
`JSBlueToothProxy`、`JSBrightnessProxy`、`JSVolumenessProxy`、`JSGsensornessProxy`、
`JSLteProxy`、`JSTelProxy`、`JSWifiProxy`、`JSUserCenterProxy`、`JSSystemInfoProxy`、
`JSHeadCameraProxy`、`JSLogManagerProxy`、`JSStrUtilsProxy`、`JSButtonEventModuleProxy`。

### HTTP 通道

```
HttpBridge.httpBridge({ url, method|requestMethod, headers, body, urlParams, timeout })
```
底层 libcurl（cpr）。**支持自定义 header、POST body、timeout。**

### 视频相关

```
Global.isSurpportVideo()      # 探测设备是否支持视频
Global.stopVideoPlayer()      # 停止视频
```

### 存储

`libjsapi_export_core.so` 中**没有** KV 存储 module（只有 `JSystemInfoProxy::getStorageInfo` 磁盘容量查询）。
KV 存储应由 js-framework 提供，**API 形态未验证** → 列入 M0 探测。

## 10. 已安装三方小程序（参考样本）

`/userdisk/secondary/miniapp/data/mini_app/pkg/` 下 57 个包，其中对本项目有价值的：

| appid | 名称 | 价值 |
|---|---|---|
| `8002026091900004` | **PenBili 2.3.0** | 视频流 UI、签名算法、`global.startTextEdit` 用法、`httpjson` 用法 |
| `8001749691786666` | **PulseBox 1.6.56** | 多页面架构、`setViewPort` 用法、BasePage 资源释放 |
| `8001145141919811` | Doge阅读 1.1.2 | Storage 适配层写法 |

> ⚠️ **PenBili 的原生播放器在本固件上不可用**：
> 它随包的 `libs/libjsapi_player.so` 是 **32 位 ARM（EM_ARM）**，
> 而运行时是 **64 位 aarch64**，`dlopen` 必然失败；
> 且 DictPen 日志的 `dynamic_load_jsapi` 列表中**没有** `libjsapi_player_*.so`。
> 它的播放实现是 `ffmpeg → /dev/fb0`，而本设备**没有 `/dev/fb0`**。
> 结论：PenBili 的 **JS/UI/API 模式可参考，播放器部分不可复用**。

## 11. vw/vh 支持现状

> ✅ **M0 已实测确认，三行全部通过。** 详见 `SPIKE_REPORT.md` §2。

| 层 | 结论 | 证据 |
|---|---|---|
| 构建器 | ✅ **支持** | `falcon-styler/lib/validator.js:175` `SUPPORT_CSS_UNIT = ['px','pt','wx','rpx','vh','vw','%']` |
| **运行时** | ✅ **完全支持，已实测** | 探针铺 10/20/30/40vw + 10/15/25vh 色块，截图逐像素扫描：`100vw`=936px、`100vh`=280px，误差 ≤1px |
| 在网应用 | 无一使用 | 桌面、播放器、PenBili（全 px，设计宽 800）、PulseBox 全为 px |

### 实测数值

```
1vw  = 9.36 逻辑 px   （936 / 100）
1vh  = 2.80 逻辑 px   （280 / 100）
100vw = 936           100vh = 280
```

| 声明 | 实测像素 | 期望 | 误差 |
|---|---|---|---|
| `10vw` | 93 | 93.6 | −0.6 |
| `20vw` | 187 | 187.2 | −0.2 |
| `30vw` | 281 | 280.8 | +0.2 |
| `40vw` | 375 | 374.4 | +0.6 |
| `10vh` | 28 | 28.0 | 0 |
| `15vh` | 42 | 42.0 | 0 |
| `25vh` | 70 | 70.0 | 0 |
| `30px` | 30 | 30 | 0 |
| `40px` | 40 | 40 | 0 |
| `50px` | 50 | 50 | 0 |

### 关键结论

- `vh` 按**视口高度**推导（web 语义），**不是**与 `vw` 同比例 —— 两者独立、精确、可混用。
- 裸 `px` 在 `setViewPort(936)` 下即**逻辑像素**，与 vw 换算基准一致。
- 小数精度保留（`0.5vh` = 1.4px 实测有效）。
- **`STANDARDS.md` §1.4 的降级开关无需启用**；`@u: 1vw` / `@v: 1vh` 为最终形态。

### 未验证

- `<hole>` / `<video>` 组件是否被 `ComponentRegistry` 接受
- 触控坐标映射（direction 270）的实际表现

## 12. 设计宽度候选

| 候选 | 来源 | 说明 |
|---|---|---|
| `936` | 逻辑屏宽 1:1 | `1px == 1` 逻辑像素，最直观 |
| `800` | PenBili `diag.js.bin` 中 `width:800px` 满宽布局 | 若为满宽则 800 即设计宽 |
| `768` | PenBili / PulseBox `app.js.bin` 中的 int32 常量 | 可能是 `DESIGN_WIDTH` |

**未定论**，由 M0 实测决定。若全量使用 vw/vh，该值对比例布局无影响，只影响 px 换算。

## 13. 验证记录

```yaml
validation:
  tested_at: "2026-10-05"
  evidence:
    - adb devices -l / uname -a / cat /etc/os-release / cat /proc/cpuinfo
    - cat /etc/miniapp/resources/cfg.json
    - miniapp_cli --help
    - miniapp_cli capture /tmp/cap1.png -> {"ret":0}, 936x280 PNG
    - miniapp_cli captureFB /tmp/curfb.png -> {"ret":-1}（无 /dev/fb0，命令不可用）
    - 桌面截图 artifacts/desktop-20261005.png：横向图标条 + 下方文字标签，
      证实逻辑屏为 936x280 横向，非竖屏
    - modetest -> DSI-1 280x936@60
    - gst-inspect-1.0 -> mppvideodec / kmssink
    - strings /usr/lib/libfalcon.so
    - strings /etc/miniapp/jsapis/libjsapi_export_core.so
    - grep dynamic_load_jsapi /userdata/applog/DictPen_*.log
    - 抖音接口连通性探测（见 API_RECON.md）
  unverified:
    - vw/vh 运行期语义
    - KV 存储 API
    - 系统输入法 confirm/cancel 行为
    - nvue 视频组件 / <hole> 可用性
    - JS 侧 HTTP 通道（httpbridge）真实调用
```
