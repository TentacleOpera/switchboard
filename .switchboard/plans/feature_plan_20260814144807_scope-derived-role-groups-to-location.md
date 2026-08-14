# Stop the auto-created "Planners" group from spanning workspaces and worktrees

## Goal

Make the terminals panel stop materialising a cross-workspace `Planners` tab every time a second planner terminal is spawned, and make the delete `×` on a role-derived group mean "stop deriving this role" rather than "hide one id until the next workspace".

### The reported behaviour

1. Spawning a planning agent causes a group named **Planners** to appear, unrequested, over and over.
2. That group's membership pulls in planner terminals that live in **different parent workspaces and different worktrees** — terminals the operator considers unrelated.

### Root cause

Both come from one function: `getDerivedGroups()` in `src/webview/terminals.js:2473`.

```js
const live = fleetList.filter(t => t.status !== 'exited' && !t.parentInstanceId);
const roleMap = new Map();
for (const t of live) {
    if (t.role) { roleMap.set(t.role, (roleMap.get(t.role) || 0) + 1); }
    if (t.worktreePath) { worktreeMap.set(t.worktreePath, (worktreeMap.get(t.worktreePath) || 0) + 1); }
}
for (const [role, count] of roleMap) {
    if (count >= threshold) {
        derived.push({
            id: safeGroupIdForValue('role', role),
            name: (role.charAt(0).toUpperCase() + role.slice(1)) + 's',
            source: 'role',
            value: role
        });
    }
}
```

Three separate facts compose into the complaint:

- **The count is global.** `fleetList` is the *whole* pty fleet — every parent folder the host has mapped, plus every worktree under each. The role tally is taken over that whole list with no `parentRoot` and no `worktreePath` predicate, so two planners anywhere in the fleet cross the threshold together. That is complaint (2) exactly.
- **The threshold is 2 and has no UI.** `groupPrefs = { threshold: 2, ... }` (`terminals.js:101`) — the loader will honour a stored value above 1 (`terminals.js:1470`), but nothing in the panel ever writes one. So the *second* planner always trips derivation. That is complaint (1)'s trigger.
- **Membership repeats the same global query.** `getGroupMembers()`'s role branch (`terminals.js:2549`) is `fleetList.filter(t => ... && t.role === group.value)` — also unscoped, so the group's members and its tab count agree with each other and disagree with the sidebar hierarchy directly above them, which *is* scoped (parent → worktree → terminals, built at `terminals.js:3155-3183` off `item.parentRoot` and `item.worktreePath`).

The scoping key is already on the wire. `ptyListTerminals` attaches `parentRoot: parentMap.get(t.cwd) ?? null` per terminal in both hosts (`src/services/TaskViewerProvider.ts:2381`, `src/standalone/bootstrap.ts:1281`) alongside `worktreePath`. The webview simply never consults it when deriving role groups. The backend already models this concept under the name **location key** — `getRoleTerminalSet()` (`TaskViewerProvider.ts:6048`) resolves a role's terminals to `worktreePath || workspaceRoot` precisely so "the same set of terminals yields the same key regardless of how many Switchboard workspaces dispatch to it". The webview's derivation is the one place that never adopted it.

### Why deleting it does not stick

`deleteGroup()` (`terminals.js:2276`) suppresses a derived group by pushing its **id** into `groupPrefs.hidden`. `groupPrefs` is persisted through `saveSetting('terminals.groupPrefs', …)` → `POST /kanban/verb/saveSetting` → the **per-workspace `kanban.db` config table**. So the suppression of `dg_role_planner` is scoped to one workspace's database while the group it suppresses is derived from a fleet that spans all of them: delete it in workspace A, open the panel served by workspace B, and it is back. The operator experiences that as "it keeps getting created".

### The fix, in one sentence

Derive role groups **per location** (`worktreePath || parentRoot`), give them ids and labels that say which location they are, apply the same predicate to their membership — and make the delete `×` on a role group record the *role* as suppressed, so one click ends the auto-derivation for every location this panel serves instead of hiding one id.

> **Superseded:** "…so one click ends the auto-derivation **for good** instead of hiding one id."
> **Reason:** Over-claims the fix's reach. The `role:<role>` sentinel rides in `groupPrefs.hidden`, which is persisted to the **per-workspace** `kanban.db` config table — the same store the root-cause section above correctly identifies as the reason an id-keyed suppression does not travel. The sentinel makes the delete stick across *locations* and across *reloads*; it does not and cannot make it stick across *workspace databases*.
> **Replaced with:** "…so one click ends the auto-derivation for every location **this panel serves** instead of hiding one id." The cross-workspace boundary is stated explicitly under "What this plan does not do".

### What this plan does not do (deliberate scope decisions)

