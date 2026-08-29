# The "Seat Has Gone Quiet" Notice Flaps, and Every Flap Wakes the Lead

## Goal

A team lead must not be interrupted every time one of its coders spends 90 seconds reading a plan file. Replace the per-silence-episode "gone quiet" notice with a **paced, aggregated wake** — one message to the lead per interval, listing every seat that is actually stuck — modelled on the feature-stall nudge that already exists in the same sweep.

### The problem

With a team running, the lead receives a stream of:

```
[switchboard:turn-end] Seat 'coder-2' has gone quiet on '<plan>' without writing a completion report — it may be waiting on input.
```

for seats that are simply reading. Each one is delivered into the lead's terminal via `ptySendPrompt`, so it interrupts whatever the lead is doing and costs it a turn.

### Root cause — the single-fire gate is not single-fire

The notice is emitted from the plan-ingestion sweep, `src/services/PlanIngestionEngine.ts:483-497`:

```ts
} else if (!record.blockedAt) {
    await db.setBlockedState(record.planFile, wsId, livenessIso);
    // "The `!record.blockedAt` guard IS the single-fire gate for the blocked
    //  arm — once blockedAt is stamped this branch cannot re-enter, so the
    //  notifier fires exactly once per blocked turn."
    if (this._turnEndNotifier) { … outcome: 'blocked' … }
}
```

That comment is **false**, and its falsity is the whole defect. Eighty lines up the same sweep runs:

```ts
if (liveNames.length > 0) {
    recordedLiveness += await db.recordLiveness(wsId, liveNames, livenessIso);
}
```

and `KanbanDatabase.recordLiveness` (`src/services/KanbanDatabase.ts:9995-10014`) executes:

```sql
UPDATE plans SET last_liveness_at = ?, blocked_at = NULL
WHERE workspace_id = ? AND dispatched_at IS NOT NULL AND dispatched_terminal IN (…)
```

So `blocked_at` is **cleared on every burst of terminal output**. The guard is not "once per dispatch" — it is "once per silence episode", and a seat re-arms it every time it prints anything.

The loop, on the default 10s sweep tick with `turnEndSilenceMs` = 90 000 (`PlanIngestionEngine.ts:337`):

1. Seat prints a tool call → within `livenessWindowMs` (90s, `:330`) → `recordLiveness` nulls `blocked_at`.
2. Seat reads a 900-line plan file, thinks, produces nothing for 90s → silence branch (`:374`) → `setBlockedState` → **notice to the lead**.
3. Seat prints its next tool call → back to (1).

A coder alternating read/think/act therefore emits a notice every ~2 minutes, *per seat*. With a 4-seat team that is a message to the lead roughly every 30 seconds. Nothing is wrong; the seat is working.

### The second half: the lead is the sink for all of them

`TaskViewerProvider.notifyTurnEnd` resolves the recipient by walking the seat's `parentInstanceId` to its parent terminal (`src/services/TaskViewerProvider.ts:1444-1452`). Every member of a team has the lead as its parent. So N seats × M flaps all land on one terminal, unbatched, each as its own `ptySendPrompt`.

### Why the fix is a paced wake, not a bigger timeout

Raising `turnEndSilenceMs` trades one failure for another: a genuinely stuck seat then goes unreported for longer, and the knob is shared with the completion-detection branch above it (`:456-482`), which must stay responsive.

The correct shape already exists in this file. `_runFeatureNudgeSweep` (`PlanIngestionEngine.ts:905-1075`) is exactly a "semi-regular wake for the head": it gates on the head being live and *not mid-turn*, paces itself with `lastNudgedAt` against a `turnEndSilenceMs` floor, and delivers **one message carrying composed evidence** — remaining subtasks, their seats, how long each has been silent, plan-file mtimes — instead of a poke. Reuse that shape for the blocked arm.

### The constraint that shapes the design: the notifier has two consumers, not one

`setTurnEndNotifier` is a **single-slot setter**, and both hosts deliberately fold two consumers into the one closure:

- `src/extension.ts:1103-1111` — `taskViewerProvider.notifyTurnEnd(info)` **then** `taskViewerProvider.handleAutobanTurnEnd(info)`.
- `src/standalone/bootstrap.ts:2017-2098` — the same pair.

