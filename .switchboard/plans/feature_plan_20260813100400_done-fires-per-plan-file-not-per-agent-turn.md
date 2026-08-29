# One Completion Signal Per Agent Turn — Batch-Aware "Done" and a Falsifiable Silence Verdict

## Goal

Make the completion signal mean **"this agent finished its turn"** rather than **"one of
the plan files this agent was given has been written"**, and make the sweep's
silence verdict falsifiable rather than a four-hour assertion built on a guess. After this
change, a coder handed six subtasks of a feature reports done once — when the last of the
six is written — instead of six times, the first of them arriving minutes before any real
work is finished; and a seat that goes quiet without ever writing its plan file stops
claiming "Waiting on you" for the rest of the afternoon.

This plan owns the **engine and the wire**: `KanbanDatabase`, `PlanIngestionEngine`, both
host broadcasters, and the `activityLight` config block. It owns no webview file. The
rendering half of the same feature — the solo-window guard, the pane-header `DONE` chip, and
the toast — is a separate subtask that owns `src/webview/terminals.js` and
`src/webview/shell.js` outright.

### The problem — part 1: one turn, N notices

Dispatch a feature (or drag several cards onto one agent) and the agent receives one prompt
covering N plans. It works through them, writing each plan file as it finishes that
subtask. The board and the Terminals panel announce completion the moment the **first** plan
file is touched, then again for the second, and so on. In a batch plan review — where the
reviewer's first act on each plan is to append a Review Findings section — the very first
notice can arrive within a minute of dispatch, while five of six plans have not been looked
at.

The operator's read of "done" is therefore wrong in both directions: it fires early (the
agent is still working) and it fires repeatedly (one turn, N notices).

### The problem — part 2: a card whose agent went silent without writing its plan file

Completion detection has one authority: the dispatched agent appending its completion
report to the plan file, which the watcher observes as an mtime advance and uses as the
activity-light OFF-switch. Two user-visible failures follow from that:

1. **Latency.** Claude Code goes completely silent the moment it finishes. The card stays
   lit until the agent gets around to the plan-file edit, or until the blind timeout
   expires.
2. **Stuck lights — the more important one.** Agents do not reliably perform the completion
   edit. When an agent finishes its work but skips or botches the plan-file append, the
   handshake never fires and the card stays lit. The board asserts "agent working" about an
   agent that stopped working long ago. The user has confirmed this happens in practice and
   that clearing on silence outright is the desired behaviour, accepting the false-positive
   tradeoff recorded below.

**Accepted tradeoff (preserved from the original analysis).** Silence is ambiguous:
finished-and-idle, blocked-on-a-permission-prompt, and mid-long-compile are
indistinguishable from output recency alone. Clearing on silence therefore admits false
positives — a card whose agent is still working can go dark. This is accepted deliberately:
an early-dark light is self-correcting (the next byte of output re-stamps liveness), whereas
a permanently-lit stale card is not. Scope is strictly limited to the activity light — this
plan must not move cards, trigger merge-back, or advance workflow state on silence. The
mtime handshake remains the sole authority for anything that mutates workflow state.

> **Superseded:** *"`PlanIngestionEngine.ts:290-304` partitions the fleet three ways … the
> third branch — active but silent longer than `livenessWindowMs` — carries the comment
> `no evidence; falls through to the blind timer (do nothing here)` and is inert. Add
> `switchboard.activityLight.silenceMs` to `package.json` … compute the quiescent set in the
> sweep … add a third UPDATE to `clearStaleWorkingState` … thread the clear reason through
> the cleared-state callback and suppress the completion toast for the `quiescent` reason."*
> **Reason:** All of it landed in commit `1bd39f4a` (2026-08-14) while these plans were being
> written, under different names. The third branch is **no longer inert**: `PlanIngestionEngine.ts:311-317`
> pushes the seat onto `silentTerminals`, and lines 340-378 run a full turn-end sweep against
> it. The config key exists as `switchboard.activityLight.turnEndSilenceMs` (`package.json:585`,
> default 90 s), alongside `blockedTimeoutMs` (`:593`). `setBlockedState` (`KanbanDatabase.ts:9803`)
> is now called from that sweep.
> **Replaced with:** The silence half of this plan is now **only** the residue that commit
> left behind — see "The problem — part 3". No new config key is added; one existing default
> is corrected.

> **Superseded:** *"Once quiescence clears working state, `src/extension.ts:1070`'s wiring to
> `broadcastAgentCompleted` fires on quiescence too — thread a `reason` through the
> cleared-state callback and suppress the completion toast for the `quiescent` reason."*
> **Reason:** False premise, verified against the code. `clearStaleWorkingState`
> (`KanbanDatabase.ts:9936`) is invoked at `PlanIngestionEngine.ts:379` and its only
> consequence on `cleared > 0` is `_firePlanDiscovered(folder)` (`:387`) — a board refresh.
> It has **never** called `_onWorkingStateCleared` and therefore cannot fire a completion
> toast. The only two broadcast sites are `_processPlanFile` (`:998`) and the turn-end
> silence sweep (`:363`), and the sweep only broadcasts on the `completed` branch — i.e. on
> a real plan-file mtime advance, which is the same evidence the file-edit path uses.
> **Replaced with:** No `reason` field. Both broadcasting sites carry identical evidence, so
> there is nothing for a reason code to discriminate, and a field with no consumer is a dead
> payload. The callback gains exactly one optional argument (`planCount`) instead of two.

