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

- **Scope decision:** this plan carries 3 independently-shippable deliverables (layouts, worktree grouping, completion messages). They are cohesive (one panel, one file pair) so they are kept as one plan, but they could be split into three plans and grouped via `create-feature-from-plans` if you want finer-grained dispatch. Confirm one-plan is acceptable before coding.
- Everything else is decided below: layout set, grouping behaviour, notification style.

## Complexity Audit

### Routine
- Grouping the existing list by `worktreePath` — the field is already served by `ptyListTerminals` (registered in `PtyFleetService.create`, `ptyFleetService.ts:95`; mapped in the list payload at `TaskViewerProvider.ts:1688`).
- Reusing the established `terminalsChanged` hub broadcast for live list updates.
- Theme fan-out already works and needs no change.
- Persisting layout/collapse state via `saveSetting`/`getSetting` — both verbs exist in both hosts (`KanbanProvider.ts:9973`, `bootstrap.ts:660`; schema at `verbSchemas.ts:398`) and the panel already calls `getSetting` cross-prefix (`terminals.js:154-174`).
- The `agentCompleted` push needs no new client plumbing: every panel iframe already owns a `/ws` socket and unwraps hub envelopes into window MessageEvents (`transport.js:113-186`), and the shim is already injected into `terminals.html` (`headlessPanelHtml.ts:358`).

### Complex / Risky
- Multiple simultaneously-visible xterm instances multiply the fit/resize problem: every layout change resizes N terminals, each firing a `{t:'resize'}` frame. The existing debounced `ResizeObserver` is per-instance (`terminals.js:386-403`) and will fire in a burst.
- xterm renders nothing useful at very small sizes; a 4-pane layout in a narrow window needs a minimum-size floor or the panes are unusable.
- Layout persistence must survive reload without pinning a layout to terminals that no longer exist — and terminal rename changes the persisted key.
- Completion detection is server-side state; the panel needs a push it currently does not receive, and the emission point (`PlanIngestionEngine.ts:845-857`) has no hub reference today — a new optional callback on the ingestion host seam is required, wired in both hosts.
- The completion signal inherits the standing mtime-is-completion contract: ANY plan-file edit while a card is dispatched clears `dispatched_at`, including edits by a planner or by the improve-plan skill itself. The toast must not claim more than the contract guarantees.

## Edge-Case & Dependency Audit

**Race Conditions**
- Terminal exits while in a multi-pane layout: the pane must go read-only (v1 already latches `entry.exited`) without collapsing the layout and reflowing its siblings unexpectedly.
- A layout referencing a killed terminal on reload — resolve against the live fleet list and drop stale slots rather than rendering empty panes.
- Rapid create/close churn already has last-write-wins list rendering in v1; grouping must not reintroduce an ordering race.
- Terminal rename invalidates the persisted pane→terminal-name key (`renameTerminal` renames the map key server-side, `ptyFleetService.ts:156-168`). On a fleet `renamed` event, update the in-memory and persisted layout map; if the rename is only discovered on reload, the stale-slot drop applies — acceptable, but the drop must not silently cascade (dropping one slot must not discard the whole layout).
- Re-dispatch overwrites `dispatched_at` (`KanbanDatabase.ts:9189-9197`), so an edit-then-redispatch sequence emits completion then returns to working. Last write wins; no debounce needed because the emission is gated on the non-null→null transition.

**Security**
- Completion messages must not interpolate raw agent output into the DOM. v1's rule stands: terminal bytes go only to `term.write()`, never to `innerHTML`. Notification text comes from board state (plan title, role), not from the terminal stream, and is assigned via `textContent`.

**Side Effects**
- N visible xterm instances parse and render continuously; v1 already accepted keep-alive CPU cost for hidden terminals, and a layout makes several of them *visible* and actively rendering. Worth measuring before assuming it is free.
- Browser notification permission (if used) is a user-visible prompt — opt-in only, never requested on load.
- The `agentCompleted` broadcast is fire-and-forget: a panel that was closed (or a browser tab not open) when the agent finished never shows a toast or badge. This matches the activity light's ephemeral semantics and is accepted, not papered over with a durable inbox.

