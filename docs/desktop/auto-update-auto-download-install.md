# 自动下载并安装更新

## 背景

Electron 自动更新弹窗需要支持用户选择“以后自动下载并安装更新”。该偏好必须持久化到全局设置，并和设置页里的同名开关保持一致。独立更新窗口不挂完整 workspace service，因此不能直接依赖 UI 层的 `settingService`。

## 行为

- 新增设置项 `autoDownloadAndInstallUpdates`，默认关闭。
- 更新弹窗在“未下载”状态的底部按钮上方展示左对齐 checkbox：`以后自动下载并安装更新`。
- 在设置页通用分组中展示同一个开关。
- 当该设置开启并检测到可用更新时，main 进程自动调用当前下载流程。
- 下载中主更新入口只展示进度/加载态，不允许点击打开更新弹窗。
- 下载完成后用户点击“重启以更新”：
  - 若没有运行中的 Agent session，直接执行现有 `quitAndInstallUpdate()`。
  - 若存在运行中任务，先提示应用将退出并重启、进行中的任务会中断；用户确认后再执行更新。

## 架构

- 设置持久化继续使用 `AppSettings` 和 `settingService`。
- 主进程 `autoUpdater` 在 `update-available` 事件中读取设置并触发自动下载，避免依赖任何 renderer 窗口是否打开。
- 独立更新窗口通过窄平台接口读写自动更新偏好，不暴露完整 setting service。
- 重启前任务检查复用现有 `IPlatformService.getDesktopSessionActivity()`，避免 UI 层直接读取任务 store 或跨层访问服务实现。

## 下载失败重试

下载失败（Promise reject 或 `error` 事件）不立即重查，按下表退避后重试：

| 连续失败次数 | 下次重试延迟 |
| --- | --- |
| 1 | 1 分钟 |
| 2 | 2 分钟 |
| 3 | 5 分钟 |
| 4 | 15 分钟 |
| 5 | 30 分钟 |
| 6 及以上 | 停止自动重查 |

- 用尽阶梯后保留 `update-available` 状态，由既有轮询（有可用更新 2 分钟 / 否则 15
  分钟）或用户手动检查恢复；手动检查会清零退避计数并立即重试。
- 下载成功或收到 `update-not-available` 表示链路已恢复，退避计数与待执行定时器清零。
- 设计原因：早期实现失败后立即重查，会「检出同一版本 → 自动下载 → 再失败 → 再重查」，
  实测 2~3 秒一轮无限循环，持续打网络并让日志爆量。

## 安装包文件名

`artifactName` 使用不含空格的产品名（`ZCode-Preview-<version>-...`），
`productName`（应用显示名、安装目录、AUMID、userData）保持 `ZCode Preview` 不变。

- 设计原因：GitHub Releases 会把资产名里的空格存成点号（`ZCode.Preview-...`），
  而 `electron-updater` 拼下载 URL 时把空格换成连字符（`ZCode-Preview-...`），
  三方命名不一致会让所有更新包 404，并叠加无限重试。

## 验证

- 单测覆盖：
  - 设置 schema 默认值和 patch。
  - 开启偏好后检测到更新自动开始下载。
  - 弹窗 checkbox 写入设置并在当前可用更新下触发下载。
  - 下载中主更新入口禁用。
  - 有运行中任务时重启按钮先请求确认。
- 仍需执行 `pnpm typecheck` 和 `pnpm lint`。
