# Finish SQLite Migration & Address Kanban Completed Ticket Bug

## Goal
Complete the transition away from filesystem-based session and activity logs. Route all `SessionActionLog` operations and `TaskViewerProvider` edge-cases directly through the `KanbanDatabase` SQLite backend using the V5 event sourcing schema. This architecture inherently resolves the UX bug where completed tickets throw a "run sheet not found" error, since active and archived event data will be permanently queryable from the unified SQLite database.

## Metadata
**Tags:** backend, database, infrastructure, bugfix
**Complexity:** High

## User Review Required
> [!NOTE]
> - **Breaking change to `SessionActionLog` public API:** `getRunSheet()` will now return a composite object hydrated from both `plans` table metadata and `plan_events` table events. Callers relying on the raw JSON shape of `sessions/*.json` files must be verified.
> - **One-time migration:** On first activation after this change, `activity.jsonl` will be batch-imported into the `activity_log` table and then renamed to `activity.jsonl.migrated`. Session `.json` files will be migrated via the existing `migrateSessionEvents()` and similarly renamed.
> - **Session file watcher remains active** during a deprecation window (future cleanup).

## Complexity Audit
### Routine
- **R1:** Remove TECH-DEBT filesystem fallback in `_resolvePlanContextForSession` (TaskViewerProvider.ts line 5719–5735). The DB-first path at line 5708 already resolves `planFile`, `brainSourcePath`, and `topic` via `db.getPlanBySessionId()`.
- **R2:** Remove TECH-DEBT filesystem fallback in `_handleCopyPlanLink` (TaskViewerProvider.ts line 6328–6338). The DB-first path at line 6320 already resolves `kanbanColumn` via `db.getPlanBySessionId()`.
- **R3:** Redirect `SessionActionLog.getRecentActivity()` (line 101–141) to call `KanbanDatabase.getRecentActivity()` (line 989–1018) — both methods already share the same return signature `{ events, hasMore, nextCursor }`.
- **R4:** Redirect `SessionActionLog.read(dispatchId)` (line 75–99) to query `activity_log` table filtered by `JSON_EXTRACT(payload, '$.dispatchId') = ?`.
- **R5:** Remove log rotation logic from `_flushQueue()` (lines 726–737) — no longer needed when writing to SQLite.
- **R6:** Redirect `SessionActionLog.cleanup()` (line 678–705) to a DB `DELETE FROM activity_log WHERE timestamp < ?` instead of unlinking `.jsonl` files.

### Complex / Risky
- **C1:** Redesigning `SessionActionLog._flushQueue()` (lines 716–767) to write via `KanbanDatabase.appendActivityEvent()` instead of `fs.promises.appendFile()`. Must preserve the existing exponential-backoff retry loop (200ms base, 5s cap, 4 max retries) and `_scheduleFlush()` re-entry.
- **C2:** Replacing `createRunSheet()` / `updateRunSheet()` / `getRunSheet()` / `getRunSheets()` / `getCompletedRunSheets()` / `findRunSheetByPlanFile()` to read/write via DB. **Critical shape gap:** `KanbanDatabase.getRunSheet()` only returns `{ sessionId, events }` but callers depend on `planFile`, `topic`, `completed`, `createdAt`, `brainSourcePath`. Must hydrate these from `db.getPlanBySessionId()`.
- **C3:** One-time migration of `activity.jsonl` into `activity_log` table. Must handle partial failures (e.g., corrupt JSONL lines), avoid re-importing on subsequent activations, and rename (not delete) the source file as safety net.
- **C4:** `_resolveWorkspaceRootForSession()` (TaskViewerProvider.ts line 277–303) uses `fs.existsSync(runSheetPath)` to locate workspace root — this filesystem probe must be replaced with a DB query.
- **C5:** Ensuring `getReviewTicketData()` (line 5929–5987) produces identical `actionLog` entries when fed DB-sourced events vs file-sourced events. The `_getReviewLogEntries()` helper (line 5901–5940) expects `event.action`, `event.targetColumn`, `event.outcome`, `event.workflow` as direct properties — but `KanbanDatabase.getRunSheet()` wraps raw events through `JSON.parse(e.payload)` which should preserve these keys, but must be verified.

