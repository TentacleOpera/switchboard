# Kanban bottom-bar worktree indicator must reflect the active worktree (project/epic aware)

## Goal

The worktree indicator on the Switchboard kanban bottom bar (the `⎇ <branch>` label on the
far right of `#kanban-sub-bar`, next to the CHAT PROMPT button) currently shows a worktree
label even when the active project filter / selected epic has nothing to do with that
worktree. For example, a worktree `remote-sync-2` provisioned for the project "Remote sync"
stays visible in the indicator after the user switches to a different project or to the base
workspace. The label should show **whatever worktree will actually be referenced in the
prompts** — the "active worktree" — and hide when no epic-with-worktree is selected and the
active project has no project-scoped worktree.

### Problem analysis & root cause

The indicator is driven by a single webview function, `updateWorktreeIndicator(worktreePath)`
(`<ref_file file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html" />`,
~line 5184), which is called from exactly one place: the `worktreeConfig` message handler
(~line 6389):

```js
case 'worktreeConfig': {
    lastWorktreeConfig = msg;
    renderWorktreesTab();
    const activeWorktrees = msg.worktrees || [];
    if (activeWorktrees.length === 1) {
        updateWorktreeIndicator(activeWorktrees[0].path);   // <-- BUG
    } else {
        updateWorktreeIndicator(null);
    }
    break;
}
```

The bug: the handler picks `activeWorktrees[0].path` whenever there is **exactly one** active
worktree in the whole workspace, with zero awareness of:

- the active project filter (`activeProjectFilter`, ~line 3851),
- the currently selected epic card (`selectedCards` entries with `isEpic: true`, ~line 5340),
- the epic→worktree map already shipped to the webview (`currentEpicWorktrees`, updated on
  every `updateBoard` at ~line 6326), or
- the per-worktree `project` / `epicId` / `epicProject` fields that `_sendWorktreeConfig`
  already populates on the backend (`KanbanProvider._sendWorktreeConfig`,
  `<ref_file file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts" />`
  ~line 9165).

So a lone epic worktree (e.g. `remote-sync-2` for epic/project "Remote sync") is shown
globally no matter what project is filtered or whether its epic is selected.

### Desired routing (matches prompt behaviour)

The codebase documents the worktree routing order as
"epic worktree → project worktree → main repo" (kanban.html ~line 9416). The indicator must
follow the same precedence, scoped to the current UI context:

