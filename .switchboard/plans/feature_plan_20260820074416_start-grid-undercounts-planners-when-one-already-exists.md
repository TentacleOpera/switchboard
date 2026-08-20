# Start Grid undercounts planner agents when one already exists

## Goal

### Problem

When a planner terminal already exists (e.g. "Planner" / Planner 1) and the user clicks "OPEN AGENT TERMINALS" (Start Grid) with `plannerTerminalCount` set to 4, the grid creates only 3 new planners (Planner 2–4) instead of the expected 4 new planners (Planner 2–5). The user expects the setting to mean "create N new planner terminals," but the code interprets it as "top up to N total," so the existing planner eats one slot.

### Root Cause

There are two code paths that build the agent grid, and both have the same off-by-existing bug:

**1. VS Code extension path — `createAgentGrid` (`src/extension.ts:3361-3373`)**

<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts" lines="3361-3373" />

`plannerCount` is read from the user's `plannerTerminalCount` setting (clamped 1–5, default 1 — see `getPlannerTerminalCount` at <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts" lines="7148-7151" />). The agents list is built with `for (let n = 1; n <= plannerCount; n++)`, producing Planner 1 through Planner N. Later, at <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts" lines="3498-3510" />, the loop checks `vscode.window.terminals.find(t => matchesGridAgentName(t, agent.name))` — if Planner 1 already exists as a live terminal, it is reused instead of created. The net result is `plannerCount - existingPlanners` new terminals, not `plannerCount`.

**2. Browser/standalone path — `openAllTerminals` (`src/webview/terminals.js:7357-7370`)**

<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/terminals.js" lines="7357-7370" />

`resolveGridAgents` (line 7227) builds a `wanted` map with `planner → plannerCount`. Then `openAllTerminals` counts live terminals by role (`liveByRole`) and computes `missing = count - (liveByRole.get(role) || 0)`. If 1 planner is live and count is 4, `missing = 3` — only 3 new terminals are created. The `ptyFleetService.create()` auto-names them `planner-2`, `planner-3`, `planner-4`, never reaching `planner-5`.

### The fix

`plannerTerminalCount` should represent the number of planner terminals to **create** when Start Grid is pressed, not the total to top up to. Both paths must create `plannerCount` new planner terminals, numbered starting from `maxPlannerNum + 1` (extension path) or auto-named by `ptyFleetService.create()` (browser path).

- **Extension path:** Find the highest planner number among live planner terminals before building the agents list. Start the loop at `maxPlannerNum + 1` and create `plannerCount` entries. Using the max number (not the count of existing planners) avoids name collisions when there are gaps in planner numbering from closed terminals.
- **Browser path:** For the planner role, set `missing = count` (create `count` new terminals regardless of how many already exist), instead of `count - liveByRole.get(role)`.

Other roles are unaffected — they always have `wanted = 1` and the top-up behaviour is correct for them (pressing Start Grid when a coder already exists should reuse it, not create a second one).

## Metadata

**Complexity:** 3
**Tags:** frontend, backend, ui, bugfix
**Project:** Browser Switchboard

## User Review Required

- [x] The semantic change from "top up to N" to "create N new" for `plannerTerminalCount > 1` is the intended product behaviour. When `plannerTerminalCount = 1`, top-up semantics are preserved (reuse existing planner if live) — this hybrid is deliberate but should be confirmed.
- [x] Pressing Start Grid twice with `plannerCount = 4` creates 8 planners total (4 + 4). This matches "create a new grid of 4 each time" but diverges from any "maintain N planners" mental model. Confirm this is acceptable.

## Complexity Audit

### Routine
- The extension-path fix is a loop bound change plus a terminal-number scan — both use existing APIs (`vscode.window.terminals.filter`, a `Planner` name regex).
- The browser-path fix is a one-line conditional: `missing = count` for planners instead of `count - live`.
- No new APIs, no database changes, no schema migrations.

### Complex / Risky
- **Name collision in the extension path.** The agents list uses names like `Planner 2`, `Planner 3`, etc. If a previous grid created `Planner 5` and it's still live, and the user clicks Start Grid again with `plannerCount = 4`, the new list would be `Planner 6, 7, 8, 9` — no collision because the max-based offset starts after the highest existing planner number.

