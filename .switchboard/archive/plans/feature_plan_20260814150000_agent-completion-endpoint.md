# Turn-End Notification — Tell the Interested Agent When a Seat Goes Quiet

## Goal

When a dispatched seat's turn ends, send a prompt to the agent that is waiting on it — its head, or the orchestrator. The signal already exists and already distinguishes *finished* from *blocked*; nothing listens to it.

This is the safeguard for an agent that never reports back on its own. Agent-to-agent reporting works today (`POST /terminals/verb/ptySendPrompt`, installed as a standing order by `AGENT_GROUP_CALLBACK_INSTRUCTION`, `teamWiring.ts:46`), and it is the primary path. But it depends on the child choosing to send the message. This card makes the extension say it when the child doesn't.

### Problem & background

**The turn-end signal is built, and it has no notification consumer.** `PlanIngestionEngine.ts:376-401` runs once per sweep over terminals that have gone silent while holding a live dispatched card:

* plan file mtime advanced since dispatch → `clearWorkingState(planFile, wsId)` — the seat finished and wrote its report;
* otherwise → `setBlockedState(planFile, wsId, livenessIso)` — the seat stopped and is waiting on a human.

Silence is the turn boundary; the mtime only disambiguates the two outcomes. The mechanism reads bytes the fleet already receives (`handle.onData` → `lastDataAt`, `ptyFleetService.ts:194`) and requires nothing from the agent, so it behaves identically for Claude Code, Codex, Gemini CLI, Aider, a wrapper script or a custom role.

**No agent is told.** The board updates — the activity light clears, the blocked ring appears — and that is the end of it. An orchestrator that dispatched three leads and is now idle learns nothing. Its only recourse today is the wake cadence, which polls on a timer precisely because nothing pushes.

**Agent-to-agent messaging is not the gap.** It shipped: `ptySendPrompt` is documented in two skills, and every team member already carries a standing order to report to its head on finishing. What is missing is the case where the child *doesn't* — it crashed, it ran out of context, it ignored the order, or it stopped to ask a question and is sitting at a prompt nobody will answer. In each of those the head waits forever, and the board silently stops.

**Explicitly not agent-reported completion.** An endpoint the agent must POST to was built (`POST /agent/event`, CLI hooks) and **removed on 2026-08-08** — see `feature_plan_20260807103100_agent-emitted-completion-via-cli-hooks.md`. It worked for one CLI and fell back to a blind timer for the rest, so the board meant different things per seat. That lesson binds this card: the notification is derived from the pty stream, never from the agent's cooperation. **No hooks, no `--settings` rewrite, no per-terminal token, no agent-side obligation.**

---

## Metadata

**Complexity:** 3
**Tags:** backend, reliability

---

## User Review Required

**None.** Four decisions made here:

* **The trigger is the existing turn-end classification**, not a new detector and not a timer.
* **Recipient resolution is by existing state:** the seat's `parentInstanceId` if it has one (its head), otherwise the live orchestrator terminal if one exists. No registry of interest, no new persistence.
* **Both outcomes notify.** "Finished" and "blocked" are equally actionable, and blocked is the one a human currently never hears about.
* **Notification is best-effort and silent on failure.** A missing recipient is not an error — it means nobody was waiting.

---

## Complexity Audit

* **Score:** 3 / 10

### Routine

* Subscribing to a code path that already runs on a schedule.
* Resolving a terminal's parent, or the orchestrator terminal, from live fleet state.
* Composing a prompt string and calling the existing send path.

### Complex / Risky

* **Firing exactly once per turn.** The sweep runs repeatedly; a seat stays silent across many ticks. Without a real transition gate the orchestrator gets the same message every tick.
* **Not fighting the standing order.** The child may also report on its own. Two messages for one turn is noise, and the orchestrator may act twice.

---

## Edge-Case & Dependency Audit

### Race Conditions

