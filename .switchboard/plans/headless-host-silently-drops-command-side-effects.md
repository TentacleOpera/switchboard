# The headless host answers `success: true` for commands it never runs

## Goal

Make the standalone host distinguish a command that is *correctly* inert from one that is *unimplemented*, so a CLI or API caller is never told an operation succeeded when nothing happened.

### Problem Analysis

The standalone host dispatches `switchboard.*` commands through a **registry-first seam**: `VscodeHostCommands.executeCommand` (hostSeams.ts:327-336) checks `switchboardCommandRegistry.has(command)` and, on a hit, runs the registered handler in-process. On a miss, it falls through to `vscode.commands.executeCommand`, which in standalone resolves to `vscodeShim.commands.executeCommand` (vscodeShim.ts:410) — a warn-once-per-process stub that returns `undefined`.

`src/services` contains **126 `executeCommand` call sites** across **38 distinct `switchboard.*` commands**. That code runs under both hosts. Under the extension, `extension.ts` registers every command via `registerSwitchboardCommand` (which populates both the vscode command system and `switchboardCommandRegistry`). Under the standalone host, `bootstrap.ts` registers a **subset** into `switchboardCommandRegistry` directly. Every command not in that subset falls through to the warn-once stub and silently no-ops.

**Two categories, currently indistinguishable at the fallback layer.**

*Correctly inert* — there is no panel to open, so doing nothing is right:
`refreshUI` (46 sites, bridged to `schedulePushFullState`), the ten `open*Panel` / `openKanban` / `openInBrowser` variants, `focusTerminal` (1), `focusTerminalByName` (8, bridged), `createAgentGrid`, `createAgentGridEditor`, `selectSession`, `revealFileInOS` (bridged no-op), `revealInExplorer` (bridged no-op), `vscode.open` (bridged no-op).

*Already bridged* — real state changes that DO execute under the standalone host (registered in bootstrap.ts):

| Command | Sites | Bridged at |
| :-- | :-- | :-- |
| `triggerAgentFromKanban` | 6 | bootstrap.ts:1320 |
| `triggerBatchAgentFromKanban` | 8 | bootstrap.ts:1330 |
| `importPlanFromClipboard` | 2 | bootstrap.ts:1383 |
| `mappingsChanged` | 3 | bootstrap.ts:1297 |
| `refreshUI` | 46 | bootstrap.ts:1291 |
| `focusTerminalByName` | 8 | bootstrap.ts:1312 |

*Unimplemented* — real state changes that silently do not occur (NOT in `switchboardCommandRegistry` under standalone):

| Command | Sites | Dropped effect |
| :-- | :-- | :-- |
| `resetKanbanDb` | 4 | database reset |
| `reconcileKanbanDbs` | 4 | database reconcile |
| `fullSync` | 4 | tracker sync |
| `kanbanForwardMove` / `kanbanBackwardMove` | 3 | card column moves |
| `restorePlanFromKanban` | 2 | plan restore |
| `initiatePlan` | 2 | plan authoring flow |
| `completePlanFromKanban` | 1 | plan completion |
| `syncImportedPlans` | 1 | imported-plan sync |
| `importUnclaimedPlans` | 1 | unclaimed-plan import |
| `batchDispatchLow` | 1 | low-complexity batch dispatch |
| `setPairProgrammingModeFromKanban` | 1 | mode change |
| `analystMapFromKanban` | 1 | analyst map |
| `addCoderTerminalFromKanban` | 1 | seat creation |
| `clearControlPlaneCache` | 1 | cache clear |
| `toggleSilent` | 1 | silent-mode toggle |
| `refreshControlPlaneRuntime` | 3 | runtime refresh |
| `setup` / `setupIDEs` | 4 | setup flows |

**Three things make this sharp rather than theoretical.**

1. **Callers report success regardless.** `KanbanProvider.ts:12780` (`case 'createPlan'`) ensures the DB exists, calls `executeCommand('switchboard.initiatePlan')`, and returns `{ success: true }`. The command is registered only at `extension.ts:1143`, so under the standalone host the plan is never created and the caller is told it was. (Note: the `kanbanVerb` CLI path has its own `createPlan` case at bootstrap.ts:1508 that creates a plan file directly — so this specific bug is reachable via the WS/webview path, not the `verb` CLI path.)

2. **The warning fires once per process.** `_warnedUnbridged` is a `Set`, so each message appears once per host lifetime. On a long-running board the evidence scrolled past days ago.