### The problem — part 3: the silence verdict holds the light for four hours on a guess

Commit `1bd39f4a` answered the stuck-light problem with a *blocked* state rather than a
clear. The sweep's non-completed branch calls `setBlockedState`, and the read-time derive
(`KanbanProvider.isWorkingState`, `KanbanProvider.ts:165-191`) computes:

```ts
const blocked = Number.isFinite(blockedTs) && (now - blockedTs) < blockedTimeoutMs;
const working = blocked || (withinHardCap && (now - basis) < timeoutMs);
```

Three consequences, all against the user's stated intent:

- **`blocked` short-circuits the hard cap.** The `3 × timeoutMs` cap exists so "a stuck light
  stays falsifiable" (its own comment). A blocked row bypasses both it and `timeoutMs`; the
  same bypass exists in SQL at `KanbanDatabase.ts:9953-9960`, where a blocked row is cleared
  only when `blocked_at < blockedCutoff`.
- **`blockedTimeoutMs` defaults to four hours** (`package.json:593`), described as "a wait on
  a human, not a machine". So the exact case the user reported — agent finished, never wrote
  the file — now stays lit for **4 hours**, where before `1bd39f4a` it cleared at 10 minutes.
  The reported bug got worse, not better.
- **Every blocked verdict in the product is silence-derived guesswork.** `setBlockedState`'s
  own doc comment still says *"CURRENTLY UNCALLED. Its only caller was the Claude-Code-only
  `POST /agent/event` hook route, removed as CLI-specific"*. The hook that could actually
  observe "the agent asked you a question" is gone. The sweep cannot distinguish
  blocked-on-a-prompt from died-silently from finished-without-writing — and it labels all
  three "Waiting on you" for four hours.

The four-hour retention was correct reasoning for a *hook-derived* verdict. It is not correct
for a verdict produced by 90 seconds of silence. And the long tail never served the case it
was written for: a human who answers the prompt produces output, `recordLiveness`
(`KanbanDatabase.ts:9995`) nulls `blocked_at` on the very next 10-second tick, and the card
un-blocks itself. The only cards the 4-hour tail ever keeps lit are the abandoned ones.

### Root cause (part 1) — the batch discriminator

**A single dispatch stamps N plan rows, and the completion signal is keyed to a plan row
rather than to the terminal's turn.**

*The dispatch side.* One fan-out writes the same terminal onto every card
(`bootstrap.ts`, the `dispatchCards` verb):

```ts
await deliverPrompt(terminal, prompt, getPromptDeliveryOptions());

for (const rec of records) {
    if (!rec.planFile) { continue; }
    await db.updateDispatchInfoByPlanFile(rec.planFile, rec.workspaceId || workspaceId, {
        routedTo: targetColumn || rec.kanbanColumn || '',
        dispatchedAgent: targetRole,
        dispatchedIde: PTY_IDE_NAME,
        dispatchedTerminal: terminal.friendlyName,
    });
}
```

`updateDispatchInfoByPlanFile` (`KanbanDatabase.ts:9709`) sets `dispatched_at = now` on each
row. So after one dispatch, N rows share one `dispatched_terminal` and one turn.

*The completion side, path 1 — plan-file edit.* `PlanIngestionEngine._processPlanFile`
(`:985-1005`) runs per changed file and clears that file's row:

```ts
const transitioned = await db.clearWorkingState(relativePath, workspaceId);
…
if (transitioned && this._onWorkingStateCleared) {
    this._onWorkingStateCleared(clearedRecord, workspaceRoot);
}
```

`clearWorkingState` returns true on a real non-NULL→NULL transition, which correctly
suppresses a *double* broadcast for the *same row*. It has no idea the row has N−1 siblings
in the same turn. Each sibling's own first write produces its own `transitioned === true`
and its own broadcast. **N broadcasts per turn, the first of them early.**

*The completion side, path 2 — the turn-end silence sweep.* The silence branch
(`PlanIngestionEngine.ts:344`) resolves the terminal's plan with
`db.getActiveDispatchedByTerminal(wsId, terminalName)`, which is:

```sql
SELECT … FROM plans
 WHERE workspace_id = ? AND status = 'active' AND is_feature = 0
   AND dispatched_terminal = ? AND dispatched_at IS NOT NULL
 ORDER BY dispatched_at DESC LIMIT 1
```

`LIMIT 1`. For a batch, the sweep tests exactly one of the N plan files' mtimes and either
clears that one or marks it blocked. The other N−1 rows are invisible to the sweep and are
left to the 10-minute stale-state timeout, which is an *abandonment* path and deliberately
does **not** broadcast. So the sweep both under-reports (N−1 rows never turn-end properly)
and mis-attributes (the one row it picks is whichever was dispatched last, not whichever the
agent is actually on).

### Background context

- Completion is intentionally derived from **plan-file mtime advance**, not from a hook or
  a marker string — that basis is correct and this plan does not change it. Terminal
  scraping and vision-based inspection remain out of scope.
- The per-card activity light going out as each plan file is written is also correct: that
  card really is finished. What is wrong is treating a per-card transition as a per-agent
  notification.
