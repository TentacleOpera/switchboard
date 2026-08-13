# Stop the Terminals Sidebar Inventing Workspace Group Headers Nobody Asked For

## Goal

The Terminals sidebar must not manufacture group headers. A terminal should appear under a workspace heading only when that heading is disambiguating something — never as a synthetic `Workspace Root` bucket, never as a sole heading wrapping every row, and never as an empty heading for a mapping with no terminals in it.

### The problem

Opening a grid group in the Terminals panel shows the terminals nested under a workspace-named group the user never created. There is no UI anywhere for creating it and no way to delete it, because it is not stored anywhere — it is computed fresh on every render.

### Root cause — the sidebar renders a directory hierarchy that is unconditional and partly synthetic

`renderSidebarList` in `src/webview/terminals.js` builds a two-tier tree (parent folder → worktree → rows) from `parentsList`, which is the **folder-mapping list from Setup**, not a user-created grouping. Three separate behaviours combine into "a group I never asked for":

**1. A synthetic catch-all is invented when there are no mappings** (lines 3122-3130):

```js
let parents = Array.isArray(parentsList) ? [...parentsList] : [];
if (parents.length === 0) {
    parents.push({
        id: 'workspace-root',
        name: 'Workspace Root',
        parentFolder: '',
        workspaceFolders: []
    });
}
```

Nothing about this comes from the user. With mappings disabled or a host that sent no parents, every terminal is then folded into it by the `soleSynthetic` branch (lines 3158-3160).

**2. Every configured mapping renders a header even with zero terminals in it.** `activeGroupsToRender` (lines 3180-3183) is `[...parentGroups, ...]` — all of them, unfiltered — and the render loop emits a full header plus a placeholder (lines 3268-3272):

```js
if (totalItems === 0) {
    const emptyNotice = document.createElement('div');
    emptyNotice.className = 'empty-parent-notice';
    emptyNotice.textContent = '(no terminals — + to open)';
```

Verified live on 2026-08-12: `POST /terminals/verb/ptyListTerminals` returns two mappings — `Autism360App` (`/Users/patrickvuleta/Documents/Gitlab`) and `Switchboard` (`/Users/patrickvuleta/Documents/GitHub/switchboard`) — and eight terminals, **all eight** with `parentRoot: /Users/patrickvuleta/Documents/GitHub/switchboard`. So the sidebar renders one heading containing everything and a second, entirely empty heading. Neither heading is separating anything.

**3. A sole heading is pure overhead.** When every live terminal shares one `parentRoot` and there are no worktree sub-groups, the heading conveys no information — every row is under it by definition — but it still costs a row of vertical space, a collapse target that can hide the whole fleet, and the appearance of a grouping the user did not make.

### Verified at HEAD — which of the three actually produced the reported header

The live payload has **two real mappings**, so `parents.length !== 0` and the webview's synthetic push at lines 3122-3130 never fired. The header the operator saw was behaviour **2** (the empty `Autism360App` mapping) and behaviour **3** (the sole populated `Switchboard` mapping) — not behaviour 1.

Behaviour 1 is also narrower than it looks: the **backend** synthesises its own catch-all. `resolveParentsForTerminals` returns exactly one parent with `id: 'workspace-root'` and `name: path.basename(workspaceRoot)` whenever mappings are disabled or empty — asserted by `src/test/multi-parent-terminals-contract.test.js:145-158` ("disabled mappings yield exactly ONE synthetic parent — never an empty array"). So with the extension running, `parentsList` is never empty and the webview's own fallback is unreachable; when mappings are off, the invented header is the *backend's*, named after the repo folder. Suppressing the sole header therefore fixes the mappings-off case as well, and it is the only mechanism that does.

### What is deliberately NOT in scope

