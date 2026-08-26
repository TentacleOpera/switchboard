# Agent Completion Signals for PTY Terminals

**Complexity:** 7

## Goal

Completion for a dispatched card is measured by one inferred signal — the plan file mtime advancing — backed by a blind 10-minute timeout sweep that is wrong in both directions: a dead agent keeps its light for the full window, while an agent grinding on a single plan for 25 minutes goes dark at minute 10 and reads as abandoned. PTY-fleet terminals already carry evidence the system discards: Switchboard reads every byte the agent prints, and throws away what that stream says about turn boundaries.

This feature adds graded signals layered on top of mtime, which remains the source of truth: an output liveness heartbeat that gates the timeout sweep, turn-end derived from sustained output silence on the same stream, and — conditionally — screen-state idle detection for CLIs that repaint while idle and therefore never go quiet.

**Design correction (2026-08-08).** Subtask 2 was originally built on Claude Code's lifecycle hooks. That implementation was removed: hooks are a Claude-Code-only mechanism, so the board lit correctly for one CLI and silently fell back to the 10-minute timer for every other agent. A completion signal whose behaviour depends on which agent was dispatched is worse than a uniform approximation. Subtask 2 is now output silence, which requires nothing from the agent and behaves identically for every CLI. Details in that plan's `## Prior Implementation (Removed)`.

The prize beyond faster completion is a blocked state the board cannot represent at all today. A working agent and one waiting on a human answer render identically, and mtime cannot separate them in principle since both leave the plan file untouched.

## How the Subtasks Achieve This

- **PTY Output Liveness Must Gate the Activity-Light Timeout Sweep**: Stamps a `lastDataAt` heartbeat on the fleet handle from the `onData` stream the gateway already receives, exposes it on both `ptyListTerminals` arms, and injects a liveness getter into `PlanIngestionEngine` so the stale sweep can spare a card whose terminal is demonstrably still producing output — and clear one whose terminal has exited, without waiting out the window. Buys only the claim raw bytes can support: liveness, never completion. This is the sole subtask that fixes an active user-visible defect rather than adding capability, and it establishes the fleet-side subscription, the exited-terminal tombstone, and the engine seam the other two reuse. It also owns **V58** (`last_liveness_at`) and the widening of all three derived-state consumers — the surface both siblings extend rather than fork.

- **Turn-End From PTY Output Silence**: Fills in the one branch subtask 1 left empty — a dispatched seat that is `active` but has produced no output for longer than a threshold is a turn boundary. Plan-file mtime is the discriminator: silence **with** an mtime advance is completion, silence **without** one is ambiguous and reads as **blocked**, giving V59's `blocked_at` column its first writer. Requires nothing from the agent — no hook, no config injection, no endpoint, no token — so it behaves identically for every CLI, which is the whole point. The honest cost versus the removed hook design is that silence cannot deterministically separate "finished" from "stopped to ask"; the plan-file discriminator carries that, conservatively (ambiguous ⇒ blocked, not cleared) and self-correctingly (`blocked_at` is nulled the moment bytes resume). Owns **V59**.

- **Screen-State Idle Detection via Headless VT**: The conditional escalation for CLIs that repaint while idle and therefore never produce the silence subtask 2 keys on. **Closed unbuilt, and should stay that way unless measurement demands it.** Runs a headless VT emulator over the coalesced flush path and derives idle from masked screen-hash stability. Its original premise — that a repainting TUI never goes quiet, so byte silence cannot work — was **refuted** by research: Claude Code removed idle re-rendering in v2.1.170+, so bytes do stop at an idle prompt, and byte silence is unpredictable per-CLI rather than universally useless. Its own recommendation names subtask 2's silence timer as the correct deliverable instead. Now gated on subtask 2's Verification step 2 (the per-CLI quiet-stretch measurement): if the CLIs in use go reliably quiet, close this permanently. Default off, adds no migration.

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
| `ptyFleetService.create` | 1 adds `lastDataAt` + `onData` tap + `recentlyClosed` | 2 no longer touches this file at all (the hook-file/env work was removed); 3 adds the render tap |
| `recentlyClosed` tombstone | 1 | 2 needs it to veto a silent-because-dead seat (operator kill leaves no `status:'exited'` to read, since `kill()` deletes the handle before killing); 3 needs it to veto frozen frames |
| The `clearWorkingState` decision path | 2 establishes it | 3 extends it in-process; one path, one broadcast. The transition boolean (`getRowsModified`) is the double-broadcast gate — load-bearing for any second clearer |
| Coalesced flush tap | 3 — via a new `onFlush` observer **on the gateway**, not the fleet | The accumulator is private to `TerminalWsGateway`; a fleet-owned tap would build a second buffer on the hot read path |