- `clearWorkingState`'s transition gate exists to stop two concurrent clearers double-firing
  for one row. It is necessary and stays; it is simply the wrong granularity for "the agent
  finished".
- Both hosts consume `_onWorkingStateCleared`: `bootstrap.ts:493` and
  `extension.ts:1070` → `TaskViewerProvider.broadcastAgentCompleted`. Gating must live where
  both inherit it — in the engine, not in each broadcaster.
- The doc comments on **both** broadcasters currently claim the push fires "ONLY from the
  plan-file-edit clear site in PlanIngestionEngine — never from the stale-state timeout
  sweep". That was true before `1bd39f4a`; the turn-end silence sweep is now a second
  broadcasting clear site. The comments are stale and are corrected here, because the next
  reader will otherwise trust them over the code.

## Metadata

- **Complexity:** 7
- **Tags:** backend, database, bugfix, reliability
- **Project:** Browser Switchboard

## User Review Required

None. The one judgement call — whether a silence-derived verdict keeps the four-hour
"Waiting on you" retention — is decided in this plan: it does not. Rationale is in
"The problem — part 3"; the setting remains user-raisable for anyone who wants the old
behaviour.

## Complexity Audit

### Routine

- Two additive read queries on `plans`, both using the existing `PLAN_COLUMNS` /
  `_readRows` idiom and both predicated on already-indexed columns.
- One `default` change and one description rewrite in `package.json`.
- Two stale doc comments corrected (`setBlockedState`, both broadcasters).
- One optional argument threaded through a callback both hosts already implement.

### Complex / Risky

- It changes the meaning of a signal two hosts and three UI surfaces already consume, and it
  touches the plan-watcher poll — the most timing-sensitive loop in the system.
- The gate must be evaluated **after** the row is cleared, so the "any siblings left?" query
  sees the post-clear state. Getting the order wrong makes the last plan of a batch never
  broadcast at all — a silent regression that looks like the feature working.
- The silence sweep's `LIMIT 1` removal changes the sweep from O(1) to O(rows-for-terminal)
  `stat` calls per silent terminal per tick. Bounded in practice (a batch is single digits)
  but it belongs in the audit.
- The turn-size counter is in-memory state inside a long-lived engine. It must not leak
  entries and must not let an abandoned turn inflate the next turn's count.
- No schema change and no migration: `dispatched_terminal` (V57) and the liveness columns
  (V59) already carry everything needed. This is query, gating and config work only.

## Edge-Case & Dependency Audit

### Race Conditions

1. **Two clearers racing one row.** `clearWorkingState`'s non-NULL→NULL transition gate is
   the arbiter; exactly one caller wins the UPDATE and only that caller consults the batch
   gate. The two gates compose — they must not cancel. Covered by verification step 11.
2. **The gate reads a moving target.** Between the clear and the `COUNT(*)`, a concurrent
   re-dispatch could add a row back to the set, holding the turn open. That is the correct
   outcome (edge case 8) and needs no lock.
3. **The blind sweep clearing rows out from under a held batch.** `clearStaleWorkingState`
   can null the last outstanding siblings of a held turn. The next legitimate clear then
   sees `remaining === 0` and broadcasts. This is acceptable — the broadcast still requires
   a genuine mtime-advance transition on some row of that turn — but it means an abandoned
   batch that is later partially resurrected can emit one notice. It cannot emit a notice
   with no completion behind it, which is the property that matters.

### Security

- No new network surface, no new HTTP verb, no user-supplied input reaches the new SQL —
  `terminalName` originates from the PTY fleet's own `friendlyName` and is bound as a
  parameter, never interpolated.

### Side Effects

4. **Single-plan dispatch.** N = 1. After the clear, zero siblings remain live, so the gate
   passes immediately and the behaviour is byte-for-byte what it is today. This must be the
   common path and must not gain latency.
5. **`dispatched_terminal` is empty.** The extension-host dispatcher does not always write
   it, and `attributePasteDispatch` writes `''` when the pane is unknown. An empty terminal
   name cannot group a batch, so the gate must **not** suppress: treat "no terminal name" as
   "one-plan turn" and broadcast immediately. Suppressing here would silence every
   extension-host completion.
6. **The agent writes plan 3 and then genuinely stops** (crashed, quota, operator killed
   it). Plans 4–6 never clear, so the batch never reaches zero live siblings and no
   completion broadcast fires. That is the correct outcome for the *completion* signal — the
   agent did not complete — and the stale-state timeout still retires the cards. The silence
   sweep (fixed here to cover all rows) also marks them blocked, which is the surface that
   reports this state.
7. **The agent re-writes an already-cleared plan file.** `clearWorkingState` returns false
   (already NULL), so no broadcast — unchanged, and the gate is never consulted.
8. **Re-dispatch mid-turn.** `updateDispatchInfoByPlanFile` overwrites `dispatched_at`, so a
   re-dispatched row rejoins the live set and legitimately holds the batch open. Correct.
9. **Two terminals working the same feature.** Rows are grouped by `dispatched_terminal`, so
   each terminal's batch completes independently. Correct.
10. **Feature rows (`is_feature = 1`).** Excluded from `getActiveDispatchedByTerminal` today
    and must stay excluded in its plural sibling and in the counter — a feature row's working
    flag is derived from its subtasks, so counting it would keep every batch permanently
    open.
