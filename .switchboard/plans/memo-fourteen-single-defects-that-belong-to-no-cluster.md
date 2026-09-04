# Fourteen Single Defects That Belong to No Cluster

## Goal

Fourteen reviewer findings that are each real, each verified, and each unrelated to the others. They are collected in one card so they reach the board without adding fourteen cards to it.

### Problem analysis

From the 2026-09-04 triage of `.switchboard/memo.md`. Every finding below was checked against HEAD; the evidence line is what the checker actually read.

**How to use this card.** It is a holding pen, not a unit of work. Each item is independently shippable and several are one-line fixes. Take them individually, in any order, and strike each from this file as it lands. If one turns out to be larger than it looks, split it out then — do not let it hold up the other thirteen.

Three items name an existing feature as their proper home; move those rather than doing them here.

## Metadata

- **Complexity:** 4
- **Tags:** bugfix, cleanup, assorted

## User Review Required

Items 1 and 6 are author decisions. The rest are defects.

## Proposed Changes

### 1. "No subagents" is not the default subagent policy **[decision]**

`KanbanProvider.ts:6610-6613` initialises `subagentPolicy = 'default'` per role and only moves off it when a per-role toggle is set. The reviewer's argument: teams are this product's replacement for subagents, so every role should default to `noSubagents`.

The active card *Prohibit Subagents in Memo and Chat Prompts* is scoped to the memo and chat paths, not the prompt builder's role defaults. This is a default flip plus whatever the Prompts tab renders.

### 2. `alert()` reports a failed claim-clear

`src/webview/connections.js:582` — the only `alert(` in the file. It is a silent no-op in a VS Code webview, the same class as `confirm()`, so the failure is reported nowhere.

**Home:** the *Browser panel action feedback* feature, which already owns the host-notification bridge.

### 3. Nothing checks or surfaces Tailscale ACL posture

The tailnet listener trusts every peer by design, so ACLs are the only thing narrowing who reaches a terminal surface. `grep -rni "acl" src/` returns nothing, and the Tailnet feature's subtasks cover MagicDNS, the Host header, secure origin, the spent token and CSRF — no ACL card.

**Home:** the *Tailnet* feature.

### 4. A batch's sibling cards are never cleared

`LocalApiServer.ts:4028-4046` — the comment states the design outright: "This POST clears exactly ONE of them… the sibling rows have no second POST to clear them", and deliberately does not gate on `remaining === 0`. Five of six fanned-out cards stay lit until the stale sweep retires them.

The nearest card, *A column move orphans the dispatch holder*, is about `dispatched_at` being nulled — a different predicate. This needs the either/or decision: clear every row stamped to the seat, or stop stamping N rows.

### 5. `protocol-catalog.json` reddens on pure line-number churn

`catalog:check` is green at HEAD, but the checked-in catalog carries 2,028 `"line":` fields and a `totalPushSites` count. So the next commit that shifts lines without regenerating reddens the **first** CI step and blocks everything behind it, for a reason unrelated to any protocol change.

Either a pre-commit regeneration hook, or a line-number-free catalog.

### 6. Team autostart worktrees accumulate with no reuse and no cleanup **[decision]**

Both start paths — `startTeamForWorkspace` (`TaskViewerProvider.ts:13284`) and `startAgentGroupById` (`KanbanProvider.ts:5085`) — call `provisionTeamWorktree` (`:15313`), which calls `_createSafetyWorktree` and `addWorktree(..., 'team')` unconditionally. There is no lookup of an existing `tier='team'` row and no removal on stop.

So a fresh branch and worktree accumulate per autostart, per window open. The board's worktree cards cover abandonment and git visibility, not accumulation.

### 7. Save and Preview can resolve one relative plan path to two files

`_resolveSaveTarget` honours a caller-supplied root. `_handleFetchKanbanPlanPreview(filePath, requestId)` takes no root at all and loops `_getAllowedRoots()` taking the first hit; the case at `:3912` passes only filePath and requestId.

