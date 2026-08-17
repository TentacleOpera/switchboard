# Team Subheaders in the Terminals Sidebar — Group Seats Under the Team That Claims Them

## Goal

The terminals sidebar shows a seat's team as a **tier in the tree**, not as an 8px chip on the row. Start a team of four and the sidebar reads `switchboard ▸ Coding-lead (4) ▸ [lead, coder-1, coder-2, reviewer]`, collapsible, with ungrouped seats still listed loose beneath. A workspace running two teams plus a stray shell no longer reads as one undifferentiated list of nine rows.

### Problem & background

`renderSidebarList` (`src/webview/terminals.js:3287`) builds a **two-tier** tree and only two tiers:

1. **Parent workspace** — bucketed by `item.parentRoot` (`:3405-3416`), rendered as `.parent-group-header`.
2. **Worktree** — a seat whose `worktreePath` is neither its parent root nor itself a registered parent folder goes into `targetGroup.worktreesMap` (`:3418-3432`) and is rendered under a `.worktree-group-header`.

Everything else lands in `parentGroup.direct` and is rendered as a **flat run of rows** (`:3529-3531`), sorted by `compareTerminals` — which orders by exited-ness, then role tier, then numeric name suffix (`:3253-3285`). Role ordering interleaves teams: two teams that both contain a lead and two coders render as `lead, lead, coder-1, coder-1, coder-2, coder-2`, with the two teams' seats alternating. That is the "jumbled all together" the report describes, and the worktree tier does not help — a team started in the workspace root shares one `cwd`, so every member is `direct`.

Team membership *is* known to the panel. `wireSpawnedTeam` (`src/services/teamWiring.ts:1036-1045`) registers each started team into `terminals.groups` as `{ id: 'team_<head>', name: <headName>, source: 'manual', members: [head, ...children], order: [...] }`, and the panel loads that array into `terminalGroups`. The membership resolver already exists: `getGroupMembers` (`:2748`) for a `manual` group returns its `order`/`members` intersected with the live set, and `findGroupForTerminalName` (`:2852`) resolves a seat to its claiming group.

### Root cause — the tier was deliberately replaced by a chip, and the chip does not do the job

This is not an oversight. It is a decision recorded in the code, at `terminals.js:2219-2220`:

> *"Group membership chip — shows which group claims this terminal, so membership is legible without a nesting tier in the sidebar tree."*

The chip is rendered into `.item-role-row` from `findGroupForTerminalName` and styled `max-width: 80px` with ellipsis at 9px (`terminals.html:884`). It answers "which group claims this row?" one row at a time. It cannot answer "which seats are on this team?", "how many are alive?", or "can I collapse this team away?" — and at 9px with an 80px clamp it truncates the moment a group name is longer than about twelve characters, which the code itself notes (`:2239-2243`).

So the fix is not to widen or restyle the chip. It is to add the tier the chip was meant to replace, and delete the rationale that says a tier is unnecessary.

### Scope note — one tier, not a general grouping view

There is already a group **tab strip** above the pane grid (`renderGroupTabStrip`, `:3000`) which is the seating/switching surface, and the retired `renderGroupSidebar` is pinned dead by `src/test/terminal-sidebar-groupings-contract.test.js:228`. This plan does not resurrect that: it adds one nesting level inside the existing workspace→worktree tree, keyed on **manual** groups only (which is what a started team is). Derived role groups are opt-in queries (`groupPrefs.autoRoleGroups`, `:2693`) and derived worktree groups would duplicate the worktree tier that already exists — neither becomes a tier.

---

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, ux
- **Project:** Browser Switchboard

---

## Complexity Audit (Routine vs Complex/Risky)

**Routine:**
- Bucketing an array by a precomputed map before rendering it.
- Cloning the existing worktree-tier header markup (collapse icon, name, count, `+`) for a third tier.
- Adding four CSS rules to `terminals.html` mirroring `.worktree-group` / `.indent-worktree`.

