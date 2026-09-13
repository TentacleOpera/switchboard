# Stage 1 — The Panels Leave the Editor

kanbanColumn: CREATED

## Goal

Delete the editor panels that have a browser equivalent and redirect their commands to open the
browser on the running host's URL. The sidebar (`switchboard-view`) stays exactly as it is. This
is the first stage of the feature "VS Code Becomes a Sidebar, and Stops Being a Second Host" —
it removes duplicated UI but leaves two hosts (Stage 2 removes the second host).

### Problem analysis

**The extension's UI is worse, and it makes the browser's UI worse too.** The webviews are shared,
so they must satisfy the VS Code webview sandbox **even when served to a browser**. That sandbox
is why `confirm()` is a silent no-op, why the frozen webview API killed originator stamping, why
every page carries CSP nonces, and why the panel font stack has no symbol glyphs. A browser user
pays for constraints imposed by a host they are not running.

Removing the editor panels is the first cut: the browser already serves the same UI without the
sandbox constraints. Stage 1 is reversible and low-risk — it changes no data, no host ownership,
no database location.

## Metadata

- **Complexity:** 5
- **Tags:** refactor, ux

## User Review Required

None.

## Complexity Audit

### Routine

- Deleting `createWebviewPanel` sites in 5 providers that already have browser equivalents (7 sites total). Each is a panel-open method replaced by a `vscode.env.openExternal` call to `http://127.0.0.1:<port>/<route>`.
- Redirecting commands: every command that opened a panel keeps its palette entry and keybinding, replacing the body with a browser-open call. No command is removed (~4,000 installs have muscle memory).

### Complex / Risky

- **ConnectionsPanelProvider has no browser equivalent.** It is extension-only (absent from `src/standalone/bootstrap.ts`). "Open the browser instead" has no target. It must either be ported to the standalone host's browser surface first, or excluded from this stage and handled separately.
- **DiagramRenderer is dead code.** Not imported by `extension.ts`, `bootstrap.ts`, or any service file in `src/` (only self-references inside `src/services/DiagramRenderer.ts`). Its two `createWebviewPanel` sites are unreachable. Should be confirmed as dead and deleted outright, not ported.

## Edge-Case & Dependency Audit

### Race Conditions

- None specific to this stage. The extension is still the host; panels are just redirected.

### Security

- The browser-open call targets `127.0.0.1:<port>` — loopback only. No configurable hostname.

### Side Effects

1. **~4,000 installs have muscle memory and keybindings.** A command that silently vanishes reads as a broken upgrade. Every command must keep its palette entry; only the body changes.
2. **Marketplace discovery is the only channel of its kind.** Hollowing the extension keeps it; deleting it does not. Stage 1 keeps the extension alive — it just opens the browser instead of a panel.

### Dependencies & Conflicts

3. **ConnectionsPanelProvider** (`src/services/ConnectionsPanelProvider.ts:70`) — extension-only, no browser route. Must be ported or excluded before this stage's delete list is final.
4. **DiagramRenderer** (`src/services/DiagramRenderer.ts:55`, `:127`) — dead code, not imported anywhere. Delete outright, do not port.
5. **This stage does not depend on Stage 2.** Stage 1 works whether the extension is the host or a client — it just opens the browser on whatever host is running.

## Dependencies

- None. Stage 1 is the first stage and has no prerequisites.

## Adversarial Synthesis

