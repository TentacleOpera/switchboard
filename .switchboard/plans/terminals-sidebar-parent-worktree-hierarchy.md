# Terminals Sidebar: Parent → Worktree Two-Level Hierarchy

## Goal

Rebuild the Terminals sidebar as a two-level accordion: **every configured parent workspace is always shown, by its configured name**, with worktree accordions nested underneath it. Replace the `Workspace Root 3 (3a/0x)` bucket with `Autism360App` and `Switchboard` headers that mean something.

Target shape:

```
▼ Autism360App                    5 (5a/0x)
      planner-1        planner
      coder-1          coder
    ▼ feat-billing                2 (2a/0x)
          coder-3      coder
          reviewer-1   reviewer
▼ Switchboard                     0 (0a/0x)
      (no terminals — + to open)
```

### Problem & Background

`renderSidebarList()` (`src/webview/terminals.js:692`) builds exactly one level of grouping, keyed on `item.worktreePath || 'Workspace Root'` (`:713`, hardcoded fallback label at `:718`). Consequences:

- Every non-worktree terminal collapses into one bucket labelled with a hardcoded string that names no real place.
- Parents with no terminals are invisible, so a second configured workspace does not exist as far as the sidebar is concerned — nothing to click, no indication it could hold terminals.
- Worktrees and the main repo render as *siblings*, when a worktree is conceptually a child of a parent workspace.

### Root Cause

The grouping key is a path string with a hardcoded fallback label, and the render is a single `for` loop over one `groupsMap` (`:730`). There is no notion of a parent, so there is no level to nest under — and until the reporting plan lands there is no source on the wire for the parent list either.

## Implementation

### 1. Build a two-level model

Replace the single `groupsMap` (`:711`) with:

```
parents: [{ id, name, parentFolder, direct: [terminal…], worktrees: Map<path, [terminal…]> }]
```

Seeded from the `parents[]` array in the `ptyListTerminals` response — **iterate the configured parents first, then distribute terminals into them**, so a parent with zero terminals still renders. Distribute each terminal by its `parentRoot`; within a parent, by `worktreePath` (absent → `direct`).

Terminals whose `parentRoot` is `null` go into a trailing **Unmapped** group, rendered only when non-empty. Never drop a terminal because it failed attribution — an invisible running shell is worse than an oddly-filed one.

**Guard against a worktree path that is really a parent.** If a terminal's `worktreePath` equals its `parentRoot` or any configured `parentFolder`, treat it as `direct` rather than opening a worktree sub-accordion for it. The spawn plan removes the source of this (the `cwd !== workspaceRoot` back-stamp at `ptyFleetService.ts:95`), but terminals created before that fix are still live in the fleet and an external caller can still pass both fields.

**Do not assume `parents[]` is non-empty.** The reporting plan guarantees at least one synthetic entry, but guard anyway: fall back to a single group holding every terminal rather than rendering nothing.

### 2. Render

- **Parent header:** the mapping `name` (`Autism360App`), full `parentFolder` in the `title`. Count aggregates the parent's direct terminals *and* all its worktrees' terminals, keeping the existing `N (Xa/Yx)` format (`:734-735`, `:754-756`).
- **Worktree sub-header:** indented under its parent, basename as today, own `N (Xa/Yx)` count.
- **Empty parent:** header plus a muted "no terminals" row, so the `+` is discoverable.
- Both levels collapse independently. Replace the `collapsedWorktrees` Set (`:13`) with a single `collapsedGroups` Set of prefixed keys (`parent:<id>`, `worktree:<path>`), persisted under one renamed setting. A rename, not a migration — a lost collapse state is one click to restore.
- Terminal rows are unchanged: `locate` / `clear` / `rename` / `close` and the stacked layout stay exactly as they are. Extract the existing row-rendering block into a helper and call it unchanged from both levels rather than reimplementing it.

### 3. Spawn targeting

- **Parent header `+`** → `ptyCreateTerminal { role, parentRoot }`. **Pass `parentRoot` only — never also set `cwd`.** `createTerminal(role, worktreePath)` (`:1341`) currently sets both to the same value; the parent path needs its own branch. The extension proxy translates `parentRoot` into a `cwd` before forwarding (spawn plan, step 2).
- **Worktree header `+`** → unchanged (`cwd` + `worktreePath`).
- **`OPEN AGENT TERMINALS`** (`terminals.html:797`, handler at `:1459`) → **no client change needed**. It posts `{ role }` with no target, and the extension proxy now fills in the board's active parent (spawn plan, step 1). It starts doing the right thing for free.

