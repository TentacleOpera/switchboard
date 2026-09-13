# Stage 3 — The Sidebar Becomes a Host Client

kanbanColumn: CREATED

## Goal

The sidebar stops imitating the board and becomes what an editor is uniquely good at: **is the host
up, what are my seats doing, and take me to the board.** Fleet and terminal status, the current
workspace, start/attach, open in browser.

### Problem analysis

Once the extension is a client (after Stage 2), the sidebar should stop imitating the board. Its
job is not to be a second board — that is how the two-hosts problem grows back. The browser is the
board; the sidebar is the status panel.

The sidebar's unique value in an editor context:
- **Is the host up?** Show host status (running, stopped, unreachable) and offer to start/attach.
- **What are my seats doing?** Show fleet liveness — which seats are active, idle, or dead.
- **Take me to the board.** One button: open the browser on the running host's URL.
- **Current workspace.** Show which workspace the host is serving.

## Metadata

- **Complexity:** 5
- **Tags:** ux, refactor

## User Review Required

None.

## Complexity Audit

### Routine

- Replacing the sidebar's current board-imitation UI with a status panel (host status, fleet liveness, open-in-browser button).
- Fetching fleet status from the host's HTTP API (`/fleet` or equivalent endpoint).

### Complex / Risky

- **Terminal access design.** After the fleet moves to the standalone host (Stage 2), terminals a user expects to see in the editor now live in the host process. The sidebar must offer a way to reach a live terminal — either `tmux attach` (if `terminal.tmux.enabled`) or a link to the browser terminal page. This design is unresolved.
- **The sidebar must not become a second board.** Every feature added to the sidebar is a feature that could diverge from the browser. The sidebar should be read-only status, not interactive board management.

## Edge-Case & Dependency Audit

### Race Conditions

- The sidebar polls the host for status. If the host goes down mid-poll, the sidebar must show "host unreachable" — not a stale or empty state.

### Security

- The sidebar's HTTP client targets loopback only (`127.0.0.1`). No configurable hostname.

### Side Effects

1. **The sidebar is the one VS Code-native surface that remains.** It must be useful enough to justify keeping the extension installed — if it is just an "open in browser" button, the extension adds little value over a bookmark.
2. **Fleet status over HTTP.** The sidebar fetches fleet liveness from the host's API. This is a read-only view — the sidebar does not manage the fleet.

### Dependencies & Conflicts

3. **Stage 2 must land first.** The sidebar can only become a client after the extension stops being a host.
4. **Terminal access design must be resolved before Stage 2 lands** (Stage 2's Outstanding Question). This stage implements whatever that design decides.

## Dependencies

- Stage 2 (extension stops being a host) — must land first. Same feature.

## Adversarial Synthesis

Key risks: the sidebar could grow back into a second board (the exact problem this feature eliminates), and the terminal access design is unresolved. Mitigations: keep the sidebar read-only; resolve terminal access in Stage 2 before this stage implements it.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` (sidebar resolve path)

- **Context:** The sidebar's webview resolve handler (`resolveWebviewView`) currently renders a board-imitation UI. After Stage 2, it fetches state from the host over HTTP.
- **Logic:** Replace the board-imitation UI with a status panel:
  1. **Host status card:** running / stopped / unreachable, with start/attach button.
  2. **Fleet liveness card:** list of seats with status (active, idle, dead), fetched from the host's `/fleet` endpoint.
  3. **Open in browser button:** `vscode.env.openExternal(Uri.parse('http://127.0.0.1:<port>'))`.
  4. **Current workspace display:** which workspace the host is serving.
- **Implementation:** The webview HTML is simplified to a status panel. No board columns, no card lists, no drag-and-drop. The sidebar polls the host's health and fleet endpoints at a reasonable interval (e.g. 5s) and updates the status cards.
- **Edge Cases:** If the host is unreachable, show "host down" with a "start host" button. If the host is running but no seats are active, show "no seats" — not an empty board.

### `src/webview/` (sidebar HTML/JS)

- **Context:** The sidebar's webview assets (HTML, JS, CSS) currently implement a board UI.
- **Logic:** Replace with a lightweight status panel — host status, fleet list, open-in-browser button. No board rendering, no CSP nonce workarounds (the sidebar is still sandboxed, but the status panel is simple HTML that works within the sandbox).
- **Edge Cases:** `confirm()` is still a no-op in the sidebar webview — but the status panel has no delete actions, so no confirm gates are needed.

## Verification Plan

### Automated Tests

> NOTE: Per the dispatching directive, compilation and automated tests are not executed in this
> review pass. The checks below remain written down for the implementer to run.

1. `npm run compile` — typecheck passes after Stage 3.
2. `npm test` — existing test suite passes.

### Goal Invariants

- Assert `src/extension.ts` contains `registerWebviewViewProvider("switchboard-view", ...)` — the sidebar is the one VS Code-native surface that remains.
- Assert the sidebar's resolve path communicates with the host over HTTP (not via direct service construction) — e.g. assert `fetch(` or an HTTP client call targeting `127.0.0.1` is present.
- Assert the sidebar does not render board columns or card lists (it is a status panel, not a second board).

### Manual Verification

1. The sidebar shows host status (running/stopped/unreachable) with start/attach.
2. The sidebar shows fleet liveness (active/idle/dead seats).
3. The sidebar has an "open in browser" button that opens the board.
4. The sidebar does not imitate the board — no columns, no card lists, no drag-and-drop.
5. With no host running, the sidebar offers to start one and says so plainly when it cannot.
