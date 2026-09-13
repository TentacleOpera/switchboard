# Fourteen Single Defects That Belong to No Cluster

## Goal

Fourteen reviewer findings that are each real, each verified, and each unrelated to the others. They are collected in one card so they reach the board without adding fourteen cards to it.

### Problem analysis

From the 2026-09-04 triage of `.switchboard/memo.md`. Every finding below was checked against HEAD; the evidence line is what the checker actually read.

**How to use this card.** It is a holding pen, not a unit of work. Each item is independently shippable and several are one-line fixes. Take them individually, in any order, and strike each from this file as it lands. If one turns out to be larger than it looks, split it out then — do not let it hold up the other thirteen.

Three items name an existing feature as their proper home; move those rather than doing them here.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, ui, cli, security, reliability

## User Review Required

Items 1 and 6 are author decisions. The rest are defects.

## Complexity Audit

### Routine

- Items 2, 5, 7, 9, 10, 14: single-file or grep-returns-nothing fixes, localized, reusing existing patterns. Several are one-line.
- Moving items 2, 3, 8 (instance-half), 12 to their named features: mechanical relocation — add a subtask to the target feature, then strike the line here.

### Complex / Risky

- **Item 4** — data-consistency decision. The fix is an either/or: clear every row stamped to the seat, or stop stamping N rows. The wrong branch either clears sibling cards still genuinely in flight, or changes the fan-out dispatch model. Must be decided before code.
- **Item 11** — card payload schema change. Pushing `routedRole` onto the card payload adds a server-side field and removes a third client-side derivation. Must land in **both** composition roots (standalone + extension) and in `kanban.html`; a root that does not emit the field leaves the client deriving it again — a parity drift exactly like the 2026-08 queue-seam precedent.
- **Item 1** — default subagent policy flip. Product-wide behaviour change for every role unless overridden, plus whatever the Prompts tab renders. Author decision, not a mechanical fix.
- **Item 6** — worktree reuse/cleanup. Touches both autostart paths and the git branch/worktree lifecycle; accumulation is itself a per-window race.
- **Item 12** — head-only team group registration. Related to the Team Wiring seed-team finding; the decision (register a group row vs resolve queue by head name) must be checked against that card first.

## Edge-Case & Dependency Audit

- **Race Conditions**
  - Item 4: clearing sibling rows races with in-flight dispatch — the stale sweep is the current backstop; removing it without a replacement leaves lit cards.
  - Item 6: concurrent autostart across open windows creates duplicate worktrees (the defect itself is a race); any reuse lookup must handle two windows provisioning the same team simultaneously.
- **Security**
  - Item 10: unescaped head names interpolated into single-quoted `-d` curl recipes — an apostrophe breaks the recipe; treat as a shell-injection-class surface on operator-supplied names.
  - Item 3: Tailscale ACL posture (moved to the Tailnet feature — not executed here).
  - Item 13: remote-control provider exclusivity is undisclosed; picking ClickUp silently disables Linear with no warning on either panel.
- **Side Effects**
  - Item 1: flipping the role default to `noSubagents` changes every role's behaviour unless a per-role toggle overrides it.
  - Item 11: payload schema change affects every card render in both hosts.
  - Item 5: a pre-commit regeneration hook runs on every commit; a line-number-free catalog is a larger refactor of `catalog:check`.
- **Dependencies & Conflicts**
  - Items 2, 3, 8 (instance-half), 12 depend on their target features existing and accepting the subtask.
  - Item 8's instance-half depends on the *Enforce one database instance per path and fix the is_feature clobber* feature; the `_ensureRelativePlanFile` half is unowned and stays here.
  - Item 12 must be checked against the Team Wiring seed-team card before deciding.
  - Item 7 overlaps the *workspace-root-resolution-on-the-write-paths* feature — confirm it is not already owned there before doing it here.
  - **Parity (standalone + extension):** items 1, 4, 10, and 11 touch shared services (`KanbanProvider`, `LocalApiServer`, `agentPromptBuilder`) used by both composition roots. Each must land in both `src/standalone/bootstrap.ts` and `src/extension.ts` wiring wherever it introduces a seam or payload field. Item 11 is the highest parity risk.

## Dependencies

- None at the session level. Feature relationships are carried inline by the items that name a home feature (2 → *Browser panel action feedback*; 3 → *Tailnet*; 8 instance-half → *Enforce one database instance per path and fix the is_feature clobber*; 12 → check *Team Wiring* seed-team card).

## Adversarial Synthesis

Key risks: evidence line numbers are from the 2026-09-04 triage and HEAD has since drifted (~8 days) — verification is grep-based, not line-based, so acceptance still holds but the cited line numbers must not be navigated by; item 4 is a data-consistency decision whose wrong branch clears in-flight sibling cards or changes the dispatch model; items 1, 4, 10, 11 touch shared services and must land in both composition roots per the parity rule, with item 11 (card payload `routedRole`) the highest drift risk. Mitigations: re-grep every evidence line before fixing, record the item-4 decision before code, and audit each fix against both roots.

## Proposed Changes