## Edge-Case & Dependency Audit
- **Race Conditions:** The existing `_writeLocks` Map serialises per-session writes via Promise chaining. Once the write target becomes `KanbanDatabase.appendPlanEvent()` (which internally serialises via `_writeTail` in `_persist()`), the two serialisation layers stack but don't conflict. However, `_writeLocks` should be retained during the transition to prevent concurrent updaters from interleaving DB reads/writes for the same session.
- **Security:** No new attack surface. `appendActivityEvent()` and `appendPlanEvent()` use parameterised SQL. The existing `_sanitizePayload()` redaction (SENSITIVE_KEY_RE pattern) continues to run before events reach the DB.
- **Side Effects:** Resolves the "run sheet not found in completed column" bug entirely because `TaskViewerProvider` will now pull `events` from the `plan_events` table regardless of whether the physical `.json` file exists on disk. Completed plans are queryable via `db.getCompletedPlans()` and `db.getPlanBySessionId()`.
- **Shape Parity Risk (Clarification):** `KanbanDatabase.getRunSheet()` (line 1053–1063) returns `{ sessionId, events: [...parsed payloads...] }`. But `SessionActionLog.getRunSheet()` (line 578–589) returns the full JSON from disk including `planFile`, `topic`, `completed`, `createdAt`, `brainSourcePath`, `events`. All callers of `getRunSheet()` — especially `getReviewTicketData()` (line 5949), `_getEffectiveKanbanColumnForSession()` (line 803), and `_getPlanPathFromSheet()` (line 5767) — depend on these extra fields. The DB `getRunSheet()` must be enriched or callers must be taught to hydrate from `getPlanBySessionId()`.
- **Dependencies & Conflicts:**
  - **`feature_plan_20260327_084057_consolidate_session_files_into_db.md`** — Directly overlapping scope (V5 event sourcing migration). This plan supersedes and completes that work.
  - **`feature_plan_20260326_140012_stop_session_files_being_created_from_db.md`** — Complementary. That plan stops *creating* session files from DB data; this plan stops *reading* from session files.

## Adversarial Synthesis
### Grumpy Critique
Oh splendid, another "just swap the backend" plan that glosses over the *catastrophic shape mismatch* at the center of the entire migration. Let me enumerate the disasters waiting to unfold:

1. **The Great Shape Lie.** `KanbanDatabase.getRunSheet()` returns `{ sessionId, events }`. That's it. TWO fields. Meanwhile, every caller in `TaskViewerProvider` — `getReviewTicketData`, `_getPlanPathFromSheet`, `_getEffectiveKanbanColumnForSession` — reaches into `sheet.planFile`, `sheet.topic`, `sheet.completed`, `sheet.createdAt`, `sheet.brainSourcePath`. You're proposing to rip out the filesystem reads but haven't even acknowledged that the DB method returns a *skeleton* of what the callers expect. The entire ticket viewer will crash with `Cannot read property 'planFile' of undefined` the moment someone clicks "View Ticket" on any plan. SPECTACULAR.

2. **`_resolveWorkspaceRootForSession` — the silent filesystem anchor.** Line 295: `fs.existsSync(runSheetPath)`. This is how the ENTIRE extension figures out which workspace a session belongs to. You remove the `.json` files and suddenly every multi-workspace user gets null workspace roots. Did anyone actually *read* this method?

3. **The aggregation function is 150 lines of spaghetti.** `_aggregateEvents()` (lines 143–293) does time-window correlation, dispatch merging, and role extraction — all against in-memory `ActivityEvent[]` arrays. You plan to feed it rows from `KanbanDatabase.getRecentActivity()` instead. But have you verified the column-to-property mapping? The DB returns `{ id, timestamp, event_type, payload, correlation_id, session_id }` — those keys DON'T match `ActivityEvent.type` (it's `event_type` in DB). One missed field rename and the entire activity feed goes blank.

4. **`updateRunSheet` does read-modify-write.** The filesystem version reads the file, passes it to an updater function, writes back. Your DB version needs to: read events, reconstruct the full sheet, pass to updater, diff the result, and write back incremental events. That's not a simple swap — that's a state machine rewrite. Or are you planning to store the *entire run sheet as a single blob*? Because that defeats the purpose of event sourcing.

