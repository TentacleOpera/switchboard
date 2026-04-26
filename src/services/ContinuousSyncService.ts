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
  private _fileWatcherSubscription?: vscode.Disposable;
  private _inFlightSessions = new Set<string>();
  private _resyncAfterCurrent = new Set<string>();
  private _serviceEnabled = false;
  private _activeControllers = new Map<string, AbortController>();
  // Per-session monotonic epoch. Bumped at sync start, watchdog recovery,
  // pause, and teardown. State-mutating writes inside _executeSync guard on
  // their captured epoch so a late-resolving orphaned Promise cannot silently
  // overwrite the watchdog's 'error' state hours later.
  private _syncEpoch: Map<string, number> = new Map();
  // Tracks skip-toast messages already shown this runtime, so the
  // informational toast fires at most once per (sessionId, reason) pair.
  // Not persisted across extension reloads. Replaced the prior anti-pattern
  // of pushing `{ [key]: true }` POJOs into `_disposables`, which would have
  // thrown on `dispose()` because plain objects have no `dispose` method.
  private _skipToastsShown: Set<string> = new Set();

  constructor(
    private readonly _kanbanProvider: KanbanProvider,
    private readonly _getClickUpService: (workspaceRoot: string) => ClickUpSyncService,
    private readonly _getLinearService: (workspaceRoot: string) => LinearSyncService,
    private readonly _getKanbanDb: (workspaceRoot: string) => KanbanDatabase
  ) {}

  /**
   * Start live sync monitoring for whichever integrations currently have realtime sync enabled.
   */
  public async start(
    workspaceRoot: string,
    config?: Partial<LiveSyncConfig>,
    options?: { notify?: boolean }
  ): Promise<void> {
    this._teardownRuntime();
    this._config = { ...DEFAULT_LIVE_SYNC_CONFIG, ...this._config, ...(config || {}) };
    if (!this._config.enabled) {
      this._serviceEnabled = false;
      this._states.clear();
      this._postStates();
      return;
    }

    this._serviceEnabled = true;
    this._states.clear();
    this._syncQueue = [];
    this._activeSyncs = 0;

    // Subscribe to file watcher from KanbanProvider (reuse existing watcher)
    this._fileWatcherSubscription = this._kanbanProvider.onPlanFileChange(
      (uri) => this._handleFileChange(uri, workspaceRoot)
    );

    // Start idle detection timer (checks mtime every 60s)
    this._idleCheckTimer = setInterval(() => {
      void this._checkIdlePlans(workspaceRoot);
    }, 60000);

    // Load existing plans in active columns (INVESTIGATION, CODER, etc.)
    await this._initializeStatesForActivePlans(workspaceRoot);
    this._postStates();

    if (options?.notify !== false) {
      vscode.window.showInformationMessage('Live sync started — plans will sync to enabled integrations when edited.');
    }
  }

  /**
   * Stop live sync after the global toggle is disabled or no integrations remain enabled.
   */
  public stop(notify = true): void {
    this._serviceEnabled = false;
    this._teardownRuntime();
    this._states.clear();
    this._syncQueue = [];
    this._activeSyncs = 0;
    this._postStates();

    if (notify) {
      vscode.window.showInformationMessage('Live sync stopped.');
    }
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
    // Bump epoch so any in-flight sync's late resolution cannot resurrect a
    // paused session back to 'active'.
    this._bumpEpoch(sessionId);

    const controller = this._activeControllers.get(sessionId);
    if (controller) {
      controller.abort('User paused sync');
    }

    const state = this._states.get(sessionId);
    if (state) {
      // Clear quiet timer and needsResync flag
      if (state.quietTimer) {
        clearTimeout(state.quietTimer);
      }
      this._states.set(sessionId, {
        ...state,
        status: 'paused',
        quietTimer: undefined,
        needsResync: false
      });
      this._kanbanProvider.postMessage({
        type: 'liveSyncUpdate',
        sessionId,
        status: 'paused',
        lastSyncAt: state.lastSyncAt
      });
    }
  }

  /**
   * User resumes live sync for a specific plan.
   */
  public resumePlan(sessionId: string, workspaceRoot: string): void {
    const state = this._states.get(sessionId);
    if (state) {
      this._states.set(sessionId, { ...state, status: 'active', consecutiveErrors: 0 });
      this._kanbanProvider.postMessage({
        type: 'liveSyncUpdate',
        sessionId,
        status: 'active',
        lastSyncAt: state.lastSyncAt
      });
      // Trigger immediate sync check
      void this._maybeSync(sessionId, workspaceRoot);
    }
  }

  /**
   * Reconcile live sync state when a plan's column changes.
   * Called by KanbanProvider after column updates to add/remove tracking.
   */
  public async onPlanColumnChange(
    sessionId: string,
    oldColumn: string,
    newColumn: string,
    workspaceRoot: string
  ): Promise<void> {
    if (!this._serviceEnabled) {
      return;
    }

    const plan = await this._getPlanRecord(sessionId, workspaceRoot);
    if (!plan) {
      return;
    }

    const isEligible = await this._isEligibleForLiveSync(plan, workspaceRoot);
    const currentState = this._states.get(sessionId);

    if (isEligible && !currentState) {
      // Plan newly eligible - create state and begin watching
      const state = this._createInitialState(sessionId);
      this._states.set(sessionId, state);
      this._postStates();
    } else if (!isEligible && currentState) {
      // Plan newly ineligible - flush pending sync, delete state, emit idle
      if (currentState.quietTimer) {
        clearTimeout(currentState.quietTimer);
      }
      this._states.delete(sessionId);
      this._kanbanProvider.postMessage({
        type: 'liveSyncUpdate',
        sessionId,
        status: 'idle',
        lastSyncAt: currentState.lastSyncAt
      });
      this._postStates();
    }
    // If eligibility unchanged, do nothing
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

  /**
   * Check if a plan is eligible for live sync based on integration configuration
   * and external issue mapping, not hardcoded column names.
   */
  private async _isEligibleForLiveSync(
    plan: import('./KanbanDatabase').KanbanPlanRecord,
    workspaceRoot: string
  ): Promise<boolean> {
    // Always skip terminal columns
    if (plan.kanbanColumn === 'COMPLETED' || plan.kanbanColumn === 'ARCHIVED') {
      return false;
    }

    // Check if at least one integration is realtime-enabled AND the plan has an external handle
    let linearOK = false;
    if (plan.linearIssueId) {
      const linear = this._getLinearService(workspaceRoot);
      const linearConfig = await linear.loadConfig();
      linearOK = linearConfig?.setupComplete === true && linearConfig.realTimeSyncEnabled === true;
    }

    let clickupOK = false;
    if (plan.clickupTaskId) {
      const clickup = this._getClickUpService(workspaceRoot);
      const clickupConfig = await clickup.loadConfig();
      clickupOK = clickupConfig?.setupComplete === true && clickupConfig.realTimeSyncEnabled === true;
    }

    return linearOK || clickupOK;
  }

  private async _handleFileChange(uri: vscode.Uri, workspaceRoot: string): Promise<void> {
    if (!this._serviceEnabled) {
      return;
    }

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

    // Check eligibility dynamically based on integration config and external issue mapping
    const isEligible = await this._isEligibleForLiveSync(plan, workspaceRoot);
    if (!isEligible) return;

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

    // Update state and queue sync with quiet-period debounce
    const now = Date.now();
    state = {
      ...state,
      lastContentHash: hash,
      status: 'active',
      lastContentChangeAt: now,
      firstPendingEditAt: state.firstPendingEditAt ?? now
    };

    // Clear existing quiet timer and start fresh
    if (state.quietTimer) {
      clearTimeout(state.quietTimer);
    }

    // Set quiet timer to fire after QUIET_MS of no further changes
    state.quietTimer = setTimeout(() => {
      void this._maybeSync(sessionId, workspaceRoot);
    }, this._config.quietMs);

    this._states.set(sessionId, state);

    // Check MAX_DEFER_MS ceiling - force sync if we've been editing continuously too long
    if (now - (state.firstPendingEditAt ?? now) > this._config.maxDeferMs) {
      void this._maybeSync(sessionId, workspaceRoot);
    }
  }

  /**
   * Two-timer sync scheduler: quiet-period debounce + rate-limit floor.
   * Called when quiet timer fires or when MAX_DEFER_MS ceiling is hit.
   */
  private async _maybeSync(sessionId: string, workspaceRoot: string): Promise<void> {
    if (!this._serviceEnabled) return;

    const state = this._states.get(sessionId);
    if (!state || state.status !== 'active') return;

    // If sync is in-flight, set needsResync flag and return
    if (state.inFlight) {
      this._states.set(sessionId, { ...state, needsResync: true });
      return;
    }

    // Rate-limit floor: ensure minimum time between syncs
    const now = Date.now();
    const floor = state.lastSyncAt + this._config.minIntervalMs - now;
    if (floor > 0) {
      // Defer until floor is reached
      setTimeout(() => {
        void this._maybeSync(sessionId, workspaceRoot);
      }, floor);
      return;
    }

    // Clear quiet timer since we're about to sync
    if (state.quietTimer) {
      clearTimeout(state.quietTimer);
    }

    // Execute sync
    void this._executeSync(sessionId, workspaceRoot);
  }

  private async _executeSync(sessionId: string, workspaceRoot: string): Promise<void> {
    if (!this._serviceEnabled) {
      return;
    }

    if (this._inFlightSessions.has(sessionId)) {
      this._resyncAfterCurrent.add(sessionId);
      return;
    }

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

    this._inFlightSessions.add(sessionId);
    this._activeSyncs++;
    // Mark syncStartedAt NOW so the stall watchdog measures elapsed time against
    // the current in-flight sync, not the last successful sync (which may be 0
    // for a plan that has never synced and would otherwise trip the watchdog
    // instantly). lastSyncAt is only updated on successful completion.
    this._states.set(sessionId, { ...state, status: 'syncing', syncStartedAt: Date.now(), inFlight: true });
    const myEpoch = this._bumpEpoch(sessionId);

    const controller = new AbortController();
    this._activeControllers.set(sessionId, controller);
    // Track whether this sync was aborted (covers timeout, pause, and teardown)
    // — we cannot rely on the raised error's message because wrappers like
    // syncPlanContent stringify the error into a generic "Sync failed: ..." form
    // that loses the `AbortError` name.
    let wasAborted = false;
    controller.signal.addEventListener('abort', () => { wasAborted = true; }, { once: true });

    // 30 second hard timeout for the entire sync operation
    const timeoutId = setTimeout(() => {
      controller.abort('Sync operation timed out after 30s');
    }, 30000);

    try {
      const plan = await this._getPlanRecord(sessionId, workspaceRoot);
      if (!plan) throw new Error('Plan not found');

      // Check rate limits
      const canProceed = await this._checkRateLimits(workspaceRoot);
      if (!canProceed) {
        // Rate limited — revert to 'active' so the stall watchdog doesn't
        // mistake us for a hung sync, and re-queue after a short backoff.
        const rlState = this._states.get(sessionId) ?? state;
        this._states.set(sessionId, { ...rlState, status: 'active', syncStartedAt: undefined });
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

      // Perform sync — only to the active provider, not both. Syncing both
      // doubles the hang risk and spends rate-limit budget on disabled
      // providers.
      const content = await this._readPlanContent(plan.planFile, workspaceRoot);

      // Defensive optional chaining: vscode.workspace may be unavailable in
      // unit-test harnesses that stub only a minimal vscode surface. Without
      // this guard, _executeSync throws before reaching the sync call and
      // every existing regression test fails at the first assertion.
      const folderUri = vscode.workspace?.workspaceFolders?.find((folder) =>
        path.resolve(folder.uri.fsPath) === path.resolve(workspaceRoot)
      )?.uri;
      const preferredProvider = vscode.workspace?.getConfiguration
        ? vscode.workspace
            .getConfiguration('switchboard', folderUri)
            .get<'linear' | 'clickup'>('integrations.preferredProvider') || 'linear'
        : 'linear';

      let syncResult;
      if (preferredProvider === 'clickup') {
        syncResult = await this._syncToClickUp(plan, content, workspaceRoot, controller.signal);
      } else {
        syncResult = await this._syncToLinear(plan, content, workspaceRoot, controller.signal);
      }

      // Handle skip results - map to UI states and emit one-shot toasts
      if (syncResult.skipped) {
        if (!this._serviceEnabled) {
          return;
        }

        const currentState = this._states.get(sessionId) ?? state;
        // Map skip reason to UI state
        let targetStatus: LiveSyncStatus = 'idle';
        if (syncResult.reason?.includes('disabled')) {
          targetStatus = 'idle';
        } else if (syncResult.reason?.includes('linked')) {
          targetStatus = 'error';
        } else {
          targetStatus = 'paused';
        }

        // Emit one-shot informational toast for first-time skip.
        // Tracked in a Set keyed by (sessionId, reason) so a given plan's
        // skip reason surfaces exactly once per extension runtime.
        const skipToastKey = `skip_${sessionId}_${syncResult.reason}`;
        if (!this._skipToastsShown.has(skipToastKey)) {
          this._skipToastsShown.add(skipToastKey);
          vscode.window.showInformationMessage(
            `Live sync skipped for "${plan.topic || sessionId}": ${syncResult.reason}. Enable real-time sync in Setup to activate.`
          );
        }

        // Update state and notify UI
        if (this._isCurrentEpoch(sessionId, myEpoch)) {
          this._states.set(sessionId, {
            ...currentState,
            status: targetStatus,
            syncStartedAt: undefined,
            inFlight: false
          });
          this._kanbanProvider.postMessage({
            type: 'liveSyncUpdate',
            sessionId,
            status: targetStatus,
            lastSyncAt: currentState.lastSyncAt
          });
        }
        return;
      }

      if (!this._serviceEnabled) {
        return;
      }

      // Epoch guard: if the watchdog recovered this session, or a pause/teardown
      // bumped the epoch, a late-resolving orphaned success must NOT overwrite
      // the newer state. Drop all writes and UI notifications silently.
      if (this._isCurrentEpoch(sessionId, myEpoch)) {
        const currentState = this._states.get(sessionId) ?? state;
        const lastContentHash = currentState.lastContentHash || state.lastContentHash;
        const now = Date.now();

        // Update state on success
        this._states.set(sessionId, {
          ...currentState,
          status: 'active',
          lastSyncAt: now,
          syncStartedAt: undefined,
          lastExternalHash: lastContentHash || currentState.lastExternalHash,
          consecutiveErrors: 0,
          timeoutWarningShown: false,
          inFlight: false,
          firstPendingEditAt: undefined,
          needsResync: false
        });

        // Notify UI
        this._kanbanProvider.postMessage({
          type: 'liveSyncUpdate',
          sessionId,
          status: 'active',
          lastSyncAt: now
        });
      }

    } catch (error: any) {
      if (!this._serviceEnabled) {
        return;
      }

      // Epoch guard: watchdog recovery / pause / teardown has already moved
      // this session on. Swallow the late rejection — do not overwrite state
      // or warn the user about an already-superseded sync.
      if (!this._isCurrentEpoch(sessionId, myEpoch)) {
        return;
      }

      const currentState = this._states.get(sessionId) ?? state;
      // Detect abort via the tracked flag OR by string-matching the (possibly
      // wrapped) error message — upstream helpers like syncPlanContent wrap
      // errors as "Sync failed: Error: AbortError", which loses `error.name`.
      const errMsg = typeof error?.message === 'string' ? error.message : String(error ?? '');
      const isTimeout = wasAborted || error?.name === 'AbortError' || /AbortError/.test(errMsg);
      const newErrorCount = currentState.consecutiveErrors + 1;

      // Do NOT overwrite a user-initiated 'paused' status or a terminal
      // 'conflict'/'completed' status that was set while the request was in
      // flight. pausePlan() aborts the controller and then sets 'paused' — the
      // catch handler would otherwise clobber that back to 'active'/'error'.
      // 'error' is treated as a protected/terminal state here because the
      // stall watchdog may have already transitioned this session into 'error'
      // and bumped consecutiveErrors; clobbering it would double-count.
      const protectedStatus = currentState.status === 'paused'
        || currentState.status === 'conflict'
        || currentState.status === 'completed'
        || currentState.status === 'error';
      const newStatus: LiveSyncStatus = protectedStatus
        ? currentState.status
        : (newErrorCount >= 5 ? 'error' : 'active');

      console.error(
        `[ContinuousSync] Sync failed for ${sessionId}:`,
        isTimeout ? (protectedStatus ? `Aborted (status=${currentState.status})` : 'Timeout exceeded') : error
      );

      // Surface a user-visible warning ONCE per error streak when a timeout
      // repeats. We wait for the 2nd consecutive timeout (single transient
      // failure is common and self-recovering) but still fire well before
      // the 5-strike `error` flip so the user isn't left staring at a
      // silently-retrying card. `timeoutWarningShown` is reset on the next
      // successful sync so subsequent streaks will warn again.
      const shouldWarnTimeout =
        isTimeout
        && !protectedStatus
        && newErrorCount >= 2
        && !currentState.timeoutWarningShown;

      this._states.set(sessionId, {
        ...currentState,
        status: newStatus,
        // Only bump error count when the abort was NOT user-initiated — a
        // user pause should not trip the 5-strike error threshold.
        consecutiveErrors: protectedStatus ? currentState.consecutiveErrors : newErrorCount,
        syncStartedAt: undefined,
        timeoutWarningShown: shouldWarnTimeout ? true : currentState.timeoutWarningShown,
        inFlight: false
      });

      if (shouldWarnTimeout) {
        // Plan name only — never include plan content or credentials in the
        // user-visible toast (see plan Security edge-case audit).
        const planName = await this._getPlanTopicSafe(sessionId, workspaceRoot);
        vscode.window.showWarningMessage(
          `Live sync for "${planName}" timed out. Will retry.`
        );
      }
    } finally {
      clearTimeout(timeoutId);
      this._activeControllers.delete(sessionId);
      // Only decrement _activeSyncs if this sync still owned the in-flight
      // slot — the stall watchdog may have already recovered the session and
      // decremented the counter, in which case a second decrement here would
      // desync the concurrency limiter.
      if (this._inFlightSessions.delete(sessionId)) {
        this._activeSyncs = Math.max(0, this._activeSyncs - 1);
      }

      if (!this._serviceEnabled) {
        return;
      }

      const shouldReschedule = this._resyncAfterCurrent.delete(sessionId);
      this._processQueue(workspaceRoot);
      if (shouldReschedule) {
        void this._maybeSync(sessionId, workspaceRoot);
      }

      // Handle needsResync flag - trigger fresh quiet window if changes arrived during sync
      const currentState = this._states.get(sessionId);
      if (currentState && currentState.needsResync && this._isCurrentEpoch(sessionId, myEpoch)) {
        this._states.set(sessionId, { ...currentState, needsResync: false });
        // Trigger file change logic to start fresh quiet window
        const plan = await this._getPlanRecord(sessionId, workspaceRoot);
        if (plan) {
          void this._handleFileChange(vscode.Uri.file(path.isAbsolute(plan.planFile) ? plan.planFile : path.join(workspaceRoot, plan.planFile)), workspaceRoot);
        }
      }

      // Notify UI of final state — but only if this sync is still current.
      // Otherwise a late settlement could overwrite the watchdog's 'error'
      // badge with our stale 'active'/'paused' status.
      if (this._isCurrentEpoch(sessionId, myEpoch)) {
        const currentState = this._states.get(sessionId);
        if (currentState) {
          this._kanbanProvider.postMessage({
            type: 'liveSyncUpdate',
            sessionId,
            status: currentState.status,
            lastSyncAt: currentState.lastSyncAt
          });
        }
      }
    }
  }

  private async _fetchExternalDescription(
    plan: import('./KanbanDatabase').KanbanPlanRecord,
    workspaceRoot: string
  ): Promise<string> {
    // Bound the watchdog's own external calls. Without this, a hung ClickUp
    // or Linear response here can prevent the stall watchdog itself from
    // recovering anything.
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10_000);

    try {
      if (plan.clickupTaskId) {
        const clickup = this._getClickUpService(workspaceRoot);
        const config = await clickup.loadConfig();
        if (config?.setupComplete === true && config.realTimeSyncEnabled === true) {
          const result = await clickup.httpRequest(
            'GET',
            `/task/${plan.clickupTaskId}`,
            undefined,
            10_000,
            controller.signal
          );
          if (result.status === 200 && result.data) {
            return result.data.description || '';
          }
        }
      }
      if (plan.linearIssueId) {
        const linear = this._getLinearService(workspaceRoot);
        const config = await linear.loadConfig();
        if (config?.setupComplete === true && config.realTimeSyncEnabled === true) {
          const result = await linear.graphqlRequest(
            `query ($id: String!) { issue(id: $id) { description } }`,
            { id: plan.linearIssueId },
            10_000,
            controller.signal
          );
          return result.data?.issue?.description || '';
        }
      }
      return '';
    } catch (err) {
      // Fail-open: timeout/network/abort → treat as "no external description
      // available", identical to today's semantics but now bounded.
      console.warn(
        `[ContinuousSync] _fetchExternalDescription bounded-error:`,
        err instanceof Error ? err.message : err
      );
      return '';
    } finally {
      clearTimeout(t);
    }
  }

  private async _detectExternalConflict(
    plan: import('./KanbanDatabase').KanbanPlanRecord,
    state: LiveSyncState,
    workspaceRoot: string
  ): Promise<boolean> {
    try {
      const externalDescription = await this._fetchExternalDescription(plan, workspaceRoot);
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

    const plan = await this._getPlanRecord(sessionId, workspaceRoot);
    if (!plan) {
      this._states.set(sessionId, { ...state, status: 'paused', conflictResolution: 'manual' });
      return;
    }

    if (choice === 'Overwrite External') {
      this._states.set(sessionId, { ...state, status: 'active', conflictResolution: 'overwrite' });
    } else if (choice === 'Accept External') {
      const externalDescription = await this._fetchExternalDescription(plan, workspaceRoot);
      if (!externalDescription) {
        this._states.set(sessionId, { ...state, status: 'paused', conflictResolution: 'accept-external' });
        vscode.window.showWarningMessage(`Unable to load external content for plan ${sessionId}.`);
        return;
      }

      const externalHash = crypto.createHash('sha256').update(externalDescription).digest('hex');
      const planPath = path.isAbsolute(plan.planFile) ? plan.planFile : path.join(workspaceRoot, plan.planFile);
      const acceptedState: LiveSyncState = {
        ...state,
        status: 'paused',
        conflictResolution: 'accept-external',
        lastContentHash: externalHash,
        lastExternalHash: externalHash,
        lastContentChangeAt: Date.now()
      };
      this._states.set(sessionId, acceptedState);
      try {
        await fs.promises.writeFile(planPath, externalDescription, 'utf-8');
      } catch (error) {
        this._states.set(sessionId, { ...state, status: 'paused', conflictResolution: 'manual' });
        vscode.window.showErrorMessage(`Failed to write external content back to plan ${sessionId}: ${error}`);
        return;
      }
      this._kanbanProvider.postMessage({
        type: 'liveSyncUpdate',
        sessionId,
        status: 'paused',
        reason: 'Accepted external changes'
      });
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
    workspaceRoot: string,
    signal?: AbortSignal
  ): Promise<{ skipped: boolean; reason?: string }> {
    const clickup = this._getClickUpService(workspaceRoot);
    const config = await clickup.loadConfig();
    if (!plan.clickupTaskId) {
      return { skipped: true, reason: 'No external issue linked' };
    }
    if (!config?.setupComplete) {
      return { skipped: true, reason: 'ClickUp not set up' };
    }
    if (config.realTimeSyncEnabled !== true) {
      return { skipped: true, reason: 'Real-time sync disabled' };
    }
    const result = await clickup.syncPlanContent(plan.clickupTaskId, content, signal);
    if (!result.success) {
      console.warn(`[ContinuousSync] ClickUp sync failed for ${plan.sessionId}: ${result.error}`);
      throw new Error(result.error);
    }
    // Update rate limit tracker from response headers (if available)
    // ClickUp returns X-RateLimit-Remaining and X-RateLimit-Reset
    return { skipped: false };
  }

  private async _syncToLinear(
    plan: import('./KanbanDatabase').KanbanPlanRecord,
    content: string,
    workspaceRoot: string,
    signal?: AbortSignal
  ): Promise<{ skipped: boolean; reason?: string }> {
    const linear = this._getLinearService(workspaceRoot);
    const config = await linear.loadConfig();
    if (!plan.linearIssueId) {
      return { skipped: true, reason: 'No external issue linked' };
    }
    if (!config?.setupComplete) {
      return { skipped: true, reason: 'Linear not set up' };
    }
    if (config.realTimeSyncEnabled !== true) {
      return { skipped: true, reason: 'Real-time sync disabled' };
    }
    const result = await linear.syncPlanContent(plan.linearIssueId, content, signal);
    if (!result.success) {
      console.warn(`[ContinuousSync] Linear sync failed for ${plan.sessionId}: ${result.error}`);
      throw new Error(result.error);
    }
    return { skipped: false };
  }

  private async _checkIdlePlans(workspaceRoot: string): Promise<void> {
    // Absolutely do not let the setInterval callback throw — the stall
    // watchdog MUST keep ticking even if a single session's state is corrupt.
    try {
      const now = Date.now();

      for (const [sessionId, state] of this._states.entries()) {
        try {
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
            // Actual interval change happens in _maybeSync via lastSyncAt manipulation
          }
        } catch (perSessionErr) {
          console.error(
            `[ContinuousSync] _checkIdlePlans per-session error (${sessionId}):`,
            perSessionErr
          );
        }
      }

      // Stall recovery MUST run every tick even if the loop above threw.
      try {
        this._recoverStalledSyncs();
      } catch (stallErr) {
        console.error(`[ContinuousSync] _recoverStalledSyncs threw:`, stallErr);
      }
    } catch (outerErr) {
      console.error(`[ContinuousSync] _checkIdlePlans outer error:`, outerErr);
    }
  }

  private _recoverStalledSyncs(): void {
    const now = Date.now();
    for (const [sessionId, state] of this._states.entries()) {
      if (state.status !== 'syncing') continue;

      // Stall window is measured from syncStartedAt (when the in-flight sync
      // began), not lastSyncAt (last successful sync) — otherwise a fresh plan
      // with lastSyncAt=0 would be marked stalled instantly, and any sync
      // whose previous success was >60s ago would be aborted the moment it
      // started. If syncStartedAt is missing (legacy state), fall back to
      // lastSyncAt but require it to be non-zero to avoid the 0-timestamp
      // instant-stall bug.
      const startedAt = state.syncStartedAt
        ?? (state.lastSyncAt > 0 ? state.lastSyncAt : now);
      if (now - startedAt <= 60000) continue;

      console.warn(`[ContinuousSync] Recovering stalled sync for session ${sessionId}`);

      // Bump epoch FIRST — any late settlement from the original _executeSync
      // call now fails the epoch check and becomes a silent no-op (no state
      // overwrite, no UI flip back to 'active').
      this._bumpEpoch(sessionId);

      // Force cleanup — abort any in-flight controller and drop tracking.
      this._activeControllers.get(sessionId)?.abort('Stall recovery');
      this._activeControllers.delete(sessionId);
      if (this._inFlightSessions.delete(sessionId)) {
        this._activeSyncs = Math.max(0, this._activeSyncs - 1);
      }

      // Clear the quiet-period debounce timer and the inFlight/needsResync
      // flags as part of recovery. Without this the recovered 'error' state
      // still carries `inFlight: true`, which blocks every subsequent
      // _maybeSync attempt (it defers, assuming a sync is still running).
      if (state.quietTimer) {
        clearTimeout(state.quietTimer);
      }
      this._states.set(sessionId, {
        ...state,
        status: 'error',
        consecutiveErrors: state.consecutiveErrors + 1,
        syncStartedAt: undefined,
        quietTimer: undefined,
        inFlight: false,
        needsResync: false
      });

      // Notify UI — include the last SUCCESSFUL sync timestamp, not now,
      // so the UI does not falsely advertise a fresh successful sync.
      this._kanbanProvider.postMessage({
        type: 'liveSyncUpdate',
        sessionId,
        status: 'error',
        lastSyncAt: state.lastSyncAt
      });
    }
  }

  private async _initializeStatesForActivePlans(workspaceRoot: string): Promise<void> {
    const db = this._getKanbanDb(workspaceRoot);
    const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
    if (!workspaceId) {
      return;
    }
    const rows = await db.getBoard(workspaceId);

    for (const row of rows) {
      const isEligible = await this._isEligibleForLiveSync(row, workspaceRoot);
      if (isEligible) {
        const state = this._createInitialState(row.sessionId);
        this._states.set(row.sessionId, state);
      }
    }
  }

  private _bumpEpoch(sessionId: string): number {
    const next = (this._syncEpoch.get(sessionId) ?? 0) + 1;
    this._syncEpoch.set(sessionId, next);
    return next;
  }

  private _isCurrentEpoch(sessionId: string, epoch: number): boolean {
    return this._syncEpoch.get(sessionId) === epoch;
  }

  private _createInitialState(sessionId: string): LiveSyncState {
    return {
      sessionId,
      status: 'idle',
      lastContentHash: '',
      lastSyncAt: 0,
      lastContentChangeAt: 0,
      consecutiveErrors: 0,
      inFlight: false,
      needsResync: false
    };
  }

  private async _getPlanRecord(sessionId: string, workspaceRoot: string) {
    const db = this._getKanbanDb(workspaceRoot);
    return db.getPlanBySessionId(sessionId);
  }

  /**
   * Look up a plan's topic for user-facing messages. Falls back to the
   * sessionId if the DB lookup fails or the topic is missing — we don't want
   * an error surfacing logic to itself throw. Caller must not pass the
   * returned string anywhere it could leak beyond the warning toast (topic
   * only, no content).
   */
  private async _getPlanTopicSafe(sessionId: string, workspaceRoot: string): Promise<string> {
    try {
      const plan = await this._getPlanRecord(sessionId, workspaceRoot);
      const topic = plan?.topic;
      if (typeof topic === 'string' && topic.trim().length > 0) {
        return topic;
      }
    } catch {
      // swallow — warning toast is best-effort.
    }
    return sessionId;
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

  private _teardownRuntime(): void {
    this._fileWatcherSubscription?.dispose();
    this._fileWatcherSubscription = undefined;

    // Clear quiet timers from all states
    for (const state of this._states.values()) {
      if (state.quietTimer) {
        clearTimeout(state.quietTimer);
      }
    }
    this._inFlightSessions.clear();
    this._resyncAfterCurrent.clear();

    // Abort all active controllers and bump epoch for every tracked session
    // so late settlements cannot resurrect state after teardown.
    for (const sessionId of this._activeControllers.keys()) {
      this._bumpEpoch(sessionId);
    }
    for (const controller of this._activeControllers.values()) {
      controller.abort('Service teardown');
    }
    this._activeControllers.clear();

    if (this._idleCheckTimer) {
      clearInterval(this._idleCheckTimer);
      this._idleCheckTimer = undefined;
    }
  }

  private _postStates(): void {
    this._kanbanProvider.postMessage({
      type: 'liveSyncStates',
      states: Array.from(this._states.values())
    });
  }

  public dispose(): void {
    this.stop();
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
  }
}
