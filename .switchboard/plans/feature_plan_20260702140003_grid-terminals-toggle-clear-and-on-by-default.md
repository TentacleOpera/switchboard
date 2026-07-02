# Worktree "Open Terminals With Grid" Toggle — Make It Clear, Prominent, And On By Default

## Goal

The per-worktree **"Open terminals with grid"** checkbox in the kanban.html WORKTREES tab is (a) unclear about what it does, (b) visually buried at 9px in the details line, and (c) off by default. Fix all three: rename/relabel it so its purpose is obvious, give it real visual weight on the worktree row, and default it to **on** for new worktrees (and existing active ones) so the feature is actually experienced instead of discovered by accident.

### What the feature actually does (root cause of the confusion)

`agents_open_with_grid` is a per-worktree flag (`worktrees.agents_open_with_grid`, `KanbanDatabase.ts:173`, default `0`). It is consumed in exactly one place — `createAgentGrid` in `src/extension.ts:2591`:

```ts
gridWorktrees = (await db.getWorktrees()).filter((w: any) => w.status === 'active' && w.agentsOpenWithGrid);
```

`createAgentGrid` is what the **main AGENTS button** runs: it opens the agent terminal grid (Planner / Lead Coder / Coder / Intern / Reviewer / …). For every active worktree whose `agentsOpenWithGrid` is on, it opens a **dedicated set of agent terminals inside that worktree's directory** (in addition to, or instead of when "Suppress main repo agent terminals" is checked). If suppress-main is on and **no** worktree has the flag, it warns "Suppress main is on but no worktree is set to open terminals — nothing to open." (`extension.ts:2596-2598`).

So the real meaning of the toggle is: **"When I click the main AGENTS button, also spawn agent terminals inside this worktree."** The current label "Open terminals with grid" (kanban.html:9739) and the 9px hidden placement communicate none of that — the user has no idea it's tied to the AGENTS button, and it's off by default so they never see the behavior.

### Why it's off by default

`addWorktree` (`KanbanDatabase.ts:2655-2680`) never sets `agents_open_with_grid`, so every new row takes the column default `INTEGER DEFAULT 0` (off). The column was added in migration V34 (`KanbanDatabase.ts:564`) and has shipped, so existing active worktrees are also off.

## Metadata

**Complexity:** 3
**Tags:** frontend, worktrees, terminals, ux

## Current State

- Worktree row rendering: `kanban.html:9626-9747` (`renderWorktreeRow`). The checkbox is built at `9724-9743` inside `detailsLine`, with label font-size `9px` (line 9740) — the smallest text on the row, tucked after the scope line.
- Toggle message: `toggleWorktreeAgentsOpenWithGrid` → `KanbanProvider.ts:7971` → `db.setWorktreeAgentsOpenWithGrid` (`KanbanDatabase.ts:2691`).
- Config send: `_sendWorktreeConfig` includes `agentsOpenWithGrid` per worktree (`KanbanProvider.ts:8944`).
- Consumption: `createAgentGrid` (`extension.ts:2591`), gated by `suppressMain` (`worktree_suppress_main_terminals` meta).

## Complexity Audit

**Routine, with a migration.** Frontend is a label/prominence swap in one render function. The default-on change is a one-line INSERT addition in `addWorktree` plus a one-time migration to flip existing active rows — both follow established patterns (V34 already added the column; `addWorktree` already takes optional fields). No schema-shape change, no new column, no message-protocol change. The only care is the migration touching shipped state (per `CLAUDE.md`: assume it shipped, migrate).

## Edge-Case & Dependency Audit