- **No threshold UI.** The root-cause analysis names "threshold is 2 with no UI" as one of the three composing facts. It is deliberately *not* fixed here: a threshold control treats the symptom (raise it to 3, and three planners in three repos still conjure a tab) and adds a settings surface for a preference the operator has already told us they want set to "never". The delete `×` + role sentinel **is** the off switch, and it is one click. If a future operator wants role groups at a higher count, that is a separate plan.
- **No cross-workspace preference store.** Every `groupPrefs` field (threshold, hidden, pinned, orders, layouts, extras) and `terminals.activeGroupId` are per-workspace panel preferences by construction. The role sentinel joins them, consistently. Making group suppression global would mean a new global config home for webview prefs — a materially larger change with its own migration, and out of scope for a bug fix. Consequence to accept: after this change, an operator with two Switchboard workspaces who deletes `Planners` in workspace A's panel and later opens workspace B's panel can still see a `Planners` tab there — but only if B has **two planners in one location**, which is the case the feature was designed for. The reported cross-workspace case is gone regardless of suppression.

## Metadata

- **Complexity:** 6
- **Tags:** bugfix, ui, frontend
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 5
> **Reason:** The improve pass found four additional edit sites the original scoping did not account for (extras add/remove mutation paths at `terminals.js:2657` and `terminals.js:4337`, the `hidden.length` count label at `terminals.js:2942`, and a shipped contract assertion the proposed extras read would have turned red). The change is still single-file, but it now touches six shipped persistence read/write pairs whose read and write sides must stay symmetric — that is a 6, not a 5.
> **Replaced with:** **Complexity:** 6

## User Review Required

- None. Every decision in this plan is made: location key = `worktreePath || parentRoot` with the sidebar's `isDirect` carve-out; suppression sentinel rides inside the shipped `hidden` array; no threshold UI; suppression stays per-workspace. The one judgement an operator might disagree with — "deleting one location's `Planners` tab kills the role's derivation in every location" — is the literal reading of the report ("it keeps getting created"), is reversible in one click via `restore all`, and is called out in the Edge-Case table.

## Complexity Audit

### Routine

- Adding a location predicate to two `fleetList` filters.
- Building a composite derived-group id and a disambiguating label.
- Reusing the existing `restoredLockOnLoad` one-shot for the stale-lock adoption instead of introducing a second flag.
- Updating the five assertions in `src/test/terminal-sidebar-groupings-contract.test.js` that pin the shapes being changed.

### Complex / Risky

- **Derived-group ids are persistence keys.** `groupPrefs.hidden`, `.pinned`, `.orders`, `.layouts` and `.extras` are all keyed by group id, and `terminals.activeGroupId` stores one. Changing `dg_role_planner` → `dg_role_<location>_planner` orphans every one of those entries on an existing install. This state shipped, so per the workspace migration rule it must be read-compatible, not rewritten. Handled by a read-side legacy fallback (below), never by a destructive key rewrite.
- **A read-side fallback creates a read/write asymmetry wherever a map is *mutated* rather than *replaced*.** `layouts` and `orders` are whole-value writes, so read-prefers-scoped is coherent. `extras` is push/filter-mutated at two sites (`terminals.js:2657`, `terminals.js:4337`) — a fallback read plus a scoped-only write means "remove from pane" filters an array that does not exist and the removed name re-unions from the legacy entry on the next read, silently. The extras path therefore reads *both* keys and filters *both* keys.
- **The lock can point at an id that no longer derives.** If `activeGroupId === 'dg_role_planner'` at load, `switchToGroup`'s `getAllGroups().find()` returns nothing and the panel loads locked to a group that does not exist. `seatActiveGroupPage()` early-returns on `!group`, so the grid keeps whatever `paneAssignments` was saved — no crash, but the "All" tab renders inactive with no tab highlighted. Needs an explicit adopt-or-drop at load.
- **`groupPrefs.hidden` is a shipped key with a contract test** (`terminal-sidebar-groupings-contract.test.js:520` — "renaming it would orphan every existing suppression"). The role suppression must ride *inside* `hidden` as a `role:<role>` sentinel, not in a new field, so restore-all keeps working and no new prefs key needs a loader whitelist entry.
- **The `groupPrefs` initialiser is asserted verbatim** by a regex at `terminal-sidebar-groupings-contract.test.js:559`. Any new key in that object literal turns that test red. Avoided entirely by not adding a key.
- **`groupPrefs.hidden` is also a user-visible *count*.** `renderGroupTabStrip` renders `${groupPrefs.hidden.length} deleted group…` (`terminals.js:2942`). Pushing both an id and a sentinel for one delete makes one click read as "2 deleted groups".
- **The composite `(location, role)` key is built from a filesystem path.** Any separator that can occur in a path silently corrupts the split. macOS parent folders with spaces are ordinary.

## Edge-Case & Dependency Audit

**Race Conditions**

- The stale-lock adoption must run *after* `fleetList` is populated (there are no terminals to match against before the first poll) and *before* the first render. The existing `restoredLockOnLoad` one-shot at `terminals.js:1575` already sits at exactly that point, between the `fleetList = data.terminals` assignment and `sanitizePaneAssignments()`/`renderSidebarList()`. Reusing it means there is one one-shot with one ordering, not two flags whose relative order is undefined.
- `renderSidebarList()` rebuilds the strip on every 5s fleet poll and every `terminalsChanged` push. Derivation is pure over `fleetList` + `groupPrefs`, so a poll landing mid-interaction re-derives the same set; no new race.

**Security**

- No new input surface. `location` is derived from `parentRoot`/`worktreePath`, both already server-supplied and already rendered as sidebar labels. Ids pass through `safeGroupIdForValue`, which strips everything outside `[A-Za-z0-9_]`. Labels are set via `textContent`, never `innerHTML`.

