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

## Metadata

**Complexity:** 4
**Tags:** ui, ux, refactor, feature
**Project:** Browser Switchboard

## Implementation Plan

All changes are in `src/webview/kanban.html` (single file — no backend changes needed; the verbs already exist).

### 1. Add merge-pending state variable

Near the other worktree state variables (~line 4135, alongside `currentFeatureWorktrees`):

```js
let mergePendingWorktreeId = null; // set when merge prompt copied from strip-icon; cleared on cleanup completion
```

This tracks that a merge prompt was copied and the button should stay disabled until the worktree is cleaned up.

### 2. Rewrite `updateCreateWorktreeButton()` to add merge mode

The function currently has three branches (0 selected, 1 feature selected, other). Add a merge-mode check at the top of each relevant branch. The button has two modes: **create** (default styling) and **merge** (yellow/claudify-orange styling).

**Mode resolution priority (matching current selection priority):**
1. If `mergePendingWorktreeId` is set → disabled, tooltip "Merge prompt copied — awaiting worktree cleanup". (The `worktreeConfig` event will clear this when the worktree disappears.)
2. One feature selected + that feature has an active worktree → **merge mode**, tooltip "Merge & clean up worktree for this feature".
3. Nothing selected + `activeProjectFilter` is set (not `__unassigned__`) + an active worktree exists for that project → **merge mode**, tooltip "Merge & clean up worktree for \<project\>".
4. Nothing selected + no project worktree → **create mode** (existing behavior).
5. One feature selected + no worktree → **create mode** (existing behavior).
6. One non-feature selected → disabled (existing behavior).
7. 2+ selected → disabled (existing behavior).

**Worktree lookup for merge mode:**
- Feature case: check `currentFeatureWorktrees[pid]` first, then fall back to `lastWorktreeConfig.worktrees` filtered by `featureId === pid` and `status === 'active'` (same logic as existing line 5866–5867, but instead of disabling, switch to merge mode).
- Project case: search `lastWorktreeConfig.worktrees` for `w.project === activeProjectFilter && w.status === 'active'`.
- Store the resolved worktree ID on the button via `btn.dataset.mergeWorktreeId` so the click handler knows which worktree to merge.

**Styling — add/remove a CSS class `merge-mode` on the button:**

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

Add these rules near the existing `.worktree-primary-btn` claudify overrides (~line 62–66).

The function must toggle `btn.classList.add('merge-mode')` / `btn.classList.remove('merge-mode')` in each branch.

### 3. Update the click handler to branch on mode

The existing click handler (`kanban.html:4239–4276`) always fires a create verb. Add a mode check at the top:

```js
document.getElementById('btn-create-worktree')?.addEventListener('click', () => {
    const btn = document.getElementById('btn-create-worktree');
    if (!btn || btn.disabled) return;

    // Merge mode: copy the merge-and-cleanup prompt
    const mergeWtId = btn.dataset.mergeWorktreeId;
    if (btn.classList.contains('merge-mode') && mergeWtId) {
        btn.disabled = true;
        btn.setAttribute('data-tooltip', 'Copying merge prompt…');
        postKanbanMessage({
            type: 'copyWorktreeMergePrompt',
            worktreeId: Number(mergeWtId),
            workspaceRoot: currentWorkspaceRoot
        });
        // mergePendingWorktreeId is set in the mergePromptReady handler below
        return;
    }

    // Create mode: existing behavior (unchanged)
    btn.disabled = true;
    setTimeout(() => { updateCreateWorktreeButton(); }, 5000);
    // ... existing create dispatch branches ...
});
```

Remove the unconditional 5-second debounce disable for the create path too — it should only apply in create mode (the merge path has its own disable lifecycle).

### 4. Handle `mergePromptReady` for the strip-icon button

The existing `mergePromptReady` handler (`kanban.html:7207–7231`) queries `button[data-wt-id="${msg.worktreeId}"]` — that's the Worktrees-tab button, which the strip-icon is not. Add a parallel path for the strip-icon:

```js
case 'mergePromptReady': {
    // Existing: Worktrees-tab button (by data-wt-id)
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
                mergePendingWorktreeId = msg.worktreeId;
                stripBtn.setAttribute('data-tooltip', 'Merge prompt copied — awaiting worktree cleanup');
                // Brief visual confirmation
                stripBtn.style.opacity = '0.6';
                setTimeout(() => { stripBtn.style.opacity = ''; }, 1000);
                updateCreateWorktreeButton(); // applies the disabled merge-pending state
            }).catch(err => {
                console.error('Failed to copy worktree merge prompt (strip-icon):', err);
                stripBtn.setAttribute('data-tooltip', 'Failed to copy merge prompt — try again');
                updateCreateWorktreeButton(); // re-enables for retry
            });
        } else {
            // Backend returned an error (e.g. worktree not found)
            stripBtn.setAttribute('data-tooltip', 'Failed to generate merge prompt — try the Worktrees tab');
            updateCreateWorktreeButton();
        }
    }
    break;
}
```

### 5. Clear `mergePendingWorktreeId` on cleanup completion

The `worktreeConfig` event handler (`kanban.html:7183–7189`) already calls `updateCreateWorktreeButton()`. Add a check: if `mergePendingWorktreeId` is set and that worktree is no longer in the fresh config (or its status is no longer `active`), clear the flag:

```js
case 'worktreeConfig': {
    lastWorktreeConfig = msg;
    // Clear merge-pending state if the worktree was cleaned up
    if (mergePendingWorktreeId !== null) {
        const stillExists = (msg.worktrees || []).some(
            w => w.id === mergePendingWorktreeId && w.status === 'active'
        );
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

This re-enables the button (back to create mode) once the API reports the worktree is gone — whether cleanup happened via the agent running `worktree-cleanup`, or the user manually clicking **Clean up** / **Abandon** in the Worktrees tab.

### 6. Edge case: user wants to cancel merge-pending state

If the user copies the merge prompt but decides not to merge, the button stays disabled until the worktree is cleaned up. They can cancel by:
- Going to the Worktrees tab and clicking **Abandon** or **Clean up** (which updates `worktreeConfig` and clears the flag).
- This is sufficient — no dedicated cancel button on the strip-icon is needed. The Worktrees tab is the manual escape hatch.

Document this in the tooltip: "Merge prompt copied — awaiting worktree cleanup (cancel via Worktrees tab)".

## Verification Plan

1. **Project worktree exists, nothing selected:**
   - Set a project filter. Create a worktree for it (via Worktrees tab or the button's create mode).
   - Verify the strip-icon button turns yellow (afterburner) / orange-tint (claudify), tooltip reads "Merge & clean up worktree for \<project\>".
   - Click it → merge prompt appears in clipboard. Button disables, tooltip reads "Merge prompt copied — awaiting worktree cleanup".
   - Run `worktree-cleanup` (or click Clean Up in Worktrees tab) → button re-enables in create mode.

2. **Feature worktree exists, feature selected:**
   - Select a feature that has an active worktree.
   - Verify button is in merge mode (not disabled as before), tooltip "Merge & clean up worktree for this feature".
   - Click → prompt copied → disabled → cleanup → re-enabled.

3. **No worktree exists:**
   - Nothing selected, no project worktree → button in create mode (default styling), tooltip "Create a worktree for the active project / workspace".
   - Feature selected, no worktree → create mode, tooltip "Create a worktree for this feature".

4. **Non-feature or multi-select:** button disabled with existing tooltips (unchanged).

5. **Theme check:** verify yellow styling in afterburner, orange-tint in claudify. Toggle theme and re-check.

6. **Worktrees tab still works:** the existing Merge prompt / Clean up / Abandon buttons in the Worktrees tab are unaffected — they use the same verbs and the same `mergePromptReady` handler (the `data-wt-id` path is preserved).