### Out of scope

- **The settings-scope work from the earlier draft is cut entirely.**

  > **Superseded:** move `terminals.layoutMode`, `terminals.paneAssignments`, `terminals.collapsedWorktrees` and `terminals.osNotify` to global scope with a fallback migration, because they are workspace-scoped while the fleet is global and the grid silently blanks on reload after a parent switch.
  > **Reason:** the described defect does not occur. `_getScopedSetting` (`KanbanProvider.ts:635-668`) reads `globalState` **before** the workspace tier, and the workspace and project tiers are gated on `_workspaceOverrideEnabled` / `_projectOverrideEnabled`, both of which default to `false` and are `false` in this workspace. These keys already resolve globally. The residual issue — an operator who turns on Workspace Override getting per-workspace fleet layout — is real but rare, unrelated to parent workspaces, and not worth carrying inside this feature.
  > **Replaced with:** nothing. If it ever bites, it is a four-key exemption in `_getScopedSetting` and its own small ticket.

- **The fleet-root disagreement banner is cut.** It existed because the fleet's boot root could silently differ from the active parent. The spawn plan resolves the target per request, so the boot root is now only a last-resort fallback and there is nothing to warn about.
- The pane grid stays parent-blind — pane headers show the terminal name only. Worth revisiting separately; four panes from four repos are indistinguishable.
- No change to `${role}-${n}` naming.
- The standalone CLI host does not persist panel settings at all (`bootstrap.ts:701-717` serves them from an in-memory Map and writes nothing but `selectedRole`). Not fixed here; noted so QA does not chase it.

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, refactor

**Depends on:** PTY Fleet: Report Each Terminal's Parent Workspace (needs `parentRoot` and `parents[]`); PTY Fleet: Spawn Into the Active Parent Workspace (needs the proxy's `parentRoot` → `cwd` translation for the per-parent `+`).

## User Review Required

No. The sidebar gains a nesting level and real parent names; no setting changes scope, no persisted data is discarded beyond one collapse-state key rename.

## Complexity Audit

### Routine

- Rendering a second grouping level from data the response already carries.
- One setting key rename.
- One new payload field on an existing `+` handler.

### Complex / Risky

- **A rewrite of `renderSidebarList()`**, the busiest function in the panel — it also owns collapse state, per-item actions, pane-assignment highlighting and the solo-mode empty-state guard. The regression surface is the whole sidebar.
- **The solo-mode branch is load-bearing and easy to lose.** The empty-fleet path at `:694-708` deliberately does *not* hide the grid when `soloTerminalName` is set; `checkSoloNotFound` owns visibility there. Preserve it verbatim.
- Nesting in a narrow sidebar — the indent must not push the `N (Xa/Yx)` count out of view.

## Edge-Case & Dependency Audit

**Race Conditions**
- `loadLayoutSettings()` runs once in `init()` (`:433`) while `saveLayoutSettings()` fires on every mutation (`:532-534`). Two open tabs are last-write-wins. Pre-existing, out of scope, do not add a poll.
- A `terminalsChanged` broadcast arriving mid-render — unchanged from today.

**Security**
- No new input surface. The parent `+` sends a `parentRoot` the client received from the host.
- Parent headers show a full filesystem path in `title`, as worktree headers already do.

**Side Effects**
- `terminals.collapsedWorktrees` becomes orphaned in `globalState` and the DB mirror. Harmless; no cleanup migration.
- The `Unmapped` group is new UI most operators will never see.

**Dependencies & Conflicts**
- Touches `src/webview/terminals.js` (heavily) and `src/webview/terminals.html` (nesting CSS).
- `terminals.js`, `terminals.html`, `KanbanProvider.ts` and `shell-terminal-strip.test.js` all had **uncommitted modifications in the working tree** at planning time. Rebase first and re-read `renderSidebarList()` rather than trusting the line numbers here.
- Does not touch any backend file, so it does not conflict with the two sibling plans beyond ordering.

