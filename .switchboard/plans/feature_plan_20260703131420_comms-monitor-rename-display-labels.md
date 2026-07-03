# Rename "MCP Monitor" to "Comms Monitor" (Display Labels Only)

## Goal

Rename all user-facing displays of "MCP Monitor" to "Comms Monitor" across the extension UI. The internal role key `mcp_monitor`, config field `mcpMonitor`, terminal-matching logic, and persisted state keys must remain unchanged — this is a **display-label-only rename** to reflect that the feature monitors communications (Slack, Gmail, Calendar), not "MCP" (which is the transport mechanism, not the user-facing purpose).

### Problem Analysis & Root Cause

**Symptom:** The feature is called "MCP Monitor" everywhere in the UI, but "MCP" is an implementation detail (Model Context Protocol — the transport used to talk to Slack/Gmail/Calendar servers). Users don't think in terms of "MCP"; they think "this monitors my comms." The name is confusing and doesn't communicate the feature's purpose.

**Root cause:** The name was chosen early to reflect the technical mechanism. The internal role key `mcp_monitor` is now baked into:
- Persisted config (`~/.switchboard/integration-config.json` → `mcpMonitor` field, `targetRole: 'mcp_monitor'`)
- Terminal state (`state.terminals[key].role = 'mcp_monitor'`)
- Agent visibility config (`visibleAgents.mcp_monitor`)
- Startup command fallback lookup (`getAgentStartupCommand('mcp_monitor')`)
- Safety invariant checks (`role === 'mcp_monitor'`)
- `sharedDefaults.js` (`DEFAULT_VISIBLE_AGENTS.mcp_monitor`, `BUILT_IN_AGENT_LABELS`)

Renaming the internal key would break **all existing installs** — their persisted config references `mcp_monitor`, their terminal state has `role: 'mcp_monitor'`, and the code looks up startup commands by that key. Per the project's migration rules (CLAUDE.md): state that shipped in a released version MUST be migrated on change. A key rename would require a full migration of config files, state files, and visibility settings across ~4,000 installs — high risk, low value.

**Decision: display-only rename.** The internal key `mcp_monitor` stays. Only the human-readable labels shown in the UI change to "Comms Monitor". This is zero-risk to existing installs because no persisted key changes.

**Clarification (verified against current code, 2026-07-03):** the string literal `'MCP Monitor'` is not merely a label — it is also the **terminal NAME**, and that name is used as a *de-facto lookup key* by two independent matching mechanisms across two files, and it derives the `state.terminals` map key. This means the rename is not "pure display": the name literal must be changed **atomically** everywhere or the grid-disposal logic will orphan/dispose the monitor terminal. See the Complex / Risky audit and the shared-surface note below.

## Metadata

- **Tags:** ux, refactor
- **Complexity:** 3
- **Project:** switchboard
- **Repo:** (root workspace — not a bare sub-repo)
- **Files touched:** `src/webview/sharedDefaults.js`, `src/webview/kanban.html`, `src/services/TaskViewerProvider.ts`, `src/extension.ts`

> Original tags `comms-monitor, mcp-monitor, rename, display-only` were outside the allowed tag list and have been mapped to `ux, refactor`. The original intent (a UX-driven rename refactor) is preserved.

## User Review Required

- **Naming of the neutral strings (decision needed):** The status line, launch button, and help text in `kanban.html` **already** read generic "Monitor" (not "MCP Monitor") in the current code — see corrected anchors below. So they already satisfy the "remove MCP" goal. **Decision for the reviewer/user:** do we (a) leave them as generic "Monitor", or (b) upgrade them to "Comms Monitor" for positive, consistent branding? This plan recommends (b) for consistency, but it is a copy choice, not a correctness requirement.
- **Shared terminal-name literal:** Because `'MCP Monitor'` is a cross-file lookup key (not just a label), this plan recommends — but does NOT implement — centralizing it as a single exported constant (e.g. `MCP_MONITOR_TERMINAL_NAME`) shared by `TaskViewerProvider.ts` and `extension.ts`. That refactor should be coordinated at the epic level because sibling subtasks add new lookups against the same name. Approve before centralizing.
- **Code comments / log strings** (`// MCP Monitor Row`, `[MCP Monitor] Tick failed`): cosmetic, developer-facing. This plan renames them for consistency but they can be skipped without user impact — confirm you want them touched.