Key risks: ConnectionsPanelProvider has no browser target (must be excluded or ported first), and DiagramRenderer is dead code (delete, don't port). Mitigations: exclude Connections from the delete list until ported; delete DiagramRenderer outright.

## Proposed Changes

### `src/services/KanbanProvider.ts`

- **Context:** KanbanProvider has two `createWebviewPanel` sites: the kanban board panel (line 1769) and the agent control panel (line 1884). Both have browser equivalents (`/kanban` and the agent control tab).
- **Logic:** Replace each panel-open method with a call to `vscode.env.openExternal(Uri.parse('http://127.0.0.1:<port>/kanban'))`. The port is obtained from the running `LocalApiServer` (still in-process at this stage).
- **Implementation:** Delete the `createWebviewPanel` call and the panel lifecycle code (`this._panel`, `onDidDispose`, etc.). Replace with a `_openInBrowser()` method that resolves the port and calls `openExternal`.
- **Edge Cases:** If no `LocalApiServer` is running (host not started), show a warning — do not silently fail.

### `src/services/PlanningPanelProvider.ts`

- **Context:** Two `createWebviewPanel` sites: project panel (line 676) and planning panel (line 867). Browser equivalents: `/project` and `/planning`.
- **Logic:** Same pattern as KanbanProvider — replace with `openExternal` calls.
- **Edge Cases:** Same — warn if no host is running.

### `src/services/SetupPanelProvider.ts`

- **Context:** One `createWebviewPanel` site (line 268). Browser equivalent: `/setup`.
- **Logic:** Replace with `openExternal` call to `http://127.0.0.1:<port>/setup`.
- **Edge Cases:** Setup may be needed before a host is running — if no host, the setup command should start one first (or fall back to the existing panel temporarily).

### `src/services/DesignPanelProvider.ts`

- **Context:** One `createWebviewPanel` site (line 691). Browser equivalent: `/design`.
- **Logic:** Replace with `openExternal` call to `http://127.0.0.1:<port>/design`.
- **Edge Cases:** Same — warn if no host is running.

### `src/services/TicketsPanelProvider.ts`

- **Context:** One `createWebviewPanel` site (line 1373). Browser equivalent: `/tickets`.
- **Logic:** Replace with `openExternal` call to `http://127.0.0.1:<port>/tickets`.
- **Edge Cases:** Same — warn if no host is running.

### `src/services/DiagramRenderer.ts`

- **Context:** Dead code — not imported by any file in `src/` outside itself. Two `createWebviewPanel` sites (lines 55, 127) are unreachable.
- **Logic:** Delete the file entirely.
- **Edge Cases:** Confirm no dynamic imports or `require()` calls reference it before deleting.

### `src/services/ConnectionsPanelProvider.ts`

- **Context:** Extension-only, no browser equivalent. Not in `src/standalone/bootstrap.ts`.
- **Logic:** **Do not delete in this stage.** Either port to the standalone host's browser surface first, or defer to a separate plan. If deferred, leave the `createWebviewPanel` site intact and exclude from the Stage 1 delete list.
- **Edge Cases:** If ported, the browser route must be designed and implemented before the panel is removed.

### `src/extension.ts`

- **Context:** All commands that opened panels must keep their palette entries and keybindings.
- **Logic:** No command registration changes — only the command bodies (which now call `openExternal` instead of creating a panel). Verify every command in `package.json`'s `contributes.commands` still exists after the change.
- **Edge Cases:** A command that opened a panel that no longer exists (DiagramRenderer) should be removed from `contributes.commands` — but only after confirming no keybinding references it.

## Verification Plan

### Automated Tests

> NOTE: Per the dispatching directive, compilation and automated tests are not executed in this
> review pass. The checks below remain written down for the implementer to run.

1. `npm run compile` — typecheck passes after Stage 1.
2. `npm test` — existing test suite passes.
3. `grep -c createWebviewPanel src/` returns zero outside `ConnectionsPanelProvider` (deferred) after Stage 1.

### Goal Invariants

- Assert `createWebviewPanel` is absent from `src/services/KanbanProvider.ts`, `src/services/PlanningPanelProvider.ts`, `src/services/SetupPanelProvider.ts`, `src/services/DesignPanelProvider.ts`, and `src/services/TicketsPanelProvider.ts` after Stage 1. Paired positive: assert `registerWebviewViewProvider` is present in `src/extension.ts` (the sidebar survives).
- Assert every command in `package.json`'s `contributes.commands` before Stage 1 still exists after Stage 1 (no command removed, only bodies changed).
- Assert `src/services/DiagramRenderer.ts` does not exist (dead code deleted).

### Manual Verification

1. Every command that previously opened a panel opens the browser on the running host.
2. No command has been removed from the palette.
3. The sidebar (`switchboard-view`) is unchanged and functional.

## Outstanding Questions

- **[user]** Is `DiagramRenderer` (`src/services/DiagramRenderer.ts`) confirmed dead code? It is not imported by any file in `src/` outside itself. Proceeding on the assumption that it is dead and should be deleted outright.
- **[user]** Should `ConnectionsPanelProvider` be ported to the standalone host's browser surface before Stage 1, or deferred to a separate plan? Proceeding on the assumption that it is deferred — the `createWebviewPanel` site stays intact until a browser equivalent is built.