- **Shipped state migration** — `agents_open_with_grid` shipped in V34. A migration that flips existing `status='active'` rows to `1` changes behavior: the next main AGENTS-button press will open per-worktree terminals for worktrees that previously had it off. This is the user's explicit intent ("on by default"), but implementers should be aware it is a behavior change for the installed base, not just new worktrees. Per project rules, migrate (a no-op migration costs nothing; the user is requesting the flip).
- **`suppressMain` interaction** — with the flag now on by default, "Suppress main repo agent terminals" + at-least-one-active-worktree becomes a common, working combination (per-worktree terminals only). The existing "nothing to open" warning (`extension.ts:2597`) only fires when suppress is on AND no worktree has the flag — after this change that's far less likely, which is desirable.
- **Terminal cap** — `ensureWorktreeTerminals` caps at 5 terminals per role per worktree (`TaskViewerProvider.ts:7460`) and warns when hit. With grid-on by default across many worktrees, the AGENTS button will open more terminals; the existing per-role cap still bounds it, and the warning still fires. No new cap logic needed.
- **Existing rows that a user deliberately turned off** — the migration will re-enable them. Acceptable given the explicit request; users can turn individual worktrees back off via the now-prominent checkbox. (If preserving explicit-offs mattered, we'd need a separate "explicitly set" sentinel — out of scope and not requested.)
- **Label length / layout** — the row is a flex column; moving the toggle onto the main action line (next to Open terminals / Merge / Abandon) must keep the row readable on narrow webviews. Use the same `btn-secondary`-sized chip styling, not a giant control.
- **Epic/subtask/tier worktrees** — all flow through `addWorktree`, so the default-on INSERT covers them uniformly.

## Proposed Changes

### 1. `kanban.html` — relabel, retooltip, and promote the toggle

In `renderWorktreeRow` (`kanban.html:9710-9744`), move the toggle out of the tiny `detailsLine` footer onto the **main action line** (alongside Open terminals / Merge / Abandon, `kanban.html:9676-9706`) so it's visible at a glance, and rewrite the label + tooltip:

```js
// On the main action line, after abandonBtn (kanban.html:9706):
const gridChk = document.createElement('input');
gridChk.type = 'checkbox';
gridChk.checked = !!w.agentsOpenWithGrid;
gridChk.id = `wt-grid-${w.id}`;
gridChk.style.cssText = 'margin-left:6px; cursor:pointer;';
gridChk.title = 'When you click the main AGENTS button, open a dedicated set of agent terminals inside this worktree (Planner/Coder/Reviewer/…), in addition to the main repo terminals — or instead of them when "Suppress main repo agent terminals" is on.';
gridChk.addEventListener('change', () => {
    postKanbanMessage({
        type: 'toggleWorktreeAgentsOpenWithGrid',
        worktreeId: w.id,
        enabled: gridChk.checked,
        workspaceRoot: currentWorkspaceRoot
    });
});
mainLine.appendChild(gridChk);
const gridLabel = document.createElement('label');
gridLabel.htmlFor = `wt-grid-${w.id}`;
gridLabel.textContent = 'Agent terminals';
gridLabel.style.cssText = 'font-size:10px; color:var(--text-muted); cursor:pointer; margin-right:4px;';
gridLabel.title = gridChk.title;
mainLine.appendChild(gridLabel);
```

Then **remove** the old `chkWrapper`/`chk`/`label` block currently in `detailsLine` (`kanban.html:9724-9743`) so the toggle isn't rendered twice. Keep the `scopeSpan` in `detailsLine` (the routing-order text is still useful).

Rationale for the label "Agent terminals": short enough for the action line, and paired with the tooltip it clearly says "this worktree gets its own agent terminals when you press AGENTS." "Open terminals with grid" was jargon that assumed the user already knew what "the grid" meant.

### 2. `KanbanDatabase.addWorktree` — new worktrees default to grid-on

`src/services/KanbanDatabase.ts:2655-2668`. Add `agents_open_with_grid` to the INSERT so every new worktree row is on by default, independent of the column default:

```ts
public async addWorktree(branch: string, wtPath: string, epicId?: string, project?: string, subtaskPlanId?: string, baseBranch?: string, tier?: string): Promise<number> {
    if (!(await this.ensureReady()) || !this._db) return 0;
    this._db.run(
        `INSERT INTO worktrees (branch, path, epic_id, project, subtask_plan_id, base_branch, tier, agents_open_with_grid) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [
            branch,
            wtPath,
            epicId !== undefined && epicId !== null ? epicId : null,
            project !== undefined && project !== null ? project : null,
            subtaskPlanId !== undefined && subtaskPlanId !== null ? subtaskPlanId : null,
            baseBranch !== undefined && baseBranch !== null ? baseBranch : null,
            tier !== undefined && tier !== null ? tier : null,
        ]
    );
    // …rest unchanged
