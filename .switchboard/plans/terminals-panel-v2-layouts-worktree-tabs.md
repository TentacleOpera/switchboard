# Terminals Panel v2: Layouts, Per-Worktree Tabs, Completion Messages

## Goal

Turn the Terminals panel from a functional terminal list into the reason to use the browser cockpit: split-pane layouts, tabs grouped per worktree, and agent completion notifications. These are the capabilities a terminal surface Switchboard owns can offer and VS Code's terminal panel structurally cannot.

Needs *a* PTY host, not a specific one — it works against standalone today and gains reach when `extension-host-pty-fleet-and-packaging.md` lands. Independently shippable either way.

### Problem analysis / root cause

The v1 panel (`src/webview/terminals.html` / `terminals.js`) is deliberately minimal: a sidebar list of fleet terminals, one xterm instance per terminal created lazily and kept alive, a role picker, inline rename, and immediate close. One terminal is visible at a time — `.terminal-view-host.active` toggles display, so switching terminals hides the previous one entirely.

That is parity with a VS Code terminal panel, not an improvement on it, so it does not yet justify the browser surface. The three things that do:

- **Layouts.** Watching four agents work in parallel is the actual multi-agent use case, and it is impossible when only one terminal renders at a time. VS Code can split terminals but cannot persist a named arrangement per project.
- **Per-worktree tabs.** Fleet terminals already carry `worktreePath` (registered by `PtyFleetService.create`), and dispatch already resolves a worktree per plan via `matchWorktreePath`. The panel currently ignores that field entirely, so a user running three worktrees sees one flat list with no indication of which agent is in which checkout.
- **Completion messages.** Completion is already detected — plan-file mtime advance clears `dispatched_at` (`KanbanDatabase.ts:9218-9224`), which is what drives the board's activity light. The panel does not surface it, so a user watching terminals has to look back at the board to learn an agent finished.

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, feature
**Project:** Browser Switchboard

## User Review Required

- None. Layout set, grouping behaviour and notification style are decided below.

## Complexity Audit

### Routine
- Grouping the existing list by `worktreePath` — the field is already served by `ptyListTerminals`.
- Reusing the established `terminalsChanged` hub broadcast for live list updates.
- Theme fan-out already works and needs no change.

### Complex / Risky
- Multiple simultaneously-visible xterm instances multiply the fit/resize problem: every layout change resizes N terminals, each firing a `{t:'resize'}` frame. The existing debounced `ResizeObserver` is per-instance and will fire in a burst.
- xterm renders nothing useful at very small sizes; a 4-pane layout in a narrow window needs a minimum-size floor or the panes are unusable.
- Layout persistence must survive reload without pinning a layout to terminals that no longer exist.
- Completion detection is server-side state; the panel needs a push it currently does not receive.

## Edge-Case & Dependency Audit

**Race Conditions**
- Terminal exits while in a multi-pane layout: the pane must go read-only (v1 already latches `entry.exited`) without collapsing the layout and reflowing its siblings unexpectedly.
- A layout referencing a killed terminal on reload — resolve against the live fleet list and drop stale slots rather than rendering empty panes.
- Rapid create/close churn already has last-write-wins list rendering in v1; grouping must not reintroduce an ordering race.

**Security**
- Completion messages must not interpolate raw agent output into the DOM. v1's rule stands: terminal bytes go only to `term.write()`, never to `innerHTML`. Notification text comes from board state (plan title, role), not from the terminal stream.

**Side Effects**
- N visible xterm instances parse and render continuously; v1 already accepted keep-alive CPU cost for hidden terminals, and a layout makes several of them *visible* and actively rendering. Worth measuring before assuming it is free.
- Browser notification permission (if used) is a user-visible prompt.

**Dependencies & Conflicts**
- Frame protocol and `terminalsChanged` come from `pty-websocket-terminal-io-channel.md` (shipped).
- `worktreePath` registration comes from `pty-fleet-backend-standalone-terminal-registry.md` (shipped).
- Does NOT depend on the extension-host packaging plan.

## Non-Goals

- No terminal search, links or serialize addons (still xterm core + fit).
- No drag-to-rearrange panes in v1 — layouts are picked from a fixed set, not freely composed.
- No cross-machine or remote notification delivery.

## Implementation Steps

### 1. Layouts

