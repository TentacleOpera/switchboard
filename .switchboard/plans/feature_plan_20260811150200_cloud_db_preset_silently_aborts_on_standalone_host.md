# A database path change reports success on the standalone host when the config write is a no-op, and three dialog branches are dead

## Goal

Stop `handleSetPresetDbPath` reporting `{success:true}` for a database relocation that did not happen, and give its three non-interactive dialog branches a real failure path on the standalone host. The defect is that a host-seam stub returns `undefined` and the method reads that as consent, so a switch that never occurred is reported as done — a confident lie, on a control that moves where the board lives.

> **Scope changed — the cloud presets are being retired, the defect underneath is not.**
>
> **Was:** "Make choosing a Google Drive / Dropbox / iCloud database location either work or fail loudly and actionably on the standalone host."
>
> **Why:** `retire-cloud-file-sync-db-path-presets.md` (PLAN REVIEWED) deletes the Google Drive, Dropbox and iCloud presets outright, calling the mechanism "a corruption generator" — every write rewrites the whole database file, and a sync client racing that rename is precisely the "stale image restored from a `.tmp`/backup" state the schema layer carries a permanent shim for. Making a retired preset fail politely is dead work. Neither plan flagged the other; this block is that reconciliation.
>
> **Now:** the same three defects, scoped to **any** database path change rather than the cloud branch. All of it survives the retirement, because none of it is preset-specific:
> 1. **The confident lie.** The success path's config write is a shim no-op on the standalone host, and the method returns success anyway. This is the load-bearing defect and it applies to Edit Path and Use Local DB exactly as it did to the presets.
> 2. **Three dead dialog branches**, not one — the cloud branch, the non-cloud "Create it?" prompt, and the migration-conflict prompt. The last is the worst: it silently switches the DB anyway.
> 3. **The capability-flag declaration** must land on the seam that is actually wired. `createHeadlessHostSeams` is **not** wired (its own docstring says so); `bootstrap.ts:659` injects `createVscodeHostSeams`. A flag declared in the unwired bundle compiles, tests green, and leaves the live standalone host unfixed.
>
> **Drop from scope:** the Google Drive `~/Library/CloudStorage` account scan and `<entry>/My Drive/Switchboard/kanban.db` resolution, the Dropbox and iCloud path resolution, and any verification step that selects a cloud preset. Read the sections below with the cloud preset as the *worked example* of the defect, not as the thing being fixed. Where a step is preset-only, it goes; where it is about the dialog seam or the success report, it stays.
>
> **Sequencing:** if `retire-cloud-file-sync-db-path-presets.md` lands first, `handleSetPresetDbPath` may be gone entirely — in that case the remaining work is the same guard on whatever survives as the path-change entry point (`editDbPath` at `TaskViewerProvider.ts:15818`, `setLocalDb` at `:15814`). Check which entry points exist before starting.

## Goal — problem analysis and root cause

### What this feature is

Switchboard can put its `kanban.db` in a cloud-synced folder so one board follows the user across machines. The Setup panel offers built-in presets — Google Drive, Dropbox, iCloud (`src/webview/setup.html:2529` posts `setPresetDbPath`), routed through `SetupPanelProvider.ts:968-973` into `TaskViewerProvider.handleSetPresetDbPath` (`src/services/TaskViewerProvider.ts:11330`).

The method resolves the preset to a concrete path — for Google Drive, by scanning `~/Library/CloudStorage` for the account entry and targeting `<entry>/My Drive/Switchboard/kanban.db` (`src/services/TaskViewerProvider.ts:11334-11355`).

Then it hits a genuine OS constraint. **The extension cannot create a folder inside a cloud-storage mount** — the provider's file-system driver rejects it. So it asks the user to create the folder by hand, and helps by opening the parent location:

```ts
// src/services/TaskViewerProvider.ts:11392-11432 (condensed)
const choice = await this._seams().ui.showWarningMessage(
    `The "${folderName}" folder does not exist in your cloud storage. ` +
    `This extension cannot create it automatically due to OS restrictions. ` + msgSuffix,
    ...actions                                    // ['Open in Finder', 'Cancel'] on macOS
);
if (choice === 'Open in Finder') {
    …
    await this._seams().commands.executeCommand('revealFileInOS', vscode.Uri.file(openDir));
    const retryChoice = await this._seams().ui.showInformationMessage(
        `Create the "${folderName}" folder in the My Drive folder then click Continue.`, 'Continue', 'Cancel'
    );
    if (retryChoice !== 'Continue') { return; }
    …
}
```

