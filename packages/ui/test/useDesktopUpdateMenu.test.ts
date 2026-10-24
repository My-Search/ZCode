import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopCommandIds, type UpdateStatePayload } from "@zcode/shared";
import { useDesktopUpdateMenu } from "@/hooks/useDesktopUpdateMenu.js";
import { getUpdateMenuLabelId, getUpdateMenuLabelValues } from "@/lib/desktopUpdateMenu.js";

vi.mock("@zcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/shared")>()),
  ZCODE_PRODUCT_FLAVOR: "production",
  ZCODE_VERSION: "3.16.2",
}));

const mocks = vi.hoisted(() => ({
  platform: {
    getUpdateState: vi.fn(),
    onUpdateStateChanged: vi.fn(),
    executeDesktopCommand: vi.fn(),
  },
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => mocks.platform }));

async function importDesktopUpdateMenu(version: string) {
  // shouldShowDesktopUpdateEntry 的默认参数在 import 时绑定 ZCODE_VERSION，
  // 用 vi.resetModules + 动态 import 按 fork / 官方版本分别加载模块。
  vi.resetModules();
  vi.doMock("@zcode/shared", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@zcode/shared")>()),
    ZCODE_PRODUCT_FLAVOR: "preview",
    ZCODE_VERSION: version,
  }));
  return await import("@/lib/desktopUpdateMenu.js");
}
function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {
      removeProperty: () => {},
      setProperty: () => {},
    },
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentMock });
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowMock });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock, "div");
}

let root: Root | undefined;
let latest: ReturnType<typeof useDesktopUpdateMenu>;
function Probe({ desktop }: { desktop: boolean }) {
  latest = useDesktopUpdateMenu(desktop);
  return null;
}
function mount(desktop = true) {
  root = createRoot(installMinimalDom());
  act(() => root!.render(createElement(Probe, { desktop })));
}
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.clearAllMocks();
});

describe("帮助菜单更新状态", () => {
  it("实时检查状态不被较晚返回的 idle 快照覆盖，并在卸载时取消订阅", async () => {
    let resolve!: (state: UpdateStatePayload) => void;
    let listener!: (state: UpdateStatePayload) => void;
    const dispose = vi.fn();
    mocks.platform.getUpdateState.mockReturnValue(
      new Promise<UpdateStatePayload>((done) => {
        resolve = done;
      }),
    );
    mocks.platform.onUpdateStateChanged.mockImplementation((callback) => {
      listener = callback;
      return dispose;
    });
    mount();
    act(() => listener({ kind: "checking", enabled: false }));
    await act(async () => resolve({ kind: "idle", enabled: true }));
    expect(latest.labelId).toBe("desktopMenu.help.checkingForUpdates");
    expect(latest.disabled).toBe(true);
    act(() => listener({ kind: "update-downloaded", enabled: true, version: "3.13.0" }));
    expect(latest.labelId).toBe("desktopMenu.help.restartToUpdate");
    expect(latest.labelValues).toEqual({ version: "3.13.0" });
    latest.checkForUpdates();
    expect(mocks.platform.executeDesktopCommand).toHaveBeenCalledWith(
      DesktopCommandIds.CheckForUpdates,
    );
    act(() => root!.unmount());
    root = undefined;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("Web 不查询或订阅桌面更新状态", () => {
    mount(false);
    expect(latest.visible).toBe(false);
    expect(mocks.platform.getUpdateState).not.toHaveBeenCalled();
    expect(mocks.platform.onUpdateStateChanged).not.toHaveBeenCalled();
  });

  it("可用版本和下载进度沿用原有菜单文案参数", () => {
    const available: UpdateStatePayload = {
      kind: "update-available",
      enabled: true,
      version: "3.13.0",
    };
    const downloading: UpdateStatePayload = {
      kind: "download-progress",
      enabled: true,
      progress: "42%",
    };
    expect(getUpdateMenuLabelId(available)).toBe("desktopMenu.help.updateAvailableVersion");
    expect(getUpdateMenuLabelValues(available)).toEqual({ version: "3.13.0" });
    expect(getUpdateMenuLabelId(downloading)).toBe("desktopMenu.help.downloadingUpdateProgress");
    expect(getUpdateMenuLabelValues(downloading)).toEqual({ progress: "42%" });
  });

  it("入口可见性与 main 侧更新器判定对齐：fork 构建显示，官方 Preview 隐藏", async () => {
    // fork 包切成 ZCode Preview 身份后入口曾被隐藏，导致更新器无用户入口（fork-2 回归）。
    const forkBuild = await importDesktopUpdateMenu("3.16.2-fork.2");
    expect(forkBuild.shouldShowDesktopUpdateEntry("preview", "3.16.2-fork.2")).toBe(true);
    expect(forkBuild.shouldShowDesktopUpdateEntry("production", "3.16.2-fork.2")).toBe(true);

    const officialBuild = await importDesktopUpdateMenu("3.16.3");
    expect(officialBuild.shouldShowDesktopUpdateEntry("preview", "3.16.3")).toBe(false);
    expect(officialBuild.shouldShowDesktopUpdateEntry("production", "3.16.3")).toBe(true);
  });
});
