# One controller, enforced at the service

## Goal

Make "there is never more than one controller terminal" an invariant the pty service enforces, rather than a property a client-side flag hopes for. A singleton role refuses a second seat instead of falling through to the name-collision loop.

### Problem Analysis

The rule is stated nowhere and enforced nowhere that covers the race. Three layers exist and each misses:

**1. `ptyFleetService.create()` is designed to make a second one.** `:222-227`:

```
let name = friendlyName || `${role}-1`;
let counter = 1;
while (this.terminals.has(name)) {
    counter++;
    name = `${role}-${counter}`;
}
```

A taken name increments. No role is exempt — the word "orchestrator" does not appear in the file at all, so the service has no notion that any role is unique. For a coder, `coder-2` is correct behaviour; for the controller it manufactures the state that must never exist.

**2. The server guard checks adoption, not occupancy.** `TaskViewerProvider.ts:11307-11308` reads `this._autobanState.orchestratorSeat` and short-circuits when a session has already adopted the role. But adoption happens **after** the terminal exists — `shell.js`'s own comment measures the gap: *"the agent adopts the seat seconds or minutes after the terminal is created, so two rapid clicks both see an empty seat and spawn a second 'Orchestrator' terminal (renamed to 'orchestrator-2' by ptyFleetService.create's collision loop)."* So the guard is blind for the whole window in which the mistake is possible.

**3. The only guard over that window is client-side and per-tab.** `orchestrationStartInFlight` is a module-level JS variable in `shell.js`. It is defeated by: two shell tabs, a shell tab plus the extension panel, a reload mid-flight, or any other caller of the start path. The comment is explicit that *"the server's seat guard cannot help here"* — which is true, and is an argument for a different server guard rather than for a client one.

**Why a second controller is worse than a second coder.** The persona holds session state that assumes it is alone: it stages queues, dispatches card one, arms watches, and posts handoff reports. Two instances race on the same board — both may stage, both may dispatch, both may hand off — and the second's existence is invisible except as a terminal named `orchestrator-2`. Nothing downstream checks for a sibling, because nothing was built expecting one.

### Root Cause

The collision loop is a good default for the fleet — a user wanting three coders should get `coder-2` and `coder-3` rather than an error. Singleton-ness was never expressed as a property of a role, so the one role that needs it inherits the many-seat behaviour, and every guard added since has been placed at the layer that happened to be convenient rather than the layer that owns creation.

## Metadata

**Complexity:** 3
**Tags:** bugfix, reliability, backend

## User Review Required

- **What happens on a second start — refuse, or focus the existing one?** Refusing with a clear message is honest; returning the existing handle makes the button idempotent and is probably the better UX ("start" on an already-running controller reveals it rather than erroring). Recommending **return the existing seat and surface it**, with a refusal only when the existing terminal is dead and cannot be reused.
- **Which roles are singletons?** The controller certainly. Possibly `project_manager` and `researcher` — both are referred to in the singular throughout (`_tryFleetDeliveryForRole('project_manager', …)` selects *the* PM), and a second of either would confuse role-based delivery the same way. Worth deciding as a set rather than special-casing one.

## Complexity Audit

### Routine

- A singleton-role list, and a branch in `create()` that consults it before the collision loop.
- Removing the now-redundant client-side in-flight flag, or keeping it purely as a UI affordance (disabled button) rather than as the guard.

### Complex / Risky

- **Enforce at `create()`, not at the callers.** The reason the current guards fail is that they sit above creation, and each new surface adds another place to forget. `create()` is the one chokepoint every path goes through — the rail button, `startOrchestratorFromKanban`, the standalone host, and any future panel or dock control.
- **Role-based delivery already assumes singletons and will silently pick one.** `_tryFleetDeliveryForRole(role, …)` selects by role; with two controllers it delivers to whichever it finds first. So today a duplicate does not announce itself as an error — it announces itself as work going to the wrong terminal, which is far harder to diagnose. Fixing creation fixes that class without touching delivery.
- **A dead terminal holding the name must not lock the role out permanently.** If `orchestrator` exists but its process is gone, a refusal would leave the user unable to start one. The check must be for a *live* seat, and the reuse path must handle "named terminal exists, process dead" by reclaiming rather than refusing.
- **`orchestrator-2` may already exist in the wild.** Anyone who double-clicked has one. The change should not orphan it: on startup, or on the first singleton check, a duplicate should be reported (not silently killed — it may have unsaved context in its scrollback).
- **The standalone host has its own creation path.** Verify `bootstrap.ts` routes through the same `create()`; if it constructs terminals another way, the guard needs to cover both or the invariant holds only in the extension.