So the reveal here is not a convenience — it is the *referent* of the instruction. The message says "in the location opened by Finder", which is incoherent if no Finder window opened.

### The defect

On the standalone host, **both** dialogs resolve to `undefined`:

- `src/standalone/vscodeShim.ts:133-134` — `showInformationMessage` and `showWarningMessage` both `return undefined`. This is the live path: the standalone bundle's webpack alias resolves `vscode` to the shim, and `bootstrap.ts:659` injects `createVscodeHostSeams(...)`, whose `VscodeHostUI` calls straight through to `vscode.window.*`.

Trace it through: `choice` is `undefined`, so `choice === 'Open in Finder'` is false and the entire branch — including the reveal — is **never entered**. The reveal at line 11415 is therefore not a no-op on this host, it is **unreachable code**. Implementing `revealFileInOS` for the standalone host would change nothing here.

The user-visible behaviour: pick a cloud preset in Setup whose target folder does not yet exist, and the operation returns having done nothing, said nothing, and explained nothing. The `return` paths in this method are `void` — there is no error channel back to the Setup panel at all.

A secondary cost, worth naming because it explains why this survived: `src/standalone/bootstrap.ts:848` registers `revealFileInOS` as a stub, and the command seam is registry-first (`src/services/hostSeams.ts:329-331`). Had it been left unregistered, `vscodeShim.executeCommand` would log `[headless] command 'revealFileInOS' is not bridged — the calling arm's side effect did not happen` (`src/standalone/vscodeShim.ts:244-250`). The stub suppresses that diagnostic.

> **Superseded:** "On the standalone host, both dialogs are stubbed to `undefined`: `src/standalone/hostServices.ts:423-424` — `showWarningMessage: async () => undefined`, `showInformationMessage: async () => undefined`; `src/standalone/vscodeShim.ts:133-134` — the same."
> **Reason:** the `hostServices.ts` half is dead code. `createHeadlessHostSeams` is **not wired** — its own docstring says so (`src/standalone/hostServices.ts:356-370`, "⚠️ NOT CURRENTLY WIRED") and `bootstrap.ts:659` injects `createVscodeHostSeams(...)` instead. This matters for more than pedantry: the original plan's step 2 declared `supportsInteractiveDialogs: false` in that bundle, which would have compiled, tested green, and left the flag `true` on the real standalone host — the fix would not have fired. Line numbers for the method and both call sites had also drifted (10908 → 11330; 13085 → 13509).
> **Replaced with:** the live stub is `vscodeShim.ts:133-134` reached via `VscodeHostUI`, and the capability flag is declared through `createVscodeHostSeams`'s options at `bootstrap.ts:659` — introduced by the sibling folder-picker plan, consumed here.

### The second defect: two more dead dialog branches in the same method

The original draft handled only the `_isCloudStoragePath` branch. Two others in the same method fail the same way and are reachable:

1. **`src/services/TaskViewerProvider.ts:11433-11448` — the non-cloud missing-parent branch.** `_isCloudStoragePath` (`:14597-14612`) matches only `cloudstorage`+`googledrive`, `mobile documents`, and `dropbox`. The Google Drive **fallback** path `~/Google Drive/Switchboard/kanban.db` (`:11348`) matches none of them — `"google drive"` has a space, so it is not `googledrive`. That path therefore lands in the `else`, which asks *"Directory not found at `<dir>`. Create it?"* and, on `undefined`, returns silently. Same defect, different branch.
2. **`src/services/TaskViewerProvider.ts:11458-11467` — the migration-conflict dialog.** When both the current and target databases contain plans, the user is asked to choose between `Open Reconciliation` and `Continue Anyway`. On a non-interactive host `migChoice` is `undefined`, so control **falls through and switches the DB path anyway** — silently choosing "Continue Anyway" on the user's behalf, on a database-location change. That is the most consequential of the three and must not be left as-is.

### The third defect: the success path does not persist on this host

`handleSetPresetDbPath` writes the setting with the raw VS Code API:

```ts
// src/services/TaskViewerProvider.ts:11451, 11473
const presetConfig = vscode.workspace.getConfiguration('switchboard');
…
await presetConfig.update('kanban.dbPath', presetPath, vscode.ConfigurationTarget.Workspace);
```

