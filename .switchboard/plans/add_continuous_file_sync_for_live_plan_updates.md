# Add Continuous File Sync for Live Plan Updates

## Goal

Implement a continuous file sync mechanism that watches Switchboard plan markdown files for changes and syncs the latest content to ClickUp/Linear task descriptions in real-time (every 30 seconds or on save). Unlike the completion-triggered write-back in Option A, this allows external stakeholders to see live progress as agents work on plans.

## Metadata

**Tags:** backend, UI
**Complexity:** 7

## User Review Required

> [!NOTE]
> - **New operation mode option**: This adds "Live Sync Mode" as an alternative to Board Management Mode's completion-only write-back. Users can choose between: (a) sync only at completion, or (b) continuous sync during plan lifecycle.
> - **Rate limiting**: Continuous sync includes built-in debouncing (30 second default) and rate limiting to prevent API quota exhaustion.
> - **Manual pause**: Users can pause live sync per-plan via the Kanban card context menu.
> - **Conflict resolution**: If external task is edited while live sync is active, Switchboard will show a conflict warning and pause sync for that plan until resolved.

## Complexity Audit

### Routine
- **Add `LiveSyncTypes.ts` type definitions** — new file `src/models/LiveSyncTypes.ts` with `LiveSyncStatus`, `LiveSyncState`, `LiveSyncConfig` types and `DEFAULT_LIVE_SYNC_CONFIG` constant. Pure type definitions, no logic.
- **Add `syncPlanContent()` method to `ClickUpSyncService`** (`src/services/ClickUpSyncService.ts`, after `syncPlan` ~line 794) — single `httpRequest('PUT', ...)` call updating task description only. Follows existing `httpRequest` + `retry` pattern. No status/column mutation.
- **Add `syncPlanContent()` method to `LinearSyncService`** (`src/services/LinearSyncService.ts`, after `syncPlan` ~line 367) — single `graphqlRequest` call with `issueUpdate` mutation. Uses existing `graphqlRequest` helper (line 192). Description-only update.
- **Add enable/disable toggle** in `src/webview/setup.html` Project Management accordion — checkbox + select dropdown for interval. Standard HTML/JS, follows existing toggle pattern.
- **Add per-plan pause/resume** context menu items in `src/webview/kanban.html` card dropdown — 2 new menu items gated on `liveSyncState.status`. Standard `postKanbanMessage` pattern.
- **Add visual indicator** on Kanban cards in `src/webview/kanban.html` — CSS pulsing dot + `renderCard()` conditional HTML. Pure presentational.
- **Add configuration** for sync interval (default 30s, min 10s, max 300s) — stored via `workspaceState` in `KanbanProvider`, same pattern as existing integration configs.