3. **`switchboard verb` reaches most of it.** The `kanbanVerb` default arm (bootstrap.ts:1668) delegates to `kanbanProvider.handleServiceVerb` → `_handleMessage`. Any `_handleMessage` arm that calls `executeCommand('switchboard.X')` for a side effect, where X is unbridged, silently no-ops and the arm returns success. Unknown verbs themselves are handled correctly (`{ success: false, error: "Verb not implemented" }`), but the side-effect commands inside known arms are not.

**A fourth defect — the catch-swallow.** `VscodeHostCommands.executeCommand` (hostSeams.ts:333) wraps the entire dispatch in `catch { return undefined }`. Even if the fallback layer threw an error for an unbridged command, the catch would swallow it and return `undefined` to the caller — the throw never reaches the arm. Any fix that makes the fallback throw must also modify this catch to let the unimplemented-command error propagate.

**A fifth, smaller defect — dead-code disagreement.** `src/standalone/hostServices.ts:429-430` returns `undefined` silently for `showInputBox` / `showQuickPick`; `src/standalone/vscodeShim.ts:202-203` calls `headlessReject()` and throws for the same calls. Same host, opposite failure modes — but `hostServices.ts`'s `createHeadlessHostSeams` is explicitly **NOT WIRED** (hostServices.ts:361): bootstrap.ts injects `createVscodeHostSeams` instead, whose `VscodeHostUI` delegates to `vscodeShim.window` (the rejecting path). The disagreement exists in the source but is not a live bug — no service reaches `hostServices.ts`'s UI stubs.

### Root Cause

`executeCommand` is used as a general-purpose internal dispatch bus, not only for UI. The registry-first seam (`VscodeHostCommands`) has no model of which commands *should* be inert — it treats every registry miss as "fall through to vscode.commands," which in standalone is a warn-once no-op. Absent that model, the safe-looking default (warn once, return `undefined`) silently converts state changes into no-ops, and the arms above it cannot tell the difference, so they return success. The `catch { return undefined }` in `VscodeHostCommands` compounds this by swallowing any error that would signal the problem.

## Metadata

**Complexity:** 6
**Tags:** bugfix, cli, reliability
**Project:** Browser Switchboard

## User Review Required

This plan corrects several stale assumptions from the original version. The core thesis (unbridged commands silently no-op, callers report fake success) is confirmed and still valid. The intervention point and command classifications have been updated against the current codebase. Review the Superseded callouts in Proposed Changes for the specific corrections.

## Complexity Audit

### Routine
- Registering no-op handlers for correctly-inert commands in bootstrap.ts (same pattern as existing `revealFileInOS` registration at bootstrap.ts:1336).
- Adding an `INERT_COMMANDS` set constant.
- Updating the `KanbanProvider.ts:12780` `createPlan` arm to not return success unconditionally.
- Deleting or deprecating the dead `hostServices.ts` `createHeadlessHostSeams` bundle.

### Complex / Risky
- Modifying `VscodeHostCommands.executeCommand` (hostSeams.ts:327-336) to throw for unbridged `switchboard.*` commands instead of falling through — this is shared code used by BOTH hosts. The extension host must be unaffected (every `switchboard.*` command is registered there, so the throw path is never reached).
- Modifying the `catch { return undefined }` block to distinguish `HeadlessUnimplementedCommandError` from handler errors — must not break existing error-swallowing behavior for registered handlers that throw.
- Auditing all 126 call sites for `return { success: true }` after `executeCommand` without result inspection — large surface area, must be done command-by-command.
- Bridging `kanbanForwardMove` / `kanbanBackwardMove` headlessly — card column moves have kanban.db state implications and the system normally moves cards automatically (per AGENTS.md). Bridging these must not race the system's own column transitions.

## Edge-Case & Dependency Audit

**Race Conditions**
- `kanbanForwardMove` / `kanbanBackwardMove` bridged handlers must not race the system's automatic column transitions (AGENTS.md: "the system moves cards automatically as work progresses — never move a card yourself"). The bridge must delegate to the same DB-layer move function the extension uses, not re-implement the move.
- `schedulePushFullState()` is coalesced (trailing-edge). Registering `refreshUI` as a no-op instead of the current `schedulePushFullState` call would break the coalesced push behavior. The existing registration at bootstrap.ts:1291 must be preserved, not replaced.