> **Note (line drift):** Evidence line numbers below are from the 2026-09-04 triage. Spot-checks on 2026-09-12 confirmed every claim still holds, but line numbers have shifted (e.g. item 1 `6610→6746`, item 10 `5836→5848`, item 12 `1382→1653`, item 14 `11803→10986`). Verification is grep-based ("the grep that found the defect returns nothing"), so drift does not break acceptance — but re-grep; do not navigate by the cited numbers. Two items also moved files since the triage: item 7's functions now live in `PlanningPanelProvider.ts` (the plan left the file unnamed), and item 8's `_ensureRelativePlanFile` / `isValidWorkspaceRoot` / `forWorkspace` live in `KanbanDatabase.ts`.

> **Parity (standalone + extension):** Items 1, 4, 10, and 11 touch shared services used by both composition roots. Each fix must land in both `src/standalone/bootstrap.ts` and `src/extension.ts` wiring where it introduces a seam or payload field. Item 11 adds a server-side `routedRole` field and changes client reads — both roots must emit it and `kanban.html` must consume it, or the client silently re-derives it (a third copy returns).

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

Each item is verified on its own; there is no combined acceptance. **Skip compilation and skip automated tests for this run** — the checks below remain the written acceptance contract; they are simply not executed in this pass.

- Items 2, 3, and 12 are moved to their named features (add a subtask to the target feature, then strike the line here) and struck from this card.
- Item 8 is split: the instance-half moves to *Enforce one database instance per path and fix the is_feature clobber*; the `_ensureRelativePlanFile` half is unowned and is fixed here, not moved.

> **Superseded:** "Items 2, 3, 8 and 12 are moved to their named features and struck from this card."
> **Reason:** Item 8 is two defects in one. Only the database-instance half has a named home; the `_ensureRelativePlanFile` fail-open half is explicitly "unowned" in the item body, so moving the whole of item 8 would drop a defect with no destination.
> **Replaced with:** Items 2, 3, 12 move to their named features; item 8's instance-half moves to *Enforce one database instance per path and fix the is_feature clobber* and its `_ensureRelativePlanFile` half is fixed in place here.

- Items 1, 6 and 13 have a recorded decision (recorded in this file under each item before any code changes) before any code changes.
- For the remainder, the check is the inverse of the evidence line above: the grep that found the defect returns nothing, or the behaviour it describes no longer reproduces. Re-grep at current HEAD — the cited line numbers are from 2026-09-04 and have drifted.
- This card is closed when it is empty, not when a batch is done.

### Goal Invariants

The goal is "fourteen defects resolved," four of which are relocated. Because the goal contains relocation, negative invariants are paired with positive ones.

- **Item 1:** `KanbanProvider.ts` role-default `subagentPolicy` initialises to `'noSubagents'` (grep `subagentPolicy = 'default'` returns nothing in the role-default path); per-role override still wins when set.
- **Item 2:** `alert(` is absent from `src/webview/connections.js`; the failed-claim-clear path routes through the host-notification bridge owned by *Browser panel action feedback*.
- **Item 4:** whichever branch is chosen, no in-flight sibling card is cleared prematurely — assert the dispatch holder for a still-running seat is not nulled while `remaining > 0` for that seat (or, if "stop stamping N rows" is chosen, assert exactly one row is stamped per dispatch).
- **Item 5:** a commit that shifts only line numbers does not redden `catalog:check` (either the hook regenerates, or the catalog carries no `"line":` fields).
- **Item 7:** preview and save resolve the same file for a given relative path across two roots — assert `_handleFetchKanbanPlanPreview` and `_resolveSaveTarget` agree on the resolved root.
- **Item 8 (fixed-here half):** `_ensureRelativePlanFile` no longer returns the absolute path on a workspace-prefix miss — it fails or resolves, never silently fail-opens to absolute.
- **Item 9:** every route that calls `getKanbanDatabase(workspaceRoot)` passes through `_resolveKnownRoot` first (grep for raw `getKanbanDatabase(` calls bypassing the resolver returns nothing).
- **Item 10:** `originVal` in `_buildBatchDrivePrefix` and `_buildDrivePrefix` is shell-escaped for single-quoted context (an apostrophe in a head name does not break the recipe); the same for `targetKey`/`planFile` in `agentPromptBuilder.ts`.
- **Item 11:** the card payload carries `routedRole` emitted by **both** `src/standalone/bootstrap.ts` and `src/extension.ts` wiring; `kanban.html` reads it from the payload and no longer derives `leadBoundCount` from `routingMapConfig.lead` alone.
- **Item 12:** a head-only team either registers a `terminals.groups` row or has its queue resolvable by head name — assert `dispatched`/`groupId`/`queueDepth` are not unconditionally false/null/0 for the three default member-less teams.
- **Item 13:** selecting ClickUp in Connections surfaces a disclosure that Linear remote control is disabled (and vice versa on the Linear panel).
- **Item 14:** the raw `<cliPath>` token is absent from `terminals.js` panel prompt text; `TaskViewerProvider.ts` and `tickets.html` no longer instruct the reader to check `.switchboard/api-server-port.txt`.
- **Relocation (negative + positive):** items 2, 3, 8-instance-half, 12 are absent (struck) from this file AND resolvable as subtasks in their named target features.