`handleAutobanTurnEnd` is a **state machine**, not a message: on `outcome: 'blocked'` it clears the card's stall watchdog, deletes the card from `_autobanDispatchedPlanFiles`, and halts the lane. It keys strictly on `info.planFile`. So the blocked notice is doing two jobs at once — waking a human-facing agent, and retiring an autoban in-flight record — and only the first job should be paced or aggregated. A digest that collapses N seats into one `{ seatName, planFile }` silently starves the second: seats 2..N of a batch, and every seat paced out of a window, never reach autoban, so their lanes never halt and their watchdogs stay armed. That is why the fix splits *signal* from *delivery* rather than simply replacing the emission.

## Metadata

**Complexity:** 6
**Tags:** backend, reliability, bugfix
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine

- Deleting the false "single-fire gate" comment (`PlanIngestionEngine.ts:487-489`) — it is the in-code rationale for behaviour the user has reported as a bug, so it goes, rather than being worked around.
- Adding a config key alongside the existing `activityLight` knobs (`package.json:573-604`).
- The two one-line host guards on the new `deliver` field.

### Complex / Risky

- **`setBlockedState` must keep firing on its current schedule.** The board's blocked ring and `anyBlocked` rollup read `blocked_at` directly. Slowing or suppressing the *stamp* would dim the board. Only the **notification** is paced — the DB write is untouched.
- **The notifier has two consumers.** See the Goal section. The per-seat `blocked` signal must keep reaching `handleAutobanTurnEnd` at today's cadence while the lead-facing text is paced and aggregated.
- **Pacing state has to survive the tick.** The sweep is stateless per tick and `blocked_at` is unusable as a latch (that is the bug). The pace stamp must live somewhere `recordLiveness` does not clear. Two candidates: an in-memory `Map` on the engine, or a DB config key. In-memory is wrong — the standalone host and the extension host each construct their own engine, and an extension reload would reset every pace window and produce a burst. Use a DB config key, the same home `kanban.featureWatches` uses.
- **Recipient resolution lives in the host, not the engine.** The engine "has no fleet identity data and must stay host-agnostic". It cannot group seats by lead, so the digest is composed per workspace folder and the host resolves its recipient from the first seat's parent chain — see the Edge-Case audit for the accepted trade.

## Edge-Case & Dependency Audit

**Race conditions**

- **A seat that recovers before the window closes.** By the time the digest is composed, `recordLiveness` may have nulled `blocked_at` for some seats in the batch. Re-read each candidate's `blocked_at` at compose time and drop the recovered ones. If the batch empties, send nothing and do not stamp the window — a silent tick is correct.
- **Genuinely stuck seats must still surface.** The pace window delays the *first* report by at most one window. Default the window to `turnEndSilenceMs` (90s), matching the feature nudge's floor — so a truly stuck seat is reported within ~90s of being stamped, which is what happens today.
- **`notifiedSeatsThisTick`.** The feature-nudge sweep suppresses itself when a per-dispatch notice already fired for one of its seats. Populate that set **only for seats the digest actually delivers** — a seat whose notice was paced out did not wake the head, so suppressing the nudge on its behalf would silence both channels at once. The per-seat machine-only emission must **not** add to the set.

**Security**

- No new surface. The digest body names seat names and workspace-relative plan paths — the same data the singular notice already carried.

**Side effects**

- **The orchestrator report mirror changes shape.** `writeOrchestratorReport` is called from inside both hosts' notifier closures, so today every blocked seat writes its own `kind: blocked` report file. Under the split it writes **one digest file per pace window** naming every due seat in the body, with `planId` set to the first seat's plan file. Fewer, richer files — but a file-inbox consumer that counted one report per blocked seat will see fewer. Accepted and intended; the digest body is the superset.
- **Mixed parents in one batch.** A workspace can run two teams. The single-recipient resolution addresses only one lead.
  > **Superseded:** "Mitigate by keying the pace window and the batch on **`dispatchedAgent` + parent-unknown**: emit one notice per *distinct seat-name batch* whose first member resolves the recipient".
  > **Reason:** Incoherent — `dispatchedAgent` is a **role** (`coder`, `intern`), not a team, so keying on it groups two teams' coders together exactly as before while adding a key nobody can reason about. The engine has no parent data at all, so no engine-side key can approximate a team.
  > **Replaced with:** emit **one digest per workspace folder per tick**. The host resolves the recipient from the first due seat's parent chain, exactly as it does today for a singular notice. Every due seat's name and plan file appear in the body, so a lead reading about a seat that is not its own can still act, and the engine logs the seats it reported so the under-notification is visible in the log rather than silent. Do **not** add a new agent role, a new resolver, or a second notifier slot.