1. **Selected epic with a worktree** → show that epic's worktree.
2. **Active project filter with a project-scoped worktree** → show that project worktree.
   (Epic worktrees whose `epicProject` happens to match the active project do **not** count
   unless that epic is selected — per the user: "if no epic with a worktree is selected, it
   should not show an epic's worktree.")
3. Otherwise → hide the indicator.

Note: the prompt-building path (`KanbanProvider._cardsToPromptPlans`, ~line 2836) has a
separate "sole active worktree" fallback that applies a single global worktree to every
dispatched card. That is prompt-dispatch behaviour for selected cards and is out of scope for
this indicator fix; the indicator is a persistent status display and must be context-aware,
not a mirror of the sole-worktree fallback. The user explicitly wants the indicator to hide
an epic's worktree when no epic is selected.

## Metadata

**Tags:** kanban, webview, worktree, indicator, ux, bug
**Complexity:** 4
**Project:** switchboard

## Complexity Audit

**Routine:**
- Adding a `recomputeWorktreeIndicator()` function in `kanban.html` that reads already-available
  webview state (`lastWorktreeConfig.worktrees`, `currentEpicWorktrees`, `activeProjectFilter`,
  `selectedCards`) — pure frontend, no backend change, no DB change, no migration.
- Calling it from the handful of existing handlers that mutate any of those four state pieces.

**Complex / Risky:**
- None. No persisted state, no shipped-version migration concerns (this is unreleased UI
  behaviour), no backend protocol change. The `worktreeConfig` payload already carries
  `project`, `epicId`, `epicProject` per worktree, so no new message field is required.

## Edge-Case & Dependency Audit

- **`activeProjectFilter` values:** may be `null` (no filter), `'__unassigned__'` (explicit
  "Unassigned" pseudo-project), or a real project name. Only a real project name (not null,
  not `'__unassigned__'`) can match a project-scoped worktree's `project` field.
- **Multiple selected epics:** if more than one epic is selected and they map to *different*
  worktrees, the indicator cannot show a single definitive "active worktree" → hide it
  (ambiguous). If all selected epics share the same worktree, show it.
- **Selected non-epic cards:** a selected regular plan/subtask must NOT surface an epic
  worktree by itself; only a selected *epic* card unlocks the epic-worktree branch. (A
  subtask's parent epic is not "selected" just because the subtask is.)
- **Epic card identity:** an epic card has `isEpic: true`; its own `planId` is the epic id
  (its `epicId` field is empty — that field denotes a subtask's parent). So the epic→worktree
  lookup for a selected epic uses the selected card's `planId`, not `epicId`.
- **`currentEpicWorktrees` vs `lastWorktreeConfig.worktrees`:** both are kept in sync on board
  refresh, but `currentEpicWorktrees` is the authoritative epic→path map (keyed by epic id).
  Prefer it for epic lookups; fall back to `lastWorktreeConfig.worktrees` filtered by
  `epicId` for completeness.
- **Project worktree lookup:** use `lastWorktreeConfig.worktrees.filter(w => w.project &&
  w.project === activeProjectFilter)`. Take the first (there should be at most one
  project-scoped worktree per project; if more, they share the project — pick the first).
- **Recompute triggers:** the indicator must refresh on every state change that affects the
  result: `worktreeConfig` (worktree list), `updateBoard` (`currentEpicWorktrees`),
  `updateWorkspaceSelection` (`activeProjectFilter`), and any `selectedCards` mutation
  (card click toggle, clear-after-dispatch, reassign, epic action).
- **Initial load:** `updateWorktreeIndicator` is currently invoked from `worktreeConfig`.
  The new recompute must also run on first hydration so a reload shows the correct label.
- **No confirm dialogs:** per project rules, none are added.

## Proposed Changes

### File: `src/webview/kanban.html`

#### 1. Replace the bare `updateWorktreeIndicator` call site with a context-aware recompute

At the `worktreeConfig` handler (~line 6389), stop picking `activeWorktrees[0]` and instead
call a new recompute function:

```js
case 'worktreeConfig': {
    lastWorktreeConfig = msg;
    renderWorktreesTab();
    recomputeWorktreeIndicator();   // replaces the activeWorktrees.length===1 branch
    break;
}
```

#### 2. Add `recomputeWorktreeIndicator()` (place it next to `updateWorktreeIndicator`, ~line 5184)

```js
// Resolves the "active worktree" — the one prompts would reference given the current UI
// context — and updates the bottom-bar indicator. Routing: selected epic worktree → active
// project worktree → none. Does NOT use the prompt path's "sole active worktree" fallback,
// because the indicator is a persistent status display and must stay project/epic-scoped
// (an epic's worktree must not show when that epic isn't selected).
function recomputeWorktreeIndicator() {
    const worktrees = (lastWorktreeConfig && lastWorktreeConfig.worktrees) || [];

    // 1. Selected epic(s) with a worktree.
    const selectedEpics = Array.from(selectedCards.entries())
        .filter(([, v]) => v && v.isEpic)
        .map(([id]) => id);
    if (selectedEpics.length > 0) {
        const paths = new Set();
        for (const epicPlanId of selectedEpics) {
            const fromMap = currentEpicWorktrees[epicPlanId];
            if (fromMap && fromMap.path) { paths.add(fromMap.path); continue; }
            const fromList = worktrees.find(w => String(w.epicId) === String(epicPlanId));
            if (fromList && fromList.path) paths.add(fromList.path);
        }
        if (paths.size === 1) {
            updateWorktreeIndicator(paths.values().next().value);
            return;
        }
        // 0 matches, or ambiguous (multiple distinct worktrees) → fall through to hide.
    }

    // 2. Active project filter with a project-scoped worktree.
    if (activeProjectFilter && activeProjectFilter !== '__unassigned__') {
        const projWt = worktrees.find(w => w.project && w.project === activeProjectFilter);
        if (projWt && projWt.path) {
            updateWorktreeIndicator(projWt.path);
            return;
        }
    }

    // 3. Nothing applicable — hide.
    updateWorktreeIndicator(null);
}
```

`updateWorktreeIndicator` itself is unchanged (it already hides when given `null` and shows
the last path segment otherwise).

#### 3. Call `recomputeWorktreeIndicator()` from every state-mutation site

Add a `recomputeWorktreeIndicator();` call immediately after each of these existing lines
(keep the surrounding logic intact):

- **`updateBoard` handler** — after `currentEpicWorktrees = nextEpicWorktrees;` (~line 6328),
  so an epic-worktree provisioning change refreshes the label even when the board signature
  is unchanged.
- **`updateWorkspaceSelection` handler** — after
  `activeProjectFilter = msg.projectFilter ?? null;` (~line 6238), so a project/workspace
  switch re-evaluates the label.
- **Card click toggle** — at the end of the click handler (~line 5352, alongside
  `updateReassignButtonVisibility(); updateEpicActionButton();`), so selecting/deselecting an
  epic updates the label live.
- **Every `selectedCards.clear()` site that affects board selection** — the clear-after-
  dispatch / reassign / epic-action clears (lines 5800, 5818, 6093, 7036, 7091, 7609, 9950,
  9984). Add `recomputeWorktreeIndicator();` next to the existing
  `updateReassignButtonVisibility(); updateEpicActionButton();` calls where present; for
  clears that don't already call those, add the recompute call right after the clear. (The
  `renderBoard` prune-clear at ~line 5228 is inside `renderBoard` and is followed by a full
  re-render — no extra call needed there; `recomputeWorktreeIndicator` will run from the
  `updateBoard` handler's `currentEpicWorktrees` update.)

To avoid duplicating the recompute in ~10 spots, the cleanest pattern is to add the call to
the existing `updateEpicActionButton()` helper's call sites (it already runs at most of these
points) OR — simpler and self-contained — just add the one-liner at each site listed above.
Prefer the explicit one-liner so the dependency is obvious and grep-able.

#### 4. (Optional hardening) Guard against stale `lastWorktreeConfig`

`recomputeWorktreeIndicator` reads `lastWorktreeConfig`. On a cold reload the
`worktreeConfig` message arrives alongside `updateBoard`; ordering is not guaranteed. The
`currentEpicWorktrees` branch handles epic lookups even when `lastWorktreeConfig` is still
empty, and the project branch no-ops when `lastWorktreeConfig.worktrees` is `[]`, so the only
visible effect of a stale config is a briefly-hidden project indicator that corrects itself
when `worktreeConfig` lands (which calls recompute). No extra guard required.

## Verification Plan

1. **Build:** `npm run compile` (webpack) — confirm no JS errors in `dist/`. (Per project
   rules, `dist/` is not used during dev testing; this is just a syntax/bundle check.)
2. **Manual repro (installed VSIX):**
   - Provision a worktree for one project (e.g. "Remote sync" → `remote-sync-2`).
   - With that project selected as the active filter → indicator shows `remote-sync-2`.
   - Switch the project dropdown to a different project (or "Unassigned") → indicator
     **hides** (previously it stayed visible). This is the core regression fix.
   - Select the epic card that owns `remote-sync-2` (click the epic card body) → indicator
     shows `remote-sync-2` regardless of the project filter.
   - Deselect the epic → indicator reverts to project-filter behaviour (shows project
     worktree if the active project has one, else hides).
   - Select two epics with *different* worktrees → indicator hides (ambiguous).
   - Select two epics sharing the *same* worktree → indicator shows that branch.
3. **Reload resilience:** reload the webview with a project worktree active → indicator
   appears correctly on first hydration (driven by the `worktreeConfig` recompute call).
4. **No-regression for the WORKTREES tab:** `renderWorktreesTab()` is still called in the
   `worktreeConfig` handler; the active-worktrees list there is unchanged.
5. **No confirm dialogs introduced** (project rule).