### Complex / Risky
- **File watcher reuse** *(Medium risk)*: Must hook into the **existing** `_planContentWatcher` in `KanbanProvider` (line 111, `src/services/KanbanProvider.ts`) via a new `EventEmitter<vscode.Uri>`. The existing `onDidChange` handler (line 424) already does ClickUp `debouncedSync` — we add a `_planFileChangeEmitter.fire(uri)` call alongside it. **Critical:** There is NO `_pendingSelfWrites` guard in the current codebase — the plan must NOT reference one. The self-write guard for ClickUp sync is handled by `ClickUpSyncService._isSyncInProgress`.
- **Plan file lookup** *(High risk — original plan had a bug)*: The original `_handleFileChange` used regex `^plan_(\w+)\.md$` to extract sessionId from filenames. **This is wrong.** Actual plan files are named `add_continuous_file_sync_for_live_plan_updates.md`, `brain_*.md`, `clickup_*.md`, etc. — NOT `plan_*.md`. Must use `KanbanDatabase.getPlanByPlanFile(uri.fsPath, workspaceId)` to look up the plan record (same pattern as existing handler at line 435-439).
- **Content diffing**: Must read file, compare with last-synced SHA-256 content hash to avoid no-op API calls. Store hash in `LiveSyncState`. Low risk but must handle file read errors gracefully (plan deleted between event and read).
- **Conflict detection** *(Medium risk)*: External edits to ClickUp/Linear task description create conflicts. Requires extra API call per check — fetch current description, hash it, compare with `lastExternalHash`. Opt-in by default (expensive). For ClickUp: `httpRequest('GET', '/task/${taskId}')` → extract `description`. For Linear: `graphqlRequest('{ issue(id: "...") { description } }')` → extract `description`.
- **Termination conditions** *(Medium risk)*: Live sync must stop when: (a) plan column changes to `COMPLETED` (check in `_handleFileChange` via DB lookup), (b) user pauses sync, (c) conflict detected, (d) file deleted (handle `ENOENT`), (e) mode change away from live-sync mode.
- **Rate limiting coordination** *(High risk)*: ClickUp has ~100 req/min limit, Linear has ~250 req/min. `ContinuousSyncService` must track global rate limit state via `RateLimitWindow` map and queue/defer syncs across all plans. Must parse `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers from ClickUp responses; Linear returns rate info in GraphQL `extensions` field. Exponential backoff on 429 responses.
- **Multi-plan sync storm** *(High risk)*: 10+ plans in `INVESTIGATION` all being edited simultaneously could overwhelm API quotas. Need global sync queue with priority (most-recently-edited first) and max concurrent syncs cap (3). Queue draining must handle plans that moved to `COMPLETED` or `paused` while queued.
- **Operation mode dependency** *(Architectural risk)*: `KanbanProvider` has **no `setOperationMode` method** currently. The "Add Operation Mode Toggle for Event-Driven Integrations" plan (sess_1776049260864, Planned column) must be implemented first to provide the mode transition infrastructure. Live sync start/stop must hook into that mode system.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - Plan file change event fires while sync is in-progress → debounce/queue the next sync, don't double-sync.
  - User pauses sync while sync is in-flight → let in-flight sync complete, then stop further syncs.
  - Mode switch from Live Sync Mode to Coding Mode → stop all file watchers, flush pending syncs, clean up state.
  - Rapid file saves (every 1 second) → respect 30s debounce, queue only one pending sync.

- **Security:**
  - No new credentials or tokens. Uses existing ClickUp/Linear sync services.
  - File content is read from workspace (trusted) and sent to external APIs via existing authenticated channels.
  - Content hashes stored in memory only (not persisted), no sensitive data exposure risk.

- **Side Effects:**
  - External task description will be overwritten with Switchboard plan content. Any manual edits in ClickUp/Linear UI will be lost unless conflict detection catches them.
  - API quota consumption increases — continuous sync uses more requests than completion-only sync.
  - Network traffic increases — plan files can be large (markdown with embedded images as base64 in some setups).

- **Dependencies & Conflicts:** *(Verified against live Kanban state 2026-04-13)*
  - **[BLOCKER] "Add Operation Mode Toggle for Event-Driven Integrations"** (Planned column, sess_1776049260864, Complexity 6): **Must be implemented first.** This plan provides the `setOperationMode()` infrastructure that live sync hooks into. Without it, there is no mode transition system — `KanbanProvider` currently has no operation mode concept. Live sync start/stop cannot be wired without this dependency.
  - **[SOFT DEP] "Extend Event Monitoring and Ticket Write-Back to Linear"** (Reviewed column, sess_1776031535469, Complexity 7): Needed for Linear `syncPlanContent()` support. If not merged, Linear continuous sync should be disabled with graceful fallback to ClickUp-only. The `LinearSyncService.graphqlRequest()` helper already exists — only the `syncPlanContent` method is new.
  - **[CONFLICT RISK] "Remove ClickUp Automation Technical Debt"** (Reviewed column, sess_1776025643864, Complexity 6): May refactor `ClickUpSyncService` interfaces. Verify `httpRequest()` method signature and `syncPlan()` interface after that plan merges. If `httpRequest` is renamed or signature changes, `syncPlanContent()` must be updated.
  - **[NO CONFLICT] "Fix Duplicate Switchboard State Parsing Bug"** (New column, sess_1776029097785, Complexity 6): No overlap — this is a parsing bug, not sync-related.
  - **[NO CONFLICT] Other Reviewed plans**: The remaining 50+ plans in Reviewed column are already implemented and do not affect this plan's target files.

## Adversarial Synthesis

### Grumpy Critique

Oh wonderful, we're going to hammer external APIs with every keystroke now. Let me point out the disaster scenarios:

1. **The rate limit death spiral.** User has 20 plans in `INVESTIGATION`. Agents are actively working on all of them. With 30-second sync intervals, that's 40 API calls per minute minimum. ClickUp's limit is ~100 req/min. Add some column moves, automation polling, and manual syncs — suddenly we're rate-limited and nothing works. The plan mentions rate limiting but doesn't specify *how* the global quota is tracked across services with different limits (ClickUp 100 vs Linear 250).

2. **Conflict detection is expensive.** The plan says "fetch current description, hash it, compare." That's an extra API call *per sync* just to check for conflicts. So now every 30-second sync requires 2 API calls: one to fetch, one to update. We're doubling the quota usage with no clear benefit — external edits during agent work are rare, but we're paying the cost every sync.

3. **File watcher cleanup is hard.** VS Code's `FileSystemWatcher` doesn't watch gitignored directories reliably. The codebase already uses `fs.watch` fallbacks in 3 places (`TaskViewerProvider`, `KanbanProvider`, `InboxWatcher`). Each has subtle bugs with watcher reuse, event duplication, and cleanup on workspace switch. Now we're adding a 4th watcher system that must stay in sync with the mode toggle state. Leaked watchers = memory leaks and ghost syncs after mode change.

4. **Content hashing ignores images.** Plan files can embed base64-encoded images (some users paste screenshots). A 5MB base64 image in markdown will be read, hashed, and potentially synced every 30 seconds. The hash computation is fast, but the API call with 5MB payload is not. No mention of size limits or image exclusion.

5. **No clear termination on agent crash.** If the agent process dies, the plan file stops changing. Live sync keeps polling (unnecessarily) until user manually pauses or plan moves to `COMPLETED`. Wasted API calls for stale plans.

6. **Conflict UI is underspecified.** "Show conflict warning and pause sync" — where? How does user resolve? Does Switchboard offer merge, overwrite, or ignore options? This is a whole UX feature, not a throwaway line.

7. **🚨 The file pattern regex is WRONG.** *(Added during plan improvement review)* `_handleFileChange` uses `fileName.match(/^plan_(\w+)\.md$/)` to extract session IDs. I looked at the actual `.switchboard/plans/` directory: files are named `add_continuous_file_sync_for_live_plan_updates.md`, `brain_11d10e198a25f4540d20157465187f8dd22a6a3418b0413a173110f52db5a617.md`, `clickup_1_foundation.md`. **Zero** files match `plan_*.md`. This regex would silently match nothing, and live sync would never fire. A beautiful no-op feature.

8. **🚨 Phantom method references.** *(Added during plan improvement review)* The KanbanProvider integration code references `_pendingSelfWrites` (a Set that doesn't exist in the codebase) and `_refreshBoardWithData` (the actual method is `refreshWithData` at line 475). The plan also calls `this._continuousSync.getAllStates?.()` but ContinuousSyncService only defines `getState(sessionId)` — no `getAllStates()`. These would all be compile errors.

9. **🚨 Missing operation mode infrastructure.** *(Added during plan improvement review)* The `setOperationMode` method referenced in section 3 doesn't exist. `KanbanProvider` has zero concept of operation modes. The "Add Operation Mode Toggle" plan (sess_1776049260864) in the Planned column is a hard blocker. Without it, there's nowhere to wire start/stop.

### Balanced Response

The Grumpy critique identifies nine issues (6 original + 3 new from codebase verification). Here's how the implementation addresses each:

1. **Rate limit death spiral**: Implement a `RateLimitTracker` class that tracks remaining quota per service (ClickUp 100/min, Linear 250/min). Syncs are queued in a priority queue; if quota exhausted, queue flushes when window resets. Exponential backoff on 429 responses. Global sync concurrency limited to 3 parallel syncs across all plans. **Clarification:** Parse `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers from ClickUp HTTP responses in `httpRequest()` to populate tracker state. Linear provides rate info in GraphQL response `extensions.rateLimit` field.

2. **Conflict detection cost**: Make conflict detection **opt-in per plan** or **batched**. Default behavior: only check for conflicts when user explicitly requests ("Check for external edits" button). Optionally enable automatic conflict checks every N syncs (e.g., every 5th sync) to balance safety vs. cost. Document that automatic conflict detection doubles API usage.

3. **File watcher cleanup**: Reuse existing `_planContentWatcher` from `KanbanProvider` (line 422) — it already watches `.switchboard/plans/**/*.md`. Hook into its `onDidChange` event via a new `_planFileChangeEmitter: EventEmitter<vscode.Uri>` instead of creating a new watcher. This eliminates the 4th watcher system entirely. On mode change to Coding Mode, simply unsubscribe from the event; no watcher cleanup needed.

4. **Content size limits**: Add a 100KB content limit for live sync. If plan content exceeds 100KB, live sync pauses and shows warning: "Plan too large for live sync — switch to completion-only mode." This excludes image-heavy plans from hammering APIs.

5. **Agent crash detection**: Track `mtime` (file modification time) of watched plans. If `mtime` hasn't changed in 5 minutes, reduce sync interval to 5 minutes (back off). If `mtime` hasn't changed in 30 minutes, pause live sync and show "Agent idle — sync paused" indicator. User can resume manually.

6. **Conflict resolution UI**: Keep it simple. On conflict detection, show modal dialog with three options: (a) "Overwrite external" — Switchboard content wins, resume sync, (b) "Accept external" — fetch external content into plan file, pause sync, (c) "Pause and review" — manual resolution. Store choice in `LiveSyncState.conflictResolution`.

7. **File pattern regex fix**: **Remove the broken regex entirely.** Replace with `KanbanDatabase.getPlanByPlanFile(uri.fsPath, workspaceId)` — the exact same pattern already used by the existing `_planContentWatcher.onDidChange` handler at line 435-439 of `KanbanProvider.ts`. This correctly resolves any plan filename to its session ID via the database, regardless of naming convention.

