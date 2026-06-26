# Make the Implementation Panel Agents Tab Track Extra Planner Terminals

## Goal

The Kanban panel's Agents tab lets the user run multiple planner terminals (a "planner pool" of 1–5). The Implementation panel's Agents tab (`implementation.html`) only ever shows a **single** PLANNER row, so the extra planner terminals are invisible there. It should enumerate and track each planner terminal, just like the Kanban view effectively does.

### Problem analysis & root cause

**Where the extra planner terminals come from.** The Kanban Agents tab has a count dropdown `#agents-tab-planner-terminal-count` (1–5) (`src/webview/kanban.html:2695`). Its value is persisted as `plannerTerminalCount` via `KanbanProvider.ts` into the workspace state file / globalState (`getPlannerTerminalCount`, `TaskViewerProvider.ts:3473-3476`; globalState key `switchboard.agents.plannerTerminalCount`). When agent terminals are opened, the count is expanded into N named terminals — `Planner`, `Planner 2`, `Planner 3`, … — **each carrying `role: 'planner'`** (`src/extension.ts:2640-2652`).

**What the Implementation panel receives.** `implementation.html` is rendered by `TaskViewerProvider`. Its agent rows are driven by the `terminalStatuses` message (handled at `implementation.html:2227-2233`, storing `lastTerminals = message.terminals`). Crucially, `TaskViewerProvider._refreshTerminalStatuses()` posts the **same** enriched terminal map to both the sidebar (`implementation.html`) and the Kanban provider (`TaskViewerProvider.ts:17899-17932`). That `lastTerminals` map already contains **every** planner terminal as a separate key (`Planner`, `Planner 2`, …), each with `.role === 'planner'`.

**The actual defect — render logic, not data.** `renderAgentList()` builds exactly one row per role. The Planner row uses a finder that returns only the **first** matching terminal (`implementation.html:3030-3035`):

```js
if (va.planner !== false) {
    agentListStandard.appendChild(createAgentRow('PLANNER', 'planner',
        'IMPROVE PLAN',
        terminals => Object.keys(terminals).find(key => terminals[key].role === 'planner')  // ← first match only
    ));
}
```

So all but the first planner terminal are discarded at render time even though they're present in `lastTerminals`. The name display also collapses to one value per role via `lastTerminalAgentNames[roleId]` ("first alive terminal per role wins", `TaskViewerProvider.ts:534`).

**Fix shape.** No backend, message, or state changes are needed — the data is already in the payload both views share. The fix is to enumerate all planner terminals from `lastTerminals` and append one `createAgentRow(...)` per terminal, with each row bound to a specific terminal name (so its status dot, name, locate/clear, and action button target that terminal rather than the role-collapsed first one).

## Metadata

- **Tags:** bug, implementation-panel, agents-tab, planner-pool, terminal-tracking, taskviewerprovider
- **Complexity:** 4 / 10
- **Primary file:** `src/webview/implementation.html`
- **Affected feature area:** Implementation panel → Agents tab (planner terminals)

## Complexity Audit

**Complex (UI-only, but touches a shared render helper).** Confined to `implementation.html`. The subtlety is that `createAgentRow` currently resolves a role-collapsed single terminal (name from `lastTerminalAgentNames[roleId]`, finder returns first match). To render multiple planner rows correctly, the row must be parameterizable by a concrete terminal name so per-row status, name, locate, clear, and dispatch all target that specific terminal. No data/persistence work — the planner terminals are already present in `lastTerminals`.

## Edge-Case & Dependency Audit

