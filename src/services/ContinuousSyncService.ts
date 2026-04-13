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
  private _pendingSyncTimers = new Map<string, NodeJS.Timeout>();
  private _inFlightSessions = new Set<string>();
  private _resyncAfterCurrent = new Set<string>();
  private _serviceEnabled = false;

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
    const state = this._states.get(sessionId);
    if (state) {
      this._states.set(sessionId, { ...state, status: 'paused' });
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
    if (!this._serviceEnabled) return;

    const state = this._states.get(sessionId);
    if (!state || state.status !== 'active') return;

    const existingTimer = this._pendingSyncTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    if (this._inFlightSessions.has(sessionId)) {
      this._resyncAfterCurrent.add(sessionId);
      return;
    }

    const timeSinceLastSync = Date.now() - state.lastSyncAt;
    const delay = Math.max(0, this._config.syncIntervalMs - timeSinceLastSync);

    const timer = setTimeout(() => {
      this._pendingSyncTimers.delete(sessionId);
      void this._executeSync(sessionId, workspaceRoot);
    }, delay);
    this._pendingSyncTimers.set(sessionId, timer);
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

      if (!this._serviceEnabled) {
        return;
      }

      const currentState = this._states.get(sessionId) ?? state;
      const lastContentHash = currentState.lastContentHash || state.lastContentHash;
      const now = Date.now();

      // Update state on success
      this._states.set(sessionId, {
        ...currentState,
        status: 'active',
        lastSyncAt: now,
        lastExternalHash: lastContentHash || currentState.lastExternalHash,
        consecutiveErrors: 0
      });

      // Notify UI
      this._kanbanProvider.postMessage({
        type: 'liveSyncUpdate',
        sessionId,
        status: 'active',
        lastSyncAt: now
      });

    } catch (error) {
      if (!this._serviceEnabled) {
        return;
      }

      const currentState = this._states.get(sessionId) ?? state;
      const newErrorCount = currentState.consecutiveErrors + 1;
      const newStatus: LiveSyncStatus = newErrorCount >= 5 ? 'error' : 'active';

      this._states.set(sessionId, {
        ...currentState,
        status: newStatus,
        consecutiveErrors: newErrorCount
      });

      console.error(`[ContinuousSync] Failed to sync ${sessionId}:`, error);
    } finally {
      this._activeSyncs = Math.max(0, this._activeSyncs - 1);
      this._inFlightSessions.delete(sessionId);

      if (!this._serviceEnabled) {
        return;
      }

      const shouldReschedule = this._resyncAfterCurrent.delete(sessionId);
      this._processQueue(workspaceRoot);
      if (shouldReschedule) {
        void this._scheduleSyncIfNeeded(sessionId, workspaceRoot);
      }
    }
  }

  private async _fetchExternalDescription(
    plan: import('./KanbanDatabase').KanbanPlanRecord,
    workspaceRoot: string
  ): Promise<string> {
    if (plan.clickupTaskId) {
      const clickup = this._getClickUpService(workspaceRoot);
      const config = await clickup.loadConfig();
      if (config?.setupComplete === true && config.realTimeSyncEnabled === true) {
        const result = await clickup.httpRequest('GET', `/task/${plan.clickupTaskId}`);
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
          { id: plan.linearIssueId }
        );
        return result.data?.issue?.description || '';
      }
    }

    return '';
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
    workspaceRoot: string
  ): Promise<void> {
    const clickup = this._getClickUpService(workspaceRoot);
    const config = await clickup.loadConfig();
    if (!plan.clickupTaskId || !config?.setupComplete || config.realTimeSyncEnabled !== true) {
      return;
    }
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
    const linear = this._getLinearService(workspaceRoot);
    const config = await linear.loadConfig();
    if (!plan.linearIssueId || !config?.setupComplete || config.realTimeSyncEnabled !== true) {
      return;
    }
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
    const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
    if (!workspaceId) {
      return;
    }
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

  private _teardownRuntime(): void {
    this._fileWatcherSubscription?.dispose();
    this._fileWatcherSubscription = undefined;

    for (const timer of this._pendingSyncTimers.values()) {
      clearTimeout(timer);
    }
    this._pendingSyncTimers.clear();
    this._inFlightSessions.clear();
    this._resyncAfterCurrent.clear();

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
