# Every Provider-Initiated Refresh Is a No-Op on the Host That Ships

## Goal

`KanbanProvider._refreshBoard` returns immediately when there is no VS Code webview panel, and the
standalone host never has one. So all 44 call sites — every verb that changes board state and then
asks the board to redraw — do nothing on the host that actually runs on the Pi. A project created by
an agent reaches the database and never reaches the screen.

### Problem analysis

**Observed 2026-09-15.** An agent created eight projects and assigned 81 features to them through
the board's own verbs (`addProject`, `assignSelectedToProject`, `setProjectFilter`). Every call
returned `{"success":true}`. The database is correct — a direct `getProjects()` against the resolved
board database returns all ten project names. The operator's dropdown stayed empty, through a page
reload.

**The mechanism** (`KanbanProvider.ts:4034`):

```ts
private async _refreshBoard(_workspaceRoot?: string) {
    if (!this._panel) {
        console.log('[KanbanProvider] _refreshBoard skipped: no panel');
        return;
    }
```

`_panel` is assigned in exactly one place — `vscode.window.createWebviewPanel` (`:1873`) — and
cleared on dispose (`:1896`). The standalone host never calls it. `bootstrap.ts:1497` states the
design directly: *"no sidebar in npx and never will be; pushes go to the WS hub once."* So on
standalone `_panel` is permanently `undefined`, and `_refreshBoard` is a permanent no-op.
`_refreshBoardImpl` (`:4052`) carries the same guard, so there is no path around it.

**Confirmed at runtime, not inferred:** the board log for that session contains **17** occurrences of
`[KanbanProvider] _refreshBoard skipped: no panel` — one per state-changing verb the agent issued.
The log line has been there the whole time; nothing reads it.

**Blast radius: 44 call sites.** Every verb that mutates board state and then refreshes is affected.
The failure is invisible because each verb still returns `{"success":true}` — the write genuinely
succeeded. Only the redraw was dropped. This is exactly the composition-root trap CLAUDE.md
describes: *"`Promise<void>` callbacks where 'never wired' and 'working' are the same value."*

**Two further defects sit on top of it, and the dropdown needs all three fixed.**

1. **The dropdown's data rides on a snapshot-only message.** The project list reaches the webview
   solely via `updateWorkspaceSelection` (`:1511`, inside a `snapshot` array), which carries
   `workspaces`, `projects` and `allWorkspaceProjects`. The high-frequency `updateBoard` message
   (`:1520`) carries none of them. So even with a working `_refreshBoard`, a project created at
   runtime would not appear — nothing re-sends `updateWorkspaceSelection` outside the initial
   snapshot.
2. **`addProject` notifies the wrong surface.** After the insert it posts `projectListChanged` to
   `this._planningPanelProvider` — the Project panel — and never to the board webview. On standalone
   that provider may not exist at all, so the notification reaches nobody.

**And one design mismatch that bites automation.** `addProject` calls
`setProjectFilter(projectName)` on every create, making the new project the active filter. That is
correct for the board's single create-project button. Called in a loop by an agent creating eight
projects, it leaves the board filtered to whichever was created last — which is how the operator's
board went blank on top of the dropdown being empty.

### Root cause

`KanbanProvider` was written when a VS Code webview panel was the only consumer, so `_panel` became
the stand-in for "is anyone listening?". The standalone host added a second consumer — the WS hub —
without revisiting that test. The guard now asks "is the *editor* watching?" while meaning "is
*anything* watching?", and answers no for the host that ships.

## Metadata

**Tags:** bugfix, reliability, backend, frontend, ux
**Complexity:** 6
**Repo:** switchboard

## User Review Required

No. The operator's requirement is explicit: *"agents should be able to create projects and they
should show instantly in the dropdown."*

## Settled Design

- **The refresh gate tests for consumers, not for a VS Code panel.** A push goes to every attached
  surface: the webview panel when one exists, the WS hub when clients are connected. No panel and no
  clients is the only case that legitimately skips, and it is not the standalone case.
