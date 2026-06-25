# Investigate & Harden: Sequential Planner Terminal Sends — Clipboard Cross-Contamination Risk

## Goal

Make the full `/clear + prompt` terminal-send sequence **atomic per terminal**, so two overlapping dispatches that target the same terminal cannot interleave their clears and prompts. This is a concurrency-safety hardening of the existing planner fan-out dispatch path — no new product behavior, no UI change.

### Problem
The planner agent supports multiple terminals (1–5) for parallel plan processing. When the user rapid-fires "move all" or dispatches multiple plan batches, plans are distributed to terminals via `_distributePlannerDispatch` (in `src/services/KanbanProvider.ts:3517`) which uses `Promise.allSettled` for concurrent dispatch. The concern is whether rapid-firing these sends could cause **clipboard cross-contamination** — one terminal's prompt content being pasted into the wrong terminal, or two prompts being concatenated in the same terminal.

### Root Cause Analysis
The investigation found **two layers of protection and one gap**. (Code locations verified against the current tree.)

**Layer 1 — Global Clipboard Lock (exists, works):**
`terminalUtils.ts` lines 5–11 implement a global `_clipboardLock` mutex (a result/error-swallowing promise chain). Every `pasteTextViaClipboard()` call is wrapped in `withClipboardLock()`, which serializes the clipboard read/write/paste/restore operations. This prevents the clipboard *contents* from being corrupted: Terminal A's clipboard write completes (paste + restore) before Terminal B's clipboard write begins.

**Layer 2 — Per-dispatch partitioning to distinct terminals (exists, works):**
`_distributePlannerDispatch` (`KanbanProvider.ts:3517`) partitions plans into per-terminal buckets via a persistent round-robin cursor, then dispatches each bucket via `Promise.allSettled` over `bucketEntries`. **Within a single dispatch call, each terminal name appears in exactly one bucket** (the `buckets` Map is keyed by terminal name), so each terminal receives exactly one `switchboard.triggerBatchAgentFromKanban` call → one unified prompt. Distinct terminals are independent processes, so concurrent dispatch is safe at the terminal level, and there is no intra-dispatch same-terminal contention.

**The Gap — No per-terminal send lock across overlapping dispatches:**
There is **no per-terminal serialization** of the full `/clear + prompt` send sequence. The dispatch call chain is:

`_distributePlannerDispatch` (KanbanProvider) → `switchboard.triggerBatchAgentFromKanban` → `handleKanbanBatchTrigger` (TaskViewerProvider.ts:3302) → `_dispatchExecuteMessage` (TaskViewerProvider.ts:15286) → **`_attemptDirectTerminalPush` (TaskViewerProvider.ts:15358–15442)**.

`_attemptDirectTerminalPush` performs:
1. `pasteTextViaClipboard(terminal, '/clear')` — clipboard lock acquired/released
2. `setTimeout(1000)` — wait before submitting /clear (paced)
3. `terminal.sendText('', true)` — submit /clear
4. `setTimeout(clearDelay ≈ 2000)` — wait for the CLI to process the clear
5. `sendRobustText(terminal, payload)` — clipboard lock acquired/released for the prompt paste

Steps 1 and 5 are individually protected by the clipboard lock, but the **overall sequence is not atomic per terminal**. The interleaving cannot arise *within* one dispatch (Layer 2 guarantees one bucket per terminal). It arises when **two `_distributePlannerDispatch` (or other dispatch) calls overlap and both resolve to the same terminal**:

```
Dispatch 1: /clear paste (lock) → 1s wait → submit /clear → 2s wait → prompt A paste (lock)
Dispatch 2: /clear paste (lock) → 1s wait → submit /clear → 2s wait → prompt B paste (lock)
```

The clipboard lock serializes only the paste *primitives*, not the `setTimeout` settle delays between them. So the two sequences' steps freely interleave on the same terminal, e.g. terminal receives `/clear, /clear, prompt A, prompt B`. The second `/clear` may wipe prompt A after it was pasted, or the two prompts may be submitted as one concatenated input. This is the cross-contamination risk.