- **No team / no lead.** With no parent chain the host falls back to a live `orchestrator` terminal, then to nothing. Unchanged.
- **`sql.js` heap.** Per folder per tick: one `getConfigJson`, one conditional `setConfigJson`, and one `getActiveDispatchedByTerminal` per newly-blocked seat. The sweep already does several reads; this is within budget. Do not write the config when nothing changed, and do not add a retry loop.

**Dependencies & conflicts**

- **Two hosts, one engine.** `notifyTurnEnd` exists twice: `TaskViewerProvider.ts:1390` and `src/standalone/bootstrap.ts:2017`. Both already honour a pre-composed `body` (`info.body ?? (…)`), so **the message needs no host change**.
  > **Superseded:** "so **no host change is required** for the message. Verify both branches, do not assume."
  > **Reason:** True of the *body*, false of the *change*. Splitting the machine signal from the delivered text requires both hosts to learn one new field, because each host's single notifier closure fans out to two consumers (`notifyTurnEnd` and `handleAutobanTurnEnd`) and only one of them may be suppressed.
  > **Replaced with:** a one-line guard in each host's delivery path on a new `TurnEndInfo.deliver` field (§4 below). `handleAutobanTurnEnd` stays unguarded and keeps its current cadence.
- **Config key is new state.** `activityLight.blockedNotifyIntervalMs` is unreleased, so it takes a clean break — no migration. The DB config key holding the pace stamps (`kanban.blockedNotifyPacing`) is likewise new; a missing key reads as `{}`.
- **Pacing map growth.** Key by `<workspaceId>|<seatName>`; prune entries whose seat is absent from the current liveness snapshot on each write, the same way `_runFeatureNudgeSweep` drops watches for absent heads. An empty liveness snapshot is no evidence — skip the prune entirely that tick (same guard as `:928`).

## Dependencies

- Independent of the two sibling subtasks in this feature. It is the only one that touches `src/services/PlanIngestionEngine.ts`, and its host edits (`TaskViewerProvider.notifyTurnEnd`, the `bootstrap.ts` turn-end closure at `:2017`) are in different regions from theirs. Land it last so it rebases onto a settled `bootstrap.ts`.
- No external dependencies. `getConfigJson` / `setConfigJson` (`KanbanDatabase.ts:5296`, `:5302`) and `getActiveDispatchedByTerminal` (`:9821`, which returns `blockedAt` — mapped at `:10145`) all exist at HEAD.

## Adversarial Synthesis

**Risk summary.** The reported symptom is a flapping notice, but the load-bearing risk is the fix's blast radius: the blocked notice is simultaneously a human-facing wake and the autoban lane's "stop" signal, so naively aggregating it would trade a noisy lead for silently stuck autoban lanes and armed watchdogs. Secondary risks are pacing state that does not survive an extension reload (which would re-burst on every reload) and a digest that reports seats which recovered between the stamp and the compose. Mitigations: split signal from delivery via a `deliver` flag so autoban keeps its per-seat cadence untouched; hold pace stamps in the DB config table rather than in engine memory; re-read `blocked_at` at compose time and drop recovered seats; and leave `setBlockedState` on its existing schedule so the board's blocked ring is unaffected.

## Proposed Changes

### 1. `src/services/PlanIngestionEngine.ts` — add the `deliver` field to `TurnEndInfo`

In the `TurnEndInfo` interface (`:83-100`):

```ts
    /** `false` = machine signal only. Consumers that DELIVER text (the pty send and the
     *  orchestrator report mirror) must skip it; state consumers (handleAutobanTurnEnd)
     *  must still run. Used by the blocked arm, which fires per seat at the sweep's own
     *  cadence for autoban while its lead-facing text is paced and aggregated into one
     *  digest by _runBlockedDigestSweep. Absent/true = deliver, today's behaviour. */
    deliver?: boolean;
```

