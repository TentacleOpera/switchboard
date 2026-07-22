# Kanban Worktree Button: Context-Sensitive Merge Mode

## Goal

The kanban board's **Create Worktree** strip-icon button (`btn-create-worktree`) is create-only today. When a worktree already exists for the current selection context (active project filter, or selected feature), the button either goes dead (feature case) or silently no-ops with a toast (project case). The merge-and-cleanup flow — which already exists as the **Merge prompt** button in the Worktrees tab — is not reachable from the kanban board itself.

**Redesign:** the same strip-icon button flips to a **merge mode** when a worktree already exists for the current context. In merge mode, clicking copies the merge-and-cleanup prompt to the clipboard (same `copyWorktreeMergePrompt` verb the Worktrees tab uses). The button visually changes color (yellow for afterburner, Claude-orange tint for claudify) and its tooltip reflects the new action. After the prompt is copied, the button disables until the API reports the worktree cleaned up.

### Problem Analysis

**Root cause:** `updateCreateWorktreeButton()` (`kanban.html:5851–5885`) is selection/feature-aware but project-blind, and it has no "merge" mode at all — only create or disabled. The merge-prompt verb (`copyWorktreeMergePrompt`) and its clipboard-delivery event (`mergePromptReady`) exist in the backend and are wired to the Worktrees tab, but the kanban strip-icon has no path to them.

**Current state machine (`updateCreateWorktreeButton`):**
| Selection | Worktree exists? | Button |
|---|---|---|
| Nothing selected | n/a | enabled — "Create a worktree for the active project / workspace" |
| 1 feature, no worktree | no | enabled — "Create a worktree for this feature" |
| 1 feature, has worktree | yes | **disabled** — "Feature already has a worktree" |
| 1 non-feature | n/a | disabled — "Only feature cards can have worktrees" |
| 2+ selected | n/a | disabled — "Select a single feature to create its worktree" |

**Gap:** the "project already has a worktree" case is not detected at all, and the "feature already has a worktree" case disables the button instead of offering merge.

**Worktree payload schema (verified, `KanbanProvider.ts:10882–10892`):** each entry in `lastWorktreeConfig.worktrees` carries `{ id, branch, path, featureId, createdAt, project, agentsOpenWithGrid, featureTopic, featureProject }`. There is **no `status` field** on worktree objects. List membership IS the active signal — cleaned-up worktrees are removed from the list by the host (the cleanup-clears-flag logic in step 5 relies on this). The existing `recomputeWorktreeIndicator` (`kanban.html:5817–5845`) confirms this: it tests presence + `w.path`/`w.featureId`/`w.project`, never `w.status`.

## Metadata

**Complexity:** 4
**Tags:** ui, ux, refactor, feature
**Project:** Browser Switchboard

## User Review Required

