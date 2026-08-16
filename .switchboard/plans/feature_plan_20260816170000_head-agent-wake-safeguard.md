# A Head Agent That Cannot Be Left Asleep

## Goal

Make it impossible for an agent driving a feature through coder terminals to wait forever on a report that never comes. Two guarantees: every dispatch a head agent makes itself is covered by the **existing** turn-end backstop, and a feature with un-accepted subtasks keeps nudging its head until the feature is done.

### Problem & background

**The failure, observed live on 2026-08-16.** A head agent (`lead-1`) drove the three subtasks of the *Automation Is a Scheduler* feature through `lead-1-coder-1/2/3` using `POST /terminals/verb/ptySendPrompt`, per `.agents/skills/terminal-coder-dispatch/SKILL.md`. `lead-1-coder-3` completed its subtask, wrote its completion report to the plan file, and **sent nothing back**. The head sat idle for eleven minutes and would have sat idle indefinitely; the silence was discovered only because the user asked whether the coder had reported. Nothing in the system was going to wake that agent.

**The root cause is NOT "there is no timer".** There is one, it is correct, and it is routed correctly. It is structurally blind to this dispatch. The chain, verified in the working tree:

1. `PlanIngestionEngine`'s sweep partitions the fleet each tick and puts any active-but-quiet seat into `silentTerminals` — quiet meaning `nowMs - lastDataAt >= turnEndSilenceMs` (default 90 000 ms, `PlanIngestionEngine.ts:310`, `:347`). `lead-1-coder-3` was silent for ~659 s. **It was in that array.**
2. For each silent terminal the sweep calls `db.getActiveDispatchedByTerminal(wsId, terminalName)` (`:386`). That query (`KanbanDatabase.ts:9821`) selects a `plans` row with `status = 'active' AND is_feature = 0 AND dispatched_terminal = ? AND dispatched_at IS NOT NULL`.
3. **No such row existed**, because `dispatched_terminal` / `dispatched_at` are stamped only by the board's own dispatch setters (`KanbanDatabase.ts:9696` `updateDispatchInfoByPlanFile`, `:9734` `attributePasteDispatch`). A head agent calling `ptySendPrompt` writes no record. The sweep hit `if (!record || !record.planFile || !record.dispatchedAt) continue;` and moved on.
4. So neither outcome could ever be reached: not `completed` (plan-file mtime advanced past `dispatchedAt`, `:415` — which *did* happen, the coder wrote its report) and not `blocked` (silence without a report).
5. `notifyTurnEnd` (`TaskViewerProvider.ts:1228`, mirrored as an inline closure in `standalone/bootstrap.ts:1867`) would have delivered correctly had it been called. It resolves the seat's `parentInstanceId` to the parent terminal's `friendlyName` and delivers via `ptySendPrompt` with `clearBeforePrompt: false` and `standingOrders: false`. `lead-1-coder-3.parentInstanceId` **is** `lead-1.agentInstanceId`. The address was right. The call never came.

**The standing order is not a backstop and was never going to be one.** The pair had a correctly-oriented standing order (`parent: lead-1-coder-3`, `child: lead-1`) naming the exact route. The coder ignored it. A contract the reporting agent must choose to honour cannot be the floor under the pattern — the whole point of a backstop is that it is derived from observable state and requires no cooperation from the party that failed.

**A second, wider hole.** Even with per-dispatch coverage, a head is unprotected in the window where no dispatch is outstanding: it dropped the thread, its own turn ended without it sending the next subtask, or a registration failed. The feature then stalls with every card parked and nobody driving. Per-dispatch turn-end says nothing about this, because there is no dispatch to observe.

### The blind spot has TWO halves — the missing record is only the first (added 2026-08-16, improve pass)

The analysis above is correct and complete about **why nothing fired on 2026-08-16**. It is incomplete as a fix specification, because a second, independent gate sits downstream of the missing record and swallows the *completed* outcome even once the record exists.

**`PlanIngestionEngine.ts:1070–1095` — the plan-file edit path clears the dispatch before the sweep can read it.** On every plan-file change the watcher imports, and if the imported row carries `dispatchedAt` it immediately calls `clearWorkingState` (`:1078`), NULLing `dispatched_at`. That transition fires `_onWorkingStateCleared` (the completion broadcast) and **nothing else — `_turnEndNotifier` is not called on this path.** The notifier is invoked in exactly two places, both inside the silence sweep (`:441` completed, `:455` blocked).

The consequence is deterministic, not a race:

* A coder writes its completion report → the file watcher fires within milliseconds → `dispatched_at` is NULL.
* The coder is *producing output* at that moment, so its `lastDataAt` is fresh and it is not even a member of `silentTerminals` on that tick.
* Ninety seconds later, when it finally is silent, `getActiveDispatchedByTerminal` returns `null` — the row it needs was cleared by the watcher, not by the sweep.
* The `completed` arm at `:423` is therefore unreachable **for any plan file the watcher watches**. It is reachable only when the write lands somewhere the watcher does not import — which is precisely the worktree case the `planRoots` resolution at `:392–:410` exists to cover.

So: **worktree-based fleets are covered today; a coder editing the main checkout is not, and would still not be after a registration record is added.** Registration is necessary and insufficient. The completed-outcome notifier must also be fired from the file-edit clear at `:1085`, gated on the same `transitioned` boolean that already gates the broadcast, with `seatName` taken from the cleared record's `dispatchedTerminal` (`KanbanPlanRecord.dispatchedTerminal`, `KanbanDatabase.ts:47`, populated by the row mapper at `:9900` / `:10140`). That field is empty for every dispatch nobody registered — which is exactly why the two changes compose: registration supplies the seat name the file-edit path needs to address the wake.

**The registration mechanism already exists and is fully shipped.** `attributePastedPrompt` — the verb the webview fires after a user pastes or drops a prompt into a terminal — takes `{ terminalName, role, planIds[], planFiles[], workspaceRoot? }`, resolves each plan, and calls `attributePasteDispatch` to stamp `dispatched_terminal` + `dispatched_at` (`KanbanProvider.ts:10208–10281`). It is in `KANBAN_VERBS` (`src/generated/verbAllowlist.ts:7`), in `protocol-catalog.json`, has a permissive schema (`verbSchemas.ts:306`), is contract-tested (`src/test/paste-attribution-contract.test.js:83`), and is served on **both** hosts — standalone reaches it through `bootstrap.ts`'s `kanbanVerb` `default:` arm, which delegates to `kanbanProvider.handleServiceVerb` (`bootstrap.ts:1117`). Its semantics are already exactly this case: *attribute a prompt that was delivered outside the board's dispatch path to the terminal that received it.* A head agent's `ptySendPrompt` is that, precisely.

---

## Metadata

**Complexity:** 6
**Tags:** reliability, backend, infrastructure

---

## User Review Required

**None.** Seven decisions made here:

* **Extend the existing sweep's coverage; do not build a second timer.** The detection, the two outcomes, the parent resolution and the delivery path all already exist and are correct. The defects are the gate at step 2 and the un-notified clear at `:1085`. A parallel wake mechanism would duplicate all of it and drift.
* **An agent-registered dispatch is a first-class dispatch record** — same `plans` row, same `dispatched_terminal` / `dispatched_at` columns, same downstream. Nothing new to reconcile, and the card's activity light behaves as it does for a board dispatch, which is also correct: the card *is* being worked.
* **Registration reuses the shipped `attributePastedPrompt` verb. No new registration verb is written.** See the superseded callout in Proposed Changes §1.
* **Per-dispatch coverage ships ON.** This is closing a blind spot in a shipped mechanism, not a new capability — PRD contract #2 governs new capabilities. A head that registers a dispatch gets exactly the backstop the board's dispatch path already gets.
* **The feature-level nudge ships OFF and is armed by the driving agent for its own session.** It sends prompts to a terminal unattended, which is a real behaviour change; it must not switch itself on for ~4 000 installs. The agent that starts driving arms it, which also makes it self-limiting and self-scoped.
* **The nudge is bound to the FEATURE, not to a dispatch.** It is cancelled when every subtask is accepted, or when the head terminal exits. That is precisely the "persists until the feature is completely done" requirement.
* **Nothing is inferred from a report.** Both mechanisms read observable state — pty `lastDataAt`, plan-file mtime, plan `status`. An agent's claim that it finished is never an input.

---

## Complexity Audit

* **Score:** 6 / 10

### Routine

* Reusing two existing `KanbanDatabase` setters rather than writing SQL.
* Two new verbs (`watchFeature` / `unwatchFeature`) + schemas + allowlist entries + catalog regeneration — for the **nudge only**. Registration needs none of this; the verb it uses is shipped.
* Watch state read/written with the existing `getConfigJson` / `setConfigJson` helpers (`KanbanDatabase.ts:5296`, `:5302`).

### Complex / Risky