> **Superseded:** If a previous grid created `Planner 5` and it's still live, and the user clicks Start Grid again with `plannerCount = 4`, the new list would be `Planner 6, 7, 8, 9` — no collision because the existing-terminal count includes `Planner 5`.
> **Reason:** The original reasoning confused the COUNT of existing planners with the MAX planner number. When numbering has gaps (e.g. Planner 1 and Planner 3 live, Planner 2 closed), the count is 2 but the max is 3. A count-based offset (`startN = count + 1 = 3`) would produce "Planner 3" — colliding with the existing live terminal, which then gets reused instead of created, perpetuating the undercount bug. The max-based offset (`startN = max + 1 = 4`) avoids this.
> **Replaced with:** Use `maxPlannerNum + 1` as the loop start, where `maxPlannerNum` is the highest planner number among live terminals (not the count of live planners). This guarantees non-colliding names regardless of gaps.

- **`plannerCount` clamping.** `getPlannerTerminalCount` clamps to 1–5. If the user has 3 existing planners and `plannerCount = 5`, the extension path creates `Planner 4, 5, 6, 7, 8` — 5 new terminals, which is correct per the user's expectation. The browser path's `ptyFleetService.create()` has no per-role cap (confirmed at `src/standalone/ptyFleetService.ts:222-228`), so `planner-4` through `planner-8` create normally.

> **Superseded:** The browser path's `ptyFleetService.create()` has no per-role cap (confirmed in the existing plan `feature_plan_20260814100824`)
> **Reason:** The line reference was incorrect and the claim relied on an external plan rather than direct code verification.
> **Replaced with:** Confirmed directly at `src/standalone/ptyFleetService.ts:222-228` — `create()` picks the next free `${role}-${counter}` name by checking `this.terminals.has(name)`, with no per-role cap.

- **Browser path: `plannedTotal` grid sizing.** `plannedTotal` (line 7346) adds `Math.max(0, count - liveByRole.get(role))` for each role. If we change `missing` for planners but not `plannedTotal`, the grid will be sized for 3 new panes but 4 terminals are created — one will be unseated. `plannedTotal` must also use the new `missing` value for planners.

## Edge-Case & Dependency Audit

### Race Conditions
- **Extension path: `matchesGridAgentName` is defined later.** The agents list is built at line 3362, but `matchesGridAgentName` is defined at line 3417 — after the agents list. The existing-planner scan must use a standalone regex, not `matchesGridAgentName`. The regex `^Planner(?: (\d+))?(?: \(\d+\))?$` matches both "Planner" (n=1) and "Planner N" (n≥2), plus VS Code's ` (N)` suffix for duplicate names.
- **Terminal closure between scan and create.** Between counting live planners (line 3362) and the create loop (line 3498), a planner terminal could exit. `clearGridBlockers` (line 3435) runs at line 3495 — just before the create loop — and disposes exited terminals matching agent names. If a planner in the new name range exits between the scan and `clearGridBlockers`, it is disposed and then recreated. If a planner NOT in the new name range exits, it doesn't affect the new creates. No race-induced undercount.

### Security
- None. No credentials, no auth surfaces, no user input parsing.

### Side Effects
- **Extension path: worktree terminals.** When `suppressMain` is true and worktree terminals are used, the main-repo terminal creation block (lines 3394–3619) is skipped entirely — the worktree path at line 3383–3392 uses `agents.map(a => a.role)` to create worktree terminals. The worktree path passes roles, not names, to `ensureWorktreeTerminals`, which creates terminals via the autoban registry. The `plannerCount` expansion in the agents list still applies — the worktree path will create `plannerCount` new planner worktree terminals because it iterates the agents array. The fix is transparent to the worktree path.
- **Browser path: `createTerminalsForRole` naming.** `ptyFleetService.create()` picks the next free `${role}-${n}` name from its own map (confirmed at `src/standalone/ptyFleetService.ts:222-228`). Creating 4 new planners when `planner-1` exists produces `planner-2` through `planner-5` automatically — no name collision. If gaps exist (e.g. `planner-1` and `planner-3` live, `planner-2` closed), `create()` fills the gap first: `planner-2`, `planner-4`, `planner-5`, `planner-6` — still 4 new terminals.
- **Browser path: pressing Start Grid twice.** With the fix, pressing Start Grid twice with `plannerCount = 4` creates 8 planners total (4 + 4). This matches the user's expectation ("create a new grid of 4 each time"). The existing "top-up" guard for other roles (which have `wanted = 1`) still prevents doubling non-planner terminals.
- **Browser path: `plannedTotal` comment.** The comment at line 7344 ("open-all is a top-up") becomes partially inaccurate after the fix — planners are batch-created, not topped up. The comment should be updated to reflect the hybrid behaviour.

