# Fix Slow Sidebar Reopen Due to PID Resolution

## Goal

Eliminate the 30+ second sidebar open delay caused by redundant PID resolution in `_refreshTerminalStatuses` by introducing an in-memory PID cache with event-driven invalidation, and reusing resolved PIDs across the method's three resolution blocks.

## Metadata

- **Tags:** [performance, frontend]
- **Complexity:** 5

## User Review Required

- Confirm that a 5-minute PID cache TTL is acceptable (i.e., stale PIDs for up to 5 minutes after a terminal's process changes are tolerable for `_isLocal` detection and the dropdown display).
- Confirm that event-driven cache invalidation (on terminal open/close) is preferred over a background interval timer.

## Complexity Audit

### Routine
- Adding private fields to TaskViewerProvider class
- Substituting cached PIDs into the existing `activePids` set construction
- Substituting cached PIDs into the `allOpenTerminals` dropdown construction
- Cleaning up cache on dispose

### Complex / Risky
- Reusing PIDs across Block 1 and Block 3 requires careful coordination — Block 3 currently re-resolves with a 5s timeout and must still work for terminals not yet in cache
- Event-driven invalidation via `onDidOpenTerminal`/`onDidCloseTerminal` must correctly evict stale entries without missing edge cases (e.g., terminal rename, process exec)
- WeakMap keyed by terminal object reference is idiomatic but must be validated against VS Code's terminal lifecycle (terminals may be kept alive by other references after close)

## Edge-Case & Dependency Audit

- **Race Conditions**: `_refreshTerminalStatuses` is called from ~15 sites, some reactively (terminal registration, role change, closure). The cache must be safe for concurrent reads — since JS is single-threaded, this is inherently safe as long as the cache Map is not mutated during iteration.
- **Security**: No security implications — PID values are not secrets and are only used for local process identification.
- **Side Effects**: The `allOpenTerminals` block (lines 16573-16581) currently sends a second `terminalStatuses` message with `allOpenTerminals` appended. This dual-message pattern must be preserved.
- **Dependencies & Conflicts**: The `pidResolutionCandidates` block (lines 16447-16484) resolves PIDs for terminals with missing/null PIDs in state.json and writes them back via `updateState`. This block should continue to resolve PIDs normally (it's a one-time fixup, not a hot-path bottleneck).

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) Plan misses the dominant latency source — Block 3's 5s-per-terminal re-resolution at lines 16573-16581, (2) A background interval timer wastes IPC resources when the sidebar is closed, (3) Name-based cache keys are fragile with non-unique terminal names. Mitigations: Reuse Block 1 PIDs for Block 3 instead of re-resolving, replace interval with event-driven invalidation using `onDidOpenTerminal`/`onDidCloseTerminal`, use `WeakMap<vscode.Terminal, ...>` keyed by terminal object reference for automatic GC and collision avoidance.

## Problem

Opening the sidebar takes 30+ seconds because `_refreshTerminalStatuses` performs full PID resolution for all terminals every time. This happens even when terminals are still running and their PIDs haven't changed.

## Root Cause

In `TaskViewerProvider.ts:_refreshTerminalStatuses` (lines 16408-16601), the code resolves PIDs in **three separate blocks** on every call:

**Block 1** (lines 16435-16441) — 1s timeout per terminal, resolves ALL active terminals:
```typescript
const activeTerminalPids = await Promise.all(
    activeTerminals.map(t => this._waitWithTimeout(t.processId, 1000, undefined))
);
```

**Block 2** (lines 16463-16484) — 1s timeout, re-resolves only terminals with missing PIDs in state.json (one-time fixup, not a bottleneck).

**Block 3** (lines 16573-16581) — **5s timeout per terminal**, resolves ALL active terminals AGAIN for the `allOpenTerminals` dropdown:
```typescript
const allOpenTerminals = await Promise.all(activeTerminals.map(async t => {
    try {
        const pid = await this._waitWithTimeout(t.processId, 5000, undefined);
        const displayName = (pid && pidAliasMap.get(pid)) || nameAliasMap.get(t.name) || t.name;
        return { name: t.name, pid: pid || null, displayName };
    } catch {
        return { name: t.name, pid: null, displayName: nameAliasMap.get(t.name) || t.name };
    }
}));
```

Block 3 is the **dominant latency source** — with 10 terminals, it can stall for up to 5 seconds vs. Block 1's ~1 second. The code comment on Block 1 even mentions: "Previously this ran sequentially — 30 terminals = 30 seconds of Phase-1 latency."

This is inefficient because:
- PIDs are already cached in state.json
- Running terminals keep the same PID
- Block 3 re-resolves PIDs that Block 1 already resolved, with a 5x longer timeout
- The system re-verifies every terminal on every sidebar open instead of trusting a cache

## Solution

Add an in-memory PID cache that:
1. Caches PIDs with timestamps, keyed by `vscode.Terminal` object reference (WeakMap)
2. Uses cached PIDs for terminals with recent timestamps (< 5 minutes old)
3. Only resolves PIDs for terminals not in cache or with stale cache
4. Reuses Block 1's resolved PIDs in Block 3 instead of re-resolving
5. Invalidates cache entries on terminal open/close events (not a background timer)

## Files to Modify

- `src/services/TaskViewerProvider.ts`

## Implementation

### 1. Add in-memory PID cache

Add to TaskViewerProvider class (near other private fields, e.g., after the `_waitWithTimeout` helper around line 1032):

```typescript
private _pidCache = new WeakMap<vscode.Terminal, { pid: number; timestamp: number }>();
private readonly PID_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
```

**Why WeakMap instead of Map with string keys:**
- Terminal names can be non-unique (multiple terminals with the same name)
- WeakMap keys on object identity, so no collision risk
- Automatic garbage collection when VS Code discards a closed terminal object
- No manual eviction needed for closed terminals (the GC handles it)

**Why no background interval timer:**
- A 30-second `setInterval` would resolve PIDs even when no sidebar is open, wasting IPC resources in the shared extension host process
- Event-driven invalidation (step 5) is zero-cost when idle and immediately responsive

### 2. Add cache population helper

```typescript
private _getCachedPid(terminal: vscode.Terminal): number | undefined {
    const entry = this._pidCache.get(terminal);
    if (entry && (Date.now() - entry.timestamp < this.PID_CACHE_TTL_MS)) {
        return entry.pid;
    }
    return undefined;
}

private _setCachedPid(terminal: vscode.Terminal, pid: number | undefined): void {
    if (pid) {
        this._pidCache.set(terminal, { pid, timestamp: Date.now() });
    }
}
```

### 3. Modify Block 1 to use cache (lines 16435-16441)

Replace the PID resolution loop with cache-first logic:

```typescript
const activeTerminalPids: (number | undefined)[] = [];
const terminalsNeedingResolution: vscode.Terminal[] = [];

for (const t of activeTerminals) {
    const cached = this._getCachedPid(t);
    if (cached !== undefined) {
        activeTerminalPids.push(cached);
    } else {
        terminalsNeedingResolution.push(t);
        activeTerminalPids.push(undefined); // placeholder
    }
}

if (terminalsNeedingResolution.length > 0) {
    const resolvedPids = await Promise.all(
        terminalsNeedingResolution.map(t =>
            this._waitWithTimeout(t.processId, 1000, undefined)
        )
    );
    for (let i = 0; i < terminalsNeedingResolution.length; i++) {
        const pid = resolvedPids[i];
        if (pid) {
            this._setCachedPid(terminalsNeedingResolution[i], pid);
            // Fill in the placeholder
            const placeholderIdx = activeTerminals.indexOf(terminalsNeedingResolution[i]);
            if (placeholderIdx !== -1) {
                activeTerminalPids[placeholderIdx] = pid;
            }
        }
    }
}

const activePids = new Set<number>();
for (const pid of activeTerminalPids) {
    if (pid) { activePids.add(pid); }
}
```

### 4. Reuse Block 1 PIDs in Block 3 (lines 16573-16581)

Replace the second full PID resolution with cache-first lookup, falling back to the PIDs already resolved in Block 1:

```typescript
const allOpenTerminals = activeTerminals.map(t => {
    const pid = this._getCachedPid(t);
    const displayName = (pid && pidAliasMap.get(pid)) || nameAliasMap.get(t.name) || t.name;
    return { name: t.name, pid: pid || null, displayName };
});
```

**Key change**: This is now synchronous — no `await`, no `Promise.all`, no 5-second timeouts. The PIDs were already resolved in Block 1 (and cached), so Block 3 just reads from the cache. For terminals that weren't in cache and Block 1 just resolved, the cache was populated in step 3.

### 5. Register event-driven cache invalidation

In the constructor or `resolveWebviewView` initialization (near where other event listeners are registered):

```typescript
this._context.subscriptions.push(
    vscode.window.onDidOpenTerminal((terminal) => {
        // New terminal — no cache entry yet, will be populated on next refresh
        // Optionally: eagerly resolve PID for the new terminal
        void this._waitWithTimeout(terminal.processId, 1000, undefined).then(pid => {
            if (pid) { this._setCachedPid(terminal, pid); }
        });
    })
);
// Note: onDidCloseTerminal is not needed — WeakMap auto-GC handles closed terminals.
// However, if a terminal's process changes (e.g., shell execs a new program),
// the PID changes but the terminal object stays the same. The cache TTL (5 min)
// handles this — after 5 minutes, the stale entry expires and is re-resolved.
```

### 6. Clean up on dispose

In `dispose()` method (around line 17071), add before existing cleanup:

```typescript
// WeakMap doesn't need explicit cleanup, but clear for clarity
this._pidCache = new WeakMap();
```

**Note**: Since `_pidCache` is a WeakMap, it doesn't prevent GC of terminal objects. The reassignment is defensive — it ensures no references linger if the provider is re-instantiated.

### 7. Keep Block 2 unchanged (lines 16447-16484)

The `pidResolutionCandidates` block resolves PIDs for terminals with missing/null PIDs in state.json and writes them back via `updateState`. This is a one-time fixup, not a hot-path bottleneck. Leave it as-is — it already only resolves terminals that need it.

**REVIEW FIX (MAJOR)**: Block 2 must also populate the PID cache when it successfully resolves a PID. Without this, if Block 1 times out on a terminal but Block 2 succeeds (same IPC call, process may have warmed up), the PID is written to state.json and `activePids` but NOT cached. Block 3's synchronous `_getCachedPid(t)` then returns `undefined`, causing `pid: null` in the dropdown — a regression from the original 5s-timeout fallback. Fix: add `this._setCachedPid(pidResolutionCandidates[i].matchingTerminal, resolvedPid)` in Block 2's resolution loop (after `activePids.add(resolvedPid)`).

## Verification Plan

### Automated Tests

- **Manual timing test**: Open 10+ agent terminals, close sidebar, reopen sidebar. Verify sidebar opens in < 2 seconds (not 30+ seconds).
- **Cache hit test**: Open sidebar twice in quick succession. Second open should be near-instant (all PIDs cached).
- **Cache miss test**: Open a new terminal, then open sidebar. Verify the new terminal's PID is resolved and displayed correctly.
- **Stale PID test**: Open a terminal, wait 5+ minutes, reopen sidebar. Verify the PID is re-resolved (cache TTL expired).
- **Dropdown test**: Verify the `allOpenTerminals` dropdown in the sidebar shows correct display names after the change.
- **Terminal close test**: Close a terminal, reopen sidebar. Verify the closed terminal no longer appears as active.
- **No compilation or automated tests required** — this is a performance optimization with observable behavior changes only.

### Recommendation

**Send to Coder** (Complexity 5: multi-file-adjacent single-file changes with moderate logic, reusing existing patterns)

## Review Results

### Stage 1 — Grumpy Findings

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Block 2 (pidResolutionCandidates) doesn't populate PID cache — PIDs resolved by Block 2 are invisible to Block 3's synchronous cache read, causing `pid: null` in dropdown when Block 1 times out but Block 2 succeeds | MAJOR | **Fixed** |
| 2 | `activeTerminals.indexOf()` in Block 1 is O(n²) worst-case for placeholder fill | NIT | Deferred (negligible at scale) |
| 3 | `onDidOpenTerminal` `.then()` callback could fire after `dispose()`, writing to fresh WeakMap | NIT | Deferred (harmless) |
| 4 | Plan suggested `_context.subscriptions.push()` but implementation uses manual disposal via `_terminalOpenDisposable` | NIT | Keep current (consistent with codebase) |

### Stage 2 — Balanced Synthesis

Only finding #1 required a code fix. All other findings are cosmetic or consistent with existing codebase patterns.

### Code Fixes Applied

**File**: `src/services/TaskViewerProvider.ts`
**Line 16534** (after `activePids.add(resolvedPid)` in Block 2's resolution loop):
```typescript
this._setCachedPid(pidResolutionCandidates[i].matchingTerminal, resolvedPid);
```

This ensures PIDs resolved by Block 2 are available to Block 3's cache read, closing the gap left by removing Block 3's 5s-timeout fallback.

### Validation Results

- **TypeScript typecheck**: PASS — no new errors introduced (2 pre-existing errors in unrelated files `ClickUpSyncService.ts` and `KanbanProvider.ts`)
- **Cache population coverage**: All 3 PID resolution sites now populate cache (Block 1, Block 2, onDidOpenTerminal)
- **Cache read coverage**: Both read sites (Block 1 cache-first, Block 3 synchronous) covered
- **Dispose coverage**: `_terminalOpenDisposable?.dispose()` + `_pidCache = new WeakMap()` present

### Remaining Risks

1. **Stale PID after process exec**: If a terminal's process changes (e.g., shell execs a new program), the PID changes but the terminal object stays the same. The cache entry becomes stale for up to 5 minutes (TTL). This is an accepted trade-off per the plan's "User Review Required" section.
2. **No fallback resolution in Block 3**: Block 3 is now purely cache-driven. If a PID isn't cached (Block 1 timeout + Block 2 timeout), Block 3 returns `pid: null`. The original code had a 5s fallback. This is the intended performance trade-off — the 5s timeout was the dominant latency source.
3. **WeakMap GC timing**: Closed terminal objects are only GC'd when VS Code releases all references. Stale cache entries persist until GC or TTL expiry (5 min). Acceptable per plan.