* **Repeat sweeps over one silent seat.** `clearWorkingState` already returns a true transition boolean — it was retained from the removed hooks work specifically as the double-broadcast gate (`KanbanDatabase`, and the existing caller gates on it at `PlanIngestionEngine.ts:389`). Gate the notification on the same boolean. For the blocked arm, the existing `!record.blockedAt` guard (`:399`) is the equivalent single-fire.
* **The child reports and the sweep also notifies.** Prefer the child's own message: it arrived first and carries more detail. If the seat's turn ended within the window in which a report was delivered to the recipient, skip. If that correlation is not cheaply available, accept the duplicate and make the notification text obviously machine-origin so the recipient can tell them apart.
* **A seat that is re-dispatched while the notification is composing.** Resolve the recipient and the card from the record read in the same sweep pass, not by re-querying afterwards.

### Security

* Not a privilege change. The send path is the same one agents already use, running in-process.
* **No secrets and no agent-side surface.** Nothing is written into the user's workspace, no token enters a pty environment, no argv carries a secret. That was the second reason the hooks design was removed and it is not reintroduced.

### Side Effects

* Idle agents receive prompts they did not previously receive, which starts a turn. That is the point, but it means an orchestrator with several leads may wake several times. Keep the message short and let the agent decide whether to act.
* A blocked seat now surfaces to an agent as well as to the board.

### Dependencies & Conflicts

* **`src/services/PlanIngestionEngine.ts:376-401`** — the silent-terminal classification; both arms get the notification call.
* **`src/services/KanbanDatabase.ts`** — `clearWorkingState` (transition boolean), `setBlockedState`, `getActiveDispatchedByTerminal`.
* **`src/standalone/ptyFleetService.ts`** — `parentInstanceId` for recipient resolution, `listActive()` to confirm the recipient is live.
* **`src/services/teamWiring.ts:46`** — `AGENT_GROUP_CALLBACK_INSTRUCTION`, the primary path this backstops. Not modified.
* **The existing prompt-delivery path** — `ptySendPrompt` with `clearBeforePrompt: false`. Never a raw write, and never `clearBeforePrompt: true`, which would wipe the recipient's conversation.
* **Sibling card — autoban.** It advances on the same `clearWorkingState` transition. Both consumers hang off one gate; confirm the gate fires once and both are driven from it.
* **Sibling card — retire the orchestrator's machinery.** This notification is what replaces the wake cadence. It must exist before the cadence is deleted.
* **Both hosts already run this engine.** `PlanIngestionEngine` is host-agnostic; the extension reaches it via `GlobalPlanWatcherService`, standalone via `planIngestionHost.ts` (`bootstrap.ts:290`), with the liveness feed wired at `bootstrap.ts:1749`. The notification goes in the shared engine behind an injected callback so it is not silently extension-only.

---

## Dependencies

* None. The signal, the transition gate and the send path all exist at HEAD.
* **Gates** the orchestrator-retirement card: the cadence cannot be deleted until something pushes.

---

## Adversarial Synthesis

