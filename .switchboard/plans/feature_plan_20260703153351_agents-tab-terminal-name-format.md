# Fix Agents Tab Terminal Name Format (`Role - Name - worktree`)

## Goal

The **Agents tab** in `implementation.html` is broken: agent rows do not display the terminal name segment, and the worktree indicator is rendered as a parenthetical suffix instead of a separate dash-separated segment.

### Problem Analysis & Root Cause

The Agents tab renders one row per role (PLANNER, LEAD CODER, CODER, INTERN, REVIEWER, ACCEPTANCE TESTER, ANALYST, custom agents, JULES) via `createAgentRow()` and `createAnalystRow()`. The intended display format is:

```
Role - Name - worktree
```

where:
- **Role** = the role label (e.g. `PLANNER`)
- **Name** = the terminal's name (e.g. `Claude CLI`)
- **worktree** = a literal segment appended only when the routed terminal is a worktree terminal

**Root cause #1 — `lastTerminalAgentNames` is never populated.**

`lastTerminalAgentNames` is declared at `implementation.html:1913`:

```js
let lastTerminalAgentNames = {}; // Terminal-derived agent names; workspace-agnostic
```

It is **read** in three places (`implementation.html:2781`, `3378`, `3379`) but is **never written to anywhere in the file**. A grep for `lastTerminalAgentNames =` returns only the declaration. As a result, `lastTerminalAgentNames[roleId]` is always `undefined`, so the "Name" segment in `createAgentRow` (line 2780-2781) and `createAnalystRow` (line 3378-3379) is never sourced from it.

The current name-resolution logic in `createAgentRow` (`implementation.html:2780-2793`):

```js
const displayName = explicitTermName
    || (dispatchInfo && dispatchInfo.isWorktreeTerminal && dispatchInfo.terminalName ? dispatchInfo.terminalName : lastTerminalAgentNames[roleId]);

if (displayName) {
    name.innerHTML = `${label} - ${displayName}${suffix}`;
} else if (lastStartupCommands[roleId]) {
    const cmd = lastStartupCommands[roleId].trim().split(/\s+/)[0].toUpperCase();
    const termNameDisplay = dispatchInfo && dispatchInfo.isWorktreeTerminal && dispatchInfo.terminalName
        ? dispatchInfo.terminalName
        : `${cmd} CLI`;
    name.innerHTML = `${label} - ${termNameDisplay}${suffix}`;
} else {
    name.innerHTML = label + suffix;
}
```

Because `lastTerminalAgentNames[roleId]` is always `undefined`, `displayName` is only set when:
- `explicitTermName` is passed (only the PLANNER row passes `lastPlannerTarget`), or
- `dispatchInfo.isWorktreeTerminal && dispatchInfo.terminalName` is set (only when a worktree route is active).

For the common case — a non-worktree, non-planner agent that is connected via a terminal — **both branches fall through** and the row renders as just `Role` (no Name segment). This is the "broken" behavior: the terminal name (e.g. `Claude CLI`) that should appear between the role and the worktree marker is missing.

Crucially, the correct Name source is already available: `findTerminalByRole()` (line 2697-2708) returns the **terminal name key** (e.g. `"Claude CLI"`), which is exactly the "Name" segment the user wants. This value is captured into `termName` (line 2714) and `resolvedTermName` (line 2719) but is **never used as the display Name** — the displayName logic ignores it and instead consults the dead `lastTerminalAgentNames` map.

**Root cause #2 — worktree is a parenthetical suffix, not a dash segment.**

The current format builds the worktree marker as a parenthetical suffix (`implementation.html:2773-2778`):

```js
let suffix = '';
const isWtTerm = (dispatchInfo && dispatchInfo.isWorktreeTerminal) ||
    (resolvedTermName && lastTerminals[resolvedTermName]?.worktreePath);
if (isWtTerm) {
    suffix = ' <span style="font-size:9px; opacity:0.6;">(worktree)</span>';
}
```

…then renders `${label} - ${displayName}${suffix}` → `Role - Name (worktree)`.

The desired format is `Role - Name - worktree` — i.e. the worktree marker is a third dash-separated segment, not a parenthetical appended to the Name.

## Metadata