`getDerivedGroups()` (line 2467) also auto-creates groups — by role and by worktree, at `groupPrefs.threshold` (default 2) — and those surface as **group tabs above the pane grid**, not as sidebar headings. They are a separate, intentional feature with its own hide/pin controls (`groupPrefs.hidden`, `groupPrefs.pinned`) and the live `activeGroupId` is one of them (`dg_role_planner`). This plan does not touch them. Likewise the user's real manual group (`terminals.groups` → `{ name: "switchboard", source: "manual", ... }`) is user-created and untouched. The backend's `resolveParentsForTerminals` is not touched either — the fix is entirely in what the sidebar chooses to render.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

## User Review Required

None. The two open decisions were made in this pass: the synthetic bucket stays as an internal fold target but never renders a header (see the supersession under Proposed Changes), and the per-mapping spawn path moves onto the group-tab-strip `+`, which is the panel's only remaining global new-terminal control.

## Complexity Audit

### Routine

- Filtering `activeGroupsToRender` to groups that hold terminals.
- Skipping the header when a sole group holds everything.
- Deleting the `empty-parent-notice` branch.

### Complex / Risky

- **The `+` spawn button lives on the header, and there is no other one.** `groupNewBtn` (lines 3231-3241) is how a user opens a terminal *into a specific parent folder* — `onNewTerminalClicked(parentGroup.fullPath ? { parentRoot: parentGroup.fullPath } : undefined, parentKey)`. Removing an empty group's header removes the only way to spawn into that folder. **`#btn-new-terminal` no longer exists** — line 192 records "`btnNew` is gone with #btn-new-terminal — spawning is per-group now", and line 751 confirms nothing global is bound. The only non-header spawn control is the group-tab-strip `+` (`.group-tab-add`, lines 2845-2854), which calls `onNewTerminalClicked(undefined, 'group:' + (activeGroupId || '__all__'))` — i.e. **no `parentRoot` at all**, so it always spawns into the default root. Any header suppression must give that control a target, or this fix breaks multi-repo terminal creation outright.
- **The role picker is mounted into the header's group.** `pickerState.key` is `'parent:' + parentGroup.id`, and the picker is appended between the header and the items container specifically so it survives collapse (lines 3260-3263). Suppressing a header must not orphan an open picker — the garbage-collect at line 3369 (`if (pickerState && !pickerRendered) { pickerState = null; }`) will silently close a picker whose host group stopped rendering.
- **`collapsedGroups` persistence.** Collapse state is keyed `'parent:<id>'` and written by `saveLayoutSettings` (line 1505). A group whose header is suppressed is not collapsible, so any persisted `parent:<id>` key for it becomes inert. Those keys have shipped, so they must be tolerated (ignored) rather than assumed absent — do not add a migration that deletes settings, just make the reader indifferent to unknown keys. The load path (lines 1409, 1497) already does `savedCollapsed.forEach(c => collapsedGroups.add(c))` with no validation, which is exactly the required indifference — confirm, do not "fix".
- **`Unmapped` is a real signal and must stay.** The `unmappedGroup` (lines 3140-3146) is already conditionally rendered (`unmappedGroup.direct.length > 0 || unmappedGroup.worktreesMap.size > 0`) and it tells the user a terminal is running somewhere no mapping covers. That is disambiguating information. Keep it, and keep its header even when it is the only group — "these are unmapped" is content, not decoration.
- **Worktree sub-groups.** A parent with worktree children genuinely needs its header to scope them. The sole-group suppression must check `worktreesMap.size === 0` as well as group count.
- **Three contract-test assertions read the exact spans this change edits.** Two must be preserved verbatim; one must be inverted as part of this change. See "Dependencies & Conflicts".

## Edge-Case & Dependency Audit

### Race Conditions

1. **`renderSidebarList` is called from many paths** — the 5s fleet poll, `terminalsChanged`, `afterPeekTransition`, group switches. The grouping decision must be a pure function of `fleetList` + `parentsList` so it cannot flicker between renders. It is: `populated()` and the sole-header test read only those two.
2. **An open picker when its host group stops rendering.** A mapping can go from populated to empty between polls (its last terminal exits) while its picker is open. After the change that group's header disappears mid-interaction and the line-3369 garbage-collect closes the picker. Accepted and correct: the picker is anchored to a group that no longer renders. The strip `+` (whose key is `group:*`, mounted outside `listEl` by `renderGroupTabStrip`) is unaffected and is where an operator recovers.

