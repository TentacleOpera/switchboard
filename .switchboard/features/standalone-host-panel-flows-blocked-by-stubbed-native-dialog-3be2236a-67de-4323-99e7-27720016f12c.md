# Standalone Host: Panel Flows Blocked by Stubbed Native Dialogs

**Complexity:** 5

## Goal

Make three user journeys that are silently dead in the browser cockpit either work or fail loudly and actionably. Each one hangs off a stubbed host primitive - showWarningMessage and showInformationMessage, showOpenDialog, revealFileInOS - and in each case the code downstream of the stub is not merely a no-op but genuinely unreachable, so the user gets a control that appears to do nothing with no error and no explanation. The fix in each case is to declare the missing capability on the seam where it actually lives, render the right control instead of a dead one, and return a structured failure naming the exact thing the user must do. This is the capability-gating honesty contract applied to three concrete flows rather than to the seam layer in general.

## How the Subtasks Achieve This

- **Cloud database presets silently abort on the standalone host**: gives `handleSetPresetDbPath` a real return type instead of `void`, adds `supportsInteractiveDialogs` to the UI seam, and returns a structured failure naming the exact absolute folder the user must create. It also replaces `SetupPanelProvider`'s unconditional `{ success: true }` — which is how a silent abort rendered in the UI as a completed action — with the real outcome.
- **Create Plans is unreachable on the standalone host**: adds `supportsOpenDialog` capability detection so the webview renders a typed-path input instead of a native picker that yields nothing, plus a `createPlansSetFolder` verb whose validation resolves the real path before the prefix check (defeating symlink escape) and bounds typed paths to the open workspace roots — a materially different trust level from a local user clicking through an OS dialog.
- **Create Plans: disclose the docs-zip path**: pushes `createPlansZipReady` with the zip's path into the panel with a Copy-path button, so finding the file no longer depends on an OS reveal whose failure is swallowed by two nested catches and which is a registered no-op stub on standalone. The reveal stays as a genuine convenience; it stops being load-bearing.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Create Plans: disclose the docs-zip path instead of relying on a reveal that can silently fail](../plans/feature_plan_20260811150000_create_plans_zip_never_discloses_its_path.md) — **PLAN REVIEWED**
- [ ] [Create Plans is unreachable on the standalone host — the folder picker is a stubbed native dialog](../plans/feature_plan_20260811150100_create_plans_folder_picker_dead_on_standalone_host.md) — **PLAN REVIEWED**
- [ ] [Cloud database presets silently abort on the standalone host — the whole flow hangs off stubbed dialogs](../plans/feature_plan_20260811150200_cloud_db_preset_silently_aborts_on_standalone_host.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**One real ordering constraint, between the two Create Plans subtasks.** The folder picker is what makes the pane *reachable* on standalone; the zip-path disclosure is what makes its *result* findable. Land **folder picker → zip disclosure**. The disclosure plan says as much itself: its browser verification step notes that if the pane cannot be reached because the picker is stubbed, that separately-tracked blocker must be worked around by invoking `createPlansDownloadZip` directly against the API. Landing the picker first removes the need for that workaround and lets the disclosure be verified through the real UI.

The **cloud database preset** subtask is functionally independent of both and can land at any point.

**Shared seam block — serialise the edits.** All three add a capability flag to the same two places: the vscode UI seam in `src/services/hostSeams.ts` and the stub block in `src/standalone/hostServices.ts`. Two distinct flags are introduced (`supportsInteractiveDialogs`, `supportsOpenDialog`); declare each where the capability actually lives rather than inferring it from a user agent or a host name.

**Deliberately out of scope in all three, and worth keeping out:** implementing `showWarningMessage` / `showInformationMessage` / `showOpenDialog` as real interactive primitives on the standalone host. That would fix these three *and* every other stubbed-dialog flow in the codebase and is the better long-term answer, but it is a host-wide interaction primitive far larger than these defects and must not be smuggled in here. Note also that any such primitive would be for **multi-choice** dialogs only — plain confirm gates are forbidden in this repo and `window.confirm()` is a silent no-op in a webview regardless.

**Related but separate:** `VscodeHostCommands.executeCommand`'s blanket `catch { return undefined; }` is the structural enabler behind the swallowed reveal failure, and the `revealFileInOS` stub registration is what suppresses the one diagnostic that would have surfaced it. Both are owned by the **Host Seam Audits** feature, not this one. These three plans work correctly whether or not that lands.

**Migration:** none in any subtask. No persisted state changes shape; the DB-path setting is written only on the success path, which none of these plans touches.