With the same relative path present in two roots, the operator previews one file and saves another.

### 8. Plan-path and database-instance identity both fail open

`_ensureRelativePlanFile` warns and returns the **absolute** path on a workspace-prefix miss. Separately, `isValidWorkspaceRoot` returns `path.resolve(workspaceRoot)` and `forWorkspace` uses that string as the `_instances` cache key — no realpath, no dev/ino, so two paths to one directory yield two instances.

The instance half belongs with *Enforce one database instance per path and fix the is_feature clobber*. The `_ensureRelativePlanFile` half is unowned.

### 9. Only two routes validate `workspaceRoot`

`_resolveKnownRoot` has exactly two call sites (`LocalApiServer.ts:7921`, `:8243`). `_handleKanbanTaskComplete` passes the raw string to `getKanbanDatabase`.

Scope the fix as "extend the existing resolver to every route" — the memo's blanket claim that no route validates is now wrong.

### 10. Head names are not shell-escaped in the generated curl recipes

`_buildBatchDrivePrefix` (`KanbanProvider.ts:5836`) and `_buildDrivePrefix` (`:5900`) both build `originVal` with `JSON.stringify(head).slice(1, -1)` — JSON escaping only — and drop it inside a single-quoted `-d`. An apostrophe in a head name breaks both recipes.

The sibling exposure is `agentPromptBuilder.ts:895` and `:912`, which interpolate `targetKey` and `planFile` the same way. (The memo named `teamWiring.ts`; that file has no curl fragments.)

### 11. A third client-side copy of the complexity route

`kanban.html:9013-9015` computes `leadBoundCount` from `routingMapConfig.lead` only, while `KanbanProvider.resolveRoutedRole:1632` takes `degradeLivePool = true` and re-routes on an empty pool. The optimistic-move prediction at `:10097` is the second copy.

Push the routed role onto the card payload rather than deriving it a third time in the client.

### 12. Rail team slots can never show dispatched state

`wireSpawnedTeam` returns `{ ok: true }` at `teamWiring.ts:1382` when `children` is empty, so the three default member-less teams register no `terminals.groups` row. `buildTeamsForShell` (`terminals.js:1927-1934`) then emits `dispatched`, `groupId` and `queueDepth` as false, null and 0 whenever `liveGroup` is absent.

One decision: register a group row for head-only teams, or resolve the queue by head name. Related to the seed-team finding in *Team Wiring*; check that card first.

### 13. Remote-control provider exclusivity is unenforced and undisclosed

`connections.js:266-268` preserves a stored `linear` but writes `clickup` when the select says so; `linear.js:188` writes `provider: 'linear'` unconditionally. Neither panel reads the other's provider to warn.

So picking ClickUp in Connections silently disables Linear remote control, with nothing on the Linear panel saying so. A disclosure decision more than a bug fix.

### 14. The operator sees a raw `<cliPath>` placeholder, and two prompts still gate on the port file

`terminals.js:11803`, `:12210` and `:12263` carry the raw `<cliPath>` token in the panel's own prompt text; every `substituteCliPath` call site is server-side. The operator sees a literal placeholder and is invited to "fix" it by hand.

Separately, `TaskViewerProvider.ts:7273` and `tickets.html:4631` both still tell the reader to check `.switchboard/api-server-port.txt` to decide whether the extension is running — a two-line text fix, or fold into the server-discovery work.

## Verification Plan

Each item is verified on its own; there is no combined acceptance.

- Items 2, 3, 8 and 12 are moved to their named features and struck from this card.
- Items 1, 6 and 13 have a recorded decision before any code changes.
- For the remainder, the check is the inverse of the evidence line above: the grep that found the defect returns nothing, or the behaviour it describes no longer reproduces.
- This card is closed when it is empty, not when a batch is done.