## Complexity Audit

### Routine
- Straightforward string replacement of display labels in four files.
- No schema changes, no migrations, no logic redesign.
- Reuses existing patterns; each edit is mechanical.
- The only label-only edits (truly zero-risk): `sharedDefaults.js:47` label, `kanban.html:7603` (`'MCP MONITOR:'`), `kanban.html:7775` (description text), and `TaskViewerProvider.ts:16517` (`displayName` ternary — display string used for messaging only).

### Complex / Risky
- **The terminal-name literal `'MCP Monitor'` is a shared lookup key, not a plain label.** It is consumed by **two different matching mechanisms in two files** and it **derives a persisted-state map key**:
  - `TaskViewerProvider.ts` matches via `_normalizeAgentKey(_stripIdeSuffix('MCP Monitor'))` at three sites: `_mcpMonitorTick` (line 20518), `launchMcpMonitorTerminal` (`targetName`, line 20605), `_isMcpMonitorTerminalRunning` (line 20686).
  - `extension.ts` matches via a **regex** `matchesGridAgentName(t, 'MCP Monitor')` (line 2724) and by literal in `registeredTerminals.delete('MCP Monitor')` (lines 2729–2730), plus the agent-grid push name (line 2650) and `agentNames.add('MCP Monitor')` (line 2707).
  - `launchMcpMonitorTerminal` uses `this._suffixedName(targetName)` as the **key into `state.terminals`** (line 20648), so changing `targetName` changes the persisted map key too.
- **Atomicity requirement:** if the creation name changes to "Comms Monitor" but any lookup or the grid-disposal path still says "MCP Monitor", the hidden-grid cleanup in `extension.ts` (the `if (!includeMcpMonitor)` branch, lines 2723–2731) will fail to dispose or, worse, the tick/running-check will never find the live terminal. All name sites across both files must change in a single commit.
- **Two matching subsystems keyed off one literal** (normalize-based vs regex-based) — a reviewer must confirm both are updated; grepping only one file is insufficient.
- Mitigation: exhaustive grep audit across `src/` (both files), plus the verification greps below. Recommend centralizing the literal in a follow-up (epic-coordinated) to remove the atomicity footgun permanently.

## Edge-Case & Dependency Audit

### Race Conditions
- None introduced. The rename does not change timing, the tick loop, or the in-flight/debounce guards. The only ordering constraint is *edit-time* atomicity (all name sites in one change), not runtime.

### Security
- None. No permission, auth, or command-execution surface changes. The startup-command fallback (`TaskViewerProvider.ts:3900`, keyed on `role === 'mcp_monitor'`) is untouched.

### Side Effects
- **Existing live terminals named "MCP Monitor":** After the rename, the tick + running-check look for "Comms Monitor". A terminal from a pre-rename session named "MCP Monitor" won't be found → tick skips it (dead-terminal guard). The user clicks "Launch" again → a new "Comms Monitor" terminal is created. One-time inconvenience, no data loss.
- **Persisted terminal state map key derives from the name.** `state.terminals` is keyed by `_suffixedName(targetName)` (line 20648). Changing `targetName` to "Comms Monitor" means a new map entry is created on next launch; the old `MCP Monitor` entry becomes an orphaned/stale record. It is harmless (only read for display/registration; role-based lookups use `role: 'mcp_monitor'` which is unchanged), but note it is **not** purely a `friendlyName` display field as the original draft implied — the name also feeds the map key. No migration is required because the entry is re-created on launch and the stale one is inert. (Clarification vs. original draft, which described only `friendlyName` as affected.)
- **`friendlyName` field** (line 20652) is set from `targetName`, so it updates automatically to "Comms Monitor". Existing state with `friendlyName: 'MCP Monitor'` is harmless (display-only).
- **Agent grid label:** `BUILT_IN_AGENT_LABELS` in `sharedDefaults.js:47` — `key` stays `'mcp_monitor'`; only `label` changes.
- **Console log / error messages:** `[MCP Monitor] Tick failed` (line 20507) is developer-facing; renaming to `[Comms Monitor]` is cosmetic. The startup-command fallback log (line 3902) already reads `Applied mcp_monitor fallback command` (key form, no display text) — leave as-is for code-searchability.
- **No `confirm()` dialogs introduced.**