11. **Sweep semantics per row.** Each row is independently `completed` (mtime advanced) or
    `blocked`. Clearing row 3 while rows 4–6 stay blocked is the accurate state and must not
    be collapsed into a single verdict for the terminal.
12. **Turn-size counter leakage.** An abandoned turn leaves an entry that never reaches the
    broadcast that would delete it. Guard with an age stamp: an entry older than `timeoutMs`
    is treated as absent and reset. The count is display-only — a wrong value costs a wrong
    number in a toast, nothing else.
13. **Payload shape is additive.** `planCount` on the `agentCompleted` payload must not break
    a webview that does not read it. The renderer must tolerate the field being absent
    (older host, or a single-plan turn that omits it). The webview subtask owns that
    tolerance.
14. **Lowering `blockedTimeoutMs` needs no migration.** `blockedTimeoutMs` was introduced in
    `1bd39f4a` (2026-08-14, HEAD) and has not existed in any prior release, so this is
    unreleased dev work and takes a clean break. Changing a `default` in `package.json`
    contributes never rewrites a user's explicit `settings.json` value — anyone who set it
    keeps their value. No key is renamed or removed, so nothing to import or archive.
15. **A user who wants the old behaviour** raises `switchboard.activityLight.blockedTimeoutMs`
    back to `14400000`. The `maximum` (86400000) already permits it; the `minimum` (600000)
    is unchanged.

### Dependencies & Conflicts

16. **Both hosts.** `bootstrap.ts` and `TaskViewerProvider` must both carry the new field, or
    the toast text differs by host — the parity trap this codebase has hit before. Computing
    `planCount` **in the engine** rather than in each broadcaster is how this plan removes
    that trap instead of testing for it.
17. **`src/webview/terminals.js` is NOT touched by this plan.** The `planCount` render, the
    solo-window guard, the pane-header chip and the toast all belong to the sibling webview
    subtask. This plan ships the field; that plan renders it. Neither blocks the other from
    landing — an unrendered field is inert, and an absent field falls through to the plain
    title.
18. **`TaskViewerProvider.broadcastAgentCompleted` is owned here**, including its missing
    `SURFACES.common` argument. `SURFACES` is already imported at `TaskViewerProvider.ts:4`,
    so the tag is a one-argument change.

## Dependencies

- None. No prior session is a prerequisite; the V57/V59 columns this plan reads already
  exist at HEAD.

## Adversarial Synthesis

**Risk Summary.** The three real risks are ordering (the sibling count must be taken *after*
the clear, or the last plan of a batch never announces), a held-forever turn (an agent that
dies mid-batch legitimately produces no notice — the blocked marking, not the completion
signal, is the surface that must report it), and the fact that this plan deliberately
narrows a four-hour "Waiting on you" window that another change shipped hours earlier.
Mitigations: the gate is a post-clear `COUNT(*)` with a held/fired log line on every
decision so the state is forensically readable; the sweep now marks **every** row of a batch
blocked rather than one; and the `blockedTimeoutMs` change is a default-only edit to a key
that has never shipped, leaving explicit user settings untouched.

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — two queries the gate needs

Add a counter for the remaining live rows in a terminal's turn, and a plural sibling of
`getActiveDispatchedByTerminal` for the sweep. Place both immediately after
`getActiveDispatchedByTerminal` (`:9821`) so the three read as a family.

```ts
    /**
     * How many plan rows are STILL live-dispatched to this terminal.
     *
     * The batch discriminator for the completion signal. One fan-out stamps every card
     * with the same `dispatched_terminal` (see updateDispatchInfoByPlanFile's call site
     * in the dispatchCards verb), so a per-row clear is a per-SUBTASK event, not a
     * per-TURN one. Callers clear the row first, then ask this: zero remaining means the
     * agent finished the turn.
     *
     * Empty `terminalName` returns 0 by design — an unattributed dispatch cannot be
     * grouped, so its single clear must be allowed to broadcast immediately.
     */
    public async countActiveDispatchedByTerminal(workspaceId: string, terminalName: string): Promise<number> {
        if (!(await this.ensureReady()) || !this._db || !workspaceId || !terminalName) return 0;
        const stmt = this._db.prepare(
            `SELECT COUNT(*) AS n FROM plans
             WHERE workspace_id = ? AND status = 'active' AND is_feature = 0
               AND dispatched_terminal = ? AND dispatched_at IS NOT NULL`,
            [workspaceId, terminalName]
        );
        try {
            const rows = this._readRows(stmt);
            return Number((rows[0] as any)?.n ?? 0);
        } finally {
            stmt.free();
        }
    }

    /**
     * Every live-dispatched plan row for a terminal, newest first.
     *
     * The plural of getActiveDispatchedByTerminal, which carries `LIMIT 1` and is
     * correct only for a single-plan turn. The turn-end silence sweep must test EVERY
     * plan the terminal is holding — with LIMIT 1 it stat'ed one file and left the rest
     * of a batch to the stale-state abandonment timeout, which deliberately does not
     * broadcast.
     */
    public async getActiveDispatchedRowsByTerminal(
        workspaceId: string,
        terminalName: string,
        limit = 50
    ): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db || !workspaceId || !terminalName) return [];
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND status = 'active' AND is_feature = 0
               AND dispatched_terminal = ? AND dispatched_at IS NOT NULL
             ORDER BY dispatched_at DESC LIMIT ?`,
            [workspaceId, terminalName, limit]
        );
        try {
            return this._readRows(stmt);
        } finally {
            stmt.free();
        }
    }
