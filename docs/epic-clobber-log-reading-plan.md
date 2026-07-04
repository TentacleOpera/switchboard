# Plan: Reading the `is_epic` Clobber Diagnostic Log

**Companion to:** `docs/investigation-epic-is_epic-clobber.md` (the root-cause analysis)
**Purpose:** One repro run writes one file. This doc tells whoever reads that file afterward
(human or agent) how to turn it into a verdict on *which* clobber candidate is real, and which
fix to apply.

---

## 0. Before you read — how to produce the file

1. Build/install the VSIX from this branch (`claude/epic-investigation-doc-m9n80g`) so the probes
   are live. (Reminder from CLAUDE.md: testing is via an installed VSIX, never the repo `dist/`.)
2. In the target workspace, do the repro **once**: select some plans → **GROUP INTO EPIC**.
3. Wait ~30 seconds so any watcher/scan events settle. You do **not** need to wait for the
   ~15-minute self-heal — the clobber happens at creation time and is captured immediately.
4. Collect the file:

   ```
   <workspaceRoot>/.switchboard/epic-clobber-diagnostic.txt
   ```

   That single file contains everything below. Hand it (plus this doc and the investigation doc)
   to the examining agent. No Dev Tools / output-channel scraping required — the probes mirror
   themselves into this file.

> If the file does **not** exist after the repro: the probes never fired. Most likely the
> installed VSIX predates this branch, or the workspace has no `.switchboard/` write access.
> Confirm the build before drawing any conclusion — an absent file is not evidence.

---

## 1. Line types you will see

Every line is `[ISO-timestamp] <body>`. There are four bodies:

| Prefix | Emitted by | Meaning |
|--------|-----------|---------|
| `createEpicFromPlanIds DB-instance check: provider=… watcher=… sameInstance=<bool>` | `KanbanProvider.createEpicFromPlanIds` | Fires once per epic creation. The decisive candidate-❷ test. |
| `persist instance=… epics=[ … ]` | `KanbanDatabase._persist` | Fires on **every** flush-to-disk. Shows the is_epic state this instance is about to write. |
| `reload instance=… epics=[ … ]` | `KanbanDatabase._reloadIfStale` | Fires when an instance reloads after an external mtime bump. Shows what it just read from disk. |
| `EPIC-CLOBBER instance=… updateEpicStatus(…) on epic "…"` + stack | `KanbanDatabase.updateEpicStatus` | Fires only when a live epic (is_epic=1) is about to be explicitly demoted to 0. The smoking gun for candidates ❶/❸/❺. |

`instance=#N(kanban.db)` is the per-object tag. **Two different `#N` for the same `kanban.db`
means two in-memory sql.js instances exist for one file** — the precondition for candidate ❷.

The `epics=[ … ]` payload lists each `.switchboard/epics/` row as
`<plan_file>=is_epic:<0|1>,epic_id:<value>`.

---

## 2. Decision tree — read the file top to bottom

Anchor on the epic's `plan_file` (the `<slug>-<uuid>.md` created by the repro). Trace its
`is_epic` value across the timeline.

### Q1 — Is there an `EPIC-CLOBBER` line for the epic's plan_file?

- **YES → verdict: EXPLICIT DEMOTION (candidate ❶ / ❸ / ❺).**
  Read the attached stack trace; the top app frame names the caller:
  - `createEpicFromPlanIds` subtask loop → **❶** (a subtask's `planId`/`sessionId` resolved to the epic's row).
  - `addSubtaskToEpic` / `removeSubtaskFromEpic` (PlanningPanelProvider) → **❸**.
  - `RemoteControlService` / `ClickUpSyncService` / `LinearSyncService` → **❺** (should be ruled out —
    if this appears, sync was actually enabled; revisit that assumption).
  - **Fix:** Step 2 of the investigation doc — the structural guard in `updateEpicStatus` refusing to
    clear `is_epic` for a `.switchboard/epics/` file. Then also fix the specific caller's planId resolution.
  - Note the `instance=` on the clobber line and cross-check Q3 — a demotion run against a *stale*
    instance is ❶/❸ **and** ❷ compounded.

- **NO → go to Q2.** (The `is_epic=0` arrived without any explicit demotion call — a lost write.)

### Q2 — On the `DB-instance check` line, what is `sameInstance`?

