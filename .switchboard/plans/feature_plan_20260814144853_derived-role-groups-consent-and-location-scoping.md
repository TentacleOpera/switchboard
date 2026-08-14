# Stop Auto-Creating a "Planners" Group, and Scope Role Groups to One Workspace/Worktree

## Goal

Two things must change in the Terminals cockpit group model:

1. **A role group must never materialise on its own.** Spawning a second planner must not conjure a group tab called "Planners", a `Planners` membership chip on every planner row, and a lock target the operator never asked for.
2. **When role grouping is deliberately enabled, a role group must not span locations.** A `planner` in `~/Documents/GitHub/switchboard` and a `planner` in `~/Documents/Gitlab/viaapp` (or in a worktree under either) are two different agents doing two different jobs. Today they are seated into the same grid as if they were a fleet.

### Problem analysis

`src/webview/terminals.js:2473 getDerivedGroups()` synthesises groups from the live fleet on every render. Its role arm is:

```js
const roleMap = new Map();
for (const t of live) {
    if (t.role) { roleMap.set(t.role, (roleMap.get(t.role) || 0) + 1); }
    if (t.worktreePath) { worktreeMap.set(t.worktreePath, (worktreeMap.get(t.worktreePath) || 0) + 1); }
}
...
for (const [role, count] of roleMap) {
    if (count >= threshold) {
        derived.push({
            id: safeGroupIdForValue('role', role),
            name: (role.charAt(0).toUpperCase() + role.slice(1)) + 's',   // ← "Planners"
            source: 'role',
            value: role
        });
    }
}
```

`threshold` comes from `groupPrefs.threshold`, initialised to `2` at `terminals.js:101` and re-floored to `2` by the loader at `terminals.js:1470` for anything `<= 1`. **There is no UI anywhere in the product that sets it** — `grep -rn "threshold" src/webview/` returns only the auto-archive dwell hours in `kanban.html` and a pixel diff in `inspect.js`. So `2` is not a default, it is the only value: the second planner always trips it.

That single derived record then fans out across four surfaces with no further consent:

| Surface | Site |
| :--- | :--- |
| A group tab in the strip, with a member count and a `×` | `terminals.js:2775 renderGroupTabStrip()` |
| A `Planners` chip on every planner row in the sidebar | `terminals.js:2088` via `findGroupForTerminalName` |
| A lock target — clicking the tab reseats the whole grid | `terminals.js:2403 switchToGroup()` |
| A destination for the locked-group empty-pane fill | `terminals.js:2648 addTerminalToActiveGroup()` |

The only escape is the `×`, which routes through `deleteGroup` (`terminals.js:2276`) into `groupPrefs.hidden` — a *suppression list*, i.e. the operator must individually dismiss each role the system invented. That is opt-out, and it is the wrong polarity for a thing nobody asked for.

The second defect is in the same record. The role key is `t.role` alone — no location component — and the membership query mirrors it (`terminals.js:2549`):

```js
} else if (group.source === 'role') {
    names = fleetList.filter(t => t.status !== 'exited' && !t.parentInstanceId && t.role === group.value).map(t => t.friendlyName);
}
```

Every fleet record already carries the two fields needed to partition this. `parentRoot` is stamped per terminal by **both** hosts — `src/services/TaskViewerProvider.ts:2381` and `src/standalone/bootstrap.ts:1281`, both from `resolveParentsForTerminals`'s `parentMap` — and `worktreePath` is carried on the pty handle from creation (`src/standalone/ptyFleetService.ts:263`). `renderSidebarList` (`terminals.js:3037`) already buckets the fleet by exactly those two fields into parent groups and per-worktree sub-groups (`terminals.js:3154-3183`). The derived role group is the one place in the panel that ignores them.

The backend already treats a role pool as location-scoped and says so out loud. `TaskViewerProvider.getRoleTerminalSet()` (`src/services/TaskViewerProvider.ts:6048`) computes a `locationKey` from the shared worktree path, falling back to the resolved workspace root, and its mixed-location branch (`:6071`) reads:

```js
} else {
    // Mixed worktrees in one role pool is not expected; fall back to a
    // name signature so distinct sets still get distinct cursors.
    locationKey = terminals.join('|');
}
```

So the dispatch side considers a cross-location role pool an anomaly worth a defensive branch, while the cockpit side *constructs* one and calls it a group.

### Root cause

`getDerivedGroups()` treats "N terminals share a `role` string" as sufficient evidence of two separate things it has no evidence for: that the operator wants a group, and that those terminals belong together. Role is a job title, not a team and not a place. Both defects are the same missing predicate — the role key needs an operator opt-in in front of it and a location component inside it.

`src/webview/terminals.js` is served to both hosts from one copy (`src/services/headlessPanelHtml.ts:400` maps `{{TERMINALS_JS_URI}}` → `/static/webview/terminals.js`), so this is a single-file fix with no host fork. The panel CSS is likewise one copy — `headlessPanelHtml.ts:389-390` reads `dist/webview/terminals.html` then falls back to `src/webview/terminals.html` — so the existing `.group-tab-overflow-item` (`terminals.html:826`) and `.item-group-chip` (`:866`) rules are available in both hosts and no new stylesheet work is required.

### This is a clean break — no migration

`getDerivedGroups`, `groupPrefs`, and the entire `dg_role_*` / `dg_worktree_*` id scheme were introduced in commit `1bd39f4a` (2026-08-14 09:49). None of it has been in a released VSIX. **No install anywhere holds a `dg_role_<role>` key in `groupPrefs.layouts` / `.orders` / `.extras` / `.pinned`, or a `dg_role_*` value in `terminals.activeGroupId`.**