- **A dropped push is logged as a fault, not as routine.** Today's `skipped: no panel` reads as
  normal operation; it has printed 17 times in one session while the product was visibly broken.
  Once the gate is correct, a skip with clients attached is a defect and must say so.
- **The project list gets a runtime delivery path.** Either `updateWorkspaceSelection` is re-sent
  when the project set changes, or the project fields ride on `updateBoard`. Prefer re-sending the
  targeted message: `updateBoard` is the hot path and widening it taxes every refresh.
- **`addProject` notifies the board, not only the Project panel.** Both surfaces show projects; both
  are told.
- **Creating a project stops implying "switch to it".** The filter change moves out of `addProject`
  and into the board button's own handler, which is the only caller that wants it. An agent creating
  a project must not move the operator's view. This is the same class as the CLAUDE.md fallback rule
  — a side effect that is right for one caller and wrong for the rest must not be buried in the
  shared path.
- **This plan does not restructure the push architecture.** It corrects one predicate, adds one
  delivery path, and moves one side effect. The broader "which surfaces exist and how do they
  subscribe" question belongs to the panel-push work already on the board.

## Complexity Audit

### Routine
- Moving the filter side effect out of `addProject`.
- Adding the board notification alongside the Project panel one.

### Complex / Risky
- **44 call sites change behaviour at once.** They have been silently doing nothing on standalone;
  making them work means 44 paths start pushing that never have. Expect latent bugs downstream —
  handlers that were never exercised on this host.
- **`_refreshBoard` is called from verb handlers that already return a payload.** With the gate
  fixed, some surfaces may now receive both a pushed update and a verb response carrying the same
  state. Check for double-render before widening the gate.
- **Both composition roots wire this.** The extension path must keep working exactly as it does;
  the fix widens the gate rather than replacing the panel branch.

## Edge-Case & Dependency Audit

- **Race conditions.** A push to the WS hub during a burst refresh could interleave with the
  debounced board refresh. `_scheduleBoardRefresh` already debounces at 100ms; route through it.
- **Security.** None.
- **Side effects.** Standalone starts receiving pushes it never got. That is the fix, and it is also
  the risk — see the Complexity Audit.
- **Dependencies & conflicts.**
  - `13c97a2b` *Panel Pushes Carry a Surface Tag* — the `updateWorkspaceSelection` snapshot already
    carries `surface: SURFACES.kanban`. Any new push must carry its surface tag or it fans out to
    every panel, which is the defect that feature exists to fix.
  - `30e0c0a7` *Defects the Parity Audits Could Not See — Omitted Wiring, Orphan Writes and
    Discarded Values* — this is a member of exactly that class and may belong inside that feature.
  - `01c83b6c` *Host Seam Audits: Classify the Channel, Make Failure Loud* — the "log a dropped push
    as a fault" half of this plan is that feature's thesis applied to the refresh path.
  - `879ceb0f` *A Machine-Foreign Path in `workspace-id`* — unrelated to this failure but present on
    this machine: line 2 of `.switchboard/workspace-id` is
    `/Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/kanban.db`, a macOS path that
    does not exist here. It did **not** cause this bug — the resolver fell through to the correct
    per-board database, verified by direct query — but it will mislead the next person debugging
    a data-path problem.

## Adversarial Synthesis

**Risk summary.** The one-line predicate fix is the whole bug and also the whole risk: 44 dormant
call sites wake at once on a host where they have never run. The safe sequencing is to fix the gate,
then exercise the verbs that use it rather than assuming they work, because "never wired" and
"working" have been the same value here for the life of the standalone host. The second risk is
scope: it is tempting to rework the push architecture while in here, and that is a different,
larger plan. The third is that the dropdown has three independent faults — gate, delivery path, and
notification target — so fixing only the famous one leaves the operator's symptom in place.

## Proposed Changes

