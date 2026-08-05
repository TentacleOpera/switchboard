# Subagent terminals: definition, co-launch, and lazy viewing

## Goal

Let each agent define its own subagents; open a head agent's terminal and its subagent terminals come up with it; put a control in the terminal frame that reveals them. Crucially, subagent terminals must be **attached lazily** — dispatch and result collection must never depend on anyone watching.

Depends on `feature_plan_20260805180001_subagent-contract-and-join` for identity and the dispatch/join protocol. This plan is the terminal lifecycle and the operator surface; it adds no new comms.

### Problem analysis

No bug — this is new capability. The design constraints come from measured behaviour of the existing panel, and they are the reason this is its own plan rather than a UI afterthought.

**Constraint 1 — the panel amplifies per attached surface.** The browser cockpit already fans every host push to every connected surface, and a `localTicketFilesListed` reply for one list was measured arriving at a panel showing a different one (see `feature_plan_20260805170000`). A single verb call produced 8 `localTicketFilesListed`, 8 `ticketSyncStatusesLoaded` and 3 `importAllTicketsComplete` pushes. Whatever the multiplier is per surface today, a head agent with five children multiplies terminal count by six.

**Constraint 2 — a busy terminal gets its viewer evicted.** `terminalWsGateway.ts:726` evicts a client whose socket stays above the high-water mark past the grace period; the client then reconnects and is replayed the scrollback ring, which can put it straight back over the mark. Every *attached* viewer of a high-output terminal pays this. Subagents are high-output by nature — they are coding agents.

**Therefore: attachment is a viewing decision, not a lifecycle one.** A subagent terminal must be able to exist, run, and report its result with no WebSocket attached at all. The "view subagents" control opens sockets on demand and closes them when the view is dismissed. This is the single most important property in this plan; a design where children are attached at spawn inherits both constraints multiplied by the fan-out width.

**Constraint 3 — the role/visibility model is a flat list.** `GRID_BUILTIN_ROLES` (`terminals.js:2773`) and `DEFAULT_VISIBLE_AGENTS` (`:2787`) are flat maps of role → visible, mirrored by hand from `TaskViewerProvider._defaultVisibleAgents()` with a comment saying to keep them in step. There is no notion of one agent belonging to another. Subagents need a parent relation, and adding it must not break the mirroring contract or silently open the opt-in roles the extension deliberately leaves shut (`tester`, `researcher`, `phone_a_friend` are all `false` by default).

**Constraint 4 — children share the working tree, deliberately.** This feature exists to save tokens, not time: an expensive head agent delegates *writing* to a cheaper or free model and spends its own tokens only on *reviewing*. Isolating a child would mean merging its work back, and the merge costs the head agent the tokens the delegation was meant to save. So: no worktrees, no branches, no per-child sandboxes. Attribution comes from the **assigned scope** in the dispatch (see `feature_plan_20260805180001`), not from isolation.

This also means **which model/CLI a child runs is the point of the feature**, not a detail. A subagent definition must be able to say "this child is a Devin terminal" or "this child is a cheaper model" — a subagent that runs the same expensive model as its parent has no reason to exist.

## Metadata

- **Complexity:** 7
- **Tags:** feature, frontend, backend, ui

## User Review Required

None. The one decision that shapes everything — lazy attach rather than attach-on-spawn — is made above and justified by measured panel behaviour rather than preference.

## Complexity Audit

**Substantial, and front-loaded on the lifecycle rather than the pixels.**

| Area | Why it costs |
|---|---|
| Parent/child model | The visibility and role maps are flat and hand-mirrored in two places. Adding hierarchy touches both, plus the grid builder. |
| Lazy attach | The panel currently opens a socket per terminal it renders. Separating "exists" from "attached" is a real change to the terminal entry lifecycle. |
| Co-launch + teardown | Opening a head agent spawns N ptys. Closing it must not orphan them, and must not kill children still reporting results. |
| Per-child CLI/model launch | A child is launched with a *different* startup command than its parent (a Devin terminal, a cheaper model). Startup commands are per-workspace today, and there is a known defect class where a per-workspace mirror clobbers per-agent values — this must be per-agent and must not write back over siblings. |

## Edge-Case & Dependency Audit

