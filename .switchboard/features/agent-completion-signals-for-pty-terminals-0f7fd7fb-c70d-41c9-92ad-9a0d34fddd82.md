# Agent Completion Signals for PTY Terminals

**Complexity:** 7

## Goal

Completion for a dispatched card is measured by one inferred signal — the plan file mtime advancing — backed by a blind 10-minute timeout sweep that is wrong in both directions: a dead agent keeps its light for the full window, while an agent grinding on a single plan for 25 minutes goes dark at minute 10 and reads as abandoned. PTY-fleet terminals already carry evidence the system discards, and Switchboard spawns the agent process itself, so it can arrange for the agent to report its own turn boundaries rather than inferring them from a filesystem side effect.

This feature adds three graded signals layered on top of mtime, which remains the source of truth: an output liveness heartbeat that gates the timeout sweep, agent-emitted turn-end events via the CLI hook mechanism, and screen-state idle detection as a default-off fallback for agents with no hook support.

The prize beyond faster completion is a blocked state the board cannot represent at all today. A working agent and one waiting on a human answer render identically, and mtime cannot separate them in principle since both leave the plan file untouched.

## How the Subtasks Achieve This

- **PTY Output Liveness Must Gate the Activity-Light Timeout Sweep**: Stamps a `lastDataAt` heartbeat on the fleet handle from the `onData` stream the gateway already receives, exposes it on both `ptyListTerminals` arms, and injects a liveness getter into `PlanIngestionEngine` so the stale sweep can spare a card whose terminal is demonstrably still producing output — and clear one whose terminal has exited, without waiting out the window. Buys only the claim raw bytes can support: liveness, never completion. This is the sole subtask that fixes an active user-visible defect rather than adding capability, and it establishes the fleet-side subscription, the exited-terminal tombstone, and the engine seam the other two reuse. It also owns **V58** (`last_liveness_at`) and the widening of all three derived-state consumers — the surface both siblings extend rather than fork.

- **Agent-Emitted Completion via CLI Hooks**: Uses the fact that Switchboard spawns the process — a Switchboard-owned hook settings file passed via `--settings`, a per-terminal identity token, and a `POST /agent/event` endpoint — so the CLI reports its own turn boundaries instead of the system inferring them. Research confirmed the CLI distinguishes the two states itself: turn-completion and waiting-for-the-user fire **different** events, so "finished" vs "stopped to ask" is a deterministic signal rather than an inference, with plan-file evidence retained only as a secondary guard. Adds the `blocked_at` column (**V59**) that lets the board render the difference. This is the correct mechanism and the only one that delivers the blocked state.

- **Screen-State Idle Detection via Headless VT**: The conditional fallback for agent CLIs that expose no hook mechanism, and the one subtask that **should not be built yet**. Runs a headless VT emulator over the coalesced flush path and derives idle from masked screen-hash stability rather than byte silence. Its original premise — that a repainting TUI never goes quiet, so byte silence cannot work — was **refuted** by research: Claude Code removed idle re-rendering in v2.1.170+, so bytes do stop at an idle prompt, and byte silence is unpredictable per-CLI rather than universally useless. It is now gated on measuring whether the hookless CLIs actually in use repaint at idle; if they do not, a byte-silence timer over the subscription subtask 1 establishes solves the problem in a few dozen lines and this subtask closes unbuilt. Default off, adds no migration.

## Reconciled Shared-Surface Contract

The three subtasks touch the same files. This is the single reconciled end-state — implement to it rather than to each plan in isolation. Established by a cross-subtask audit against the code on 2026-08-07; each item is recorded in the owning plan with a superseded callout where it corrected an earlier design.

**The finding that reshaped the feature.** The 10-minute activity-light window is enforced in **three independent implementations**, not one:

1. `KanbanDatabase.clearStaleWorkingState` (`:9603`) — SQL cutoff, nulls `dispatched_at`.
2. `isWorkingState` — read-time age check, **two copies**: `KanbanProvider.ts:142` and `bootstrap.ts:148`, consumed at four card-build sites (`KanbanProvider.ts:1845`, `:3474`, `:3679`, `bootstrap.ts:196`) plus a fifth builder that hardcodes `working: false` (`KanbanProvider.ts:7369`).
3. `KanbanDatabase.getFeatureWorkingStates` (`:6180`) — its own SQL cutoff for the feature rollup.

Gating only the sweep spares the DB row while the card still renders dark at minute 10:01, because consumer #2 recomputes the age at render time. Subtask 1 was rewritten to move all three onto one widened age basis, `MAX(dispatched_at, last_liveness_at)`, persisted in the row rather than injected into three read paths. Everything below follows from that.

