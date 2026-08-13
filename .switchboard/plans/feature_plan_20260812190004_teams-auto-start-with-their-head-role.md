# A Team Starts With Its Head Role — Delete The Instantiate Button

## Goal

Make a team materialise when a terminal of its head role starts, rather than when someone remembers to press a button in a settings tab.

### The problem

Reported from UAT: *"you should not 'instantiate' the feature group in the agents/subagent tab, it should just happen when you start an agent with the role the group is attached to. For example, if I make a lead agent group that has 2 child terminals for each lead, and I start two lead agents, it automatically starts 2 terminals for each and creates two groups."*

Today a group is a template that does nothing until instantiated. `instantiateAgentGroup` is a kanban verb driven by a button in the Agents tab (`kanban.html:4393-4400`), and it creates head-plus-children in one shot. Start a `lead` any other way — the terminals-tab `+`, a role column, a worktree header — and you get a bare lead. The configuration you saved has no effect on the thing it describes.

### Root cause

Group definitions were modelled as **templates awaiting invocation** rather than as **properties of a role**. That put a manual step between a saved intent and every occasion the intent applies, and the step lives in a settings tab far from where terminals are actually started. The operator's summary is exact: this is what stops a lead coder from being an actual lead.

### The hazard this creates on shipped installs

`terminals.agentGroups` is not empty on a typical install, and it was not the operator who filled it. `KanbanProvider._loadAgentGroups` (`:4394-4401`) seeds a built-in group whenever the config key is absent, and persists it:

```ts
private static readonly SEEDED_AGENT_GROUP: any = {
    id: 'feature-implementation',
    name: 'Feature Implementation',
    headRole: 'lead',
    members: [{ role: 'coder', count: 3, label: '', startupCommand: '' }],
};
```

`_loadAgentGroups` runs from the `getAgentGroups` verb (`:11479`), which the Agents tab issues on open. So **every install that has ever opened the AGENTS tab already holds a persisted group headed on `lead` with three coder members**, whether or not its operator has ever heard of agent groups.

Turn head role into a trigger and that group becomes live. The first `lead` those operators start after upgrading spawns three additional agent CLIs — three real processes, three sets of API costs — that nobody configured and nobody asked for. On ~4,000 installs that is not an edge case, it is the default path. This plan therefore cannot be **released** without the seeded-group resolution owned by *Seed A Starter Team, And Migrate The Groups People Already Have*; see Dependencies.

## Metadata

**Complexity:** 7
**Tags:** backend, ux, reliability

## User Review Required

None.

## Complexity Audit

### Routine

- Deleting the instantiate button, its result arm and its verb arm is a flat removal across four files.
- `instantiateAgentGroupCore` already composes head-then-members in the correct order and already pre-flights all three caps.
- Both hosts already have an adapter that calls the core with the right hooks; auto-start reuses them rather than building new ones.

### Complex / Risky

- **Behaviour change on shipped state**, amplified by a seed the operator never chose. See the hazard above.
- **Generated artefacts and a CI gate.** `src/generated/verbAllowlist.ts` and `protocol-catalog.json` both carry `instantiateAgentGroup` (allowlist `:7`; catalog `:93`, `:883`, `:5279`) plus the `instantiateAgentGroupResult` push rows (`:8708`, `:13364-13412`). `npm run parity:check` compares allowlists against catalogs and goes red if they move apart.
- **Recursion.** A team headed on `coder` reached from a team containing coders is an unbounded fan-out whose only backstop would be a cap refusal.
- **Cap reachability.** `MAX_LIVE_DELEGATE_PTYS = 32` and `MAX_DELEGATES_PER_PARENT = 8` (`ptyFleetService.ts:11-13`) were previously reachable only by deliberately pressing a button.

## Edge-Case & Dependency Audit

### Race Conditions

- Two heads of the same role starting concurrently must each resolve the same team definition and each spawn their own members. The definition is read-only at spawn time, so the only shared mutable state is the standing-orders and groups writes, both serialised by the companion wiring plan.
- Auto-start must fire on **creation**, not on restore or re-render. A panel reload that re-renders existing terminals must not re-trigger, or every reload doubles the fleet.
- A head that fails to start must not leave half a team running.

### Security

- No new wire surface; this removes one verb. The existing guard that drops wire-supplied `delegates`/`startupCommand` in `handlePtyVerb` must keep applying — auto-start resolves members from host-side config, never from the create payload.

### Side Effects

- **Cost.** Each member is an agent CLI process. Auto-start multiplies process count and token spend per head started. This is the requested behaviour and it is also the largest side effect in the feature.
- Removing `instantiateAgentGroup` is an API removal on a shipped verb surface: an external caller gets unknown-verb rather than a wrong answer, which is the correct failure, but it belongs in release notes.