**The load-bearing evidence is that `1bd39f4a` is UNPUSHED, not the `git log -S` probe.** `git log origin/main..HEAD` lists it, so it is in no lineage a release could have been cut from. Use that check, not the one below, if this is ever re-litigated:

- `git log -S … -- src/webview/terminals.js` is **path-scoped**, so it cannot see code moved in from another file — a live pattern in this repo, where `planning.js` still carries dead duplicates of extracted panel code. It is suggestive, not decisive. (Run without the pathspec it still returns only `1bd39f4a`; the one earlier `source: 'role'` hit, in `f9ec8198`, is a **plan file** — the design doc for this work — not code.)
- **The installed `1.7.13` VSIX is not counter-evidence, though it looks like it.** Its `dist/webview/terminals.js` *does* contain `dg_`, `source:"role"`, `source:"worktree"`, `terminals.groupPrefs` and `terminals.activeGroupId`. That bundle was built 2026-08-14 13:15 — 3.5 hours *after* `1bd39f4a` — i.e. it is a local build of this unpushed tree, which is how this repo is tested (CLAUDE.md: all testing is via an installed VSIX). It shares a version number with the published release and cannot be distinguished from it by version alone. Do not grep the installed bundle to decide whether something shipped.
- Do not grep it for identifiers either: `deleteGroup`, `safeGroupIdForValue` and `restoredLockOnLoad` all return **0** there because they are minified locals. Only string literals and object property names survive.

**One residual, on this machine only.** This workspace's `kanban.db` config table may already hold a `terminals.groupPrefs` blob and a `terminals.activeGroupId` from today's dev-build session, possibly carrying `dg_role_*` keys. That is one install, not the install base — no migration is owed, and Proposed Change 8's reconcile already clears a stale role lock on the first fleet fetch. Expect to see one stale tab or lock clear itself once after this lands; that is the reconcile working, not a regression.

Per CLAUDE.md, unreleased dev state takes clean breaks: no compat shims, no legacy-key read-through, no use-inference on load. The new location-scoped id simply replaces the old one, and `autoRoleGroups` defaults to `false` for everybody.

> **Superseded:** The change orphans four shipped preference maps keyed by `dg_role_<role>`, so per CLAUDE.md every reader needs a legacy read-through, the loader needs a `usedRoleGroups` inference (consulting `layouts`/`orders`/`extras`/`pinned`/`activeGroupId` but deliberately not `hidden`) to migrate `autoRoleGroups` on for prior users, and the lock reconcile needs a pre-scoping-id branch.
> **Reason:** Fiction. The state being "migrated" is one commit old and unreleased — `git log -S` on each of `getDerivedGroups`, `groupPrefs` and the id-encoder returns only `1bd39f4a`, dated today, at `HEAD`. CLAUDE.md's "when unsure whether something shipped, assume it did" is a tiebreaker for when the answer is *unknown*; here it is one command away and the answer is no. The invented apparatus was ~40% of the plan's surface area (two helpers, three reader rewrites, a loader inference, four test assertions, four verification steps) and every line of it protects nothing.
> **Replaced with:** No migration. `autoRoleGroups: false` for all installs. Readers, writers and the id scheme change together with no aliasing. The lock reconcile narrows to the one case that can actually occur (see Proposed Change 8).

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 5
> **Reason:** With the invented migration removed, what remains is one file, eight edit sites, and a contract-test update. It reuses existing patterns throughout (the location key is the third copy of a normalisation `renderSidebarList` and `getRoleTerminalSet` already do). The residual risk is two render/consent traps and two test tripwires, not architectural.
> **Replaced with:** **Complexity:** 4 — routine multi-site change in one file. Routing: Send to Coder.

## User Review Required

- None.

## Complexity Audit

### Routine

- Adding a `locationKeyForTerminal(t)` / `locationLabelForKey(key)` helper pair beside `safeGroupIdForValue` (`terminals.js:2468`). Both fields are already on every fleet record and already normalised the same way in `renderSidebarList` (`terminals.js:3177` splits on `/` after a `\\` → `/` replace to get a basename). **Verified — line counted.**
- Compositing the role key as `role + LOC_SEP + locationKey` and passing it through the existing `safeGroupIdForValue('role', …)` encoder — the encoder already `encodeURIComponent`s and strips to `[a-zA-Z0-9_]`, so a path is safe input (`terminals.js:2468-2471`).

> **Superseded:** the composite key joined on `'@'` (`role + '@' + loc`).
> **Reason:** `@` is legal in a POSIX path, so two distinct `(role, location)` pairs can collide into one map key — `role='a'` + `loc='b@c'` and `role='a@b'` + `loc='c'` both produce `a@b@c`, silently merging two locations into one tab. The blast radius here is smaller than in the sibling plan that was deleted for this design (this plan reads `role`/`loc` back off the stored entry object rather than splitting the key, so a collision merges groups instead of manufacturing a group named after a path fragment) — but it is a one-line fix either way, and a map key that cannot collide is worth more than a rationale for why the collision is survivable.
> **Replaced with:** `LOC_SEP = '\u0000'`. A filesystem path can contain `@`, a space, a dash, a colon and a pipe; it cannot contain NUL. Keep reading `role`/`loc` off the entry object — do **not** switch to splitting the key.
- Adding `autoRoleGroups` to the `groupPrefs` initialiser (`terminals.js:101`) and to the loader whitelist (`terminals.js:1469-1476`).
- Rendering a toggle row in the strip's overflow menu, which already hosts the "N deleted groups — restore all" entry (`terminals.js:2939-2951`) and already has a styled `.group-tab-overflow-item` class.
- All preference readers and writers (`getGroupMembers` extras overlay `:2560`, `orderGroupMembers` `:2574`, `setGroupOrder` `:2589`, `getStoredGroupLayout` `:2600`, `addTerminalToActiveGroup` `:2648`, the layout-picker store `:816`, `deleteGroup` `:2276`) are **untouched**. They key on `group.id`; the id changes shape and they follow it. No aliasing, nothing to migrate.