- Fixed layout set, chosen from a toolbar control: `1` (single), `2h` (side by side), `2v` (stacked), `2x2` (quad). Not free-form panes — a fixed set keeps persistence and resize handling tractable.
- Replace the single `.terminal-view-host.active` toggle with a CSS-grid pane container. Each pane holds one terminal's existing container element, so per-terminal xterm instances and sockets are reused unchanged — panes are assignment, not re-creation.
- Assignment: clicking a sidebar terminal fills the focused pane. A pane with no assignment renders an empty-slot affordance, not a broken terminal.
- **Minimum pane size floor:** below a threshold (roughly 40 cols × 10 rows after fit), refuse to subdivide further and fall back to the next-simpler layout, surfacing why. An unreadable 4-pane grid is worse than 2 panes.
- **Resize discipline:** batch fit across panes. On a layout change, run one `requestAnimationFrame` pass that fits every visible pane and sends at most one `{t:'resize'}` per terminal — not one per `ResizeObserver` firing. The existing per-instance debounce stays as the backstop for window resizes.
- Persist the layout (mode + pane→terminal-name map) per workspace via the existing generic `saveSetting`/`getSetting` verbs. On load, resolve names against the live fleet and silently drop stale slots.

### 2. Per-worktree grouping

- Group the sidebar by `worktreePath`, which `ptyListTerminals` already returns. Terminals with no `worktreePath` group under the workspace root.
- Header per group: the worktree's basename, plus a live/exited count. Collapsible, with collapse state persisted alongside the layout.
- Show the full path on hover — basenames collide across sibling worktrees.
- **Spawn-into-worktree:** the group header gets a New Terminal affordance that passes that group's `worktreePath` as `cwd`, so a terminal created from a worktree group lands in it. `ptyCreateTerminal` already accepts `cwd` and `worktreePath`.

### 3. Completion messages

- Server side: `dispatched_at` transitioning to NULL for a plan is the completion signal, and `PlanIngestionEngine` already calls `clearWorkingState` on plan-file edits. Emit a small `agentCompleted { planFile, planTitle, role, terminalName? }` broadcast over the existing hub sink when that clears — the same `broadcastWs` path `terminalsChanged` uses. Resolve `terminalName` from the dispatch identity already recorded on the row (`dispatched_agent` / `routed_to`), so the message can point at the pane.
- Panel side: an in-panel toast naming the plan and role, plus a persistent badge on the relevant pane and sidebar entry until acknowledged. In-panel first — it works with no permission prompt and no OS integration.
- Optional OS-level notification via the Notifications API, **off by default**, behind an explicit opt-in toggle. Never request permission on load; request only when the user enables it.
- Text is built from board state only. No terminal bytes in the DOM.

### 4. Contract surfaces

- Extend the panel-scrollbar and shim-injection contract tests to cover any new markup (the panel is auto-discovered by `browser-panel-scrollbar-contract.test.js` via `headlessPanelHtml.ts`, so new scroll containers must satisfy it).
- Keep exactly one `SHARED_DEFAULTS_SCRIPT` marker.
- No confirm dialogs anywhere — closing a terminal or clearing a pane is immediate.

## Proposed Changes

### `src/webview/terminals.html` + `terminals.js`
- **Logic:** Grid pane container replacing the single-active toggle; layout picker; worktree-grouped sidebar with per-group spawn; batched multi-pane fit; completion toasts + badges; layout/collapse persistence via `saveSetting`/`getSetting`.
- **Edge cases:** Min-pane floor; stale layout slots dropped on load; exited panes read-only without reflowing siblings; one resize frame per terminal per layout change.

### Completion broadcast (host side)
- **Logic:** Emit `agentCompleted` on `dispatched_at` clear, carrying plan title, role and resolved terminal name.
- **Edge cases:** Do not emit for the stale-state timeout sweep (`clearStaleWorkingState`) — a timeout is not a completion, and conflating them would report success for an agent that simply stopped.

## Verification Plan

### Automated
- `npm run test:contract:panel-scrollbars` and `test:contract:shim-injection` pass with the new markup.
- New contract test: layout persistence round-trips, and a persisted layout referencing a dead terminal loads without empty panes.
- New contract test: `agentCompleted` fires on `dispatched_at` clear via plan-file edit, and does NOT fire on the stale-state timeout path.
- `npm run compile`, `lint` clean.

### Manual UAT (darwin)
- Spawn four agents across two worktrees → sidebar shows two groups with correct counts → pick `2x2` → all four render live and stay interactive → resize the window and every pane reflows once, not repeatedly.
- Narrow the window until the floor trips → layout falls back with a visible reason rather than rendering unreadable panes.
- Reload the page → layout, pane assignment and group collapse all restore; kill a terminal first and confirm its slot is dropped cleanly.
- Dispatch a card, let the agent edit the plan file → completion toast names the right plan and role, badge appears on the right pane, clears on acknowledge.
- Let a dispatch go stale past the timeout → NO completion message.

## Completion Report

(To be filled in by the implementing agent.)
