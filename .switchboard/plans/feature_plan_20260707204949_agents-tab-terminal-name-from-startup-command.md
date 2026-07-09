# Fix Agents Tab Terminal Name to Match Kanban Column (Startup-Command-Derived)

## Goal

The **Agents tab** in `implementation.html` displays terminal rows as `ROLE - <name>`, but the `<name>` segment is wrong. The user reports rows like `Planner - planner` and `Lead Coder - lead coder devin` when the expected display is `Coder - AGY CLI` — i.e. the `<name>` segment must be the **startup-command-derived agent name**, the same value shown at the top of the Kanban column headers. This is the **third** time this bug has been reported; the prior fix (`feature_plan_20260703153351_agents-tab-terminal-name-format.md`) corrected the *format* (dash-separated segments, dead-variable removal) but chose the **wrong name source** — it routed the display to the terminal's raw VS Code name, which is the role label, not the startup-command name.

### Problem Analysis & Root Cause

There are **two divergent name sources** in the codebase, and the Agents tab uses the wrong one.

**Source A — the terminal's raw VS Code name (WRONG for display).** Terminals are created with role-label names:
- `createAgentGrid` (`src/extension.ts:2802-2807`) creates each terminal with `name: agent.name` where `agent.name` is a hardcoded label (`'Planner'`, `'Lead Coder'`, `'Coder'`, …) from the `allBuiltInAgents` array (`src/extension.ts:2635-2647`).
- `_createAutobanTerminal` (`src/services/TaskViewerProvider.ts:7210-7211`) creates each terminal with `name: uniqueName` from `getNextAutobanTerminalName(roleLabel, …)` where `roleLabel` is the role label (`'Planner'`, `'Coder'`, `'Lead Coder'`, …) from `_getAutobanRoleLabel` (`TaskViewerProvider.ts:6657-6665`).