### Security

- None. No new transport; `createTerminal`'s `targetSpec` already accepts `{ parentRoot }` and the backend already resolves it.

### Side Effects

3. **Zero mappings configured.** With the extension running this cannot happen — the backend always returns at least its own synthetic parent. Under a host that sends none, `parentsList` is empty, the webview's synthetic fires, and that sole group is header-suppressed by rule (c). Rows render flat with no heading. This is the same visible outcome the original plan wanted from deleting the synthetic, without the fold rewrite.
4. **One mapping, all terminals under it, no worktrees.** Header suppressed, rows flat. Its `+` moves to the strip control's target list.
5. **One mapping with worktrees.** Header kept — it scopes the worktree children.
6. **Two or more mappings with terminals.** All populated headers kept, each with its own `+`. This is the case the hierarchy exists for.
7. **Two mappings, only one holds terminals.** The empty one renders nothing at all — no header, no notice. The populated one is now the sole group, so its header is suppressed too. Result on the live payload: zero headings, eight flat rows. Both mappings remain spawn targets via the strip `+`.
8. **Terminals in a mapping the user then deletes in Setup.** They become unmapped; the `Unmapped` header appears. Correct, unchanged.
9. **Exited terminals** still count toward `totalItems`/`activeCount`. A group holding only exited terminals is still holding terminals — keep it in `populated()`. Do not filter on `status !== 'exited'` for the "does this group hold anything" test.
10. **A worktree sub-group under an otherwise-empty parent.** `populated()` must test `worktreesMap.size > 0` as well as `direct.length > 0`, or a parent whose only terminals live in worktrees would be filtered out and its rows would vanish entirely — a data-loss bug far worse than the extra header.
11. **Solo popout.** `renderSidebarList` short-circuits parts of its render when `soloTerminalName` is set (the strip is skipped at line 3118). The grouping section still runs; suppression applies identically and harmlessly.
12. **No confirm dialogs** (repo rule).

### Dependencies & Conflicts

- **`buildRolePicker` is shared with the brand-icon subtask**, which rewrites the option rows. **That subtask must land first**; this one only adds a location control above the options.
- **`src/test/multi-parent-terminals-contract.test.js`** — three assertions touch this code:
  - **line 307 must be inverted as part of this change.** It currently asserts `/empty-parent-notice/.test(terminalsJs)` with the message "a parent with zero terminals must still show why it is there". That is the exact contract this plan removes. Rewrite the test to assert the class is **absent** and that `activeGroupsToRender` filters on occupancy. Leaving it is a knowingly-red test; deleting it silently drops the coverage — invert it and restate the reason.
  - **lines 266-274 must stay green.** They extract `block(terminalsJs, 'for (const item of fleetList) {', 'const activeGroupsToRender')` and require it to reference `workspace-root` or `!parentGroups[0].fullPath`, and to *not* contain the ungated `parentGroups.length === 1 ? parentGroups[0] : unmappedGroup` fold. Keeping the synthetic bucket and its `soleSynthetic` gate satisfies both.
  - **line 288 must stay green.** It matches the literal `unmappedGroup.direct.length > 0 || unmappedGroup.worktreesMap.size > 0` anywhere in the file. Do **not** refactor the unmapped arm of `activeGroupsToRender` into the `populated()` helper — spell that condition out verbatim and use the helper only for `parentGroups`.
  - **line 294** extracts `block(terminalsJs, 'for (const parentGroup of activeGroupsToRender) {', 'const headerEl = document.createElement')` and asserts the worktree totals are aggregated in it. The literal `const headerEl = document.createElement` must therefore still appear *after* the totals loop, even once header construction becomes conditional.
- Same file as the other three subtasks; serialise the edit stream.