### Complex / Risky

- **The loader whitelist silently drops unknown keys.** `loadLayoutSettings` rebuilds `groupPrefs` field-by-field (`terminals.js:1469`) and every key it does not name is lost on reload. `terminal-sidebar-groupings-contract.test.js:554` exists *because* a sibling feature already shipped this bug once. `autoRoleGroups` must be named in the whitelist in the same commit that adds it to the initialiser, or the toggle works all session and forgets on reload with no error anywhere.
- **The contract test pins the initialiser literal character-for-character.** `terminal-sidebar-groupings-contract.test.js:559` is `/let groupPrefs = \{ threshold: 2, hidden: \[\], pinned: \[\], orders: \{\}, layouts: \{\}, extras: \{\} \}/`. Adding a key to that line turns the test red, and the whole file is CI-gated (`npm run test:contract:terminal-sidebar-groupings`, `.github/workflows/integration-tests.yml:524`). The test must be updated in the same change — this is a deliberate tripwire, not a stale assertion, and the update should extend it to cover the new key rather than loosen it to a wildcard.
- **The overflow `»` is conditionally rendered — twice.** `terminals.js:2875` only enters the measurement block when `groupTabEls.length > 0 || hasHiddenGroups`, and the inner build at `:2894` gates *again* on `overflowing.length > 0 || hasHiddenGroups`. With role groups off and no worktree group at threshold, both are false — and the toggle that turns role grouping back on would live inside a menu that does not exist. **Both** conditions must go; satisfying only the outer one still yields no menu at zero tabs. Width is not a concern: `overflowReserved = 36` is already subtracted from `availableWidth` unconditionally (`:2880-2881`).
- **The chip is width-capped and will truncate the new suffix.** `.item-group-chip` is `max-width: 80px` with `text-overflow: ellipsis` at `font-size: 9px` (`terminals.html:866-879`). `Planners · switchboard` renders as `Planners · s…`, and two location-scoped groups therefore produce two *visually identical* chips — the operator sees the pre-fix symptom and concludes the fix did not land. The chip must render a short name and carry the full one in its `title`.
- **A dangling lock is a soft-dead panel.** `terminals.js:1575` restores the saved lock exactly once (`restoredLockOnLoad`), and `switchToGroup` early-returns on an unresolvable id (`:2419`), leaving `activeGroupId` set to a group that no longer exists: no tab renders active, `seatActiveGroupPage` early-returns (`:2447`), and the empty-pane fill (`:2650`) is inert. Turning the toggle **off** while locked to a role group produces exactly that. The in-session path is handled in the toggle handler; the reload path needs a reconcile at the restore site. **Ordering verified:** `init()` awaits `Promise.all([loadLayoutSettings(), fetchAgentNames()])` before its first `fetchTerminalList()` (`terminals.js:1218-1226`), so `groupPrefs` and `activeGroupId` are both populated when the reconcile runs. The solo path (`:1214`) fetches without loading settings, but `activeGroupId` is `null` there, so the reconcile is a no-op.
- **The reconcile must not fire on a merely-below-threshold group.** Role grouping on, operator locked to their planner pair, one planner exits between sessions → the group is absent at load but is *not* structurally unreachable. Clearing there persists `activeGroupId = null` and silently discards the lock. The predicate is "role grouping is off", not "the id starts with `dg_role_`".
- **Test-block boundaries constrain where new code may go.** Five assertions slice the file between `switchToGroup` / `seatActiveGroupPage` and `safeGroupIdForValue` (`terminal-sidebar-groupings-contract.test.js:138/154/174/179/200`), and `:609` is a *negative* assertion (`!/activeGroupId = null/` over the `seatActiveGroupPage`→`safeGroupIdForValue` slice). `block()` is a plain `indexOf` window (`:29-35`), so any helper placed between those two functions is swallowed into that slice — and a helper that clears a lock there would fail `:609` for a reason unrelated to the seating path. New helpers go **after** `safeGroupIdForValue` and **before** `getDerivedGroups`; that window is sliced by nothing (`:108` and `:124` both start *at* `function getDerivedGroups()`). For the same reason the lock reconcile belongs in the fetch path at `:1575`, not inside `seatActiveGroupPage`.
- **`locationKeyForTerminal` depends on `parentsList`, which must be populated in both hosts.** **Verified:** `bootstrap.ts:1265` calls the same `resolveParentsForTerminals` from `WorkspaceIdentityService` and returns `parents` on the payload (`:1289`), matching `TaskViewerProvider`'s `result.parents = parents` (`:2378`). `parentsList` is module state (`terminals.js:187`) filled from that same response (`:1568`), so the helper sees the same parent set in the extension host and in `npx switchboard`.
- **Worktree-derived groups are deliberately untouched.** They are location-keyed by construction (`worktreeMap` is keyed on `t.worktreePath`) and are not what the operator hit. Gating them too would be scope the report does not support.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| :--- | :--- |
| Fresh install, operator spawns 2 planners in one workspace | **No group tab, no membership chip, no lock target.** Sidebar shows two planner rows under their workspace header, as it does for a single planner. |
| Operator enables "Group by role", 2 planners in one workspace | One tab, `Planners · switchboard`, count 2. Clicking it locks and seats both. |
| Role grouping on; 2 planners in workspace A, 2 in workspace B | **Two tabs**, `Planners · switchboard` and `Planners · viaapp`, count 2 each. Neither seats the other's terminals. |
| Role grouping on; 1 planner in A, 1 in B | **No tab at all** — neither location reaches `threshold` (2). This is the intended consequence of scoping: two lone planners are not a fleet. |
| Role grouping on; 2 planners in a worktree of A, 1 in A's main checkout | One tab for the worktree pair (`Planners · feature-xyz`); the main-checkout planner is ungrouped. Worktree wins over parent in the location key, matching the sidebar's own hierarchy. |
| Terminal whose `worktreePath` **is** its `parentRoot`, or is itself a registered parent folder | Location key falls back to `parentRoot`. This mirrors `renderSidebarList`'s own `isDirect` rule (`terminals.js:3169`: `!wtPath \|\| wtPath === targetGroup.fullPath \|\| allParentFolders.has(wtPath)`), so the group strip and the sidebar tree never disagree about where a terminal lives. |
| Terminal with a `role` but no `parentRoot` and no `worktreePath` (Unmapped bucket, `terminals.js:3144`) | Location key `''`; label `unmapped`. Groups only with other unmapped same-role terminals. Never folded into a mapped location's group. |
| Two spellings of one path (trailing slash, `\` vs `/`) | Normalised to one key — `\\`→`/`, trailing `/` stripped — so a path spelling difference cannot fork one location into two tabs. Case is **not** normalised, deliberately: `renderSidebarList` compares `p.fullPath === item.parentRoot` case-sensitively, and lower-casing here would let a group and the sidebar bucket the same terminal differently. |
| Chip on a row claimed by a location-scoped role group | Chip reads the short name (`Planners`); the `title` carries the full `Member of Planners · switchboard`. Never a row of identical `Planners · s…` ellipses. |
| Operator toggles role grouping **off** while locked to a role tab | The toggle handler detects the lock no longer resolves and routes through `clearGroupLock()`, which re-seats from the live fleet honouring pins and saves. No dead strip, no inert panes. |
| Reload with role grouping **off** and a stale `activeGroupId` on a role id | The reconcile at the restore site clears the lock the same way. "All" renders active. |
| Reload with role grouping **on**, saved lock on a role tab now below threshold | The lock is **kept**, not cleared. The tab reappears the moment the location is back at threshold — same as today's behaviour for a shrinking derived group. |
| Operator deletes a location-scoped role tab (`×`) | `deleteGroup` pushes the new id into `groupPrefs.hidden`. That location stays suppressed; the same role in another location is unaffected. |
| Operator hits "restore all" in the `»` menu | `groupPrefs.hidden = []` as today. Role tabs return only if `autoRoleGroups` is on. |
| Solo mode (`?solo=`) | Unchanged. `renderGroupTabStrip` already early-returns on `soloTerminalName` (`terminals.js:2776`) and `saveSetting` no-ops in solo. |
| Delegate children | Already excluded from both the count and the membership query via `!t.parentInstanceId`; the location key is never consulted for them. `terminal-sidebar-groupings-contract.test.js:584` guards the role branch and `:588` the worktree branch — do not drop the predicate while editing. |
| Manual groups, incl. backend-registered `team_*` groups (`src/services/teamWiring.ts:485`) | Untouched. They are `source: 'manual'`, carry their own `members` array, and are named after the head — not the "Planners" producer. |

**Non-goals.** The strip's `+` (`terminals.js:2850-2859`) still opens the role picker with a `group:<id>` key and no location target. A location-scoped role tab therefore does **not** yet pre-seed the new terminal's cwd with the group's location. Separate affordance, out of scope.

## Dependencies

- None. No session dependency, no verb, no schema, no DB migration, no compat shim.

Everything touched lives in `src/webview/terminals.js` and `src/test/terminal-sidebar-groupings-contract.test.js`. `terminals.groupPrefs` is a JSON blob in the existing `config` table and the change is additive within it. No `dist/` concern (per CLAUDE.md, `src/` is the source of truth; the VSIX is rebuilt at release). Per the session directive, no compilation step is required — `terminals.js` is plain JS served verbatim to both hosts.

## Adversarial Synthesis

Key risks: (1) the consent flag can **hide its own escape hatch** — the toggle lives in an overflow menu that two separate conditions decline to render precisely when role grouping is off; (2) the location suffix **truncates in the sidebar chip** (`max-width: 80px` at 9px), so two correctly-separated groups render as identical `Planners · s…` and the fix reads as a failure; (3) the initialiser literal is a **CI-gated tripwire** (`:559`) that the obvious implementation turns red. Mitigations: both overflow gates are deleted outright (not neutralised); the chip renders a `shortName` with the full name in its `title`; the tripwire is extended to name the new key rather than loosened; and the load-time lock reconcile fires only when role grouping is off, so a merely-below-threshold group keeps its lock.

## Proposed Changes

### 1. `src/webview/terminals.js:101` — declare the consent flag

```js
// autoRoleGroups: role groups are OPT-IN. Two terminals sharing a job title is
// not evidence that the operator wants them seated together — it was enough to
// conjure a "Planners" tab, a membership chip on every planner row and a lock
// target, all unrequested, with a per-role dismissal as the only exit.
let groupPrefs = { threshold: 2, hidden: [], pinned: [], orders: {}, layouts: {}, extras: {}, autoRoleGroups: false };
```

### 2. `src/webview/terminals.js:1469` — name it in the loader whitelist

The loader rebuilds `groupPrefs` field-by-field and drops every key it does not name. One line, in the same commit as the initialiser:

```js
groupPrefs = {
    threshold: Number(savedGroupPrefs.threshold) > 1 ? Math.floor(savedGroupPrefs.threshold) : 2,
    hidden: Array.isArray(savedGroupPrefs.hidden) ? savedGroupPrefs.hidden.filter(id => typeof id === 'string') : [],
    pinned: Array.isArray(savedGroupPrefs.pinned) ? savedGroupPrefs.pinned.filter(id => typeof id === 'string') : [],
    orders: (savedGroupPrefs.orders && typeof savedGroupPrefs.orders === 'object') ? savedGroupPrefs.orders : {},
    layouts: savedLayouts,
    extras: savedExtras,
    // Opt-in and stays opt-in: absent or non-true reads as false.
    autoRoleGroups: savedGroupPrefs.autoRoleGroups === true
};
```

### 3. `src/webview/terminals.js` — new helpers, placed AFTER `safeGroupIdForValue` and BEFORE `getDerivedGroups`

Placement is load-bearing: five contract assertions slice the file between `switchToGroup`/`seatActiveGroupPage` and `safeGroupIdForValue`, one of them a negative match on `activeGroupId = null`. The window *after* `safeGroupIdForValue` and *before* `getDerivedGroups` is sliced by nothing.

```js
/** Normalise a path for keying: `\` → `/`, trailing slashes stripped. Case is
 *  deliberately preserved — renderSidebarList compares parentRoot exactly, and
 *  a case-folding key here would bucket a terminal differently from the tree. */
function normalizeLocationPath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * A terminal's physical location: its worktree if it has one, else the parent
 * workspace it was spawned under. Both fields are stamped by both hosts
 * (TaskViewerProvider.ts:2381, bootstrap.ts:1281) and are the same two fields
 * renderSidebarList buckets the tree by.
 *
 * The worktree is only treated as a distinct location when the sidebar treats
 * it as one: renderSidebarList (:3169) files a terminal as `direct` under its
 * parent when worktreePath IS the parent root or is itself a registered parent
 * folder. Mirroring that rule is what stops the group strip and the sidebar
 * tree from telling two different stories about the same terminal.
 */
function locationKeyForTerminal(t) {
    const parentRoot = normalizeLocationPath(t && t.parentRoot);
    const wt = normalizeLocationPath(t && t.worktreePath);
    if (!wt || wt === parentRoot) { return parentRoot; }
    const registeredParents = new Set(
        (Array.isArray(parentsList) ? parentsList : [])
            .map(p => normalizeLocationPath(p && p.parentFolder))
            .filter(Boolean)
    );
    return registeredParents.has(wt) ? parentRoot : wt;
}

/** Basename of a location key, for the group label. Matches renderSidebarList. */
function locationLabelForKey(key) {
    if (!key) { return 'unmapped'; }
    const parts = String(key).split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : key;
}
```

> **Superseded:** `locationKeyForTerminal` returned `(t.worktreePath || t.parentRoot)` normalised — worktree unconditionally wins over parent.
> **Reason:** `renderSidebarList` does **not** treat every `worktreePath` as a separate location. Its `isDirect` test at `terminals.js:3169` is `!wtPath || wtPath === targetGroup.fullPath || allParentFolders.has(wtPath)` — a terminal whose `worktreePath` equals its parent root, or equals *another registered parent folder*, is rendered as a direct child of its `parentRoot` bucket. An unconditional worktree-wins key files that terminal into a group for a location the sidebar says it is not in, reintroducing the "the group disagrees with where the terminal lives" defect this plan exists to remove, in a rarer shape.
> **Replaced with:** the `locationKeyForTerminal` above, which falls back to `parentRoot` when `worktreePath` is the parent root or is itself a registered parent folder. `parentsList` is module state (`terminals.js:187`) populated from the same `ptyListTerminals` response that fills `fleetList` (`:1568`), in **both** hosts (`TaskViewerProvider.ts:2378`, `bootstrap.ts:1289`) — verified, not assumed.

### 4. `src/webview/terminals.js:2473 getDerivedGroups()` — gate on consent, key on location

```js
function getDerivedGroups() {
    const threshold = groupPrefs.threshold;
    const hidden = new Set(groupPrefs.hidden);
    const live = fleetList.filter(t => t.status !== 'exited' && !t.parentInstanceId);
    const roleMap = new Map();
    const worktreeMap = new Map();
    for (const t of live) {
        // Role is a job title, not a team and not a place. Two planners in two
        // different checkouts are two agents doing two jobs — keying on role
        // alone seated them into one grid and named the result "Planners".
        if (t.role) {
            const loc = locationKeyForTerminal(t);
            const key = t.role + '@' + loc;
            const entry = roleMap.get(key) || { role: t.role, loc, count: 0 };
            entry.count++;
            roleMap.set(key, entry);
        }
        if (t.worktreePath) { worktreeMap.set(t.worktreePath, (worktreeMap.get(t.worktreePath) || 0) + 1); }
    }
    const derived = [];
    // Opt-in. Worktree groups below stay automatic: they are location-keyed by
    // construction and describe a place the operator chose to create.
    if (groupPrefs.autoRoleGroups) {
        for (const { role, loc, count } of roleMap.values()) {
            if (count >= threshold) {
                const label = (role.charAt(0).toUpperCase() + role.slice(1)) + 's';
                // Always suffixed, never conditionally: a name that flips when a
                // planner appears in another workspace is a name the operator
                // cannot learn.
                derived.push({
                    id: safeGroupIdForValue('role', role + '@' + loc),
                    name: label + ' · ' + locationLabelForKey(loc),
                    shortName: label,
                    source: 'role',
                    value: role,
                    role,
                    location: loc
                });
            }
        }
    }
    for (const [wt, count] of worktreeMap) { /* unchanged */ }
    return derived.filter(g => !hidden.has(g.id));
}
```

`value` is retained as the bare role so nothing downstream that reads `group.value` changes meaning; `role` + `location` are the new membership predicate; `shortName` is what the width-capped sidebar chip renders (Proposed Change 7). The `hidden` filter stays a plain `hidden.has(g.id)` — with no legacy ids in existence there is nothing to alias.

The two existing assertions over this block still hold: `:107` requires `source: 'role'` and `source: 'worktree'` to be emitted and no `source: 'project'`; `:123` requires `groupPrefs.threshold` and `groupPrefs.hidden` to be read. All four survive. **Verified.**

### 5. `src/webview/terminals.js:2548` — membership must match the key

```js
} else if (group.source === 'role') {
    // Same predicate as getDerivedGroups: role AND location. Filtering on role
    // alone is what unioned every workspace's planners into one group.
    names = fleetList
        .filter(t => t.status !== 'exited'
            && !t.parentInstanceId
            && t.role === group.value
            && locationKeyForTerminal(t) === group.location)
        .map(t => t.friendlyName);
}
```

`!t.parentInstanceId` stays — `terminal-sidebar-groupings-contract.test.js:584` requires it in the role branch (and `:588` in the worktree branch).

> **Superseded:** the predicate carried a `(group.location === undefined || …)` escape so that a persisted `source: 'role'` record in `terminals.groups` — a shape `loadLayoutSettings:1435` still admits — would resolve on role alone rather than to empty.
> **Reason:** Nothing writes that shape (`saveSelectionAsGroup:2383` and `teamWiring.ts:485` both write `'manual'`), and `terminals.groups` is unreleased state one commit old, so no such record can exist on disk either. The clause guards a case that is unreachable in both directions — dead defensiveness that widens the predicate the plan exists to narrow.
> **Replaced with:** the straight `locationKeyForTerminal(t) === group.location` above.

### 6. `src/webview/terminals.js:2874` — always offer the overflow menu, and put the toggle in it

Both gates must go. Replace the outer `if (groupTabEls.length > 0 || hasHiddenGroups) {` with an unconditional block, and delete the inner `if (overflowing.length > 0 || hasHiddenGroups) {` likewise:

```js
const hasHiddenGroups = Array.isArray(groupPrefs.hidden) && groupPrefs.hidden.length > 0;
// The » menu now also carries the role-grouping toggle, so it must be reachable
// when there are no tabs at all — otherwise the only control that turns role
// groups back on lives inside a menu that role groups being off has hidden.
// Both the measurement gate and the build gate are therefore unconditional;
// overflowReserved (36px) is already subtracted unconditionally above, so the
// » costs no layout that was not already budgeted.
{
    const stripWidth = tabRow.clientWidth;
    const addBtnWidth = addBtn.offsetWidth;
    const overflowReserved = 36;
    const availableWidth = stripWidth - addBtnWidth - overflowReserved;

    let usedWidth = allTab.offsetWidth + 2;
    const overflowing = [];
    for (const item of groupTabEls) {
        const w = item.el.offsetWidth + 2;
        if (usedWidth + w <= availableWidth) {
            usedWidth += w;
        } else {
            overflowing.push(item);
        }
    }

    /* …unchanged body: remove overflowing tabs, build overflowContainer,
       overflowBtn, menu, the per-overflow menu items, the divider, and the
       restore-all entry — all previously nested inside the removed gate… */
}
```

> **Superseded:** `if (true) { … if (overflowing.length > 0 || hasHiddenGroups || true) { /* build the menu */ } }`
> **Reason:** `if (true)` and `|| true` are pseudocode, not code. Left as written they ship as dead tautologies that a linter flags and a future reader cannot distinguish from a bug, and they leave the original conditions visible and misleading. The prose also named only one gate ("the condition must admit the toggle"), so a coder fixing `:2875` alone still gets no `»` at zero tabs.
> **Replaced with:** the bare block above — both gates deleted outright, the measurement and build bodies preserved verbatim. Note for the coder: the attach-before-measure ordering is a contract (`terminal-sidebar-groupings-contract.test.js:327-341` asserts `groupTabStripEl.appendChild(tabRow)` precedes the `tabRow.clientWidth` read), and `appendChild` already happens at `:2867`, above this block. Do not move the measurement.

Inside the menu, above the existing "N deleted groups — restore all" entry (`:2939`):

```js
const roleToggle = document.createElement('div');
roleToggle.className = 'group-tab-overflow-item';
roleToggle.textContent = groupPrefs.autoRoleGroups
    ? 'Group by role: on — click to stop'
    : 'Group by role: off — click to group same-role terminals per workspace';
roleToggle.title = 'When on, terminals sharing a role IN THE SAME workspace or worktree get a group tab. Roles never span locations.';
roleToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    groupPrefs.autoRoleGroups = !groupPrefs.autoRoleGroups;
    // Turning it off strands a lock on a group that no longer exists: no tab
    // renders active and the empty-pane fill goes inert. Drop it here, where
    // clearGroupLock also re-seats the grid and saves.
    const stillExists = getAllGroups().some(g => g.id === activeGroupId);
    if (activeGroupId && !stillExists) { clearGroupLock(); }
    else { saveLayoutSettings(); renderSidebarList(); }
});
menu.appendChild(roleToggle);
```

`renderSidebarList()` is sufficient to repaint the strip: it calls `renderGroupTabStrip()` unconditionally for the non-solo case (`terminals.js:3123-3125`), and `clearGroupLock()` ends with `renderSidebarList()` too (`:2374`). **Verified** — no separate `renderGroupTabStrip()` call is needed, and adding one would double-render.

`e.stopPropagation()` is required: the menu installs a document-level outside-click closer (`:2959`), and the restore-all entry beside it already stops propagation for the same reason.

No confirm gate — per CLAUDE.md, and `window.confirm` is a silent no-op in a VS Code webview regardless.

### 7. `src/webview/terminals.js:2088` — the chip renders the short name

```js
const claimingGroup = findGroupForTerminalName(item.friendlyName);
if (claimingGroup) {
    const groupChip = document.createElement('span');
    groupChip.className = 'item-group-chip';
    // .item-group-chip is max-width:80px / ellipsis at 9px (terminals.html:866).
    // A location-scoped role group's full name ("Planners · switchboard")
    // truncates to "Planners · s…", so two DIFFERENT groups render identical
    // chips — the operator reads that as the bug still being present. The chip
    // names the group; the title names the location.
    groupChip.textContent = claimingGroup.shortName || claimingGroup.name;
    groupChip.title = `Member of ${claimingGroup.name}`;
    roleRow.appendChild(groupChip);
}
```

Only `shortName` is new; derived worktree groups and manual groups have none and fall through to `name` exactly as today. `terminal-sidebar-groupings-contract.test.js:343-357` pins `groupChip.className = 'item-group-chip'`, the `findGroupForTerminalName(item.friendlyName)` resolution, and the `.item-group-chip` CSS rule — all three are preserved. **Verified.**

### 8. `src/webview/terminals.js:1575` — reconcile a lock left on a role group that consent has removed

```js
if (!restoredLockOnLoad && activeGroupId) {
    restoredLockOnLoad = true;
    const savedId = String(activeGroupId);
    if (getAllGroups().some(g => g.id === savedId)) {
        switchToGroup(savedId, { noSave: true });
    } else if (!groupPrefs.autoRoleGroups && savedId.startsWith('dg_role_')) {
        // Role grouping is off, so getDerivedGroups emits no role tab at all and
        // this id can never resolve. switchToGroup would early-return and leave
        // the panel soft-dead: no active tab, an inert seatActiveGroupPage, and
        // a dead empty-pane fill. clearGroupLock re-seats from the live fleet
        // honouring pins, and saves.
        //
        // Deliberately NOT "any unresolved dg_role_ id": with role grouping ON,
        // an absent group means the location is merely below threshold, and
        // clearing there would persist activeGroupId = null and discard a lock
        // that the next spawn would have restored.
        clearGroupLock();
    }
}
```

Manual (`grp_*`) and worktree (`dg_worktree_*`) locks never enter this branch, so the "a locked group survives a shrinking membership" behaviour is untouched. Placement is in the fetch path, not in `seatActiveGroupPage`: `:609` is a negative assertion (`!/activeGroupId = null/`) over the `seatActiveGroupPage`→`safeGroupIdForValue` slice, and `clearGroupLock` assigns exactly that.

### 9. `src/test/terminal-sidebar-groupings-contract.test.js` — extend the contract

Update `:559` (it must stay an exact-literal tripwire, not become a wildcard):

```js
assert.ok(
    /let groupPrefs = \{ threshold: 2, hidden: \[\], pinned: \[\], orders: \{\}, layouts: \{\}, extras: \{\}, autoRoleGroups: false \}/.test(terminalsJs),
    'the initialiser must carry layouts, extras and the autoRoleGroups consent flag'
);
```

Extend the loader assertion in the same test (`:562` builds the `loader` slice):

```js
assert.ok(
    /autoRoleGroups: savedGroupPrefs\.autoRoleGroups === true/.test(loader),
    'the loader whitelist must name autoRoleGroups, or the toggle forgets on reload with no error'
);
```

Add three tests:

```js
test('role groups are opt-in and never span a workspace or worktree', () => {
    const derived = block(terminalsJs, 'function getDerivedGroups()', 'function getAllGroups()');
    assert.ok(
        /if \(groupPrefs\.autoRoleGroups\)/.test(derived),
        'the role arm must be gated on consent — a second planner must not conjure a "Planners" tab'
    );
    assert.ok(
        derived.includes('locationKeyForTerminal(t)') && /role \+ '@' \+ loc/.test(derived),
        'the role key must carry a location component, or two workspaces\' planners become one group'
    );
    const worktreeArm = derived.slice(derived.indexOf('worktreeMap'));
    assert.ok(
        !/autoRoleGroups/.test(worktreeArm),
        'worktree groups stay automatic — they are location-keyed by construction and were not the complaint'
    );
});

