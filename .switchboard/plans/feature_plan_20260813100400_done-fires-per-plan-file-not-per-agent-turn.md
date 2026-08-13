# "Done" Fires Once Per Plan File, So a Feature or Batch Dispatch Reports Complete While the Agent Is Still Working

## Goal

Make the completion signal mean **"this agent finished its turn"** rather than **"one of
the plan files this agent was given has been written"**. After this change, a coder handed
six subtasks of a feature reports done once — when the last of the six is written — instead
of six times, the first of them arriving minutes before any real work is finished.

### The problem

Dispatch a feature (or drag several cards onto one agent) and the agent receives one prompt
covering N plans. It works through them, writing each plan file as it finishes that
subtask. The board and the Terminals panel announce completion the moment the **first** plan
file is touched, then again for the second, and so on. In a batch plan review — where the
reviewer's first act on each plan is to append a Review Findings section — the very first
notice can arrive within a minute of dispatch, while five of six plans have not been looked
at.

The operator's read of "done" is therefore wrong in both directions: it fires early (the
agent is still working) and it fires repeatedly (one turn, N notices).

### Root cause

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

`updateDispatchInfoByPlanFile` sets `dispatched_at = now` on each row. So after one
dispatch, N rows share one `dispatched_terminal` and one turn.

*The completion side, path 1 — plan-file edit.* `PlanIngestionEngine._processPlanFile`
runs per changed file and clears that file's row:

```ts
if (updatedRecord.dispatchedAt) {
    const transitioned = await db.clearWorkingState(relativePath, workspaceId);
    …
    if (transitioned && this._onWorkingStateCleared) {
        this._onWorkingStateCleared(clearedRecord, workspaceRoot);
    }
}
```

`clearWorkingState` returns true on a real non-NULL→NULL transition, which correctly
suppresses a *double* broadcast for the *same row*. It has no idea the row has N−1 siblings
in the same turn. Each sibling's own first write produces its own `transitioned === true`
and its own broadcast. **N broadcasts per turn, the first of them early.**

*The completion side, path 2 — the silence sweep.* The turn-end-by-silence branch of
`PlanIngestionEngine`'s poll resolves the terminal's plan with:

```ts
const record = await db.getActiveDispatchedByTerminal(wsId, terminalName);
```

and that query is:

```sql
SELECT … FROM plans
 WHERE workspace_id = ? AND status = 'active' AND is_feature = 0
   AND dispatched_terminal = ? AND dispatched_at IS NOT NULL
 ORDER BY dispatched_at DESC LIMIT 1
```

`LIMIT 1`. For a batch, the sweep tests exactly one of the N plan files' mtimes and either
clears that one or marks it blocked. The other N−1 rows are invisible to the sweep and are
left to the 20-minute stale-state timeout, which is an *abandonment* path and deliberately
does **not** broadcast. So the sweep both under-reports (N−1 rows never turn-end properly)
and mis-attributes (the one row it picks is whichever was dispatched last, not whichever the
agent is actually on).

### Background context

- Completion is intentionally derived from **plan-file mtime advance**, not from a hook or
  a marker string — that basis is correct and this plan does not change it.
- The per-card activity light going out as each plan file is written is also correct: that
  card really is finished. What is wrong is treating a per-card transition as a per-agent
  notification.
- `clearWorkingState`'s transition gate exists to stop two concurrent clearers double-firing
  for one row. It is necessary and stays; it is simply the wrong granularity for "the agent
  finished".
- Both hosts consume `_onWorkingStateCleared`: `bootstrap.ts` (`setOnWorkingStateCleared`)
  and `TaskViewerProvider.broadcastAgentCompleted`. Gating must live where both inherit it —
  in the engine, not in each broadcaster.

## Metadata

- **Complexity:** 6
- **Tags:** backend, database, bugfix, reliability
- **Project:** Browser Switchboard

## Complexity Audit

**Complex.** Not large, but it changes the meaning of a signal two hosts and three UI
surfaces already consume, and it touches the plan-watcher poll — the most timing-sensitive
loop in the system.

- The gate must be evaluated **after** the row is cleared, so the "any siblings left?" query
  sees the post-clear state. Getting the order wrong makes the last plan of a batch never
  broadcast at all — a silent regression that looks like the feature working.
- The silence sweep's `LIMIT 1` removal changes the sweep from O(1) to O(rows-for-terminal)
  `stat` calls per silent terminal per tick. Bounded in practice (a batch is single digits)
  but it belongs in the audit.
- No schema change and no migration: `dispatched_terminal` (V57) and the liveness columns
  (V59) already carry everything needed. This is query and gating work only.

