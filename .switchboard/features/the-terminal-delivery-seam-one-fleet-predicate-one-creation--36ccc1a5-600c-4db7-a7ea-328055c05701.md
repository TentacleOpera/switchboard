# The Terminal-Delivery Seam: One Fleet Predicate, One Creation Policy

**Complexity:** 6

## Goal

Fix the two halves of the terminal-delivery seam that both hang off TaskViewerProvider._ptyHostPort meaning a fleet exists, when it actually means the fleet lives in a child process. Seven prompt-delivery features are silently unavailable under npx switchboard on a host that owns a live in-process fleet, and on the VS Code host a role that resolves to no terminal now declines rather than spawning, which is a lost affordance for roughly 4,000 shipped installs since the allowPtyFleet deletion. Together these replace the field with a host-agnostic predicate and give the resolve-to-nothing case a real answer: spawn in the fleet, where the terminal is visible to both surfaces at once.

## How the Subtasks Achieve This

- **One Fleet Seam: Stop `_ptyHostPort` Meaning "A Fleet Exists"**: adds an injectable `_fleetVerb` fallback to `_ptyHostVerb`, introduces a `_hasFleet()` predicate that is exactly "a child port OR an injected verb", and swaps the seven guards that currently read the child-process port as a proxy for fleet existence. Standalone registers its in-process fleet through the same seam, which makes the Design panel sends, the Artifacts planner and architect sends, the analyst message, the project-manager terminal, agent-to-agent messaging, the delegate prompt block and role-to-terminal-name resolution all work under `npx switchboard`.
- **Terminal Creation Policy — Spawn in the Fleet Instead of Declining**: supplies the third branch the parent plan specified but never shipped. When a role resolves to nothing in either set and a fleet is running, it spawns in the fleet — reaching startup-command and settle parity with the VS Code path — rather than returning `false` and degrading to a clipboard fallback. It converts **both** creation paths (`sendPromptToAgentTerminal` and `PlanningPanelProvider._sendPromptToTerminal`) in one change, so the policy does not diverge again. `_deliverPromptToPmTerminal` was verified at HEAD to have no creation path at all — its clipboard-only behaviour is deliberate and documented, so it is explicitly out of scope rather than a third path to convert. The startup command is applied **conditionally**: `PtyFleetService.create()` already injects the role's configured command, so the seam tops up only the cases the fleet's narrower resolution misses (hard-coded role fallbacks such as `claude_artifacts`, custom agents, and pre-backfill legacy installs).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Terminal Creation Policy — Spawn in the Fleet Instead of Declining](../plans/terminal-creation-policy-spawn-in-the-fleet.md) — **CODER CODED** — ID: f880bd33-e127-4562-9959-cdca33cd318d
- [ ] [One Fleet Seam: Stop `_ptyHostPort` Meaning "A Fleet Exists"](../plans/feature_plan_20260812150000_fleet-seam-standalone-terminal-parity.md) — **CODER CODED** — ID: fefc269b-df55-41d2-b774-b73ee6c5ebd7
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Hard ordering, and a direct collision on one line.** These two subtasks edit the *same guard*. The fleet-seam plan swaps `if (this._ptyHostPort) { return false; }` in `sendPromptToAgentTerminal` for `this._hasFleet()`; the creation-policy plan replaces that same statement with a fleet-spawn attempt.

1. **One Fleet Seam first.** It establishes `_hasFleet()` as the predicate and the `_fleetVerb` seam the spawn path will need on standalone.
2. **Terminal Creation Policy second**, written on top of `_hasFleet()` rather than on the raw port field.

Landing them in the other order means the creation policy is written against a predicate that is about to be replaced, and the guard gets rewritten twice.

**Shared files — one agent stream:** both touch `src/services/TaskViewerProvider.ts` and `src/services/PlanningPanelProvider.ts`, and both touch `src/test/browser-direct-terminal-helpers.test.js`.

**Reconciled test ownership (verified 2026-08-14).** A census of source-text pins (`grep -rn "_ptyHostPort" src/test/`, plus `hasPtyHost`) found **four** pinned assertions across **three** CI-wired files, not one assertion in one file. Each is assigned a single owner so the two subtasks never edit the same assertion:

| File:line | Pins | Owner |
| :--- | :--- | :--- |
| `browser-direct-terminal-helpers.test.js:75` | `_tryFleetDeliveryForRole` literal `if (!this._ptyHostPort)` | **One Fleet Seam** — rewrite to `_hasFleet()` |
| `browser-direct-terminal-helpers.test.js:109` | `sendPromptToAgentTerminal` literal `if (this._ptyHostPort)` | **One Fleet Seam** — rewrite to `_hasFleet()` |
| `pty-dispatch-focus-contract.test.js:199` | `_isLikelyPtyDispatchTarget` literal `if (!this._ptyHostPort)` | **One Fleet Seam** — rewrite to `_hasFleet()` |
| `browser-direct-terminal-helpers.test.js:96` | `hasPtyHost()` present in `_sendPromptToTerminal` | **Terminal Creation Policy** — keep green, do not rewrite |

The contradiction flagged earlier resolves cleanly: the creation-policy subtask keeps `hasPtyHost()` as the *branch selector* and changes only what the true branch does (spawn instead of decline), so the literal survives and no assertion is contested. The fleet-seam subtask must not treat `browser-direct-terminal-helpers` as a must-stay-green gate — it reds on that plan executing correctly, and reverting the two chokepoint swaps to "fix" it would undo the feature's entire point.

**Practical, non-blocking:** the fleet-seam plan registers its seam in the same `bootstrap.ts` block as the already-landed Agent Groups `setAgentGroupInstantiator`; land after it to avoid resolving that block twice.

**Byte-compatibility is non-negotiable in both.** The no-fleet VS Code branch must stay identical for installs where node-pty does not load, and `_hasFleet()` must be exactly two ORed fields — a false positive stops delivery falling back to the VS Code terminal on roughly 4,000 installs that work today, which is strictly worse than the current false negative.

## Implementation Summary

Terminal delivery now uses one host-agnostic fleet predicate backed by either the extension child-host port or an injected standalone fleet verb. Standalone injects that verb only when `node-pty` is available, preserving honest no-fleet fallback behavior. Missing role terminals now spawn in the fleet from both TaskViewerProvider and PlanningPanelProvider, with conditional startup-command top-up and shell/agent settle delays. Contract coverage was added and wired into CI; automated tests and compilation were not run for this delivery by explicit instruction.