### 2. `src/services/PlanIngestionEngine.ts` — stop delivering from inside the per-seat loop

At `:483-497`, keep the DB stamp **and** the per-seat notifier call (autoban needs it), mark it undelivered, drop it from `notifiedSeatsThisTick`, and collect the seat for the digest:

```ts
                                    } else if (!record.blockedAt) {
                                        await db.setBlockedState(record.planFile, wsId, livenessIso);
                                        this._host.logger.appendLine(
                                            `[GlobalPlanWatcher] Turn-end (silence) marked blocked for ${terminalName}: ${record.planFile}`
                                        );
                                        // `blocked_at` is NOT a single-fire latch: recordLiveness
                                        // (above, KanbanDatabase.recordLiveness) NULLs it on every
                                        // burst of terminal output, so a seat that alternates
                                        // read/think/act re-enters this branch every ~2 minutes.
                                        // The notice therefore fires once per SILENCE EPISODE, not
                                        // once per dispatch.
                                        //
                                        // The signal still fires per seat at this cadence because
                                        // handleAutobanTurnEnd keys on it to retire the card's
                                        // in-flight record and halt its lane — but it is NOT
                                        // delivered as text, and it does NOT count as a wake for
                                        // notifiedSeatsThisTick. The lead-facing message is paced
                                        // and aggregated in _runBlockedDigestSweep below.
                                        if (this._turnEndNotifier) {
                                            try {
                                                this._turnEndNotifier({
                                                    seatName: terminalName,
                                                    planFile: record.planFile,
                                                    outcome: 'blocked',
                                                    workspaceRoot: folder,
                                                    deliver: false,
                                                });
                                            } catch (cbErr) {
                                                this._host.logger.appendLine(`[GlobalPlanWatcher] turnEndNotifier callback failed: ${cbErr}`);
                                            }
                                        }
                                        blockedThisTick.push({ terminalName, planFile: record.planFile });
                                    }
```

Declare `const blockedThisTick: Array<{ terminalName: string; planFile: string }> = [];` beside `notifiedSeatsThisTick` (`:401`).

### 3. `src/services/PlanIngestionEngine.ts` — new `_runBlockedDigestSweep`