**Non-negotiables carried into all three:** `dispatched_at` is never rewritten (it anchors both the hard cap and subtask 2's mtime comparison for turn-start); the hard cap is `3 × timeoutMs` from `dispatched_at`; every new capability ships default-OFF or degrades to today's behaviour when the fleet is absent; config reads go through the host seam, never a fresh `vscode.workspace.getConfiguration`. Subtask 2 adds one more: completion evidence is the plan file's **mtime**, never `updated_at` — `updated_at` only advances when the watcher re-ingests, which happens after the signal fires, so keying on it can never detect a real completion.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [PTY Output Liveness Must Gate the Activity-Light Timeout Sweep](../plans/feature_plan_20260807103000_pty-liveness-heartbeat-gates-activity-light-sweep.md) — **CODE REVIEWED** — ID: 50638768-d7e6-4b88-968b-215a1ecaf00d
- [ ] [Agent-Emitted Completion via CLI Hooks — BUILT, THEN REMOVED (superseded by output-silence detection)](../plans/feature_plan_20260807103100_agent-emitted-completion-via-cli-hooks.md) — **CODE REVIEWED** — ID: 65ef46d3-c16a-4db1-ac69-ad9c384b735c
- [ ] [Screen-State Idle Detection: Render the PTY Stream Server-Side So Output Can Signal Turn-End for Agents With No Hook Mechanism](../plans/feature_plan_20260807103200_pty-screen-state-idle-detection-headless-vt.md) — **CODE REVIEWED** — ID: 75b6017a-01a0-47d5-b839-52e228e109a9
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

## Review Findings

Reviewer pass over all three subtasks: subtasks 1 and 2 are implemented and now correct after fixes; subtask 3 is legitimately closed unbuilt per its own Recommendation, with no orphaned scaffolding. Four CRITICALs were found and fixed — the generated hook command never expanded `$SWITCHBOARD_TERMINAL` (single-quoted `-d` body) so every `/agent/event` POST 401'd and subtask 2 was entirely inert; `kanban.html` referenced an undeclared `copyDispatchPromptBtn` from a stray out-of-scope edit and threw during every column-header build, breaking board render; `getActiveDispatchedByCwd` selected the unqualified `PLAN_COLUMNS` across a `worktrees` join whose shared `status`/`created_at`/`project`/`feature_id` columns made it fail at prepare time; and PTY tombstones were surfaced inside the `ptyListTerminals` `terminals` array, which `terminals.js` renders unfiltered, turning every operator-closed terminal into a permanent ghost row that kept its pane slot. Four MAJORs were also fixed: `setBlockedState` bumped the same `updated_at` that `turn_end` uses as its completion discriminator (self-poisoning false completion), `turn_end` could never detect a real completion because `updated_at` lags the plan watcher that fires after the hook (now keyed on plan-file mtime, a read-only stat), the completion broadcast could double-fire now that a second concurrent clearer exists (`clearWorkingState` returns a true non-NULL→NULL transition and both seams gate on it), and the `--settings` path was appended unquoted so any workspace path containing a space corrupted the startup command. The reconciled shared-surface contract held up: V58/V59 are correctly split, a fresh DB reaches version 59, all five derived-state consumers moved onto the one widened `MAX(dispatched_at, last_liveness_at)` basis with the 3× hard cap, and both hosts' `ptyListTerminals` arms stayed in parity. Verification: typecheck clean, eslint 0 errors, all six static ratchets green (catalog/allowlist, parity, verb-returns, push-routing, mirror, icons), the changed SQL validated directly against sqlite3, the regenerated hook command's variable expansion verified in a real shell, and 72 contract/regression suites run — 64 pass and the 8 failures were each confirmed red at HEAD in a clean `git archive` copy before any of this feature's code.