**Complex / risky:**
- **Two contract tests slice `renderSidebarList` on literals this change moves.** `src/test/terminal-sidebar-role-ordering-contract.test.js:84` extracts the block from `'function renderSidebarList() {'` to the literal `'for (const item of parentGroup.direct) {'`. That loop is exactly what gets replaced. The `block()` helper throws when a delimiter is missing, so this is a hard failure, not a soft one — the test must be updated in the same change, and the sort-before-render assertions must be re-pointed at the new bucketing so the guarantee they encode survives.
- **Cost per render.** `findGroupForTerminalName` calls `getGroupMembers` for every group on every call; calling it once per row makes the sidebar O(rows × groups × members) on a path that runs on every fleet poll. The bucketing must build one name→group map per render instead.
- **A team can span locations.** Members spawned into per-plan worktrees are already filed under worktree tiers. Bucketing at each tier independently (parent-direct and each worktree's items) keeps the tree truthful — a team appears wherever its seats are — rather than lifting seats out of the worktree they actually live in.
- **Collapse state persistence.** `collapsedGroups` is saved via `saveLayoutSettings()`; a new key namespace (`team:`) must not collide with the existing `parent:` / `worktree:` / `group:` namespaces.

---

## Edge-Case & Dependency Audit

| Case | Behaviour |
|---|---|
| Seat in no group | Rendered as a loose row under its parent/worktree, below the team tiers. No pseudo-group ("Unassigned" is retired — `:2728-2733`). |
| Seat in a **derived** group only (role/worktree) | Loose row, and it **keeps its chip** — the chip still answers the question no tier does for derived claims. |
| Seat in a manual team | Rendered under that team's subheader, and its chip is **suppressed** (the tier already names the team; the chip would be the same word twice on one row). |
| Team whose members span two workspaces | A subheader per location, each counting only the seats present there. Truthful; no seat is moved out of the workspace it runs in. |
| Team with exactly one live member | Still gets a subheader. A tier that appears and disappears on member count is a tier the operator cannot learn — the same reasoning `getDerivedGroups` applies to always-suffixing role group names (`:2697-2699`). |
| Exited member | Stays under its team subheader; `compareTerminals` sinks it within the bucket, and the team count reads `3 (2a/1x)` like the worktree tier. |
| Team whose every member exited | The subheader remains as long as any row is present, and disappears with its last row — consistent with the worktree tier, which is keyed on having items. |
| Overlapping membership (a coder added to a derived group as an extra) | The bucketing map takes the **first manual** claimant, matching `findGroupForTerminalName`'s precedence. No row is rendered twice. |
| Multi-select / `group` button | Unchanged — the selection header is rendered before the tree (`:3312-3368`) and the team tier does not touch `selectedTerminalNames`. |
| Role picker (`pickerState`) | New `team:` keys are **not** picker anchors; the tier's `+` reuses the parent's spawn target so no new picker key namespace is introduced, and the existing `pickerRendered` garbage-collect (`:3624`) is unaffected. |
| Browser cockpit | Same file serves both surfaces (`terminals.js` + `terminals.html` are shared), so one edit covers the VS Code webview and the browser panel. |

**Dependencies:** none outside this repo. Reads `terminalGroups` (already loaded), `collapsedGroups` (already persisted), `compareTerminals` (unchanged).

---

## Proposed Changes

### 1. `src/webview/terminals.js` — bucket by manual group, render a third tier

**1a. One map per render, not one lookup per row.** Added above the bucketing loop:

```js
/**
 * name -> claiming MANUAL group, built once per render.
 *
 * findGroupForTerminalName calls getGroupMembers for every group, so calling it
 * per row is O(rows x groups x members) on a path that runs on every fleet
 * poll. Manual groups only: a started team registers itself as one
 * (teamWiring.ts:1038), while derived role/worktree groups are queries — and a
 * derived worktree group would duplicate the worktree tier this sits inside.
 * First claimant wins, matching findGroupForTerminalName's precedence.
 */
function buildTeamClaimMap() {
    const map = new Map();
    for (const g of terminalGroups) {
        if (!g || g.source !== 'manual') { continue; }
        for (const name of getGroupMembers(g)) {
            if (!map.has(name)) { map.set(name, g); }
        }
    }
    return map;
}
```

**1b. Split any row run into team buckets + loose rows.** A shared helper, used for `parentGroup.direct` and for each `wtGroup.items` so both tiers gain team subheaders:

```js
/**
 * Split a sorted run of rows into per-team buckets plus the ungrouped
 * remainder. Buckets are ordered by first appearance in the already-sorted
 * input, so team order inherits compareTerminals' role tiering (a lead-headed
 * team sorts above a coder-headed one) with no second comparator.
 */
function bucketRowsByTeam(items, claimMap) {
    const buckets = new Map();   // groupId -> { group, items: [] }
    const loose = [];
    for (const item of items) {
        const g = claimMap.get(item.friendlyName);
        if (!g) { loose.push(item); continue; }
        let b = buckets.get(g.id);
        if (!b) { b = { group: g, items: [] }; buckets.set(g.id, b); }
        b.items.push(item);
    }
    return { buckets: [...buckets.values()], loose };
}
```

**1c. Render the tier.** The flat loop at `:3529-3531` becomes:

```js
const claimMap = buildTeamClaimMap();
const directSplit = bucketRowsByTeam(parentGroup.direct, claimMap);
for (const bucket of directSplit.buckets) {
    itemsContainer.appendChild(renderTeamTier(bucket, parentGroup));
}
for (const item of directSplit.loose) {
    itemsContainer.appendChild(renderTerminalRow(item));
}
```

and the identical two lines replace the worktree item loop at `:3599-3601` (with `wtGroup` as the spawn-target owner).

`renderTeamTier` mirrors the worktree header exactly — collapse icon, `.worktree-name`, `.worktree-count` in `N (Aa/Xx)` form, and a `+` that spawns into the **enclosing** location (not into the team, which is not a place):

```js
/**
 * One team subheader plus its rows. Deliberately reuses the worktree tier's
 * classes for the header internals so the three tiers read as one system; only
 * the wrapper class differs, and it carries the indent + accent.
 *
 * The `+` targets the ENCLOSING location, not the team: a team is a roster, not
 * a directory, and there is no "spawn into this team" operation (team members
 * are spawned by the team start, teamWiring.ts).
 */
function renderTeamTier(bucket, locationOwner) {
    const key = 'team:' + bucket.group.id;
    const isCollapsed = collapsedGroups.has(key);
    const div = document.createElement('div');
    div.className = 'team-group indent-team' + (isCollapsed ? ' collapsed' : '');
    // ... header: icon '▼', name = bucket.group.shortName || bucket.group.name,
    //     count = `${bucket.items.length} (${active}a/${exited}x)`
    // ... header click toggles collapsedGroups + saveLayoutSettings() + renderSidebarList()
    const itemsEl = document.createElement('div');
    itemsEl.className = 'team-items';
    for (const item of bucket.items) { itemsEl.appendChild(renderTerminalRow(item, { inTeamTier: true })); }
    div.appendChild(itemsEl);
    return div;
}
```

**1d. Suppress the now-duplicated chip, and delete the rationale that rejected this tier.** In `renderTerminalRow` (`:2219-2247`) the comment block asserting membership is "legible without a nesting tier in the sidebar tree" is **removed** — it is the justification for the behaviour being reported as a bug, and leaving it inverts for the next reader. The chip itself stays for derived claims:

```js
// Group membership chip — for a seat NOT rendered under a team subheader.
// Under a tier the chip is the tier's own name repeated on every row, so it is
// suppressed there. A seat claimed only by a derived role/worktree group has no
// tier, and the chip is still the only thing that names its claimant.
const claimingGroup = opts?.inTeamTier ? null : findGroupForTerminalName(item.friendlyName);
```

`renderTerminalRow`'s signature gains an optional second argument, defaulted, so its other call sites are untouched.

### 2. `src/webview/terminals.html` — CSS for the third tier

Added after `.worktree-group.indent-worktree` (`:668-672`), reusing the worktree header rules by class-listing rather than duplicating them:

```css
/* Team tier — one level inside a workspace or worktree. Header internals reuse
   .worktree-* classes; only the wrapper, indent and accent are new. */
.team-group { margin-bottom: 6px; margin-left: 6px;
              border-left: 1px solid var(--accent-violet, #c586c0);
              padding-left: 4px; }
.team-group-header { display: flex; align-items: center; justify-content: space-between;
                     padding: 3px 6px; background: rgba(255,255,255,0.025);
                     border-radius: 3px; font-size: 10px; font-weight: 600;
                     color: var(--text-secondary); cursor: pointer; }
.team-group-header:hover { color: var(--text-primary); background: rgba(255,255,255,0.05); }
.team-group.collapsed .worktree-collapse-icon { transform: rotate(-90deg); }
.team-items { padding-left: 6px; margin-top: 3px; }
.team-group.collapsed .team-items { display: none; }
```

The violet left-border distinguishes a roster tier from the teal location tiers (`--accent-teal` on `.parent-group-header`, `:647`) — the same accent the retired group tier used (`terminals.html:729`).

### 3. `src/test/terminal-sidebar-role-ordering-contract.test.js` — re-point the slice

`test('renderSidebarList sorts before iterating')` currently slices to `'for (const item of parentGroup.direct) {'`, which this change deletes. Re-point the end delimiter to `'const claimMap = buildTeamClaimMap();'` and keep both existing sort assertions — plus one new one, because sorting now has to survive the bucketing:

```js
assert.ok(/bucketRowsByTeam\(parentGroup\.direct, claimMap\)/.test(render),
    'direct rows must be bucketed by team AFTER sorting — bucketing preserves input order, so a bucket built from an unsorted run is unsorted');
```

### 4. `src/test/terminal-sidebar-groupings-contract.test.js` — pin the new tier

Additive assertions in the existing `renderSidebarList` hierarchy test (its current assertions all still hold — no `groupsView` branch, no `renderGroupSidebar`, tab strip still rendered):

- `buildTeamClaimMap` filters on `source !== 'manual'` (a derived worktree group must not become a tier inside the worktree tier).
- `buildTeamClaimMap` is called **once** per `renderSidebarList` invocation, and `findGroupForTerminalName` is **not** called from inside a row loop.
- `renderTeamTier` uses the collapse key prefix `'team:'` and calls `saveLayoutSettings()`.
- both the parent-direct run and each worktree run go through `bucketRowsByTeam` (a team whose members live in worktrees must still get a subheader).
- the "legible without a nesting tier" comment is **gone** from `terminals.js` — the pin that stops a later pass from restoring the rejected rationale.
- `.team-group`, `.team-group-header`, `.team-items` and `.indent-team` all exist in `terminals.html` (the panel-CSS-must-ship pin).

---

## Verification Plan

1. **Unit:** `node src/test/terminal-sidebar-role-ordering-contract.test.js` and `node src/test/terminal-sidebar-groupings-contract.test.js` — both green.
2. **Regression:** `node src/test/multi-parent-terminals-contract.test.js`, `node src/test/shell-terminal-strip.test.js`, `node src/test/terminal-pane-pinning-contract.test.js` — all three slice `renderSidebarList` on other delimiters and must remain green untouched.
3. **UAT — one team.** Start the Coding team. The sidebar shows the workspace header, then one team subheader named after the head, then the four seats indented beneath it. Row chips are gone on those four rows.
4. **UAT — two teams.** Start a second team with an overlapping role set. Two subheaders, no interleaving, counts correct per team, and no seat listed twice.
5. **UAT — collapse persistence.** Collapse one team, reload the panel. It is still collapsed, and the other team is still open.
6. **UAT — mixed.** With two teams running, open a plain shell via the workspace `+`. It renders as a loose row **below** both team tiers, with no team subheader of its own.
7. **UAT — worktree team.** Dispatch a feature that spawns members into per-plan worktrees. Each worktree tier contains its own team subheader; no seat is lifted out of its worktree.
8. **UAT — derived claim keeps its chip.** Enable `autoRoleGroups` with three same-role seats outside any team. They stay loose rows and each still shows its role-group chip.
9. **UAT — exit.** Close one team member. Its row sinks within the team bucket and the team count moves to `4 (3a/1x)`.
10. **UAT — browser cockpit.** Load the browser terminals panel and confirm the identical tree, since both surfaces share the file.
