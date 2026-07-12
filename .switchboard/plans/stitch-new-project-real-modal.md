# Replace the Stitch "New Project" Native Input Box with a Real In-Webview Modal

## Goal

Make the Stitch tab's **New Project** button open a proper modal inside the Design panel (title field, Create/Cancel), instead of bouncing the user out to the stock VS Code input box at the top of the window.

### Problem & root-cause analysis

`btnNewStitchProject` posts `stitchCreateProject` with no payload and a comment admitting the shortcut: *"Title is collected via a native VS Code input box on the host side"* (`design.js:2438-2447`). The provider then calls `vscode.window.showInputBox` (`DesignPanelProvider.ts:2505`). The native box detaches focus from the panel, looks nothing like the product, and is inconsistent with the panel's existing in-webview modals (e.g. the folder-manager modal). Note `window.prompt()` is a silent no-op in VS Code webviews — a real DOM modal is the only correct replacement (same class of constraint as the repo's confirm-gate rule; an *input* modal is allowed, confirm gates are not).

### Second native dialog in the same handler (discovered during feature reconciliation)

`stitchCreateProject` does NOT stop at the title input box. Immediately after it, the handler runs a **native `showQuickPick` brief-attach flow** (`DesignPanelProvider.ts:2511-2540`): a Yes/No "Attach a design brief?" pick, then a second pick listing every briefs file, then it reads the chosen brief and posts `stitchBriefInjected {content, projectId}` (`:2560-2561`). So "make New Project a modal" is a two-dialog problem, not one — removing only the title box would leave a native quick-pick popping up *after* the modal closes, which is exactly the jarring behaviour this subtask exists to kill.

