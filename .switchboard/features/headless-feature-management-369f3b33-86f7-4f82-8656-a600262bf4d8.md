# Headless Feature Management

**Complexity:** 7

## Goal

Make feature management work in the standalone (npx switchboard) host, and stop the browser cockpit lying about it in the meantime.

Feature management is extension-only: six LocalApiServerOptions hooks are supplied solely by TaskViewerProvider, and the three UI verbs fall through standalone's kanbanVerb switch. The browser board ships the full feature UI anyway — PROMOTE TO FEATURE renders, enables, opens a modal, accepts a name, and does nothing. The failure is invisible because transport.js discards every {success:false} response without surfacing it.

This is a live violation of PRD contract #6 (capability-gating honesty) and contract #7 (two-layer completion, migrated-but-unreachable). The set fixes it in four steps: make failures visible, make the control honest, extract the logic host-agnostically, then wire it into the standalone host.

## How the Subtasks Achieve This

- **Surface Verb Failures in the Browser Transport** (Cx 2): Adds the missing `result.success === false` branch to `transport.js`'s verb response handler. Today a failure is re-dispatched as a typeless `MessageEvent` no UI handler consumes, so the server's honest *"Verb 'X' not implemented in standalone mode"* never reaches a human. Scope is deliberately wider than features — this makes **every** failing or unimplemented verb diagnosable, and it is the reason this gap went unnoticed for as long as it did.
- **Capability-Gate Feature Management in the Browser** (Cx 4): Adds a `featureManagement` capability *derived* from whether all six `LocalApiServerOptions` hooks are actually supplied, and disables `#btn-feature-action` with an explanatory tooltip when false. Restores PRD contract #6 immediately, without waiting for the wiring. The derivation is all-six by design: a flag that overstates what is wired turns a dead button into a lying one.
- **Extract a Host-Agnostic FeatureManagementService** (Cx 7): Moves the six operations off the ~12,000-line `KanbanProvider` — which the standalone host never constructs — into an injectable service with no `vscode` dependency, leaving thin forwarders behind. Wires nothing new; it exists to make the logic reachable. This is the only subtask that can affect the ~4,000 shipped installs, so it is gated on golden fixtures captured before any code moves.
- **Wire Feature Management into the Standalone Host** (Cx 5): Constructs the service in `bootstrap.ts`, supplies all six hooks so the seven existing routes stop returning 503, and adds the three UI verbs to the `kanbanVerb` switch so the browser board's button works. Completes PRD contract #7's Layer 2 and flips the capability flag to true.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Surface Verb Failures in the Browser Transport](../plans/browser-surface-verb-failures.md) — **PLAN REVIEWED**
- [ ] [Capability-Gate Feature Management in the Browser](../plans/capability-gate-feature-management.md) — **PLAN REVIEWED**
- [ ] [Extract a Host-Agnostic FeatureManagementService](../plans/extract-feature-management-service.md) — **PLAN REVIEWED**
- [ ] [Wire Feature Management into the Standalone Host](../plans/wire-feature-management-standalone.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**One hard dependency; the rest is recommended order.**

| # | Subtask | Constraint |
|---|---|---|
| 1 | Surface Verb Failures | None — fully independent, touches only `transport.js`. |
| 2 | Capability-Gate | None hard. Best after #1 so anything slipping the gate reports itself. |
| 3 | Extract Service | None. **Must precede #4.** |
| 4 | Wire Standalone | **Hard: requires #3.** There is nothing to wire until the service exists. |

**Ship #1 first.** It is a few lines, independently shippable, and converts this entire class of failure from silent to diagnosable — including any residual gap the later subtasks leave behind. Working on #3 or #4 before it means debugging blind.

**#2 before #4 is preferred**, so the button is never enabled-and-inert: #2 disables it honestly while unwired, #4 flips the capability and enables it. Reversing them leaves a window where the control works only for operations that happen to be wired.

**#1 and #2 can run in parallel with #3** — different files (`transport.js` / `kanban.html` vs `KanbanProvider.ts` + the new service), so no stream collision.

### Cross-feature serialisation

Subtask #3 edits `src/services/KanbanProvider.ts`, which the **Cross-Client Project Scope Independence** feature also edits. Per the PRD's one-stream-per-provider-file discipline, #3 must not run concurrently with that feature's subtasks. They touch different methods and share no helper, so there is no logical conflict — only file contention.

Subtask #4 edits `verbSchemas.ts`, shared across all provider work; serialise concurrent edits there.

### Where the risk actually is

Three of the four subtasks are additive or browser-only. **#3 is the only one that can break shipped installs**, because it moves live, mutating code — including operations that abandon worktrees and unlink external trackers — out of the provider the extension depends on. Its golden fixtures are the merge gate, and its end state is deliberately "extension unchanged, standalone still 503".