```

**`_readRows` returns `KanbanPlanRecord[]`.** For `countActiveDispatchedByTerminal` that is
the wrong shape for a `COUNT(*)` projection — confirm at implementation time whether
`_readRows` maps columns positionally or by name, and if it cannot carry a bare `n`, use the
raw `stmt.step()` / `stmt.getAsObject()` idiom used by `getLiveDispatchAttribution`
(`:9895`) instead. Do not ship a count that silently reads `0`.

**Also in this file:** correct `setBlockedState`'s doc comment (`:9791`). It says
*"CURRENTLY UNCALLED"*; it has had exactly one caller since `1bd39f4a` — the turn-end
silence sweep at `PlanIngestionEngine.ts:369`. Say so, and say that the verdict is
silence-derived (not hook-derived), because the retention decision below depends on that
distinction being visible to the next reader.

### 2. `src/services/PlanIngestionEngine.ts` — broadcast on the turn boundary, not the row

**2a. The turn-size counter.** Add private state and two small helpers near
`_onWorkingStateCleared` (`:142`).

```ts
    /**
     * Per-terminal turn size, for the completion notice's "+N more".
     *
     * Captured on the FIRST clear of a turn (remaining-after-clear + 1 == the full
     * batch, because no sibling has cleared yet) and consumed by the broadcast that
     * closes the turn. Display-only: a wrong value costs a wrong number in a toast.
     *
     * Deliberately NOT a SQL query. `clearWorkingState` nulls dispatched_at but leaves
     * dispatched_terminal set, so there is no post-hoc SQL predicate that separates
     * "rows from THIS turn" from "every row ever dispatched to a seat named coder-1",
     * and `updated_at` is not a usable anchor either — the sweep's clear path never
     * touches it.
     *
     * An abandoned turn never reaches the broadcast that deletes its entry, so entries
     * carry a timestamp and an entry older than the activity-light timeout is treated
     * as absent. Without that, one dead batch inflates every later turn on that seat.
     */
    private _turnSizes = new Map<string, { size: number; at: number }>();

    private _noteTurnClear(wsId: string, terminalName: string, remainingAfter: number, timeoutMs: number): void {
        if (!terminalName) { return; }
        const key = `${wsId}|${terminalName}`;
        const prev = this._turnSizes.get(key);
        const stale = !prev || (Date.now() - prev.at) > timeoutMs;
        const observed = remainingAfter + 1;
        if (stale || observed > prev!.size) {
            this._turnSizes.set(key, { size: observed, at: Date.now() });
        }
    }

    private _takeTurnSize(wsId: string, terminalName: string): number {
        if (!terminalName) { return 1; }
        const key = `${wsId}|${terminalName}`;
        const entry = this._turnSizes.get(key);
        this._turnSizes.delete(key);
        return Math.max(1, entry?.size ?? 1);
    }
```

> **Superseded:** *"`countTurnPlansByTerminal(workspaceId, terminalName, dispatchedAtIso)` is
> a third small query in `KanbanDatabase`: count active, non-feature rows for the terminal
> whose `dispatched_at` is NULL (already cleared) **and** whose `updated_at` is at or after
> the turn's dispatch stamp" — called independently from inside `bootstrap.ts` and
> `TaskViewerProvider.ts`.*
> **Reason:** Three defects. (a) It is duplicated in both broadcasters, which is precisely the
> host-parity trap this plan's own edge-case list flags. (b) Its `updated_at` anchor does not
> hold on the sweep path: `clearWorkingState` (`KanbanDatabase.ts:9763`) writes only
> `dispatched_at`, `last_liveness_at` and `blocked_at`, so a row cleared by the silence sweep
> never bumps `updated_at` and would be missed by the count. (c) It adds a third query to a
> loop this plan is already making more expensive.
> **Replaced with:** The engine — the one site both hosts inherit from — captures the turn
> size in memory at the first clear and hands it to the callback. No new SQL, no
> `updated_at` dependence, no per-host duplication.

**2b. The callback signature.** Widen it additively so both hosts inherit the count:

```ts
    private _onWorkingStateCleared?: (
        record: KanbanPlanRecord,
        workspaceRoot: string,
        meta?: { planCount: number }
    ) => void;