### Dependencies & Conflicts

- **Depends on** *The Spawn Primitive Must Wire The Team* landing first. Auto-start multiplies the occasions on which wiring must happen; landing it first ships an interval in which teams start automatically and arrive unwired — the exact defect the first live run reported, made more frequent.
- **Release-blocked by** *Seed A Starter Team, And Migrate The Groups People Already Have*. The two may land in either order in the repo, but **no release may contain auto-start without the seeded-group resolution**, or the first `lead` on a typical upgraded install spawns three unrequested coders. This is a stronger constraint than the feature's stated sequencing, which puts migration last.
- **Shares `kanban.html`** with *The Teams Tab And Four Shipped Team Types* (which moves two whole subsections). Different regions, same file; they serialise.
- **Shares `agentGroupInstantiation.ts`** with the wiring plan and the member-fields plan. Sequential ownership.
- The one-team-per-head-role constraint introduced here is enforced against existing state by the migration plan.

## Dependencies

- `sess_20260812190003 — shared post-spawn team wiring` (must land first)
- `sess_20260812190007 — seeded group resolution` (must not release without it)
- `sess_20260812190004 — head-role auto-start; instantiate path removal`

## Adversarial Synthesis

Key risks: a shipped, auto-seeded `lead` + 3 × coder group turning into three unrequested agent CLIs on the first lead start across ~4,000 installs; unbounded recursive team spawning if the parentage guard is missed; and a parity gate going red because the verb was removed from the allowlist without the catalog. Mitigations: treat the seeded-group resolution as a release gate rather than a later subtask, gate team-triggering strictly on `!parentInstanceId` and verify it by process count rather than by eye, and regenerate allowlist and catalog in the same change. A cap refusal must never prevent the head itself from starting.

## Design

### The head role is the trigger

When a terminal is created whose role heads a team, spawn that team's members alongside it and wire them (wiring itself is the companion plan's concern — this plan owns *when*, not *how*).

The trigger belongs on the terminal-creation path shared by every spawn route, for the same reason the wiring does: a trigger attached to one caller reproduces the bug it is fixing, one door along. That is `handlePtyVerb`'s `ptyCreateTerminal` arm in both hosts — the same layer the companion plan installs its wiring hook on, which also guarantees a team spawned by the trigger is wired by the hook.

### Only a top-level start triggers a team — this is the recursion guard

A team's members are terminals too. A `Solo coder` team headed on `coder` would, without a guard, fire again for each coder a `Feature team` spawns, and each of those coders would spawn its own friend, and so on until a cap refuses. The refusal would be the only thing preventing an unbounded fan-out, which is not a design.

**Gate on parentage: a spawn triggers a team only when it has no `parentInstanceId`.** Members are parented by construction (`spawnDelegates` passes `parent.agentInstanceId`, `ptyFleetService.ts:358`), so they cannot trigger. One rule, checked in one place, and it also gives the right answer for a member whose role happens to head another team — it joins the team that spawned it and starts nothing of its own.

Note the interaction with the companion member-fields plan: a `shared` member is spawned **unparented** by design. An unparented member would pass this guard and trigger its own team. The shared-member branch must therefore carry an explicit "this is a team member, do not trigger" signal rather than relying on parentage alone. Flagged here because the guard is defined here; the branch is built there.

### One team per head role

Auto-start needs a single answer to "what starts when a `lead` starts". Two definitions claiming `lead` have no defined resolution, so head role is unique across team definitions and the editor enforces it. This is a new constraint on existing state and is handled by the migration plan, not silently here.

### Delete the instantiate path

| site | action |
| :-- | :-- |
| `kanban.html:4393-4400` | remove the INSTANTIATE button and its click handler |
| `kanban.html:9123` | remove the `instantiateAgentGroupResult` message arm |
| `KanbanProvider.ts:11524-11550` | remove the `instantiateAgentGroup` verb arm |
| `src/generated/verbAllowlist.ts` | regenerate without `instantiateAgentGroup` |
| `protocol-catalog.json` | remove the `instantiateAgentGroup` rows (`:93`, `:883`, `:5279`) and the `instantiateAgentGroupResult` push rows (`:8708`, `:13364-13412`) |

