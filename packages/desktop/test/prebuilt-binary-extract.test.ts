import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

// extractPrebuiltArchive 经 spawn-command.mjs 调 spawnSync 解压归档。这里替换
// spawnSync 只断言子进程命令与环境，不真正解压；spawn-command 只用命名导入。
vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
  default: { spawnSync: spawnSyncMock },
}));

import { extractPrebuiltArchive } from "../../../scripts/prebuilt-binary-extract.mjs";

const temporaryDirectories: string[] = [];
async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-prebuilt-extract-"));
  temporaryDirectories.push(directory);
  return directory;
}

const originalPlatform = process.platform;
function stubPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0 });
});

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  delete process.env.ZCODE_PSENV_PROBE;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("extractPrebuiltArchive win32 zip", () => {
  it("spawn powershell.exe 时剥离继承的 PSModulePath，其余环境原样透传", async () => {
    // windows-2022 runner 父环境带 PSModulePath（指向 PowerShell 7 模块目录）会让 5.1
    // 自动加载到不兼容的 Microsoft.PowerShell.Archive（3 参 ExtractToDirectory 在
    // .NET Framework 上不存在），Expand-Archive 失败导致 ugrep 解压不出来
    // （2026-11-21 run 44912926493）。spawn env 必须把它置为 undefined
    // （Node 构建环境块时跳过 undefined 值），不能是空串。
    stubPlatform("win32");
    process.env.ZCODE_PSENV_PROBE = "probe";
    const base = await createTemporaryDirectory();
    const extractDir = join(base, "extract");

    extractPrebuiltArchive({
      archivePath: join(base, "archive.zip"),
      archiveExt: "zip",
      extractDir,
      cwd: base,
    });

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnSyncMock.mock.calls[0];
    expect(command).toBe("powershell.exe");
    expect(options.env).toMatchObject({ ZCODE_PSENV_PROBE: "probe" });
    expect(options.env.PSModulePath).toBeUndefined();
    expect(String(args.at(-1))).toContain("Expand-Archive");
    expect(String(args.at(-1))).toContain(extractDir);
  });

  it("非 Windows zip 仍走 unzip 且不覆写子进程环境", async () => {
    stubPlatform("linux");
    const base = await createTemporaryDirectory();

    extractPrebuiltArchive({
      archivePath: join(base, "archive.zip"),
      archiveExt: "zip",
      extractDir: join(base, "extract"),
      cwd: base,
    });

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnSyncMock.mock.calls[0];
    expect(command).toBe("unzip");
    expect(args).toEqual(["-q", join(base, "archive.zip"), "-d", join(base, "extract")]);
    expect(options.env).toBeUndefined();
  });
});