- **Single planner (count = 1):** `lastTerminals` has just `Planner` → exactly one row, identical to today. No regression.
- **Planner pool not yet opened:** if no planner terminals are alive, fall back to a single PLANNER row (red dot, "not ready") so the row still exists for dispatch — preserves current behaviour when nothing is open.
- **Dispatch readiness (`lastDispatchReadiness[roleId]`)** is keyed by **role**, not terminal name, so multiple planner rows would share the same role-level readiness/badge. Acceptable for status display; the per-terminal liveliness (`termData.alive`/heartbeat) already differentiates the dot per terminal. Do not invent per-terminal readiness keys (that data isn't sent).
- **Locate / Clear buttons** must target the specific terminal name, not the role — pass the concrete terminal name through so the existing locate/clear message carries the right terminal identifier.
- **Worktree terminals:** the existing `dispatchInfo.isWorktreeTerminal` suffix logic should keep working; per-terminal rows just make it clearer. No special handling required beyond using the row's own terminal name.
- **Other roles unchanged:** only the Planner row becomes multi-row. Lead/Coder/Intern/Reviewer/Analyst continue using their single-find rows.
- **No new message type / no provider change** — the planner terminals are already in the `terminalStatuses` payload shared with this webview.
- **No confirmation dialogs** (project rule).

## Proposed Changes

### 1. `src/webview/implementation.html` — enumerate planner terminals in `renderAgentList()`

Replace the single-find Planner block (`:3030-3035`) with enumeration over all planner terminals in `lastTerminals`, falling back to one placeholder row when none are open:

```js
// 1. Planner(s) — render one row per planner terminal (planner pool: 1-5)
if (va.planner !== false) {
    const plannerTermNames = Object.keys(lastTerminals)
        .filter(key => lastTerminals[key].role === 'planner')
        .sort(); // 'Planner', 'Planner 2', 'Planner 3', ...
    if (plannerTermNames.length === 0) {
        // No planner terminal open yet — keep a single placeholder row for dispatch.
        agentListStandard.appendChild(createAgentRow('PLANNER', 'planner',
            'IMPROVE PLAN',
            terminals => Object.keys(terminals).find(key => terminals[key].role === 'planner')
        ));
    } else {
        plannerTermNames.forEach((termName, idx) => {
            const label = idx === 0 ? 'PLANNER' : `PLANNER ${idx + 1}`;
            agentListStandard.appendChild(createAgentRow(label, 'planner',
                'IMPROVE PLAN',
                () => termName,            // bind this row to a specific terminal
                false,                     // hideLocate
                termName                   // explicit terminal name (see change 2)
            ));
        });
    }
}
```

### 2. `src/webview/implementation.html` — let `createAgentRow` target a specific terminal

`createAgentRow` (`:2684`) currently derives its display name from `lastTerminalAgentNames[roleId]` (one value per role, `:2751`). Add an optional `explicitTermName` parameter so pooled rows resolve their own terminal for status, name, locate, and clear:

```js
function createAgentRow(label, roleId, actionLabel, findTerminalFn, hideLocate, explicitTermName) {
    const container = document.createElement('div');
    container.className = 'agent-row';

    const termName = explicitTermName || (findTerminalFn ? findTerminalFn(lastTerminals) : null);
    const dispatchInfo = lastDispatchReadiness && roleId ? lastDispatchReadiness[roleId] : null;
    const dispatchState = dispatchInfo && dispatchInfo.state ? dispatchInfo.state : null;
    const routedTermName = (dispatchInfo && dispatchInfo.terminalName) ? dispatchInfo.terminalName : null;
    const resolvedTermName = termName || routedTermName;
    const termData = resolvedTermName ? lastTerminals[resolvedTermName] : null;
    // ... existing status logic unchanged (uses termData) ...
```

And in the name-display block (`:2745-2755`), prefer the explicit terminal name when provided so each pooled row shows its own terminal rather than the role-collapsed `lastTerminalAgentNames[roleId]`:

```js
if (roleId !== 'jules') {
    let suffix = '';
    if (dispatchInfo && dispatchInfo.isWorktreeTerminal) {
        suffix = ' <span style="font-size:9px; opacity:0.6;">(worktree)</span>';
    }
    const displayName = explicitTermName
        || (dispatchInfo && dispatchInfo.isWorktreeTerminal && dispatchInfo.terminalName ? dispatchInfo.terminalName : lastTerminalAgentNames[roleId]);
    if (displayName) {
        name.innerHTML = `${label} - ${displayName}${suffix}`;
    } else if (lastStartupCommands[roleId]) {
        // ... existing fallback unchanged ...
    }
}
```

Ensure the **Locate** and **Clear** button handlers further down in `createAgentRow` use `resolvedTermName` (the row's specific terminal) when posting their messages, so they act on the correct planner terminal. (They already operate on the resolved terminal; passing `explicitTermName` makes that resolution per-terminal for pooled rows.)

> All other call sites of `createAgentRow` omit the new trailing args, so they keep their current single-row behaviour unchanged.

## Verification Plan

1. **Build:** `npm run compile` succeeds.
2. **Set planner pool to 3:** in Kanban → Agents tab, set `#agents-tab-planner-terminal-count` to 3 and open the agent terminals (so `Planner`, `Planner 2`, `Planner 3` exist).
3. **Implementation panel shows all three:** open the Implementation panel → Agents tab. Confirm three planner rows appear (PLANNER, PLANNER 2, PLANNER 3), each with its own terminal name, status dot, and Locate/Clear buttons.
4. **Per-terminal status is accurate:** kill or busy one planner terminal and confirm only that row's dot/status changes (others stay independent).
5. **Locate/Clear target the right terminal:** click Locate on "PLANNER 2" and confirm it focuses the `Planner 2` terminal (not `Planner`).
6. **Count = 1 regression:** set the pool back to 1; the Implementation panel shows a single PLANNER row exactly as before.
7. **No planner open:** with no planner terminal alive, confirm a single placeholder PLANNER row still renders (red/not-ready) so dispatch is still available.
8. **Other roles unchanged:** Lead/Coder/Intern/Reviewer/Analyst rows are unaffected.