## Dependencies

- The brand-icon subtask ("Show the Antigravity Brand Icon Everywhere terminals.html Names an Agent") must land first — shared `buildRolePicker`.

## Adversarial Synthesis

Key risks: suppressing headers removes the only spawn-into-a-specific-folder control in the panel, because `#btn-new-terminal` was deleted and the strip `+` passes no `parentRoot`; a `populated()` filter that forgets `worktreesMap` would delete rows, not just headings; and one shipped contract test asserts the empty-parent notice must exist, so the change is a deliberate contract reversal, not an unopposed cleanup. Mitigations: the strip `+` gains a spawn-location selector built from the existing `buildWorkspaceList()` helper and the existing `{ parentRoot }` `targetSpec` shape; `populated()` tests both collections; and `multi-parent-terminals-contract.test.js:307` is inverted in the same change, with two neighbouring assertions preserved verbatim by keeping the synthetic bucket and spelling the unmapped condition out longhand.

## Proposed Changes

### `src/webview/terminals.js` — `renderSidebarList`

**a) Keep the synthetic bucket; stop it ever wearing a header.**

> **Superseded:** "Delete the synthetic catch-all (lines 3041-3049) … The `soleSynthetic` branch then has no synthetic case left to serve. Replace its condition with 'no real mappings at all' … introduce an explicit headerless `flatGroup` for that case rather than reusing `unmappedGroup`."
> **Reason:** The defect is the **header**, not the bucket. Once rule (c) suppresses the sole group's header, a synthetic bucket is invisible — nothing named `Workspace Root` ever renders. Deleting the object instead forces a replacement bucket (`flatGroup`), a rewrite of the `soleSynthetic` fold, and breaks `multi-parent-terminals-contract.test.js:266-274`, which requires the fold to stay gated on the synthetic group — all for zero user-visible difference. It also would not have fixed the mappings-off case, where the invented header comes from the **backend's** `resolveParentsForTerminals` synthetic (`id: 'workspace-root'`, `name: basename(workspaceRoot)`), which this webview code cannot delete.
> **Replaced with:** Leave lines 3122-3130 and the `soleSynthetic` fold (3158-3160) exactly as they are, and add a comment recording that the bucket is now an internal fold target that never renders a heading. The header suppression in (c) covers both the webview synthetic and the backend one, because both arrive as a single parent group with no worktrees.

```js
// The synthetic bucket below is an internal fold target ONLY — it never renders a
// heading. `suppressSoleHeader` (further down) drops the header for any single
// populated parent group with no worktree children, which covers this bucket, the
// backend's own `workspace-root` synthetic (resolveParentsForTerminals, used when
// mappings are disabled), and the ordinary one-real-mapping case alike.
let parents = Array.isArray(parentsList) ? [...parentsList] : [];
```

**b) Render only groups that hold terminals** (lines 3180-3183):

```js
// A mapping with nothing in it is a heading that separates nothing from nothing.
// Both collections are tested: a parent whose only terminals live in worktrees has
// an empty `direct` and must NOT be filtered out.
const populated = (g) => g.direct.length > 0 || g.worktreesMap.size > 0;
const activeGroupsToRender = [
    ...parentGroups.filter(populated),
    // Spelled out longhand, not via populated(): multi-parent-terminals-contract
    // matches this exact condition to prove Unmapped is never an always-on header.
    ...(unmappedGroup.direct.length > 0 || unmappedGroup.worktreesMap.size > 0 ? [unmappedGroup] : [])
];
```

and delete the `totalItems === 0` empty-notice branch (lines 3268-3272) — it is now unreachable.

**c) Suppress the header when it disambiguates nothing.** Compute once, before the render loop:

```js
// A heading that every row is under by definition is not a grouping — it is a
// collapse target that can hide the whole fleet and a row of chrome claiming a
// structure the user never made. Suppressed for the SOLE populated parent group
// with no worktree children. Kept for `Unmapped` (that label is content), and
// kept whenever two or more groups render or a worktree needs scoping.
const suppressSoleHeader =
    activeGroupsToRender.length === 1 &&
    activeGroupsToRender[0] !== unmappedGroup &&
    activeGroupsToRender[0].worktreesMap.size === 0;
```