**Side Effects**

- Group ids change shape for role groups. Anything persisting an id (`hidden`, `pinned`, `orders`, `layouts`, `extras`, `activeGroupId`) sees a new key on the next write. Handled by read-side fallback + lock adoption; no stored key is deleted or rewritten.
- Tab labels gain a `· <basename>` suffix when a role occupies more than one location. `sortGroups` sorts on `name`, so ordering follows the suffix — intended.

**Dependencies & Conflicts**

- `parentRoot` must be present on fleet entries. Verified in both hosts (`TaskViewerProvider.ts:2381`, `bootstrap.ts:1281`) and asserted by `src/test/multi-parent-terminals-contract.test.js:187`. No host change needed.
- Derivation is confined to `src/webview/terminals.js` — `getDerivedGroups`/`dg_role` appear in no other source file, so no other panel or the multi-window shell recomputes groups. `postFleetStateToShell()` ships the raw fleet, not groups.
- No backend, API, schema or migration change.

| Case | Behaviour after the change |
| --- | --- |
| Two planners in the same worktree | One `Planners` group, as today. |
| Two planners in the same parent, neither in a worktree | One `Planners` group scoped to that parent. |
| One planner in parent A, one in parent B | **No group** — neither location reaches the threshold. This is the reported bug's core case. |
| One planner in the main checkout, one in a worktree of the same parent | **No group** — a worktree is a distinct location (matches `getRoleTerminalSet`'s rule and the sidebar hierarchy). |
| Two planners in parent A *and* two in parent B | Two tabs, labelled `Planners · <A basename>` and `Planners · <B basename>`. |
| Only one location has the role | Bare `Planners` — no suffix noise when there is nothing to disambiguate. |
| `parentRoot` is null (unmapped terminal) | Location key is `''`; unmapped terminals group only with other unmapped ones, mirroring the sidebar's `unmappedGroup` bucket. |
| A parent folder whose path contains a space (`/Users/pat/My Repos/x`) | Correct — the `(location, role)` key is joined on `\u0000`, which cannot occur in a path. A space separator would have split the key mid-path and produced a group whose `value` was a path fragment. |
| `worktreePath` equals the terminal's own `parentRoot`, or equals another *mapped parent folder* | Location key is the **parent**, not the worktree path — mirroring the sidebar's `isDirect` rule (`terminals.js:3170`: `!wtPath \|\| wtPath === targetGroup.fullPath \|\| allParentFolders.has(wtPath)`), which renders such a terminal as a direct child of its parent rather than under a worktree sub-header. |
| Delegate children | Already excluded by `!t.parentInstanceId` in both the derivation and the membership branches; unchanged. |
| Hidden autoban planner PTYs | Not in `fleetList` (`ptyListTerminals` returns them under `hiddenTerminals`), so they never contributed to the tally and still do not. |
| Existing install with `hidden: ['dg_role_planner']` | The legacy id is still consulted, so every scoped planner group stays suppressed. No re-appearance on upgrade. |
| Existing install with `layouts['dg_role_planner']` / `orders['dg_role_planner']` | Read falls back to the legacy id when no scoped entry exists, so the stored layout and member order survive the first switch; the next write lands under the scoped id. |
| Existing install with `extras['dg_role_planner']` | Read unions **both** keys; "remove from pane" filters **both** keys. Nothing is deleted from storage, so a downgrade still finds the legacy entry. |
| Existing install locked to `activeGroupId: 'dg_role_planner'` | The existing `restoredLockOnLoad` one-shot re-points the lock at the scoped group whose members are live, else drops the lock cleanly. |
| Operator deletes `Planners · repoA` while `Planners · repoB` exists | Both go, and no planner group derives again **in this workspace's panel**. This is the intended reading of the complaint ("stop creating it"); the strip's `N deleted groups — restore all` entry brings them back. |
| The strip's deleted-group count after one role delete | Reads `1 deleted group` — a role delete stores the sentinel *instead of* the id, not in addition to it. |
| Two locations whose paths differ only in characters `safeGroupIdForValue` flattens (`/a/b-c` vs `/a/b_c`) | Both encode to the same id, so they would share suppression/layout/extras state and render as one tab. Pre-existing property of `safeGroupIdForValue` (worktree groups already embed a full path in an id the same way); accepted, not fixed here. |
| Worktree-derived groups | Untouched — `worktreePath` is already a location, so those groups were never cross-workspace. |
| Manual groups | Untouched — `source: 'manual'`, explicit member list, no derivation. |
| Backend-registered team groups (`teamWiring.ts:484`) | Untouched — they are `source: 'manual'` named after the head terminal, not role-derived. |

## Dependencies

- None — no upstream session dependencies. This plan is self-contained in `src/webview/terminals.js` and its contract test.

## Adversarial Synthesis

**Risk Summary.** The three real risks are all *persistence-key* risks, not logic risks: (1) the derived-group id is the key for five shipped `groupPrefs` maps plus the saved lock, so changing its shape orphans stored state — mitigated by read-side legacy fallback on every read path and an adopt-or-drop for the lock, with zero stored keys deleted or rewritten; (2) a fallback read paired with a scoped-only write silently breaks the one map that is *mutated* rather than replaced (`extras`), so that path reads both keys and filters both keys; (3) the `(location, role)` composite is built from a filesystem path, so it is joined on `\u0000` rather than a space, which a macOS folder name can contain. Secondary risk: the fix's scoping addresses complaint (2) but complaint (1) — "a group I never asked for" — is carried entirely by the delete sentinel, which is per-workspace like every other panel preference; that boundary is stated rather than papered over.

## Proposed Changes

### 1. `src/webview/terminals.js` — location helpers next to `safeGroupIdForValue` (~line 2468)

Placed **before** `getDerivedGroups()` so they stay outside the `block(terminalsJs, 'function getDerivedGroups()', 'function getAllGroups()')` slice the contract test asserts against.

```js
    function safeGroupIdForValue(source, value) {
        const encoded = encodeURIComponent(String(value || '')).replace(/[^a-zA-Z0-9_]/g, '_');
        return 'dg_' + source + '_' + encoded;
    }

    /**
     * Separator for the (location, role) composite key. A filesystem path can
     * contain a space, a dash, a colon and a pipe; it cannot contain NUL. Any
     * printable separator would split a key mid-path on a folder like
     * "/Users/pat/My Repos/x" and yield a group whose `value` was a path
     * fragment instead of a role.
     */
    const LOC_SEP = '\u0000';

    /**
     * The physical location a terminal lives in: its worktree if it has one,
     * else its parent folder. Mirrors getRoleTerminalSet's locationKey in
     * TaskViewerProvider.ts — the same set of terminals must resolve to the
     * same key no matter which workspace's panel is looking at them. An
     * unattributed terminal resolves to '' and groups only with its own kind,
     * matching the sidebar's Unmapped bucket.
     *
     * The two carve-outs mirror renderSidebarList's `isDirect` rule
     * (terminals.js:3170). A worktreePath that IS the terminal's parent, or
     * that is itself a mapped parent folder, renders as a direct child of the
     * parent row — no worktree sub-header. Deriving a separate location for it
     * here would label a group after a folder the tree never shows as a
     * worktree, which is the same class of disagreement this plan exists to
     * remove.
     */
    function locationKeyForTerminal(t) {
        if (!t) { return ''; }
        const parent = String(t.parentRoot || '');
        const wt = String(t.worktreePath || '');
        if (!wt || wt === parent) { return parent; }
        if (parentsList.some(p => p && p.parentFolder === wt)) { return parent; }
        return wt;
    }

    /** Human label for a location key — the trailing path segment, or ''. */
    function locationLabel(key) {
        const parts = String(key || '').replace(/\\/g, '/').split('/').filter(Boolean);
        return parts.length > 0 ? parts[parts.length - 1] : '';
    }

    /**
     * The pre-scoping id for a role group. Every groupPrefs map (hidden,
     * layouts, orders, extras, pinned) is keyed by group id, and those keys
     * shipped. Reads consult this as a fallback so an upgraded install keeps
     * its suppressions, layouts, orderings and extras; writes always use the
     * new scoped id. Nothing rewrites or deletes stored keys.
     */
    function legacyDerivedId(group) {
        if (!group || group.source !== 'role') { return null; }
        return safeGroupIdForValue('role', group.value);
    }

    /** Sentinel stored inside the SHIPPED groupPrefs.hidden array. */
    function hiddenRoleSentinel(role) {
        return 'role:' + String(role || '');
    }

    /**
     * Read a groupPrefs map by group id, falling back to the pre-scoping id.
     * Safe ONLY for maps whose writes replace the whole value (layouts,
     * orders). `extras` is push/filter-mutated in place, so it does not use
     * this — see getGroupMembers and the two extras mutation sites.
     */
    function readGroupPref(map, group) {
        if (!map || !group) { return undefined; }
        if (map[group.id] !== undefined) { return map[group.id]; }
        const legacy = legacyDerivedId(group);
        return (legacy && legacy !== group.id) ? map[legacy] : undefined;
    }
```

> **Superseded:** `function locationKeyForTerminal(t) { return String((t && (t.worktreePath || t.parentRoot)) || ''); }`
> **Reason:** A bare `worktreePath || parentRoot` does not mirror the sidebar, which the plan claims as its correctness standard. `renderSidebarList` treats a terminal as *direct* under its parent when `wtPath === targetGroup.fullPath || allParentFolders.has(wtPath)` (`terminals.js:3170`) — i.e. a worktreePath that is the parent itself, or that is another mapped parent folder, is not a worktree row. The bare version would derive a distinct location for those terminals and label a group after a folder the tree renders as a plain parent.
> **Replaced with:** the `parentsList`-aware version above. `parentsList` is module state populated alongside `fleetList` in `fetchTerminalList` (`terminals.js:1568`), so it is available wherever derivation runs.

### 2. `src/webview/terminals.js` — `getDerivedGroups()` (line 2473)

Tally roles per `(location, role)` instead of per role, and emit a scoped id plus a disambiguating label.

```js
    function getDerivedGroups() {
        const threshold = groupPrefs.threshold;
        const hidden = new Set(groupPrefs.hidden);
        const live = fleetList.filter(t => t.status !== 'exited' && !t.parentInstanceId);
        // Roles are tallied per LOCATION, not across the whole fleet. The fleet
        // spans every mapped parent folder and every worktree under each; a
        // global tally is what let one planner in repo A and one in repo B
        // conjure a "Planners" group whose members the operator never sees
        // together anywhere else in this panel. The sidebar hierarchy directly
        // below is scoped the same way (parent → worktree → terminals).
        const roleMap = new Map();   // `${location}\0${role}` → count
        const worktreeMap = new Map();
        for (const t of live) {
            if (t.role) {
                const key = locationKeyForTerminal(t) + LOC_SEP + t.role;
                roleMap.set(key, (roleMap.get(key) || 0) + 1);
            }
            if (t.worktreePath) { worktreeMap.set(t.worktreePath, (worktreeMap.get(t.worktreePath) || 0) + 1); }
        }
        // Roles present in more than one location get a location suffix; a role
        // that lives in exactly one place keeps the bare plural.
        const locationsPerRole = new Map();
        for (const key of roleMap.keys()) {
            const sep = key.indexOf(LOC_SEP);
            const loc = key.slice(0, sep);
            const role = key.slice(sep + 1);
            if (!locationsPerRole.has(role)) { locationsPerRole.set(role, new Set()); }
            locationsPerRole.get(role).add(loc);
        }
        const derived = [];
        for (const [key, count] of roleMap) {
            if (count < threshold) { continue; }
            const sep = key.indexOf(LOC_SEP);
            const location = key.slice(0, sep);
            const role = key.slice(sep + 1);
            const plural = (role.charAt(0).toUpperCase() + role.slice(1)) + 's';
            const label = locationLabel(location);
            const multi = (locationsPerRole.get(role) || new Set()).size > 1;
            derived.push({
                id: safeGroupIdForValue('role', location + LOC_SEP + role),
                name: (multi && label) ? `${plural} · ${label}` : plural,
                source: 'role',
                value: role,
                location
            });
        }
        for (const [wt, count] of worktreeMap) {
            if (count >= threshold) {
                const basename = locationLabel(wt) || wt;
                derived.push({
                    id: safeGroupIdForValue('worktree', wt),
                    name: basename,
                    source: 'worktree',
                    value: wt
                });
            }
        }
        // Suppression is checked three ways: the scoped id, the pre-scoping id
        // (so an upgraded install keeps its deletions), and a `role:<role>`
        // sentinel written by deleteGroup — one delete ends the derivation for
        // that role in every location this panel serves, instead of hiding one
        // id.
        return derived.filter(g => !hidden.has(g.id)
            && !(g.source === 'role' && (hidden.has(legacyDerivedId(g)) || hidden.has(hiddenRoleSentinel(g.value)))));
    }
```

> **Superseded:** composite key built as `locationKeyForTerminal(t) + ' ' + t.role` and destructured with `const [loc, role] = key.split(' ')`.
> **Reason:** A space is legal in a filesystem path. `/Users/pat/My Repos/switchboard` + `' '` + `planner` splits into `loc = '/Users/pat/My'` and `role = 'Repos/switchboard'` — the two-element array destructure silently discards the rest, so the group is emitted with `value: 'Repos/switchboard'`, a name of `Repos/switchboards`, a membership query matching no terminal (count on the tab: 0), and a suppression sentinel of `role:Repos/switchboard` that suppresses nothing. Every gate stays green; the panel is wrong on sight for any operator with a space in a folder name.
> **Replaced with:** `LOC_SEP = '\u0000'` as the join, and `indexOf`/`slice` rather than `split` so a role containing the separator could not truncate either.

`sortGroups` needs no change — it sorts on `name`, which now carries the suffix.

### 3. `src/webview/terminals.js` — `getGroupMembers()` role branch (line 2548)

The membership query must carry the same predicate, or the tab count and the seated panes disagree with the derivation.

```js
        } else if (group.source === 'role') {
            // Same location predicate as getDerivedGroups — the count on the
            // tab and the terminals seated into panes are one population.
            names = fleetList.filter(t => t.status !== 'exited' && !t.parentInstanceId
                && t.role === group.value
                && locationKeyForTerminal(t) === group.location
            ).map(t => t.friendlyName);
        } else if (group.source === 'worktree') {
```

> **Superseded:** `&& (group.location === undefined || locationKeyForTerminal(t) === group.location)`, justified as preserving old behaviour "for a group restored from a pre-scoping save".
> **Reason:** That restore path does not exist. Derived groups are never persisted as objects — only their **ids** are (`groupPrefs.*`, `terminals.activeGroupId`); the only persisted group *records* are manual ones, and `loadLayoutSettings` hardcodes `source: 'manual'` on every one of them (`terminals.js:1442`). So `group.source === 'role'` implies the object came straight from `getDerivedGroups()`, which always sets `location`. The clause is unreachable — and if a future change ever made it reachable, `undefined` would read as "any location" and silently restore the exact global-tally bug this plan removes. A dead fail-open branch guarding the bug under repair is worse than no branch.
> **Replaced with:** a strict `locationKeyForTerminal(t) === group.location` compare.

### 4. `src/webview/terminals.js` — legacy-key fallback on the prefs reads

`getStoredGroupLayout` (line 2600) and `orderGroupMembers` (line 2574) each read a `groupPrefs` map by `group.id` and are *replaced* wholesale on write, so `readGroupPref` is coherent for both:

- `getStoredGroupLayout`: `const stored = readGroupPref(groupPrefs.layouts, group);`
- `orderGroupMembers`: `const saved = readGroupPref(groupPrefs.orders, group) || [];`

Writes (`setGroupOrder` line 2591, the layout store at line 817) keep using `group.id` unchanged — new state lands under the scoped key, and the next read prefers it.

**`extras` is different and must not use `readGroupPref`.** It is mutated in place at two sites, so a fallback read plus a scoped-only write would break removal. Read unions both keys; both mutation sites address both keys. Nothing is deleted from storage, so a downgrade still finds its legacy entry.

`getGroupMembers` extras union (line 2560):

```js
        if (group.source !== 'manual' && groupPrefs.extras) {
            // Read BOTH keys. The scoped id is where new extras land; the
            // pre-scoping id is where an upgraded install's extras already
            // sit. Using readGroupPref here would be wrong in the other
            // direction — extras is push/filter-mutated, so a fallback READ
            // with a scoped-only WRITE makes "remove from pane" filter an
            // array that does not exist and the name silently returns.
            const extra = groupPrefs.extras[group.id];
            const legacyId = legacyDerivedId(group);
            const legacyExtra = (legacyId && legacyId !== group.id) ? groupPrefs.extras[legacyId] : null;
            for (const list of [extra, legacyExtra]) {
                if (!Array.isArray(list)) { continue; }
                for (const n of list) {
                    if (live.has(n) && !names.includes(n)) { names.push(n); }
                }
            }
        }
```

The unassign-pane removal (`terminals.js:4337`) filters both keys:

```js
                    if (group.source !== 'manual' && groupPrefs.extras) {
                        // Both keys: the extra may have been added under the
                        // pre-scoping id on a previous version.
                        const keys = [activeGroupId, legacyDerivedId(group)].filter(Boolean);
                        for (const k of keys) {
                            if (Array.isArray(groupPrefs.extras[k])) {
                                groupPrefs.extras[k] = groupPrefs.extras[k].filter(n => n !== targetName);
                            }
                        }
                    } else if (group.source === 'manual' && Array.isArray(group.members)) {
```

`addTerminalToActiveGroup` (line 2657) is unchanged — an add always lands under the scoped id, and the union read picks it up.

> **Superseded:** "`getStoredGroupLayout` **and** `orderGroupMembers` **and the extras union** each read a `groupPrefs` map by `group.id`. Add the legacy id as a read-only fallback… extras union: `const extra = readGroupPref(groupPrefs.extras, group);`"
> **Reason:** Two defects. (a) It turns a shipped contract test red: `terminal-sidebar-groupings-contract.test.js:594` asserts `/groupPrefs\.extras\[group\.id\]/` appears inside `getGroupMembers`, and `readGroupPref(groupPrefs.extras, group)` removes that literal — the plan's own test-update list did not include this assertion. (b) It creates a read/write asymmetry unique to `extras`: reads would fall back to the legacy id while both mutation sites (`terminals.js:2657` push, `terminals.js:4337` filter) write only under `activeGroupId`, so on an upgraded install "remove from this pane" filters a non-existent scoped array, the legacy entry survives, and the terminal re-unions into the group on the very next read — a removal that silently does nothing.
> **Replaced with:** `readGroupPref` for `layouts` and `orders` only (both whole-value writes); an explicit two-key union for the extras read (which keeps the pinned `groupPrefs.extras[group.id]` literal) and a two-key filter on the extras removal.

### 5. `src/webview/terminals.js` — `deleteGroup()` (line 2276)

Deleting a role-derived group records the role **instead of** the id.

```js
        } else if (group) {
            // Derived group (role/worktree): suppress, don't destroy.
            // groupPrefs.hidden is the shipped key — no new groupPrefs field,
            // so the loader whitelist and `restore all` both keep working.
            //
            // A role group derives itself again in every location that reaches
            // the threshold, and the suppression list lives in the per-workspace
            // kanban.db config table — so hiding one id reads to the operator as
            // "it keeps coming back". Deleting a role group means "stop deriving
            // this role here"; `restore all` clears the sentinel with everything
            // else. The sentinel REPLACES the id rather than joining it: the
            // strip renders `groupPrefs.hidden.length` as the deleted-group
            // count, so storing both would make one click read as "2 deleted
            // groups". The sentinel already suppresses every scoped id for the
            // role, so the id entry would be dead weight anyway.
            if (group.source === 'role') {
                const sentinel = hiddenRoleSentinel(group.value);
                if (!groupPrefs.hidden.includes(sentinel)) {
                    groupPrefs.hidden.push(sentinel);
                }
            } else if (!groupPrefs.hidden.includes(id)) {
                groupPrefs.hidden.push(id);
            }
        } else {
```

> **Superseded:** pushing the id unconditionally and *then* additionally pushing the sentinel for role groups.
> **Reason:** `renderGroupTabStrip` renders `${groupPrefs.hidden.length} deleted group${… === 1 ? '' : 's'} — restore all` (`terminals.js:2942`). Two entries per delete makes a single `×` click report "2 deleted groups", and two clicks report "4". The id entry is also redundant — `getDerivedGroups` already filters on the sentinel, which covers every scoped id for that role.
> **Replaced with:** role → sentinel only; every other derived source → id, unchanged. The literal `groupPrefs.hidden.push(id)` survives in the `else if`, so the shipped assertion at `terminal-sidebar-groupings-contract.test.js:519` stays green.

The tab's delete `×` already calls `deleteGroup(g.id)` with no confirm gate (`terminals.js:2829`) — unchanged, per CLAUDE.md.

### 6. `src/webview/terminals.js` — adopt or drop a stale lock, inside the existing one-shot (`fetchTerminalList`, line 1575)

`loadLayoutSettings` restores `activeGroupId` verbatim (`terminals.js:1447`), and a saved `dg_role_<role>` id no longer derives. The panel already has exactly one post-first-fetch one-shot for this concern:

```js
                    if (!restoredLockOnLoad && activeGroupId) {
                        restoredLockOnLoad = true;
                        switchToGroup(activeGroupId, { noSave: true });
                    }
```

Extend it rather than adding a second flag:

```js
                    if (!restoredLockOnLoad && activeGroupId) {
                        restoredLockOnLoad = true;
                        // A lock saved before role groups were location-scoped names
                        // an id that no longer derives: switchToGroup's find() misses
                        // and returns silently, seatActiveGroupPage() never runs, and
                        // the panel loads locked to nothing — "All" unlit, no tab lit,
                        // and the grid still holding whatever paneAssignments was
                        // saved. Adopt the scoped successor for that role if one is
                        // live, else drop the lock so "All" is honestly the state.
                        if (!getAllGroups().some(g => g.id === activeGroupId)) {
                            const successor = getDerivedGroups().find(
                                g => g.source === 'role' && legacyDerivedId(g) === activeGroupId
                            );
                            if (successor) { activeGroupId = successor.id; }
                            else { activeGroupId = null; }
                        }
                        if (activeGroupId) { switchToGroup(activeGroupId, { noSave: true }); }
                        else { clearGroupLock(); }
                    }
```

> **Superseded:** a new module-level `let pendingLegacyLockAdopt = true;` plus an `adoptLegacyGroupLock()` function, "called once from `fetchTerminalList` immediately after `fleetList = data.terminals;`".
> **Reason:** `fetchTerminalList` already owns a one-shot for precisely this — `restoredLockOnLoad` (`terminals.js:95`, fired at `terminals.js:1575`) — sitting at the same point in the same function, after the fleet assignment and before the render. A second flag beside it means two one-shots with no defined order between them, both mutating `activeGroupId`, both able to call `switchToGroup`/`clearGroupLock` — and `adoptLegacyGroupLock` would call `switchToGroup` **without** `{ noSave: true }`, persisting a lock during a restore that is explicitly meant not to write.
> **Replaced with:** the adoption folded into the existing `restoredLockOnLoad` block, keeping one flag, one ordering, and the `noSave` contract. When no successor exists, `clearGroupLock()` re-seats the grid from the live fleet rather than leaving the stale `paneAssignments` in place.

Note `legacyDerivedId(successor)` is `safeGroupIdForValue('role', role)` and the successor's own id embeds the location, so the two can never collide — the `find` matches only genuine pre-scoping ids.

### 7. `src/test/terminal-sidebar-groupings-contract.test.js` — update the pinned shapes

Five assertions read on the changed blocks; they pin the *design*, so they need to state the new one.

- `derived groups are computed from role and worktree only` (line 107): keep the `source: 'role'` / `source: 'worktree'` / no-`'project'` assertions; add
  ```js
  assert.ok(
      derived.includes('locationKeyForTerminal('),
      'role derivation must be scoped per location — a global role tally groups planners across unrelated workspaces and worktrees'
  );
  assert.ok(
      derived.includes('LOC_SEP') && !/split\(' '\)/.test(derived),
      'the (location, role) key must join on a separator a filesystem path cannot contain — a space splits "/Users/x/My Repos/y" mid-path'
  );
  ```
- `derived groups respect threshold and hidden list` (line 123): add
  ```js
  assert.ok(
      /hiddenRoleSentinel\(/.test(derived) && /legacyDerivedId\(/.test(derived),
      'suppression must consult the role sentinel and the pre-scoping id, or a delete stops sticking across locations and upgrades lose their suppressions'
  );
  ```
- `getGroupMembers counts one population` (line 577): the existing `groupPrefs.extras[group.id]` assertion at line 594 **stays as-is** (the extras read deliberately keeps that literal). Add to the role-branch block:
  ```js
  assert.ok(
      roleBranch.includes('locationKeyForTerminal('),
      'the role branch must carry the same location predicate as the derivation, or the tab count and the seated panes disagree'
  );
  assert.ok(
      !/group\.location === undefined/.test(roleBranch),
      'no fail-open escape on an absent location — derived groups are never persisted as objects, and "undefined means any location" silently restores the global tally'
  );
  ```
- New test, next to the `hidden`-key test at line 520:
  ```js
  test('deleting a role group suppresses the role inside the shipped hidden key', () => {
      const fn = block(terminalsJs, 'function deleteGroup(id) {', 'function clearGroupLock()');
      assert.ok(
          /hiddenRoleSentinel\(group\.value\)/.test(fn),
          'a role delete must record the role, not the id — the id-only suppression hides one location while the group derives in every other one'
      );
      assert.ok(
          /else if \(!groupPrefs\.hidden\.includes\(id\)\)/.test(fn),
          'the sentinel must REPLACE the id for role groups, not join it — the strip renders groupPrefs.hidden.length as the deleted-group count'
      );
      assert.ok(
          !/groupPrefs\.hiddenRoles/.test(terminalsJs),
          'the sentinel must ride inside the shipped groupPrefs.hidden array — a new prefs key needs a loader whitelist entry and breaks the verbatim initialiser assertion'
      );
  });
  ```
- New test, next to the lock tests:
  ```js
  test('a pre-scoping group lock is adopted or dropped inside the existing one-shot', () => {
      const fn = block(terminalsJs, 'async function fetchTerminalList()', 'function checkSoloNotFound()');
      assert.ok(
          /legacyDerivedId\(g\)\s*===\s*activeGroupId/.test(fn),
          'a saved dg_role_<role> lock must adopt its location-scoped successor — switchToGroup would otherwise miss silently and load the panel locked to nothing'
      );
      assert.ok(
          !/pendingLegacyLockAdopt/.test(terminalsJs),
          'the adoption rides in the existing restoredLockOnLoad one-shot — a second flag mutating activeGroupId in the same function has no defined order against it'
      );
      assert.ok(
          /clearGroupLock\(\)/.test(fn),
          'with no live successor the lock must be dropped and the grid re-seated, not left holding the saved paneAssignments'
      );
  });
  ```

The verbatim `groupPrefs` initialiser assertion (line 559) and the `hidden`-key assertion (line 520) both stay green: no new prefs key is introduced, and `groupPrefs.hidden.push(id)` survives verbatim in the non-role branch.

## Verification Plan

### Automated Tests

These are the implementing coder's gates; they were **not** run during this planning pass (session directive: skip compilation and tests).

1. `node --test src/test/terminal-sidebar-groupings-contract.test.js` — all tests green, including the six updated/added assertions and the two pre-existing ones the change is designed not to disturb (line 519 `groupPrefs.hidden.push(id)`, line 559 verbatim initialiser, line 594 `groupPrefs.extras[group.id]`).
2. `node --test src/test/multi-parent-terminals-contract.test.js` — unchanged, confirms `parentRoot` still reaches the webview.
3. `node --test src/test/` — no other suite regresses. Note the five pre-existing red tests at HEAD: stash-verify first and compare the failure set, do not attribute them to this change.

### Manual (installed VSIX, terminals panel)

4. **Cross-workspace, the reported case.** With two mapped parent folders, spawn one planner in each. → **No `Planners` tab appears.** Before the fix, one appeared containing both.
5. **Same-location.** Spawn a second planner in the *same* parent (no worktree). → A single `Planners` tab appears with count 2; switching to it seats exactly those two.
6. **Worktree separation.** With two planners in parent A's main checkout, create a worktree under A and spawn two planners inside it. → Two tabs: `Planners · <A basename>` and `Planners · <worktree basename>`, counts 2 and 2, and neither seats the other's terminals.
7. **Label economy.** Delete one of the two planners in the worktree so only one location has a planner pair. → The surviving tab reads bare `Planners`, no suffix.
8. **Path with a space.** Map a parent folder whose path contains a space (e.g. `~/My Repos/thing`) and spawn two planners in it. → The tab reads `Planners` (or `Planners · thing` when a second location also has a pair), count 2, and switching seats both. A regression here renders a tab named after a path fragment with count 0.
9. **Delete means stop.** Click `×` on a `Planners` tab. → It disappears immediately (no confirm — CLAUDE.md), the strip's overflow reads `1 deleted group — restore all` (not 2), and spawning further planners in *any* location does not bring it back. Reload the panel: still gone.
10. **Restore.** Open the strip's `»` overflow → `1 deleted group — restore all`. → The role group derives again for every location over threshold.
11. **Upgrade compatibility — suppression and layout.** Before installing, hand-set `terminals.groupPrefs` in this workspace's `kanban.db` config to `{"threshold":2,"hidden":["dg_role_planner"],"pinned":[],"orders":{},"layouts":{"dg_role_planner":"2x2"},"extras":{}}`. After installing, with two same-location planners → no `Planners` tab (the legacy suppression is honoured). Clear `hidden` via `restore all`, switch to the group → it restores at `2x2` (the legacy layout is read through the fallback).
12. **Upgrade compatibility — extras removal.** Hand-set `extras` to `{"dg_role_planner":["<some live non-planner terminal>"]}`. After installing, switch to the scoped `Planners` tab → the extra terminal is seated (the union read finds the legacy key). Click the pane's unassign `×` on it, then switch away and back → **it stays gone**. A regression here re-seats it on the next read.
13. **Stale lock.** Set `terminals.activeGroupId` to `dg_role_planner` in the config table with two same-location planners live, then open the panel. → The scoped `Planners` tab is the lit one and its members are seated; with no planners live, the `All` tab is lit and the grid seats the full fleet.

---

**Recommendation:** Complexity 6 → **Send to Coder.**