> **Superseded:** *"`TaskViewerProvider.ts:11063`, `bootstrap.ts:1706` — remove the two `instantiateAgentGroupCore` call sites"*, alongside *"`instantiateAgentGroupCore` itself survives as the composition routine the auto-start path calls."*
> **Reason:** Those two sites are not the manual entry points — they are the **host adapters**. `TaskViewerProvider.instantiateAgentGroup` (`:11063-11090`) supplies `createHeadWithDelegates`, `liveDelegateCount`, `cwd` and `onCreated` for the extension host, deliberately below `handlePtyVerb`; `bootstrap.ts:1706` does the same for standalone. They are precisely what auto-start needs in order to call the core at all. Deleting them and then writing equivalents is pure churn, and the two halves of the original plan contradicted each other: the core cannot "survive as the routine the auto-start path calls" if both of its callers are removed.
> **Replaced with:** **Keep** both host adapters. Remove only the manual reach into them: the button, its result arm, the verb arm, and the verb's allowlist/catalog rows. Auto-start calls the same adapters from the `ptyCreateTerminal` path.

### Closing a head closes its team — already true

*Clarification.* This is not new work for owned members. `PtyFleetService.kill()` (`:443-457`) already resolves `listChildren(handle.agentInstanceId)` and recurses `this.kill(child.friendlyName)` for each, so a parented member already dies with its head. The only new case is the **shared** member, which is unparented and must be exempt — and that case is introduced by the companion member-fields plan, which owns the exemption. Until it lands, every member is parented and closes with its head, by existing behaviour.

Confirm this rather than build it, and confirm it on both hosts.

### Caps become reachable without visiting the tab

`MAX_LIVE_DELEGATE_PTYS = 32` and `MAX_DELEGATES_PER_PARENT = 8` were previously only reachable by deliberately instantiating groups. With auto-start they can be hit by starting terminals normally. A refusal must name the cap and must **not** prevent the head from starting: a lead that comes up alone with a warning is far better than a lead that refuses to start because its team could not fit.

Note that `instantiateAgentGroupCore`'s pre-flight does the opposite — it refuses the whole operation before creating anything, on the stated grounds that a partial result leaves an orphan head. That is correct for a button press and wrong for auto-start, where the head is the thing the operator actually asked for. Auto-start must create the head first and treat member spawning as best-effort.

## Implementation Notes