8. **Phantom method references**: (a) Remove all references to `_pendingSelfWrites` — it doesn't exist. The existing self-write guard is `ClickUpSyncService._isSyncInProgress`. (b) Rename `_refreshBoardWithData` → `refreshWithData` (line 475). (c) Add `getAllStates(): Map<string, LiveSyncState>` method to `ContinuousSyncService` returning `this._states`.

9. **Operation mode dependency**: Document `setOperationMode` as a **forward reference** to the "Add Operation Mode Toggle" plan (sess_1776049260864). The `ContinuousSyncService` itself is self-contained — it has `start()` and `stop()` methods. The wiring into mode transitions is deferred to the mode toggle plan's implementation, with a note that it must call `_continuousSync.start(root)` on live-sync mode entry and `_continuousSync.stop()` on exit.

## Agent Recommendation

Send to Lead Coder (Complexity 7 ≥ 7)

## Proposed Changes

### 1. Add Live Sync Types and State

#### [CREATE] `src/models/LiveSyncTypes.ts`

**Context:** New type definitions for continuous sync state tracking. These types are shared between `ContinuousSyncService`, `KanbanProvider`, and the webview UI.

**Logic:**
- `LiveSyncStatus`: Enum of possible sync states per plan
- `LiveSyncState`: Per-plan state including content hash, last sync time, conflict info
- `LiveSyncConfig`: User configuration (interval, auto conflict check)

**Implementation:**

```typescript
export type LiveSyncStatus = 
  | 'idle'           // Plan eligible but not yet synced
  | 'active'         // Watching file, will sync on change
  | 'syncing'        // Sync in progress
  | 'paused'         // User paused or idle timeout
  | 'conflict'       // External edit detected
  | 'error'          // Sync failed (rate limit, network)
  | 'completed';     // Plan reached COMPLETED, sync stopped

export interface LiveSyncState {
  sessionId: string;
  status: LiveSyncStatus;
  lastContentHash: string;        // SHA-256 of plan markdown content
  lastExternalHash?: string;      // Hash of external task description (for conflict detection)
  lastSyncAt: number;             // Unix timestamp
  lastContentChangeAt: number;    // Unix timestamp of last file mtime change
  consecutiveErrors: number;
  conflictResolution?: 'overwrite' | 'accept-external' | 'manual';
}

export interface LiveSyncConfig {
  enabled: boolean;
  syncIntervalMs: number;           // Default: 30000 (30s)
  idleTimeoutMs: number;          // Default: 300000 (5min) → back off sync
  staleTimeoutMs: number;         // Default: 1800000 (30min) → pause sync
  maxContentSizeBytes: number;    // Default: 102400 (100KB)
  autoConflictCheckEvery: number; // Check conflicts every N syncs (0 = disabled)
  conflictCheckEnabled: boolean;  // Master toggle for conflict detection
}

export const DEFAULT_LIVE_SYNC_CONFIG: LiveSyncConfig = {
  enabled: false,
  syncIntervalMs: 30000,
  idleTimeoutMs: 300000,
  staleTimeoutMs: 1800000,
  maxContentSizeBytes: 102400,
  autoConflictCheckEvery: 0,      // Disabled by default (expensive)
  conflictCheckEnabled: true      // Allow manual conflict checks
};
```

**Edge Cases Handled:**
- `consecutiveErrors` tracking enables circuit breaker pattern — after 5 errors, status moves to 'error' and requires manual resume
- `lastContentChangeAt` separate from `lastSyncAt` enables idle detection (no content change = back off sync frequency)
- `maxContentSizeBytes` prevents large file sync abuse

### 2. Create Continuous Sync Service

#### [CREATE] `src/services/ContinuousSyncService.ts`

**Context:** Central service managing live sync for all plans in Board Management Mode. Reuses existing file watchers from `KanbanProvider` instead of creating new ones.

**Logic:**
- Subscribe to `KanbanProvider._planContentWatcher.onDidChange` events
- Maintain `Map<string, LiveSyncState>` of tracked plans
- Implement sync queue with rate limit awareness
- Implement idle detection via `mtime` polling (every 60s, lightweight)

**Implementation:**

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { KanbanProvider } from './KanbanProvider';
import type { ClickUpSyncService } from './ClickUpSyncService';
import type { LinearSyncService } from './LinearSyncService';
import type { KanbanDatabase } from './KanbanDatabase';
import type { LiveSyncState, LiveSyncConfig, LiveSyncStatus } from '../models/LiveSyncTypes';
import { DEFAULT_LIVE_SYNC_CONFIG } from '../models/LiveSyncTypes';

interface RateLimitWindow {
  service: 'clickup' | 'linear';
  remaining: number;
  resetAt: number;  // Unix timestamp when quota resets
}

export class ContinuousSyncService implements vscode.Disposable {
  private _states = new Map<string, LiveSyncState>();
  private _config: LiveSyncConfig = DEFAULT_LIVE_SYNC_CONFIG;
  private _rateLimits: Map<string, RateLimitWindow> = new Map();
  private _syncQueue: Array<{ sessionId: string; priority: number }> = [];
  private _activeSyncs = 0;
  private _maxConcurrentSyncs = 3;
  private _idleCheckTimer?: NodeJS.Timeout;
  private _disposables: vscode.Disposable[] = [];
  private _unsubscribeFromFileWatcher?: () => void;

  constructor(
    private readonly _kanbanProvider: KanbanProvider,
    private readonly _getClickUpService: (workspaceRoot: string) => ClickUpSyncService,
    private readonly _getLinearService: (workspaceRoot: string) => LinearSyncService,
    private readonly _getKanbanDb: (workspaceRoot: string) => KanbanDatabase
  ) {}

  /**
   * Start live sync monitoring. Called when entering Board Management Mode with live sync enabled.
   */
  public async start(workspaceRoot: string, config?: Partial<LiveSyncConfig>): Promise<void> {
    if (config) {
      this._config = { ...DEFAULT_LIVE_SYNC_CONFIG, ...config };
    }
    if (!this._config.enabled) {
      return;
    }

    // Subscribe to file watcher from KanbanProvider (reuse existing watcher)
    this._unsubscribeFromFileWatcher = this._kanbanProvider.onPlanFileChange(
      (uri) => this._handleFileChange(uri, workspaceRoot)
    );

    // Start idle detection timer (checks mtime every 60s)
    this._idleCheckTimer = setInterval(() => {
      void this._checkIdlePlans(workspaceRoot);
    }, 60000);

    // Load existing plans in active columns (INVESTIGATION, CODER, etc.)
    await this._initializeStatesForActivePlans(workspaceRoot);

    vscode.window.showInformationMessage('Live sync started — plans will sync to ClickUp/Linear every 30s when edited.');
  }

  /**
   * Stop live sync. Called when leaving Board Management Mode or disabling live sync.
   */
  public stop(): void {
    this._unsubscribeFromFileWatcher?.();
    this._unsubscribeFromFileWatcher = undefined;

    if (this._idleCheckTimer) {
      clearInterval(this._idleCheckTimer);
      this._idleCheckTimer = undefined;
    }

    // Cancel pending debounced syncs
    for (const state of this._states.values()) {
      if (state.status === 'syncing') {
        // Let active syncs complete; update status to paused
        this._states.set(state.sessionId, { ...state, status: 'paused' });
      }
    }

    vscode.window.showInformationMessage('Live sync stopped.');
  }