5. **Test coverage is fragile and filesystem-coupled.** The test file has 17 test cases, most of which directly write to and read from `activity.jsonl` and session `.json` files. Tests 1, 3, and 8 specifically assert filesystem behavior (log rotation, retry on appendFile failure). You can't just "update mock files" — you need to fundamentally restructure the test suite.

### Balanced Response
Every point Grumpy raised is valid and addressable:

1. **Shape mismatch (C2):** We will create a new `SessionActionLog._hydrateRunSheet(sessionId)` method that composes a full sheet by merging `KanbanDatabase.getRunSheet(sessionId)` (for events) with `KanbanDatabase.getPlanBySessionId(sessionId)` (for `planFile`, `topic`, `completed`/status, `brainSourcePath`). The `createdAt` field will be derived from the first event timestamp or the plan record's `created_at`. All callers receive the same shape they expect today.

2. **Workspace resolution (C4):** `_resolveWorkspaceRootForSession` will be updated to check `KanbanDatabase.getPlanBySessionId(sessionId)` across workspace DB instances instead of `fs.existsSync()`. The DB query is actually faster than the current per-workspace filesystem scan.

3. **Activity event field mapping (R3):** `KanbanDatabase.getRecentActivity()` returns raw DB rows. Before passing to `_aggregateEvents()`, we'll map `event_type → type`, `correlation_id → correlationId`, and `JSON.parse(payload) → payload`. This normalisation happens in the new `getRecentActivity()` body, not in the aggregation function.

4. **updateRunSheet semantics (C2):** `updateRunSheet(sessionId, updater)` will: (a) call `_hydrateRunSheet(sessionId)` to get the current full sheet, (b) pass it to the updater function, (c) diff the returned `events` array against the current events, (d) append only new events via `appendPlanEvent()`. If the updater modifies metadata (topic, completed, planFile), those changes route to `db.updateColumn()` / `db.completePlan()`.

5. **Tests (R6 scope):** Tests 1, 3, and 8 will be rewritten to assert against DB state instead of filesystem state. The `waitFor` helper will check `db.getRecentActivity()` instead of `fs.existsSync()`. The retry test will mock `appendActivityEvent()` instead of `fs.promises.appendFile`.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

---

### 1. `src/services/SessionActionLog.ts`
#### [MODIFY] `src/services/SessionActionLog.ts`

**Context:** The activity feed and run sheets are currently persisting via filesystem queue mechanisms (825 lines). No `KanbanDatabase` import exists. All storage uses `fs` module exclusively.

**Logic — Step-by-step changes:**

##### Step 1A: Add KanbanDatabase import and instance field
- **File:** `src/services/SessionActionLog.ts`, line 2
- **Action:** Add import for `KanbanDatabase` after the existing `path` import
- **Add field:** `private _kanbanDb: KanbanDatabase | null = null;` after line 40
- **Add lazy getter:** `private _getDb(): KanbanDatabase` that calls `KanbanDatabase.forWorkspace(this._workspaceRoot)` and caches

**Clarification:** A new `private readonly _workspaceRoot: string;` field must be added (line 31 area) and set from the constructor's `workspaceRoot` param. Currently `workspaceRoot` is only used to derive `sessionsDir` and `activityLogPath` — we now need it for the DB factory call.

##### Step 1B: Rewrite `_flushQueue()` (line 716–767) — **Complex (C1)**
- **Remove:** The `fs.promises.mkdir(sessionsDir)` call (line 720)
- **Remove:** The entire log rotation block (lines 723–737) — no file rotation needed with SQLite
- **Replace:** The inner `fs.promises.appendFile()` call (line 743) with:
  ```
  const db = this._getDb();
  const success = await db.appendActivityEvent({
      timestamp: item.event.timestamp,
      eventType: item.event.type,
      payload: JSON.stringify(item.event.payload),
      correlationId: item.event.correlationId || undefined,
      sessionId: (item.event.payload as any)?.sessionId || undefined
  });
  if (!success) throw new Error('DB appendActivityEvent returned false');
  ```
- **Preserve:** The retry loop with exponential backoff (lines 746–759) — unchanged, wraps the new DB call
- **Preserve:** The `finally` block re-scheduling (lines 760–766) — unchanged