**Security**
- The `switchboard verb` CLI path accepts arbitrary JSON payloads. Bridged handlers that accept args from `executeCommand` must validate them the same way the extension handlers do. The `kanbanVerb` default arm already validates via `validateVerbPayload` (KanbanProvider.ts:9574) — bridged handlers reached through `_handleMessage` inherit this.

**Side Effects**
- Throwing for unbridged commands will change behavior for any code path that currently silently succeeds. The `SWITCHBOARD_HEADLESS_LENIENT=1` env escape must be checked at the `VscodeHostCommands` level (before the throw), not just in vscodeShim, because `VscodeHostCommands` is where the throw originates.
- Some `_handleMessage` arms call `executeCommand` with `void` (fire-and-forget, e.g. `void this._seams().commands.executeCommand('switchboard.refreshUI')` at KanbanProvider.ts:1744). A throw from a voided call becomes an unhandled rejection. The INERT set must cover `refreshUI` so this doesn't break.

**Dependencies & Conflicts**
- `switchboardCommandRegistry` is a singleton shared between the extension host and standalone host. Any modification to `VscodeHostCommands` must be host-conditional or command-prefix-conditional (`switchboard.*` only) to avoid affecting the extension host, where `vscode.commands.executeCommand` is the correct fallback for non-`switchboard.*` commands.
- The existing `verb-engine-headless-seams.test.js` test suite uses `VscodeHostCommands` with a booby-trapped vscode module. Changes to `VscodeHostCommands` must not break these tests.

## Dependencies

None — this plan is self-contained. No other plan in `.switchboard/plans/` blocks or is blocked by this work.

## Adversarial Synthesis

Key risks: (1) the `VscodeHostCommands` `catch { return undefined }` will swallow any throw unless explicitly modified to re-throw `HeadlessUnimplementedCommandError`; (2) modifying shared `VscodeHostCommands` code risks extension-host regressions if the host-conditional logic is wrong; (3) the 126-site caller audit is large and a missed `return { success: true }` leaves a fake-success path open. Mitigations: gate the throw on `command.startsWith('switchboard.')` AND a standalone-host flag (the extension registers all `switchboard.*` commands, so the throw is unreachable there); use the existing `verb-engine-headless-seams.test.js` pattern to verify the throw propagates; grep-gate the audit with a CI assertion that no `executeCommand('switchboard.*')` call is followed by an unconditional `return { success: true }`.

## Proposed Changes

### Phase 1 — classify, and make the unknown loud. Ships alone and is the safety fix.

> **Superseded:** Add a command registry to the standalone host: an explicit `INERT` allowlist (the UI set above) and a `BRIDGED` map (initially empty). Change `vscodeShim.executeCommand` to a three-way branch: `INERT` → return `undefined` silently; `BRIDGED` → invoke the handler; anything else → throw `HeadlessUnimplementedCommandError` naming the command.
> **Reason:** The plan targeted `vscodeShim.executeCommand`, which is the terminal fallback only — the live dispatch path is `VscodeHostCommands.executeCommand` (hostSeams.ts:327-336), which is registry-first. A throw in vscodeShim would be swallowed by `VscodeHostCommands`'s `catch { return undefined }` (hostSeams.ts:333) and never reach the caller. Additionally, `switchboardCommandRegistry` already IS the bridged map — `registry.has(command)` is the check. No separate `BRIDGED` map is needed.
> **Replaced with:** The three-way branch lives in `VscodeHostCommands.executeCommand`. After the registry miss, check an `INERT_COMMANDS` set → return `undefined` silently; for any other `switchboard.*` command → throw `HeadlessUnimplementedCommandError`; for non-`switchboard.*` commands → fall through to `vscode.commands.executeCommand` as today. The `catch` block is modified to re-throw `HeadlessUnimplementedCommandError` instead of swallowing it.