In the loop, keep the `totalItems` / `activeCount` aggregation exactly where it is, then gate header construction:

```js
for (const parentGroup of activeGroupsToRender) {
    const parentKey = 'parent:' + parentGroup.id;
    const headerless = suppressSoleHeader && parentGroup !== unmappedGroup;
    // A headerless group has no collapse target, so it can never be collapsed —
    // an inert persisted `parent:<id>` key must not hide the whole fleet.
    const isParentCollapsed = !headerless && collapsedGroups.has(parentKey);
    /* …totalItems / activeCount aggregation unchanged — the contract test extracts
       the span up to the `const headerEl` line and requires the worktree totals here… */
    if (!headerless) {
        const headerEl = document.createElement('div');
        /* …unchanged header construction, groupNewBtn, collapse listener… */
        parentDiv.appendChild(headerEl);
    }
    /* picker mount and itemsContainer unchanged */
}
```

The picker mount at lines 3260-3263 stays where it is — it is appended to `parentDiv`, not to `headerEl`, so a header-suppressed group still mounts its picker and still sets `pickerRendered`, and the garbage-collect at line 3369 leaves it alone.

**d) Give the strip `+` a spawn target, so every mapping stays reachable.**

> **Superseded:** "extend the panel's **top-level new-terminal control** to accept a target: pass `parentsList` into the picker as selectable spawn locations".
> **Reason:** There is no top-level new-terminal control. `#btn-new-terminal` was deleted — `terminals.js:192` and `:751` both record it, and nothing global is bound. The instruction as written has no target.
> **Replaced with:** The control to extend is the **group tab strip's `+`** (`.group-tab-add`, lines 2845-2854), the panel's only non-header spawn affordance. It currently calls `onNewTerminalClicked(undefined, addKey)` — a `targetSpec` of `undefined`, i.e. always the default root.

Add a spawn-location row to `buildRolePicker`, shown only when the picker was opened without a pinned target (the strip `+`) and more than one root is available. Enumerate from the existing helper `buildWorkspaceList()` (line 4839), which already returns `[{ root, label }]` from `parentsList` for the kanban pane's workspace picker:

```js
// Header `+` buttons pass a pinned { parentRoot }. The strip `+` passes undefined,
// and with sole/empty headers suppressed it is now the ONLY route to a non-default
// folder — so it must let the operator choose one. Reuses buildWorkspaceList(),
// the same parentsList projection the kanban pane's workspace picker uses, and the
// same { parentRoot } targetSpec shape createTerminal already accepts. No new transport.
let chosenTarget = targetSpec;
const roots = buildWorkspaceList();
if (!targetSpec && roots.length > 1) {
    const loc = document.createElement('select');
    loc.className = 'role-picker-location';
    for (const r of roots) {
        const opt = document.createElement('option');
        opt.value = r.root;
        opt.textContent = r.label;
        loc.appendChild(opt);
    }
    loc.addEventListener('change', () => { chosenTarget = { parentRoot: loc.value }; });
    chosenTarget = { parentRoot: roots[0].root };
    picker.appendChild(loc);
}
```

and pass `chosenTarget` — not `targetSpec` — to `createTerminal` in both the role-option and `No role` click handlers. Note the handlers read it at click time, so a change after the picker renders is honoured without a re-render.

**e) Confirm the collapse-key reader is already indifferent.** The load path (lines 1409, 1497) adds every persisted string to `collapsedGroups` without validating it against a live group id, so an orphaned `parent:*` key is inert. No change needed; do not add a cleanup pass, and do not delete keys from settings.

### `src/webview/terminals.html`

Add a rule for `.role-picker-location`, modelled on the existing `.link-select` / `.role-picker-title` treatment, so the selector reads as part of the picker rather than as a stray form control. No other CSS changes — the rows already render flat when no header wraps them.

