import {
  ZCODE_PRODUCT_FLAVOR,
  ZCODE_VERSION,
  type ZCodeProductFlavor,
  type UpdateStatePayload,
} from "@zcode/shared";

// 更新入口跟随产品身份而不是后端环境：Preview 身份（含生产后端的 Preview）禁用更新器。
// 例外：fork 构建（版本含 -fork）与官方构建不同，main 侧更新器对它始终初始化
// （resolveAutoUpdaterInitializationEnabled，更新源为 fork 仓库 GitHub Releases），
// 入口必须同步放行，否则 Preview 身份的 fork 包没有任何更新入口可用了。
export function shouldShowDesktopUpdateEntry(
  flavor: ZCodeProductFlavor = ZCODE_PRODUCT_FLAVOR,
  version: string = ZCODE_VERSION,
): boolean {
  return version.includes("-fork") || flavor === "production";
}

export function getUpdateMenuLabelId(state: UpdateStatePayload | null) {
  switch (state?.kind) {
    case "checking":
      return "desktopMenu.help.checkingForUpdates";
    case "update-available":
      return "desktopMenu.help.updateAvailableVersion";
    case "download-progress":
      return "desktopMenu.help.downloadingUpdateProgress";
    case "update-downloaded":
      return "desktopMenu.help.restartToUpdate";
    case "idle":
    default:
      return "titleBar.menu.help.checkForUpdates";
  }
}

export function getUpdateMenuLabelValues(
  state: UpdateStatePayload | null,
): Record<string, string> | undefined {
  switch (state?.kind) {
    case "update-available":
    case "update-downloaded":
      return { version: state.version };
    case "download-progress":
      return { progress: state.progress };
    default:
      return undefined;
  }
}