* **The file-edit clear at `PlanIngestionEngine.ts:1078` beats the sweep every time.** Firing `_turnEndNotifier` there is the load-bearing half of this change; ship registration without it and the observed failure reproduces unchanged for any coder working the main checkout. It must hang off the same `transitioned` boolean as the broadcast — re-deriving the condition re-opens the double-fire the comment at `:1072` exists to close.
* **`getActiveDispatchedByTerminal` returns ONE row — `ORDER BY dispatched_at DESC LIMIT 1`.** A head that registers a second plan against the same terminal before the first resolves hides the first from the sweep. The terminal-coder-dispatch pattern is one subtask at a time per terminal, so this is consistent with the pattern — but it must be stated in the skill. It must **not** be enforced by rejecting at the verb (see §1: that verb is shipped and shared with the paste/drop path).
* **The nudge can interrupt the head mid-turn.** Delivering a prompt to a terminal whose agent is actively working injects text into a running turn. The nudge MUST gate on the head's own `lastDataAt` being older than the same silence threshold the coder path uses. Skipping this makes the safeguard the thing that breaks the driving agent.
* **Double-wake.** A seat that goes quiet produces a turn-end notice; if the feature nudge fires on the same tick the head receives two prompts about the same stall. The nudge must be suppressed while any turn-end notice for one of the feature's seats is outstanding.
* **Waking a dead head.** If the head terminal has exited, the nudge has no recipient. It must drop the watch and log, not retry forever — the same honesty the existing `notifyTurnEnd` shows when `_ptyHostPort` is absent (`TaskViewerProvider.ts:1234`).
* **Two hosts, but only for the notifier signature.** The turn-end notifier is implemented twice — `TaskViewerProvider.notifyTurnEnd` (`:1228`) and an inline closure in `standalone/bootstrap.ts` (`:1867`) — and its payload type is duplicated a third and fourth time in `handleAutobanTurnEnd` (`TaskViewerProvider.ts:1343`, called from `extension.ts:1114` and `bootstrap.ts:1914`). Widening `outcome` to include `'stalled'` touches all four signatures. Per PRD contract #7 both hosts must be done or the capability is `npx`-invisible. The two new **verbs**, by contrast, need no bootstrap edit — a new `KanbanProvider` arm is served in standalone automatically via the `default:` delegation, provided the arm touches only `db` + config and no `vscode.*` (contract #3).

---

## Edge-Case & Dependency Audit

### Race Conditions

* **Register-then-complete inside one tick.** A coder that finishes before the first sweep tick leaves a record whose plan mtime already advanced. With the file-edit notifier in place this is no longer the sweep's problem at all — the watcher fires the `completed` notice on the import. Do not add a minimum-age guard on either path.
* **Register AFTER the coder already wrote.** `dispatched_at` is stamped at registration time; the completion test is `mtime > dispatchedAt`. Registering after the write inverts the compare and the completion is invisible — the head then gets a late `blocked` instead. **Register before `ptySendPrompt`**, not after. This is a skill instruction, not a code guard.
* **Registration racing the plan watcher's own import.** The watcher rewrites `plans` rows on file change. `dispatched_at` is preserved across that upsert (parameter 21 is passed but the `ON CONFLICT` clause omits the column — `KanbanDatabase.ts:2270`), so an import between registration and completion does not lose the record.
* **Nudge vs. an in-flight registration.** The head registers, then dispatches. If the nudge tick lands between the two it sees no outstanding record and wakes a head that is mid-dispatch. The head-silence gate covers this — a head that just wrote a registration is not silent.
* **`blocked` is not terminal.** `blocked_at` rows are retained for `blockedTimeoutMs` (4 h) rather than cleared (`clearStaleWorkingState`, `KanbanDatabase.ts:9953–9960`), so a seat that goes quiet and *later* writes its report produces `blocked` first and `completed` after. The head must treat a `blocked` notice as "go look", never as "this subtask is dead". State this in the skill.

### Security

* Not a privilege change. Registration writes to the same rows the board writes, through a verb the webview already calls, on a localhost API surface the head agent already holds a port and token for.
* A registration naming a terminal that does not exist does **not** park a permanent phantom: `clearStaleWorkingState` NULLs any `dispatched_at` whose row was never liveness-stamped after `activityLight.timeoutMs` (default 10 min, `PlanIngestionEngine.ts:296`). A typo self-heals in one activity-light window.

### Side Effects