### `src/test/multi-parent-terminals-contract.test.js`

Invert the assertion at line 307 in the same change (test **authoring**, not execution — execution is deferred by session directive):

```js
test('an empty parent renders nothing at all — no header, no notice', () => {
    assert.ok(!/empty-parent-notice/.test(terminalsJs), 'a mapping with no terminals must not manufacture a heading');
    assert.ok(/parentGroups\.filter\(populated\)/.test(terminalsJs), 'only populated parent groups may render');
});
```

## Verification Plan

### Automated Tests

Execution is **deferred by session directive (SKIP TESTS)**. The assertion inversion above is part of the implementation. The following neighbouring assertions in the same file must be left structurally intact so they pass when the suite is next run:

- `multi-parent-terminals-contract.test.js:266-274` — the `soleSynthetic` fold must stay gated on `workspace-root` / `!parentGroups[0].fullPath`, and the ungated sole-parent fold must not reappear. Preserved by keeping the synthetic bucket.
- `multi-parent-terminals-contract.test.js:288` — the literal `unmappedGroup.direct.length > 0 || unmappedGroup.worktreesMap.size > 0` must survive verbatim.
- `multi-parent-terminals-contract.test.js:294` — `const headerEl = document.createElement` must still follow the `totalItems += wtGroup.items.length` aggregation inside the `activeGroupsToRender` loop.
- `multi-parent-terminals-contract.test.js:300-305` — the `'parent:' + parentGroup.id` and `'worktree:' + wtPath` collapse keys must survive.

### Static checks

1. `grep -n "empty-parent-notice" src/webview/terminals.js src/webview/terminals.html` returns nothing in the JS (the CSS rule may remain unused or be removed with it).
2. `grep -n "suppressSoleHeader" src/webview/terminals.js` shows the single computation and its uses in the loop.
3. `grep -n "buildWorkspaceList" src/webview/terminals.js` shows the pre-existing definition plus the new use in `buildRolePicker` — no second enumeration of `parentsList` was written.
4. `grep -n "btn-new-terminal" src/webview/terminals.js src/webview/terminals.html` still returns nothing but the two comments — no dead control was resurrected.

### Manual UAT

*(The browser panel is served from the installed VSIX's `dist/`, not `src/` — rebuild and reinstall the VSIX before concluding the headings are still there.)*

5. **The live repro.** With two mappings configured and every terminal under one of them, open the Terminals panel: **no** workspace heading appears above the rows, and the empty mapping contributes nothing — no header, no `(no terminals — + to open)` line.
6. Open a terminal in the second configured folder so two mappings are populated — both headings appear, each with its own `+`. Close it — the headings disappear and the rows go flat again.
7. **Spawn into the other folder.** With headings suppressed, click the `+` on the group tab strip. The picker offers a location selector listing both configured folders; pick the second, pick a role, and confirm the new terminal's `parentRoot` is that folder (it appears under the second heading once created).
8. **Sole mapping with a worktree.** Create a terminal in a worktree of the single populated mapping; the parent heading reappears (it is now scoping the worktree sub-header) and disappears again when that terminal closes.
9. **Unmapped survives.** Start a terminal in a directory no mapping covers; the `Unmapped` heading renders even as the only heading, with its terminals under it.
10. **Exited-only group.** Let a second mapping's only terminal exit; its heading must still render while another group is populated (the group still holds a terminal).
11. **Picker survives a re-render.** Open the picker on the now-headerless sole group and wait past a 5s fleet poll — it must still be on screen.
12. **Orphaned collapse key.** With a persisted `parent:workspace-root` collapse key from an earlier version, confirm the fleet is visible (a suppressed header is not collapsible) and the console shows no error.
13. Switch between group tabs above the pane grid and confirm the sidebar tree is unaffected — the derived/manual group feature is untouched.

---

**Recommendation:** Complexity 5 — **Send to Coder.**
