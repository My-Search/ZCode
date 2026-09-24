# Fork 发布工作流 Spec（.github/workflows/build-release.yml）

## 背景

本仓库是 zai-org/zcode 的 fork，通过 `Sync & Build Release` 工作流定期合并上游并产出
`<官方版本>-fork.<序号>` 形式的 GitHub Release。本 spec 定义构建门槛、版本号构成与
各状态的唯一所有者；修改该工作流前先更新本文档。

## 产品规则

### R1 构建门槛：官方有「尚未发布」的提交才构建

- 判据：当前 `upstream/main` 是否已被**任意一个** fork 发布 tag（`v*-fork.*`）包含
  （`git merge-base --is-ancestor <upstream_sha> <tag>`）。
  - 已包含 → 官方这批提交已经发布过 → **不构建**（上游无新提交时的常态）。
  - 未包含 → 上游有新提交（或上一次发布被取消/失败）→ **构建**。
- 推论：
  - fork 自身的提交（workflow 修改、文档等）**不触发**自动构建；如需发版用
    `workflow_dispatch` 手动触发。
  - 合并上游后构建被取消 / 失败时，下一次定时运行仍会因「未发布」而补发，
    不会丢发布。
- 上游不可达（fetch 失败）时无法证明「官方有新提交」，本轮**跳过构建**并告警。
- `workflow_dispatch`（手动）**始终构建**，不受门槛限制；`dry_run` 时只做上游检查。

### R2 版本号构成

```
<官方版本>-fork.<序号>        例：3.14.3-fork.1
release tag = v<版本号>       例：v3.14.3-fork.1
```

镜像内版本（`__ZCODE_VERSION__`、electron 产物版本）由工作流在构建前 patch 根
`package.json` 注入，与 release tag 一致。

### R3 官方版本号来源：README「更新」区块

- 按优先级依次取第一个能解析出 `ZCode vX.Y.Z` 的来源：
  1. `README.md` 中 `## 更新` 区块的第一条版本记录；
  2. `README.en.md` 中 `## Updates` 区块的第一条版本记录；
  3. 回退：根 `package.json` 的 `version`，并输出 warning。
- **不用根 `package.json` 作为主来源**：上游发版不改根 `package.json`
  （open source 至今一直是 3.14.0，上游更新到 3.14.3 时也没动它），
  用它会让镜像版本永远停在 `3.14.0-fork.N`。
- 也不依赖上游 git tag / Releases：上游仓库**没有任何 tag**（GitHub tags API 为空）。

### R4 fork 序号：按官方版本分桶自增，官方版本变更时自动重置

- 序号 = 当前官方版本下已存在的 `v<官方版本>-fork.<N>` tag 的最大 N + 1；
  该版本下无任何 tag 时从 **1** 开始。
- 官方版本号变化 → tag 前缀变化 → 序号从 1 重新计数，即「重置 fork 后缀」。
- **不再使用 `github.run_number`**：它跨版本单调递增（导致 3.14.3 的第一个构建
  会是 fork.19 这类跳号），且被跳过的运行也会消耗编号。
- `workflow_dispatch` 的 `fork_suffix` 输入仍可显式覆盖序号；非数字直接失败。

### R5 状态与所有者（唯一写入方）

| 状态              | 所有者                     | 说明                                   |
| ----------------- | -------------------------- | -------------------------------------- |
| 官方版本号        | 上游（README 更新区块）    | 随 sync 合并进入 fork，工作流只读解析   |
| 发布记录          | git tag `v*-fork.*`        | 仅 release job（action-gh-release）创建 |
| 序号              | 派生自发布记录（无独立状态）| 每次由 tag 集合现算 max+1             |
| job 间接口        | `sync` job outputs         | `should_build` / `build_sha` / `version` / `release_tag` / `build_date` |

### R6 上游同步（保持既有行为）

- 仅当 `upstream/main` 不是 HEAD 祖先时才 merge，冲突则失败并提示手动处理。
- 合并提交带 `[skip ci]`；`build_sha` 传给下游，保证构建/打 tag 指向合并后的新 HEAD。

## 事件顺序

```
schedule / push(workflow文件) / workflow_dispatch
        │
        ▼
[sync] fetch upstream ──不可达──► 本轮跳过构建(R1) ──► 结束
        │
   有新提交? ──是──► merge + push origin/main
        │
        ▼
   decide: upstream_sha 已被任一 v*-fork.* tag 包含?
        │
   否(或手动触发) ──► patch: 官方版本(R3) + 序号(R4) ──► version / release_tag
        │
        ▼
[build ×4 平台] patch 根 package.json → bundle → 上传产物
        │
        ▼
[release] 创建 tag vX.Y.Z-fork.N + GitHub Release（写入发布记录，供下轮判据使用）
```

## 验收场景

| # | 场景                                                        | 期望                                   |
| - | ----------------------------------------------------------- | -------------------------------------- |
| AC1 | 定时触发，上游无新提交                                      | 不构建，summary 说明原因               |
| AC2 | 定时触发，上游有新提交且未发布                              | 合并后构建，版本 = 新官方版本 + `-fork.1` |
| AC3 | 同一官方版本下再次构建（手动/补发）                         | 序号 = 现有最大 N + 1，不跳号          |
| AC4 | 官方版本升级后再次构建                                      | 序号重置回 1（R4）                     |
| AC5 | README 更新区块缺失/无版本号                                | 回退 package.json 并告警，流程不中断   |
| AC6 | 上游 fetch 失败                                            | 本轮不构建、告警                       |
| AC7 | `workflow_dispatch`（含 `fork_suffix`、`dry_run`）          | 始终构建/按 dry_run 跳过；suffix 覆盖生效 |
| AC8 | 合并后构建失败或被取消，上游无再更新                        | 下轮定时仍检测到「未发布」并补发       |
| AC9 | fork 自身提交（未合入上游新内容）                          | 定时运行不构建                         |

## 已知边界

- 手动触发会对已发布 HEAD 再次构建（显式 `fork_suffix` 或自动 max+1 得到新序号），
  属于 R1（手动始终构建）与 R4（序号覆盖）允许的行为。
- 旧 tag `v3.14.0-fork.*` 保留作为历史发布记录，其序号序列不再续用。