  /**
   * Get current state for a plan (for UI rendering).
   */
  public getState(sessionId: string): LiveSyncState | undefined {
    return this._states.get(sessionId);
  }

  /**
   * Get all tracked states (for bulk UI rendering on board refresh).
   */
  public getAllStates(): Map<string, LiveSyncState> {
    return new Map(this._states);
  }

  /**
   * User pauses live sync for a specific plan.
   */
  public pausePlan(sessionId: string): void {
    const state = this._states.get(sessionId);
    if (state) {
      this._states.set(sessionId, { ...state, status: 'paused' });
    }
  }

  /**
   * User resumes live sync for a specific plan.
   */
  public resumePlan(sessionId: string, workspaceRoot: string): void {
    const state = this._states.get(sessionId);
    if (state) {
      this._states.set(sessionId, { ...state, status: 'active', consecutiveErrors: 0 });
      // Trigger immediate sync check
      void this._scheduleSyncIfNeeded(sessionId, workspaceRoot);
    }
  }

  /**
   * User requests conflict check for a specific plan.
   */
  public async checkForConflicts(sessionId: string, workspaceRoot: string): Promise<boolean> {
    const state = this._states.get(sessionId);
    if (!state) return false;

    const plan = await this._getPlanRecord(sessionId, workspaceRoot);
    if (!plan) return false;

    const hasConflict = await this._detectExternalConflict(plan, state, workspaceRoot);
    if (hasConflict) {
      this._states.set(sessionId, { ...state, status: 'conflict' });
      await this._showConflictDialog(sessionId, workspaceRoot);
    }
    return hasConflict;
  }

  private async _handleFileChange(uri: vscode.Uri, workspaceRoot: string): Promise<void> {
    // Look up plan record by file path — same pattern as existing KanbanProvider
    // onDidChange handler (line 435-439). Plan files have varied naming conventions
    // (e.g. add_*.md, brain_*.md, clickup_*.md) — regex matching is unreliable.
    const db = this._getKanbanDb(workspaceRoot);
    const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
    if (!workspaceId) return;

    // Try absolute path first, then relative (DB may store either form)
    let plan = await db.getPlanByPlanFile(uri.fsPath, workspaceId);
    if (!plan) {
      const relativePath = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
      plan = await db.getPlanByPlanFile(relativePath, workspaceId);
    }
    if (!plan) return;

    const sessionId = plan.sessionId;

    // Only sync plans in eligible columns (not COMPLETED, not CREATED)
    const eligibleColumns = ['INVESTIGATION', 'PLAN REVIEWED', 'CODER CODED', 'LEAD REVIEW'];
    if (!eligibleColumns.includes(plan.kanbanColumn)) return;

    // Check if plan already tracked
    let state = this._states.get(sessionId);
    if (!state) {
      state = this._createInitialState(sessionId);
      this._states.set(sessionId, state);
    }

    // Update content change timestamp
    state = { ...state, lastContentChangeAt: Date.now() };

    // Check content size — guard against large base64-embedded images
    let content: string;
    try {
      content = await this._readPlanContent(plan.planFile, workspaceRoot);
    } catch (err) {
      // File may have been deleted between event firing and read
      console.warn(`[ContinuousSync] Failed to read plan file for ${sessionId}:`, err);
      return;
    }

    if (content.length > this._config.maxContentSizeBytes) {
      this._states.set(sessionId, { ...state, status: 'error' });
      vscode.window.showWarningMessage(`Plan "${plan.topic}" exceeds 100KB limit — live sync disabled for this plan.`);
      return;
    }

    // Compute hash
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    // If hash unchanged, no sync needed
    if (hash === state.lastContentHash) {
      this._states.set(sessionId, state);
      return;
    }

    // Update state and queue sync
    state = { ...state, lastContentHash: hash, status: 'active' };
    this._states.set(sessionId, state);

    // Debounce: schedule sync after interval
    void this._scheduleSyncIfNeeded(sessionId, workspaceRoot);
  }

  private async _scheduleSyncIfNeeded(sessionId: string, workspaceRoot: string): Promise<void> {
    const state = this._states.get(sessionId);
    if (!state || state.status !== 'active') return;

    const timeSinceLastSync = Date.now() - state.lastSyncAt;
    const delay = Math.max(0, this._config.syncIntervalMs - timeSinceLastSync);

    setTimeout(() => {
      void this._executeSync(sessionId, workspaceRoot);
    }, delay);
  }

  private async _executeSync(sessionId: string, workspaceRoot: string): Promise<void> {
    if (this._activeSyncs >= this._maxConcurrentSyncs) {
      // Queue for later
      const existing = this._syncQueue.find(q => q.sessionId === sessionId);
      if (!existing) {
        this._syncQueue.push({ sessionId, priority: Date.now() });
      }
      return;
    }

    const state = this._states.get(sessionId);
    if (!state || state.status !== 'active') return;

    this._activeSyncs++;
    this._states.set(sessionId, { ...state, status: 'syncing' });

    try {
      const plan = await this._getPlanRecord(sessionId, workspaceRoot);
      if (!plan) throw new Error('Plan not found');

      // Check rate limits
      const canProceed = await this._checkRateLimits(workspaceRoot);
      if (!canProceed) {
        // Re-queue
        setTimeout(() => {
          void this._executeSync(sessionId, workspaceRoot);
        }, 5000);
        return;
      }

      // Optional conflict check (expensive)
      if (this._config.autoConflictCheckEvery > 0) {
        const syncsSinceLastCheck = Math.floor((Date.now() - state.lastSyncAt) / this._config.syncIntervalMs);
        if (syncsSinceLastCheck >= this._config.autoConflictCheckEvery) {
          const hasConflict = await this._detectExternalConflict(plan, state, workspaceRoot);
          if (hasConflict) {
            this._states.set(sessionId, { ...state, status: 'conflict' });
            await this._showConflictDialog(sessionId, workspaceRoot);
            return;
          }
        }
      }

      // Perform sync
      const content = await this._readPlanContent(plan.planFile, workspaceRoot);
      await this._syncToClickUp(plan, content, workspaceRoot);
      await this._syncToLinear(plan, content, workspaceRoot);

      // Update state on success
      this._states.set(sessionId, {
        ...state,
        status: 'active',
        lastSyncAt: Date.now(),
        consecutiveErrors: 0
      });

      // Notify UI
      this._kanbanProvider.postMessage({
        type: 'liveSyncUpdate',
        sessionId,
        status: 'active',
        lastSyncAt: Date.now()
      });

    } catch (error) {
      const newErrorCount = state.consecutiveErrors + 1;
      const newStatus: LiveSyncStatus = newErrorCount >= 5 ? 'error' : 'active';

      this._states.set(sessionId, {
        ...state,
        status: newStatus,
        consecutiveErrors: newErrorCount
      });

      console.error(`[ContinuousSync] Failed to sync ${sessionId}:`, error);
    } finally {
      this._activeSyncs--;
      this._processQueue(workspaceRoot);
    }
  }