### Dependencies & Conflicts
- **Shared surface — the `'MCP Monitor'` name literal** is touched by several sibling subtasks in this epic (they add *new* lookups/UI against the monitor terminal). Sibling plans most likely to collide: `dedicated-tab`, `stuck-running-status-and-stop-control`, `separate-terminal-auth-polling`, `per-source-intervals` (all touch the AUTOMATION monitor panel and/or the terminal lifecycle). If they add references to `'MCP Monitor'` after this plan lands, those references will be stale. **Recommendation (do not implement here):** promote the literal to a shared exported constant and coordinate the swap at the epic level so every subtask references the constant rather than the string. Flag this to the epic owner.
- No new npm/runtime dependencies. `GlobalIntegrationConfigService.ts` field `mcpMonitor` (line 15) and `targetRole: 'mcp_monitor'` default (line 50) are unchanged.

## Dependencies

- None identified (`sess_XXXXXXXXXXXXX` — no upstream planning session this plan depends on). Cross-subtask coordination is a *recommendation*, not a hard dependency — this plan is independently shippable if executed atomically.

## Adversarial Synthesis

**Risk Summary:** The single real risk is that `'MCP Monitor'` is a cross-file terminal-name lookup key (two matching mechanisms in `TaskViewerProvider.ts` and `extension.ts`, plus it derives the `state.terminals` map key) — not a plain label — so a partial rename silently breaks grid disposal or the "is-running" check. Mitigation: change every name site atomically in one commit and run the verification greps against both files; do not centralize the literal in this pass (recommend it to the epic owner instead). Secondary, benign risk: an orphaned pre-rename terminal-state entry and a stale live terminal, both self-healing on next Launch — no migration needed.

## Proposed Changes

> **Line anchors below were re-verified against current code on 2026-07-03 and CORRECTED — the original draft's numbers had drifted by ~90–100 lines in `TaskViewerProvider.ts` and ~3 lines in `extension.ts`, and several `kanban.html` targets referenced strings that no longer exist.**

### 1. `src/webview/sharedDefaults.js` — update the agent label

Line 47:

```js
    { key: 'mcp_monitor', label: 'Comms Monitor' }
```

### 2. `src/webview/kanban.html` — update display labels

- **Line 7603** (was drafted as 7777): `mcpLabel.textContent = 'COMMS MONITOR:';`
- **Line 7775** (was drafted as 7949): `mcpDesc.textContent = 'The Comms Monitor periodically pings a dedicated Claude terminal to check your Slack, Gmail, and Google Calendar for new messages and events — so you don\'t have to open those apps manually. Results appear in the monitor terminal pane.';`
- **Status line / launch button / help text — CORRECTION:** the draft targeted lines 7884/7886/7888/7903 with strings like `'🟢 MCP Monitor terminal: running'` and `'Launch MCP Monitor Terminal'`. **Those strings do not exist in the current code.** The current code already reads generic "Monitor" with no "MCP" prefix:
  - Line 7710: `statusLine.innerHTML = '🟢 <strong>Monitor terminal:</strong> running';`
  - Line 7712: `statusLine.innerHTML = '🔴 <strong>No monitor terminal running.</strong>';`
  - Line 7714: `launchBtn.textContent = 'Launch Monitor Terminal';`
  - Line 7729 (help text): already MCP-label-free — reads "...sends a prompt to your monitor terminal..." and "...via your claude.ai MCP servers..." (note: "MCP servers" here is a correct technical term, NOT the feature label — leave it).
  - **Recommended (copy decision — see User Review Required):** for positive branding, change these three to "Comms Monitor terminal" / "No Comms Monitor terminal running." / "Launch Comms Monitor Terminal". If the reviewer prefers minimal churn, they can be left as generic "Monitor" since they already contain no "MCP" label.