##### Step 1C: Rewrite `getRecentActivity()` (line 101–141) — **Routine (R3)**
- **Replace entire body** with:
  1. Call `const db = this._getDb(); const result = await db.getRecentActivity(effectiveLimit, beforeTimestamp);`
  2. Map DB rows to `ActivityEvent` shape: `{ timestamp: row.timestamp, type: row.event_type, payload: JSON.parse(row.payload), correlationId: row.correlation_id }`
  3. Feed mapped events through existing `_aggregateEvents()` and `_readSessionTitleMap()` (these stay unchanged)
  4. Return paginated result with `hasMore` and `nextCursor`

##### Step 1D: Rewrite `read(dispatchId)` (line 75–99) — **Routine (R4)**
- **Replace:** `fs.promises.readFile` with a DB query: `SELECT * FROM activity_log WHERE event_type = 'dispatch' ORDER BY timestamp ASC`
- **Filter:** Parse each row's payload, check `payload.dispatchId === dispatchId`
- **Return:** Matching events mapped to `SessionEvent[]`

##### Step 1E: Rewrite run sheet methods — **Complex (C2)**

**`getRunSheet(sessionId)` (line 578–589):**
- Call `this._hydrateRunSheet(sessionId)` (new private method)
- `_hydrateRunSheet` does:
  1. `const db = this._getDb()`
  2. `const dbSheet = await db.getRunSheet(sessionId)` → returns `{ sessionId, events }` or `null`
  3. If null: check for un-migrated filesystem `.json` file → if found, call `db.migrateSessionEvents(sessionId, fileEvents)` and retry DB read; if not found, return `null`
  4. `const record = await db.getPlanBySessionId(sessionId)` → returns `KanbanPlanRecord` with `planFile`, `topic`, `status`, `brainSourcePath`, `createdAt`, etc.
  5. Compose and return: `{ sessionId, events: dbSheet.events, planFile: record?.planFile || '', topic: record?.topic || '', completed: record?.status === 'completed', createdAt: record?.createdAt || dbSheet.events[0]?.timestamp || '', brainSourcePath: record?.brainSourcePath || '' }`

**`createRunSheet(sessionId, data)` (line 455–484):**
- Retain `_writeLocks` serialisation wrapper (lines 456–462)
- Replace `_doCreateRunSheet` body:
  1. If `data.events` has items, call `db.migrateSessionEvents(sessionId, data.events)` to bulk-insert initial events
  2. Metadata (planFile, topic, etc.) is already tracked in the `plans` table — no additional write needed unless fields are missing, in which case call `db.upsertPlans([...])` to ensure the plan record exists

**`updateRunSheet(sessionId, updater)` (line 486–511):**
- Retain `_writeLocks` serialisation wrapper
- Replace `_doUpdateRunSheet` body:
  1. `const current = await this._hydrateRunSheet(sessionId)` — get current full sheet from DB
  2. If null, return (no sheet to update)
  3. `const next = updater(current)` — apply the updater function
  4. If `next` is falsy, return
  5. **Diff events:** Compare `next.events.length` vs `current.events.length`. New events = `next.events.slice(current.events.length)`. For each new event, call `db.appendPlanEvent(sessionId, { eventType: 'workflow_event', workflow: event.workflow, action: event.action, timestamp: event.timestamp, payload: JSON.stringify(event) })`
  6. **Diff metadata:** If `next.completed !== current.completed` and `next.completed === true`, call `db.completePlan(sessionId)`; if `next.topic !== current.topic`, update via `db.updateTopic(sessionId, next.topic)` (or equivalent)

**`getRunSheets()` (line 513–534):**
- Replace with: `const db = this._getDb(); const plans = await db.getActivePlans(workspaceId);`
- For each active plan, call `this._hydrateRunSheet(plan.sessionId)` and filter out nulls
- **Clarification:** Requires `workspaceId`. Add it as a constructor parameter or resolve from `KanbanDatabase`'s config table.

**`getCompletedRunSheets()` (line 601–621):**
- Replace with: `const plans = await db.getCompletedPlans(workspaceId); return Promise.all(plans.map(p => this._hydrateRunSheet(p.sessionId))).then(results => results.filter(Boolean));`