- **`sameInstance=false` → verdict: SPLIT INSTANCES (candidate ❷ precondition confirmed).**
  The Provider wrote `is_epic=1` to `provider=#A`, but the watcher operates on `watcher=#B`.
  Confirm the clobber mechanism in Q3.
  - Also compare the two `dbPath=` values on this line. If the paths differ, the split is a
    **path-resolution divergence** (`~` expansion / symlink / mapped-parent redirect in
    `forWorkspace` / `resolveEffectiveWorkspaceRoot`). If the paths are identical but instances
    differ, the `_instancesByDbPath` cache (KanbanDatabase.ts:~868) is being bypassed.
  - **Fix:** make both paths resolve to one instance — normalize the root before `forWorkspace`,
    or have the watcher reuse the Provider's `_getKanbanDb`. Do **not** "heal on refresh" (per the
    user's explicit directive: fix the clobber, not the symptom).

- **`sameInstance=true` → candidate ❷ is dead at the fork.** The clobber is neither an explicit
  demotion (Q1) nor a split at creation. Go to Q3, then Q4.

### Q3 — Trace the `persist` / `reload` lines for the epic's plan_file, in timestamp order.

Look for this signature of a **stale-snapshot overwrite**:

```
persist instance=#A epics=[ …epic.md=is_epic:1… ]     ← Provider flushes the good state
reload  instance=#B epics=[ …epic.md=is_epic:0… ]     ← other instance had NOT seen it
persist instance=#B epics=[ …epic.md=is_epic:0… ]     ← #B flushes its stale 0 over the top  ← CLOBBER
```

- If you see a `persist instance=#B … is_epic:0` **after** a `persist instance=#A … is_epic:1`
  for the same file, and `#B ≠ #A` → **verdict: STALE-SNAPSHOT PERSIST (candidate ❷ confirmed).**
  The instance in the last `is_epic:0` persist is the culprit; its stack of callers is whatever
  triggered that flush (often the watcher's `insertFileDerivedPlan` or a config write).
- If every `persist` line for the file shows `is_epic:1` and only a later `reload` shows `is_epic:0`,
  the `0` is coming from **disk** — i.e. something outside these instances wrote it, or the on-disk
  row was never 1. Go to Q4.

### Q4 — Neither explicit demotion nor a split/stale persist. Widen the net.

Remaining possibilities from the investigation doc:
- **❹ backup export/restore gap** — a `SELECT` that omits `is_epic` re-inserting the row as NULL/0.
  Look for a `reload` immediately after a restore, or check whether `exportStateToFile` /
  `_writeKanbanStateBackup` ran (they fire from `_persist`). Fix = add `is_epic`/`epic_id`/`project_id`
  to the export+restore columns (Step 3).
- A code path that writes `is_epic` **without** going through `updateEpicStatus` (so the Q1 guard
  never saw it). Grep for direct `UPDATE plans SET is_epic` and `insertFileDerivedPlan` calls with a
  0/NULL is_epic, and add the same file-logging probe there, then re-run.

---

## 3. One-paragraph verdict template (for the examining agent)

> **Verdict:** `<EXPLICIT DEMOTION ❶/❸/❺ | SPLIT INSTANCES + STALE PERSIST ❷ | BACKUP GAP ❹ | UNKNOWN — widen probes>`.
> **Evidence:** quote the exact log lines (with timestamps and `instance=` tags) that establish it.
> **Culprit:** the caller named by the stack trace, or the offending `instance=#N` and the flush that carried `is_epic:0`.
> **Recommended fix:** the matching Step from `docs/investigation-epic-is_epic-clobber.md`, plus any caller-specific correction.
> **Confidence + gaps:** note anything the single run did NOT disambiguate and what a follow-up probe would need.

---

## 4. Cleanup (after the verdict)

These probes are temporary. Once the clobber is fixed, remove:
- `src/services/epicClobberDiag.ts` (the whole file)
- its import + call sites in `KanbanDatabase.ts` (instanceId field, `_nextInstanceId`, demotion guard,
  `_diagEpicSnapshot`, and its calls in `_persist`/`_reloadIfStale`)
- the DB-instance-check block in `KanbanProvider.createEpicFromPlanIds`
- the epic-file-handle log in `GlobalPlanWatcherService._handlePlanFile`
- the generated `.switchboard/epic-clobber-diagnostic.txt` files in any test workspace

Grep for `is_epic clobber` and `EPIC CLOBBER` / `EPIC-CLOBBER` to find every probe.