## Edge-Case & Dependency Audit

1. **Single-plan dispatch.** N = 1. After the clear, zero siblings remain live, so the gate
   passes immediately and the behaviour is byte-for-byte what it is today. This must be the
   common path and must not gain latency.

2. **`dispatched_terminal` is empty.** The extension-host dispatcher does not always write
   it, and `attributePasteDispatch` writes `''` when the pane is unknown. An empty terminal
   name cannot group a batch, so the gate must **not** suppress: treat "no terminal name" as
   "one-plan turn" and broadcast immediately. Suppressing here would silence every
   extension-host completion.

3. **The agent writes plan 3 and then genuinely stops** (crashed, quota, operator killed
   it). Plans 4–6 never clear, so the batch never reaches zero live siblings and no
   completion broadcast fires. That is the correct outcome for the *completion* signal — the
   agent did not complete — and the existing 20-minute `clearStaleWorkingState` timeout still
   retires the cards. The silence sweep (fixed in this plan to cover all rows) also marks
   them blocked, which is the surface that reports this state.

4. **The agent re-writes an already-cleared plan file.** `clearWorkingState` returns false
   (already NULL), so no broadcast — unchanged, and the gate is never consulted.

5. **Two terminals working the same feature.** Rows are grouped by `dispatched_terminal`, so
   each terminal's batch completes independently. Correct.

6. **Re-dispatch mid-turn.** `updateDispatchInfoByPlanFile` overwrites `dispatched_at`, so a
   re-dispatched row rejoins the live set and legitimately holds the batch open. Correct.

7. **Feature rows (`is_feature = 1`).** Excluded from `getActiveDispatchedByTerminal` today
   and must stay excluded — a feature row's working flag is derived from its subtasks, so
   counting it would keep every batch permanently open.

8. **Silence sweep cost.** With `LIMIT 1` removed, a silent terminal costs one `stat` per
   live dispatched row per 10 s tick. Cap the fan-out defensively (e.g. 50 rows) and log
   when the cap truncates — a silent truncation would read as "swept everything".

9. **Sweep semantics per row.** Each row is independently `completed` (mtime advanced) or
   `blocked`. Clearing row 3 while rows 4–6 stay blocked is the accurate state and must not
   be collapsed into a single verdict for the terminal.

10. **Payload shape is additive.** Adding `planCount` to the `agentCompleted` payload must
    not break a webview that does not read it. The toast renderer must tolerate the field
    being absent (older host, or a single-plan turn that omits it).

11. **Both hosts.** `bootstrap.ts` and `TaskViewerProvider` must both carry the new field, or
    the toast text differs by host — the parity trap this codebase has hit before.

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — two queries the gate needs

Add a counter for the remaining live rows in a terminal's turn, and a plural sibling of
`getActiveDispatchedByTerminal` for the sweep.

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
     * of a batch to the 20-minute abandonment timeout, which deliberately does not
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

### 2. `src/services/PlanIngestionEngine.ts` — broadcast on the turn boundary, not the row

In `_processPlanFile`, gate the callback on the batch being empty. The clear stays exactly
where it is — the card's own light must still go out when its plan file lands.

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
                            if (remaining > 0) {
                                this._host.logger.appendLine(
                                    `[GlobalPlanWatcher] Turn still open for ${terminalName}: ` +
                                    `${remaining} plan(s) outstanding — completion broadcast held`
                                );
                            } else {
                                try {
                                    this._onWorkingStateCleared(clearedRecord, workspaceRoot);
                                } catch (cbErr) {
                                    this._host.logger.appendLine(`[GlobalPlanWatcher] onWorkingStateCleared callback failed: ${cbErr}`);
                                }
                            }
                        }
                    } catch (clearErr) { /* unchanged */ }
                }
```

In the silence sweep, replace the single-row lookup with the plural one and apply the same
turn gate.

```ts
                                for (const terminalName of silentTerminals) {
                                    // Was getActiveDispatchedByTerminal (LIMIT 1): a batch
                                    // dispatch holds N rows on one terminal and the sweep
                                    // tested exactly one of them, leaving the rest to the
                                    // 20-minute abandonment timeout, which does not
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
                                        if (remaining === 0) {
                                            try { this._onWorkingStateCleared(lastCleared, folder); }
                                            catch (cbErr) {
                                                this._host.logger.appendLine(`[GlobalPlanWatcher] onWorkingStateCleared callback failed: ${cbErr}`);
                                            }
                                        }
                                    }
                                }
