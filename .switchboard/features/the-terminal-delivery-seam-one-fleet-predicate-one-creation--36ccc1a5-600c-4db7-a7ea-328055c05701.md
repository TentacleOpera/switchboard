# The Terminal-Delivery Seam: One Fleet Predicate, One Creation Policy

**Complexity:** 6

## Goal

Fix the two halves of the terminal-delivery seam that both hang off TaskViewerProvider._ptyHostPort meaning a fleet exists, when it actually means the fleet lives in a child process. Seven prompt-delivery features are silently unavailable under npx switchboard on a host that owns a live in-process fleet, and on the VS Code host a role that resolves to no terminal now declines rather than spawning, which is a lost affordance for roughly 4,000 shipped installs since the allowPtyFleet deletion. Together these replace the field with a host-agnostic predicate and give the resolve-to-nothing case a real answer: spawn in the fleet, where the terminal is visible to both surfaces at once.

## How the Subtasks Achieve This

- **One Fleet Seam: Stop `_ptyHostPort` Meaning "A Fleet Exists"**: adds an injectable `_fleetVerb` fallback to `_ptyHostVerb`, introduces a `_hasFleet()` predicate that is exactly "a child port OR an injected verb", and swaps the seven guards that currently read the child-process port as a proxy for fleet existence. Standalone registers its in-process fleet through the same seam, which makes the Design panel sends, the Artifacts planner and architect sends, the analyst message, the project-manager terminal, agent-to-agent messaging, the delegate prompt block and role-to-terminal-name resolution all work under `npx switchboard`.
- **Terminal Creation Policy — Spawn in the Fleet Instead of Declining**: supplies the third branch the parent plan specified but never shipped. When a role resolves to nothing in either set and a fleet is running, it spawns in the fleet — with the same startup-command and settle behaviour the VS Code path has always applied — rather than returning `false` and degrading to a clipboard fallback. It converts all three creation paths, so the policy does not diverge again.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Terminal Creation Policy — Spawn in the Fleet Instead of Declining](../plans/terminal-creation-policy-spawn-in-the-fleet.md) — **PLAN REVIEWED**
- [ ] [One Fleet Seam: Stop `_ptyHostPort` Meaning "A Fleet Exists"](../plans/feature_plan_20260812150000_fleet-seam-standalone-terminal-parity.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Hard ordering, and a direct collision on one line.** These two subtasks edit the *same guard*. The fleet-seam plan swaps `if (this._ptyHostPort) { return false; }` in `sendPromptToAgentTerminal` for `this._hasFleet()`; the creation-policy plan replaces that same statement with a fleet-spawn attempt.

1. **One Fleet Seam first.** It establishes `_hasFleet()` as the predicate and the `_fleetVerb` seam the spawn path will need on standalone.
2. **Terminal Creation Policy second**, written on top of `_hasFleet()` rather than on the raw port field.

Landing them in the other order means the creation policy is written against a predicate that is about to be replaced, and the guard gets rewritten twice.

**Shared files — one agent stream:** both touch `src/services/TaskViewerProvider.ts` and `src/services/PlanningPanelProvider.ts`, and both touch `src/test/browser-direct-terminal-helpers.test.js`. That test currently asserts *"refuses to create a terminal when fleet is available"* — the fleet-seam plan requires the literal `hasPtyHost()` to survive in `PlanningPanelProvider._sendPromptToTerminal`, while the creation-policy plan rewrites the refusal assertion into the three-branch policy. Both edits to that file must be made deliberately, with the old assertion's intent recorded inline.

**Practical, non-blocking:** the fleet-seam plan registers its seam in the same `bootstrap.ts` block as the already-landed Agent Groups `setAgentGroupInstantiator`; land after it to avoid resolving that block twice.

**Byte-compatibility is non-negotiable in both.** The no-fleet VS Code branch must stay identical for installs where node-pty does not load, and `_hasFleet()` must be exactly two ORed fields — a false positive stops delivery falling back to the VS Code terminal on roughly 4,000 installs that work today, which is strictly worse than the current false negative.