```

Existing callers ignoring the third argument keep compiling; this is the whole migration.
There is deliberately **no `reason` field** — see the superseded callout in the Goal: both
broadcasting clear sites carry the same evidence (a plan-file mtime advance), so a reason
code would have exactly one value.

**2c. `_processPlanFile` (`:985-1005`) — gate on the batch being empty.** The clear stays
exactly where it is; the card's own light must still go out when its plan file lands.

```ts
                if (updatedRecord.dispatchedAt) {
                    try {
                        const transitioned = await db.clearWorkingState(relativePath, workspaceId);
                        const clearedRecord = { ...updatedRecord };
                        updatedRecord.dispatchedAt = null;
                        this._host.logger.appendLine(
                            `[GlobalPlanWatcher] Plan file edit cleared working state for: ${relativePath}` +
                            (transitioned ? '' : ' (already cleared — broadcast suppressed)')
                        );
                        if (transitioned && this._onWorkingStateCleared) {
                            // The CARD is done; the AGENT may not be. One dispatch stamps
                            // every card in the batch with the same dispatched_terminal, so
                            // a per-row transition fired N completion notices per turn — the
                            // first of them minutes before any real work was finished.
                            // Counted AFTER the clear, so this row is already excluded.
                            // An empty terminal name returns 0 and broadcasts immediately:
                            // an unattributed dispatch cannot be grouped, and suppressing it
                            // would silence every extension-host completion.
                            const terminalName = (clearedRecord.dispatchedTerminal || '').trim();
                            const remaining = terminalName
                                ? await db.countActiveDispatchedByTerminal(workspaceId, terminalName)
                                : 0;
                            this._noteTurnClear(workspaceId, terminalName, remaining, timeoutMs);
                            if (remaining > 0) {
                                this._host.logger.appendLine(
                                    `[GlobalPlanWatcher] Turn still open for ${terminalName}: ` +
                                    `${remaining} plan(s) outstanding — completion broadcast held`
                                );
                            } else {
                                const planCount = this._takeTurnSize(workspaceId, terminalName);
                                try {
                                    this._onWorkingStateCleared(clearedRecord, workspaceRoot, { planCount });
                                } catch (cbErr) {
                                    this._host.logger.appendLine(`[GlobalPlanWatcher] onWorkingStateCleared callback failed: ${cbErr}`);
                                }
                            }
                        }
                    } catch (clearErr) { /* unchanged */ }
                }
```

`timeoutMs` is read from `activityLight` config in the periodic sweep but not in
`_processPlanFile`. Read it here too (same `this._host.getConfig('activityLight').getNumber('timeoutMs', 600000)`
call) or hoist it — it is only the counter's staleness bound, so a hard-coded fallback is
acceptable if the config read is awkward at that point in the file.

**2d. The silence sweep (`:340-378`) — every row, and re-test a blocked row.**

```ts
                                for (const terminalName of silentTerminals) {
                                    // Was getActiveDispatchedByTerminal (LIMIT 1): a batch
                                    // dispatch holds N rows on one terminal and the sweep
                                    // tested exactly one of them, leaving the rest to the
                                    // stale-state abandonment timeout, which does not
                                    // broadcast. Bounded and logged when truncated —
                                    // a silent cap reads as "swept everything".
                                    const SWEEP_ROW_CAP = 50;
                                    const rows = await db.getActiveDispatchedRowsByTerminal(wsId, terminalName, SWEEP_ROW_CAP);
                                    if (rows.length === SWEEP_ROW_CAP) {
                                        this._host.logger.appendLine(
                                            `[GlobalPlanWatcher] Silence sweep for ${terminalName} capped at ${SWEEP_ROW_CAP} rows`
                                        );
                                    }
                                    let clearedAny = false;
                                    let lastCleared: KanbanPlanRecord | null = null;
                                    for (const record of rows) {
                                        if (!record.planFile || !record.dispatchedAt) continue;
                                        const wtRow = worktrees.find(w => w.id === record.worktreeId);
                                        const planRoot = wtRow ? wtRow.path : folder;
                                        let completed = false;
                                        try {
                                            const stat = await fs.promises.stat(path.join(planRoot, record.planFile));
                                            completed = stat.mtimeMs > Date.parse(record.dispatchedAt);
                                        } catch { /* missing file is no evidence of completion */ }
                                        if (completed) {
                                            const transitioned = await db.clearWorkingState(record.planFile, wsId);
                                            this._host.logger.appendLine(
                                                `[GlobalPlanWatcher] Turn-end (plan file mtime advance) for ${terminalName}: ${record.planFile}` +
                                                (transitioned ? '' : ' (already cleared)')
                                            );
                                            if (transitioned) { clearedAny = true; lastCleared = record; }
                                        } else if (!record.blockedAt) {
                                            await db.setBlockedState(record.planFile, wsId, livenessIso);
                                            this._host.logger.appendLine(
                                                `[GlobalPlanWatcher] Turn-end (silence) marked blocked for ${terminalName}: ${record.planFile}`
                                            );
                                        }
                                    }
                                    // One notice per TURN. Fired only once every row this
                                    // terminal was holding has cleared — the same gate the
                                    // plan-file-edit path uses, so the two clearers cannot
                                    // disagree about what "done" means.
                                    if (clearedAny && lastCleared && this._onWorkingStateCleared) {
                                        const remaining = await db.countActiveDispatchedByTerminal(wsId, terminalName);
                                        this._noteTurnClear(wsId, terminalName, remaining, timeoutMs);
                                        if (remaining === 0) {
                                            const planCount = this._takeTurnSize(wsId, terminalName);
                                            try { this._onWorkingStateCleared(lastCleared, folder, { planCount }); }
                                            catch (cbErr) {
                                                this._host.logger.appendLine(`[GlobalPlanWatcher] onWorkingStateCleared callback failed: ${cbErr}`);
                                            }
                                        }
                                    }
                                }