```ts
    /**
     * Paced, aggregated "seat is stuck" wake — the blocked-arm counterpart to
     * _runFeatureNudgeSweep. The per-seat notice it replaces fired once per
     * SILENCE EPISODE, not once per dispatch, because recordLiveness nulls
     * `blocked_at` on any output; a lead therefore received one interrupt per
     * seat per ~2 minutes for seats that were merely reading.
     *
     * Pacing state lives in the DB config key `kanban.blockedNotifyPacing`
     * ({ "<workspaceId>|<seat>": epochMs }), NOT in memory: each host builds its
     * own engine and an extension reload would otherwise reset every window and
     * produce a burst.
     */
    private async _runBlockedDigestSweep(args: {
        db: KanbanDatabase;
        folder: string;
        wsId: string;
        nowMs: number;
        intervalMs: number;
        liveness: Array<{ friendlyName: string; lastDataAt: number; status: string }>;
        blockedThisTick: Array<{ terminalName: string; planFile: string }>;
        notifiedSeatsThisTick: Set<string>;
    }): Promise<void> {
        const { db, folder, wsId, nowMs, intervalMs, liveness, blockedThisTick, notifiedSeatsThisTick } = args;
        if (!this._turnEndNotifier || blockedThisTick.length === 0) { return; }

        const KEY = 'kanban.blockedNotifyPacing';
        let pacing: Record<string, number> = {};
        try { pacing = await db.getConfigJson<Record<string, number>>(KEY, {}) || {}; } catch { return; }

        // Only seats outside their pace window, and only those STILL blocked at
        // compose time — a seat can have produced output between the stamp above
        // and here, which nulls blocked_at and makes the report a lie.
        const due: Array<{ terminalName: string; planFile: string; silentFor: number }> = [];
        const byName = new Map(liveness.map(e => [e.friendlyName, e]));
        for (const cand of blockedThisTick) {
            const key = `${wsId}|${cand.terminalName}`;
            const last = pacing[key] || 0;
            if (last > 0 && nowMs - last < intervalMs) { continue; }
            const rec = await db.getActiveDispatchedByTerminal(wsId, cand.terminalName);
            if (!rec || !rec.blockedAt) { continue; }
            const lastDataAt = byName.get(cand.terminalName)?.lastDataAt || 0;
            due.push({
                terminalName: cand.terminalName,
                planFile: cand.planFile,
                silentFor: lastDataAt > 0 ? Math.round((nowMs - lastDataAt) / 1000) : 0,
            });
        }
        if (due.length === 0) { return; }

        // Evidence, not a poke — same contract as the feature nudge.
        const lines = [
            `[switchboard:turn-end] ${due.length} seat(s) have gone quiet without writing a completion report — they may be waiting on input:`
        ];
        for (const d of due) {
            const silence = d.silentFor > 0 ? `, silent ${d.silentFor}s` : '';
            lines.push(`  - ${d.terminalName} on ${d.planFile}${silence}`);
        }
        lines.push('Check each seat and unblock it, or re-dispatch its plan. No action is needed for a seat that is simply working.');

        // Recipient is resolved by the HOST from the FIRST due seat's parent chain —
        // the engine has no fleet identity data and must stay host-agnostic. Where a
        // workspace runs two teams this addresses one lead; every seat is named in the
        // body, and the log line below makes the under-notification visible.
        try {
            this._turnEndNotifier({
                seatName: due[0].terminalName,
                planFile: due[0].planFile,
                outcome: 'blocked',
                workspaceRoot: folder,
                body: lines.join('\n'),
            });
        } catch (cbErr) {
            this._host.logger.appendLine(`[GlobalPlanWatcher] blocked digest notifier failed: ${cbErr}`);
        }
        this._host.logger.appendLine(
            `[GlobalPlanWatcher] Blocked digest fired for ${folder} → recipient resolved from '${due[0].terminalName}' (${due.map(d => d.terminalName).join(', ')}).`
        );

        for (const d of due) {
            pacing[`${wsId}|${d.terminalName}`] = nowMs;
            notifiedSeatsThisTick.add(d.terminalName);
        }
        // Prune seats no longer in the fleet. An EMPTY liveness snapshot is no
        // evidence (same guard as _runFeatureNudgeSweep) — skip the prune then.
        if (liveness.length > 0) {
            for (const key of Object.keys(pacing)) {
                const seat = key.slice(key.indexOf('|') + 1);
                if (!byName.has(seat)) { delete pacing[key]; }
            }
        }
        try { await db.setConfigJson(KEY, pacing); } catch { /* next tick retries */ }
    }
```

Wire it after the `silentTerminals` block closes and **before** `_runFeatureNudgeSweep` (`:520`), so the nudge's `notifiedSeatsThisTick` check sees this tick's digest:

```ts
                        const blockedNotifyIntervalMs = activityCfg.getNumber('blockedNotifyIntervalMs', turnEndSilenceMs);
                        try {
                            await this._runBlockedDigestSweep({
                                db, folder, wsId, nowMs, intervalMs: blockedNotifyIntervalMs,
                                liveness, blockedThisTick, notifiedSeatsThisTick,
                            });
                        } catch (digestErr) {
                            this._host.logger.appendLine(`[GlobalPlanWatcher] blocked digest sweep failed for ${folder}: ${digestErr}`);
                        }
```

`db`, `folder`, `wsId`, `nowMs`, `activityCfg`, `turnEndSilenceMs`, `liveness` and `notifiedSeatsThisTick` are all already in scope at that point.

### 4. Both hosts — honour `deliver: false`

**`src/services/TaskViewerProvider.ts`**, at the top of `notifyTurnEnd` (`:1390`), before the `_ptyHostPort` check:

```ts
            // Machine-only signal (the blocked arm's per-seat emission). The lead-facing
            // text for those seats arrives as one paced digest from
            // PlanIngestionEngine._runBlockedDigestSweep; handleAutobanTurnEnd — the
            // OTHER consumer of this single-slot notifier — still receives every one of
            // them, which is what keeps autoban lanes halting on their existing cadence.
            // Deliberately unlogged: this fires per blocked seat per tick and the digest
            // logs the seats it reported.
            if (info.deliver === false) { return; }
```

