# Cloud database presets silently abort on the standalone host — the whole flow hangs off stubbed dialogs

## Goal

Make choosing a Google Drive / Dropbox / iCloud database location either work or fail **loudly and actionably** on the standalone host, instead of returning silently and leaving the user with a Setup control that appears to do nothing.

## Goal — problem analysis and root cause

### What this feature is

Switchboard can put its `kanban.db` in a cloud-synced folder so one board follows the user across machines. The Setup panel offers built-in presets — Google Drive, Dropbox, iCloud (`src/webview/setup.html:2529` posts `setPresetDbPath`), routed through `SetupPanelProvider.ts:968-973` into `TaskViewerProvider.handleSetPresetDbPath` (`src/services/TaskViewerProvider.ts:10908`).

The method resolves the preset to a concrete path — for Google Drive, by scanning `~/Library/CloudStorage` for the account entry and targeting `<entry>/My Drive/Switchboard/kanban.db` (`src/services/TaskViewerProvider.ts:10914-10920`).

Then it hits a genuine OS constraint. **The extension cannot create a folder inside a cloud-storage mount** — the provider's file-system driver rejects it. So it asks the user to create the folder by hand, and helps by opening the parent location:

```ts
// src/services/TaskViewerProvider.ts:10970-11000 (condensed)
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

On the standalone host, **both** dialogs are stubbed to `undefined`:

- `src/standalone/hostServices.ts:423-424` — `showWarningMessage: async () => undefined`, `showInformationMessage: async () => undefined`
- `src/standalone/vscodeShim.ts:133-134` — the same

Trace it through: `choice` is `undefined`, so `choice === 'Open in Finder'` is false and the entire branch — including the reveal — is **never entered**. The reveal at line 10987 is therefore not a no-op on this host, it is **unreachable code**. Implementing `revealFileInOS` for the standalone host would change nothing here.

The user-visible behaviour: pick a cloud preset in Setup whose target folder does not yet exist, and the operation returns having done nothing, said nothing, and explained nothing. The `return` paths in this method are `void` — there is no error channel back to the Setup panel at all.

A secondary cost, worth naming because it explains why this survived: `src/standalone/bootstrap.ts:783` registers `revealFileInOS` as a stub, and the command seam is registry-first (`src/services/hostSeams.ts:329-331`). Had it been left unregistered, `vscodeShim.executeCommand` would log `[headless] command 'revealFileInOS' is not bridged — the calling arm's side effect did not happen` (`src/standalone/vscodeShim.ts:244-250`). The stub suppresses that diagnostic.

## Metadata

- **Complexity:** 3
- **Tags:** bugfix, backend, ux, reliability
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine.** Detect that interactive dialogs are unavailable, and return a structured, actionable error through the panel's existing push channel instead of falling off the end of the method.

**Complex/Risky — two items.**

1. **`handleSetPresetDbPath` returns `void`.** It currently communicates only through `showErrorMessage` and dialogs — both stubbed on the standalone host. Giving it a real result type touches its two call sites (`src/services/TaskViewerProvider.ts:13085`, `src/services/SetupPanelProvider.ts:969`), the second of which returns `{ success: true }` unconditionally today — i.e. the Setup panel reports success for an operation that may have silently aborted. That unconditional `success: true` is part of the defect and must be replaced with the real outcome.

2. **This is a database-location change on a published extension (~4,000 installs).** The plan must not alter *where* a preset resolves to, or the semantics of a successful switch — only what happens when the flow cannot proceed interactively. Any change to path resolution is out of scope; a mistake there points a user's board at the wrong database.

**Migration:** none. No stored state changes, no schema, no settings key. The DB-path setting is written only on the success path, which this plan does not touch.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| --- | --- |
| Editor host, folder missing, user clicks Open in Finder | Unchanged — dialog, reveal, Continue prompt, retry. |
| Editor host, user cancels | Unchanged — returns without switching. |
| **Standalone host, folder missing** | Return a structured failure naming **the exact absolute folder to create** and stating that the extension cannot create it. The user can then create it by any means and retry. |
| Standalone host, folder already exists | Must proceed normally — the interactive branch is only for the missing-folder case, and must not become a blanket "unsupported on this host". |
| Preset not found at all (Drive/Dropbox/iCloud not installed) | Existing `showErrorMessage` path — also invisible on standalone. Route the same structured failure so it is visible there too. |
| Non-macOS editor host | `actions` is `['Cancel']` only and `msgSuffix` gives the literal path. Already degrades correctly; unchanged. |
| Setup panel currently reports success unconditionally | Must reflect the real outcome. A silent abort must not render as success. |
| Multiple workspaces | `targetWorkspaceRoot` threading is unchanged. |
| User creates the folder then retries | Second invocation takes the exists-path and succeeds. Must require no restart. |

**Dependencies:** none new.

**Out of scope**, flagged rather than silently absorbed:
- Implementing `showWarningMessage` / `showInformationMessage` as real interactive dialogs on the standalone host (i.e. a webview modal round-trip). That would fix this *and* every other stubbed-dialog flow in the codebase, and is the better long-term answer — but it is a host-wide interaction primitive, far larger than this defect, and must not be smuggled in here. Note also that Switchboard forbids plain confirm gates; any such primitive is for **multi-choice** dialogs only, which this flow legitimately is.
- `VscodeHostCommands.executeCommand`'s blanket `catch { return undefined; }` (`src/services/hostSeams.ts:333-335`), which turns every failed command into a silent success codebase-wide.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — give the method a real outcome