- **Tags:** `bug`, `ui`, `agents-tab`, `webview`, `implementation.html`
- **Complexity:** 3
- **Files touched:** `src/webview/implementation.html`
- **Risk:** Low — display-only change in a single webview HTML file; no state, persistence, or backend changes.

## Complexity Audit

**Routine.** This is a localized string-formatting fix in one file with two cooperating defects:

1. A dead variable (`lastTerminalAgentNames`) that is read but never written, causing the Name segment to vanish for the common case.
2. A format-string shape mismatch (parenthetical suffix vs. dash segment) for the worktree marker.

Both are addressable by re-routing the Name source to the already-computed `resolvedTermName` and re-shaping the worktree marker into a separate dash segment. No new data flows, no backend changes, no migrations. The `findTerminalByRole` helper and `resolvedTermName` already exist and are correct.

## Edge-Case & Dependency Audit

| Edge case | Handling |
| :--- | :--- |
| Agent with no connected terminal (`resolvedTermName` is null) | Must fall back to `lastStartupCommands[roleId]` → `<CMD> CLI`, then to bare `label`. Preserve existing fallback chain. |
| Worktree route via `dispatchInfo.isWorktreeTerminal` but `resolvedTermName` from `findTerminalByRole` is null | Use `dispatchInfo.terminalName` as the Name source (current code already prefers this for worktree routes). |
| PLANNER row passes `explicitTermName` (`lastPlannerTarget`) | Must keep taking precedence — it is the user-selected planner target. |
| Non-worktree terminal | No ` - worktree` segment appended; render as `Role - Name`. |
| ANALYST row (`createAnalystRow`) has its own parallel name logic | Must be fixed consistently — it also reads the dead `lastTerminalAgentNames['analyst']` and lacks the worktree segment. |
| Jules row | Unchanged — uses `name.innerText = label` (no terminal name segment by design). |
| Custom agents | Use `createAgentRow` with `customAgent.role`; fix flows through automatically. |
| `name.innerHTML` vs `name.innerText` | The worktree segment uses a `<span>` for styling, so `innerHTML` must be retained for the styled segment. The Name and Role segments are plain text and must be HTML-escaped if sourced from terminal names (terminal names are extension-controlled, but escape defensively). |
| Terminals sub-tab | Out of scope — user reported the **Agents tab** specifically. The terminals sub-tab is static HTML and unaffected. |

**Dependencies:** None. `findTerminalByRole`, `lastTerminals`, `lastDispatchReadiness`, `lastStartupCommands`, and `lastPlannerTarget` are all already in scope of `createAgentRow`/`createAnalystRow`.

## Proposed Changes

### File: `src/webview/implementation.html`

#### Change 1 — `createAgentRow`: use `resolvedTermName` as the Name source and reformat the worktree marker as a dash segment

Replace the name-resolution block at `implementation.html:2770-2796` (the `const name = document.createElement('div');` block inside `createAgentRow`).

**Current** (`implementation.html:2770-2796`):

```js
const name = document.createElement('div');
name.className = 'agent-name';
if (roleId !== 'jules') {
    let suffix = '';
    const isWtTerm = (dispatchInfo && dispatchInfo.isWorktreeTerminal) ||
        (resolvedTermName && lastTerminals[resolvedTermName]?.worktreePath);
    if (isWtTerm) {
        suffix = ' <span style="font-size:9px; opacity:0.6;">(worktree)</span>';
    }

    const displayName = explicitTermName
        || (dispatchInfo && dispatchInfo.isWorktreeTerminal && dispatchInfo.terminalName ? dispatchInfo.terminalName : lastTerminalAgentNames[roleId]);

    if (displayName) {
        name.innerHTML = `${label} - ${displayName}${suffix}`;
    } else if (lastStartupCommands[roleId]) {
        const cmd = lastStartupCommands[roleId].trim().split(/\s+/)[0].toUpperCase();
        const termNameDisplay = dispatchInfo && dispatchInfo.isWorktreeTerminal && dispatchInfo.terminalName
            ? dispatchInfo.terminalName
            : `${cmd} CLI`;
        name.innerHTML = `${label} - ${termNameDisplay}${suffix}`;
    } else {
        name.innerHTML = label + suffix;
    }
} else {
    name.innerText = label;
}
```