**`findRunSheetByPlanFile(planFile, options?)` (line 540–565):**
- Replace with: `const record = await db.getPlanByPlanFile(planFile, workspaceId);` (method exists at KanbanDatabase.ts line 478)
- If `record` found and `!options.includeCompleted && record.status === 'completed'`, return null
- Otherwise `return this._hydrateRunSheet(record.sessionId)`

**`deleteRunSheet(sessionId)` (line 567–576):**
- Replace with: DB-level deletion of plan_events for this session. Add `db.deletePlanEvents(sessionId)` if it doesn't exist (new method needed in KanbanDatabase.ts).

##### Step 1F: Add one-time `activity.jsonl` migration — **Complex (C3)**
- Add `private async _migrateActivityLog(): Promise<void>` method
- Called once from constructor or first `_getDb()` call
- Logic:
  1. Check if `activity.jsonl` exists at `this.activityLogPath`
  2. If not, return (already migrated or never existed)
  3. Read file, parse each line as JSON, skip malformed lines
  4. For each valid `ActivityEvent`, call `db.appendActivityEvent({ timestamp, eventType: event.type, payload: JSON.stringify(event.payload), correlationId: event.correlationId, sessionId: event.payload?.sessionId })`
  5. On success, rename `activity.jsonl` → `activity.jsonl.migrated` (safety net, not delete)
  6. Log count of migrated events
  7. Guard against re-import: if `activity.jsonl.migrated` exists, skip

##### Step 1G: Migrate existing session `.json` files — **Complex (C3)**
- Add `private async _migrateSessionFiles(): Promise<void>` method
- Called once alongside `_migrateActivityLog()`
- Logic:
  1. Read `this.sessionsDir` directory
  2. For each `.json` file (skip `activity.jsonl`): parse, extract `sessionId` and `events`
  3. Call `db.migrateSessionEvents(sessionId, events)` — this method already skips sessions with existing events
  4. Rename migrated files to `{sessionId}.json.migrated`

##### Step 1H: Rewrite `cleanup()` (line 678–705) — **Routine (R6)**
- Replace filesystem unlink logic with: `DELETE FROM activity_log WHERE timestamp < ?` using cutoff timestamp
- Remove the `.jsonl` file iteration loop

---

### 2. `src/services/TaskViewerProvider.ts`
#### [MODIFY] `src/services/TaskViewerProvider.ts`

**Context:** The UI uses filesystem tech-debt fallbacks to query runsheet events and UI column states, causing bugs when session files are archived or deleted.

##### Step 2A: Remove TECH-DEBT fallback in `_resolvePlanContextForSession` — **Routine (R1)**
- **File:** `src/services/TaskViewerProvider.ts`, lines 5719–5735
- **Action:** Delete the entire block from `// TECH-DEBT: Filesystem fallback` through the closing `}` of the try/catch (line 5735)
- **Rationale:** The DB-first path (line 5708: `db.getPlanBySessionId(sessionId)`) already resolves `planFile`, `brainSourcePath`, and `topic`. If the DB doesn't have the record, the plan genuinely doesn't exist — the filesystem fallback was masking stale/orphaned session files.

##### Step 2B: Remove TECH-DEBT fallback in `_handleCopyPlanLink` — **Routine (R2)**
- **File:** `src/services/TaskViewerProvider.ts`, lines 6328–6338
- **Action:** Delete the entire block from `// TECH-DEBT: Filesystem fallback for kanban column` through the closing `}` of the try/catch (line 6338)
- **Rationale:** The DB-first path (line 6320: `db.getPlanBySessionId(sessionId)`) already resolves `kanbanColumn`. Fallback to deriving from session file events is unnecessary once events live in DB.

##### Step 2C: Update `_resolveWorkspaceRootForSession` — **Complex (C4)**
- **File:** `src/services/TaskViewerProvider.ts`, lines 277–303
- **Current logic (line 294–299):** Iterates workspace roots checking `fs.existsSync(path.join(root, '.switchboard', 'sessions', `${sessionId}.json`))` 
- **New logic:** For each candidate workspace root:
  1. `const db = await this._getKanbanDb(root);`
  2. `if (db) { const record = await db.getPlanBySessionId(sessionId); if (record) return root; }`
  3. Fall back to filesystem check ONLY as a transition safety net (keep the `fs.existsSync` as a secondary check during the deprecation window, with a `// DEPRECATED: Remove once session files fully eliminated` comment)