### Dependencies & Conflicts
- **Contract tests.** `terminal-open-all-seating-contract.test.js` and `multi-parent-terminals-contract.test.js` assert structural patterns in `openAllTerminals` (e.g. `plannedTotal > liveCount`, `growLayoutForFleet(`, `body: JSON.stringify({ role })`, exactly one `await fetchTerminalList()`). The browser-path fix preserves all these patterns — it changes the `missing` calculation but not the structural contracts. No test conflicts expected.
- **`fillGrid` is unaffected.** The "Fill grid" button (line 7405+) has its own `liveCount` and `need = slots - liveCount` logic, separate from `openAllTerminals`. The fix does not touch `fillGrid`.
- **No confirm gate.** Per `CLAUDE.md`, no confirmation dialogs.

## Dependencies

None — this plan is self-contained and does not depend on any other plan or session.

## Adversarial Synthesis

Key risks: gap-collision in the extension path when planner numbering has gaps from closed terminals (mitigated by using max planner number instead of count); grid sizing mismatch if `plannedTotal` is not updated alongside `missing` (mitigated by applying the same conditional to both); and semantic inconsistency when `plannerCount=1` uses top-up while `plannerCount>1` uses batch-create (accepted as deliberate design). Mitigations are built into the corrected proposed changes.

## Proposed Changes

### 1. `src/extension.ts` — find max planner number before building the agents list

At line 3361, after reading `plannerCount`, scan live planner terminals for the highest planner number and offset the loop from there:

```typescript
const plannerCount = await taskViewerProvider.getPlannerTerminalCount(effectiveWorkspaceRoot);
const agents: { name: string; role: string }[] = [];

// Find the highest planner number among live terminals so the grid creates
// plannerCount NEW planners with non-colliding names. Using the COUNT of
// existing planners is insufficient — gaps from closed terminals (e.g.
// Planner 1 and Planner 3 live, Planner 2 closed) would make a count-based
// offset produce a name that collides with an existing live terminal, which
// would then be reused instead of created, perpetuating the undercount bug.
let maxPlannerNum = 0;
for (const t of vscode.window.terminals) {
    if (t.exitStatus !== undefined) continue;
    const name = (t.name || '').trim();
    const m = name.match(/^Planner(?: (\d+))?(?: \(\d+\))?$/);
    if (m) {
        const num = m[1] ? parseInt(m[1], 10) : 1;
        if (num > maxPlannerNum) maxPlannerNum = num;
    }
}

for (const builtIn of allBuiltInAgents) {
    if (visibleAgents[builtIn.role] !== false) {
        if (builtIn.role === 'planner' && plannerCount > 1) {
            const startN = maxPlannerNum + 1;
            for (let n = startN; n < startN + plannerCount; n++) {
                agents.push({ name: n === 1 ? 'Planner' : `Planner ${n}`, role: 'planner' });
            }
        } else {
            agents.push(builtIn);
        }
    }
}
```

> **Superseded:** The original proposed code used `existingPlanners` (the count of live planner terminals) as the loop offset: `const startN = existingPlanners + 1;`
> **Reason:** Count-based offset fails when planner numbering has gaps. If Planner 1 and Planner 3 are live (Planner 2 was closed), `existingPlanners = 2`, `startN = 3`, and the loop produces "Planner 3" — which collides with the existing live Planner 3. The create loop at line 3500 then finds and reuses it instead of creating a new one, resulting in only `plannerCount - 1` new terminals. The `clearGridBlockers` function does not mitigate this because it only disposes exited and duplicate terminals, not live ones that happen to match a name in the new range.
> **Replaced with:** `maxPlannerNum`-based offset — scans for the highest planner number (not the count), guaranteeing all new names are above any existing planner number. With Planner 1 and Planner 3 live, `maxPlannerNum = 3`, `startN = 4`, producing "Planner 4, 5, 6, 7" — no collision.