Yes — this is a UX-visible behavior change to a shipped strip-icon button (~4,000 installs per PRD contract #2). The button's affordance flips from "create or dead" to "create or merge" depending on worktree state. Reviewer should confirm: (a) the mode-flip is the desired UX vs. a second dedicated merge button, (b) the yellow/orange merge-mode coloring is acceptable in both themes, (c) disabling the button until cleanup (with the Worktrees tab as the cancel hatch) is the right lifecycle. No backend changes; ships behind existing verb wiring, so default-OFF risk is limited to the webview layer.

## Complexity Audit

### Routine
- Adding one module-scoped state variable (`mergePendingWorktreeId`) next to existing worktree state.
- Adding CSS rules for `.merge-mode` (two theme variants) near existing claudify overrides.
- Toggling a CSS class and tooltip string per branch in an existing function.
- Reusing the existing `copyWorktreeMergePrompt` helper and `mergePromptReady` event — no new verbs, no backend work.
- Verification is manual click-through in both themes.

### Complex / Risky
- The mode resolution in `updateCreateWorktreeButton` must mirror the existing `recomputeWorktreeIndicator` lookup exactly (feature: `currentFeatureWorktrees[pid]` OR `worktrees.some(w => String(w.featureId) === String(pid))`; project: `worktrees.find(w => w.project && w.project === activeProjectFilter)`). Diverging from the indicator's logic produces a button that disagrees with the indicator dot.
- The `mergePendingWorktreeId` lifecycle must be race-safe against `updateBoard` (line 7088) and `worktreeConfig` (line 7187) re-evaluating the button between click and `mergePromptReady` response. Set the flag optimistically in the click handler, not in the response.
- The `mergePromptReady` handler gains a parallel strip-icon path; the existing `button[data-wt-id=...]` selector path must remain untouched and the strip-icon must NOT carry `data-wt-id` (it carries `data-merge-worktree-id` instead) so the two paths never collide.

## Edge-Case & Dependency Audit

**Race Conditions:**
- Click → `copyWorktreeMergePrompt` post → `mergePromptReady` response is asynchronous. Between post and response, `updateCreateWorktreeButton()` can fire from `updateBoard` or `worktreeConfig`. If `mergePendingWorktreeId` is not yet set, the button re-evaluates to merge-mode-enabled (worktree still present) → user can double-click → two prompts copied. **Mitigation:** set `mergePendingWorktreeId` in the click handler BEFORE posting; the `mergePromptReady` error path clears it (re-eval re-enables for retry).
- `worktreeConfig` arriving while merge-pending: step 5 clears the flag only when the worktree is no longer in the list. If the host re-sends an unchanged config, the flag correctly persists (worktree still active).

**Security:**
- `navigator.clipboard.writeText` is gated by user gesture (the click) — same as the existing Worktrees-tab path. No new permission surface.
- The merge prompt content comes from the host via `mergePromptReady` — same trusted source as today; no injection vector introduced.

**Side Effects:**
- The create path's existing 5-second debounce-disable (`kanban.html:4242–4243`) is preserved for create mode only; the merge path has its own disable lifecycle (optimistic flag + cleanup-clears).
- The Worktrees-tab `mergePromptReady` path (`button[data-wt-id=...]`) is unchanged; the strip-icon path is additive and guarded by `classList.contains('merge-mode')`.

**Dependencies & Conflicts:**
- Depends on the existing `copyWorktreeMergePrompt` verb being wired in both hosts (extension + standalone) — it already is (Worktrees tab uses it today). No new verb, no schema change, no ratchet/parity/push-routing impact per PRD contracts #4–#6.
- Single-file change (`src/webview/kanban.html`) — no `verbSchemas.ts` edit, no provider-file collision per PRD orchestration discipline.

## Dependencies

- None — all verbs (`copyWorktreeMergePrompt`, `worktreeConfig`) and events (`mergePromptReady`) already exist and are wired in both hosts. This plan is webview-only.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the worktree-existence lookup must match `recomputeWorktreeIndicator`'s presence-based logic — the original plan's `w.status === 'active'` filter referenced a field that does not exist on the worktree payload and would have silently disabled merge mode entirely (corrected below); (2) the `mergePendingWorktreeId` flag must be set optimistically in the click handler to survive `updateBoard`/`worktreeConfig` re-evals between click and `mergePromptReady`; (3) the strip-icon must never carry `data-wt-id` so the two `mergePromptReady` paths don't collide. Mitigations: presence-based lookup, optimistic flag set + error-path clear, and a stated `data-wt-id` invariant.

## Proposed Changes

All changes are in **`src/webview/kanban.html`** (single file — no backend changes needed; the verbs already exist).

### `src/webview/kanban.html` — state variable

**Context:** Near the other worktree state variables (~line 4135, alongside `currentFeatureWorktrees`).

**Logic:** Add a module-scoped flag tracking that a merge prompt was copied from the strip-icon and the button should stay disabled until the worktree is cleaned up.

**Implementation:**
```js
let mergePendingWorktreeId = null; // set when merge prompt copied from strip-icon; cleared on cleanup completion
```

**Edge Cases:** Must be set BEFORE posting `copyWorktreeMergePrompt` (in the click handler, step 3), not in the `mergePromptReady` response, to survive intermediate `updateCreateWorktreeButton()` re-evals.

### `src/webview/kanban.html` — rewrite `updateCreateWorktreeButton()` (line 5851–5885)

**Context:** The function currently has three branches (0 selected, 1 feature selected, other) and is project-blind with no merge mode. The button has two modes: **create** (default styling) and **merge** (yellow/claudify-orange styling).

**Logic — mode resolution priority (matching current selection priority):**
1. If `mergePendingWorktreeId` is set → disabled, tooltip "Merge prompt copied — awaiting worktree cleanup (cancel via Worktrees tab)". (The `worktreeConfig` event clears the flag when the worktree leaves the list.)
2. One feature selected + that feature has a worktree → **merge mode**, tooltip "Merge & clean up worktree for this feature".
3. Nothing selected + `activeProjectFilter` is set (not `__unassigned__`) + a worktree exists for that project → **merge mode**, tooltip "Merge & clean up worktree for \<project\>".
4. Nothing selected + no project worktree → **create mode** (existing behavior).
5. One feature selected + no worktree → **create mode** (existing behavior).
6. One non-feature selected → disabled (existing behavior).
7. 2+ selected → disabled (existing behavior).

> **Superseded:** Worktree lookup for merge mode filtered by `w.status === 'active'` (feature case: `worktrees` filtered by `featureId === pid && status === 'active'`; project case: `worktrees` filtered by `w.project === activeProjectFilter && w.status === 'active'`).
> **Reason:** The `worktreeConfig` worktree objects carry no `status` field — verified at `KanbanProvider.ts:10882–10892` (fields: `id, branch, path, featureId, createdAt, project, agentsOpenWithGrid, featureTopic, featureProject`). `undefined === 'active'` is always `false`, so merge mode would never trigger and the entire feature would be dead on arrival. The existing `recomputeWorktreeIndicator` (lines 5817–5845) — the authoritative "does a worktree exist for this context" check — uses list membership + `w.path`/`w.featureId`/`w.project`, never `w.status`. List membership IS the active signal (cleaned-up worktrees are removed from the list by the host).
> **Replaced with:** Presence-based lookup mirroring `recomputeWorktreeIndicator` exactly:
> - **Feature case:** `currentFeatureWorktrees[pid]` first, then fall back to `((lastWorktreeConfig && lastWorktreeConfig.worktrees) || []).some(w => String(w.featureId) === String(pid))` (same logic as existing line 5866–5867, but instead of disabling, switch to merge mode).
> - **Project case:** `((lastWorktreeConfig && lastWorktreeConfig.worktrees) || []).find(w => w.project && w.project === activeProjectFilter)` (same logic as indicator line 5840).
> - Store the resolved worktree's `id` on the button via `btn.dataset.mergeWorktreeId` so the click handler knows which worktree to merge. Clear `btn.dataset.mergeWorktreeId` in non-merge branches.

**Styling — add/remove CSS class `merge-mode` on the button.** Add these rules near the existing `.worktree-primary-btn` claudify overrides (~line 62–66):

```css
/* Afterburner (default theme): yellow */
#btn-create-worktree.merge-mode {
    background: rgba(255, 204, 0, 0.15);
    border-color: #ffcc00;
}
#btn-create-worktree.merge-mode:hover:not(:disabled) {
    background: rgba(255, 204, 0, 0.25);
}
/* Optional: tint the icon */
#btn-create-worktree.merge-mode img {
    filter: sepia(1) saturate(5) hue-rotate(5deg);
}

/* Claudify theme: Claude-orange tint (matches existing .worktree-primary-btn claudify override) */
body.theme-claudify #btn-create-worktree.merge-mode {
    background: color-mix(in srgb, #D97757 18%, transparent);
    border-color: color-mix(in srgb, #D97757 50%, transparent);
}
body.theme-claudify #btn-create-worktree.merge-mode:hover:not(:disabled) {
    background: color-mix(in srgb, #D97757 30%, transparent);
}
body.theme-claudify #btn-create-worktree.merge-mode img {
    filter: brightness(0) invert(35%) sepia(1) saturate(3) hue-rotate(340deg);
}
```

The claudify `#btn-create-worktree.merge-mode img` rule (id + class + element) outranks the existing `body.theme-claudify .strip-icon-btn img` flat-grey rule (class + element) by specificity, so the icon gets the orange tint only in merge mode. The function must toggle `btn.classList.add('merge-mode')` / `btn.classList.remove('merge-mode')` in each branch.

**Edge Cases:** The lookup MUST match `recomputeWorktreeIndicator` exactly — any divergence produces a button that disagrees with the bottom-bar indicator dot. Clear `data-merge-worktree-id` in every non-merge branch so a stale ID never survives a mode change.

### `src/webview/kanban.html` — click handler (line 4239–4278)

**Context:** The existing click handler always fires a create verb and unconditionally debounces-disable for 5 seconds at the top.

**Logic:** Add a merge-mode check at the top, BEFORE the create-path debounce. In merge mode, set `mergePendingWorktreeId` optimistically, disable the button, and call the existing `copyWorktreeMergePrompt` helper (line 10635) — do not hand-roll the post. The 5-second debounce stays in the create branch only.

**Implementation:**
```js
document.getElementById('btn-create-worktree')?.addEventListener('click', () => {
    const btn = document.getElementById('btn-create-worktree');
    if (!btn || btn.disabled) return;

    // Merge mode: copy the merge-and-cleanup prompt
    const mergeWtId = btn.dataset.mergeWorktreeId;
    if (btn.classList.contains('merge-mode') && mergeWtId) {
        // Set optimistically BEFORE posting so intermediate updateCreateWorktreeButton()
        // re-evals (from updateBoard / worktreeConfig) keep the button disabled.
        mergePendingWorktreeId = Number(mergeWtId);
        btn.disabled = true;
        btn.setAttribute('data-tooltip', 'Copying merge prompt…');
        copyWorktreeMergePrompt(Number(mergeWtId)); // existing helper at line 10635
        return;
    }

    // Create mode: existing behavior (5s debounce preserved here only)
    btn.disabled = true;
    setTimeout(() => { updateCreateWorktreeButton(); }, 5000);
    // ... existing create dispatch branches (unchanged) ...
});
```

> **Superseded:** The click handler posts `copyWorktreeMergePrompt` directly via `postKanbanMessage({ type: 'copyWorktreeMergePrompt', worktreeId, workspaceRoot: currentWorkspaceRoot })`, and sets `mergePendingWorktreeId` in the `mergePromptReady` handler.
> **Reason:** A helper `copyWorktreeMergePrompt(worktreeId)` already exists at line 10635 and posts the same message — forking the dispatch creates a second call site to maintain. Setting the flag in the response opens a race window (see Edge-Case & Dependency Audit) where `updateBoard`/`worktreeConfig` re-enable the button before the response arrives.
> **Replaced with:** Call `copyWorktreeMergePrompt(Number(mergeWtId))` and set `mergePendingWorktreeId` optimistically in the click handler before posting; the `mergePromptReady` error path clears it.

**Edge Cases:** If `mergePromptReady` returns an error (no prompt), the error path (step 4) clears `mergePendingWorktreeId` and calls `updateCreateWorktreeButton()` → re-eval re-enters merge mode (worktree still exists) → enabled for retry.

### `src/webview/kanban.html` — `mergePromptReady` handler (line 7207–7231)

**Context:** The existing handler queries `button[data-wt-id="${msg.worktreeId}"]` — the Worktrees-tab button. The strip-icon is NOT that button.

**Invariant:** The strip-icon (`btn-create-worktree`) must NEVER carry a `data-wt-id` attribute — it carries `data-merge-worktree-id` instead. This guarantees the existing `button[data-wt-id=...]` selector never matches the strip-icon, so the two paths cannot collide. State this invariant in a code comment.

**Logic:** Add a parallel strip-icon path after the existing `data-wt-id` path (which stays unchanged).

**Implementation:**
```js
case 'mergePromptReady': {
    // Existing: Worktrees-tab button (by data-wt-id) — unchanged.
    // INVARIANT: the strip-icon (btn-create-worktree) must never carry data-wt-id
    // (it uses data-merge-worktree-id), so this selector never matches it.
    const btn = document.querySelector(`button[data-wt-id="${msg.worktreeId}"]`);
    if (btn && msg.prompt) {
        // ... existing clipboard + flash logic (unchanged) ...
    }
    // ... existing error flash (unchanged) ...

    // New: strip-icon button path
    const stripBtn = document.getElementById('btn-create-worktree');
    if (stripBtn && stripBtn.classList.contains('merge-mode')) {
        if (msg.prompt) {
            navigator.clipboard.writeText(msg.prompt).then(() => {
                // mergePendingWorktreeId was already set optimistically in the click handler;
                // keep it set — updateCreateWorktreeButton() applies the disabled merge-pending state.
                stripBtn.setAttribute('data-tooltip', 'Merge prompt copied — awaiting worktree cleanup (cancel via Worktrees tab)');
                stripBtn.style.opacity = '0.6';
                setTimeout(() => { stripBtn.style.opacity = ''; }, 1000);
                updateCreateWorktreeButton();
            }).catch(err => {
                console.error('Failed to copy worktree merge prompt (strip-icon):', err);
                mergePendingWorktreeId = null; // clear optimistic flag → re-eval re-enables for retry
                stripBtn.setAttribute('data-tooltip', 'Failed to copy merge prompt — try again');
                updateCreateWorktreeButton();
            });
        } else {
            // Backend returned an error (e.g. worktree not found)
            mergePendingWorktreeId = null;
            stripBtn.setAttribute('data-tooltip', 'Failed to generate merge prompt — try the Worktrees tab');
            updateCreateWorktreeButton();
        }
    }
    break;
}
```

**Edge Cases:** The `classList.contains('merge-mode')` guard ensures this path only runs when the strip-icon is in merge mode — it cannot accidentally handle a Worktrees-tab response. The optimistic flag is cleared on every error branch so the button re-enables for retry.

### `src/webview/kanban.html` — `worktreeConfig` handler (line 7183–7189)

**Context:** The handler already calls `updateCreateWorktreeButton()`. Add a check to clear `mergePendingWorktreeId` when the worktree is cleaned up.

**Logic:** If `mergePendingWorktreeId` is set and that worktree is no longer in the fresh config's list, clear the flag. List membership is the active signal (no `status` field).

**Implementation:**
```js
case 'worktreeConfig': {
    lastWorktreeConfig = msg;
    // Clear merge-pending state if the worktree was cleaned up (no status field —
    // list membership is the active signal; cleaned-up worktrees leave the list).
    if (mergePendingWorktreeId !== null) {
        const stillExists = (msg.worktrees || []).some(w => w.id === mergePendingWorktreeId);
        if (!stillExists) {
            mergePendingWorktreeId = null;
        }
    }
    renderWorktreesTab();
    recomputeWorktreeIndicator();
    updateCreateWorktreeButton();
    updateManagerPassButton();
    break;
}
```

> **Superseded:** Clear `mergePendingWorktreeId` when `w.id === mergePendingWorktreeId && w.status === 'active'` is no longer true.
> **Reason:** Worktree objects have no `status` field (see Superseded callout in the `updateCreateWorktreeButton` section). Checking `w.status === 'active'` would mean `stillExists` is always `false` (the `&&` short-circuits on `undefined !== 'active'`), clearing the flag immediately on every `worktreeConfig` — the button would re-enable mid-merge-pending.
> **Replaced with:** `stillExists = (msg.worktrees || []).some(w => w.id === mergePendingWorktreeId)` — pure list-membership check, consistent with the rest of the plan.

**Edge Cases:** This re-enables the button (back to create mode) once the API reports the worktree is gone — whether cleanup happened via the agent running `worktree-cleanup`, or the user manually clicking **Clean up** / **Abandon** in the Worktrees tab.

### `src/webview/kanban.html` — edge case: cancel merge-pending state

If the user copies the merge prompt but decides not to merge, the button stays disabled until the worktree is cleaned up. They can cancel by:
- Going to the Worktrees tab and clicking **Abandon** or **Clean up** (which updates `worktreeConfig` and clears the flag via the handler above).

This is sufficient — no dedicated cancel button on the strip-icon is needed. The Worktrees tab is the manual escape hatch. The tooltip documents this: "Merge prompt copied — awaiting worktree cleanup (cancel via Worktrees tab)".

## Verification Plan

> Per session directives: **skip compilation** and **skip automated tests.** Verification is manual click-through in the running webview (both themes). No `npm run verb-returns:check` / `parity:check` / `push-routing:check` impact — no verb/schema/dispatch changes.

### Automated Tests
- None required — single-file webview change, no backend/verb/schema impact. The PRD ratchets (`verb-returns:check`, `parity:check`, `push-routing:check`) are unaffected because no provider arm, schema, or `postMessage` call site is added or changed (the `copyWorktreeMergePrompt` verb and its wiring already exist).

### Manual Verification
1. **Project worktree exists, nothing selected:**
   - Set a project filter. Create a worktree for it (via Worktrees tab or the button's create mode).
   - Verify the strip-icon button turns yellow (afterburner) / orange-tint (claudify), tooltip reads "Merge & clean up worktree for \<project\>".
   - Click it → merge prompt appears in clipboard. Button disables, tooltip reads "Merge prompt copied — awaiting worktree cleanup (cancel via Worktrees tab)".
   - Run `worktree-cleanup` (or click Clean Up in Worktrees tab) → button re-enables in create mode.

2. **Feature worktree exists, feature selected:**
   - Select a feature that has an active worktree.
   - Verify button is in merge mode (not disabled as before), tooltip "Merge & clean up worktree for this feature".
   - Click → prompt copied → disabled → cleanup → re-enabled.

3. **No worktree exists:**
   - Nothing selected, no project worktree → button in create mode (default styling), tooltip "Create a worktree for the active project / workspace".
   - Feature selected, no worktree → create mode, tooltip "Create a worktree for this feature".

4. **Non-feature or multi-select:** button disabled with existing tooltips (unchanged).

5. **Theme check:** verify yellow styling in afterburner, orange-tint in claudify. Toggle theme and re-check. Confirm the claudify merge-mode icon tint overrides the default flat-grey `.strip-icon-btn img` rule.

6. **Worktrees tab still works:** the existing Merge prompt / Clean up / Abandon buttons in the Worktrees tab are unaffected — they use the same verbs and the same `mergePromptReady` handler (the `data-wt-id` path is preserved).

7. **Race check:** click merge, then immediately trigger a board refresh (e.g. move a card) before `mergePromptReady` returns. Confirm the button stays disabled (optimistic `mergePendingWorktreeId` set) — does not flicker back to enabled.

8. **Error retry:** force a `mergePromptReady` error (e.g. delete the worktree from another tab between click and response). Confirm the button re-enables in merge mode for retry.

9. **Indicator agreement:** in every merge-mode state, confirm the bottom-bar worktree indicator (from `recomputeWorktreeIndicator`) shows the same worktree path the button would merge — the two must agree.

---

**Recommendation:** Complexity 4 → **Send to Coder**.