```

Note the `else if (!record.blockedAt)` branch: the mtime test above it now runs on **every**
tick for **every** row, including already-blocked ones — only the redundant `setBlockedState`
write is skipped. Before this change the sweep re-tested nothing once a row was blocked, so
a plan file written by a process that produces no terminal output (a background write, a
headless agent) could leave the row blocked until the retention expired. Keep the guard on
the *write*, never on the *test*.

**2e. Sweep log line.** The existing summary at `:381-386` reports
`(liveness: recorded=…, forced=…)`. Add `silent=${silentTerminals.length}`. When a card goes
dark or goes blocked and the user asks why, this log is the only forensic trail.

### 3. `src/standalone/bootstrap.ts` — forward the count, fix the stale comment

`broadcastAgentCompletedForRecord` (`:459`) already tags `SURFACES.common` (`:490`). Take the
meta argument and add one field:

```ts
    const broadcastAgentCompletedForRecord = (record: any, meta?: { planCount?: number }) => {
        …
            server.broadcastWs('agentCompleted', {
                planFile: record.planFile,
                planTitle: record.topic,
                role: record.dispatchedAgent,
                worktreePath: worktreePath || undefined,
                terminalName: terminalName || undefined,
                planCount: meta?.planCount,
            }, SURFACES.common);
    };
    ingestionEngine.setOnWorkingStateCleared((record, _wsRoot, meta) => {
        broadcastAgentCompletedForRecord(record, meta);
    });
```

Correct the comment at `:451-455`. It says the push "Fires ONLY from the plan-file-edit clear
site in PlanIngestionEngine — never from the stale-state timeout sweep". Since `1bd39f4a`
there are two broadcasting clear sites; the accurate statement is that it fires from either
clear site **on plan-file mtime evidence**, and never from the blind stale-state sweep, which
is abandonment rather than completion. Add that the engine gates both on the terminal's whole
batch clearing.

### 4. `src/services/TaskViewerProvider.ts` — the count, the surface tag, the stale comment

`broadcastAgentCompleted` (`:1047`) ships its frame **untagged** (`:1073-1079`) while the
standalone half tags `SURFACES.common`. An untagged frame is delivered to every connection
regardless of declared surfaces — a parity gap, fixed here.

```ts
    public broadcastAgentCompleted(record: KanbanPlanRecord, workspaceRoot: string, meta?: { planCount?: number }): void {
        …
            server.broadcastWs('agentCompleted', {
                planFile: record.planFile,
                planTitle: record.topic,
                role: record.dispatchedAgent,
                worktreePath: worktreePath || undefined,
                terminalName: terminalName || undefined,
                planCount: meta?.planCount,
-            });
+            }, SURFACES.common);
    }
```

`SURFACES` is already imported at `TaskViewerProvider.ts:4` — no new import. `PANEL_SURFACES`
(`src/services/wsHub.ts:70-77`) maps `terminals` to `['terminals', 'common']`, so the Terminals
panel still receives the frame after tagging. A panel with no `PANEL_SURFACES` entry sends no
`surfaces` parameter and receives the full stream, so it is unaffected either way.

The doc comment at `:1036-1046` claims it "Mirrors the standalone bootstrap wiring verbatim"
— it did not (that is the bug above) and it repeats the same stale "never from the
stale-state timeout sweep" claim. Update it so the claim is true, or the next reader will
trust it over the code again.

Update the wiring at `src/extension.ts:1070`:

```ts
    globalPlanWatcher.getEngine().setOnWorkingStateCleared((record, wsRoot, meta) => {
        taskViewerProvider.broadcastAgentCompleted(record, wsRoot, meta);
    });
```

### 5. `package.json` — a silence-derived verdict does not get a human-wait retention

```jsonc
        "switchboard.activityLight.blockedTimeoutMs": {
          "type": "integer",
-         "default": 14400000,
+         "default": 1800000,
          "minimum": 600000,
          "maximum": 86400000,
-         "description": "How long (ms) a card stays visibly 'Waiting on you' after the agent goes quiet without a plan-file change. Default 4 hours. This is a wait on a human, not a machine, so it is deliberately much longer than timeoutMs. …"
+         "description": "How long (ms) a card stays visibly 'Waiting on you' after the agent goes quiet without a plan-file change. Default 30 minutes. The verdict is derived from output silence alone, which cannot tell 'the agent asked you a question' from 'the agent died' or 'the agent finished without writing its plan file' — so this is a bounded guess, not a confirmed wait on a human. A real human wait resolves itself long before this: answering the prompt produces output, and the next liveness tick (~10s) nulls the blocked stamp. Raise it toward the 24h maximum if you prefer the card to stay lit while you are away from the desk."
        },