**`src/standalone/bootstrap.ts`**, the same guard as the first statement inside the async IIFE in the `setTurnEndNotifier` closure (`:2018`). It must be **inside** the IIFE, not around the whole closure: `taskViewerProvider.handleAutobanTurnEnd(info)` at the end of the closure must keep running.

Both guards sit above `writeOrchestratorReport`, so an undelivered signal writes no report file either.

### 5. `package.json` — contribute the knob

Add `switchboard.activityLight.blockedNotifyIntervalMs` (number, default `90000`, minimum `10000`) beside the existing `activityLight.*` settings (`:573-604`), described as: *"Minimum interval between 'seat has gone quiet' wakes for the same seat. Notices are batched into one message per interval."*

### 6. Host inline fallbacks — leave them, but name the real producer

`TaskViewerProvider.ts:1403-1409` and `bootstrap.ts:2021-2027` both compose the singular string as `info.body ?? (…)`. The engine now always supplies `body` for a *delivered* blocked notice, so those arms become the malformed-input fallback they were written to be. No behavioural change; add a one-line comment on each naming `_runBlockedDigestSweep` as the real producer.

## Verification Plan

### Automated Tests

1. `npx tsc --noEmit -p .` clean.
2. **New unit coverage** in `src/test/plan-ingestion-blocked-digest.test.js`:
   - a seat flapping (blocked → live → blocked) three times inside one interval produces **one** *delivered* notifier call, not three;
   - two seats blocked in the same tick produce **one** delivered call whose body lists both;
   - a seat whose `blocked_at` was nulled between the stamp and the digest is **excluded** from the body;
   - every blocked seat still produces a `deliver: false` notifier call on its own tick (the autoban signal), including seats paced out of the digest;
   - `notifiedSeatsThisTick` is populated for reported seats **only** — a paced-out seat is absent, so the feature nudge can still fire for it;
   - an empty `liveness` snapshot does not prune the pacing map.
3. `node --test src/test/autoban-state-regression.test.js` and `src/test/terminal-plan-attribution-contract.test.js` — the autoban turn-end contracts still hold.
4. Full suite. Five tests are red at HEAD independently — stash-verify before attributing.

### Manual / end-to-end

5. **With a live team.** Start a lead + 3 coders, dispatch three plans.
   - Watch the lead's terminal for 15 minutes. Assert **at most one** gone-quiet message per 90s window, listing seats by name, and none at all while every seat is producing output.
   - Compare against the pre-change behaviour on the same workload — record both counts in the completion report.
6. **Stuck-seat latency.** Suspend one coder's agent process. Assert the lead is told within ~90–100s and that the message names that seat and its plan file.
7. **Board unaffected.** While seats flap, assert the kanban card's blocked ring still lights and clears on the existing schedule — proof the `setBlockedState` write was not paced along with the notice.
8. **Autoban lane halt.** With single-column autoban running, let an autoban-dispatched card's seat go silent. Assert the lane halts on the existing schedule (log: `Turn-end 'blocked' for card … — lane halts, not advancing`) even when that seat is **not** the first member of the digest batch and even when it is paced out of the digest entirely.
9. **Report mirror.** Assert `.switchboard/orchestrator/reports/` receives one `kind: blocked` file per delivered digest — not one per blocked seat per tick — and that its body names every due seat.
10. **Both hosts.** Repeat step 5 abbreviated under `npx switchboard` to confirm the standalone notifier honours both the composed `body` and the `deliver: false` guard.

---

**Recommendation:** Complexity 6 → **Send to Coder**.

## Implementation Summary

Replaced the per-silence-episode "gone quiet" notification with a paced, aggregated wake mechanism in `PlanIngestionEngine.ts`. The blocked state is still stamped in the DB and signals machine consumers via `deliver: false` on every silence tick (preserving autoban lane halt behavior), while lead-facing text is aggregated and paced per workspace via `_runBlockedDigestSweep` (storing per-seat pacing timestamps in `kanban.blockedNotifyPacing`). Added `deliver?: boolean` to `TurnEndInfo` and guarded prompt delivery in both `TaskViewerProvider.notifyTurnEnd` and `bootstrap.handleTurnEndNotify`. Added `switchboard.activityLight.blockedNotifyIntervalMs` to `package.json` and unit test coverage in `src/test/plan-ingestion-blocked-digest.test.js`.