  private async _detectExternalConflict(
    plan: import('./KanbanDatabase').KanbanPlanRecord,
    state: LiveSyncState,
    workspaceRoot: string
  ): Promise<boolean> {
    try {
      let externalDescription = '';

      // Fetch current external task description
      if (plan.clickupTaskId) {
        const clickup = this._getClickUpService(workspaceRoot);
        // Use existing httpRequest to fetch task — same pattern as ClickUpSyncService line 445
        const result = await clickup.httpRequest('GET', `/task/${plan.clickupTaskId}`);
        if (result.status === 200 && result.data) {
          externalDescription = result.data.description || '';
        }
      } else if (plan.linearIssueId) {
        const linear = this._getLinearService(workspaceRoot);
        const result = await linear.graphqlRequest(
          `query ($id: String!) { issue(id: $id) { description } }`,
          { id: plan.linearIssueId }
        );
        externalDescription = result.data?.issue?.description || '';
      }

      if (!externalDescription) return false;

      const externalHash = crypto.createHash('sha256').update(externalDescription).digest('hex');

      // If we have a previous external hash, compare to detect external edits
      if (state.lastExternalHash && externalHash !== state.lastExternalHash) {
        return true; // External description changed since our last sync
      }

      // Update external hash for next comparison
      this._states.set(plan.sessionId, { ...state, lastExternalHash: externalHash });
      return false;
    } catch (err) {
      console.warn(`[ContinuousSync] Conflict check failed for ${plan.sessionId}:`, err);
      return false; // On error, assume no conflict (fail-open)
    }
  }

  private async _showConflictDialog(sessionId: string, workspaceRoot: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `Conflict detected for plan ${sessionId}. External task was edited.`,
      'Overwrite External',
      'Accept External',
      'Pause & Review'
    );

    const state = this._states.get(sessionId);
    if (!state) return;