* Cards dispatched by a head agent now light their activity indicator and clear it on completion, the same as board-dispatched cards. This is a visible change and the correct one — today those cards look idle while an agent works them.
* Firing `_turnEndNotifier` from the file-edit clear path changes behaviour for **board-dispatched** cards too: today a board dispatch whose coder edits the plan file in the main checkout produces a completion broadcast but no turn-end notice; after this change it produces both. That is the intended semantics (a seat finished its turn) and the recipient resolution already handles "no parent, no orchestrator → log and drop", so a board dispatch with no head simply logs. It also feeds `handleAutobanTurnEnd`, which is guarded by its own dispatched-plan map (`TaskViewerProvider.ts:1350`) and ignores anything autoban did not dispatch. Both are checked in the verification plan rather than assumed.
* A head that registers and then crashes leaves a record that resolves as `blocked` after `blockedTimeoutMs` (4 h, `PlanIngestionEngine.ts:311`), or is reaped by the 10-minute activity-light sweep, whichever the liveness data supports. Existing behaviour for an abandoned board dispatch; no new path.

### Dependencies & Conflicts

* **`src/services/PlanIngestionEngine.ts`** — the sweep (`:300`–`:480`), `turnEndSilenceMs` (`:310`), `getActiveDispatchedByTerminal` call (`:386`), the mtime compare (`:415`), `_turnEndNotifier` (`:178`–`:181`), `TurnEndInfo` (`:83`–`:92`), **and the file-edit clear (`:1070`–`:1095`)**.
* **`src/services/KanbanDatabase.ts`** — `getActiveDispatchedByTerminal` (`:9821`), the two dispatch setters (`:9696`, `:9734`), `getSubtasksByFeatureId` (`:6257`), `getConfigJson` / `setConfigJson` (`:5296`, `:5302`). Do **not** add a third setter.
* **`src/services/KanbanProvider.ts`** — `attributePastedPrompt` (`:10208`) is reused **unchanged**; the two watch verbs are new arms in the same switch.
* **`src/services/TaskViewerProvider.ts`** — `notifyTurnEnd` (`:1228`) and `handleAutobanTurnEnd` (`:1343`).
* **`src/standalone/bootstrap.ts`** — the inline turn-end closure (`:1867`) and its `handleAutobanTurnEnd` call (`:1914`).
* **`src/services/verbSchemas.ts`**, **`src/generated/verbAllowlist.ts`**, **`protocol-catalog.json`** — the two watch verbs only.
* **`.agents/skills/terminal-coder-dispatch/SKILL.md`** — gains the registration step. The skill currently teaches `ptySendPrompt` with no registration (§1, `:32`–`:49`), which is exactly how the observed failure was produced; leaving the skill unchanged ships the fix with nothing telling an agent to use it.
* **The `config` table** is the home for the feature-watch state — not a new table, not `state.json`.

---

## Dependencies

* None. Every mechanism this plan extends is already in the tree.

---

## Adversarial Synthesis