Under the standalone alias, `getConfiguration` returns `StandaloneConfiguration`, whose `update()` is **a deliberate no-op** (`src/standalone/vscodeShim.ts:178`). So on the standalone host the DB path is never written, `dbPathUpdated` is pushed, a `✅ Database location set to …` notification fires, and nothing changed.

This is decisive for the plan's shape. Converting the method's return type from `void` to `{ success: boolean; … }` **without** fixing the write turns a silent abort into a *confident false success* — strictly worse, and it would sail through a test that asserts `{success:true}` when the folder already exists. The write must go through the seam (`HostPathConfigProvider.updateConfigWorkspace`, `src/services/hostSeams.ts:186-190`), which is the host-agnostic path PRD contract #3 already mandates and which the standalone provider implements for real against `config.json` (`src/standalone/hostServices.ts:158-163`).

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, backend, ux, reliability
- **Project:** Browser Switchboard

## User Review Required

None. The scope boundary is set below: path **resolution** is untouched; only the failure paths, the config-write seam, and the result channel change.

## Complexity Audit

### Routine

- Detect that interactive dialogs are unavailable, and return a structured, actionable error through the verb's return body instead of falling off the end of the method.
- Swap one raw `vscode.workspace.getConfiguration(...).update(...)` for the equivalent seam call.

### Complex / Risky

1. **`handleSetPresetDbPath` returns `void`.** It currently communicates only through `showErrorMessage` and dialogs — both inert on the standalone host. Giving it a real result type touches its two call sites (`src/services/TaskViewerProvider.ts:13509`, `src/services/SetupPanelProvider.ts:969`), the second of which returns `{ success: true }` unconditionally today — i.e. the Setup panel reports success for an operation that may have silently aborted. That unconditional `success: true` is part of the defect and must be replaced with the real outcome.

2. **This is a database-location change on a published extension (~4,000 installs).** The plan must not alter *where* a preset resolves to, or the semantics of a successful switch — only what happens when the flow cannot proceed interactively, plus the seam the write goes through. Any change to path resolution is out of scope; a mistake there points a user's board at the wrong database.

3. **Swapping the config write to the seam is a behaviour change on the editor host, and must be recognised as one.** `VscodeHostPathConfigProvider.updateConfigWorkspace` calls `_writeConfigFile` **before** `vscode.workspace.getConfiguration('switchboard', <root>).update(key, value, false)` (`src/services/hostSeams.ts:186-190`). So editor installs additionally get `switchboard.kanban.dbPath` mirrored into the workspace `config.json`. That mirror is the established pattern for every other seam-routed setting in the codebase and is additive, but it is a new file write on a shipped install and belongs in the test plan, not in a footnote. Note also the scope argument shifts from `vscode.ConfigurationTarget.Workspace` to the seam's `false` (workspace scope) — the same target, expressed the seam's way.

4. **The Setup panel has no result channel today.** `src/webview/setup.html:2529` does a fire-and-forget `vscode.postMessage(...)`; the VS Code webview API returns nothing, so there is no `.then()` to hang a render on. In the browser cockpit the returned body **is** re-dispatched as a message (`src/webview/transport.js:405-412`), so a typed body reaches a handler there. The design must use that, not an imagined promise.

**Migration:** none. No stored state changes shape, no schema, no settings key is added or renamed. The DB-path setting is written only on the success path, whose *value* this plan does not change.

## Edge-Case & Dependency Audit

### Side Effects

| Case | Required behaviour |
| --- | --- |
| Editor host, cloud folder missing, user clicks Open in Finder | Unchanged — dialog, reveal, Continue prompt, retry. |
| Editor host, user cancels | Unchanged — returns without switching, now as `{success:false}` rather than `void`. |
| **Standalone host, cloud folder missing** | Return a structured failure naming **the exact absolute folder to create** and stating that Switchboard cannot create it. The user can then create it by any means and retry. |
| **Standalone host, non-cloud parent missing** (`~/Google Drive/Switchboard`) | Same structured failure shape. Do not silently return. |
| **Standalone host, migration conflict** (both DBs have plans) | Return `{success:false}` naming the conflict and pointing at Reconciliation. Must **not** fall through and switch anyway — that is silently choosing "Continue Anyway" for the user. |
| Standalone host, folder already exists | Proceeds — the interactive branches are only for the missing-folder cases and must not become a blanket "unsupported on this host". Success is reported only if the seam write actually persisted. |
| Preset not found at all (Drive/Dropbox/iCloud not installed) | Existing `showErrorMessage` path — also invisible on standalone. Route the same structured failure so it is visible there too. |
| Non-macOS editor host | `actions` is `['Cancel']` only and `msgSuffix` gives the literal path. Already degrades correctly; unchanged. |
| Setup panel currently reports success unconditionally | Must reflect the real outcome. A silent abort must not render as success. |
| Multiple workspaces | `targetWorkspaceRoot` threading is unchanged; the seam is constructed per workspace root, so the write lands on the same root `_resolveWorkspaceRoot` already picks. |
| User creates the folder then retries | Second invocation takes the exists-path and succeeds. Must require no restart. |
| Browser cockpit shows both a toast and a panel error | Accepted. `transport.js:381-390` toasts any `success:false` body and *also* dispatches it; the duplicate is noise, not a defect, and suppressing it would mean editing the shared `EXPECTED_QUIET` list for one flow. |