```

### 3. Both broadcasters — carry the batch size so the notice can say what finished

`src/standalone/bootstrap.ts`, inside `broadcastAgentCompletedForRecord`, and
`src/services/TaskViewerProvider.ts`, inside `broadcastAgentCompleted`: resolve how many
plans this terminal's turn covered and ship it. Both already compute `terminalName` just
above; add one query and one field.

```ts
            // How many plans this turn covered. The engine only calls us when the LAST
            // row cleared, so this is a completed count, not a progress count. Resolved
            // from the plans that share this turn's dispatched_terminal and dispatched_at
            // window; 1 when unattributed.
            let planCount = 1;
            if (terminalName) {
                try { planCount = Math.max(1, await db.countTurnPlansByTerminal(wsId, terminalName, record.dispatchedAt)); }
                catch { /* best-effort — the notice still names the plan */ }
            }
            server.broadcastWs('agentCompleted', {
                planFile: record.planFile,
                planTitle: record.topic,
                role: record.dispatchedAgent,
                worktreePath: worktreePath || undefined,
                terminalName: terminalName || undefined,
                planCount,
            }, SURFACES.common);
```

`countTurnPlansByTerminal(workspaceId, terminalName, dispatchedAtIso)` is a third small
query in `KanbanDatabase`: count active, non-feature rows for the terminal whose
`dispatched_at` is NULL (already cleared) **and** whose `updated_at` is at or after the
turn's dispatch stamp. It is a display number only — if it resolves wrong, the toast says
"1 plan" and nothing else breaks.

### 4. `src/webview/terminals.js` — say how many plans finished

`handleAgentCompleted` already forwards to `showCompletionToast(planTitle, role, termName)`.
Thread the count through and render it, tolerating its absence.

```js
        showCompletionToast(planTitle || 'Agent Task', role || 'Agent', targetTerm, msg.planCount);
```

```js
    function showCompletionToast(title, role, termName, planCount) {
        …
        const bodyEl = document.createElement('div');
        bodyEl.className = 'toast-body';
        // planCount is additive on the wire — an older host omits it, and a single-plan
        // turn is the common case, so both fall through to the plain title.
        const n = Number(planCount);
        const scope = Number.isFinite(n) && n > 1 ? `${title} +${n - 1} more` : title;
        bodyEl.textContent = scope + (termName ? ` (${termName})` : '');
        …
    }
```

## Verification Plan

1. **The reported repro — feature dispatch.** Create a feature with six subtasks, dispatch
   the whole feature to one coder. Watch the extension output channel. Expect five
   `Turn still open for <terminal>: N plan(s) outstanding — completion broadcast held` lines
   and exactly **one** completion broadcast, after the sixth plan file is written.
2. **Batch plan review.** Drag four plans onto a reviewer in one drop. Confirm the first
   plan's Review Findings write produces a held line, not a toast.
3. **Single-plan dispatch is unchanged.** Dispatch one plan. Expect one broadcast, fired on
   the same event as today, with no added latency (the count query runs once and returns 0).
4. **Unattributed dispatch.** Dispatch from the extension host in a configuration where
   `dispatched_terminal` is written empty. Confirm the completion still broadcasts
   immediately — this is the regression the empty-name branch exists to prevent, and it
   would otherwise silence every extension-host completion.
5. **Abandoned batch.** Dispatch three plans, let the agent write one, then kill the
   terminal. Expect: no completion broadcast; the remaining two marked blocked by the
   silence sweep; the cards retired by the 20-minute stale sweep with no toast.
6. **Silence sweep coverage.** Dispatch three plans to one terminal, let the agent write all
   three but produce no further output. Wait past `turnEndSilenceMs`. Expect three
   `Turn-end (plan file mtime advance)` lines (one per plan) and one broadcast — before this
   change there was one line and, for a batch, no broadcast at all.
7. **Sweep cap.** Temporarily lower `SWEEP_ROW_CAP` to 2, dispatch three plans, and confirm
   the truncation line appears in the log. Restore the cap.
8. **Toast text.** Confirm a six-plan turn renders `<first plan title> +5 more (coder-1)`
   and a one-plan turn renders exactly what it does today.
9. **Host parity.** Run steps 1 and 3 under both the standalone host and the VS Code
   extension host. Expect identical log lines and identical toast text.
10. **No double-fire.** With two clearers racing (write a plan file while the silence sweep
    tick is running), confirm exactly one broadcast — the `clearWorkingState` transition
    gate plus the batch gate must compose, not cancel.
11. `npm run compile-tests` clean; the new SQL validated directly against `sqlite3` before
    it ships (the shared-column-name trap in this table has bitten a prepare-time failure
    before).
