# Kanban Column Header Terminal Names → Locate Links

## Goal

Make the terminal names shown in the kanban column header sublines (e.g. "DEVIN CLI", "CODER CLI", or the live terminal display name) behave like the **locate** buttons in the implementation.html agents tab — clicking the name focuses the corresponding terminal in the integrated terminal panel.

For the synthetic **AUTOCODE / CODED_AUTO** column (dynamic routing), there is no single owning agent. Clicking its subline must dynamically route to the **most senior terminal currently alive**, in the order: **lead → coder → intern**.

### Problem Analysis & Root Cause

**Symptom:** The kanban column header renders the agent/terminal name as inert plain text. Users cannot jump to the terminal from the board; they must open the Implementation tab and click a per-row `locate` button, or open the Autoban panel and click `FOCUS`.

**Root cause:** In `src/webview/kanban.html`, `updateAllColumnAgents()` (line ~5075) writes the agent name via `el.textContent = name`. The element is a passive `<div class="column-agent">` with no click handler and no cursor styling. The `focusTerminal` message path already exists in the webview (`postKanbanMessage({ type: 'focusTerminal', terminalName })`) and is already handled by `KanbanProvider.ts` (line ~7570) which forwards to `switchboard.focusTerminalByName`. So the backend wiring is complete — only the webview click binding is missing.

**Complication — display name vs terminal name:** `lastAgentNames[role]` is a *display* name. For configured-only agents it is `${BINARY} CLI` (e.g. "DEVIN CLI") produced in `KanbanProvider._getAgentNames` (line ~4567). For live terminals it is `info.displayName` from `TaskViewerProvider.getActualTerminalAgentNames()` (line ~597), which is **not** the same as the VS Code terminal name that `focusTerminalByName` needs. Therefore the subline cannot simply forward `lastAgentNames[role]` as the `terminalName`. It must resolve the role to a real terminal name from `lastTerminals` (keyed by terminal name, each entry carrying `.role` and `.worktreePath`), exactly as implementation.html's `findTerminalByRole` does (line ~2697).

**Dynamic-routing column:** `CODED_AUTO` is synthetic (no `role` in its column definition). `updateAllColumnAgents` hard-codes its subline to the literal string "Dynamic routing" (line ~5098). To make it a locate link we must, on click, scan `lastTerminals` for an alive entry whose `role` is `lead`, then `coder`, then `intern`, and focus the first match — mirroring the seniority order already encoded in `routingMapConfig` (line ~3904: `lead` > `coder` > `intern`).

## Metadata

- **Tags:** kanban, webview, ux, terminal-focus, dynamic-routing
- **Complexity:** 4
- **Files touched:** `src/webview/kanban.html`
- **Project:** switchboard

## Complexity Audit

**Routine.** The change is confined to a single webview file and a single rendering function (`updateAllColumnAgents`), plus a small CSS addition for the clickable affordance. No backend, state, persistence, or migration changes — the `focusTerminal` message handler already exists in `KanbanProvider.ts` and `TaskViewerProvider._focusTerminalByName`. No new dependencies.

The only non-trivial logic is the seniority resolution for `CODED_AUTO`, which is a straightforward ordered scan of `lastTerminals` reusing the liveness pattern already present in `resolveTerminalLiveness` (line ~8017).

## Edge-Case & Dependency Audit

