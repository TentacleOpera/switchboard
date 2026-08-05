# Subagent terminals: definition, co-launch, and lazy viewing

## Goal

Let each agent define its own subagents (**delegates** in code — see the naming decision in `…180001`); open a head agent's terminal and its delegate terminals come up with it; put a control in the terminal frame that reveals them. Crucially, delegate terminals must be **attached lazily** — dispatch and result collection must never depend on anyone watching.

Depends on `feature_plan_20260805180001_subagent-contract-and-join` for identity (`agentInstanceId`) and the dispatch/join protocol. This plan is the terminal lifecycle and the operator surface; it adds no new comms.

### Which terminal backend — the pty fleet, in the pty host child process

Every terminal in this plan is a **node-pty handle owned by `PtyFleetService`**, not a `vscode.Terminal`. In the extension deployment the fleet, the WebSocket gateway and the prompt-delivery helpers all live in a **separate pty host child process** (`src/standalone/ptyHost.ts`); `TaskViewerProvider.ts:24-28` states it directly — *"The extension is control plane: it never constructs a fleet and never sees terminal bytes."* The standalone `npx` host runs the same fleet in-process (`src/standalone/bootstrap.ts:1462`).

Consequences that shape the whole plan:

- **Co-launch is a verb call, not a direct API call.** The only way to create a delegate is the `ptyCreateTerminal` verb (`ptyHost.ts` `handlePtyVerb`), reached from the extension over `_ptyHostPort` (`TaskViewerProvider.ts:552`) via the `/terminals/verb/<verb>` forwarding route (`LocalApiServer.ts:3527`).
- **Nothing here touches Phone-a-Friend.** That feature is `vscode.Terminal`-only (`allowPtyFleet=false`; `TaskViewerProvider.ts:4673`). `…180000` is independent of this plan in both directions.
- **The pty host may not be running.** `ptyReady` / `_ptyHostPort` can be undefined (`TaskViewerProvider.ts:1901`, `:1916`, `:1951`). Delegate definitions must then be visibly unavailable rather than dead-clicking (PRD contract #6).

### Problem analysis

No bug — this is new capability. The design constraints come from measured behaviour of the existing panel, and they are the reason this is its own plan rather than a UI afterthought.

**Constraint 1 — the panel amplifies per attached surface.** The browser cockpit already fans every host push to every connected surface, and a `localTicketFilesListed` reply for one list was measured arriving at a panel showing a different one (see `feature_plan_20260805170000`). A single verb call produced 8 `localTicketFilesListed`, 8 `ticketSyncStatusesLoaded` and 3 `importAllTicketsComplete` pushes. Whatever the multiplier is per surface today, a head agent with five children multiplies terminal count by six.

**Constraint 2 — a busy terminal gets its viewer evicted.** `checkBackpressure` in `src/standalone/terminalWsGateway.ts` evicts a client whose `ws.bufferedAmount` stays above `HIGH_WATER_MARK_BYTES` past `HIGH_WATER_GRACE_MS` (`:713-731`); the client then reconnects and is replayed the scrollback ring, which can put it straight back over the mark — the code names this spiral explicitly at `:841` ("the eviction→reconnect→replay spiral"). Constants at `:5-8`: `MAX_SCROLLBACK_BYTES = 256 KB`, `HIGH_WATER_MARK_BYTES = 1 MB`, `HIGH_WATER_GRACE_MS = 30 s`. Every *attached* viewer of a high-output terminal pays this. Delegates are high-output by nature — they are coding agents.

> **Superseded:** "`terminalWsGateway.ts:726` evicts a client…" (and the same path cited as `src/services/terminalWsGateway.ts` throughout).
> **Reason:** Wrong directory and drifted line. The file is `src/standalone/terminalWsGateway.ts` — there is no `src/services/terminalWsGateway.ts` — and the eviction block is `:713-731` inside `checkBackpressure`, with the tunable constants at `:5-8`. A coder following the original citation finds nothing.
> **Replaced with:** the citations above.

**Therefore: attachment is a viewing decision, not a lifecycle one.** A delegate terminal must be able to exist, run, and report its result with no WebSocket attached at all. The "view delegates" control opens sockets on demand and closes them when the view is dismissed. This is the single most important property in this plan; a design where children are attached at spawn inherits both constraints multiplied by the fan-out width.

**Constraint 3 — the role/visibility model is a flat list, and its two copies have already drifted.** `GRID_BUILTIN_ROLES` (`terminals.js:3044`) is a flat array, and its own comment says it mirrors *"what OPEN AGENT TERMINALS actually opens, not what the Agents tab can toggle"*. The visibility defaults live in a shared module — `DEFAULT_VISIBLE_AGENTS` in `src/webview/sharedDefaults.js:2`, exported at `:263` and injected into webviews (guarded by `src/test/webview-shim-injection-contract.test.js:136`) — and are hand-mirrored from `TaskViewerProvider._defaultVisibleAgents()` (`:5703`).

**That mirror is currently broken.** `_defaultVisibleAgents()` declares `claude_artifacts: false`; `DEFAULT_VISIBLE_AGENTS` declares `claude_designer: false`. Same slot, different key — so one side carries a default the other has never heard of. `GRID_BUILTIN_ROLES` lists `claude_artifacts`. This is a **pre-existing defect, out of scope for this plan**, but it is the proof that the mirroring hazard below is real rather than theoretical, and it means the implementer must not assume the two copies agree.

There is no notion of one agent belonging to another. Delegates need a parent relation, and adding it must not break the mirroring contract or silently open the opt-in roles the extension deliberately leaves shut (`tester`, `researcher`, `phone_a_friend` are all `false` by default in both copies).

> **Superseded:** "`GRID_BUILTIN_ROLES` (`terminals.js:2773`) and `DEFAULT_VISIBLE_AGENTS` (`:2787`) are flat maps of role → visible, mirrored by hand from `TaskViewerProvider._defaultVisibleAgents()`."
> **Reason:** Both citations are stale, and one is the wrong file. `GRID_BUILTIN_ROLES` is at `:3044`. `DEFAULT_VISIBLE_AGENTS` is no longer in `terminals.js` at all — it was centralised into `src/webview/sharedDefaults.js:2` and is consumed by `terminals.js:2950`, `kanban.html:4184`, `implementation.html:1943`, `setup.html:1279`. Also `GRID_BUILTIN_ROLES` is an **array**, not a role→visible map.
> **Replaced with:** the citations above. The centralisation is good news — hierarchy defaults belong in the one shared module, not a fourth copy.

**Constraint 4 — children share the working tree, deliberately.** This feature exists to save tokens, not time: an expensive head agent delegates *writing* to a cheaper or free model and spends its own tokens only on *reviewing*. Isolating a child would mean merging its work back, and the merge costs the head agent the tokens the delegation was meant to save. So: no worktrees, no branches, no per-child sandboxes. Attribution comes from the **assigned scope** in the dispatch (see `…180001`), not from isolation.

This also means **which model/CLI a child runs is the point of the feature**, not a detail. A delegate definition must be able to say "this child is a Devin terminal" or "this child is a cheaper model" — a delegate that runs the same expensive model as its parent has no reason to exist.

**Constraint 5 — the startup-command lookup is role-keyed and machine-global, so per-child CLI is a new resolution path, not just a careful write.** *(Found during reconciliation; the original plan flagged only the clobber risk.)* `PtyFleetService.injectStartupCommand(handle, role)` (`ptyFleetService.ts:119-133`) does:

```ts
const commands = await GlobalIntegrationConfigService.getAgentStartupCommands() || {};
const cmd = commands[role];
```

Role-keyed, from machine-global config — and `ptyCreateTerminal` accepts only `role, name, cwd, worktreePath`, with **no** command override. So two delegates of the same role under different parents necessarily receive the same command, and there is currently no channel to pass a per-child command at all. This is the mechanism the whole feature rests on, so it needs an explicit new parameter (§6), not just discipline about writes.

## Metadata

- **Complexity:** 7
- **Tags:** feature, frontend, backend, ui

## User Review Required

None. The one decision that shapes everything — lazy attach rather than attach-on-spawn — is made above and justified by measured panel behaviour rather than preference.

## Complexity Audit

**Substantial, and front-loaded on the lifecycle rather than the pixels.**

### Routine

- Adding a `delegates` array to the agent config shape, additively (an agent with none behaves exactly as now).
- Wiring the Agents-tab controls in `kanban.html`'s own inline script (it is a self-contained webview — handlers do not live in a shared module).
- Adding a parent link field to the fleet handle alongside `agentInstanceId`.
- Inserting one control into the pane action row (the index bookkeeping is the risk, not the insertion).

### Complex / Risky

| Area | Why it costs |
|---|---|
| Parent/child model | The role and visibility maps are flat, live in three places (`GRID_BUILTIN_ROLES` array, `sharedDefaults.js` `DEFAULT_VISIBLE_AGENTS`, `TaskViewerProvider._defaultVisibleAgents()`), and **two of them have already drifted**. Adding hierarchy touches the grid builder plus the mirror. |
| Lazy attach | `createTerminalView` (`terminals.js:3534`) opens the socket (`new WebSocket(wsUrl)`, `:3991`) as part of building a pane. Separating "exists" from "attached" is a real change to the terminal entry lifecycle, not a flag. |
| Co-launch + teardown | Opening a head agent spawns N ptys via `ptyCreateTerminal`. Closing it must not orphan them, and must not kill children still reporting results — teardown has to interlock with the contract's join. |
| Per-child CLI/model launch | The lookup is `commands[role]` from machine-global config and `ptyCreateTerminal` has no override parameter (Constraint 5). A new per-child command channel must thread create → `injectStartupCommand`, take precedence over the role lookup, and never write back over the global map. |
| Cross-process lifecycle | Spawn, list, and close are verb round-trips to the pty host; the control plane holds no handles. Every lifecycle decision is an async call that can fail with the host absent. |

## Edge-Case & Dependency Audit

### Race Conditions

- **Closing the head agent must not orphan children, and must not race the join.** Define the teardown: closing a head agent terminates its subtree, but a child mid-dispatch must be allowed to report (or be explicitly cancelled and reported as `cancelled` per the contract's envelope) — never silently killed while a parent blocks on the join.
- **Co-launch is N async verb round-trips.** Opening a head agent fires N `ptyCreateTerminal` calls; a partial failure mid-way leaves a half-populated subtree. Decide whether co-launch is all-or-nothing or best-effort-and-report, and make the grid reconcile tolerate the outcome either way.
- **Attach/detach can interleave with eviction.** A child evicted by `checkBackpressure` (`:713-731`) while the view is open will reconnect; the view-control's own detach must not race that reconnect into a leaked socket. Detach must be idempotent.
- **Name assignment is collision-counted at create time.** `PtyFleetService.create()` (`ptyFleetService.ts:74-80`) probes `this.terminals.has(name)` in a loop. Two parents co-launching same-role children concurrently contend on that counter — another reason names are labels and `agentInstanceId` is identity.

### Security

- **A delegate definition is an arbitrary command that the host will run.** The per-child startup command (§6) is executed in the user's tree by `handle.sendText(cmd, true)` (`ptyFleetService.ts:129`). It is user-authored config, same trust level as today's role startup commands — but co-launch makes it fire automatically on opening a head agent, where today it fires on an explicit terminal open. Do not broaden who can write it: definitions come from the Agents tab and config only, never from a dispatch payload or an agent-supplied field.
- **Caps are a safety control, not just ergonomics.** See Side Effects.

### Side Effects

- **Lazy attach must be genuinely lazy.** Not "render hidden" — `createTerminalView` opens a WebSocket when a pane is built (`terminals.js:3534`, socket at `:3991`), and hiding a pane with CSS still leaves it attached and still pays eviction. Detach must mean the socket is closed.
- **Output while detached is bounded to 256 KB and will age out.** *(The original plan asked for this to be confirmed; it is now answered.)* `MAX_SCROLLBACK_BYTES = 256 * 1024` (`terminalWsGateway.ts:5`), per terminal, and replay is `lastSeq`-based (`:812-843`). A coding agent produces 256 KB of output in well under a minute, so a child that ran unwatched for minutes **will** have lost its early output — this is not a risk to check, it is the expected behaviour. The gateway's own comments say the ring "evicts at `MAX_SCROLLBACK_BYTES`" (`:30`) and that an escape sequence is "long evicted" past that (`:182`). Acceptable **only** because the *result* goes through `POST /delegates/result` rather than the terminal. State this plainly in the child-side skill: terminal output is for humans and is lossy; the result endpoint is the contract.
- **Never drive results through the terminal.** The child reports via `POST /delegates/result`. Any design where the host scrapes a child's pty for its answer reintroduces every fragility this avoids — and would be reading a ring that has already dropped the beginning.
- **Delegate terminals must not pollute the flat fleet list** used by dispatch targeting, the Agents tab, and the kanban agent pickers. Either scope them under their parent in those surfaces or filter them out; a fleet list that grows by 6× breaks every picker that assumes it is short. Note `ptyListTerminals` is the single source for all of these, so the filter belongs at or just above that payload.
- **Terminal name collisions.** Two head agents each with a `researcher` child cannot both be `researcher-1`. Names must be parent-qualified; identity remains the `agentInstanceId` from the contract plan, with the name purely a label.
- **Pty count is a real resource.** Each child is a process. Cap children per head agent and total live delegate ptys, and surface the cap — an operator who opens four head agents should not discover the limit as a spawn failure.
- **Do not add an in-terminal notice for delegate state.** Chip/frame chrome only. Writing status into a pty buffer makes it permanent scrollback that cannot be dismissed and corrupts TUI screen buffers — see the removed `[Not connected — keystroke discarded]` line and the comment left in its place.
- **No confirmation dialogs on any control added here.** Project rule, and `window.confirm` is a silent no-op in webviews regardless.

### Dependencies & Conflicts

- **`GRID_BUILTIN_ROLES` / `DEFAULT_VISIBLE_AGENTS` / `_defaultVisibleAgents()` are hand-mirrored and already divergent** (Constraint 3). The mirroring contract's whole point is that reading saved values raw is not equivalent, because an absent key reads as visible. Any hierarchy added to the visibility model must preserve that: **a delegate role with no saved entry must default closed**, or enabling one head agent silently opens every child role. Add the hierarchy defaults to `sharedDefaults.js` (the shared module) rather than creating a fourth copy — and do not "fix" the `claude_artifacts` / `claude_designer` drift as a side quest.
- **The pane action row has FIVE controls, not four, and they are read by positional index.** `terminals.js:2033-2039` — `children[0]` = pin, `[1]` = clear, `[2]` = **model**, `[3]` = hide, `[4]` = mode — with an explicit comment at `:2032` that "children[] is the honest read". Appending a control shifts nothing; *inserting* one shifts every later read, and both the append order and the reads must change together.
  > **Superseded:** "The view control belongs in the pane frame, alongside pin/clear/hide/mode."
  > **Reason:** The row is pin / clear / **model** / hide / mode. The original enumeration omits the model button at index 2, and so does the original verification step 10 — meaning the plan could pass its own check while the model button had silently become the hide button.
  > **Replaced with:** the five-control enumeration above; the new control is appended at index 5 (safest — no existing read shifts) unless placement demands otherwise, and any insertion updates `:2035-2039` and `:2321-2323` in the same change.
- **Kanban-mode panes hide frame controls by iterating the row.** `terminals.js:2321-2323` reads `children[4]` as `modeBtn` and hides every child that is not it. A newly appended control is therefore hidden in kanban mode automatically — but only if `modeBtn` is still found at the right index, which is the same trap from the other direction.
- **`kanban.html` is a self-contained webview.** Its handlers live in its own inline script, not in a shared module. Wire the Agents-tab controls there rather than reaching for an external file.
- **Depends on `…180001`** for `agentInstanceId` (which does not exist in the codebase today) and for the dispatch/join endpoints. That plan also must have exposed the id on the `ptyCreateTerminal` / `ptyListTerminals` payloads — without that, this plan cannot address a child it just spawned.
- **Independent of `…180000`** in both directions — different terminal backend, different process. Do not share a config key with it.
- **Naming:** use `delegate*` for every new identifier. `subagent*` is taken by the shipped in-CLI policy addon (`agentConfig.ts:31-32`, `sharedDefaults.js:87-95`, present on every role at `:22-34`) which means something unrelated. See the naming decision in `…180001`.
- **Project PRD contracts** (`.switchboard/projects/browser-switchboard/prd.md`): new verbs return in-body (#4) and are schema-validated at the boundary (#5, `verbSchemas.ts` — shared file, serialise edits); **capability-gating honesty (#6)** is load-bearing here because the pty host may be absent — the Agents-tab delegate section and the view control must be **disabled with a reason**, never dead-clicking; **two-layer completion (#7)** means wiring in both the extension host and `src/standalone/bootstrap.ts`. Panel HTML stays in the one shared module (#1) — no forked UI for the delegate view.

## Dependencies

- **Depends on:** `feature_plan_20260805180001_subagent-contract-and-join` — hard prerequisite (`agentInstanceId` on the fleet handle *and* on the verb payloads; dispatch/join endpoints; the `cancelled` status for teardown).
- **Independent of:** `feature_plan_20260805180000_phone-a-friend-per-instance-addressing`.
- **Shared-file contention:** `src/webview/terminals.js`, `src/webview/kanban.html`, `src/webview/sharedDefaults.js`, `src/standalone/ptyFleetService.ts`, `src/standalone/ptyHost.ts`, `verbSchemas.ts`.
- No session-id dependencies recorded for this plan.

## Adversarial Synthesis

**Risk summary.** The failure that matters is lazy attach that is not actually lazy — `createTerminalView` opens the socket as part of building a pane (`terminals.js:3534`/`:3991`), so a "hidden pane" still attaches and still pays the eviction spiral (`terminalWsGateway.ts:713-731`), multiplied by the fan-out width; the acceptance signal must be socket count at the gateway, never UI appearance. Second is the positional-index trap in the pane action row: five controls read by `children[0..4]` at `:2035-2039` and again at `:2321-2323`, so an inserted control silently repoints pin/clear/model/hide/mode — and the original plan's own checklist omitted the model button, meaning it could have passed while broken. Third is per-child CLI: the lookup is `commands[role]` from machine-global config with no override parameter on `ptyCreateTerminal`, so "a child runs a cheaper model" needs a new resolution path or the whole cost-routing premise silently collapses to "children inherit the parent's command". Mitigations: measure sockets at the gateway; append rather than insert and update both index sites together; thread an explicit per-child command through create → `injectStartupCommand` with precedence over the role lookup and no write-back.

## Proposed Changes

### 1. Delegate definition per agent — in the Kanban panel's Agents tab

**Context.** `kanban.html` is a self-contained webview; its handlers live in its own inline script. Agent config shape in `src/services/agentConfig.ts`; webview defaults in `src/webview/sharedDefaults.js`.

**Logic.** This is the primary user-facing surface of the whole feature: the operator defines an agent's delegates here, including **which CLI/model each child launches with**. Everything else in this plan is lifecycle that follows from these definitions.

Extend the agent config so an agent can declare children: role/label, count, **the CLI/startup command the child launches with** (this is the cost-routing lever and the reason the feature exists), and default-visible — which must default to **false**, matching how opt-in roles are treated today. Keep it additive: an agent with no delegates behaves exactly as now.

No isolation field. Children run in the workspace tree alongside their parent; attribution is the `scope` in the dispatch envelope.

**Edge cases.** Name the field `delegates`, never `subagents` (collision with the shipped `subagentPolicy` addon that appears on every role). Disable the section with a stated reason when the pty host is unavailable (PRD #6). No confirm dialogs.

### 2. Parent relation in the fleet model

**Context.** `ExtendedTerminalHandle` in `src/standalone/ptyFleetService.ts`; `ptyListTerminals` in `ptyHost.ts`.

**Logic.** Add a parent link to the terminal record, carried alongside `agentInstanceId` (both persisted through `updateRegistryState`, `:212`). Fleet listings gain the ability to return a tree or a filtered flat list; existing consumers (Agents tab, dispatch pickers, kanban agent selection) take the **filtered flat list** so nothing grows unexpectedly.

**Edge cases.** The parent link is by `agentInstanceId`, never by name — names are renameable and collision-counted. Filter at or just above the `ptyListTerminals` payload, since it is the single source for every picker.

### 3. Co-launch on head-agent open

**Logic.** Opening a head agent's terminal spawns its declared children as ptys, **unattached**, via N `ptyCreateTerminal` verb calls. Spawn is the lifecycle event; attachment is not.

**Edge cases.** Decide and document all-or-nothing vs best-effort on partial spawn failure. Enforce the per-parent and global caps *before* spawning any child, so a rejected batch does not leave a partial subtree. Report the cap, do not fail silently.

### 4. Split "exists" from "attached" in `src/webview/terminals.js`

**Context.** `createTerminalView` at `:3534` builds the pane and opens the socket at `:3991`; pane reconcile at `:1727` / `:2558`.

**Logic.** Introduce an explicit attach/detach on the terminal entry so a terminal can be live with no socket. Head agents attach as now; delegates attach only when viewed.

**Edge cases.** Detach must close the socket, not hide the pane. Detach must be idempotent (it can race a post-eviction reconnect). A detached entry must still render its identity in the grid so the operator can see the child exists.

### 5. The view control

**Context.** Action row built with append order documented at `terminals.js:2033`; positional reads at `:2035-2039`; kanban-mode hide loop at `:2321-2323`.

**Logic.** A control in the pane frame that reveals the focused head agent's children — attaching their sockets on open and detaching on close.

**Implementation.** Prefer **appending** at index 5 so no existing read shifts. If placement requires insertion, update the append order, `:2035-2039`, and `:2321-2323` in the same change. Give it the same per-pane-mode visibility treatment the existing controls have.

**Edge cases.** Disabled with a reason when the pty host is absent or the agent has no delegates (PRD #6 — never a dead click). No confirm dialog.

### 6. Per-child launch command

**Context.** `PtyFleetService.injectStartupCommand(handle, role)` at `ptyFleetService.ts:119-133` reads `GlobalIntegrationConfigService.getAgentStartupCommands()[role]` — role-keyed, machine-global — and `handle.sendText(cmd, true)` at `:129` after `SHELL_READINESS_DELAY_MS`. `ptyCreateTerminal` (`ptyHost.ts`) accepts only `role, name, cwd, worktreePath`.

**Logic.** A delegate launches with its own CLI/model rather than inheriting its parent's. Thread an explicit optional `startupCommand` through `ptyCreateTerminal` → `PtyFleetService.create()` → `injectStartupCommand`, where it **takes precedence** over the `commands[role]` lookup.

**Implementation.** The per-child command is read-only at this layer: it comes from the delegate definition and must **never** be written back into `GlobalIntegrationConfigService.getAgentStartupCommands()`. That write-back is the documented clobber class where a per-workspace mirror overwrites per-agent values — here it would rewrite every sibling agent's startup command.

**Edge cases.** Absent `startupCommand` → existing role behaviour, unchanged (this is what keeps non-delegate terminals byte-compatible). Preserve the `handle.status === 'active'` guard at `:127` and the readiness delay; a delegate is not special here. Two delegates of the same role under different parents must be able to carry different commands — the point of the change.

## Verification Plan

1. Define a head agent with three delegates; open it. Four ptys exist; **one** WebSocket is open. Verify at the gateway, not in the UI.
2. Dispatch to all three delegates with the panel closed entirely. All three run and report through `POST /delegates/result`; the parent's join returns all three. Nothing about the result path touches a terminal.
3. Open the view control → three sockets open and backscroll renders. Close it → three sockets close. Confirm at the gateway.
4. Run a delegate producing heavy output while detached, then attach. The tail renders. Confirm early output aged out of the 256 KB ring (expected — `terminalWsGateway.ts:5`) and that the *result* is unaffected.
5. Attach all delegates of two head agents simultaneously and confirm no eviction cascade (`terminalWsGateway.ts:713-731`). This is the constraint that motivated lazy attach — measure it, do not assume it.
6. Close a head agent while a delegate is mid-dispatch → the child reports or is reported `cancelled`; the parent's join terminates rather than hanging.
7. Two head agents each with a same-role delegate → names are parent-qualified and distinct; both resolve correctly by `agentInstanceId`.
8. Fresh install, no saved visibility entries → no delegate terminal opens by itself, and `tester` / `researcher` / `phone_a_friend` remain shut.
9. Exceed the per-parent and global delegate caps → refused with a stated reason, **before** any child spawns (no partial subtree).
10. **Pane action row, all five controls:** pin, clear, **model**, hide, mode all still operate on the right buttons after the change, in both terminal and kanban pane modes. Exercise every one — an index shift makes a button do a *neighbour's* job, which looks like nothing is wrong until clicked.
11. A delegate defined with a different CLI (e.g. a Devin terminal) launches with that command, not its parent's — and setting it does not alter any sibling agent's startup command in `GlobalIntegrationConfigService.getAgentStartupCommands()`. Inspect the stored config, not just the behaviour.
12. Two delegates of the **same role** under different parents, with different commands → each launches with its own. This is what the role-keyed lookup could not do.
13. Head agent and two delegates all editing the same tree: no isolation is provisioned, no branch is created, and the head agent reviews the combined diff in place.
14. Partial co-launch failure (force one `ptyCreateTerminal` to fail) → the documented behaviour occurs and is reported; the grid does not show a phantom pane.
15. **Capability absent:** with the pty host not running, the Agents-tab delegate section and the view control are disabled with a stated reason — no dead click, no stub success (PRD #6).
16. **Fleet-list containment:** with six delegates live, the Agents tab, dispatch pickers and kanban agent selection show the filtered flat list, not the expanded set.
17. **Both hosts:** repeat 1–3 against the standalone `npx` host as well as the extension host (PRD #7).

### Automated Tests

Not run in this planning pass (session directive). Recorded for the implementer:

- `src/test/terminal-pane-grid-reconcile-contract.test.js` and `src/test/terminal-pane-pinning-contract.test.js` — guard the pane row and reconcile behaviour this plan modifies.
- `src/test/terminal-rename-rekey-contract.test.js` — parses the name-keyed collection list; a new name-keyed delegate map will trip it (key on `agentInstanceId` instead).
- `src/test/webview-shim-injection-contract.test.js` — asserts `DEFAULT_VISIBLE_AGENTS` and friends are injected; relevant to any hierarchy default added to `sharedDefaults.js`.
- `src/test/terminal-dec-mode-restore-contract.test.js` — the three name-keyed teardown sites.
- Five regression tests are already red at HEAD; stash-verify before attributing a failure to this change.

## Recommendation

**Complexity 7 → Send to Lead Coder.**