1. **`src/services/hostSeams.ts` — `VscodeHostCommands.executeCommand` (line 327-336)**
   - **Context:** This is the live dispatch seam for both hosts. In standalone, a registry miss falls through to `vscode.commands.executeCommand` (vscodeShim no-op). In the extension, a registry miss falls through to the real vscode command system (which has all commands registered).
   - **Logic:** After `this._registry.has(command)` returns false, add a three-way branch:
     - If `command` starts with `switchboard.` AND is in an `INERT_COMMANDS` set → return `undefined` silently (correctly inert: no panel to open, no state to change).
     - If `command` starts with `switchboard.` AND is NOT in `INERT_COMMANDS` → throw `HeadlessUnimplementedCommandError` (new error class, defined in this file or in `commandRegistry.ts`).
     - If `command` does NOT start with `switchboard.` → fall through to `vscode.commands.executeCommand` as today (editor built-ins like `markdown.api.render`, `vscode.open`).
   - **Catch block modification:** The existing `catch { return undefined }` (line 333) must re-throw `HeadlessUnimplementedCommandError` instead of swallowing it. Other errors (handler throws) continue to be swallowed and return `undefined` — this preserves existing behavior for registered handlers that throw.
   - **Implementation:**
     ```typescript
     async executeCommand<T = unknown>(command: string, ...args: any[]): Promise<T | undefined> {
         try {
             if (this._registry.has(command)) {
                 return await this._registry.execute<T>(command, ...args);
             }
             if (command.startsWith('switchboard.')) {
                 if (INERT_COMMANDS.has(command)) {
                     return undefined;
                 }
                 if (process.env.SWITCHBOARD_HEADLESS_LENIENT === '1') {
                     // Env escape: restore today's warn-and-continue behavior.
                     if (!warnedUnbridged.has(command)) {
                         warnedUnbridged.add(command);
                         console.warn(`[headless] command '${command}' is not bridged — the calling arm's side effect did not happen`);
                     }
                     return undefined;
                 }
                 throw new HeadlessUnimplementedCommandError(command);
             }
             return await vscode.commands.executeCommand<T>(command, ...args);
         } catch (err) {
             if (err instanceof HeadlessUnimplementedCommandError) {
                 throw err; // Don't swallow — the caller must see this.
             }
             return undefined;
         }
     }
     ```
   - **Edge Cases:** The `INERT_COMMANDS` set and `warnedUnbridged` Set are module-level constants in `hostSeams.ts`. The `INERT_COMMANDS` set is populated from a shared constant (see step 2). The extension host never reaches the `switchboard.*` throw branch because `registerSwitchboardCommand` populates the registry for every command — `registry.has(command)` returns true.

2. **`src/services/commandRegistry.ts` — add `INERT_COMMANDS` and `HeadlessUnimplementedCommandError`**
   - **Context:** This module is already host-agnostic (no vscode import) and is the natural home for command classification.
   - **Logic:** Export a `HeadlessUnimplementedCommandError` class and an `INERT_COMMANDS` Set containing the correctly-inert command names:
     ```
     switchboard.refreshUI (already bridged, but listed for documentation)
     switchboard.openConnectionsPanel
     switchboard.openDesignPanel
     switchboard.openInBrowser
     switchboard.openKanban
     switchboard.openPlan
     switchboard.openPlanningPanel
     switchboard.openProjectPanel
     switchboard.openSetupPanel
     switchboard.openTerminalGrid
     switchboard.openTicketsPanel
     switchboard.focusTerminal
     switchboard.createAgentGrid
     switchboard.createAgentGridEditor
     switchboard.selectSession
     ```
   - **Note:** `refreshUI`, `focusTerminalByName`, `revealFileInOS`, `revealInExplorer`, and `vscode.open` are already registered in the registry (bootstrap.ts:1291, 1312, 1336-1338) so they never reach the INERT check. They are listed in the set for completeness and to guard against a future bootstrap change that removes their registration.

3. **`src/standalone/vscodeShim.ts` — `commands.executeCommand` (line 410-416)**
   - **Context:** This is the terminal fallback for non-`switchboard.*` commands and for `switchboard.*` commands when `SWITCHBOARD_HEADLESS_LENIENT=1`. With the `VscodeHostCommands` change above, `switchboard.*` commands no longer reach this stub (they throw or return undefined in `VscodeHostCommands` first). This stub remains as the lenient-mode fallback and for non-`switchboard.*` commands.
   - **Logic:** No change needed to the stub itself. The warn-once behavior stays as the lenient-mode fallback. The comment at lines 395-408 should be updated to reflect that `VscodeHostCommands` now handles the three-way branch and this stub is only reached in lenient mode or for non-`switchboard.*` commands.

4. **Env escape:** `SWITCHBOARD_HEADLESS_LENIENT=1` restores today's warn-and-continue behavior. Checked in `VscodeHostCommands.executeCommand` before the throw (see step 1 implementation). This ensures an unclassified command cannot harden into an outage before Phase 2 lands.

### Phase 2 — bridge the state changes. Ships incrementally, highest-traffic first.

> **Superseded:** Implement `BRIDGED` handlers against the services the extension commands already delegate to. `triggerAgentFromKanban` and `triggerBatchAgentFromKanban` first — dispatch is the CLI's primary job. Then `kanbanForwardMove` / `kanbanBackwardMove`, `completePlanFromKanban`, `fullSync`, `reconcileKanbanDbs`.
> **Reason:** `triggerAgentFromKanban` and `triggerBatchAgentFromKanban` are already bridged (bootstrap.ts:1320, 1330). `importPlanFromClipboard` and `mappingsChanged` are also already bridged (bootstrap.ts:1383, 1297). The plan's original Phase 2 listed these as needing implementation — they do not.
> **Replaced with:** Bridge only the commands that are actually unbridged. Priority order by traffic: `fullSync` (4 sites), `resetKanbanDb` (4), `reconcileKanbanDbs` (4), `setup`/`setupIDEs` (4), `kanbanForwardMove`/`kanbanBackwardMove` (3), `refreshControlPlaneRuntime` (3), then the 1-2 site commands.

5. **`src/standalone/bootstrap.ts` — register bridged handlers** for each unbridged state-change command, following the same pattern as the existing `triggerAgentFromKanban` registration (bootstrap.ts:1320). Each handler delegates to the same service method the extension's `registerSwitchboardCommand` handler uses (see extension.ts for the handler bodies):
   - `switchboard.fullSync` → extension.ts:1536 — delegates to the tracker sync service.
   - `switchboard.resetKanbanDb` → extension.ts:1564 — delegates to `db.reset()`.
   - `switchboard.reconcileKanbanDbs` → extension.ts:1725 — delegates to the reconcile service.
   - `switchboard.kanbanForwardMove` / `switchboard.kanbanBackwardMove` → extension.ts:1862, 1867 — delegates to `db.updateColumn()`. **Caution:** must not race the system's automatic column transitions. The bridge should call the same DB-layer function the extension handler calls, not re-implement move logic.
   - `switchboard.completePlanFromKanban` → extension.ts:1872.
   - `switchboard.restorePlanFromKanban` → extension.ts:1877.
   - `switchboard.refreshControlPlaneRuntime`, `switchboard.clearControlPlaneCache`, `switchboard.toggleSilent`, `switchboard.setPairProgrammingModeFromKanban`, `switchboard.batchDispatchLow`, `switchboard.analystMapFromKanban`, `switchboard.addCoderTerminalFromKanban`, `switchboard.syncImportedPlans`, `switchboard.importUnclaimedPlans`, `switchboard.setup`, `switchboard.setupIDEs` — bridge each to its extension handler's service method.

6. **`switchboard.initiatePlan` specifically:** The headless equivalent of the authoring flow is writing a plan file to `.switchboard/plans/`, which the board already reconciles on its own. Bridge it to `createAndIngestPlan` (the same function `kanbanVerb`'s `createPlan` case uses at bootstrap.ts:1516) rather than to a UI interview. This fixes the `KanbanProvider.ts:12780` `createPlan` arm's fake-success path.

7. **Any command that genuinely cannot work headless stays unbridged and therefore throws** — that is the correct outcome, not a gap. `setup` / `setupIDEs` may fall into this category if they require interactive UI flows (they call `showInputBox` / `showQuickPick` which reject headless). If so, they should throw with a message directing the user to the CLI `setup` command instead.

### Phase 3 — one stub layer. Independent of the above.

> **Superseded:** Reconcile `hostServices.ts` and `vscodeShim.ts` onto a single policy: prompts that return `undefined` are indistinguishable from a user pressing Escape, which is a lie in a headless context, so `headlessReject` should win. Delete the silent duplicates.
> **Reason:** `hostServices.ts`'s `createHeadlessHostSeams` is explicitly NOT WIRED (hostServices.ts:361). Bootstrap.ts injects `createVscodeHostSeams` instead, whose `VscodeHostUI` delegates to `vscodeShim.window` (the rejecting path). The "disagreement" between hostServices.ts (silent undefined) and vscodeShim.ts (reject) is between dead code and live code — no service reaches hostServices.ts's UI stubs. The fix is not to "reconcile" two live layers but to delete or clearly deprecate the dead one.
> **Replaced with:** Delete the `createHeadlessHostSeams` function from `hostServices.ts` (or replace its body with a thrown `Error('createHeadlessHostSeams is not wired — use createVscodeHostSeams')` if imports elsewhere still reference it). The live policy (`vscodeShim`'s `headlessReject`) is already correct and needs no change.

8. **`src/standalone/hostServices.ts` — delete or hard-deprecate `createHeadlessHostSeams`**
   - **Context:** The function at line ~360 is documented as NOT CURRENTLY WIRED. Its `commands.executeCommand` (line 412) duplicates `vscodeShim`'s warn-once stub, and its `ui.showInputBox`/`showQuickPick` (lines 429-430) return `undefined` silently instead of rejecting.
   - **Logic:** Check for any remaining imports of `createHeadlessHostSeams`. If none exist outside the file itself, delete the function. If imports exist, replace the body with `throw new Error('createHeadlessHostSeams is not wired — standalone uses createVscodeHostSeams (bootstrap.ts:1127)')` to make any accidental use immediately visible.
   - **Edge Cases:** The `switchboardCommandRegistry` import at hostServices.ts:7 is used only by the dead function's `commands.executeCommand`. If the function is deleted, remove the import too.

### Throughout — audit callers.

9. **Audit all 126 `executeCommand('switchboard.*')` call sites in `src/services/`** for `return { success: true }` (or equivalent) after an `executeCommand` whose result they never inspect. Success must be conditional on the bridged call's result. Priority: arms reachable via `handleServiceVerb` → `_handleMessage` (the `kanbanVerb` default path), since those are the CLI-reachable arms. The `KanbanProvider.ts:12780` `createPlan` arm is the confirmed instance — there may be others.

## Verification Plan

### Automated Tests

1. Under the standalone host, `switchboard verb triggerAgentFromKanban '{...}'` dispatches (already bridged — regression test). After Phase 1, `switchboard verb` for an arm that internally calls an unbridged `executeCommand('switchboard.X')` throws `HeadlessUnimplementedCommandError` naming the command, rather than returning `{ success: true }`. After Phase 2 the bridged command dispatches.
2. `switchboard verb createPlan` (via `kanbanVerb`'s direct case) still creates a plan file. The WS/webview path (`_handleMessage` `case 'createPlan'`) no longer returns `{ success: true }` without a plan appearing; after Phase 2 step 6, `initiatePlan` is bridged and the plan file is written.
3. `refreshUI` and every `open*Panel` command still return silently — no throw, no warning. Verify via the `INERT_COMMANDS` set membership.
4. A grep gate asserts every `executeCommand('switchboard.*')` string in `src/services` appears in either `switchboardCommandRegistry` (bridged) or `INERT_COMMANDS` (inert), so a newly added command cannot default to silence. Implement as a test that reads `commandRegistry.ts` and greps `src/services/*.ts`.
5. With `SWITCHBOARD_HEADLESS_LENIENT=1`, behaviour matches today (warn once, continue, no throw).
6. `showInputBox` / `showQuickPick` reject identically whichever layer reaches them — verified by the existing `VscodeHostUI` → `vscodeShim.window` path. After Phase 3, `hostServices.ts`'s silent-undefined stubs are gone.
7. Extension host behaviour is unchanged across the whole suite — the `VscodeHostCommands` throw branch is unreachable because `registerSwitchboardCommand` populates the registry for every `switchboard.*` command.
8. The existing `verb-engine-headless-seams.test.js` test suite passes unchanged (it uses `VscodeHostCommands` with a booby-trapped vscode module — the throw for unbridged `switchboard.*` commands must not affect tests that only use registered commands).

### Goal Invariants

- Assert `HeadlessUnimplementedCommandError` is exported from `src/services/commandRegistry.ts`.
- Assert `INERT_COMMANDS` is a `Set<string>` exported from `src/services/commandRegistry.ts` and contains `switchboard.refreshUI` and `switchboard.openKanban`.
- Assert `VscodeHostCommands.executeCommand` in `src/services/hostSeams.ts` re-throws `HeadlessUnimplementedCommandError` (not swallowed by `catch`).
- Assert `createHeadlessHostSeams` is absent from `src/standalone/hostServices.ts` (or its body throws).
- Assert `switchboard.initiatePlan` appears in a `switchboardCommandRegistry.register(` call in `src/standalone/bootstrap.ts`.
- Assert no `executeCommand('switchboard.*')` call in `src/services/*.ts` is immediately followed by `return { success: true }` without inspecting the result (grep gate).
