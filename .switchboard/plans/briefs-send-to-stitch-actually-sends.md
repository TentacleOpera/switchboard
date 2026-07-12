# Briefs "Send to Stitch" — Auto-Name the Project and Actually Generate

## Goal

Make the Briefs tab's **Send to Stitch** button do what it says: create the Stitch project named automatically from the brief's title (no input box), and immediately submit the brief as the generation prompt — instead of stopping at a pre-filled prompt box waiting for a second, undiscoverable click.

### Problem & root-cause analysis

The flow today (`stitchSendBrief`, `DesignPanelProvider.ts:3035-3096`): read the brief → **block on `vscode.window.showInputBox` for a project title** (pre-seeded with the brief title at `:3060-3064`, so the prompt is almost always redundant) → create the project → post `stitchProjectsReady {selectProjectId}` (`:3087`) then `stitchBriefInjected {content, projectId}` (`:3088`). The webview handler (`design.js:3123-3132`) then merely writes the brief into `stitch-prompt-input`, switches to the Stitch tab, and sets status *"Brief loaded — review and click Generate"*. So the button's name promises a send, but the implementation half-finishes twice: the "auto" name isn't automatic, and nothing is ever sent. Root cause: the flow was built as project-creation + prompt-injection, and the final generate step was left to the user without any UI signal stronger than a status line.

## Confirmed design decisions

- **Project title = brief title verbatim** (the webview already resolves `briefNode.title || name || 'Untitled'` at `design.js:2424-2425` and sends it as `message.briefTitle`); trim and fall back to the filename stem for untitled briefs. No dialog.
- **Auto-send:** after the project is created and selected, generation fires immediately with the brief content as the prompt — same code path as the Generate button (`stitchGenerate` message, `DesignPanelProvider.ts:3098`), so locks, spinner card, status handling, and screen-arrival flow are all inherited.
- **The prompt box still shows the brief** while generating (transparency: the user sees exactly what was sent and can iterate afterwards).

## Metadata

**Complexity:** 4
**Tags:** ux, webview, stitch, briefs

## User Review Required

- **None.** The behaviour (auto-name + auto-generate) is the stated goal; the failure modes below are handled by inheriting the existing Generate lock and error paths.

## Complexity Audit

### Routine
- Deleting the input box and reusing the Generate submit path are small, local edits.

### Complex / Risky
- **Ordering:** auto-send must not race project selection. `stitchProjectsReady (selectProjectId)` and `stitchBriefInjected` are posted back-to-back from the same handler (`:3087-3088`) and `window.postMessage` delivers them in order, so by the time the `stitchBriefInjected` handler runs the dropdown has already been set to the new project. Even so, pass `projectId` **explicitly** into the submit (from `msg.projectId`) rather than reading `stitchProjectSelect.value` — cheaper than reasoning about handler side effects and immune to any future async in the `stitchProjectsReady` handler.
- **Double-generation guard:** the injected auto-send and a user's impatient manual Generate click must not both fire. `stitchGenerate` acquires `_stitchOperationLock` (`:3101-3105`); note `stitchSendBrief` **releases** its own lock in its `finally` (`:3089-3090`) *before* the webview posts `stitchGenerate`, so there is no deadlock — the second `stitchGenerate` simply re-acquires the freed lock. Verify, don't assume.
- **Shared message contract:** `stitchBriefInjected` is consumed by one handler but (today) produced by two cases — see Edge-Case & Dependency Audit.

## Edge-Case & Dependency Audit

