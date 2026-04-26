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
  lastSyncAt: number;             // Unix timestamp of last SUCCESSFUL sync
  lastContentChangeAt: number;    // Unix timestamp of last file mtime change
  syncStartedAt?: number;         // Unix timestamp when the current in-flight sync began (cleared on completion/abort)
  consecutiveErrors: number;
  timeoutWarningShown?: boolean;  // True once we've surfaced a user-visible warning for this error streak; reset on success
  conflictResolution?: 'overwrite' | 'accept-external' | 'manual';
  // Quiet-period debounce fields
  quietTimer?: NodeJS.Timeout;    // Timer for quiet-period debounce (reset on each file change)
  firstPendingEditAt?: number;     // Timestamp of first pending edit (for MAX_DEFER_MS ceiling)
  needsResync?: boolean;          // Flag set when file change arrives during in-flight sync
  inFlight?: boolean;             // Whether a sync is currently in-flight
}

export interface LiveSyncConfig {
  enabled: boolean;
  syncIntervalMs: number;           // Default: 30000 (30s)
  idleTimeoutMs: number;          // Default: 300000 (5min) → back off sync
  staleTimeoutMs: number;         // Default: 1800000 (30min) → pause sync
  maxContentSizeBytes: number;    // Default: 102400 (100KB)
  autoConflictCheckEvery: number; // Check conflicts every N syncs (0 = disabled)
  conflictCheckEnabled: boolean;  // Master toggle for conflict detection
  // Quiet-period debounce settings
  quietMs: number;                // Default: 3000ms - wait this long after last edit before syncing
  minIntervalMs: number;           // Default: 10000ms - minimum time between syncs (rate-limit floor)
  maxDeferMs: number;             // Default: 60000ms - force sync after this long even if still editing
}

export const DEFAULT_LIVE_SYNC_CONFIG: LiveSyncConfig = {
  enabled: false,
  syncIntervalMs: 30000,
  idleTimeoutMs: 300000,
  staleTimeoutMs: 1800000,
  maxContentSizeBytes: 102400,
  autoConflictCheckEvery: 0,      // Disabled by default (expensive)
  conflictCheckEnabled: true,     // Allow manual conflict checks
  quietMs: 3000,                 // 3 second quiet period
  minIntervalMs: 10000,          // 10 second minimum between syncs
  maxDeferMs: 60000              // 60 second max defer before forced sync
};