Key risks: (1) **stopping at the missing dispatch record** — the file-edit clear at `PlanIngestionEngine.ts:1078` NULLs `dispatched_at` milliseconds after the coder writes its report, so a registration-only fix reproduces the observed failure verbatim for any coder in the main checkout while every test that asserts "the record now exists" passes; (2) **writing a new registration verb** when `attributePastedPrompt` already ships the exact write on both hosts with schema, allowlist, catalog and contract tests; (3) **hardening that shared verb with rejections**, which regresses the paste/drop path on ~4 000 installs (PRD contract #2); (4) **the nudge interrupting a working head**, turning a safeguard into the cause of a broken turn; (5) **shipping the fix without touching the skill**, so no agent ever registers and the blind spot persists with a mechanism sitting behind it; (6) **treating a coder's own report as the resolution signal** — the report is the thing that failed. Mitigations: fire the turn-end notifier from the file-edit clear on the same `transitioned` gate; reuse the shipped verb and leave it untouched; put the one-plan-per-terminal rule in the skill, not in a boundary check; gate the nudge on head silence and suppress it while a turn-end for the feature is outstanding; update the skill in the same change; key everything on mtime, `lastDataAt` and plan `status`.

---

## Proposed Changes

**Build order:** (1) close the wake path (registration + the file-edit notifier) → (2) the skill → (3) the feature nudge. Steps 1–2 are the fix for the observed failure and are independently shippable. Step 3 is a new opt-in capability whose "no outstanding dispatch" test is meaningless until registrations exist.

### 1. Let a head agent register its own dispatch

> **Superseded:** New verb `registerAgentDispatch` with payload `{ planFile, terminalName, workspaceRoot? }` … schema in `verbSchemas.ts`; wire the arm into **both** hosts; regenerate `protocol-catalog.json` and `src/generated/verbAllowlist.ts`. Reject rather than shadow: if `getActiveDispatchedByTerminal` already returns an unresolved row for that terminal, return `{ success: false, error }`. Reject a `terminalName` with no live seat.
> **Reason:** The verb already exists, shipped, on both hosts. `attributePastedPrompt` (`KanbanProvider.ts:10208`) takes `{ terminalName, role, planIds[], planFiles[], workspaceRoot? }`, resolves each plan by planId then plan-file, and calls `attributePasteDispatch` — the same setter the new verb was going to call. It is in `KANBAN_VERBS`, in `protocol-catalog.json`, schema'd at `verbSchemas.ts:306`, contract-tested, and served in standalone through the `kanbanVerb` `default:` delegation to `handleServiceVerb`. Writing a second verb duplicates a shipped write path, adds a fifth catalog entry to maintain, and delivers nothing the existing one does not. The two rejections are worse than useless: the verb is **shared with the webview paste/drop path**, so rejecting a second attribution for a busy terminal would break a user re-attributing a card by drag — a contract-#2 regression on ~4 000 installs — and the phantom-record fear the live-seat check answers is false, because `clearStaleWorkingState` reaps an unheartbeated `dispatched_at` inside one activity-light window (10 min).
> **Replaced with:** No new verb. The head agent calls the shipped verb; the code change is the notifier gap it exposes.

* **Registration call (agent-side, no code change):**
  `POST /kanban/verb/attributePastedPrompt` with `{ "terminalName": "<coder friendlyName>", "role": "coder", "planFiles": ["<plan file path>"], "workspaceRoot": "<root>" }` — or `planIds` when the head knows them, which resolves without the plan-file fallback. Returns `{ success, attributed, skipped }` in the body (contract #4); `attributed: 0` means nothing was stamped and the head is **not** covered — treat a zero as a failed registration, not as a success.
* **Code change — fire the turn-end notifier from the file-edit clear.** In `PlanIngestionEngine.ts:1085`, alongside the existing `_onWorkingStateCleared` call and inside the same `if (transitioned)` gate, call `_turnEndNotifier({ seatName: clearedRecord.dispatchedTerminal, planFile: relativePath, outcome: 'completed', workspaceRoot })`. Skip when `dispatchedTerminal` is empty — an unattributed dispatch has no seat to name and therefore no parent to resolve. Both callbacks stay independently optional, matching the sweep's structure at `:435`–`:446`.
* Nothing else changes. The sweep, the `blocked` outcome, the parent resolution and `notifyTurnEnd` all now work for agent dispatches because the record they were always looking for finally exists — and the `completed` outcome now fires from the path that actually observes it.

> **Superseded:** "Nothing else changes. The sweep, both outcomes, the parent resolution and `notifyTurnEnd` all now work for these dispatches because the record they were always looking for finally exists."
> **Reason:** The `completed` outcome does **not** work once the record exists, for any plan file the watcher imports: `clearWorkingState` at `:1078` NULLs `dispatched_at` on the coder's own report-write, milliseconds after it lands and ~90 s before the seat is silent enough to be swept. The sweep's `completed` arm is reachable only for writes the watcher does not import (worktree copies), which is why the arm looks alive in worktree fleets and is dead in the main checkout.
> **Replaced with:** The `blocked` outcome is fixed by the record alone; the `completed` outcome additionally requires the notifier call at `:1085`.

**Edge cases:** registration is naturally idempotent — re-calling for the same `(planFile, terminalName)` refreshes `dispatched_at`, so a resend after a failed review needs no deregister. A registration that names a terminal with no live seat self-clears within `activityLight.timeoutMs`.

### 2. Teach the skill

`.agents/skills/terminal-coder-dispatch/SKILL.md` gains a registration step between §1 (*Addressing a terminal*) and §4 (*The dispatch prompt template*):

* **Register before you send.** The `attributePastedPrompt` call, verbatim, with `curl` in the same style as the existing §1 examples, and the rule that it goes **before** `ptySendPrompt` so `dispatched_at` precedes the coder's write.
* **Check the body.** `attributed: 0` is a failed registration.
* **One outstanding plan per terminal.** `getActiveDispatchedByTerminal` is `LIMIT 1`, so a second registration against a busy terminal hides the first from the backstop. Drive one subtask at a time per coder; use a second coder for concurrency.
* **What the wake looks like.** A `[switchboard:turn-end]` message arriving at the head's prompt *is* the new turn. `blocked` means "go look", not "dead" — a `completed` notice for the same seat can follow.
* §8 (*Failure modes*) — the current first entry ("Coder never replies — nothing wakes you. Check the terminal is `status: 'active'` … and that a standing order exists") is the advice that failed on 2026-08-16: the standing order existed and was correctly oriented. Replace its fix with registration, and keep the standing order as the fast path rather than the floor.

**Edge cases:** the skill must state the one-plan-per-terminal constraint explicitly, because a head driving three coders concurrently will otherwise silently lose coverage on two of them with no error to read.

### 3. The feature-level nudge

* New config key holding a set of feature watches: `{ featureId, headTerminal, armedAt, lastNudgedAt, stopColumns? }`, read/written with `getConfigJson` / `setConfigJson`. Armed by the head agent through two new `KanbanProvider` verbs (`watchFeature` / `unwatchFeature`), default absent — nothing is watched unless an agent asks. Both arms touch only `db` + config, so standalone serves them through the existing `default:` delegation with no `bootstrap.ts` edit (contracts #3 and #7); both return their result in the body (contract #4) and get permissive schemas requiring only `featureId` (contract #5).
* On each sweep tick, for every armed watch, wake the head **only when all four hold**:
  1. the feature still has at least one un-accepted subtask;
  2. the head terminal is live and `active` (read from the liveness array the tick already built at `PlanIngestionEngine.ts:336`);
  3. the head's own `lastDataAt` is older than `turnEndSilenceMs` — it is not mid-turn;
  4. no dispatch record for any of that feature's seats is outstanding, and no turn-end notice for one of them fired on this tick.

> **Superseded:** "the feature still has at least one subtask outside the accepted terminal columns."
> **Reason:** "Accepted terminal column" is not observable from `PlanIngestionEngine` without new plumbing — column *kind* (`'completed'`) lives in `KanbanColumnDefinition` (`agentConfig.ts:118`–`:129`) and is assembled by `buildKanbanColumns` from custom agents + custom columns that the host-agnostic engine has no seam to read. Adding one to carry it is more machinery than the test needs.
> **Replaced with:** `db.getSubtasksByFeatureId(featureId)` (`KanbanDatabase.ts:6257`) already filters `status = 'active'`, and reaching the COMPLETED column sets `status = 'completed'` (`KanbanDatabase.ts:5222`, `:5235`, `:5261`). So *"no rows returned" = the feature is done*, with zero new plumbing. For a head that treats an earlier column (e.g. `CODE REVIEWED`) as accepted, the arming payload carries an optional `stopColumns: string[]`, and a subtask whose `kanbanColumn` is in that list counts as accepted too — a plain string compare on a field the returned row already carries.

* The wake carries **evidence, not a poke**: which subtasks remain, which seat each was dispatched to, how long that seat has been silent, and whether its plan file's mtime has advanced. A head woken with "check on your coders" has to re-derive everything; a head woken with the state acts immediately. The engine composes this body — it holds the subtask rows, the liveness snapshot and the mtimes; the host must not re-derive it.
* **Delivery reuses the existing turn-end transport rather than adding a second one.** `TurnEndInfo` (`PlanIngestionEngine.ts:83`) gains `outcome: 'completed' | 'blocked' | 'stalled'` plus two optional fields: `recipientSeat` (deliver here directly, skipping parent resolution — the head *is* the recipient, so resolving its parent would address the orchestrator instead) and `body` (the pre-composed evidence; hosts fall back to their own message when absent). Both host implementations change identically and minimally: honour `recipientSeat` when set, send `body` when set, keep `clearBeforePrompt: false` and `standingOrders: false`. `handleAutobanTurnEnd` (`TaskViewerProvider.ts:1343`, mirrored at `bootstrap.ts:1914`) takes the widened union and returns early on `'stalled'` — its dispatched-plan map guard at `:1350` already makes it a no-op, so the early return is explicitness, not a behaviour change.
* **Cancellation** is automatic on either condition: no un-accepted subtasks remain, or the head terminal is absent/`exited` in the liveness snapshot. Drop the watch and log which one ended it. A watch is never retried against a dead head.
* Interval: reuse `turnEndSilenceMs` for the head-silence test; the nudge fires at most once per watch per interval, paced by `lastNudgedAt` in the watch record with a floor well above the sweep tick, so a stalled feature produces a periodic reminder rather than a stream.

**Edge cases:** a feature whose head never armed a watch behaves exactly as today. Arming twice for the same feature replaces the watch rather than stacking. A watch whose feature no longer exists — `getSubtasksByFeatureId` returns nothing *and* the feature row is gone — is dropped on the next tick; note that "no subtasks" and "feature deleted" are the same observation here, and both correctly end the watch.

---

## Verification Plan

*(This pass runs under SKIP COMPILATION and SKIP TESTS directives — the plan states what must be asserted; the implementing agent runs them.)*

### Automated Tests

* **The regression test for the observed failure:** a plan registered via `attributePastedPrompt`, dispatched by `ptySendPrompt`, whose plan file is then edited **in the watched root**, produces a `completed` turn-end notice addressed to the seat's parent. This must fail against HEAD before the `:1085` change and pass after — it is the assertion that pins the half of the bug the original plan missed.
* The same dispatch with **no** mtime advance and the seat silent past `turnEndSilenceMs` produces a `blocked` notice from the sweep.
* Without registration (`dispatched_terminal` empty), neither notice fires, and the file-edit path skips the notifier rather than emitting an empty `seatName`.
* The file-edit notifier hangs off the same `transitioned` boolean as the completion broadcast — a second import for an already-cleared row fires neither callback.
* `attributePastedPrompt` stamps `dispatched_terminal` / `dispatched_at` and returns `attributed: 1` when reached over HTTP **on both hosts** — an extension test and a standalone test resolving through the `kanbanVerb` `default:` arm, per PRD contract #7. This is a verification of the reuse claim, not an assumption of it.
* A second `attributePastedPrompt` for a terminal already holding an unresolved plan still succeeds (the shipped paste/drop contract is unchanged) — asserted explicitly so a future "harden it" pass has to break a test to regress it.
* The nudge does **not** fire when the head's `lastDataAt` is recent — assert by counting delivered prompts, not by reading the watch state.
* The nudge does not fire on a tick where a turn-end notice for one of the feature's seats fired.
* The nudge stops permanently once `getSubtasksByFeatureId` returns no active subtasks, and drops when the head terminal is absent or `exited` in the liveness snapshot.
* `stopColumns` is honoured: a subtask parked in a listed column counts as accepted and does not keep the watch alive.
* The nudge payload names the remaining subtasks and their seats — assert the delivered body carries that data, not merely that a prompt was sent (PRD "done" definition).
* `handleAutobanTurnEnd` ignores `outcome: 'stalled'` in both hosts, and a `completed` notice arriving from the new file-edit path for an autoban-dispatched card behaves exactly as one from the sweep.
* `watchFeature` / `unwatchFeature` resolve in **both** hosts and return their state in the body.

### Manual Verification

1. **The observed failure, reproduced then fixed:** dispatch a subtask via `ptySendPrompt` without registering; confirm silence. Register first, repeat; confirm the turn-end notice arrives at the head when the coder writes its report **in the main checkout** — not only in a worktree.
2. **Silent coder:** dispatch, register, then leave the coder quiet without a report. Confirm the `blocked` notice at ~90 s.
3. **Blocked then completed:** after (2), have the coder write its report. Confirm a `completed` notice follows the `blocked` one.
4. **Head mid-turn:** arm a watch, keep the head busy, confirm no nudge lands in the middle of its turn.
5. **Stalled feature:** arm a watch, dispatch nothing, leave the head idle. Confirm a nudge arrives naming the un-accepted subtasks and their seats.
6. **Completion cancels:** move the last subtask to COMPLETED and confirm the nudges stop.
7. **Dead head:** exit the head terminal and confirm the watch is dropped with a log line, not retried.
8. **Shipped paste path unregressed:** drag a plan onto a terminal in the board UI twice in a row and confirm both attributions succeed.
9. **`npx` host:** repeat 1 and 5 under standalone.

---

## Outstanding Questions

- **[user]** Ship this as one plan, or split it into two — *"Wake the head when its coder finishes"* (registration + the `:1085` notifier + the skill, ships ON, fixes the observed failure) and *"Feature-level stall nudge"* (the watch verbs + sweep arm + `TurnEndInfo` widening, ships OFF, a new capability)? The two are independently shippable and the first is strictly more urgent. — proceeding as **one plan with a hard phase boundary**: §1–§2 are the fix and can merge alone; §3 is additive and touches no path §1–§2 changes.

---

## Recommendation

Complexity 6 → **Send to Coder.**

**The thing to get right:** this is a *coverage* fix, not a new mechanism, and the coverage hole has two halves. The record is missing (fixed by calling a verb that already ships), **and** the file-edit clear at `PlanIngestionEngine.ts:1078` consumes the completion transition without telling anyone (fixed by one notifier call at `:1085`). Ship only the first half and the 2026-08-16 failure reproduces exactly, with a green test suite proving the record now exists. Anyone who responds to this plan by writing a second timer — or a second registration verb — has rebuilt the working half and left the broken half in place.

**Second:** the nudge must gate on the **head's** silence as well as the feature's state. A safeguard that injects a prompt into a running turn is worse than the stall it prevents.

**Third:** the skill in the same change, and hands off `attributePastedPrompt`'s existing behaviour. A registration verb nobody is told to call protects nothing; a shared verb that starts rejecting breaks the drag-drop path for 4 000 installs.

---

## Review Findings

Reviewed 2026-08-16. §1 (the load-bearing file-edit notifier at `PlanIngestionEngine.ts:1336`) and §2 (the skill) are correct as built; §3 shipped **dead** — `notifyTurnEnd`'s malformed-parent-chain guard skipped every nudge, because the nudge sets `seatName === recipientSeat === headTerminal`, so the guard is now scoped to the parent-resolution branch in both hosts (`TaskViewerProvider.ts:1288`, `bootstrap.ts:1904`); an empty liveness snapshot (extension reload / ptyHost booting) was also permanently dropping every armed watch, fixed with a no-evidence early return (`PlanIngestionEngine.ts:928`), and the nudge body now carries the plan-file mtime the plan specified (`:1027`). Verification was NOT static-only: `tsc --noEmit` is clean for these files (5 pre-existing TS2835 errors at HEAD, unchanged), and `catalog:check`, `parity:check`, `verb-returns:check`, `push-routing:check`, `standalone-parity:check`, `standalone-fork:check`, `test:contract:{terminal-plan-attribution,paste-attribution,verb-engine-kanban,autoban-state,unattended-batch}` all pass. The change shipped with zero automated coverage, so eight assertions were added to the CI-wired `src/test/terminal-plan-attribution-contract.test.js` (27 passed) — verified to fail against HEAD, per the plan's requirement. Two out-of-scope CI blockers remain in this working tree and are **not** from this plan: `mirror:check` is still red on `switchboard-orchestration/SKILL.md` (red at HEAD too; the `terminal-coder-dispatch` half was this plan's and is fixed), and `test:contract:standing-orders-marker` crashes on a duplicate `TEAM_WIRING_SRC` declaration at `standing-orders-marker-contract.test.js:818`.

---

## Completion Report

Implemented all three sections. **§1 (the load-bearing fix):** fired `_turnEndNotifier` from the file-edit clear at `PlanIngestionEngine.ts:1301`, on the same `transitioned` gate as the completion broadcast, with `seatName` taken from `clearedRecord.dispatchedTerminal` and skipped when empty — closing the half of the bug the original plan missed (the sweep's `completed` arm is unreachable for any plan file the watcher imports). Registration reuses the shipped `attributePastedPrompt` verb unchanged; no new registration verb written. **§3 (feature nudge):** widened `TurnEndInfo` with `outcome: 'stalled'`, `recipientSeat?`, `body?`; updated both host notifiers (`TaskViewerProvider.notifyTurnEnd` and the `bootstrap.ts` inline closure) to honour `recipientSeat`/`body`, and `handleAutobanTurnEnd` in both hosts to early-return on `'stalled'`; added `watchFeature`/`unwatchFeature` arms to `KanbanProvider` (db + config only, served in standalone via the `default:` delegation), permissive schemas in `verbSchemas.ts`, and regenerated `protocol-catalog.json` + `src/generated/verbAllowlist.ts`; added `_runFeatureNudgeSweep` to `PlanIngestionEngine` gated on all four conditions (un-accepted subtasks, live head, head silence, no outstanding dispatch / no turn-end this tick), composing an evidence body and pacing via `lastNudgedAt`, with auto-cancellation on feature-done or dead head. **§2 (skill):** added a registration section (§3.5) to `.agents/skills/terminal-coder-dispatch/SKILL.md` covering register-before-send, `attributed: 0` as failure, one-plan-per-terminal, the wake outcomes, and the optional feature watch; rewrote the §8 "Coder never replies" entry to name registration as the floor and the standing order as the fast path. Files changed: `src/services/PlanIngestionEngine.ts`, `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`, `src/services/KanbanProvider.ts`, `src/services/verbSchemas.ts`, `src/generated/verbAllowlist.ts`, `protocol-catalog.json`, `.agents/skills/terminal-coder-dispatch/SKILL.md`. No issues encountered; per directives, compilation and automated tests were skipped.

---

## Reviewer Pass (2026-08-16)

Direct reviewer pass completed in-place. Four fixes applied across `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`, `src/services/PlanIngestionEngine.ts`, `.claude/skills/terminal-coder-dispatch/SKILL.md` and `src/test/terminal-plan-attribution-contract.test.js`: the nudge-delivery guard (CRITICAL — §3 was inert in both hosts), the empty-liveness watch drop (MAJOR), the stale Claude skill mirror that broke the CI-wired `mirror:check` (MAJOR), and the missing regression coverage the plan's Verification Plan required (MAJOR). Typecheck, all six ratchet gates and five affected contract suites were executed and pass; see `## Review Findings` above for the two pre-existing, out-of-scope CI blockers that remain in this working tree.