    if (choice === 'Overwrite External') {
      this._states.set(sessionId, { ...state, status: 'active', conflictResolution: 'overwrite' });
    } else if (choice === 'Accept External') {
      // Fetch external content and update local plan file
      this._states.set(sessionId, { ...state, status: 'paused', conflictResolution: 'accept-external' });
    } else {
      this._states.set(sessionId, { ...state, status: 'paused', conflictResolution: 'manual' });
    }
  }

  private async _checkRateLimits(workspaceRoot: string): Promise<boolean> {
    // Check ClickUp rate limit
    const clickupLimit = this._rateLimits.get('clickup');
    if (clickupLimit && clickupLimit.remaining <= 0 && Date.now() < clickupLimit.resetAt) {
      return false;
    }

    // Check Linear rate limit
    const linearLimit = this._rateLimits.get('linear');
    if (linearLimit && linearLimit.remaining <= 0 && Date.now() < linearLimit.resetAt) {
      return false;
    }

    return true;
  }

  private async _syncToClickUp(
    plan: import('./KanbanDatabase').KanbanPlanRecord,
    content: string,
    workspaceRoot: string
  ): Promise<void> {
    if (!plan.clickupTaskId) return; // No ClickUp task linked to this plan
    const clickup = this._getClickUpService(workspaceRoot);
    const result = await clickup.syncPlanContent(plan.clickupTaskId, content);
    if (!result.success) {
      console.warn(`[ContinuousSync] ClickUp sync failed for ${plan.sessionId}: ${result.error}`);
      throw new Error(result.error);
    }
    // Update rate limit tracker from response headers (if available)
    // ClickUp returns X-RateLimit-Remaining and X-RateLimit-Reset
  }

  private async _syncToLinear(
    plan: import('./KanbanDatabase').KanbanPlanRecord,
    content: string,
    workspaceRoot: string
  ): Promise<void> {
    if (!plan.linearIssueId) return; // No Linear issue linked to this plan
    const linear = this._getLinearService(workspaceRoot);
    const result = await linear.syncPlanContent(plan.linearIssueId, content);
    if (!result.success) {
      console.warn(`[ContinuousSync] Linear sync failed for ${plan.sessionId}: ${result.error}`);
      throw new Error(result.error);
    }
  }

  private async _checkIdlePlans(workspaceRoot: string): Promise<void> {
    const now = Date.now();

    for (const [sessionId, state] of this._states.entries()) {
      if (state.status !== 'active') continue;

      const timeSinceContentChange = now - state.lastContentChangeAt;

      if (timeSinceContentChange > this._config.staleTimeoutMs) {
        // Stale — pause sync
        this._states.set(sessionId, { ...state, status: 'paused' });
        this._kanbanProvider.postMessage({
          type: 'liveSyncUpdate',
          sessionId,
          status: 'paused',
          reason: 'Agent idle for 30 minutes'
        });
      } else if (timeSinceContentChange > this._config.idleTimeoutMs) {
        // Idle — increase sync interval (back off) by updating state
        // Actual interval change happens in _scheduleSyncIfNeeded via lastSyncAt manipulation
      }
    }
  }

  private async _initializeStatesForActivePlans(workspaceRoot: string): Promise<void> {
    const db = this._getKanbanDb(workspaceRoot);
    const workspaceId = path.basename(workspaceRoot);
    const rows = await db.getBoard(workspaceId);

    const eligibleColumns = ['INVESTIGATION', 'PLAN REVIEWED', 'CODER CODED', 'LEAD REVIEW'];
    for (const row of rows) {
      if (eligibleColumns.includes(row.kanbanColumn)) {
        const state = this._createInitialState(row.sessionId);
        this._states.set(row.sessionId, state);
      }
    }
  }

  private _createInitialState(sessionId: string): LiveSyncState {
    return {
      sessionId,
      status: 'idle',
      lastContentHash: '',
      lastSyncAt: 0,
      lastContentChangeAt: 0,
      consecutiveErrors: 0
    };
  }

  private async _getPlanRecord(sessionId: string, workspaceRoot: string) {
    const db = this._getKanbanDb(workspaceRoot);
    return db.getPlanBySessionId(sessionId);
  }

  private async _readPlanContent(planFile: string, workspaceRoot: string): Promise<string> {
    const fullPath = path.isAbsolute(planFile) ? planFile : path.join(workspaceRoot, planFile);
    return fs.promises.readFile(fullPath, 'utf-8');
  }

  private _processQueue(workspaceRoot: string): void {
    if (this._syncQueue.length === 0 || this._activeSyncs >= this._maxConcurrentSyncs) {
      return;
    }

    // Sort by priority (oldest first)
    this._syncQueue.sort((a, b) => a.priority - b.priority);
    const next = this._syncQueue.shift();
    if (next) {
      void this._executeSync(next.sessionId, workspaceRoot);
    }
  }

  public dispose(): void {
    this.stop();
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
  }
}
```

**Edge Cases Handled:**
- **Max concurrent syncs**: `_maxConcurrentSyncs = 3` prevents API spam
- **Rate limit tracking**: `_rateLimits` Map tracks per-service quota windows
- **Queue draining**: `_processQueue` continues draining after each sync completes
- **Error circuit breaker**: 5 consecutive errors moves plan to 'error' status (manual resume required)
- **Content size guard**: 100KB limit enforced before hash computation
- **Plan file lookup via DB**: Uses `getPlanByPlanFile()` with absolute+relative path fallback (matches existing KanbanProvider pattern, no fragile regex)
- **ENOENT handling**: File read wrapped in try/catch to handle race between watcher event and file deletion
- **Graceful service skip**: `_syncToClickUp`/`_syncToLinear` check for `clickupTaskId`/`linearIssueId` presence and skip silently if plan isn't linked to that service

### 3. Extend KanbanProvider with Live Sync Integration

#### [MODIFY] `src/services/KanbanProvider.ts`

**Context:** `KanbanProvider` needs to:
1. Instantiate `ContinuousSyncService`
2. Expose `onPlanFileChange` event for the service to subscribe to
3. Handle `liveSyncUpdate` messages from service to webview
4. Start/stop live sync on mode changes

**Implementation — Add properties (near line ~112, after `_integrationAutoPull`):**

```typescript
private readonly _continuousSync: ContinuousSyncService;
private _planFileChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
public readonly onPlanFileChange = this._planFileChangeEmitter.event;
```

**Implementation — Instantiate in constructor (after `_integrationAutoPull` init):**

```typescript
this._continuousSync = new ContinuousSyncService(
  this,
  (root) => this._getClickUpService(root),
  (root) => this._getLinearService(root),
  (root) => this._getKanbanDb(root)
);
this._disposables.push(this._continuousSync);
```

**Implementation — Wire up file watcher event (in `_setupPlanContentWatcher`, line ~424):**

> **Clarification:** The existing `onDidChange` handler (lines 424-457) has NO `_pendingSelfWrites` guard
> and NO refresh debounce. It directly does ClickUp `debouncedSync`. We add a single line to emit
> the URI for the continuous sync service.

```typescript
// In _setupPlanContentWatcher(), inside the existing onDidChange handler (line 424):
this._planContentWatcher.onDidChange(async (uri) => {
  try {
    // === EXISTING LOGIC (lines 426-455) — ClickUp debouncedSync ===
    const clickUp = this._getClickUpService(workspaceRoot);
    const clickUpConfig = await clickUp.loadConfig();
    if (!clickUpConfig?.setupComplete) { return; }

    const db = this._getKanbanDb(workspaceRoot);
    const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
    if (!workspaceId) { return; }

    let plan = await db.getPlanByPlanFile(uri.fsPath, workspaceId);
    if (!plan) {
      const relativePath = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
      plan = await db.getPlanByPlanFile(relativePath, workspaceId);
    }
    if (!plan) { return; }

    clickUp.debouncedSync(plan.sessionId, {
      planId: plan.planId,
      sessionId: plan.sessionId,
      topic: plan.topic,
      planFile: plan.planFile,
      kanbanColumn: plan.kanbanColumn,
      status: plan.status,
      complexity: plan.complexity,
      tags: plan.tags,
      dependencies: plan.dependencies,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      lastAction: plan.lastAction
    });
  } catch { /* ClickUp sync failure must never block operations */ }

  // NEW: Emit for continuous sync service (single added line)
  this._planFileChangeEmitter.fire(uri);
});
```

**Implementation — Add live sync state to `refreshWithData` (line 475):**

> **Clarification:** The actual method is `refreshWithData` (line 475), not `_refreshBoardWithData`.
> Add live sync state broadcast after existing board data posting.

```typescript
// At the end of refreshWithData(), after the existing webview postMessage calls:
if (this._continuousSync) {
  const liveSyncStates: Array<[string, LiveSyncState]> = Array.from(
    this._continuousSync.getAllStates().entries()
  );
  this._panel?.webview.postMessage({
    type: 'liveSyncStates',
    states: liveSyncStates.map(([sessionId, state]) => ({ sessionId, ...state }))
  });
}
```

**Implementation — Handle mode transition with live sync:**

> **⚠️ FORWARD REFERENCE:** `setOperationMode` does NOT exist in the current codebase.
> This code is provided as a **specification** for the "Add Operation Mode Toggle" plan
> (sess_1776049260864), which is a **hard blocker**. That plan must create the mode
> infrastructure, then integrate these live sync hooks.

```typescript
// TO BE ADDED by the "Add Operation Mode Toggle" plan (sess_1776049260864).
// When that plan creates setOperationMode(), it must include these live sync hooks:
public async setOperationMode(mode: 'coding' | 'board-management' | 'live-sync'): Promise<void> {
  if (this._operationMode === mode) return;

  const previousMode = this._operationMode;
  this._operationMode = mode;
  await this._context.workspaceState.update(KanbanProvider.OPERATION_MODE_KEY, mode);

  // Stop previous mode behaviors
  if (previousMode === 'board-management' || previousMode === 'live-sync') {
    this._integrationAutoPull.stopAll();  // Stops automation polling
  }
  if (previousMode === 'live-sync') {
    this._continuousSync.stop();  // Stops file watchers and flushes pending syncs
  }

  // Start new mode behaviors
  if (mode === 'board-management') {
    await this._startAllAutomation();
  } else if (mode === 'live-sync') {
    await this._startAllAutomation();
    const roots = this._getWorkspaceRoots();
    for (const root of roots) {
      await this._continuousSync.start(root, { enabled: true });
    }
  }

  this._panel?.webview.postMessage({ type: 'operationModeChanged', mode });
}
```

**Edge Cases Handled:**
- Self-write guard prevents sync loops when Switchboard writes its own plan files
- Mode transitions cleanly stop/start appropriate services (no orphaned watchers)
- Live sync states sent to webview on every refresh for UI consistency

### 4. Add Kanban Card Live Sync UI

#### [MODIFY] `src/webview/kanban.html`

**Context:** Kanban cards need visual indicators for live sync status: pulsing dot when active, pause icon when paused, warning when conflict/error.

**Implementation — Add CSS (after line ~200):**

```css
.live-sync-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    margin-right: 6px;
}

.live-sync-indicator.active {
    background: #4ade80;  /* Green */
    animation: pulse 2s infinite;
}

.live-sync-indicator.paused {
    background: #fbbf24;  /* Amber */
}

.live-sync-indicator.error,
.live-sync-indicator.conflict {
    background: #f87171;  /* Red */
}

@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
}