### Change A — the refresh gate asks the right question

#### `src/services/KanbanProvider.ts` — `_refreshBoard` (`:4034`) and `_refreshBoardImpl` (`:4052`)
- **Logic:** replace `if (!this._panel) return` with a test for *any* attached consumer: the panel,
  or connected WS clients. Skip only when neither exists.
- **Edge case:** the log line must change with it. A skip when consumers exist is a fault and must
  be logged as one — the current wording reads as routine and printed 17 times during an outage.
- **Edge case:** audit the other three `if (!this._panel)` early-returns in this file for the same
  confusion. They may be correct (genuinely panel-only work) — establish which, and comment them so
  the next reader does not have to re-derive it.

### Change B — the project list can be delivered at runtime

#### `src/services/KanbanProvider.ts` — the `updateWorkspaceSelection` snapshot (`:1511`)
- **Logic:** make the workspace/project selection message sendable outside the initial snapshot, and
  send it when the project set changes.
- **Edge case:** it must carry `surface: SURFACES.kanban` like the snapshot copy does, or it fans
  out to every panel (see `13c97a2b`).
- **Edge case:** do **not** move the project fields onto `updateBoard`. That message is the hot path;
  widening it pays the cost on every refresh to serve a list that changes rarely.

### Change C — `addProject` tells the board, and stops hijacking the filter

#### `src/services/KanbanProvider.ts` — `case 'addProject'` (`:10581`)
- **Logic:** after the insert and cache invalidation, notify the board webview as well as the
  Project panel. Remove the `setProjectFilter(projectName)` call and make the board's
  create-project button perform the switch itself.
- **Edge case:** the existing comment argues the filter change prevents plans created next from
  landing in the wrong project. Verify what depends on that before removing it, and if a caller does
  rely on it, give `addProject` an explicit `makeActive` flag defaulting to false rather than
  keeping an implicit side effect.

### Change D — `getProjects` is reachable on the standalone host

- **Context:** `POST /kanban/verb/getProjects` answers *"Verb 'getProjects' not implemented in
  standalone mode"*, so an agent cannot read the project list from the host that ships, only write
  to it.
- **Logic:** wire the verb in the standalone composition root.
- **Edge case:** confirm whether other read verbs share this gap; a single unwired verb is a
  miss, a pattern of them is this plan's headline defect in another guise.

## Verification Plan

### Automated Tests
1. **Refresh reaches a client with no panel.** With no `_panel` and a connected WS client, a
   state-changing verb results in a push. Fails against today's code — the headline regression.
2. **A created project appears without a reload.** Drive `addProject` over HTTP against the
   standalone host, then assert the pushed payload contains the new name. This is the operator's
   stated requirement, asserted end to end.
3. **`addProject` does not move the active filter.** Create a project; assert
   `kanban.activeProjectFilter` is unchanged. Fails today.
4. **Batch creation leaves the view alone.** Create three projects in sequence; assert the filter is
   untouched and all three are present — the exact sequence that blanked the operator's board.
5. **`getProjects` answers on standalone.** No "not implemented in standalone mode".
6. **The dropped-push log line is a fault.** Assert a skip with consumers attached logs at warn or
   above, so the next outage is greppable.

### Goal Invariants
1. `_refreshBoard` and `_refreshBoardImpl` contain no bare `if (!this._panel) return`; the gate names
   the WS-hub consumer too. *(Paired positive: with a panel and no WS clients, the panel still
   receives its push — the extension path is widened, not replaced.)*
2. `KanbanProvider` can emit `updateWorkspaceSelection` outside the initial snapshot array, and that
   emission carries a `surface` tag.
3. `case 'addProject'` contains no unconditional `setProjectFilter` call.
4. `case 'addProject'` notifies the board webview, not only `_planningPanelProvider`.
5. `getProjects` is not in the standalone not-implemented set.
6. The no-consumer skip is logged at warn level or above and names that no surface was attached.