### Security

- No new input surface. `preset` is one of three literals already validated by the switch's `default` branch; the resolved path is derived from `os.homedir()`, never from the caller.

### Race Conditions

- None introduced. The method was already `await`-serialised end to end; the changes are return statements and one seam call.

## Dependencies

- `sess_none — no new package or service dependencies.`
- **Hard ordering dependency:** the sibling plan *"Create Plans is unreachable on the standalone host — the folder picker is a stubbed native dialog"* introduces `supportsInteractiveDialogs` on `HostUI`, sets it from `createVscodeHostSeams`'s options, and applies the standalone override at `bootstrap.ts:659`. **This plan consumes that flag and will not compile before it exists.** It must land second.

> **Superseded:** "Add `supportsInteractiveDialogs: true` to the vscode UI seam (`src/services/hostSeams.ts`) and `false` alongside the stubs in `src/standalone/hostServices.ts:423-424`."
> **Reason:** two problems. (a) The `hostServices.ts` half is dead code (see above), so the flag would stay `true` on the live standalone host. (b) All three subtasks in this feature were each declaring a capability flag in the same two files, which is a guaranteed merge collision and an invitation to two different declaration mechanisms landing side by side.
> **Replaced with:** the folder-picker plan owns the seam change and declares **both** flags once; this plan only reads `this._seams().ui.supportsInteractiveDialogs`.

**Out of scope**, flagged rather than silently absorbed:
- Implementing `showWarningMessage` / `showInformationMessage` as real interactive dialogs on the standalone host (i.e. a webview modal round-trip). That would fix this *and* every other stubbed-dialog flow in the codebase, and is the better long-term answer — but it is a host-wide interaction primitive, far larger than this defect, and must not be smuggled in here. Note also that Switchboard forbids plain confirm gates; any such primitive is for **multi-choice** dialogs only, which these flows legitimately are.
- `VscodeHostCommands.executeCommand`'s blanket `catch { return undefined; }` (`src/services/hostSeams.ts:333-335`), which turns every failed command into a silent success codebase-wide.
- Every *other* raw `vscode.workspace.getConfiguration(...).update(...)` in `TaskViewerProvider` — the same no-op-on-standalone trap applies to each, but this plan converts only the one on its own path.

## Adversarial Synthesis