## Dependencies

- **PTY Fleet: Report Each Terminal's Parent Workspace** — must land first; supplies `parentRoot` and `parents[]`.
- **PTY Fleet: Spawn Into the Active Parent Workspace** — needed for verification step 5 only. Everything else here is independently verifiable.

## Adversarial Synthesis

Key risks: rewriting the panel's busiest function and silently losing an existing behaviour — collapse persistence, pane highlighting, or the solo-mode empty-state guard — and rendering a phantom worktree accordion for a terminal whose `worktreePath` is really a parent directory. Mitigations: extract the terminal-row block and reuse it unchanged rather than reimplementing it, keep the solo branch verbatim, and guard the worktree grouping against paths that match a configured parent. Scope was cut hard: the settings work was removed as a non-defect and the fleet-root banner as obsolete, leaving only the grouping rebuild.

## Proposed Changes

### `src/webview/terminals.js`

- **Context:** `collapsedWorktrees` at `:13`; `loadLayoutSettings` at `:509`; `saveLayoutSettings` at `:531`; `renderSidebarList` at `:692`; grouping loop `:711-729`; header render `:730-782`; `createTerminal` at `:1341`.
- **Logic:** Two-level grouping seeded from `parents[]`; one prefixed collapse set; a parent-targeted spawn path.
- **Implementation:** replace `groupsMap` with the parent model from step 1; extract the row block into a helper called from both levels; rename `collapsedWorktrees` → `collapsedGroups` with `parent:` / `worktree:` prefixes and update load/save; add `createTerminalInParent(role, parentRoot)` posting `{ role, parentRoot }` with no `cwd`.
- **Edge Cases:** `parents[]` empty (degraded single group); `parentRoot: null` (Unmapped, hidden when empty); `worktreePath` equal to a parent folder (treat as direct); solo mode (`saveSetting` already short-circuits at `:499`; keep the `:694-708` guard verbatim).

### `src/webview/terminals.html`

- **Context:** sidebar classes `worktree-group`, `worktree-group-header`, `worktree-title-area`, `worktree-name`, `worktree-count`, `btn-group-new`.
- **Logic:** One nesting level.
- **Implementation:** add `parent-group` / `parent-group-header` classes, or an indent modifier on the existing worktree classes.
- **Edge Cases:** narrow sidebar — the count must stay visible at the indented level.

## Verification Plan

### Automated Tests

1. **Both parents always visible:** with terminals in Autism360App only, the sidebar still renders a `Switchboard` header with `0 (0a/0x)` and a working `+`.
2. **Nesting:** a worktree terminal renders under a worktree sub-header, itself under the owning parent — not as a sibling.
3. **Counts:** the parent count includes its worktrees' terminals; each worktree count covers only its own.
4. **Independent collapse:** collapsing a parent hides its worktrees; collapsing one worktree leaves the parent's direct terminals visible. Both survive a reload.
5. **Per-parent spawn:** `+` on the Switchboard header, with the host booted on Gitlab, produces a terminal that appears under Switchboard — and the payload carried `parentRoot` with no `cwd`.
6. **Open-all needs no client change:** `OPEN AGENT TERMINALS` with the board on Switchboard opens terminals that appear under Switchboard.
7. **Unmapped:** a terminal with `parentRoot: null` appears under Unmapped; with none, no Unmapped group renders.
8. **No phantom worktree:** a terminal whose `worktreePath` equals its `parentRoot` renders as a direct child of the parent.
9. **Empty `parents[]` degradation:** with `parents: []`, one group renders holding every terminal — never blank.
10. **Solo mode:** popping out a terminal and closing the fleet does not blank the pinned pane (existing `terminal-solo-popout-contract` behaviour).
11. **Regression:** the existing terminal contract suites still pass, including the focus contracts added with the locate/caret work.

## Recommendation

Complexity 5 → **Send to Coder**.

## Completion Report

Rebuilt the Terminals sidebar into a two-level accordion displaying configured parent workspace headers and nested worktree groups. Extracted terminal row rendering, implemented independent group collapse state saved as `terminals.collapsedGroups`, and wired per-parent `+` button to post `parentRoot`.
Files changed: `src/webview/terminals.js`, `src/webview/terminals.html`.
No issues encountered during implementation.