**Dependencies & Conflicts**
- Frame protocol and `terminalsChanged` come from `pty-websocket-terminal-io-channel.md` (shipped).
- `worktreePath` registration comes from `pty-fleet-backend-standalone-terminal-registry.md` (shipped).
- Does NOT depend on the extension-host packaging plan.
- New DB column `dispatched_terminal` follows the idempotent `ALTER TABLE plans ADD COLUMN ... TEXT DEFAULT ''` migration list (`KanbanDatabase.ts:219-280`) — the same pattern that added `routed_to`/`dispatched_agent`/`dispatched_ide` (lines 261-263). No conflict; additive only.
- The new ingestion-host-seam callback is optional, so hosts that don't wire it degrade silently (no completion push) rather than breaking ingestion.
- PRD alignment: the Terminals panel is standalone-capability-gated already (`headlessPanelHtml.ts:385-397` — fail-closed when node-pty is absent), so the shipped extension's byte-compat contract is untouched. The OS-notification toggle is opt-in (default-OFF), satisfying the new-capabilities-default-OFF contract.

## Dependencies

- none — no session dependencies. Shipped file-level dependencies are listed under **Edge-Case & Dependency Audit** above (`pty-websocket-terminal-io-channel.md`, `pty-fleet-backend-standalone-terminal-registry.md`).

## Non-Goals

- No terminal search, links or serialize addons (still xterm core + fit).
- No drag-to-rearrange panes in v1 — layouts are picked from a fixed set, not freely composed.
- No cross-machine or remote notification delivery.

## Implementation Steps

### 1. Layouts

- Fixed layout set, chosen from a toolbar control: `1` (single), `2h` (side by side), `2v` (stacked), `2x2` (quad). Not free-form panes — a fixed set keeps persistence and resize handling tractable.
- Replace the single `.terminal-view-host.active` toggle (`terminals.js:311-334`, `switchActiveTerminal`) with a CSS-grid pane container. Each pane holds one terminal's existing container element (created in `createTerminalView`, `terminals.js:336-404`), so per-terminal xterm instances and sockets are reused unchanged — panes are assignment, not re-creation. `switchActiveTerminal` becomes "assign to focused pane"; single-terminal mode is the `1` layout degenerate case, not a separate code path.
- Assignment: clicking a sidebar terminal fills the focused pane. A pane with no assignment renders an empty-slot affordance, not a broken terminal.
- **Minimum pane size floor:** below a threshold (roughly 40 cols × 10 rows after fit), refuse to subdivide further and fall back to the next-simpler layout, surfacing why. An unreadable 4-pane grid is worse than 2 panes.
- **Resize discipline:** batch fit across panes. On a layout change, run one `requestAnimationFrame` pass that fits every visible pane and sends at most one `{t:'resize'}` per terminal — not one per `ResizeObserver` firing. The existing per-instance debounce (`terminals.js:386-403`) stays as the backstop for window resizes.
- Persist the layout (mode + pane→terminal-name map) per workspace via the existing generic `saveSetting`/`getSetting` verbs (`/kanban/verb/...` — the panel already calls `getSetting` this way at `terminals.js:156`). On load, resolve names against the live fleet and silently drop stale slots.
- Full teardown stays in `destroyTerminalView` (`terminals.js:289-309`) — closing a terminal removes its pane assignment; exiting a terminal latches the pane read-only in place.

### 2. Per-worktree grouping

- Group the sidebar by `worktreePath`, which `ptyListTerminals` already returns. Terminals with no `worktreePath` group under the workspace root. This rewrites `renderSidebarList` (`terminals.js:81-150`) into a two-level render; the flat-list ordering guarantees (last-write-wins) are preserved per group.
- Header per group: the worktree's basename, plus a live/exited count. Collapsible, with collapse state persisted alongside the layout.
- Show the full path on hover — basenames collide across sibling worktrees.
- **Spawn-into-worktree:** the group header gets a New Terminal affordance that passes that group's `worktreePath` as `cwd`, so a terminal created from a worktree group lands in it. `ptyCreateTerminal` already accepts `cwd` and `worktreePath` (`TaskViewerProvider.ts:1672`, forwarded to `PtyFleetService.create`).

### 3. Completion messages