```

Leave `timeoutMs`, `livenessWindowMs` and `turnEndSilenceMs` untouched.

**Explicitly out of scope:** renaming the "Waiting on you" badge in `src/webview/kanban.html`
(`:7754`). The label is arguably still over-claiming for a silence-derived verdict, but
bounding the window to 30 minutes removes the harm, and editing `kanban.html` would open a
third webview file to contention for a copy change. If the label still reads wrong after
this ships, that is its own one-line plan.

## Verification Plan

### Automated Tests

*(Not executed in this planning session — the dispatching prompt carried SKIP TESTS and SKIP
COMPILATION. The coder runs them.)*

1. **Unit — batch gate holds.** Seed three plan rows sharing one `dispatched_terminal`, all
   with `dispatched_at` set. Clear row 1; assert `countActiveDispatchedByTerminal` returns 2
   and no callback fired. Clear rows 2 and 3; assert the callback fired exactly once, on the
   third clear, with `planCount === 3`.
2. **Unit — single-plan turn.** One row. Assert the callback fires on the first clear with
   `planCount === 1`.
3. **Unit — empty terminal name.** A row with `dispatched_terminal = ''`. Assert the callback
   fires immediately (count query is skipped, `remaining` is 0).
4. **Unit — feature rows excluded.** Add an `is_feature = 1` row with the same terminal.
   Assert it is not counted and does not hold the batch open.
5. **Unit — sweep covers every row.** Three rows on one silent terminal, all three plan files
   mtime-advanced. Assert three clears and exactly one callback.
6. **Unit — sweep re-tests a blocked row.** Row already carrying `blocked_at`; advance its
   plan-file mtime; run the sweep. Assert it clears (the mtime test is no longer skipped) and
   that `setBlockedState` was not re-written for it on the prior tick.
7. **Unit — turn-size staleness.** Note a turn clear, advance the clock past `timeoutMs`,
   note a new clear on the same terminal. Assert the second turn's size is the newly observed
   value, not the leaked one.
8. **Unit — sweep cap logs.** Lower `SWEEP_ROW_CAP`, seed more rows, assert the truncation
   line is emitted.
9. **SQL validated directly against `sqlite3`** before it ships — the shared-column-name trap
   in this table has caused a prepare-time failure before (see `getActiveDispatchedByCwd`'s
   comment at `KanbanDatabase.ts:9855`).
10. `npm run compile-tests` clean.

### Manual

11. **The reported repro — feature dispatch.** Create a feature with six subtasks, dispatch
    the whole feature to one coder. Watch the output channel. Expect five
    `Turn still open for <terminal>: N plan(s) outstanding — completion broadcast held` lines
    and exactly **one** completion broadcast, after the sixth plan file is written.
12. **Batch plan review.** Drag four plans onto a reviewer in one drop. Confirm the first
    plan's Review Findings write produces a held line, not a broadcast.
13. **Unattributed dispatch.** Dispatch from the extension host in a configuration where
    `dispatched_terminal` is written empty. Confirm the completion still broadcasts
    immediately — this is the regression the empty-name branch exists to prevent.
14. **Abandoned batch.** Dispatch three plans, let the agent write one, then kill the
    terminal. Expect: no completion broadcast; the remaining two marked blocked by the
    silence sweep; the cards retired by the stale sweep with no broadcast.
15. **Stuck light is bounded.** Dispatch a plan to a Claude Code seat, let the agent finish
    and go silent WITHOUT writing its plan file. Confirm the card goes blocked
    ("Waiting on you") within ~90 s and **clears within 30 minutes**, not four hours. Confirm
    it never moved columns.
16. **A real human wait is not truncated.** Dispatch work that stops on a permission prompt.
    Confirm the card goes blocked, then answer the prompt. Confirm output resumes and the
    blocked stamp is nulled on the next tick, well inside the 30-minute window.
17. **Host parity.** Run steps 11 and 13 under both the standalone host and the VS Code
    extension host. Expect identical log lines and identical payloads.
18. **No double-fire.** Write a plan file while the silence-sweep tick is running. Confirm
    exactly one broadcast — the `clearWorkingState` transition gate and the batch gate must
    compose, not cancel.
19. **Frame is tagged.** Confirm via the WS frame log that the extension-host `agentCompleted`
    frame now carries `surface: 'common'` rather than arriving untagged, and that the
    Terminals panel still receives it.

---

**Recommendation:** Complexity 7 → **Send to Lead Coder.**

## Implementation Summary

Implemented batch-aware turn-end completion signals and falsifiable silence retention. Added `countActiveDispatchedByTerminal` and `getActiveDispatchedRowsByTerminal` queries in [`KanbanDatabase.ts`](file:///home/patrick/switchboard/src/services/KanbanDatabase.ts) to track outstanding active rows for a dispatched terminal. In [`LocalApiServer.ts`](file:///home/patrick/switchboard/src/services/LocalApiServer.ts) and [`PlanIngestionEngine.ts`](file:///home/patrick/switchboard/src/services/PlanIngestionEngine.ts), wired batch gating (`countActiveDispatchedByTerminal`, `_noteTurnClear`, `_takeTurnSize`) so completion broadcasts fire only on turn boundaries with populated `planCount`. Fixed silence sweep in `PlanIngestionEngine.ts` to iterate all rows via `getActiveDispatchedRowsByTerminal` and updated `blockedTimeoutMs` code fallback to 1800000ms. Updated [`bootstrap.ts`](file:///home/patrick/switchboard/src/standalone/bootstrap.ts), [`TaskViewerProvider.ts`](file:///home/patrick/switchboard/src/services/TaskViewerProvider.ts), and [`extension.ts`](file:///home/patrick/switchboard/src/extension.ts) to forward `planCount` and tag WS `agentCompleted` broadcasts with `SURFACES.common`. Adjusted `switchboard.activityLight.blockedTimeoutMs` default in `package.json` to 30 minutes.