These raw names are the **keys** of the `lastTerminals` map pushed to the webview via the `terminalStatuses` message (`implementation.html:2224-2225`). The current Agents-tab display reads this key via `findTerminalByRole(lastTerminals, role)` → `resolvedTermName` and renders it as the `<name>` segment (`implementation.html:2794, 2806`). So the display shows the role label (e.g. `CODER - Coder`, `PLANNER - Planner`) — not the startup-command name. (The user's lowercase `planner` / `lead coder devin` variants arise from terminal-name keys written by ancillary creation/scan paths; regardless of the exact raw key, the fix below stops displaying the raw key at all.)

**Source B — the startup-command-derived display name (CORRECT, used by the Kanban column).** The Kanban column-header subline (`kanban.html:5280-5298`, `updateAllColumnAgents`) renders `lastAgentNames[role]`, which `KanbanProvider._getAgentNames` (`KanbanProvider.ts:5491-5551`) computes as `path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase() + ' CLI'` from the role's startup command (e.g. command `agy` → `AGY CLI`). This is then overridden, when a live terminal exists, by `getActualTerminalAgentNames()` (`TaskViewerProvider.ts:582-608`) which reads `_terminalAgentInfo.displayName` — and that `displayName` is **also** derived from the startup command at every terminal-creation / terminal-scan site:
- `createAgentGrid` (`src/extension.ts:2894-2897`): `displayName = basename(binary).toUpperCase() + ' CLI'` → `setTerminalAgentInfo(...)`.
- `_createAutobanTerminal` (`TaskViewerProvider.ts:7319-7322`): same derivation.
- Terminal re-scan for pre-existing terminals on restart (`TaskViewerProvider.ts:16072-16082` and `16142-16149`): same derivation, so `_terminalAgentInfo` is repopulated for terminals that survive an IDE restart.

So Source B **always** yields the startup-command-derived name (`AGY CLI`), and it is what the Kanban column header shows. The user's expectation ("like the names are at the top of the kanban columns") is exactly Source B.

**Why the Agents tab doesn't already use Source B — the smoking gun.** The backend **already posts** the Source-B names to the `implementation.html` webview via the `terminalAgentNames` message:
- On init / config refresh: `TaskViewerProvider._postSidebarConfigurationState` (`TaskViewerProvider.ts:4616-4617`) posts `{ type: 'terminalAgentNames', agentNames: getActualTerminalAgentNames() }`.
- On every terminal agent-info change: `_notifyTerminalAgentNamesChanged` (`TaskViewerProvider.ts:556-561`) posts the same.

But **`implementation.html` has no `case 'terminalAgentNames'` handler** (verified: zero matches for `terminalAgentNames` / `lastAgentNames` / `agentNames` in the file). The message is sent and silently ignored. The Kanban webview (`kanban.html:6878-6879`) handles its equivalent (`updateAgentNames`, posted by `KanbanProvider.ts:1719/3243/3402`) and renders correctly; the Agents tab does not. (Note: implementation.html receives the `terminalAgentNames` type from `TaskViewerProvider.ts:559/4617`; kanban.html receives the `updateAgentNames` type from `KanbanProvider`. Same `getActualTerminalAgentNames()` data source, different transport message types per webview.)

**Compounding factor — the fallback is also dead.** The display code has a fallback branch (`implementation.html:2795-2797`) that would derive `<CMD> CLI` from `lastStartupCommands[roleId]` — producing the correct `AGY CLI` when no live-terminal name is available. But `lastStartupCommands` is **never populated** in `implementation.html`: it is declared at line 1916 and read at lines 2795/3402, but the `startupCommands` message that the backend posts (`TaskViewerProvider.ts:4613`, payload `{ type: 'startupCommands', commands, visibleAgents, ... }` from `handleGetStartupCommands` at `TaskViewerProvider.ts:4148-4161`) has **no handler** in `implementation.html` either (verified: no `case 'startupCommands'`). So `lastStartupCommands` stays `{}`, the fallback never fires, and the display always falls through to `resolvedTermName` — the raw role-label terminal name.

**Net root cause:** The Agents tab displays Source A (the terminal's raw role-label name) because it (1) ignores the `terminalAgentNames` message that carries Source B, and (2) never populates `lastStartupCommands` so the Source-B fallback is dead. The prior fix made the display *faithfully* show the raw terminal name; the raw terminal name is itself the wrong value. The Kanban column shows Source B because it consumes the equivalent message. The fix is to make the Agents tab consume the same Source-B data the backend already sends.

## Metadata

- **Plan ID:** 9c3e1a7f-4b20-4c61-9d2e-6f8a17c0b521
- **Tags:** `bugfix`, `ui`
- **Complexity:** 4
- **Files touched:** `src/webview/implementation.html`
- **Risk:** Low — display-only change in a single webview HTML file, plus wiring up three message handlers for messages the backend already posts. No state, persistence, backend, or terminal-creation changes. Locate/clear action handlers continue to use the raw terminal name key (`resolvedTermName`/`termName`) and are unchanged.
- **Supersedes:** `feature_plan_20260703153351_agents-tab-terminal-name-format.md` (that plan's `resolvedTermName`-as-display approach is the proximate cause of this regression).

## User Review Required

No — display-only bugfix with a verified root cause. The fix makes the Agents tab consume messages the backend already posts and show the same name the Kanban column already shows. No product-scope, migration, or behavior-change-for-existing-users implications (the name shown simply becomes correct).

## Complexity Audit

### Routine
- Single-file change (`src/webview/implementation.html`): add four `case` handlers to the existing message switch, declare one new state variable, and re-route the display Name source in two render functions.
- The backend already posts `terminalAgentNames`, `visibleAgents`, `startupCommands`, and `customAgents` (`TaskViewerProvider.ts:4613, 4617, 4620, 4623`); this plan only adds the receiving end.
- The name-derivation formula (`basename(binary).toUpperCase() + ' CLI'`) is identical to the backend's (`TaskViewerProvider.ts:7321`, `extension.ts:2896`, `KanbanProvider.ts:5528-5530`). The pre-existing display fallback (`implementation.html:2795-2797`) used a weaker non-basename form; this plan's refinement aligns the fallback to the same basename + `.exe/.cmd/.bat`-strip derivation so the no-terminal path matches the Kanban column byte-for-byte.
- Locate/clear handlers use `resolvedTermName`/`termName` (the raw terminal key), not the display name (`implementation.html:2862, 2878, 3422`), so decoupling display-name from action-target is safe and requires no handler changes.

### Complex / Risky
- None. No backend, state, persistence, migration, or terminal-creation changes. The only subtlety is message timing (see Edge-Case audit) which is handled by the existing `terminalStatuses`-triggered re-render pattern.

## Edge-Case & Dependency Audit

### Race Conditions / Message Timing
- `terminalAgentNames` and `startupCommands` are posted by `_postSidebarConfigurationState` on init and on every terminal agent-info change. VS Code webviews queue messages until the listener is registered, so no message is lost if posted before the listener attaches (same mechanism the existing `terminalStatuses` handler relies on — that handler works, so this does too).
- A `terminalStatuses` push can arrive between a `terminalAgentNames` push and a re-render. Because each handler calls `renderAgentList()` and reads the latest module-level state synchronously on the JS thread, the final render reflects the most-recent snapshot. This is the **pre-existing** rendering model (all globals are read mid-render) and is not worsened.
- **Ordering guard:** if `terminalAgentNames` arrives before `startupCommands`, a role with no live-terminal entry renders the bare label first, then re-renders with `<CMD> CLI` once `startupCommands` lands. Both handlers call `renderAgentList()`, so the transient is self-correcting within one event loop tick. Acceptable (matches how `terminalStatuses` already causes re-renders).

### Security
- `lastAgentNames[roleId]` and `lastStartupCommands[roleId]` are extension-controlled (backend-derived from `state.json` / in-memory `_terminalAgentInfo`), not user-input in this webview. The existing `esc()` helper (`implementation.html:2800, 3397`) is retained on all variable segments before composing `innerHTML`, so even a maliciously-crafted startup command or terminal display name cannot inject HTML. The only literal HTML in the composed string remains the styled `worktree` `<span>`.
- `label` for custom agents is user-defined (from `lastCustomAgents`); `esc(label)` is the XSS gate and is retained (as flagged by the prior plan).

### Side Effects
- **Display-only:** no state mutations, no messages posted to the extension, no persistence writes.
- **Locate/clear unchanged:** the locate button posts `focusTerminal { terminalName: resolvedTermName }` and clear posts `sendToTerminal { name: resolvedTermName }` (`implementation.html:2862, 2878`). These use the raw terminal key, not the display name, so they keep resolving the correct terminal after the display-name change. Verified: `createAnalystRow` locate uses `termName` (`implementation.html:3422`).
- **Worktree segment unchanged:** the ` - worktree` dash segment logic (`implementation.html:2783-2784, 2801-2803, 3396-3400`) is independent of the Name source and is preserved.
- **Latent gap fixed as a side effect:** `lastVisibleAgents` and `lastCustomAgents` are currently never populated from the backend (no handlers), so the Agents tab renders `DEFAULT_VISIBLE_AGENTS` and zero custom agents. Handling `startupCommands` (which carries `visibleAgents`) and `customAgents` fixes this with no extra messages. This is a behavior improvement (the tab will finally respect visibility checkboxes and show custom agents) but not a regression risk — it makes the tab match the Kanban Agents tab, which is the established correct behavior.

### Dependencies & Conflicts

| Edge case | Handling |
| :--- | :--- |
| Role with a live terminal (newly created this session) | `lastAgentNames[role]` = `AGY CLI` (from `terminalAgentNames` / `_terminalAgentInfo.displayName` set at `extension.ts:2897`). Display: `CODER - AGY CLI`. |
| Role with a pre-existing terminal (survived IDE restart) | Terminal re-scan repopulates `_terminalAgentInfo` (`TaskViewerProvider.ts:16080, 16149`) → `terminalAgentNames` carries `AGY CLI`. Display: `CODER - AGY CLI`. |
| Role with a terminal but `terminalAgentNames` not yet received (transient) | Falls back to `lastStartupCommands[role]` → `<CMD> CLI` (now populated via the `startupCommands` handler). Same value. |
| Role with no terminal but a startup command configured | `lastAgentNames[role]` undefined → `lastStartupCommands[role]` → `AGY CLI`. Matches Kanban column's `configuredNames` path. |
| Role with no terminal and no startup command | Both undefined → bare label (e.g. `CODER`). Matches Kanban column's "No agent assigned" semantics (Agents tab uses bare label, by existing convention). |
| PLANNER row passes `explicitTermName` (`lastPlannerTarget`) | **Preserved as highest priority.** The user-selected planner target (a terminal name) continues to win. Note: `lastPlannerTarget` is a terminal name key, so the PLANNER row may still show a raw-name segment when a rotation target is active — this is pre-existing, intended (it shows *which* terminal the rotation cursor points at), and unchanged by this plan. |
| Worktree-routed terminal (`dispatchInfo.isWorktreeTerminal`) | `worktreeRouteName` retained as a display candidate so a worktree dispatch shows the routed terminal's name. Appended ` - worktree` segment preserved. |
| JULES row | Unchanged — uses `name.innerText = label` (no name segment by design). |
| Custom agent row | `label` = `customAgent.name.toUpperCase()`; `lastAgentNames[customAgent.role]` provides the name if a terminal is connected. `esc(label)` retained (XSS gate for user-defined names). |
| ANALYST row (`createAnalystRow`) | Fixed consistently — uses `lastAgentNames['analyst']` then `lastStartupCommands['analyst']` fallback. |
| `terminalAgentNames` entry present but terminal since closed | `getActualTerminalAgentNames()` prunes stale `_terminalAgentInfo` entries against `vscode.window.terminals` (`TaskViewerProvider.ts:596-598`) before posting, so stale names are not sent. |

### Dependencies
None. The backend posts all required messages already. No other plans or sessions need to complete first. `findTerminalByRole`, `resolvedTermName`, `termName`, `lastTerminals`, `lastDispatchReadiness`, and the `esc()` helper are all already in scope.

## Adversarial Synthesis

**Why this is the third report — and why this fix breaks the cycle.** The first two reports were addressed by reshaping the display *format* and re-routing the display to `resolvedTermName` (the terminal's raw name). That was conceptually wrong: the terminal's raw name is the role label, not the agent name the user cares about. Every terminal-creation site names the terminal after the role (`createAgentGrid`, `_createAutobanTerminal`), so as long as the display reads the raw terminal key, it will *always* show a role-label-derived string — no amount of format tweaking fixes that. This plan breaks the cycle by switching the display to the **same source the Kanban column uses** (`getActualTerminalAgentNames()` / startup-command derivation), which is posted to the webview but was never consumed. After this fix, the Agents tab and the Kanban column header read from the identical backend source, so they cannot diverge again unless someone changes the backend's name-derivation — a single, shared source of truth.

**Key risks:** (1) `terminalAgentNames` only carries roles with a live `_terminalAgentInfo` entry — mitigated by the `lastStartupCommands` fallback (now populated), whose derivation is **byte-identical** to `KanbanProvider._getAgentNames` (basename + `.exe/.cmd/.bat` strip + `.toUpperCase() + ' CLI'`, mirroring `KanbanProvider.ts:5528-5530`) so the no-terminal fallback cannot diverge from the Kanban column; (2) the PLANNER row's `explicitTermName` (`lastPlannerTarget`) is a terminal name key, not a display name, so the PLANNER row may still show a raw-name segment during rotation — this is pre-existing, intended, and explicitly preserved (changing it would hide which terminal the rotation cursor targets); (3) handling `visibleAgents`/`customAgents` changes the set of rows shown (previously defaults-only) — this is a correction toward the Kanban tab's behavior, not a regression; the dedicated `visibleAgents` message handler (in addition to the copy embedded in `startupCommands`) is defense-in-depth against a future refactor of `handleGetStartupCommands`'s return shape. **Mitigations:** keep `explicitTermName` precedence for PLANNER; keep `esc()` on all variable segments; keep locate/clear on `resolvedTermName`/`termName`; keep the fallback formula mirroring Kanban's exact derivation. No blockers.

## Proposed Changes

### File: `src/webview/implementation.html`

#### Change 1 — Declare `lastAgentNames` state

Near the other module-level state (after `let lastCustomAgents = [];` at line 1919), add:

```js
let lastCustomAgents = [];
let lastAgentNames = {}; // role -> startup-command-derived display name (e.g. 'AGY CLI'); from 'terminalAgentNames' message
```

#### Change 2 — Handle the `terminalAgentNames`, `visibleAgents`, `startupCommands`, and `customAgents` messages

In the message switch (the `window.addEventListener('message', …)` block starting at line 2148; the switch closes at line 2474), add four cases. Insert before the closing `default`/`}` of the switch (e.g. after the `case 'switchboardThemeChanged'` block ending at line 2473):

```js
case 'terminalAgentNames':
    lastAgentNames = message.agentNames || {};
    renderAgentList();
    break;
case 'visibleAgents':
    lastVisibleAgents = { ...DEFAULT_VISIBLE_AGENTS, ...(message.agents || {}) };
    renderAgentList();
    break;
case 'startupCommands':
    lastStartupCommands = message.commands || {};
    if (message.visibleAgents) {
        lastVisibleAgents = { ...DEFAULT_VISIBLE_AGENTS, ...message.visibleAgents };
    }
    renderAgentList();
    break;
case 'customAgents':
    lastCustomAgents = Array.isArray(message.customAgents) ? message.customAgents : [];
    renderAgentList();
    break;
```

Rationale: the backend already posts all four (`TaskViewerProvider.ts:4613, 4617, 4620, 4623`). `terminalAgentNames` is the primary Name source (live-terminal display names). `visibleAgents` (dedicated message, payload `{ agents }` at line 4620) and the `visibleAgents` copy embedded in `startupCommands` (from `handleGetStartupCommands`'s return shape, line 4151) both populate `lastVisibleAgents` — handling the dedicated message is defense-in-depth so the tab does not silently revert to defaults if `handleGetStartupCommands` ever drops `visibleAgents` from its return shape. `startupCommands` populates `lastStartupCommands` so the `<CMD> CLI` fallback works for roles without a live-terminal entry. `customAgents` populates `lastCustomAgents` so custom-agent rows render (latent gap). Each handler calls `renderAgentList()` to apply the new data immediately.

#### Change 3 — `createAgentRow`: use `lastAgentNames[roleId]` as the display Name (stop using the raw terminal name)

Replace the name-resolution block at `implementation.html:2782-2814` (the `if (roleId !== 'jules') { … } else { name.innerText = label; }` block).

**Current** (`implementation.html:2782-2814`):

```js
if (roleId !== 'jules') {
    const isWtTerm = (dispatchInfo && dispatchInfo.isWorktreeTerminal) ||
        (resolvedTermName && lastTerminals[resolvedTermName]?.worktreePath);

    // Name segment resolution order:
    //   1. explicitTermName (PLANNER's user-selected target)
    //   2. worktree-routed terminal name (dispatchInfo.terminalName when isWorktreeTerminal)
    //   3. the terminal name key resolved by findTerminalByRole (resolvedTermName)
    //   4. fallback to startup command -> "<CMD> CLI"
    //   5. bare role label
    const worktreeRouteName = (dispatchInfo && dispatchInfo.isWorktreeTerminal && dispatchInfo.terminalName)
        ? dispatchInfo.terminalName : null;
    const displayName = explicitTermName || worktreeRouteName || resolvedTermName || null;
    const fallbackCmdName = lastStartupCommands[roleId]
        ? `${lastStartupCommands[roleId].trim().split(/\s+/)[0].toUpperCase()} CLI`
        : null;

    // Escape plain-text segments before joining into innerHTML (the worktree span is the only literal HTML).
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const wtSegment = isWtTerm
        ? ' - <span style="font-size:9px; opacity:0.6;">worktree</span>'
        : '';

    if (displayName) {
        name.innerHTML = `${esc(label)} - ${esc(displayName)}${wtSegment}`;
    } else if (fallbackCmdName) {
        name.innerHTML = `${esc(label)} - ${esc(fallbackCmdName)}${wtSegment}`;
    } else {
        name.innerHTML = esc(label) + wtSegment;
    }
} else {
    name.innerText = label;
}
```

**Proposed:**

```js
if (roleId !== 'jules') {
    const isWtTerm = (dispatchInfo && dispatchInfo.isWorktreeTerminal) ||
        (resolvedTermName && lastTerminals[resolvedTermName]?.worktreePath);

    // Name segment resolution order (MIRRORS the Kanban column header — KanbanProvider._getAgentNames /
    // getActualTerminalAgentNames — so the Agents tab and the Kanban column always agree):
    //   1. explicitTermName   — PLANNER's user-selected rotation target (a terminal name; preserved)
    //   2. worktreeRouteName  — dispatchInfo.terminalName for a worktree-routed dispatch
    //   3. lastAgentNames[roleId] — startup-command-derived display name from the 'terminalAgentNames'
    //      message (e.g. 'AGY CLI'), the SAME source the Kanban column header uses
    //   4. fallbackCmdName    — lastStartupCommands[roleId] -> '<CMD> CLI' (matches #3 when no live term)
    //   5. bare role label
    //
    // NOTE: the terminal's raw VS Code name (resolvedTermName) is intentionally NOT used for display —
    // it is the role label ('Coder', 'Planner', …), not the agent name. resolvedTermName is still used
    // below for the locate/clear action handlers (unchanged).
    const worktreeRouteName = (dispatchInfo && dispatchInfo.isWorktreeTerminal && dispatchInfo.terminalName)
        ? dispatchInfo.terminalName : null;
    const agentDisplayName = lastAgentNames[roleId] || null;
    // Fallback derivation MIRRORS KanbanProvider._getAgentNames (KanbanProvider.ts:5528-5530):
    //   path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase() + ' CLI'
    // The webview has no node `path` module, so basename is inlined via split on / and \.
    // This keeps the no-terminal fallback byte-identical to the Kanban column's configuredNames path.
    const _cmd0 = (lastStartupCommands[roleId] || '').trim().split(/\s+/)[0] || '';
    const fallbackCmdName = _cmd0
        ? `${_cmd0.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '').toUpperCase()} CLI`
        : null;
    const displayName = explicitTermName || worktreeRouteName || agentDisplayName || fallbackCmdName || null;

    // Escape plain-text segments before joining into innerHTML (the worktree span is the only literal HTML).
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const wtSegment = isWtTerm
        ? ' - <span style="font-size:9px; opacity:0.6;">worktree</span>'
        : '';

    if (displayName) {
        name.innerHTML = `${esc(label)} - ${esc(displayName)}${wtSegment}`;
    } else {
        name.innerHTML = esc(label) + wtSegment;
    }
} else {
    name.innerText = label;
}
```

Key differences:
- `resolvedTermName` is **removed** from the display-name chain. The primary Name source is now `lastAgentNames[roleId]` (the `terminalAgentNames` message = the same `getActualTerminalAgentNames()` output the Kanban column uses).
- `fallbackCmdName` is folded into the single `displayName` chain (so the `<CMD> CLI` fallback is reached without a separate branch).
- `explicitTermName` (PLANNER rotation target) and `worktreeRouteName` retain highest precedence — pre-existing intended behavior preserved.
- Locate/clear handlers (lines 2862, 2878) are untouched and still use `resolvedTermName`.

#### Change 4 — `createAnalystRow`: same fix

Replace the analyst name-resolution block at `implementation.html:3396-3411`.

**Current** (`implementation.html:3396-3411`):

```js
const isWtTermAnalyst = !!(termName && lastTerminals[termName]?.worktreePath);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const wtSegmentAnalyst = isWtTermAnalyst
    ? ' - <span style="font-size:9px; opacity:0.6;">worktree</span>'
    : '';
const analystDisplayName = termName || null;
const analystFallbackName = lastStartupCommands['analyst']
    ? `${lastStartupCommands['analyst'].trim().split(/\s+/)[0].toUpperCase()} CLI`
    : null;
if (analystDisplayName) {
    name.innerHTML = `ANALYST - ${esc(analystDisplayName)}${wtSegmentAnalyst}`;
} else if (analystFallbackName) {
    name.innerHTML = `ANALYST - ${esc(analystFallbackName)}${wtSegmentAnalyst}`;
} else {
    name.innerHTML = `ANALYST${wtSegmentAnalyst}`;
}
```

**Proposed:**

```js
const isWtTermAnalyst = !!(termName && lastTerminals[termName]?.worktreePath);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const wtSegmentAnalyst = isWtTermAnalyst
    ? ' - <span style="font-size:9px; opacity:0.6;">worktree</span>'
    : '';
// Mirror createAgentRow: prefer the startup-command-derived display name from 'terminalAgentNames'
// (same source as the Kanban column header), then the <CMD> CLI fallback. termName (the raw terminal
// key) is NOT used for display — only for the locate/clear handlers below.
const analystAgentName = lastAgentNames['analyst'] || null;
// Fallback derivation MIRRORS KanbanProvider._getAgentNames (KanbanProvider.ts:5528-5530):
//   path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase() + ' CLI'
const _analystCmd0 = (lastStartupCommands['analyst'] || '').trim().split(/\s+/)[0] || '';
const analystFallbackName = _analystCmd0
    ? `${_analystCmd0.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '').toUpperCase()} CLI`
    : null;
const analystDisplayName = analystAgentName || analystFallbackName || null;
if (analystDisplayName) {
    name.innerHTML = `ANALYST - ${esc(analystDisplayName)}${wtSegmentAnalyst}`;
} else {
    name.innerHTML = `ANALYST${wtSegmentAnalyst}`;
}
```

`termName` (from `findTerminalByRole(lastTerminals, 'analyst')` at line 3371) is retained for the locate/clear handlers (lines 3420-3440) and for worktree detection — unchanged.

## Verification Plan

### Automated Tests
Skipped per project convention — this is a webview display change; the extension reads `src/webview/implementation.html` directly during dev (no `npm run compile` needed; `dist/` is not used for testing, per `CLAUDE.md`). No automated test covers Agents-tab row rendering.

### Manual Verification

1. **Load:** Reload the Switchboard webview in VS Code (Task Viewer / sidebar). Confirm the Agents tab renders.

2. **Name-source parity with Kanban column (the core assertion):** With startup commands configured (e.g. coder = `agy`, planner = `devin`, lead = `agy`) and terminals opened via the **Open Terminals** button:
   - For each role, the Agents-tab row's `<name>` segment MUST equal the name shown at the top of the corresponding Kanban column header.
   - E.g. coder command `agy` → Agents tab shows `CODER - AGY CLI` and the Kanban coder column subline shows `AGY CLI`. They must match exactly.
   - This is the regression guard for the "third time" complaint: the two UIs now share one source.

3. **Pre-existing terminals (restart):** Close and reopen VS Code with agent terminals still open. Confirm the Agents tab still shows `AGY CLI` (not the raw role label) — verifies the `terminalAgentNames` re-scan path (`TaskViewerProvider.ts:16080, 16149`) feeds the display through the new handler.

4. **No terminal, command configured:** Hide/close all coder terminals but keep the coder startup command set. Agents tab coder row shows `CODER - AGY CLI` (from the `lastStartupCommands` fallback, now populated via the `startupCommands` handler). Kanban column also shows `AGY CLI`. Match.

5. **No terminal, no command:** Clear a role's startup command and close its terminal. Agents tab shows the bare role label (e.g. `REVIEWER`). Kanban column shows `No agent assigned`. Both indicate "no agent" — consistent.

6. **PLANNER rotation target preserved:** Trigger a planner dispatch and confirm the PLANNER row shows the selected rotation target terminal name (from `lastPlannerTarget` / `explicitTermName`), not the startup-command name. This is intended behavior — the row tells the user *which* terminal the cursor will use.

7. **Worktree dispatch:** Dispatch via a worktree route. The routed row shows `LEAD CODER - <routed name> - worktree` (the ` - worktree` dash segment is preserved).

8. **Locate/clear still work:** For each connected row, click **locate** (terminal focuses) and **clear** (terminal receives `/clear`). These must target the correct terminal — they use `resolvedTermName`/`termName`, unchanged by this plan. A name-display change must not break terminal targeting.

9. **Visibility & custom agents (side-effect check):** Toggle visibility checkboxes in the Kanban Agents tab (e.g. hide Intern, add a custom agent) and reload the Task Viewer. Confirm the Task Viewer Agents tab now reflects those settings (Intern hidden, custom agent shown) — verifies the `startupCommands.visibleAgents` and `customAgents` handlers. (Pre-fix, the Task Viewer tab ignored these and showed defaults.)

10. **HTML-injection sanity:** Set a startup command whose binary basename contains `<` or `&` (if practical) and confirm the Agents tab renders it as literal text, not parsed HTML (verifies `esc()` is retained on the name segment).

11. **Grep verification:** After edits, run a grep for `resolvedTermName ||` and `termName || null` in the *display* blocks of `createAgentRow`/`createAnalystRow` and confirm the raw terminal name is no longer in the display-name chain (it remains only in the locate/clear handlers). Confirm `lastAgentNames` is declared and assigned in exactly the new handler + the two render functions.

---

## Recommendation

**Complexity: 4 → Send to Coder.** Display-only bugfix in a single webview HTML file, verified root cause, no new data flows (the backend already posts all four messages; this adds only the receiving handlers and re-prioritizes the display Name source). The four changes (declare `lastAgentNames`; add four message handlers; re-route `createAgentRow` display; re-route `createAnalystRow` display) plus the fallback-formula alignment with `KanbanProvider._getAgentNames` are well-scoped for a coder-level execution pass. The fix breaks the repeat-regression cycle by anchoring the Agents-tab name to the **same backend source** the Kanban column already uses, instead of the terminal's raw role-label name, with a byte-identical fallback so the two UIs cannot diverge in the no-terminal case.

**Stage Complete:** PLAN REVIEWED

## Review Findings

In-place reviewer pass complete. All four plan changes are implemented in `src/webview/implementation.html` and match the proposed code: `lastAgentNames` declared (line 1935); four message handlers `terminalAgentNames`/`visibleAgents`/`startupCommands`/`customAgents` wired (lines 2490-2508) with payload shapes verified against `TaskViewerProvider._postSidebarConfigurationState` (lines 5012-5022) and `handleGetStartupCommands` return shape (lines 4545-4557); `createAgentRow` display chain re-routed to `lastAgentNames[roleId]` with byte-identical basename+`.exe/.cmd/.bat`-strip fallback mirroring `KanbanProvider._getAgentNames` (lines 5593-5595), `resolvedTermName` removed from display and retained only for locate/clear (lines 2886-2911); `createAnalystRow` fixed consistently (lines 3424-3439) with `termName` retained for locate/clear. Regression audit found no double-trigger, race, or orphaned-reference issues — each handler calls `renderAgentList()` once (pre-existing pattern), state is read synchronously mid-render, and `getActualTerminalAgentNames()` prunes stale entries before posting. Validation: grep confirms `lastAgentNames` has exactly 4 references (1 decl + 1 write + 2 reads) and `resolvedTermName ||` appears only in locate/clear gating (lines 2886/2898/2911), not in any display chain. No CRITICAL/MAJOR findings; no code fixes applied. Remaining risk: the explanatory comment block from the plan's proposed `createAgentRow` code was dropped in the implementation (NIT — non-functional; not re-added per no-comment-churn policy). Theoretical fallback divergence for Windows-backslash startup commands on a POSIX backend is documented and accepted by the plan.