test('the role membership query filters on location, not role alone', () => {
    const fn = block(terminalsJs, 'function getGroupMembers(group) {', 'function orderGroupMembers(');
    const roleBranch = fn.slice(fn.indexOf("group.source === 'role'"), fn.indexOf("group.source === 'worktree'"));
    assert.ok(
        roleBranch.includes('locationKeyForTerminal(t) === group.location'),
        'membership must use the same role+location predicate getDerivedGroups keys on'
    );
    assert.ok(
        roleBranch.includes('!t.parentInstanceId'),
        'delegate children stay excluded'
    );
});

test('the role-grouping toggle is reachable with no group tabs on screen', () => {
    // The » menu is the ONLY control that turns role grouping back on. It used
    // to be built solely when there were tabs or hidden groups — both false in
    // exactly the state the toggle exists to escape.
    const strip = block(terminalsJs, 'function renderGroupTabStrip() {', 'function terminalNameSuffix(');
    assert.ok(
        strip.includes('Group by role'),
        'the strip must carry the role-grouping toggle'
    );
    assert.ok(
        !/if \(groupTabEls\.length > 0 \|\| hasHiddenGroups\)/.test(strip),
        'the overflow measurement must not be gated on there being tabs — the toggle lives inside it'
    );
    assert.ok(
        !/if \(overflowing\.length > 0 \|\| hasHiddenGroups\)/.test(strip),
        'the overflow BUILD must not be gated either — the outer gate alone still yields no menu at zero tabs'
    );
    assert.ok(
        !/if \(true\)|\|\| true/.test(strip),
        'no tautological gate left behind — delete the condition, do not neutralise it'
    );
});