| Case | Handling |
|------|----------|
| No live terminal for a role (configured-only, e.g. "DEVIN CLI" with no terminal open) | `lastTerminals` has no matching entry → subline renders as plain text (non-interactive, no underline/cursor). No `focusTerminal` posted. |
| Role hidden via `lastVisibleAgents[role] === false` or name === `'No agent assigned'` | Existing branch keeps the italic "No agent assigned" text. Must remain non-clickable. |
| `CODED_AUTO` with no alive lead/coder/intern terminal | Subline stays as "Dynamic routing" plain text; click is a no-op (or disabled). |
| Worktree terminals should be preferred | Reuse `findTerminalByRole` semantics: prefer entries with `worktreePath` set, fall back to any matching role. |
| Chat-only agents (`_isChat && !_isLocal`) | Mirror implementation.html: do not bind a locate action for chat-only terminals (no local terminal to focus). |
| `lastTerminals` not yet populated (early load before `terminals` message) | `findTerminalByRole` returns `null` → subline is plain text. `updateAllColumnAgents` is re-run on `terminals` message (existing flow calls it via `updateAllColumnAgents` after terminal state changes), so the link activates once terminals arrive. |
| Clicking should not trigger column drag/select handlers | Use `event.stopPropagation()` on the click handler and render the subline as a nested `<a>`/`<span>` rather than replacing the whole header cell. |
| `agentNames` refresh after terminal starts/stops | `updateAllColumnAgents` already re-runs on `updateAgentNames` and `terminals` messages; the click binding is recomputed each render, so staleness is not a concern. |
| VS Code webview `confirm()` ban (project rule) | No confirm dialogs are introduced. |

**Dependencies:** None new. Relies on existing `lastTerminals`, `lastAgentNames`, `lastVisibleAgents`, `columnToRole`, `postKanbanMessage`, and the `focusTerminal` message handler.

## Proposed Changes

### File: `src/webview/kanban.html`

#### 1. Add a `findTerminalByRole` helper (mirror of implementation.html line ~2697)

Place near `columnToRole` (around line ~5054):

```js
/** Resolve a role to a live terminal name, preferring worktree terminals (mirrors implementation.html). */
function findTerminalByRole(role) {
    if (!role || !lastTerminals) return null;
    const entries = Object.entries(lastTerminals);
    const worktreeMatch = entries.find(([, info]) =>
        info && info.role === role && info.worktreePath
    );
    if (worktreeMatch) return worktreeMatch[0];
    const anyMatch = entries.find(([, info]) => info && info.role === role);
    return anyMatch ? anyMatch[0] : null;
}

/** True if a terminal name corresponds to a chat-only (non-local) agent. */
function isChatOnlyTerminal(termName) {
    const info = termName ? lastTerminals[termName] : null;
    return !!(info && info._isChat && !info._isLocal);
}
```

#### 2. Add a seniority resolver for the dynamic-routing column

```js
/** For CODED_AUTO (dynamic routing): resolve the most senior alive terminal. Order: lead → coder → intern. */
function findMostSeniorRoutedTerminal() {
    const SENIORITY = ['lead', 'coder', 'intern'];
    for (const role of SENIORITY) {
        const entries = Object.entries(lastTerminals || {});
        // Prefer worktree, then any alive terminal of this role.
        const worktree = entries.find(([, info]) =>
            info && info.role === role && info.worktreePath && isTerminalAlive(info));
        if (worktree) return worktree[0];
        const any = entries.find(([, info]) =>
            info && info.role === role && isTerminalAlive(info));
        if (any) return any[0];
    }
    return null;
}

function isTerminalAlive(info) {
    if (!info) return false;
    const HEARTBEAT_MS = 60_000;
    const lastSeenMs = Date.parse(info.lastSeen || '');
    const heartbeatAlive = !isNaN(lastSeenMs) && (Date.now() - lastSeenMs) < HEARTBEAT_MS;
    return info.alive !== undefined ? !!info.alive : (info._isLocal || heartbeatAlive);
}
```

> Note: `resolveTerminalLiveness` (line ~8017) is scoped inside the autoban panel render closure, so it cannot be reused directly. `isTerminalAlive` is a small top-level helper that replicates its liveness rule. If preferred, `resolveTerminalLiveness` can be hoisted to top-level instead — either approach is acceptable; hoisting is cleaner but touches the autoban panel code path. The plan keeps the new helper to minimise blast radius.

#### 3. Rewrite `updateAllColumnAgents` to render a clickable subline when a terminal is resolvable

Replace the body of `updateAllColumnAgents` (lines ~5075–5101):