- **Code comments (cosmetic, optional):** lines 7599 (`// MCP Monitor Row`), 7621 (`// MCP Monitor Config Panel`), 7777 (`// Append MCP Monitor components...`). Rename to "Comms Monitor" for consistency or skip — no user impact.

### 3. `src/services/TaskViewerProvider.ts` — update terminal name and display strings

- **Line 20605** (was drafted as 20513): `const targetName = 'Comms Monitor';`  *(inside `launchMcpMonitorTerminal`)*
- **Line 20518** (was drafted as 20426): `const strippedTarget = this._normalizeAgentKey(this._stripIdeSuffix('Comms Monitor'));`  *(inside `_mcpMonitorTick`)*
- **Line 20686** (was drafted as 20594): `const strippedTarget = this._normalizeAgentKey(this._stripIdeSuffix('Comms Monitor'));`  *(inside `_isMcpMonitorTerminalRunning`)*
- **Line 16517** (was drafted as 16425): `const displayName = role === 'jules_monitor' ? "Jules Monitor" : "Comms Monitor";`
- **Line 20652** (was drafted as 20560): `state.terminals[key].friendlyName = targetName;` — already uses the `targetName` variable, so it updates **automatically** once `targetName` is renamed. **No literal edit needed here — but note (correction):** the same `targetName` also feeds the map key at **line 20648** (`const key = this._suffixedName(targetName)`), so the persisted-state key changes too (see Side Effects). Verify, do not hand-edit line 20648.
- **Line 20507** (was drafted as 20415): `console.error('[Comms Monitor] Tick failed:', err);` *(cosmetic, developer-facing)*
- **Line 3902 (was drafted as 3893) — CORRECTION:** the current log already reads `Applied mcp_monitor fallback command` (key form only, no display text). The draft's proposed edit is moot. **Leave unchanged** for code-searchability; the `role === 'mcp_monitor'` guard at line 3900 stays.

### 4. `src/extension.ts` — update the agent-grid name (all name sites, atomically)

- **Line 2650** (was drafted as 2647): `agents.push({ name: 'Comms Monitor', role: 'mcp_monitor' });`  *(role key stays `mcp_monitor`)*
- **Line 2707** (was drafted as 2675): `if (!includeMcpMonitor) { agentNames.add('Comms Monitor'); }`
- **Line 2724** (was drafted as 2692): `const mcpMatches = vscode.window.terminals.filter(t => t.exitStatus === undefined && matchesGridAgentName(t, 'Comms Monitor'));`
- **Line 2726** (was drafted as 2694): `outputChannel?.appendLine(\`[Extension] Disposing hidden grid terminal '${terminal.name}' for agent 'Comms Monitor'\`);`
- **Line 2729** (was drafted as 2697): `registeredTerminals.delete('Comms Monitor');`
- **Line 2730** (was drafted as 2698): `registeredTerminals.delete(suffixedName('Comms Monitor'));`

> **Atomicity note:** the name in `extension.ts` (agent-grid push + disposal) and the name in `TaskViewerProvider.ts` (creation + tick + running-check) MUST match after the change, or the grid cleanup path (`if (!includeMcpMonitor)`) will fail to find/dispose the terminal and the tick will never target it. Change all of §3 and §4 together.

### What does NOT change (verification checklist — anchors re-verified)