```

(Leave the column `DEFAULT 0` in the schema string as-is — the explicit `1` in the INSERT is the source of truth for new rows, and avoids any ALTER-DEFAULT complications on existing DBs.)

### 3. Migration V43 — flip existing active worktrees to grid-on

`src/services/KanbanDatabase.ts`, add a new migration next to the V42 block (~line 284). Follow the existing migration registration pattern (find the `MIGRATION_V*_SQL` array + the version bump + the apply switch used by V34/V42):

```ts
// V43: default agents_open_with_grid to ON for existing active worktrees.
// New rows are set by addWorktree's INSERT; this one-time update brings
// pre-existing active worktrees in line with the "on by default" behavior.
const MIGRATION_V43_SQL = [
    `UPDATE worktrees SET agents_open_with_grid = 1 WHERE status = 'active' AND agents_open_with_grid = 0`,
];
```

Register it in the migration runner at the current target version (bump `CURRENT_VERSION`/the version constant by 1 as V42 did) so it runs once on the next DB open. Log a line matching the V34 style (`KanbanDatabase.ts:5319`): `console.log('[KanbanDatabase] V43 migration completed: agents_open_with_grid defaulted to ON for active worktrees');`.

### 4. Tests

- `addWorktree` test: after insert, `getWorktrees()` returns the new row with `agentsOpenWithGrid === true`.
- Migration test: seed an active worktree with `agents_open_with_grid = 0`, run the V43 migration, assert it's now `1`; assert a `merged`/`abandoned` row is untouched.
- (If a webview harness exists) render test: a worktree with `agentsOpenWithGrid: true` shows the checkbox checked on the main action line and **not** duplicated in the details line; toggling posts `toggleWorktreeAgentsOpenWithGrid` with the new enabled value.

## Non-Goals

- No change to `createAgentGrid`'s terminal-opening logic (the consumption side already works).
- No change to the "Suppress main repo agent terminals" setting.
- No new "selectively preserve explicit-off" sentinel (out of scope; the user asked for on-by-default).
- No schema-shape change (column already exists).

## Verification Plan

1. Unit tests from §4.
2. Manual: create a new worktree from the WORKTREES tab → confirm the "Agent terminals" checkbox on its row is **checked** by default and sits on the action line (not buried in the footer).
3. Manual: open an existing workspace with pre-existing active worktrees → after the extension loads (V43 runs), confirm those worktrees' checkboxes are now checked.
4. Manual: with the box checked, click the main **AGENTS** button → confirm a set of agent terminals opens inside that worktree's directory (verify cwd via the terminal). Turn the box off → click AGENTS → confirm no per-worktree terminals open for it.
5. Manual: enable "Suppress main repo agent terminals" with one worktree grid-on → click AGENTS → confirm only the worktree terminals open (no main-repo ones); with all worktrees grid-off + suppress on → confirm the "nothing to open" warning still fires.
6. Hover the checkbox/label → confirm the new tooltip clearly explains the AGENTS-button behavior.

## User Review Required

Yes — confirm that flipping **existing** active worktrees to grid-on (migration V43) is desired, since it changes the next AGENTS-button press for the installed base. (New-worktree default-on is non-negotiable per the request; the only question is whether pre-existing worktrees should also be flipped.)
