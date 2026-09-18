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

## Review Findings

Reviewed commit `4f165c9e`. The feature goal is achieved: `_hasFleet()` is exactly `!!this._ptyHostPort || !!this._fleetVerb`, standalone injects its fleet through `setFleetVerb` (gated on `ptyReady`), and both in-scope creation paths now spawn in the fleet while `_deliverPromptToPmTerminal` and `_dispatchResearchToResearcher` stay untouched. Four fixes were applied: the newly CI-wired `standalone-fleet-seam-contract.test.js` was red on delivery (3/13 — its `extractMethodBody` mis-extracted return-type object literals, and two assertions were written to the plan's stale census rather than the code), `seat-safeguards-fleet-prompt-path.test.js` was red on a 12→14 `_dispatchExecuteMessage` census, `standalone-agent-team-isolation-contract.test.js` was red pinning the deleted `_headlessRuntime.ptyVerb` branch, and `handlePtyVerb` in `bootstrap.ts` had no `ptyWrite` arm, so the startup-command top-up silently no-opped on standalone and skipped its settle. Files changed: `src/standalone/bootstrap.ts`, `src/test/standalone-fleet-seam-contract.test.js`, `src/test/seat-safeguards-fleet-prompt-path.test.js`, `src/test/standalone-agent-team-isolation-contract.test.js`. Validation: `tsc --noEmit` clean of new errors, all 146 CI-wired contract gates run — 22 were already red at `4f165c9e^`, 3 more are red only from other agents' uncommitted `standingOrders`/`teamWiring` work, 1 needs a fresh `out/`; nothing red is attributable to this change.

**Verdict is provisional on the core mechanism.** The delivered coverage for the creation policy is source-text only: no automated check discriminates "exactly one startup command reaches the terminal" or "the prompt waits for the settle", and neither manual verification was executed in this pass. Passing the unrelated suites is not evidence those work.

## Deferred Findings

- MAJOR — `src/services/PlanningPanelProvider.ts:1393` — on standalone with node-pty unavailable, `hasPtyHost()` is false, so `_sendPromptToTerminal` falls to `this._seams().terminal.create(...)`, which returns the inert headless handle and the method reports `true`. A silent false positive: the builder arms say "sent" and nothing was delivered. Pre-existing (identical at `4f165c9e^`), but the creation-policy plan explicitly required this branch stay unreachable in standalone. Closing it needs a headless marker on the terminal seam, which is net-new seam surface.
- NIT — `src/services/TaskViewerProvider.ts:21258` — the pre-spawn `ptyListTerminals` re-check is TOCTOU-windowed; two dispatches landing inside the window still spawn two terminals. Plan-specified shape, so left as-is.
- NIT — `src/services/TaskViewerProvider.ts:21290` — a failed create returns bare `false`, so the arm's clipboard fallback carries a generic reason instead of the fleet's error, and the plan's `created: true` signal was not adopted (the seam must return `Promise<boolean>`, which two contract gates pin).
- NIT — `src/services/TaskViewerProvider.ts:21332` — the seam omits the `_refreshTerminalStatuses()` call its own precedent at `:11475` makes after a fleet create.
- NIT — `src/test/pty-dispatch-focus-contract.test.js:200` — the assertion message still describes the standalone half of `_hasFleet()` as "the injected capability signal"; it is now the injected fleet verb.