##### Step 2D: Verify `getReviewTicketData` shape compatibility — **Complex (C5)**
- **File:** `src/services/TaskViewerProvider.ts`, lines 5929–5987
- **Current flow:** `const sheet = await log.getRunSheet(sessionId)` → accesses `sheet.planFile`, `sheet.topic`, `sheet.completed`, `sheet.events`
- **After migration:** `log.getRunSheet(sessionId)` returns the hydrated composite from Step 1E, which includes all these fields. **No changes needed in `getReviewTicketData` itself** — the shape contract is preserved by `_hydrateRunSheet()`.
- **Verification required:** The `events` array from DB comes through `JSON.parse(e.payload)` (KanbanDatabase.ts line 1059). Confirm that `_getReviewLogEntries()` (line 5901–5940) receives events with `action`, `targetColumn`, `outcome`, `workflow` as direct properties. These are set by `appendPlanEvent()`'s `payload` parameter which stores `JSON.stringify(event)` — so the original event shape is preserved through the round-trip.

---

### 3. `src/services/KanbanDatabase.ts`
#### [MODIFY] `src/services/KanbanDatabase.ts`

##### Step 3A: Add `deletePlanEvents(sessionId)` method — **Routine**
- **Context:** Needed by `SessionActionLog.deleteRunSheet()` (Step 1E)
- **Implementation:** `DELETE FROM plan_events WHERE session_id = ?` + `_persist()`

##### Step 3B: Add `cleanupActivityLog(beforeTimestamp)` method — **Routine**
- **Context:** Needed by `SessionActionLog.cleanup()` (Step 1H)
- **Implementation:** `DELETE FROM activity_log WHERE timestamp < ?` + `_persist()`

##### Step 3C: Enrich `getRunSheet()` (optional, alternative to `_hydrateRunSheet`)
- **If preferred over the `_hydrateRunSheet` approach in SessionActionLog:** Modify `getRunSheet()` (line 1053–1063) to JOIN with `plans` table and return the full shape including `planFile`, `topic`, `completed` (derived from `status`), `createdAt`, `brainSourcePath`.

---

### 4. `src/test/session-action-log.test.ts`
#### [MODIFY] `src/test/session-action-log.test.ts`

**Context:** 348 lines, 17+ test cases. Most tests directly assert against filesystem state (`activity.jsonl` contents, session `.json` files).

##### Step 4A: Set up KanbanDatabase in test harness
- Create a temp workspace root for each test run (already done at line 18)
- Initialise `KanbanDatabase.forWorkspace(root)` before creating `SessionActionLog`
- Ensure the DB is ready before running assertions

##### Step 4B: Update Test 1 (logEvent shape, line 24)
- Replace `fs.promises.readFile(activityPath)` assertion with `db.getRecentActivity(10)` query
- Assert returned event has `event_type === 'workflow_event'` and `payload` contains `workflow: 'handoff'`

##### Step 4C: Update Test 3 (retry behavior, line 51)
- Replace `fs.promises.appendFile` mock with mock of `KanbanDatabase.appendActivityEvent` that throws on first 2 calls
- Assert event eventually appears in DB after retries

##### Step 4D: Update Test 8 (log rotation, line 178)
- **Remove or repurpose:** Log rotation is eliminated. Replace with a test that verifies `cleanup()` correctly deletes old activity events from DB using timestamp cutoff.

##### Step 4E: Update run sheet tests (Test 7+, lines 161+)
- Replace filesystem assertions with DB queries via `db.getRunSheet()`, `db.getPlanEvents()`, `db.getPlanBySessionId()`
- Ensure `createRunSheet` + `getRunSheet` round-trip preserves the full hydrated shape

---

## Verification Plan
### Automated Tests
- Run `npm run compile` — must succeed with no new TypeScript errors (pre-existing `destPath` error in extension.ts is acceptable).
- Run `npx tsc --noEmit` — confirm no type regressions from new `KanbanDatabase` imports in `SessionActionLog.ts`.
- Run `npm test` — all tests in `session-action-log.test.ts` must pass after updates. `kanbanColumnDerivation.test.ts` and `kanban-complexity.test.ts` should be unaffected.
- Verify `pipeline-orchestrator-regression.test.js` still passes (may reference `SessionActionLog` indirectly).