## Edge-Case & Dependency Audit

**Migration.** No stored state. Existing `orchestrator-2` terminals are reported rather than removed.

**Security.** Neutral. No new surface; a refusal path is added.

**Side effects.** The rail button becomes idempotent under the recommended option — a second click reveals the running controller instead of doing nothing (its current in-flight no-op) or spawning a sibling (its behaviour once the flag is defeated).

**Ordering.** Independent and shippable now. It is a **precondition** for the Mission Control surfaces: the panel, the dock and the rail button all reach the same start path, and three entry points over an unenforced singleton is three ways to break it.

## Dependencies

- **Precondition for** `mission-control-panel-ui-specification.md` and `feature_plan_20260808220200_shell-right-agent-dock-terminal.md` — both add surfaces that touch the controller, and neither should ship while the invariant is client-side.
- Independent of the missions and automation work.

## Adversarial Synthesis

**"The in-flight flag already handles this."** It handles one tab. The comment that introduces it says the server cannot help, which is the tell: a client guard was chosen because the available server guard checked the wrong thing, not because a client guard was sufficient.

**"Two controllers is a user error — let them."** A user cannot see it. The duplicate is named `orchestrator-2` and nothing surfaces it as a problem; role-based delivery just starts sending work to one of them. An invariant the system relies on internally should not be the user's job to maintain.

**"Make the collision loop refuse for every role."** No — three coders is a legitimate configuration and the loop serves it correctly. Singleton-ness is a property of specific roles, so it belongs in a list, not in the loop's general behaviour.

**"Guard in the start handler instead — it is one place."** It is one place *today*. The panel, the dock and the rail all reach the controller, and the last two revisions of those plans each proposed a start control before finding the existing one. Creation is the chokepoint that cannot be bypassed by a new surface.

## Proposed Changes

1. **Declare singleton roles** as data, with the controller in the set (and a decision on `project_manager` / `researcher`).
2. **`create()` consults it before the collision loop**: for a singleton role with a live terminal, return that handle rather than minting `<role>-2`.
3. **Reclaim, do not refuse, when the named terminal is dead** — a stale name must not lock the role out.
4. **Demote the client flag** to a UI affordance (disable the button while a start is pending); it is no longer the guard.
5. **Report pre-existing duplicates** rather than removing them — scrollback may matter.
6. **Verify the standalone creation path** routes through the same `create()`.

### Migration

None. Existing duplicates are reported, not deleted.

## Verification Plan

### Goal Invariants

- No sequence of calls produces two live terminals for a singleton role.
- A dead singleton terminal can always be replaced.
- Non-singleton roles still get `<role>-2`.

### Automated Tests

- **Concurrent starts yield one terminal:** fire two `/orchestration/start` calls with no delay between them and assert exactly one controller exists. This is the actual bug — the existing client flag passes a sequential test and fails this one, so a sequential-only test would certify the defect.
- **Two surfaces, one controller:** start from the rail path and the panel path simultaneously; assert one. The per-tab flag cannot cover this and it is the realistic failure once three surfaces exist.
- **Adoption-window race:** create the terminal, and before adoption, call start again; assert no second terminal. This is the window `shell.js` documents as "seconds or minutes".
- **Dead terminal is reclaimable:** kill the process, leave the name, call start; assert a working controller rather than a refusal.
- **Collision loop intact for others:** create three coders; assert `coder-2` and `coder-3`.
- **Standalone parity:** run the same concurrent-start assertion against the standalone host.
- **Pre-existing duplicate is reported:** seed `orchestrator-2`; assert it is surfaced and not deleted.

## Outstanding Questions

- **[user]** Refuse, or return the existing seat? Recommending return-and-reveal.
- **[user]** Is the singleton set just the controller, or also `project_manager` and `researcher`?
- Does anything today *rely* on being able to create a second controller — a test fixture, or a multi-workspace case where each root wants its own? A per-workspace singleton is a different rule from a global one, and the `worktrees`-table lesson from this programme is that unscoped uniqueness bites in multi-root setups.