**When does this actually happen?** (All require two *overlapping* top-level dispatches — a single dispatch is already safe.)
- User clicks "move all" twice in rapid succession (before the first dispatch's slow `/clear + prompt` chain completes).
- Two different columns both dispatch to the planner role concurrently.
- Any scenario where `_distributePlannerDispatch` (or another `_dispatchExecuteMessage` caller) targets a terminal that already has an in-flight send.

There is currently no in-flight guard preventing overlapping `_distributePlannerDispatch` invocations.

### Desired Behavior
The full `/clear + prompt` send sequence for a given terminal must be **atomic** — no second send to the same terminal may begin until the first completes. This requires a per-terminal send lock that serializes the entire `_attemptDirectTerminalPush` sequence (not just the clipboard paste portions), while leaving sends to *distinct* terminals fully concurrent.

## Metadata

- **Tags:** reliability, bugfix, refactor
- **Complexity:** 5
- **Files touched:** 2 — `src/services/terminalUtils.ts` (add lock helper), `src/services/TaskViewerProvider.ts` (wrap + import)
- **Risk:** Medium — concurrency changes require careful manual testing to avoid deadlocks or a parallelism regression.

## User Review Required

- **None.** This is a self-contained correctness hardening with no product-scope or UX decision. The design (per-terminal promise-chain lock, keyed by normalized terminal name, wrapping the single `_attemptDirectTerminalPush` chokepoint) is fully specified below.

## Complexity Audit

### Routine
- The lock is a promise-chain serializer that **directly mirrors the existing, proven `_clipboardLock` pattern** in the same file.
- Exactly **one wrap point**: `_attemptDirectTerminalPush` is the sole place performing the `/clear + prompt` sequence, and its only caller is `_dispatchExecuteMessage`. No fan-out of edits.
- No change to dispatch partitioning, the round-robin cursor, prompt generation, the global clipboard lock, or any UI.

### Complex / Risky
- Concurrency control in async TypeScript: lock ordering must be **per-terminal lock → clipboard lock** with no reverse path, or a deadlock could occur (analysis below shows no reverse path exists).
- The lock **must not serialize across distinct terminals** — that would kill the parallel-planner speedup that Layer 2 provides.
- The lock **key** must coalesce the suffix/case aliases that resolve to the same terminal, yet keep genuinely distinct terminals separate.
- Behavior must be invisible in the common single-dispatch case (zero added latency when nothing is contending).

## Edge-Case & Dependency Audit

### Race Conditions
- **The core race** (the bug being fixed): two overlapping dispatches resolving to the same terminal interleave their `/clear + prompt` steps. The per-terminal lock closes this by forcing the second send to await the first.
- **Resolution is read-only and stays outside the lock.** Terminal lookup (`_registeredTerminals` map reads + open-terminal scan) is idempotent and side-effect-free, so resolving twice concurrently is safe; we only acquire the lock once a live terminal is found, so a missing-terminal call returns `false` immediately without queuing.
- **Intra-dispatch:** none — Layer 2 guarantees one bucket (one push) per terminal per dispatch.

### Security
- No new input surface, no `eval`, no path construction. The terminal name is already validated upstream by `_isValidAgentName` in both `_dispatchExecuteMessage` and `handleKanbanBatchTrigger` before reaching `_attemptDirectTerminalPush`. The lock key is derived from an already-validated/resolved terminal name. No security impact.

### Side Effects
- Sends to the **same** terminal now queue (serialize) instead of interleaving. This is the intended effect and matches what the user expects when double-firing.
- Sends to **distinct** terminals are unaffected — full concurrency preserved.
- The lock `Map` gains one entry per distinct (normalized) terminal name. Terminal names are bounded to the handful of role terminals (planner1–5, coder, lead, tester, reviewer, plus any custom roles), so the map holds at most a few dozen entries for the life of the extension host — negligible. Optional cleanup is documented but not required.

### Dependencies & Conflicts
- Depends on the existing global `_clipboardLock` (left **unchanged**). The two locks compose: per-terminal lock wraps the sequence; the clipboard lock still protects each individual paste.
- **Lock ordering / deadlock:** the per-terminal lock wraps `_attemptDirectTerminalPush`, which calls `pasteTextViaClipboard` (which acquires the clipboard lock). Ordering is always per-terminal → clipboard. The clipboard lock is held *only* inside `pasteTextViaClipboard`'s inner fn (clipboard ops + the paste command) and never tries to acquire a per-terminal lock. No reverse path exists → no deadlock.
- **Other `sendRobustText` / `pasteTextViaClipboard` callers** (TaskViewerProvider.ts:9810, 15849, 19179, and standalone `pasteTextViaClipboard`) do **not** go through `_attemptDirectTerminalPush` and therefore are **not** covered by the per-terminal send lock. They remain protected only by the clipboard lock, exactly as today. This is acceptable: the fix is scoped to the planner-dispatch interleaving that motivated it, and those other paths are not part of the rapid-fire fan-out. Noted as a known, intentional limitation rather than a regression.
- No conflict with the round-robin rotation cursor or `getRoleTerminalSet`.

### Edge cases (resolution / lifecycle)
| Edge Case | Analysis |
|-----------|----------|
| Same terminal name, different `Terminal` objects | If a terminal was recreated (closed + reopened), the name may match but the `vscode.Terminal` object differs. Keying the lock by **normalized name** (not object reference) is correct: the send to a dead object will fail at paste time and is handled by existing error handling; a live send to the reused name still serializes. |
| Suffix / case aliases (`planner` vs `planner — IDE` vs `Planner`) | `_attemptDirectTerminalPush` resolves all of these to one `vscode.Terminal`. The lock key is derived via `_normalizeAgentKey(_stripIdeSuffix(...))` so all aliases share **one** lock, preventing an alias from sneaking a second concurrent send past the lock. |
| Terminal closed mid-send | If a terminal is closed while a queued send waits, the send fails when it acquires the lock and tries to paste; the existing try/catch around `/clear` and the `sendRobustText` fallback handle this. A thrown error inside the locked fn rejects `next`, but the stored lock tail swallows it (`next.then(()=>{}, ()=>{})`), so the chain advances and there is **no deadlock**. |
| Performance | Sends to different terminals stay concurrent. Only same-terminal sends serialize — which is precisely the rapid-fire double-dispatch case that should be serialized anyway. Zero added latency when uncontended. |
| Lock cleanup | The `Map` is bounded by terminal-name count, so growth is negligible and cleanup is optional. If ever desired, the existing close handler `TaskViewerProvider.handleTerminalClosed(terminal)` (wired in `extension.ts:1646`) can call `cleanupTerminalSendLock(this._normalizeAgentKey(this._stripIdeSuffix(terminal.name)))` to drop the entry. Not implemented in this change to avoid coupling and scope creep. |

## Dependencies

- None.

## Adversarial Synthesis

**Key risks:** (1) a deadlock if the per-terminal and clipboard locks could be acquired in opposing orders — ruled out, since the only ordering is per-terminal → clipboard and the clipboard-held critical section never re-enters the terminal lock; (2) accidentally serializing distinct terminals and erasing the parallel-planner speedup — avoided by keying the lock on the per-terminal normalized name; (3) a buggy/dead cleanup path leaving misleading code — addressed by removing the broken auto-cleanup and keeping only a correct, optional manual hook. **Mitigations:** mirror the proven `_clipboardLock` promise-chain, key on the resolved+normalized terminal name, keep resolution outside the lock, and verify the rapid-fire (N=1) and concurrent-distinct (N=3) scenarios manually.

## Proposed Changes

### `src/services/terminalUtils.ts`

#### Change 1: Add a per-terminal send lock keyed by terminal name

**Context.** The file already hosts the global `_clipboardLock` / `withClipboardLock` serializer (lines 5–11). Add a sibling per-terminal serializer immediately after it, using the identical promise-chain idiom.

**Logic.** A `Map<string, Promise<void>>` holds the tail of each terminal's in-flight send chain. `withTerminalSendLock(key, fn)` chains `fn` after the current tail for `key` (running it whether the prior settled or rejected), stores a result/error-swallowing tail so the chain always advances, and returns the real result/error to the caller. This serializes same-key sends while leaving distinct keys independent. The map entry persists (bounded by terminal-name count); a correct, optional `cleanupTerminalSendLock` is exported for callers that want to drop an entry on terminal close.

**Implementation.** Insert after line 11:

```typescript
// Per-terminal send lock: serialize the FULL /clear + prompt sequence for a
// single terminal so two overlapping dispatches to the same terminal cannot
// interleave their clears and prompts (e.g. rapid double "move all", or two
// columns dispatching to the planner role at once). Distinct terminals keep
// running concurrently. The KEY is a normalized terminal name (the caller
// normalizes), so suffix/case aliases of the same terminal share one lock.
// Mirrors the proven _clipboardLock promise-chain pattern above.
const _terminalSendLocks = new Map<string, Promise<void>>();

export function withTerminalSendLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (_terminalSendLocks.has(key)) {
        // Diagnostic: a previous send to this terminal is still in flight, so
        // this one will queue behind it. Helps explain any perceived slowness.
        console.log(`[TerminalSendLock] Queuing send to '${key}' — previous send in progress`);
    }
    const existing = _terminalSendLocks.get(key) || Promise.resolve();
    const next = existing.then(fn, fn);
    // Store a result/error-swallowing tail so the chain always advances even if
    // a send rejects (e.g. terminal closed mid-send). No deadlock on failure.
    _terminalSendLocks.set(key, next.then(() => {}, () => {}));
    return next;
}

// Optional: drop a terminal's lock entry (e.g. from a terminal-close handler).
// Not required — the map is bounded by the small set of role-terminal names.
export function cleanupTerminalSendLock(key: string): void {
    _terminalSendLocks.delete(key);
}
```

**Edge Cases.**
- The buggy auto-cleanup from the original draft — which compared the stored promise against a freshly-created `next.then(...)` promise and therefore *never matched* (dead code) — is intentionally **not** included. Cleanup is now an explicit, correct, optional export.
- Keying on a string (caller-normalized name) rather than the `vscode.Terminal` object is deliberate: recreated terminals reuse the name, and the dispatch layer targets terminals by name.

### `src/services/TaskViewerProvider.ts`

#### Change 2: Wrap the `_attemptDirectTerminalPush` send sequence in the per-terminal lock

**Context.** `_attemptDirectTerminalPush` (lines 15358–15442) resolves a terminal, logs the dispatch event, runs the optional `/clear`, then `sendRobustText`. Its only caller is `_dispatchExecuteMessage`. This is the single chokepoint for the `/clear + prompt` sequence.

**Logic.** Keep terminal **resolution outside** the lock (so a missing terminal returns `false` immediately without queuing). Once a live terminal is found, compute a normalized lock key from the **resolved** terminal's name (falling back to the requested name), then run the remainder of the method inside `withTerminalSendLock`. This serializes overlapping sends to the same terminal while leaving distinct terminals concurrent.

**Implementation.** After the resolution block and the `if (!terminal) return false;` guard (line 15394), wrap the rest of the body:

```typescript
        if (!terminal) return false;

        // Serialize the full /clear + prompt sequence per terminal so two
        // overlapping dispatches to the SAME terminal cannot interleave. Key on
        // the resolved, normalized name so suffix/case aliases coalesce; distinct
        // terminals keep their own chains and stay concurrent. Resolution above
        // is intentionally outside the lock (read-only, and a missing terminal
        // must fail fast without queuing).
        const sendLockKey =
            this._normalizeAgentKey(this._stripIdeSuffix(terminal.name || terminalName)) || terminalName;

        return withTerminalSendLock(sendLockKey, async () => {
            // Log the session event for observability
            await this._logEvent('dispatch', {
                timestamp: new Date().toISOString(),
                dispatchId: messageId,
                event: 'received',
                sender: meta.sender,
                recipient: meta.recipient,
                action: meta.action
            });

            // ... existing /clear configuration read, /clear paste+submit+wait,
            //     and `await sendRobustText(terminal, payload, paced);` UNCHANGED ...

            return true;
        });
```

The body moved inside the callback is the existing code at lines 15396–15441 **verbatim** — only the indentation and the surrounding `withTerminalSendLock(...)` wrapper are added. `terminal` is captured by the closure; nothing else changes.

**Import.** Extend the existing import at line 16:

```typescript
import { sendRobustText, getAntigravityHash, pasteTextViaClipboard, withTerminalSendLock } from './terminalUtils';
```

(`cleanupTerminalSendLock` is exported for the optional close-handler hook described in the Edge-Case audit; importing it is not required for this change.)

**Edge Cases.**
- `terminal.name` is preferred over the raw `terminalName` argument for the key so the lock reflects the *actual* target after suffix/case-insensitive resolution; the `|| terminalName` fallback covers the (unexpected) empty-name case.
- The wrapped callback returns `true` (matching today); a thrown error inside it rejects the returned promise exactly as before, preserving the existing error contract for `_dispatchExecuteMessage`.

## Verification Plan

> Per session policy, compilation and the automated test suite are run **separately by the user** and are not executed as part of this plan.

### Automated Tests
- **No new unit tests.** This change is timing-/concurrency-sensitive (multi-second `setTimeout` settle delays around terminal paste); it has no deterministic, side-effect-free unit boundary, and the existing `_clipboardLock` it mirrors is likewise covered by manual verification rather than unit tests. The TypeScript compiler (`tsc` via `npm run compile`) is the relevant automated gate for the type changes (new export, import update, key derivation) and is run by the user.

### Manual Tests
1. **Normal single dispatch (no regression):** set planner terminals to 2; click "move all" on a column with 4 plans; verify 2 plans → terminal 1 and 2 plans → terminal 2, concurrently, with no added delay versus prior behavior.
2. **Rapid-fire double dispatch (the bug scenario):** set planner terminals to 1; click "move all" twice in rapid succession on a column with plans; verify the second dispatch **waits** for the first to complete — the terminal receives `/clear, prompt A, /clear, prompt B` (serialized), **not** `/clear, /clear, prompt A, prompt B` (interleaved). Confirm the `[TerminalSendLock] Queuing send to '<name>'` log line appears for the second send.
3. **Concurrent distinct terminals (parallelism preserved):** set planner terminals to 3; click "move all" on a column with 6 plans; verify all 3 terminals receive their prompts concurrently (no `[TerminalSendLock]` queuing across distinct terminals, no serialization).
4. **Terminal closed mid-send (no deadlock):** start a dispatch, then close the target terminal before it completes; verify the lock releases (a subsequent send to a *different* live terminal is unaffected) and the error is handled gracefully (no hang).
5. **Log inspection:** confirm `[TerminalSendLock]` messages appear only for same-terminal contention and never block distinct-terminal sends.

## Uncertain Assumptions

None. All claims in this plan were verified directly against the current source tree: the call chain (`_distributePlannerDispatch` → `triggerBatchAgentFromKanban` → `handleKanbanBatchTrigger` → `_dispatchExecuteMessage` → `_attemptDirectTerminalPush`), the line numbers, the existing `_clipboardLock` pattern, the absence of an in-flight dispatch guard, and the helper methods `_normalizeAgentKey` / `_stripIdeSuffix`. The fix uses only the in-codebase promise-chain idiom and standard VS Code terminal/clipboard APIs already in use here — no third-party library or unverified API behavior is involved. No web research is needed.

---

**Recommendation:** Complexity 5/10 → **Send to Coder.**