> **Superseded:** (original Proposed Change #3) "drop the `showInputBox` call and its comment … The rest of the handler (create project, refresh project list, select the new project) is unchanged."
> **Reason:** "the rest is unchanged" is false and dangerous — the handler's `showQuickPick` brief-attach block (`:2511-2540`) is part of "the rest", and it is itself a native-dialog flow. Leaving it means New Project still bounces to a native dialog, defeating the goal; an implementer following the original text would ship a half-fixed flow.
> **Replaced with:** The modal collects the title only and posts `stitchCreateProject {title, workspaceRoot}`. The brief-attach `showQuickPick` block is **removed** from `stitchCreateProject` (see User Review + Proposed Change #3). Brief→project is fully covered — and better — by the sibling *"Send to Stitch"* subtask, which auto-names the project from the brief and generates immediately.

## Metadata

**Complexity:** 4
**Tags:** ux, webview, stitch

## User Review Required

- **Drop the "attach a brief at project creation" capability from New Project. (Recommended.)** Today, creating a Stitch project offers an optional native quick-pick to attach a brief, which pre-loads it into the prompt. This overlaps the Briefs tab's **Send to Stitch** button, which (after the sibling subtask) creates a brief-named project *and* fires generation — a strictly better brief→project path. Keeping brief-attach here would require rebuilding a two-step brief picker inside the webview modal (duplicating Send-to-Stitch) purely to preserve a redundant native flow. **Recommendation: remove it.** New Project = create an empty, titled project; use Send to Stitch to go from a brief. Flagged because it removes a user-reachable capability (even if a redundant one).

## Complexity Audit

### Routine
- Modal markup, open/close wiring, and the one-field handoff are pattern reuse from the folder modal.
- Deleting the `showInputBox` + `showQuickPick` blocks is straight deletion; the create/upsert/select tail of the handler is untouched.

### Complex / Risky
- Keyboard handling collisions: the panel has a global Escape handler that closes the Stitch preview pane (`design.js` keydown listener) — the modal's Escape must `stopPropagation` so closing the modal doesn't also close an open preview.
- Cross-subtask coupling: removing the brief-attach block changes who posts `stitchBriefInjected`. See Edge-Case & Dependency Audit.

## Edge-Case & Dependency Audit

- **Double-submit:** disable Create while the `stitchCreateProject` round-trip is in flight (`state.stitchBusy` already flips via `setStitchBusy`, `design.js:1838/1853`); re-enable on `stitchProjectsReady`/`stitchError`.
- **State restore:** the panel persists webview state — the modal should NOT persist as open across reloads (unlike the folder modal, there's nothing to restore; drop the state write).
- **Empty/blank title:** the webview keeps the modal open with the input outlined rather than submitting; the provider still defends (returns `stitchError` on missing/blank `title`) since the message could arrive from a stale client.
- **Dependencies & Conflicts (shared surface):** `stitchBriefInjected` is posted by BOTH `stitchCreateProject` (`:2561`) and the sibling `stitchSendBrief` (`:3088`). Removing the brief-attach block here makes `stitchSendBrief` the **sole** producer of `stitchBriefInjected`. The sibling *"Send to Stitch"* subtask changes that message's webview **handler** to auto-generate; to keep the two flows decoupled and order-independent, that subtask gates auto-generate on an explicit `autoGenerate` flag (see its plan). This subtask and Send-to-Stitch touch neighbouring cases in `DesignPanelProvider.ts` (`stitchCreateProject` vs `stitchSendBrief`) — no line-level merge conflict, but they share the `stitchBriefInjected` contract, so land them aware of each other.

## Dependencies

- No hard ordering vs the cache/tab subtasks. Soft coupling with `briefs-send-to-stitch-actually-sends.md` via the `stitchBriefInjected` contract (above) — either order works given the `autoGenerate` flag; if landing this first, `stitchBriefInjected` simply has one producer sooner.

## Adversarial Synthesis

**Risk Summary:** The real trap is scope, not code — "replace the input box" silently means "replace both native dialogs in the handler", and the brief-attach quick-pick is the one an implementer would miss. Resolved by explicitly removing it (superseded by Send-to-Stitch) and flagging the capability drop for review. Secondary risks are the classic modal ones: Escape must `stopPropagation` so it doesn't also close the preview pane, and Create must be double-submit-guarded via the existing `stitchBusy` lock.

## Proposed Changes

1. **`design.html`:** add a `stitch-new-project-modal` following the existing `folder-modal` markup/styling pattern — title text, single text input (placeholder "e.g. Onboarding Redesign"), Create (primary) and Cancel buttons.
2. **`design.js`:** New Project click → open the modal with the input focused (drop the "collected via a native VS Code input box" comment at `:2441`); Enter submits, Escape cancels (scoped with `stopPropagation` so it doesn't collide with the preview-pane Escape handler); Create posts `stitchCreateProject { title, workspaceRoot }` and closes the modal; empty title keeps the modal open with the input outlined rather than submitting. Keep the `state.stitchBusy` no-op guard on open.
3. **`DesignPanelProvider.ts` `stitchCreateProject` (`:2496`):** accept `message.title`; **delete** the `showInputBox` block (`:2505-2509`) **and** the `showQuickPick` brief-attach block (`:2511-2540`) **and** the `stitchBriefInjected` post that depended on it (`:2560-2562`); if `title` is missing/blank, return a `stitchError` (defensive — the webview no longer sends blanks). The create/upsert/`stitchProjectsReady`-with-`selectProjectId` tail (`:2542-2559`) is unchanged.
4. Reuse the existing busy/lock behavior: the button already no-ops while `state.stitchBusy`; keep the modal-open path behind the same guard, and hold the `_stitchOperationLock` across the create round-trip as today.

## Non-Goals

- No change to the brief→project creation path in the **Briefs** tab — the sibling subtask *"Send to Stitch actually sends"* owns that flow (auto-naming, not a modal).
- No redesign of other native dialogs in the panel.

## Verification Plan

- Click New Project → modal opens inside the panel, input focused; Enter and the Create button both create the project, the project list refreshes and selects it (existing behavior preserved).
- No native dialog appears at any point in the New Project flow (neither the title box nor a brief-attach quick-pick).
- Escape / Cancel closes without side effects and does not also close an open Stitch preview; empty submit is rejected inline.
- No `showInputBox` and no `showQuickPick` remain in the `stitchCreateProject` handler.

### Automated Tests

- Skipped this pass per session directive (SKIP TESTS). Manual verification above is the acceptance gate.

## Review Findings

Correct and complete: New Project opens the in-webview modal, posts `stitchCreateProject {title, workspaceRoot}`, and the provider drops both the `showInputBox` and the `showQuickPick` brief-attach block plus its dependent `stitchBriefInjected` post, defensively rejecting blank titles. Escape handling is right — the modal input's `stopPropagation` starves the bubble-phase preview-close handler (`design.js:2547`), so cancelling the modal doesn't also close an open Stitch preview. **No code changed for this subtask.** Validation: `design.js` passes a syntax check (compile/tests skipped per directive). No remaining risks.