Change the signature and return structured results rather than `void`:

```ts
public async handleSetPresetDbPath(
    preset: string,
    targetWorkspaceRoot?: string
): Promise<{ success: boolean; error?: string; actionRequired?: { createFolder: string } }> {
```

Every existing `return;` becomes an explicit outcome. The preset-not-found branch (`src/services/TaskViewerProvider.ts:10950-10966`) keeps its `showErrorMessage` **and** returns `{ success: false, error: errorMsg }`.

### 2. `src/services/TaskViewerProvider.ts` — handle the non-interactive host in the missing-folder branch

```ts
if (this._isCloudStoragePath(parentDir)) {
    const folderName = path.basename(parentDir);

    // On a host without interactive dialogs (standalone/browser), showWarningMessage
    // resolves to undefined — so `choice === 'Open in Finder'` was false, the reveal
    // below was never reached, and this method returned having done and said nothing.
    // Fail loudly with the one fact the user needs: the exact folder to create.
    if (!this._seams().ui.supportsInteractiveDialogs) {
        return {
            success: false,
            error: `Switchboard cannot create "${folderName}" inside cloud storage (the OS forbids it). `
                 + `Create this folder yourself, then choose the preset again:\n${parentDir}`,
            actionRequired: { createFolder: parentDir }
        };
    }

    const isMac = process.platform === 'darwin';
    // …existing interactive flow unchanged…
}
```

Add `supportsInteractiveDialogs: true` to the vscode UI seam (`src/services/hostSeams.ts`) and `false` alongside the stubs in `src/standalone/hostServices.ts:423-424`, so the capability is declared where it actually lives rather than inferred.

### 3. `src/services/SetupPanelProvider.ts` — stop reporting unconditional success

```ts
case 'setPresetDbPath': {
    const result = await this._taskViewerProvider.handleSetPresetDbPath(
        message.preset,
        typeof message.targetWorkspaceRoot === 'string' ? message.targetWorkspaceRoot : undefined
    );
    // Was `return { success: true }` regardless of outcome — which is how a silent
    // abort rendered in the UI as a completed action.
    return result;
}
```

### 4. `src/webview/setup.html` — render the failure

Where `setPresetDbPath`'s result is handled (near line 2529), show `result.error` in the panel's status area when `success` is false. When `actionRequired.createFolder` is present, render that path with a **Copy path** button (`navigator.clipboard.writeText`, synchronous inside the click), so the user can paste it straight into Finder's *Go to Folder* or a terminal.

### 5. `src/services/TaskViewerProvider.ts:13085` — propagate at the second call site

That caller currently awaits and discards. Have it surface the failure the same way rather than swallowing it.

## Verification Plan

**Automated**
1. `npx tsc --noEmit -p tsconfig.json` — the signature change must compile at **both** call sites (13085 and `SetupPanelProvider.ts:969`); a missed one is a type error, which is the point of returning a value.
2. `npm test` — no regressions (five tests already red at HEAD; stash-verify first).
3. New test `src/test/cloud-db-preset-noninteractive.test.js`:
   - seam with `supportsInteractiveDialogs: false` and a cloud parent dir that does not exist → assert the result is `{ success: false }`, that `error` contains the **absolute** `parentDir`, and that `actionRequired.createFolder` equals it;
   - assert `showWarningMessage` is **not** called in that path (no reliance on a stub returning undefined);
   - seam with `supportsInteractiveDialogs: true` → assert the existing interactive flow still runs and `revealFileInOS` is still invoked with a `Uri` when the user picks `Open in Finder`;
   - folder already exists on a non-interactive host → assert it proceeds and returns `{ success: true }` (the guard must not become a blanket host block);
   - preset entirely absent → `{ success: false }` with the preset-specific message.
4. Assert `SetupPanelProvider`'s `setPresetDbPath` arm returns the real result, not a literal `{ success: true }`.

**Manual — browser cockpit** (the case that is silent today)
5. Setup → database location → choose Google Drive with no `Switchboard` folder in My Drive. A visible error must name the exact folder to create, with a working `Copy path` button. Today this does nothing at all.
6. Create that folder manually, choose the preset again. It must succeed with no restart.
7. Choose a preset for a provider that is not installed. The provider-specific error must be visible in the panel.

**Manual — VS Code editor panel** (must be unchanged)
8. Same missing-folder scenario: the warning dialog appears, `Open in Finder` opens Finder at My Drive, the Continue prompt follows, and creating the folder then clicking Continue completes the switch.
9. Cancel at each prompt and confirm no DB-path change is written.

**Regression guard**
10. `setCustomDbPath` and `resetDatabase` (the sibling arms in `SetupPanelProvider.ts:962-978`) must behave exactly as before.
11. Confirm a successful preset switch still points the board at the cloud `kanban.db` and that no path-resolution behaviour changed — this plan must alter only the non-interactive failure path.