The regex `^Planner(?: (\d+))?(?: \(\d+\))?$` matches:
- `Planner` (the n=1 name, no suffix) — `m[1]` is undefined, num defaults to 1
- `Planner 2`, `Planner 3`, … (the n≥2 names) — `m[1]` captures the number
- `Planner (2)`, `Planner 2 (1)` (VS Code's dedup suffix when a name collides) — the `(N)` suffix is ignored, the planner number is extracted from the first capture group

### 2. `src/webview/terminals.js` — create `plannerCount` new planners, not top-up

In `openAllTerminals`, change the `missing` calculation for the planner role. At line 7357:

```javascript
let created = 0;
for (const [role, count] of wanted.entries()) {
    // Planners are created as a batch of `count` new terminals, not topped up
    // to `count` total — the user expects "4 planners" to mean 4 new ones.
    const missing = (role === 'planner' && count > 1)
        ? count
        : count - (liveByRole.get(role) || 0);
    if (missing > 0) {
        created += await createTerminalsForRole(
            role, missing, hasCommand[role] === true,
            () => { fillEmptyPanes({ persist: false }); }
        );
    }
}
```

And update `plannedTotal` at line 7346 to match:

```javascript
let plannedTotal = liveCount;
for (const [role, count] of wanted.entries()) {
    const missing = (role === 'planner' && count > 1)
        ? count
        : Math.max(0, count - (liveByRole.get(role) || 0));
    plannedTotal += missing;
}
```

Also update the comment at line 7344 to reflect the hybrid behaviour:

```javascript
// is a top-up for most roles, but planners are batch-created (count new
// terminals regardless of live ones), so `created` alone under-sizes the
// grid whenever the operator already had panes open.
```

## Verification Plan

### Manual Testing
1. Set `plannerTerminalCount` to 4 in the Agents tab.
2. Open one planner terminal manually (or click Start Grid once to get Planner 1).
3. Click "OPEN AGENT TERMINALS" again.
4. **Expected:** 4 new planner terminals are created (Planner 2, 3, 4, 5 in the extension path; `planner-2` through `planner-5` in the browser path). Total planners = 5.
5. **Regression check:** Verify non-planner roles (Coder, Intern, etc.) still top up correctly — clicking Start Grid when a Coder already exists should reuse it, not create a second one.
6. **Gap-collision check (extension path):** Create Planner 1 and Planner 3 (close Planner 2). Set `plannerTerminalCount = 4`. Click Start Grid. **Expected:** 4 new terminals (Planner 4, 5, 6, 7) — not 3, which would happen with a count-based offset.

### Automated Tests
- **Extension path:** Add a test that stubs `vscode.window.terminals` with one live "Planner" terminal, sets `plannerTerminalCount = 4`, calls `createAgentGrid`, and asserts 4 new terminals are created (names "Planner 2" through "Planner 5").
- **Extension path gap-collision:** Add a test that stubs `vscode.window.terminals` with live "Planner" and "Planner 3" terminals (gap at 2), sets `plannerTerminalCount = 4`, calls `createAgentGrid`, and asserts 4 new terminals are created (names "Planner 4" through "Planner 7") — not 3.
- **Browser path:** Add a test that stubs `fleetList` with one live `planner` terminal, sets `wanted.get('planner') = 4`, calls `openAllTerminals`, and asserts `createTerminalsForRole` is called with `missing = 4` for the planner role.
- **Non-planner top-up regression:** Assert `createTerminalsForRole` is called with `missing = 0` for a coder that already has 1 live terminal (top-up behaviour preserved).
- **`plannedTotal` sizing:** Assert that with 1 live planner and `plannerCount = 4`, `plannedTotal` equals 5 (1 live + 4 new), and `growLayoutForFleet` is called with 5.

## Outstanding Questions
- **[user]** Is the hybrid semantics acceptable? When `plannerTerminalCount = 1`, pressing Start Grid reuses an existing planner (top-up). When `plannerTerminalCount > 1`, it creates N new planners (batch). This is deliberate but creates two different behaviours for the same setting depending on its value. — proceeding on the assumption that this hybrid is acceptable since count=1 with top-up avoids creating a redundant second planner, while count>1 with batch-create matches the "give me a grid of N" intent.