- `GlobalIntegrationConfigService.ts`: `mcpMonitor` field (line 15), `targetRole: 'mcp_monitor'` default (line 50) — **unchanged**.
- `sharedDefaults.js` line 13: `mcp_monitor: false` in `DEFAULT_VISIBLE_AGENTS` — **unchanged** (key, not label).
- `TaskViewerProvider.ts` line 3940 (was drafted as 3931): `mcp_monitor: false` in defaults — **unchanged**.
- `TaskViewerProvider.ts` line 3900 (was drafted as 3891): `if (role === 'mcp_monitor' && ...)` fallback guard — **unchanged**.
- `TaskViewerProvider.ts` line 16515 (was drafted as 16423): `if (role === 'jules_monitor' || role === 'mcp_monitor')` safety invariant — **unchanged**.
- `TaskViewerProvider.ts` line 20628 (was drafted as 20536): `await this.setVisibleAgent('mcp_monitor', true);` — **unchanged**.
- `TaskViewerProvider.ts` line 20651 (was drafted as 20559): `state.terminals[key].role = 'mcp_monitor';` — **unchanged**.
- `TaskViewerProvider.ts` line 20659 (was drafted as 20567): `await this.getAgentStartupCommand('mcp_monitor');` — **unchanged**.
- `extension.ts` line 2641: `const includeMcpMonitor = visibleAgents.mcp_monitor !== false;` — **unchanged** (reads the visibility key).
- Command ID `'switchboard.launchMcpMonitorTerminal'` (registration + KanbanProvider references) — **unchanged** (renaming it would break keybindings/external references; the command is internal).
- The kanban message types `launchMcpMonitorTerminal`, `setMcpMonitorConfig`, `updateMcpMonitorConfig` (kanban.html + provider) — **unchanged** (wire-protocol strings, not display).

## Verification Plan

### Automated Tests
- **Build:** `npm run compile` (webpack) succeeds with no type errors. (Note per CLAUDE.md: `dist/` is not used in dev/test; compile only validates types here.)
- **Grep audit — no stray "MCP Monitor" display labels remain:**
  - `grep -rn "MCP Monitor" src/` should return only acceptable matches: the command ID substring `launchMcpMonitorTerminal`, the `GlobalIntegrationConfigService.ts` doc comment (line 12, optional), and any intentionally-kept `MCP servers` technical references — **zero** display-label matches.
  - `grep -rn "MCP MONITOR" src/` should return **zero** matches.
- **Grep audit — internal keys preserved (must be unchanged count):**
  - `grep -rn "'mcp_monitor'" src/` returns the **same** matches as before the rename (config lookups, state role, startup command, safety checks, visibility default).
  - `grep -rn "mcpMonitor" src/services/GlobalIntegrationConfigService.ts` is **unchanged**.
- **Grep audit — name consistency across the two files (footgun check):**
  - `grep -rn "'Comms Monitor'" src/services/TaskViewerProvider.ts src/extension.ts` — confirm the creation name (TaskViewerProvider) and every grid/disposal reference (extension.ts) both use the new literal; no lingering `'MCP Monitor'` name literal in either file.

### Manual
1. **AUTOMATION tab label:** Open the kanban AUTOMATION tab. Dropdown label reads "COMMS MONITOR:". Description text says "Comms Monitor". (If option (b) chosen) launch button reads "Launch Comms Monitor Terminal".
2. **Terminal name:** Click Launch. The created terminal is named "Comms Monitor" in the VS Code terminal panel. Status line updates to the running state.
3. **Grid consistency (critical footgun test):** With the monitor visible, confirm the agent grid does NOT dispose the freshly-launched "Comms Monitor" terminal (proves `extension.ts` name matching was updated in lockstep). Then toggle monitor visibility off and confirm the hidden-grid cleanup disposes it (proves the `if (!includeMcpMonitor)` disposal path matches the new name).
4. **Agent grid label:** If the agent grid is visible, the monitor tile is labeled "Comms Monitor".
5. **Existing installs (migration safety):**
   - Install with pre-existing `~/.switchboard/integration-config.json` containing `mcpMonitor` config: config is still read correctly (field name unchanged); monitor enables, interval + sources persist.
   - Install with a live pre-rename terminal named "MCP Monitor": tick does not find it (expected — name mismatch); clicking Launch creates a new "Comms Monitor" terminal that ticks correctly. Confirm no crash from the orphaned old `state.terminals` entry.
6. **Regression:** The `switchboard.launchMcpMonitorTerminal` command ID is unchanged — existing keybindings/external command references still work.

---

**Recommendation: Send to Intern.** Complexity 3 (routine, 1-3 band). The edits are mechanical string swaps, but they MUST be applied atomically across `TaskViewerProvider.ts` and `extension.ts` because the terminal-name literal is a shared cross-file lookup key — the intern must not stop after editing one file. Run the name-consistency grep and the grid-disposal manual test before marking done.