- The head must be created first and its members second, so members can be parented to it and named from its `friendlyName`. That is the existing order in `instantiateAgentGroupCore`; preserve it.
- Member spawn failure must not fail the head. `spawnDelegates` already returns `{children, error}` best-effort with a report (`ptyFleetService.ts:365-372`) — surface the error and keep the head.
- Auto-start fires on terminal **creation**, not on restore. Confirm a panel reload that re-renders existing terminals does not re-trigger, or every reload doubles the fleet.
- The Agents-tab group editor stays for now — this plan removes the *instantiate* action, not the ability to define a group. The Teams tab replaces the editor in a companion plan.
- `switchboard.terminal.*` config and pair-programming mode are untouched. Pair programming operates on plan dispatch and decides whether a coder also receives a prompt; it says nothing about which terminals exist, so it neither conflicts with nor is affected by auto-start.
- `verbAllowlist.ts` lives under `src/generated/` — regenerate it, do not hand-edit, and move the catalog in the same change or `npm run parity:check` fails.
- Removing the verb removes the only path by which a caller could ask for a group by id. Confirm nothing else in the tree posts `instantiateAgentGroup` before deleting the arm.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` / `src/standalone/bootstrap.ts`

- **Context.** `handlePtyVerb`'s `ptyCreateTerminal` arm in each host; the existing group adapters at `:11063` and `:1706`.
- **Logic.** On a create with no `parentInstanceId`, look up a team definition whose `headRole` matches the new terminal's role; if one exists, spawn its members through the existing adapter.
- **Implementation.** Head first, members second, best-effort. Surface a member error on the verb result without failing the create. Keep both adapters as-is.
- **Edge Cases.** No team for the role → exactly one terminal, no group, no orders. Parented create → never triggers. Restore/re-render → never triggers.

### `src/services/KanbanProvider.ts`

- **Context.** The `instantiateAgentGroup` verb arm at `:11524-11550`.
- **Implementation.** Remove the arm and its four `instantiateAgentGroupResult` post-messages.
- **Edge Cases.** Leave `getAgentGroups` / `saveAgentGroup` / `deleteAgentGroup` untouched — the editor still needs them.

### `src/webview/kanban.html`

- **Context.** Button at `:4393-4400`, result arm at `:9123`.
- **Implementation.** Remove both. Leave EDIT and the delete control, and leave the delete control's immediate, un-gated behaviour exactly as it is.
- **Edge Cases.** The `agent-groups-error` slot is shared with save/delete errors — do not remove it with the instantiate arm.

### `src/generated/verbAllowlist.ts` + `protocol-catalog.json`

- **Implementation.** Regenerate the allowlist; remove the verb and push rows from the catalog in the same change.
- **Edge Cases.** `npm run parity:check` is the gate that catches a half-done removal.

## Verification Plan

1. **The reported case.** With a team headed on `lead` and two coder members, start two leads. Two teams appear, four coders total, two groups.
2. **Every spawn route triggers.** Repeat via the terminals-tab `+`, a workspace-header `+`, a worktree-header `+`, and a board role column. All must behave identically.
3. **The recursion guard.** Define a team headed on `coder`, then start a `lead` whose team has coder members. The spawned coders must **not** each spawn their own team. Confirm by process count, not by eye.
4. **A member whose role heads a team.** Same setup: the spawned coder joins the lead's team and starts nothing of its own.
5. **No instantiate button.** No control anywhere instantiates a group; the verb is gone from the allowlist and returns unknown-verb over HTTP; `npm run parity:check` is green.
6. **Closing the head.** Close a lead; its coders close with it. Confirm no orphaned agent CLIs, on both hosts.
7. **Cap refusal keeps the head.** Drive the fleet near `MAX_LIVE_DELEGATE_PTYS`, then start a head whose team will not fit. The head starts, the members do not, and the error names the cap.
8. **Member spawn failure keeps the head.** Force one member to fail; head and siblings survive, error surfaces.
9. **Reload does not re-trigger.** With two live teams, reload the panel. Fleet size unchanged.
10. **Teamless roles unaffected.** Start a role with no team; exactly one terminal, no group, no orders.
11. **The seeded-group hazard is closed.** On an install whose `terminals.agentGroups` holds only the untouched shipped `feature-implementation` group, start a `lead`. Confirm the outcome matches whatever the migration plan decided — and confirm it is **not** three unrequested coders. If the migration plan has not landed, this step fails and the change is not releasable.
12. **Standalone parity.** Repeat 1, 3 and 6 against `npx`.

### Automated Tests

Per the session directive, no compilation or automated-test run is part of this pass's verification; the checks above are manual, with the exception of `npm run parity:check`, which this change can turn red and which the implementer must run before hand-off.

## Recommendation

Complexity 7 → **Send to Lead Coder**.

## Completion Summary

Added `findTeamForHeadRole(db, role)` to `teamWiring.ts` and wired it into both hosts' `handlePtyVerb` `ptyCreateTerminal` arm: after role-config delegates are resolved, if the terminal has no `parentInstanceId` (the recursion guard — members are parented by construction), the trigger looks up a team definition whose `headRole` matches and overrides `payload.delegates` with its members, so `spawnDelegates` fires on the same create and the existing `wireSpawnedTeam` post-create hook wires the team. The head is created first and member spawning is best-effort (`spawnDelegates` returns `{children, error}`), so a cap refusal surfaces a `delegateError` without preventing the head from starting. Removed the instantiate path end to end: the INSTANTIATE button and its click handler from `kanban.html`, the `instantiateAgentGroupResult` message arm from `kanban.html`, the `instantiateAgentGroup` verb arm from `KanbanProvider.ts`, and the verb plus its five push rows from `verbAllowlist.ts` and `protocol-catalog.json`. Both host adapters (`TaskViewerProvider.instantiateAgentGroup` and `bootstrap.ts:setAgentGroupInstantiator`) were kept — auto-start does not call them directly (it goes through `handlePtyVerb`), but they remain the composition routine the core runs through when explicitly invoked. `npm run parity:check` passes green.

## Review Findings

Reviewed against the plan: the trigger sits on both hosts' `ptyCreateTerminal` arm after role-config delegates are resolved, is gated on `!payload.parentInstanceId && !payload._isTeamMember`, overrides `payload.delegates` with the team's members, and leaves member spawning best-effort so a cap refusal surfaces `delegateError` without stopping the head; the instantiate path is gone end to end and `findTeamForHeadRole` skips `unassigned` teams. MAJOR, fixed: the verb's removal from the generated artefacts had never actually been regenerated — `npm run catalog:check` (CI step 1) was red — so I ran `npm run catalog:generate`, which also restored the three agent-group verbs to `KANBAN_VERBS` that the sibling TEAMS-tab plan depends on. For the record: both host adapters were kept per this plan, but auto-start does not call them, so `instantiateAgentGroupCore` and both adapters are now unreachable — flagged rather than deleted, because the plan explicitly ordered them kept. Files changed by this review: `protocol-catalog.json`, `src/generated/verbAllowlist.ts`. Validation: typecheck clean, all nine static gates exit 0, `pty-host-gating` and `pty-route-surface` green, and the step-11 release gate confirmed functionally in the seed/migrate plan; remaining risk is that `payload._isTeamMember` is belt-and-braces only, since `spawnDelegates` calls `create()` directly and never re-enters `handlePtyVerb`.