test('a load-time lock is dropped only when consent has removed its group', () => {
    const fetchBlock = block(terminalsJs, 'async function fetchTerminalList()', 'function checkSoloNotFound()');
    assert.ok(
        /restoredLockOnLoad[\s\S]{0,700}clearGroupLock\(\)/.test(fetchBlock),
        'a role lock that consent has made unreachable must be cleared at the restore site, not left to soft-kill the panel'
    );
    assert.ok(
        /!groupPrefs\.autoRoleGroups && savedId\.startsWith\('dg_role_'\)/.test(fetchBlock),
        'the reconcile must fire only when role grouping is OFF — a merely below-threshold group keeps its lock'
    );
});
```

## Verification Plan

### Automated Tests

1. `npm run test:contract:terminal-sidebar-groupings` — the file is a plain `node` script (`package.json:921`, wired into CI at `.github/workflows/integration-tests.yml:524`) and exits non-zero on any failure. All existing assertions plus the four new/extended ones must pass.

> **Superseded:** `npx tap src/test/terminal-sidebar-groupings-contract.test.js` (or the repo's configured node test runner for `src/test/`)
> **Reason:** the repo does not use tap. The file is a self-running script with its own `test()`/`assert` harness and a `process.exit(1)` summary (`:19-27`, `:744-748`), invoked as `node --require ./src/test/bootstrap/sandboxStateHome.js <file>`. The hedged "or the repo's configured runner" wording left the coder to rediscover this.
> **Replaced with:** `npm run test:contract:terminal-sidebar-groupings`.

2. Confirm the tripwire still bites: temporarily remove `autoRoleGroups: false` from the initialiser and re-run — `:559` must fail. If it stays green, the assertion was loosened rather than extended.
3. Run the wider `src/test/` contract suite and diff the failure set against a stashed baseline (`git stash && <runner> && git stash pop`). This repo carries known-red tests at HEAD, so the gate is "no *new* failures", not "all green".
4. `node --check src/webview/terminals.js` — it is plain JS, so the parse check is meaningful here. No compilation step is required or in scope (session directive; `terminals.js` is served verbatim by both hosts).

**Manual — fresh behaviour (the reported bug)**

5. Reload the Terminals panel. (No DB seeding needed — `autoRoleGroups` is absent from every stored `groupPrefs` and reads as `false`.)
6. Spawn planner #1, then planner #2, in the same workspace. **Expected: no "Planners" tab in the strip, no `Planners` chip on either sidebar row, "All" stays the active tab.** This is the exact repro.
7. Open the `»` menu → confirm "Group by role: off" is present and reachable *with no group tabs on screen* (the two-gate conditional-render trap).

**Manual — location scoping**

8. Toggle "Group by role: on". Confirm one tab appears, labelled `Planners · <workspace-basename>`, count 2. Click it — both planners seat, nothing else does.
9. Confirm the sidebar chip on each planner row reads `Planners` (not a truncated `Planners · s…`) and its tooltip reads `Member of Planners · <workspace-basename>`.
10. Spawn 2 planners in a **second** workspace (use the per-workspace `+` on that workspace's sidebar header so `parentRoot` is set). **Expected: a second tab, `Planners · <other-basename>`, count 2. The first tab's count stays 2.** Click each — neither seats the other's terminals.
11. Create a worktree, spawn 2 planners inside it. Expected a third tab labelled with the worktree basename; the parent workspace's planner tab is unaffected. Cross-check the sidebar: the same two terminals must appear under that worktree's sub-header, not under the parent — group and tree must agree.
12. Reduce workspace B to 1 planner. Its tab disappears (below threshold); workspace A's tab is untouched.

**Manual — consent and lock reconcile**

13. Lock onto a role tab, then toggle "Group by role: off" from the `»` menu. **Expected: the tab vanishes, "All" renders active, the grid re-seats from the live fleet, and clicking an empty pane still fills it** — not a strip with no active tab and dead panes.
14. Reload with role grouping off and a stale role id still in `terminals.activeGroupId` (`sqlite3 <kanban.db> "SELECT value FROM config WHERE key='terminals.activeGroupId';"` to confirm it was persisted before the toggle). **Expected: same as 13 — the reconcile clears it on the first fleet fetch.**
15. With role grouping ON and a lock saved on a role tab, exit one of its two planners and reload. **Expected: the lock is KEPT** (`terminals.activeGroupId` still set); the tab reappears the moment a second planner is spawned in that location. This is the case the narrowed reconcile exists to protect.

**Both hosts**

16. Repeat steps 6–10 in the standalone browser cockpit (`http://localhost:<api-server-port>` Terminals page). One file serves both hosts via `headlessPanelHtml.ts:400`, so behaviour must be identical; verify against the live server rather than assuming, and note the served bundle is the installed VSIX's `dist/` — rebuild or point the server at the edited `src/` before trusting the result.

---

**Recommendation: Send to Coder.**