- Server side: `dispatched_at` transitioning to NULL for a plan is the completion signal, and `PlanIngestionEngine` already calls `clearWorkingState` on plan-file edits, gated on the row having been dispatched (`PlanIngestionEngine.ts:845-857`). Emit a small `agentCompleted { planFile, planTitle, role, terminalName? }` broadcast when that clear happens.
- **Emission mechanism (corrected — see Superseded callouts below):** add an optional `onWorkingStateCleared?(record)` callback to the ingestion host seam interface (the same interface `createStandalonePlanIngestionHost` implements, `src/standalone/planIngestionHost.ts`), invoked from the clear site with the updated record (which already carries `topic` → `planTitle` and `dispatched_agent` → `role`). Wire it to `server.broadcastWs('agentCompleted', {...})` in the standalone bootstrap (engine constructed at `bootstrap.ts:287`; `LocalApiServer.broadcastWs` at `LocalApiServer.ts:465` fans out to every panel's existing `/ws` socket — no client-side surface filtering, `wsHub.ts:223-248`) and in the extension host for parity.
- **Terminal identity (corrected):** record the exact terminal at dispatch time. Add `dispatched_terminal TEXT DEFAULT ''` to the idempotent migration list (`KanbanDatabase.ts:219-280`), extend `updateDispatchInfoByPlanFile` (`KanbanDatabase.ts:9183-9198`) to write it, and set it from the dispatch path that already knows the terminal (`bootstrap.ts:1016-1048`, where `terminal.friendlyName` is in scope). Fallback when the column is empty (older rows, extension-host dispatch): resolve by role + `worktreePath` against the live fleet, mirroring dispatch's own selection rule (`bootstrap.ts:1016-1020`); if still ambiguous, omit `terminalName` — the toast names plan and role, the pane badge is best-effort.
- Do not emit for the stale-state timeout sweep (`clearStaleWorkingState`, `KanbanDatabase.ts:9233-9251`) — a timeout is not a completion, and conflating them would report success for an agent that simply stopped. The emission lives only at the plan-file-edit clear site, never in the sweep.
- Panel side: an in-panel toast naming the plan and role, plus a persistent badge on the relevant pane and sidebar entry until acknowledged. In-panel first — it works with no permission prompt and no OS integration. Missed broadcasts (panel closed) are accepted: the signal is ephemeral like the activity light, not a durable inbox.
- Optional OS-level notification via the Notifications API, **off by default**, behind an explicit opt-in toggle. Never request permission on load; request only when the user enables it.
- Text is built from board state only, assigned via `textContent`. No terminal bytes in the DOM.

> **Superseded:** "Emit a small `agentCompleted` broadcast over the existing hub sink when that clears — the same `broadcastWs` path `terminalsChanged` uses."
> **Reason:** The `terminalsChanged` broadcast fires from `TerminalWsGateway`'s constructor-injected callback (`terminalWsGateway.ts:83-92`) — a path `PlanIngestionEngine` cannot reach; the engine holds no hub reference at all. The claim described a wire that does not exist.
> **Replaced with:** Emit via `LocalApiServer.broadcastWs` (`LocalApiServer.ts:465`) through a new optional `onWorkingStateCleared` callback on the ingestion host seam, wired in both hosts (`bootstrap.ts:287` for standalone; the extension host's ingestion host for parity). The hub fan-out and per-panel `/ws` delivery (`transport.js:113-186`) need no changes.

> **Superseded:** "Resolve `terminalName` from the dispatch identity already recorded on the row (`dispatched_agent` / `routed_to`)."
> **Reason:** Those columns do not hold a terminal name. The standalone dispatch path writes `dispatchedAgent: targetRole` (the role string, e.g. `'coder'`), `dispatchedIde: PTY_IDE_NAME`, and `routedTo: targetColumn` (`bootstrap.ts:1031-1035`). The terminal's `friendlyName` is known at dispatch (`bootstrap.ts:1048`) but never persisted, so at completion time it is unrecoverable except by heuristic.
> **Replaced with:** Persist the terminal name at dispatch in a new `dispatched_terminal` column (migration pattern at `KanbanDatabase.ts:219-280`), with a role+`worktreePath` fleet-match fallback for rows that predate the column, and omit `terminalName` when unresolved.

### 4. Contract surfaces

- Extend the panel-scrollbar and shim-injection contract tests to cover any new markup (the panel is auto-discovered by `browser-panel-scrollbar-contract.test.js` via `headlessPanelHtml.ts`, so new scroll containers must satisfy it).
- Keep exactly one `SHARED_DEFAULTS_SCRIPT` marker (`terminals.html:304`).
- No confirm dialogs anywhere — closing a terminal or clearing a pane is immediate.

## Adversarial Synthesis

Key risks: the completion toast inherits the mtime-is-completion contract, so any plan-file edit while dispatched (including a planner's own edit) reads as "agent finished"; the pane-pointing badge depended on a terminal name that was never persisted; and the emission point had no hub access. Mitigations: emit only on the gated non-null→null transition at the plan-file-edit clear site (never the timeout sweep), persist `dispatched_terminal` at dispatch with a documented heuristic fallback, and route the broadcast through a new optional ingestion-host-seam callback to `LocalApiServer.broadcastWs`. Layouts and grouping survived review unchanged; complexity holds at 6.

## Proposed Changes

### `src/webview/terminals.html` + `terminals.js`
- **Logic:** Grid pane container replacing the single-active toggle (`terminals.js:311-334`); layout picker; worktree-grouped sidebar with per-group spawn (`terminals.js:81-150` rewritten two-level); batched multi-pane fit; completion toasts + badges driven by the `agentCompleted` window message (same listener shape as `terminalsChanged`, `terminals.js:49-57`); layout/collapse persistence via `saveSetting`/`getSetting`; rename event updates the persisted pane map.
- **Edge cases:** Min-pane floor; stale layout slots dropped on load without cascading; exited panes read-only without reflowing siblings; one resize frame per terminal per layout change; missed broadcasts accepted (ephemeral semantics).

### Ingestion host seam + completion broadcast (host side)
- **Logic:** Optional `onWorkingStateCleared(record)` callback on the ingestion host interface (`src/standalone/planIngestionHost.ts` and the extension host's equivalent), invoked from `PlanIngestionEngine.ts:845-857` when `clearWorkingState` fires; wired to `server.broadcastWs('agentCompleted', { planFile, planTitle, role, terminalName? })` in both hosts.
- **Edge cases:** Callback absent → no push, ingestion unaffected. Never invoked from the `clearStaleWorkingState` sweep — a timeout is not a completion.

### Dispatch identity (`KanbanDatabase.ts`, `bootstrap.ts`)
- **Logic:** New `dispatched_terminal TEXT DEFAULT ''` column (migration list, `KanbanDatabase.ts:219-280`); `updateDispatchInfoByPlanFile` extended to write it (`KanbanDatabase.ts:9183-9198`); standalone dispatch sets it from the terminal it selected/created (`bootstrap.ts:1016-1048`).
- **Edge cases:** Empty column (pre-migration rows, extension-host dispatch) → role+worktreePath fleet-match fallback; still unresolved → omit `terminalName` and show toast/badge without pane targeting.

## Verification Plan

### Automated Tests

> **Superseded:** Run `npm run test:contract:panel-scrollbars` and `test:contract:shim-injection` with the new markup; add contract tests for layout-persistence round-trip and `agentCompleted` firing; `npm run compile`, `lint` clean.
> **Reason:** Session directive for this improvement pass: SKIP TESTS and SKIP COMPILATION — no automated tests or compilation are run as part of this verification plan.
> **Replaced with:** The automated checks below are specified (so a later session or CI can run them) but are explicitly NOT executed under this plan's verification.

Specified, not run:
- `npm run test:contract:panel-scrollbars` and `npm run test:contract:shim-injection` (both exist, `package.json:792-793`) with the new markup.
- Contract test: layout persistence round-trips, and a persisted layout referencing a dead terminal loads without empty panes.
- Contract test: `agentCompleted` fires on `dispatched_at` clear via plan-file edit, and does NOT fire on the stale-state timeout path; `terminalName` equals the `dispatched_terminal` column when set, and the fallback/omit path behaves as specified.
- `npm run compile`, `lint` clean.

### Manual UAT (darwin)
- Spawn four agents across two worktrees → sidebar shows two groups with correct counts → pick `2x2` → all four render live and stay interactive → resize the window and every pane reflows once, not repeatedly.
- Narrow the window until the floor trips → layout falls back with a visible reason rather than rendering unreadable panes.
- Reload the page → layout, pane assignment and group collapse all restore; kill a terminal first and confirm its slot is dropped cleanly; rename a terminal and confirm the layout follows the new name (or drops only that slot).
- Dispatch a card, let the agent edit the plan file → completion toast names the right plan and role, badge appears on the right pane (terminal name from `dispatched_terminal`), clears on acknowledge.
- Dispatch a card, edit the plan file yourself mid-run → toast fires (documented mtime-is-completion contract semantics), no crash, badge on the recorded terminal.
- Let a dispatch go stale past the timeout → NO completion message.
- Close the terminals panel, let an agent finish, reopen → no stale toast/badge (ephemeral semantics accepted).

## Completion Report

Implemented split-pane layouts (1, 2h, 2v, 2x2), per-worktree grouped sidebar tabs with live counts and group spawn, and agent completion notification toasts and badges. Added `dispatched_terminal` database tracking and an `onWorkingStateCleared` seam event to broadcast `agentCompleted` messages on plan completion. Modified `KanbanDatabase.ts`, `PlanIngestionEngine.ts`, `bootstrap.ts`, `terminals.html`, and `terminals.js`. No issues encountered during implementation.