.card-context-menu .menu-item[data-action="pauseLiveSync"],
.card-context-menu .menu-item[data-action="resumeLiveSync"] {
    display: flex;
    align-items: center;
    gap: 8px;
}
```

**Implementation — Add to card template (in `renderCard` function):**

```javascript
function renderCard(card) {
    const liveSyncState = window.liveSyncStates?.[card.sessionId];
    const showIndicator = liveSyncState && ['active', 'syncing', 'paused', 'error', 'conflict'].includes(liveSyncState.status);
    
    const indicatorHtml = showIndicator
        ? `<span class="live-sync-indicator ${liveSyncState.status}" title="Live Sync: ${liveSyncState.status}"></span>`
        : '';
    
    return `
        <div class="kanban-card" data-session-id="${card.sessionId}">
            <div class="card-header">
                ${indicatorHtml}
                <span class="card-title">${escapeHtml(card.topic)}</span>
            </div>
            <!-- ... rest of card ... -->
        </div>
    `;
}
```

**Implementation — Add context menu items (in card context menu handler):**

```javascript
case 'cardContextMenu': {
    const { sessionId, x, y } = message;
    const card = findCard(sessionId);
    const liveSyncState = window.liveSyncStates?.[sessionId];
    
    const menuItems = [
        { label: 'View Plan', action: 'viewPlan', sessionId },
        { label: 'Move Column', action: 'moveColumn', sessionId },
        // ... other items ...
    ];
    
    // Add live sync controls if in live-sync mode
    if (liveSyncState) {
        if (liveSyncState.status === 'active' || liveSyncState.status === 'syncing') {
            menuItems.push({ label: '⏸ Pause Live Sync', action: 'pauseLiveSync', sessionId });
        } else if (liveSyncState.status === 'paused' || liveSyncState.status === 'error') {
            menuItems.push({ label: '▶ Resume Live Sync', action: 'resumeLiveSync', sessionId });
        }
        if (liveSyncState.status === 'conflict') {
            menuItems.push({ label: '⚠ Resolve Conflict...', action: 'resolveConflict', sessionId });
        }
    }
    
    showContextMenu(x, y, menuItems);
    break;
}

// Handle live sync actions
case 'pauseLiveSync': {
    postKanbanMessage({ type: 'pauseLiveSync', sessionId: message.sessionId });
    break;
}
case 'resumeLiveSync': {
    postKanbanMessage({ type: 'resumeLiveSync', sessionId: message.sessionId });
    break;
}
```

**Implementation — Handle `liveSyncUpdate` message from extension:**

```javascript
case 'liveSyncUpdate': {
    window.liveSyncStates = window.liveSyncStates || {};
    window.liveSyncStates[message.sessionId] = {
        status: message.status,
        lastSyncAt: message.lastSyncAt,
        reason: message.reason
    };
    // Re-render affected card
    const card = findCard(message.sessionId);
    if (card) {
        updateCardElement(card);
    }
    break;
}

case 'liveSyncStates': {
    // Bulk update on board refresh
    window.liveSyncStates = {};
    for (const state of message.states) {
        window.liveSyncStates[state.sessionId] = state;
    }
    renderBoard();  // Full re-render to show all indicators
    break;
}
```

**Edge Cases Handled:**
- Indicators only shown for plans with live sync state (not all cards)
- Context menu items dynamically shown based on current status
- Bulk state update on refresh ensures UI consistency after reload

### 5. Add Setup Panel Configuration

#### [MODIFY] `src/webview/setup.html`

**Context:** Add live sync configuration controls to Project Management accordion.

**Implementation — Add after mode toggle buttons in Project Management section:**

```html
<div class="startup-section">
    <div class="section-label">Live Sync Configuration</div>
    
    <div class="field-row">
        <label class="toggle-switch">
            <input type="checkbox" id="live-sync-enabled" />
            <span class="toggle-slider"></span>
            Enable Live Sync (continuous updates to ClickUp/Linear)
        </label>
    </div>
    
    <div class="field-row" id="live-sync-options" style="display: none;">
        <label>Sync Interval (seconds)</label>
        <select id="live-sync-interval">
            <option value="10">10s (fast)</option>
            <option value="30" selected>30s (default)</option>
            <option value="60">60s (conservative)</option>
            <option value="300">5min (minimal)</option>
        </select>
        
        <label class="toggle-switch">
            <input type="checkbox" id="live-sync-conflict-check" />
            <span class="toggle-slider"></span>
            Auto-check for external edits (doubles API usage)
        </label>
        
        <div class="help-text">
            Conflict detection fetches external task content before each sync to detect manual edits in ClickUp/Linear. Expensive but prevents overwriting external changes.
        </div>
    </div>
</div>
```

**Implementation — Add JavaScript handlers:**

```javascript
// On accordion open / settings load
case 'liveSyncConfig': {
    document.getElementById('live-sync-enabled').checked = message.enabled;
    document.getElementById('live-sync-interval').value = String(Math.round(message.syncIntervalMs / 1000));
    document.getElementById('live-sync-conflict-check').checked = message.conflictCheckEnabled;
    updateLiveSyncOptionsVisibility();
    break;
}

// Toggle handlers
document.getElementById('live-sync-enabled').addEventListener('change', (e) => {
    vscode.postMessage({ type: 'saveLiveSyncConfig', enabled: e.target.checked });
    updateLiveSyncOptionsVisibility();
});

document.getElementById('live-sync-interval').addEventListener('change', (e) => {
    vscode.postMessage({ type: 'saveLiveSyncConfig', syncIntervalMs: parseInt(e.target.value) * 1000 });
});

function updateLiveSyncOptionsVisibility() {
    const enabled = document.getElementById('live-sync-enabled').checked;
    document.getElementById('live-sync-options').style.display = enabled ? 'block' : 'none';
}
```

**Edge Cases Handled:**
- Options hidden when live sync disabled (progressive disclosure)
- Clear warning about conflict detection cost
- Sensible default (30s) with options for different use cases

### 6. Add ClickUp/Linear Content Sync Methods

#### [MODIFY] `src/services/ClickUpSyncService.ts`

**Context:** Add method to sync plan content to ClickUp task description without changing status/column.

**Implementation — Add after `syncPlan` (line ~842):**

```typescript
/**
 * Sync plan markdown content to ClickUp task description.
 * Used by ContinuousSyncService for live updates.
 * Does NOT change task status, list, or custom fields.
 */
async syncPlanContent(taskId: string, markdownContent: string): Promise<{ success: boolean; error?: string }> {
  try {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      return { success: false, error: 'ClickUp not set up' };
    }

    // Convert markdown to ClickUp description format (if needed)
    // ClickUp API accepts markdown directly in description field
    const response = await this.httpRequest('PUT', `/task/${taskId}`, {
      description: markdownContent
    });

    if (response.status === 200) {
      return { success: true };
    } else {
      return { success: false, error: `ClickUp API error: ${response.status}` };
    }
  } catch (error) {
    return { success: false, error: `Sync failed: ${error}` };
  }
}
```

**Edge Cases Handled:**
- Separate from `syncPlan` to avoid side effects (column moves, status changes)
- Direct task ID parameter (no lookup needed — ContinuousSyncService has plan with clickupTaskId)
- Error handling consistent with existing sync methods

#### [MODIFY] `src/services/LinearSyncService.ts`

**Context:** Add similar method for Linear. Linear uses GraphQL API with different content format. Must use the **existing `graphqlRequest` helper** (line 192) — NOT raw `fetch`. The helper already handles token management, error formatting, and timeouts.

**Implementation — Add after `syncPlan` (line ~367):**

```typescript
/**
 * Sync plan markdown content to Linear issue description.
 * Used by ContinuousSyncService for live updates.
 * Does NOT change issue state or other fields.
 */