| Shared surface | Owner | How the others relate |
|---|---|---|
| Migration numbers | 1 takes **V58** (`last_liveness_at`); 2 takes **V59** (`blocked_at`); 3 adds none | Two plans stamped V58 would not conflict visibly — the `getMigrationVersion()` gate silently skips the second and its column is never added |
| `isWorkingState` ×2 + `getFeatureWorkingStates` | 1 widens the age basis | 2 extends the *same* functions to return the working/blocked pair; never a parallel `isBlockedState` |
| `clearStaleWorkingState` / `clearWorkingState` | 1 widens the cutoff + hard cap | 2 adds `blocked_at` to what they null |
| Four card-build sites | 1 passes the widened basis | 2 adds `blocked` at the same four; `:7369`'s disposition is decided by 1 |
| `ptyFleetService.create` | 1 adds `lastDataAt` + `onData` tap + `recentlyClosed` | 2 adds env merge + hook file; 3 adds the render tap. **Serialise — one stream per file** (PRD orchestration discipline) |
| `recentlyClosed` tombstone | 1 | 2 needs it for blocked expiry; 3 needs it to veto frozen frames — `kill()` deletes the handle before killing, so `status:'exited'` is unreadable for operator kills |
| The `clearWorkingState` decision path | 2 establishes it | 3 extends it in-process; one path, one broadcast |
| Coalesced flush tap | 3 — via a new `onFlush` observer **on the gateway**, not the fleet | The accumulator is private to `TerminalWsGateway`; a fleet-owned tap would build a second buffer on the hot read path |

**Non-negotiables carried into all three:** `dispatched_at` is never rewritten (it anchors both the hard cap and subtask 2's turn-start comparison); the hard cap is `3 × timeoutMs` from `dispatched_at`; every new capability ships default-OFF or degrades to today's behaviour when the fleet is absent; config reads go through the host seam, never a fresh `vscode.workspace.getConfiguration`.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [PTY Output Liveness Must Gate the Activity-Light Timeout Sweep](../plans/feature_plan_20260807103000_pty-liveness-heartbeat-gates-activity-light-sweep.md) — **PLAN REVIEWED**
- [ ] [Agent-Emitted Completion: Let the CLI Report Turn-End Instead of Inferring It, and Surface the Blocked State the Board Cannot Currently Represent](../plans/feature_plan_20260807103100_agent-emitted-completion-via-cli-hooks.md) — **PLAN REVIEWED**
- [ ] [Screen-State Idle Detection: Render the PTY Stream Server-Side So Output Can Signal Turn-End for Agents With No Hook Mechanism](../plans/feature_plan_20260807103200_pty-screen-state-idle-detection-headless-vt.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Ordered, not parallel.

1. **Liveness heartbeat first.** It is the only subtask fixing a live defect, and it creates four things the others build on: the fleet-handle `onData` subscription, the `recentlyClosed` tombstone, the injected-getter seam on `PlanIngestionEngine`, and the widened derived-state layer (V58 `last_liveness_at` feeding `isWorkingState` ×2, `getFeatureWorkingStates`, and the sweep). It ships alone with no prerequisites.

   It is **not** the smallest of the three, contrary to the original sequencing note. The cross-subtask audit found the timeout enforced in three independent implementations rather than one (see the Reconciled Shared-Surface Contract above), which pulled a migration, two duplicated read-path derives across both hosts, and four card builders into its scope and moved it from complexity 5 to 7. It remains first because everything else depends on that end-state, not because it is cheap.

2. **CLI hooks second.** Depends on the liveness subtask for three things: **V58 being taken** (so this is V59), the exited-terminal force-clear plus `recentlyClosed` tombstone for `blocked_at` expiry — a blocked card whose agent later dies, or whose terminal the operator closed, would otherwise stick indefinitely — and the widened derive that `blocked` extends rather than forks. If the work needs splitting further, the endpoint plus the V59 schema and board state can land ahead of the hook-file generation; the endpoint is independently testable with `curl`. Do not split the other way — hook generation with no endpoint delivers nothing testable.

3. **Screen-state idle last, conditionally, and now gated on a measurement rather than on the other two.** Hard-depends on subtask 1 (frozen frames from exited terminals must not read as idle, and operator-killed terminals leave no `status` to veto them without the tombstone). Two independent reasons it may never be built, either of which is a successful outcome rather than sunk cost:

   - **Hook coverage.** If subtask 2's hooks cover the agents actually in use, there is nothing left for this to serve.
   - **Byte silence may simply work — this is new.** Research refuted the premise that a repainting TUI never goes quiet; Claude Code removed idle re-rendering in v2.1.170+. Whether a *hookless* CLI repaints at idle is unmeasured, per-CLI, and cheap to test. If those CLIs go quiet, a byte-silence timer over subtask 1's existing `onData` subscription replaces this entire subtask at a fraction of the cost and with none of the version coupling. **Run that measurement before writing any emulator code** (subtask 3, Verification step 1).

   It must also never run for a terminal already emitting hook events, or two signals race to clear the same card and produce a double completion broadcast.

Convergence constraint spanning 2 and 3: both signals must terminate in the **same** decision path and the same `clearWorkingState` call, not two parallel ones. Whichever lands second extends the first's path rather than adding its own.

**Research outcome (2026-08-07).** A web-research pass settled the third-party contracts all three subtasks depended on. Net effect on the feature: subtask 2 got **simpler and more reliable** (the CLI emits distinct events for turn-end vs waiting-for-user, so the blocked state is deterministic, not inferred) and picked up two new hard requirements (the hook command must force `exit 0` or a failed POST can *interrupt the agent* via exit-code-2 block semantics; `--settings` outranks the user's own hook config and may replace their hooks map). Subtask 3's justification **weakened** — its central premise was refuted — and it moved from "build last" to "measure first, expect to close". Subtask 1 was unaffected: every claim it makes is about this repository and was verified in code. Per-subtask detail lives in each plan's `## Resolved Assumptions` section, which is authoritative — do not re-research those questions.