- **Failure cleanup:** if generation fails after the project was created, the empty project remains (acceptable — it's visible and reusable; do not auto-delete).
- **Long briefs:** prompt-size limits are Stitch's to enforce; surface its error via the existing `stitchError` path.
- **Dependencies & Conflicts (shared surface with New Project modal):** `stitchBriefInjected` is currently posted by BOTH `stitchSendBrief` (`:3088`) and `stitchCreateProject` (`:2561`). The sibling *"New Project modal"* subtask removes `stitchCreateProject`'s brief-attach block, which would leave `stitchSendBrief` the sole producer. To avoid coupling this subtask's landing to that one — and to guard against a future third producer accidentally auto-generating — gate the new auto-generate behaviour on an explicit `autoGenerate` flag on the message (Proposed Change #2). This subtask and New Project touch neighbouring cases (`stitchSendBrief` vs `stitchCreateProject`) — no line-level conflict, but land them aware of the shared contract.

## Dependencies

- Soft coupling with `stitch-new-project-real-modal.md` via the `stitchBriefInjected` contract (above). The `autoGenerate` flag makes the two order-independent — either can land first.

## Adversarial Synthesis

**Risk Summary:** Two ordering hazards and one shared-contract hazard. The auto-send must generate against the *new* project id (pass `msg.projectId` explicitly, don't trust the dropdown), and it must not deadlock or double-fire against the operation lock (safe today because `stitchSendBrief` frees its lock before the webview posts `stitchGenerate`). The shared hazard: `stitchBriefInjected` has two producers, so making its handler auto-generate unconditionally would also auto-generate New-Project-with-brief — resolved by gating on an explicit `autoGenerate` flag that only `stitchSendBrief` sets.

## Proposed Changes

1. **`DesignPanelProvider.ts` `stitchSendBrief` (`:3060-3065`):** delete the `showInputBox` block; use `message.briefTitle` as the project title directly — `const title = (message.briefTitle || '').trim() || <filename stem of the brief>`. Everything else in the handler stays (lock, create, upsert projects, `stitchProjectsReady` with `selectProjectId`). When posting `stitchBriefInjected`, add `autoGenerate: true` (Proposed Change #2 reads it).
2. **`design.js` `stitchBriefInjected` handler (`:3123`):** after filling the prompt input and switching tabs, if `msg.autoGenerate`, trigger generation for the injected project. Extract the inline Generate logic from the `btnGenerateStitch` click handler (`:2521-2543`) into a reusable helper `runStitchGenerate({ prompt, projectId, deviceType, modelId })` and call it from BOTH the button and here. For the auto path, pass `prompt: msg.content` (trimmed), `projectId: msg.projectId`, `deviceType: stitchDeviceSelect.value`, `modelId: state.stitchModelId`, guarding on `state.stitchBusy`. Status becomes "Generating from brief…" and the standard generating card (`showStitchGenerating`) takes over. When `msg.autoGenerate` is falsy, keep today's "Brief loaded — review and click Generate" behaviour (so any non-auto producer is unaffected).
3. **Prompt framing:** send the brief as the prompt. The Generate path only requires a non-empty prompt (`:2526`); a non-empty brief satisfies that, so the existing `--- Design Brief ---` wrapper is cosmetic. Prefer sending the raw brief content; if a wrapper is retained it is purely cosmetic and must not be the only thing making the prompt non-empty. (Decide in implementation — no behavioural impact.)
4. **Button affordance:** while the round-trip runs, the Send to Stitch button stays disabled via the existing `stitchBusy` wiring (`design.js:2423`, `setStitchBusy`); verify it now covers the full create+generate span (the span is two locked operations back-to-back, with a brief unlocked gap between `stitchSendBrief` completing and `stitchGenerate` starting — acceptable, the webview stays busy across it via `showStitchGenerating`).

## Non-Goals

- No change to which brief content is sent (the whole file). Framing is cosmetic per Proposed Change #3.
- No project-name dedup/uniqueness logic — Stitch allows duplicate titles; sending twice intentionally creates a new project each time (matches the current create-per-send behavior).
- No modal — the sibling "New Project modal" subtask covers the manual creation path only.

## Verification Plan

- Select a brief → Send to Stitch → no dialog appears; a project named after the brief shows up selected in the Stitch tab; generation starts unaided (spinner card, busy status); screens arrive and render normally.
- Brief with an empty/whitespace title → project named from the filename stem.
- Clicking while a Stitch operation is in flight is a no-op (existing lock), and the button re-enables afterwards.
- The prompt box contains the sent brief after generation begins.
- A `stitchBriefInjected` message WITHOUT `autoGenerate` (if any producer sends one) still only loads the brief and waits — no accidental generation.

### Automated Tests

- Skipped this pass per session directive (SKIP TESTS). Manual verification above is the acceptance gate.

## Review Findings

**CRITICAL (fixed):** Send-to-Stitch never actually generated. `stitchSendBrief` correctly auto-names and posts `stitchBriefInjected {autoGenerate:true}`, but the `stitchProjectsReady {selectProjectId}` posted immediately before it calls `setStitchBusy(true)` to load the new project's screens, and `runStitchGenerate` bails on `state.stitchBusy` — so the auto-generate silently no-opped, contradicting the plan's core acceptance ("generation starts unaided"). Fix (`src/webview/design.js`): when busy, stash the request in `state.stitchPendingAutoGenerate` and fire it from the `stitchScreensReady` handler once the (empty) screen-load clears busy; cleared on `stitchError`. `stitchGetProjectScreens` holds no operation lock, so the deferred `stitchGenerate` acquires `_stitchOperationLock` cleanly (no deadlock/double-fire; the Send button is busy-disabled across the gap). Validation: `design.js` syntax OK. Remaining risk (out of scope): generate leaves `stitchBusy` set until the next screens/project event — pre-existing and identical for manual Generate.