**Proposed:**

```js
const name = document.createElement('div');
name.className = 'agent-name';
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

Key differences:
- `resolvedTermName` is now the primary Name source for the common (non-worktree, non-planner) case — this is the terminal name key returned by `findTerminalByRole`, e.g. `"Claude CLI"`.
- The dead `lastTerminalAgentNames[roleId]` lookup is removed.
- The worktree marker becomes a ` - worktree` dash segment (with the existing styling span retained on the word `worktree` only), instead of `(worktree)` appended to the Name.
- Plain-text segments are HTML-escaped before being composed into `innerHTML`.

#### Change 2 — `createAnalystRow`: same fix, consistent format

Replace the analyst name-resolution block at `implementation.html:3376-3385`.

**Current** (`implementation.html:3376-3385`):

```js
const name = document.createElement('div');
name.className = 'agent-name';
if (lastTerminalAgentNames['analyst']) {
    name.innerText = `ANALYST - ${lastTerminalAgentNames['analyst']}`;
} else if (lastStartupCommands['analyst']) {
    const cmd = lastStartupCommands['analyst'].trim().split(/\s+/)[0].toUpperCase();
    name.innerText = `ANALYST - ${cmd} CLI`;
} else {
    name.innerText = 'ANALYST';
}
```

**Proposed:**

```js
const name = document.createElement('div');
name.className = 'agent-name';
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

Note: `termName` in `createAnalystRow` is already computed at `implementation.html:3353` via `findTerminalByRole(lastTerminals, 'analyst')`, so it is the correct Name source. `createAnalystRow` does not receive `dispatchInfo`, so the worktree determination uses `lastTerminals[termName]?.worktreePath` only (consistent with the existing `isWtTerm` check in `createAgentRow`).

#### Change 3 (optional cleanup) — remove the dead `lastTerminalAgentNames` declaration

After Changes 1 & 2, `lastTerminalAgentNames` is no longer read anywhere. Remove the declaration at `implementation.html:1913`:

```js
let lastTerminalAgentNames = {}; // Terminal-derived agent names; workspace-agnostic
```

This is a safe deletion — a grep confirms the variable has no remaining references after the two edits above. Leaving it would be misleading dead state.

## Verification Plan

1. **Build / load:** Reload the Switchboard webview in VS Code (the extension reads `src/webview/implementation.html` directly during dev — no `npm run compile` needed per project convention; `dist/` is not used for testing).

2. **Manual matrix — Agents tab:** With at least one terminal connected per role, confirm the rendered row label for each:
   - **Non-worktree terminal connected** (e.g. a `Claude CLI` terminal registered with role `coder`): row reads `CODER - Claude CLI` (no worktree segment).
   - **Worktree-routed terminal** (dispatch via an epic worktree): row reads `LEAD CODER - <terminal name> - worktree`.
   - **PLANNER row** with a selected planner target: row reads `PLANNER - <selected target>` (explicit target wins).
   - **No terminal connected, but startup command configured** (e.g. `claude` command): row reads `REVIEWER - CLAUDE CLI` (fallback).
   - **No terminal, no startup command:** row reads `INTERN` (bare label).
   - **ANALYST row** with a connected analyst terminal: row reads `ANALYST - <terminal name>`; with a worktree terminal, `ANALYST - <terminal name> - worktree`.
   - **JULES row:** unchanged — reads `JULES PARALLEL CODER` (no name/worktree segment by design).
   - **Custom agent row** with a connected terminal: reads `<CUSTOM NAME> - <terminal name>`.

3. **HTML-injection sanity:** Set a terminal name containing `<` or `&` (e.g. via the terminals sub-tab rename, if available) and confirm it renders as literal text, not as parsed HTML.

4. **No regressions in row controls:** For each row, the `locate` and `clear` buttons still fire `focusTerminal` / `sendToTerminal` with the correct `resolvedTermName` (these handlers are unchanged, but verify they still resolve the right terminal after the name-display change).

5. **Grep verification:** After edits, run a grep for `lastTerminalAgentNames` in `src/webview/implementation.html` and confirm zero matches (Change 3) — this proves the dead variable is fully removed and no stale reads remain.