async syncPlanContent(issueId: string, markdownContent: string): Promise<{ success: boolean; error?: string }> {
  try {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      return { success: false, error: 'Linear not set up' };
    }

    // Use existing graphqlRequest helper (line 192) — handles token, timeouts, error formatting
    const mutation = `
      mutation UpdateIssueDescription($id: String!, $description: String!) {
        issueUpdate(id: $id, input: { description: $description }) {
          success
          issue { id }
        }
      }
    `;

    const result = await this.graphqlRequest(mutation, {
      id: issueId,
      description: markdownContent
    });

    if (result.data?.issueUpdate?.success) {
      return { success: true };
    } else {
      return { success: false, error: 'Linear issueUpdate returned success=false' };
    }
  } catch (error) {
    return { success: false, error: `Sync failed: ${error}` };
  }
}
```

**Edge Cases Handled:**
- Uses existing `graphqlRequest` helper — no duplicated HTTP/auth logic
- Same separation of concerns as ClickUp version
- Graceful error wrapping consistent with existing LinearSyncService methods

## Verification Plan

### Manual Testing

1. **Enable live sync**: Enter Board Management Mode → enable Live Sync in setup panel → verify "Live sync started" notification.
2. **Edit plan file**: Open a plan in `INVESTIGATION` → add text → save → verify green pulse indicator appears on Kanban card within 30s.
3. **Check external update**: View same task in ClickUp/Linear → verify description matches plan content.
4. **Pause sync**: Right-click card → Pause Live Sync → verify amber indicator → edit plan → verify external task NOT updated.
5. **Resume sync**: Right-click card → Resume Live Sync → verify green indicator returns.
6. **Conflict simulation**: Edit task description directly in ClickUp → in Switchboard, click "Check for external edits" → verify conflict dialog appears.
7. **Overwrite external**: Choose "Overwrite External" in conflict dialog → verify Switchboard content replaces ClickUp content.
8. **Idle timeout**: Leave plan untouched for 30 minutes → verify indicator changes to "paused" with "Agent idle" tooltip.
9. **Large file guard**: Create plan with >100KB content (paste large base64 image) → verify warning message and sync disabled for that plan.
10. **Rate limit handling**: Rapidly edit 5+ plans simultaneously → verify syncs queue and complete without 429 errors.
11. **Mode transition**: Switch from Live Sync Mode to Coding Mode → verify live sync stops (no more updates to external tasks).
12. **Reload persistence**: Reload VS Code window while in Live Sync Mode → verify live sync resumes automatically with correct states.

### Automated Tests

#### New test file: `src/test/continuous-sync.test.ts`

- **`ContinuousSyncService.start/stop`**: Verify service initializes states, subscribes to file watcher, starts idle timer. Verify stop cleans up all resources.
- **`_handleFileChange` filtering**: Send watcher event for non-plan file → verify ignored. Send event for plan in `COMPLETED` column → verify ignored. Send event for eligible plan → verify state created and sync queued.
- **Content size limit**: Create plan file >100KB → verify status set to 'error' and sync not queued.
- **Debounce behavior**: Fire 5 file change events in 5 seconds → verify only one sync executes after 30s interval.
- **Idle detection**: Mock `mtime` unchanged for 5 minutes → verify sync interval backed off. Mock 30 minutes unchanged → verify status changed to 'paused'.
- **Rate limit tracking**: Mock rate limit headers (ClickUp: remaining=0, resetAt=future) → verify syncs queued but not executed until window resets.
- **Conflict detection (manual)**: Mock external API returning different description hash → verify conflict dialog triggered.
- **Error circuit breaker**: Mock 5 consecutive sync failures → verify status moves to 'error' and requires manual resume.
- **Multi-plan queue**: Queue 10 plans for sync with `_maxConcurrentSyncs=3` → verify 3 execute immediately, 7 wait in queue, queue drains correctly.

### Integration Tests

- **End-to-end live sync**: Create plan → enable live sync → edit plan file → verify ClickUp task description updated within 60s.
- **Conflict resolution flow**: Edit task in ClickUp → trigger conflict check in Switchboard → verify dialog → choose overwrite → verify content replaced.

## Documentation Updates

### README.md Addition

```markdown
### Live Sync Mode

Live Sync Mode continuously updates ClickUp/Linear task descriptions as you edit plans in Switchboard. Unlike Board Management Mode (which only writes back at completion), Live Sync shows stakeholders real-time progress.

**How it works:**
- Switchboard watches plan files for changes
- Every 30 seconds (configurable), updated content syncs to external task
- Visual indicator on Kanban cards shows sync status (green=pulsing, amber=paused, red=conflict/error)
- Right-click any card to pause/resume live sync

**Rate limiting:**
- ClickUp: ~100 requests/minute
- Linear: ~250 requests/minute
- Built-in queuing prevents quota exhaustion

**Conflict detection:**
- Optional: fetches external content before sync to detect manual edits
- Disabled by default (expensive — doubles API usage)
- When conflict detected: choose to overwrite external, accept external, or pause and review

**Termination conditions:**
- Live sync stops when plan reaches `COMPLETED`
- Pauses automatically after 30 minutes of no edits (agent idle detection)
- User can pause/resume any time via card context menu
```

## Review Update (2026-04-13)

### Fixed Items
- Fixed the `ContinuousSyncService` watcher subscription typing/runtime cleanup so the extension compiles again and repeated starts do not accumulate stale watcher/timer state.
- Wired live sync startup to the saved `.switchboard/state.json` configuration through `KanbanProvider.applyLiveSyncConfig()`, so enabling live sync now actually starts the service in Coding Mode instead of silently no-oping behind the default disabled config.
- Fixed `TaskViewerProvider.handleSaveLiveSyncConfig()` to merge partial UI updates instead of clobbering previously saved settings on every checkbox/select change.
- Fixed active-plan initialization in `ContinuousSyncService` to resolve the real workspace ID from `KanbanDatabase` instead of incorrectly using `path.basename(workspaceRoot)`.
- Added an inline Kanban pause/resume control wired to `pauseLiveSync` / `resumeLiveSync` messages so per-plan manual control now exists even though the planned context-menu UX is still not implemented.
- Fixed live-sync scheduling so repeated saves debounce per plan instead of stacking overlapping timers/syncs, and added in-flight rescheduling guards so a second save during an active sync triggers one follow-up sync instead of racing the same plan twice.
- Fixed conflict baseline handling so successful syncs update `lastExternalHash`, preventing false-positive conflicts on the next auto-check, and implemented the "Accept External" branch to write the external description back into the local plan file before pausing sync.

### Files Changed
- `src/services/ContinuousSyncService.ts`
- `src/services/KanbanProvider.ts`
- `src/services/TaskViewerProvider.ts`
- `src/webview/kanban.html`

### Validation Results
- `npm run compile` ✅
- `npm run compile-tests` ✅
- `npm run lint` ⚠️ Fails before/after this review because the repo currently has no ESLint v9 flat config (`eslint.config.js`), so lint cannot load a project config.

### Remaining Risks / Follow-ups
- Rate-limit tracking is still skeletal: the queue exists, but ClickUp/Linear response metadata is not yet parsed back into `_rateLimits`, so quota protection is not fully implemented.
- Conflict resolution remains basic: "Accept External" now writes the remote description into the plan file, but there is still no richer merge/review UX beyond overwrite, accept, or pause.
- The plan called for card context-menu actions; this pass added inline pause/resume controls instead of a true context-menu implementation.