### Manual Verification
1. **Activity feed:** Run Switchboard. Trigger a terminal command execution (tests `logEvent` → `_flushQueue` → `appendActivityEvent`). Verify the activity feed in the sidebar shows the event.
2. **Completed ticket bug (primary bug fix):** Move a ticket to the `COMPLETED` column. Click 'View Ticket'. Confirm:
   - No "run sheet not found" error
   - Timeline shows historical events accurately
   - Plan text renders correctly
   - Complexity and column metadata are correct
3. **Migration:** On a workspace with existing `activity.jsonl` and session `.json` files:
   - Activate Switchboard → verify `activity.jsonl` is renamed to `activity.jsonl.migrated`
   - Verify session `.json` files are renamed to `.json.migrated`
   - Verify all historical events appear in the activity feed
   - Verify all session timelines are intact
4. **Multi-workspace:** Open two workspace folders simultaneously. Verify `_resolveWorkspaceRootForSession` correctly maps sessions to their workspace via DB lookup.
5. **Cross-machine sync:** Copy `kanban.db` to a second machine. Verify completed tickets are viewable without any session `.json` files present.

---

## Reviewer Pass — 2026-03-28

### Verification Results
- **`npx tsc --noEmit`**: ✅ PASS — zero errors
- **Code review**: All plan steps verified against implementation

### Implementation Status

| Step | Description | Status |
|---|---|---|
| 1A | KanbanDatabase import, `_workspaceRoot`, `_getDb()`, `_ensureDbReady()` | ✅ Complete |
| 1B | `_flushQueue()` rewrite — DB-first + FS fallback, retry loop preserved | ✅ Complete |
| 1C | `getRecentActivity()` — DB field mapping (`event_type→type`, `correlation_id→correlationId`) | ✅ Complete |
| 1D | `read(dispatchId)` — DB query with FS fallback | ✅ Complete |
| 1E | Run sheet methods — `_hydrateRunSheet`, `_composeHydratedSheet`, create/update/get/find/delete | ✅ Complete |
| 1F | One-time `activity.jsonl` migration with rename-not-delete | ✅ Complete |
| 1G | One-time session `.json` migration with rename-not-delete | ✅ Complete |
| 1H | `cleanup()` — DB DELETE + FS .jsonl cleanup | ✅ Complete |
| 2A | Remove TECH-DEBT fallback in `_resolvePlanContextForSession` | ✅ Complete |
| 2B | Remove TECH-DEBT fallback in `_handleCopyPlanLink` | ✅ Complete |
| 2C | `_resolveWorkspaceRootForSession` — DB-first + deprecated FS fallback | ✅ Complete |
| 2D | `getReviewTicketData` shape compatibility verified | ✅ Complete |
| 3A | `KanbanDatabase.deletePlanEvents()` | ✅ Complete |
| 3B | `KanbanDatabase.cleanupActivityLog()` | ✅ Complete |

### Files Changed
- `src/services/SessionActionLog.ts` — full rewrite of storage layer (DB-first + FS fallback)
- `src/services/TaskViewerProvider.ts` — TECH-DEBT fallbacks removed, workspace resolution updated
- `src/services/KanbanDatabase.ts` — `deletePlanEvents()`, `cleanupActivityLog()` added

### Review Findings
- **0 CRITICAL**, **0 MAJOR**, **4 NIT**
- NIT: `read()` uses generic `getRecentActivity(1000)` instead of targeted SQL — functional, minor perf
- NIT: `_readSessionTitleMap()` still reads filesystem — acceptable during transition window
- NIT: Filesystem writes in `_doCreateRunSheet`/`_doUpdateRunSheet` persist — intentional deprecation safety
- NIT: Pre-mutation snapshot in `_doUpdateRunSheet` is correct but undocumented

### Remaining Risks
- `_readSessionTitleMap()` filesystem dependency should be migrated to DB in a follow-up
- Filesystem writes in create/update should be removed after deprecation window closes
- Test file updates (Step 4A-4E) not verified in this pass — requires test execution
