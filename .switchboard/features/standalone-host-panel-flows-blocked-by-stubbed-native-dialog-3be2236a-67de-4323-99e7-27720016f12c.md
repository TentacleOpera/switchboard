# Standalone Host: Panel Flows Blocked by Stubbed Native Dialogs

**Complexity:** 6

## Goal

Make three user journeys that are silently dead in the browser cockpit either work or fail loudly and actionably. Each one hangs off a stubbed host primitive - showWarningMessage and showInformationMessage, showOpenDialog, revealFileInOS - and in each case the code downstream of the stub is not merely a no-op but genuinely unreachable, so the user gets a control that appears to do nothing with no error and no explanation. The fix in each case is to declare the missing capability on the seam where it actually lives, render the right control instead of a dead one, and return a structured failure naming the exact thing the user must do. This is the capability-gating honesty contract applied to three concrete flows rather than to the seam layer in general.

## How the Subtasks Achieve This

- **Create Plans is unreachable on the standalone host**: the feature's **seam owner**. Introduces `supportsOpenDialog` *and* `supportsInteractiveDialogs` on the `HostUI` interface, sets them from a new `createVscodeHostSeams` capability option, and applies the standalone override at `bootstrap.ts:659` — the composition root that is actually wired, rather than the unwired `createHeadlessHostSeams` bundle. On top of that it adds a `createPlansSetFolder` verb whose validation resolves the real path before the prefix check (defeating symlink escape) and bounds typed paths to the open workspace roots, and enforces that same validation inside `createPlansDownloadZip`, which is the arm that actually walks the filesystem and is reachable over HTTP.
- **Create Plans: disclose the docs-zip path**: returns the zip's path in the verb body *and* pushes `createPlansZipReady`, rendering it in the panel with a Copy-path button, so finding the file no longer depends on an OS reveal whose failure is swallowed by two nested catches and which is a registered no-op stub on standalone. The reveal stays as a genuine convenience; it stops being load-bearing.
- **Cloud database presets silently abort on the standalone host**: gives `handleSetPresetDbPath` a real return type instead of `void`, **consumes** the `supportsInteractiveDialogs` flag the first subtask declares, and returns a structured failure naming the exact absolute folder the user must create — across all three of the method's dead dialog branches, not just the cloud one. It also replaces `SetupPanelProvider`'s unconditional `{ success: true }` with the real outcome, and routes the DB-path write through the `pathConfig` seam because the raw `vscode.workspace.getConfiguration(...).update(...)` it used is a deliberate no-op under the standalone shim.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Create Plans: disclose the docs-zip path instead of relying on a reveal that can silently fail](../plans/feature_plan_20260811150000_create_plans_zip_never_discloses_its_path.md) — **PLAN REVIEWED**
- [ ] [Create Plans is unreachable on the standalone host — the folder picker is a stubbed native dialog](../plans/feature_plan_20260811150100_create_plans_folder_picker_dead_on_standalone_host.md) — **PLAN REVIEWED**
- [ ] [Cloud database presets silently abort on the standalone host — the whole flow hangs off stubbed dialogs](../plans/feature_plan_20260811150200_cloud_db_preset_silently_aborts_on_standalone_host.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**The whole feature is serialised: folder picker → zip disclosure → cloud database preset.**

1. **Folder picker first — it owns the shared seam.** The other two subtasks previously each declared their own capability flag in the same two files, which was both a merge collision and an invitation to two different declaration mechanisms landing side by side. The picker plan now introduces **both** flags (`supportsOpenDialog`, `supportsInteractiveDialogs`) on `HostUI`, threads them through a new optional `createVscodeHostSeams(root, secrets, { ui })` parameter, and applies the standalone override at `src/standalone/bootstrap.ts:659`. Nothing else touches `hostSeams.ts`.
2. **Zip disclosure second.** The picker is what makes the pane *reachable* on standalone; the disclosure is what makes its *result* findable. Landing the picker first lets the disclosure be verified through the real browser UI instead of by POSTing `createPlansDownloadZip` at the API by hand.
3. **Cloud database preset last.** It **consumes** `supportsInteractiveDialogs` and will not compile before the picker plan lands.

> **Superseded:** "The **cloud database preset** subtask is functionally independent of both and can land at any point." and "**Shared seam block — serialise the edits.** All three add a capability flag to the same two places: the vscode UI seam in `src/services/hostSeams.ts` and the stub block in `src/standalone/hostServices.ts`."
> **Reason:** two errors found while auditing the subtasks against the source. (a) The cloud-preset subtask is *not* independent — it reads a flag that, under the reconciled design, one specific sibling introduces. (b) `src/standalone/hostServices.ts` is the wrong file entirely: `createHeadlessHostSeams` is **not wired**, as its own docstring states (`src/standalone/hostServices.ts:356-370`), and `bootstrap.ts:659` injects `createVscodeHostSeams(...)` instead. A flag declared in that block would compile, test green, and never fire on the real standalone host — all three plans would have shipped a fix that does nothing.
> **Replaced with:** the numbered ordering above, with one seam owner and `bootstrap.ts` as the standalone declaration site.

**Landmine for whoever writes the bootstrap override.** Do not copy the adjacent idiom at `src/standalone/bootstrap.ts:665-668` (`headlessSeams.watcher = { ...headlessSeams.watcher, watchFolder: … }`). `VscodeHostUI` and `VscodeHostFileWatcher` are **classes**; spreading an instance copies own enumerable properties only and drops every prototype method. That is latent for the watcher (nothing calls `watchPattern`/`watchFile` on standalone, despite the comment claiming they "stay stubbed" — they are `undefined`), but the UI seam has twelve methods the standalone host calls constantly, so the same pattern there would take the host down. Pass the capabilities into the constructor instead.

**Deliberately out of scope in all three, and worth keeping out:** implementing `showWarningMessage` / `showInformationMessage` / `showOpenDialog` as real interactive primitives on the standalone host. That would fix these three *and* every other stubbed-dialog flow in the codebase and is the better long-term answer, but it is a host-wide interaction primitive far larger than these defects and must not be smuggled in here. Note also that any such primitive would be for **multi-choice** dialogs only — plain confirm gates are forbidden in this repo and `window.confirm()` is a silent no-op in a webview regardless.

**Related but separate:** `VscodeHostCommands.executeCommand`'s blanket `catch { return undefined; }` is the structural enabler behind the swallowed reveal failure, and the `revealFileInOS` stub registration is what suppresses the one diagnostic that would have surfaced it. Both are owned by the **Host Seam Audits** feature, not this one. These three plans work correctly whether or not that lands.

**Migration:** none in any subtask. No persisted state changes shape and no settings key is added or renamed.

> **Superseded:** "the DB-path setting is written only on the success path, which none of these plans touches."
> **Reason:** the cloud-preset plan now does touch it. Its success path wrote through `vscode.workspace.getConfiguration(...).update(...)`, which is a **deliberate no-op** under the standalone shim (`src/standalone/vscodeShim.ts:178`) — so on the host this feature exists to fix, the switch never persisted while the method still reported success. Converting the method to return `{success:true}` without fixing that would have replaced a silent abort with a confident false success.
> **Replaced with:** the write (and its paired read) is routed through `HostPathConfigProvider.updateConfigWorkspace`, which the standalone provider implements against `config.json`. The *value* written is unchanged, so this is still not a data migration — but it is a behaviour change on shipped editor installs (the seam additionally mirrors the key into the workspace `config.json`) and is verified explicitly in that plan's test list.
