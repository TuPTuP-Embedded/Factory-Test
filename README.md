# 星海弹弹 TP-01 测试工具（Android 离线 APK 工程 + GitHub Actions 自动编译）

本项目将 `tp01-simple` 网页版完整封装为 **可完全离线运行** 的原生 Android 应用（APK），并内置 **Android 原生蓝牙 BLE GATT + 原生 USB MIDI + 原生屏幕方向与常亮锁 + 文件导入导出桥接**，解决了普通 Android WebView 不支持 `navigator.bluetooth` 和 `navigator.requestMIDIAccess` 的问题。

---

## 核心特性（与网页版 100% 兼容且完全离线）

1. **100% 离线启动与运行**：所有前端资源（HTML / CSS / JS / 图标）均内置在 APK `assets/www/` 中，无需联网、无需架设 HTTPS 服务器，安装到任何 Android 手机或平板即可直接打开使用。
2. **原生蓝牙 BLE-MIDI 桥接 (`navigator.bluetooth` Polyfill)**：
   - 自动申请 Android 6–11 定位/蓝牙权限或 Android 12+ (`BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT`) 权限。
   - 支持按 BLE-MIDI 服务 UUID (`03b80e5a-ede8-4b33-a751-6ce34ec4c700`) 过滤扫描，也支持勾选「显示全部蓝牙设备」。
   - 自动请求高优先级连接 (`CONNECTION_PRIORITY_HIGH`) 与 `MTU 512`，兼容 20 字节默认包与 100/244/512 大包高速固件升级。
   - 完整支持固件升级（`.ble` 与 `.BIN` 自动加头打包）、升级中断线自动重连、断点续传。
3. **原生 USB MIDI 桥接 (`navigator.requestMIDIAccess` Polyfill)**：
   - 调用 Android 系统级 `MidiManager`，插上 OTG 转接线即可收发标准 USB MIDI 消息。
4. **检验模式自动横屏 & 升级防锁屏**：
   - 切换到「检验（按键点亮）」模式时自动调用原生横屏与沉浸式全屏。
   - 固件升级期间自动保持屏幕常亮（`FLAG_KEEP_SCREEN_ON`），防止锁屏中断升级。
5. **本地文件选择与 `.ble` 打包下载**：
   - 支持直接从手机本地存储选择 `.ble` 或 `.bin` 升级文件。
   - 点击「下载 .ble」会直接保存到手机系统的 `Download/`（下载）目录并弹窗提示。

---

## 如何使用 GitHub Actions 自动编译 APK（零本地环境配置）

1. **创建 GitHub 仓库**：
   在 GitHub 上新建一个仓库（公开或私有均可）。
2. **上传本项目全部文件**：
   将本压缩包解压后的所有文件（确保包含隐藏文件夹 `.github/workflows/build-apk.yml`）推送到 GitHub 仓库：
   ```bash
   git init
   git add .
   git commit -m "Initial commit: TP-01 Simple Android APK project"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/<你的仓库名>.git
   git push -u origin main
   ```
3. **等待自动编译并下载 APK**：
   - 推送代码后，进入 GitHub 仓库顶部的 **Actions** 选项卡。
   - 你会看到 **Build TP-01 Simple Android APK** 工作流正在自动运行（也可以随时点击右侧 **Run workflow** 手动触发）。
   - 约 1～2 分钟编译完成后，点进该次运行记录，在页面底部的 **Artifacts** 区域即可下载：
     - `tp01-simple-release-apk`（已自动签名，解压后得到 `tp01-simple-release.apk`，可直接传到任何 Android 手机离线安装）
     - `tp01-simple-debug-apk`（调试版 `tp01-simple-debug.apk`）
4. **自动发布到 GitHub Releases（可选）**：
   如果你推送一个以 `v` 开头的标签（例如 `git tag v1.0.0 && git push origin v1.0.0`），GitHub Actions 会自动创建 Release 并将签名的 APK 挂载到 Release 下载列表。

---

## 目录结构

```text
tp01-android-apk/
├── .github/
│   └── workflows/
│       └── build-apk.yml          # GitHub Actions 自动编译工作流
├── app/
│   ├── build.gradle               # Android App 构建与签名配置
│   └── src/main/
│       ├── AndroidManifest.xml    # 蓝牙 BLE / USB MIDI 权限与 Activity 声明
│       ├── java/com/xinghai/tp01simple/
│       │   └── MainActivity.java  # 原生 WebView 容器 + BLE/MIDI/文件/屏幕桥接实现
│       ├── res/mipmap-*/          # 从 icon.svg 转换生成的各分辨率 Android 桌面图标
│       └── assets/www/            # 完整内置的 tp01-simple 离线网页资源 + native-bridge.js
├── build.gradle                   # 根项目 Gradle 配置
├── settings.gradle                # 仓库与模块配置
└── gradle.properties              # JVM 与 AndroidX 属性配置
```