- **Lazy attach must be genuinely lazy.** Not "render hidden" — the current grid opens a WebSocket when a pane is built, and hiding a pane with CSS still leaves it attached and still pays eviction. Detach must mean the socket is closed.
- **Output while detached must not be lost.** The gateway replays from a scrollback ring with `lastSeq`, so a viewer attaching late gets the tail. Confirm the ring is per-terminal and sized for a child that ran unwatched for minutes; a child whose early output aged out of the ring is unviewable after the fact, which is acceptable only if the *result* went through the contract rather than the terminal. Say so in the skill.
- **Never drive results through the terminal.** The child reports via `POST /subagents/result`. Terminal output is for humans. Any design where the host scrapes a child's pty for its answer reintroduces every fragility this avoids.
- **Closing the head agent must not orphan children.** Define the teardown: closing a head agent terminates its subtree, but a child mid-dispatch must be allowed to report (or be explicitly cancelled and reported as `cancelled` per the contract's envelope) — never silently killed while a parent blocks on the join.
- **`GRID_BUILTIN_ROLES` and `DEFAULT_VISIBLE_AGENTS` are hand-mirrored** from `TaskViewerProvider._defaultVisibleAgents()`, with an explicit comment that reading saved values raw is not equivalent because an absent key reads as visible. Any hierarchy added to the visibility model must preserve that: a subagent role with no saved entry must default **closed**, or enabling one head agent silently opens every child role.
- **Subagent terminals must not pollute the flat fleet list** used by dispatch targeting, the Agents tab, and the kanban agent pickers. Either scope them under their parent in those surfaces or filter them out; a fleet list that grows by 6× breaks every picker that assumes it is short.
- **Terminal name collisions.** Two head agents each with a `researcher` child cannot both be `researcher-1`. Names must be parent-qualified; identity remains the `agentInstanceId` from the contract plan, with the name purely a label.
- **Pty count is a real resource.** Each child is a process. Cap children per head agent and total live subagent ptys, and surface the cap — an operator who opens four head agents should not discover the limit as a spawn failure.
- **The view control belongs in the pane frame**, alongside pin/clear/hide/mode. That row is read positionally in `updatePaneElement` via `children[N]` with an explicit index comment; inserting a control shifts those indices and both the append order and the reads must change together. This is a known trap in this file.
- **Kanban-mode panes hide some frame controls.** A new control must follow the existing show/hide treatment for its pane mode rather than being unconditionally visible.
- **Do not add an in-terminal notice for subagent state.** Chip/frame chrome only. Writing status into a pty buffer makes it permanent scrollback that cannot be dismissed and corrupts TUI screen buffers — see the removed `[Not connected — keystroke discarded]` line and the comment left in its place.

## Proposed Changes

### 1. Subagent definition per agent — in the Kanban panel's Agents tab

This is the primary user-facing surface of the whole feature: the operator defines an agent's subagents here, including **which CLI/model each child launches with**. Everything else in this plan is lifecycle that follows from these definitions.

Implementation note: `kanban.html` is a self-contained webview — its handlers live in its own inline script, not in a shared module. Wire the Agents-tab controls there rather than reaching for an external file.

Extend the agent config so an agent can declare children: role/label, count, **the CLI/startup command the child launches with** (this is the cost-routing lever and the reason the feature exists), and default-visible — which should default to **false**, matching how opt-in roles are treated today. Keep it additive: an agent with no children behaves exactly as now.

No isolation field. Children run in the workspace tree alongside their parent; attribution is the `scope` in the dispatch envelope.

### 2. Parent relation in the fleet model

Add a parent link to the terminal record, carried alongside `agentInstanceId`. Fleet listings gain the ability to return a tree or a filtered flat list; existing consumers (Agents tab, dispatch pickers, kanban agent selection) take the filtered flat list so nothing grows unexpectedly.

### 3. Co-launch on head-agent open

Opening a head agent's terminal spawns its declared children as ptys, **unattached**. Spawn is the lifecycle event; attachment is not.

### 4. Split "exists" from "attached" in `terminals.js`

Today building a pane opens a socket. Introduce an explicit attach/detach on the terminal entry so a terminal can be live with no socket. Head agents attach as now; children attach only when viewed.

### 5. The view control

A control in the pane frame that reveals the focused head agent's children — attaching their sockets on open and detaching on close. Insert it into the action row with the positional-index reads in `updatePaneElement` updated in the same change, and give it the same per-pane-mode visibility treatment the existing controls have.

### 6. Per-child launch command

A child terminal launches with its own CLI/model rather than inheriting its parent's. This is the mechanism the whole feature rests on — delegating to a cheaper model is the point — so it must be settable per child in the agent definition and must not be mirrored back over sibling agents' startup commands.

## Verification Plan

1. Define a head agent with three children; open it. Four ptys exist; **one** WebSocket is open. Verify at the gateway, not in the UI.
2. Dispatch to all three children with the panel closed entirely. All three run and report through `POST /subagents/result`; the parent's join returns all three. Nothing about the result path touches a terminal.
3. Open the view control → three sockets open and backscroll renders. Close it → three sockets close. Confirm at the gateway.
4. Run a child producing heavy output while detached, then attach. The tail renders; confirm whether early output aged out of the ring and that the *result* is unaffected either way.
5. Attach all children of two head agents simultaneously and confirm no eviction cascade (`terminalWsGateway.ts:726`). This is the constraint that motivated lazy attach — measure it, do not assume it.
6. Close a head agent while a child is mid-dispatch → the child reports or is reported `cancelled`; the parent's join terminates rather than hanging.
7. Two head agents each with a same-role child → names are parent-qualified and distinct; both resolve correctly by instance id.
8. Fresh install, no saved visibility entries → no subagent terminal opens by itself, and `tester` / `researcher` / `phone_a_friend` remain shut.
9. Exceed the per-parent and global child caps → refused with a stated reason, no partial spawn.
10. Pane action row: pin/clear/hide/mode all still operate on the right buttons after the insertion (the `children[N]` index trap), in both terminal and kanban pane modes.
11. A child defined with a different CLI (e.g. a Devin terminal) launches with that command, not its parent's — and setting it does not alter any sibling agent's startup command.
12. Head agent and two children all editing the same tree: no isolation is provisioned, no branch is created, and the head agent reviews the combined diff in place.