Key risks: (1) **repeat notification** — the sweep revisits a silent seat every tick, so without gating on the existing transition boolean the orchestrator is woken continuously, which is worse than the cadence it replaces; (2) **double notification** when the child also honours its standing order, causing the recipient to act twice on one turn; (3) **recipient resolution failing silently**, so the safeguard appears wired but nothing is ever delivered — the hollow-success failure this feature exists to remove; (4) **host asymmetry** if the classification only runs in the extension host. Mitigations: gate both arms on the single-fire signals that already exist (`clearWorkingState`'s transition boolean, `!record.blockedAt`); prefer the child's own report and mark machine-origin messages distinctly; log an explicit "no recipient for seat X" rather than returning quietly; verify the standalone path and state the answer in the plan rather than assuming it.

---

## Proposed Changes

### 1. Notify on turn-end

**Implementation:** in `PlanIngestionEngine.ts:376-401`, after the existing state write in each arm, resolve the recipient and send:

* **completed arm** (`:389`, gated on the `transitioned` boolean already computed): *"Seat `<name>` finished its turn on `<planFile>`."*
* **blocked arm** (`:399`, gated on the existing `!record.blockedAt`): *"Seat `<name>` has gone quiet on `<planFile>` without writing a completion report — it may be waiting on input."*

**Recipient:** the seat's `parentInstanceId` → that terminal, if live. Otherwise the orchestrator terminal, if live. Otherwise nobody — log it and move on.

**Delivery:** the existing `ptySendPrompt` path with `clearBeforePrompt: false`.

**Edge cases:** never fire outside the existing gates. Never `clearBeforePrompt: true`. If the recipient is the seat itself (a malformed parent chain), skip.

### 2. Wire the notifier in both hosts

**Context — resolved, not open.** `PlanIngestionEngine` is host-agnostic and both hosts run it: the extension through `GlobalPlanWatcherService` (its own header: *"VS Code adapter over the host-agnostic"* engine), and standalone through `planIngestionHost.ts`, constructed at `bootstrap.ts:290`. The liveness feed the silent-seat classification depends on is wired in standalone too — `bootstrap.ts:1749`, `ingestionEngine.setTerminalLivenessProvider(() => ptyFleetService.getLiveness())`. Turn-end detection therefore already works under `npx switchboard`.

**Implementation:** add the notifier as a host-injected callback on the engine — `setTurnEndNotifier(...)` in the same idiom as `setTerminalLivenessProvider` — and wire it in both hosts: the extension host alongside its other engine seams, standalone at `bootstrap.ts:1749`.

**Logic:** the notify call belongs in the shared engine, not in `GlobalPlanWatcherService`. Putting it in the VS Code adapter would make the safeguard extension-only when the signal underneath it is already host-agnostic — a gratuitous parity hole, and PRD contract #7's "reachable-but-unwired" failure exactly.

**Edge cases:** a host that does not set a notifier gets the classification with no notification, silently and correctly — no null-callback crash. Verify the standalone wiring by running it, not by reading it.

---

## Verification Plan

Tests are skipped per session directive, and compilation is skipped per session directive.

### Automated Tests

* A seat that goes silent with an advanced plan file notifies its parent exactly once, across repeated sweeps.
* A seat that goes silent without an advanced plan file notifies once with the blocked wording, and does not re-notify while `blockedAt` is set.
* A seat with no parent and no live orchestrator produces a logged "no recipient", not a silent return.
* A seat whose parent has exited is skipped without throwing.
* The notification uses `clearBeforePrompt: false`.
* Grepping `src/` for hook artifacts — `SWITCHBOARD_HOOK_TOKEN`, `agent-hooks`, `/agent/event` — returns nothing, confirming the removed design was not reintroduced.

### Manual Verification

1. **Blocked seat:** dispatch a card, have the agent stop and ask a question. Confirm the orchestrator receives one message naming the seat.
2. **Finished seat:** dispatch, let the agent finish and write its report. Confirm one message, and that the child's own standing-order report is not duplicated into a second identical action.
3. **Silent for a long time:** confirm no repeat messages on subsequent sweeps.
4. **Non-Claude CLI:** repeat 1 with a different agent CLI and confirm identical behaviour — this is the property the removed hooks design failed.
5. **Standalone:** repeat 1 under `npx switchboard`. The engine and its liveness feed are already wired there, so the notification must fire identically.

---

## Recommendation

Complexity 3 → **Send to Intern.**

**The thing to get right:** fire once. The sweep revisits a silent seat on every tick, so both arms must hang off the single-fire gates that already exist — `clearWorkingState`'s transition boolean and the `!record.blockedAt` guard. A notification that repeats every tick is a worse wake cadence than the one this replaces.

**Second:** this is derived from the pty stream, never from the agent. No hooks, no tokens, no settings files, no agent-side obligation — that design was built, reviewed and removed, and the reason it was removed still holds.

**Migration:** none. No new state, no schema change, no new endpoint.

---

## Completion Report

Implemented both proposed changes. Added a `setTurnEndNotifier` seam to `PlanIngestionEngine` in the exact idiom of `setOnWorkingStateCleared` / `setTerminalLivenessProvider` (a host-injected callback + `TurnEndInfo` payload of seat name, plan file, outcome, workspace root), and fired it from the existing single-fire gates: the completed arm on the `transitioned` boolean (alongside `_onWorkingStateCleared`, on the same gate — not re-derived), the blocked arm on the existing `!record.blockedAt` guard. The engine stays host-agnostic and degrades silently when no notifier is set. Wired the notifier in both hosts: the extension host (`extension.ts`) delegates to a new `TaskViewerProvider.notifyTurnEnd` which resolves the recipient via `ptyListTerminals` (the only path carrying `agentInstanceId` / `parentInstanceId` across the pty-host child-process boundary — the cached `_ptyTerminalNames` array is names only), falling back to a live `orchestrator`-role terminal, logging an explicit "no recipient for seat X" otherwise; standalone (`bootstrap.ts`) resolves via `ptyFleetService.listActive()` directly. Both deliver through the existing prompt path with `clearBeforePrompt: false` and standing orders suppressed, skip when the recipient is the seat itself (malformed parent chain), and carry a `[switchboard:turn-end]` prefix so machine-origin messages are distinguishable from the child's own standing-order report. After review, fixed the hollow-success defect in the extension-side delivery: `ptySendPrompt` does not throw on failure — a dead/wrong recipient returns `{success:false, error:'...'}` as a resolved promise — so the response is now captured and an explicit delivery failure is logged naming the recipient and error when `sendRes?.success === false`, and an active-status pre-check (the `active` list from `ptyListTerminals` is already in scope) skips a recipient that is no longer live before the send, mirroring the standalone twin's `handle.status === 'active'` guard. Files changed: `src/services/PlanIngestionEngine.ts`, `src/services/TaskViewerProvider.ts`, `src/extension.ts`, `src/standalone/bootstrap.ts`. No hooks, tokens, `--settings` rewrites, `/agent/event` endpoints, or any agent-side obligation were reintroduced (verified by grep). Compilation and tests were skipped per session directive; manual verification under a live fleet (blocked seat, finished seat, repeat-sweep silence, non-Claude CLI, standalone) remains to be done.

---

## Review Findings (reviewer pass, 2026-08-15)

Card is sound: the notifier hangs off the two existing single-fire gates in the shared engine (`PlanIngestionEngine.ts:435`, `:455`), both hosts are wired, delivery uses `clearBeforePrompt:false` with an active-status pre-check and a captured `ptySendPrompt` response, and no hook/token/`/agent/event` artefact was reintroduced (grep clean). One CRITICAL was found in the consumer this card feeds, not in the card itself: `TurnEndInfo.planFile` is the DB's **relative** `plan_file`, while autoban's tracking map was keyed on the **absolute** path `_collectKanbanCardsInColumns` resolves — fixed by a shared `_autobanPlanFileKey` normaliser (see the autoban plan's findings). Files changed by this pass: none in this card's own scope. Validation: `tsc --noEmit` clean apart from 5 pre-existing TS2835 dynamic-import errors; `catalog:check`, `mirror:check`, `verb-returns:check`, `lint` and 91 CI-wired suites run, with only 7 failures all confirmed red at HEAD in a baseline worktree. Remaining risk: the manual verifications (blocked seat, finished seat, repeat-sweep silence, non-Claude CLI, standalone under `npx switchboard`) still need a live fleet — nothing automated covers recipient resolution.

---

## Review Findings (reviewer pass 2, 2026-08-16)

Card re-verified independently and remains sound: the notifier still hangs off the two existing single-fire gates in the shared engine (`PlanIngestionEngine.ts:429`, `:456`), both hosts wire it inside one closure (a second `setTurnEndNotifier` call would silently replace the first), delivery uses `clearBeforePrompt:false` with `standingOrders:false`, an active-status pre-check and a captured `ptySendPrompt` response, and the hook-artifact greps are clean — `SWITCHBOARD_HOOK_TOKEN` and `agent-hooks` are at zero, and the three `/agent/event` hits are comments in `KanbanDatabase.ts` recording the 2026-08-08 removal, not a reintroduction. One NIT fixed in `TaskViewerProvider.notifyTurnEnd`: the `!this._ptyHostPort` early return was the only no-delivery path that returned silently, so a fleet-less host made the safeguard look wired while nothing ever fired — it now logs like every sibling path. **Gate-wiring audit — MAJOR, unresolved:** every item in this card's `### Automated Tests` subsection (notify-once across sweeps, blocked-arm single fire, "no recipient" logged, exited-parent skip, `clearBeforePrompt:false`) is named but has **no test file, no npm script and no CI step** — recipient resolution is covered by static reading only, so the discriminating behaviour of this card is unguarded in CI. Verification was run, not skipped: `tsc --noEmit` clean apart from the 5 pre-existing TS2835 dynamic-import errors, `catalog:check`/`mirror:check`/`verb-returns:check`/`lint` green, and all 92 CI-wired suites executed with 7 failures, every one of them reproduced red at HEAD in a detached baseline worktree.