```js
function updateAllColumnAgents() {
    if (!lastAgentNames) return;

    columns.forEach(col => {
        const el = document.getElementById('agent-' + col);
        if (!el) return;
        const role = columnToRole(col);
        const name = lastAgentNames[role];

        if (role && (lastVisibleAgents[role] === false || name === 'No agent assigned')) {
            renderAgentSubline(el, 'No agent assigned', null, { italic: true, warning: true });
            return;
        }

        const termName = findTerminalByRole(role);
        const chatOnly = isChatOnlyTerminal(termName);
        const focusable = termName && !chatOnly;
        renderAgentSubline(el, name || '', focusable ? termName : null);
    });

    // Synthetic CODED_AUTO column — dynamic routing to most senior alive terminal.
    const autoRouteEl = document.getElementById('agent-CODED_AUTO');
    if (autoRouteEl) {
        const routed = findMostSeniorRoutedTerminal();
        renderAgentSubline(autoRouteEl, 'Dynamic routing', routed, { dim: true });
    }
}

/** Render the column-agent subline. If `focusTermName` is non-null, make it a clickable locate link. */
function renderAgentSubline(el, label, focusTermName, opts = {}) {
    el.innerHTML = '';
    el.style.color = '';
    el.style.fontStyle = '';
    el.classList.remove('column-agent-link');

    if (!label) { el.textContent = ''; return; }

    if (opts.warning) {
        el.style.color = 'var(--vscode-editorWarning-foreground, #cca700)';
    }
    if (opts.italic) {
        el.style.fontStyle = 'italic';
    }

    if (focusTermName) {
        const link = document.createElement('a');
        link.className = 'column-agent-link';
        link.href = '#';
        link.textContent = label;
        link.title = `Locate terminal: ${focusTermName}`;
        link.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            postKanbanMessage({ type: 'focusTerminal', terminalName: focusTermName });
        });
        el.appendChild(link);
    } else {
        el.textContent = label;
        if (opts.dim) el.style.opacity = '0.8';
    }
}
```

#### 4. Add CSS for the locate-link affordance

Add inside the existing `.column-agent` rule block (around line ~712):

```css
.column-agent .column-agent-link {
    color: inherit;
    text-decoration: none;
    cursor: pointer;
}
.column-agent .column-agent-link:hover {
    text-decoration: underline;
    opacity: 1;
}
```

## Verification Plan

1. **Build / load:** Reload the Switchboard extension webview (no `npm run compile` needed for dev — `src/` is the source of truth). Open the Kanban tab.
2. **Regular column — live terminal:**
   - Start a lead coder terminal (e.g. dispatch a plan or open the configured CLI).
   - Confirm the LEAD CODED column subline shows the terminal display name **underlined on hover** with a pointer cursor.
   - Click the subline → the corresponding terminal is focused/revealed in the terminal panel.
3. **Regular column — configured only (no live terminal):**
   - With no terminal running for a role, confirm the subline shows e.g. "DEVIN CLI" as **plain non-interactive text** (no underline, default cursor). Clicking does nothing.
4. **Hidden / unassigned role:**
   - Disable a role via `lastVisibleAgents` (toggle in Setup) or leave a role unconfigured → subline shows italic "No agent assigned", non-clickable.
5. **Chat-only agent:**
   - For a chat-only (non-local) agent role, confirm the subline is plain text (no locate link), mirroring implementation.html's `isChatOnly` gating.
6. **Dynamic routing (CODED_AUTO):**
   - With coders collapsed (AUTOCODE column visible) and a **lead** terminal alive → click "Dynamic routing" → lead terminal focuses.
   - Kill the lead terminal, keep a **coder** alive → click → coder terminal focuses.
   - Kill coder, keep an **intern** alive → click → intern terminal focuses.
   - Kill all of lead/coder/intern → subline shows "Dynamic routing" as plain non-interactive text; click is a no-op.
7. **Worktree preference:**
   - With both a main-workspace lead terminal and a worktree lead terminal alive → clicking the LEAD CODED subline focuses the **worktree** terminal (matches implementation.html `findTerminalByRole` preference).
8. **No regressions:**
   - Confirm column drag-and-drop, card selection, and the existing autoban-panel FOCUS buttons still work (the subline click uses `stopPropagation` and is a nested element, so it must not interfere with header/column interactions).
   - Confirm `updateAllColumnAgents` still runs on `updateAgentNames` and `terminals` messages (link activates as soon as a terminal appears).