**Key risks:** (1) returning `{success:true}` on a host where the config write is a shim no-op, converting a silent abort into a confident lie; (2) fixing only the cloud branch and leaving the non-cloud "Create it?" and migration-conflict dialogs equally dead — the latter silently switching the DB anyway; (3) hanging the panel render on a `postMessage` return value that does not exist in the VS Code webview API. **Mitigations:** the write is routed through `pathConfig.updateConfigWorkspace` and success is reported only after it; all three dialog branches get the non-interactive guard; the failure is delivered as a typed return body that `transport.js` re-dispatches, with the editor keeping its existing `showErrorMessage`.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts:11330` — give the method a real outcome

```ts
public async handleSetPresetDbPath(
    preset: string,
    targetWorkspaceRoot?: string
): Promise<{ success: boolean; error?: string; actionRequired?: { createFolder: string } }> {
```

Every existing `return;` becomes an explicit outcome. The preset-not-found branch (`:11370-11388`) keeps its `showErrorMessage` **and** returns `{ success: false, error: errorMsg }`. The terminal fall-through returns `{ success: true }` — but only after §4's write actually persisted.

### 2. `src/services/TaskViewerProvider.ts` — guard all three non-interactive branches

A single private helper keeps the three call sites honest:

```ts
/** Structured failure for a branch that can only proceed through an interactive
 *  dialog. On a host without them (standalone/browser) showWarningMessage resolves
 *  to undefined (vscodeShim.ts:133-134) — so the comparison below was false, the
 *  branch was never entered, and this method returned having done and said nothing. */
private _noninteractiveFolderFailure(parentDir: string) {
    const folderName = path.basename(parentDir);
    return {
        success: false,
        error: `Switchboard cannot create "${folderName}" from this host. `
             + `Create this folder yourself, then choose the preset again:\n${parentDir}`,
        actionRequired: { createFolder: parentDir }
    };
}
```

**Branch A — cloud storage (`:11392`):**

```ts
if (this._isCloudStoragePath(parentDir)) {
    if (!this._seams().ui.supportsInteractiveDialogs) {
        return this._noninteractiveFolderFailure(parentDir);
    }
    const folderName = path.basename(parentDir);
    const isMac = process.platform === 'darwin';
    // …existing interactive flow unchanged…
}
```

Note the wording change from the original draft's *"(the OS forbids it)"*: that reason is true for the cloud branch and false for branch B, and one helper serves both. The exact folder path — the one fact the user needs — is unchanged and still absolute.

**Branch B — non-cloud missing parent (`:11433`):**

```ts
} else {
    if (!this._seams().ui.supportsInteractiveDialogs) {
        // Reachable: the Google Drive FALLBACK path is `~/Google Drive/...`, which
        // _isCloudStoragePath does not match ("google drive" ≠ "googledrive").
        return this._noninteractiveFolderFailure(parentDir);
    }
    const choice = await this._seams().ui.showWarningMessage(
        `Directory not found at ${parentDir}. Create it?`, 'Create Directory', 'Cancel'
    );
    // …existing flow, with each `return;` becoming an explicit outcome…
}
```

**Branch C — migration conflict (`:11458`):**

```ts
if (migResult.skipped === 'target_has_data') {
    if (!this._seams().ui.supportsInteractiveDialogs) {
        // Falling through here would silently pick "Continue Anyway" and repoint the
        // board at a second populated database without the user ever being asked.
        return {
            success: false,
            error: `Both the current and target databases contain plans, so nothing was migrated `
                 + `and the location was not changed. Reconcile them from the VS Code extension first.`
        };
    }
    const migChoice = await this._seams().ui.showWarningMessage(…);   // unchanged
    …
}
```

### 3. `src/services/SetupPanelProvider.ts:968-973` — stop reporting unconditional success

```ts
case 'setPresetDbPath': {
    const result = await this._taskViewerProvider.handleSetPresetDbPath(
        message.preset,
        typeof message.targetWorkspaceRoot === 'string' ? message.targetWorkspaceRoot : undefined
    );
    // Was `return { success: true }` regardless of outcome — which is how a silent
    // abort rendered in the UI as a completed action. `type` lets transport.js
    // re-dispatch the body to the panel's own handler (transport.js:405-412).
    return { ...result, type: 'dbPresetResult' };
}
```

`src/services/TaskViewerProvider.ts:13509` currently awaits and discards, then returns a literal `{ success: true }`. Have it return the real result the same way.

### 4. `src/services/TaskViewerProvider.ts:11451, 11473` — write through the seam

```ts
// Was: vscode.workspace.getConfiguration('switchboard').update('kanban.dbPath', presetPath,
//      vscode.ConfigurationTarget.Workspace) — a DELIBERATE NO-OP under the standalone
//      shim (vscodeShim.ts:178), so the switch never persisted and this method still
//      reported success. The seam writes config.json on standalone and does the vscode
//      update (plus the config.json mirror) in the editor.
await this._seams().pathConfig.updateConfigWorkspace('kanban.dbPath', presetPath);
```

The sibling read at `:11455` (`presetConfig.get<string>('kanban.dbPath', '')`, used to find the old path for migration) should move to `this._seams().pathConfig.getConfigString('kanban.dbPath')` in the same change — otherwise the standalone host reads through the shim's `StandaloneConfiguration.get`, which resolves against `config.json` anyway but by a second, unrelated route.

> **Superseded:** the original plan's implicit assumption that the existing success path is correct and only the failure paths need work ("The DB-path setting is written only on the success path, which this plan does not touch").
> **Reason:** the success path's write is a no-op on the very host this plan targets. Leaving it while adding `{success:true}` returns would replace a silent abort with a false success — the exact failure mode the plan exists to remove, relocated one step later.
> **Replaced with:** route the write (and its paired read) through the `pathConfig` seam, and report success only after it.

### 5. `src/webview/setup.html` — render the failure

Add a handler for the `dbPresetResult` message (the panel's existing `window.addEventListener('message', …)` switch). When `success` is false, show `error` in the database section's status area. When `actionRequired.createFolder` is present, render that path with a **Copy path** button (`navigator.clipboard.writeText`, called synchronously inside the click so the transient user activation still holds), so the user can paste it straight into Finder's *Go to Folder* or a terminal.

This is delivered by `transport.js`'s re-dispatch of the returned body in the browser cockpit. In the editor, `postMessage` is fire-and-forget and the existing `showErrorMessage` dialogs remain the channel — the editor host has `supportsInteractiveDialogs: true`, so it never reaches the new branches anyway.

## Verification Plan

*(Compilation and automated test execution are out of scope for this planning pass per session directive; the steps below are what the implementer runs.)*

**Automated**
1. `npx tsc --noEmit -p tsconfig.json` — the signature change must compile at **both** call sites (`TaskViewerProvider.ts:13509` and `SetupPanelProvider.ts:969`); a missed one is a type error, which is the point of returning a value.
2. `npm run verb-returns:check` — the Setup provider's ceiling is unchanged by this plan (it already returns), but run it to confirm.
3. New test `src/test/cloud-db-preset-noninteractive.test.js`:
   - seam with `supportsInteractiveDialogs: false` and a **cloud** parent dir that does not exist → assert `{ success: false }`, that `error` contains the **absolute** `parentDir`, and that `actionRequired.createFolder` equals it;
   - assert `showWarningMessage` is **not** called in that path (no reliance on a stub returning undefined);
   - same for the **non-cloud** parent (`~/Google Drive/Switchboard`) — proves branch B is covered and that `_isCloudStoragePath` does not match it;
   - migration conflict (`migResult.skipped === 'target_has_data'`) on a non-interactive seam → assert `{success:false}` **and** that `updateConfigWorkspace` was never called (proves it did not silently "Continue Anyway");
   - seam with `supportsInteractiveDialogs: true` → assert the existing interactive flow still runs and `revealFileInOS` is still invoked with a `Uri` when the user picks `Open in Finder`;
   - folder already exists on a non-interactive host → assert `updateConfigWorkspace('kanban.dbPath', <path>)` **was** called and the result is `{ success: true }` (the guard must not become a blanket host block, and success must be conditional on the write);
   - preset entirely absent → `{ success: false }` with the preset-specific message.
4. Assert `SetupPanelProvider`'s `setPresetDbPath` arm returns the real result, not a literal `{ success: true }`, and that the body carries `type: 'dbPresetResult'`.
5. Assert the editor seam's `updateConfigWorkspace` still reaches `vscode.workspace.getConfiguration(...).update(...)` with workspace scope — the byte-compat guard for shipped installs.

**Manual — browser cockpit** (the case that is silent today)
6. Setup → database location → choose Google Drive with no `Switchboard` folder in My Drive. A visible error must name the exact folder to create, with a working `Copy path` button. Today this does nothing at all.
7. Create that folder manually, choose the preset again. It must succeed with no restart — and `config.json` must actually contain `switchboard.kanban.dbPath`. Restart `npx switchboard` and confirm the board opens against the cloud DB; this is the step that proves the success is real rather than a no-op write.
8. Choose a preset for a provider that is not installed. The provider-specific error must be visible in the panel.

**Manual — VS Code editor panel** (must be unchanged)
9. Same missing-folder scenario: the warning dialog appears, `Open in Finder` opens Finder at My Drive, the Continue prompt follows, and creating the folder then clicking Continue completes the switch.
10. Cancel at each prompt and confirm no DB-path change is written.
11. After a successful switch, confirm `switchboard.kanban.dbPath` is set in the workspace settings **and** mirrored into the workspace `config.json` — the seam's added write, verified deliberately rather than discovered.

**Regression guard**
12. `setCustomDbPath` and `resetDatabase` (the sibling arms in `SetupPanelProvider.ts:974-978`) must behave exactly as before.
13. Confirm a successful preset switch still points the board at the cloud `kanban.db` and that no path-**resolution** behaviour changed — this plan alters the failure paths and the write seam, nothing about where a preset resolves to.

## Recommendation

Complexity 5 → **Send to Coder.**
