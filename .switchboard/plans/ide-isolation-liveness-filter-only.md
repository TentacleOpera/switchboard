# IDE Isolation via Liveness Filter Hardening

## Goal
Prevent cross-IDE terminal collisions in `state.json` by fixing 3 specific code sites where the existing `ideMatches` / `isCompatibleIdeName` guard is bypassed, allowing one IDE's agents to appear alive in (or be deleted by) another IDE. No key renaming, no new naming conventions — just close the gaps in the existing IDE-aware filtering.

## Metadata
**Tags:** bugfix, backend
**Complexity:** 3

## User Review Required
> [!NOTE]
> - **No visual changes.** No naming changes. No migration. Terminal keys remain bare names (e.g., `"Lead Coder"`).
> - **Behavioral change:** A terminal registered by Cursor will no longer appear as "alive" in Windsurf's sidebar (and vice versa), even if its `lastSeen` heartbeat is fresh. Previously, the heartbeat path bypassed IDE filtering, causing phantom agents in the wrong IDE.
> - **`clearGridBlockers()` scoping:** When an IDE starts its Agent Grid, it will only clear its own `state.json` entries (matching `ideName`), not wipe entries belonging to another IDE. Previously, Cursor starting Agent Grid would delete Windsurf's `"Lead Coder"` entry.
> - **CLI/external agents unaffected.** Agents with no `ideName` (i.e., registered via MCP CLI without IDE context) continue to appear in all IDEs, preserving backward compatibility. The `!termIdeName` guard in `ideMatches` handles this.
> - **This is the lightweight alternative to the "IDE Isolation via Terminal Suffixing" plan** (`brain_642190a87717983852fe71172da1058c68062269f9932769d695e21d6b5eea41.md`, complexity 7). That plan renames all internal keys; this plan fixes the 3 filter gaps without touching the naming contract.

## Complexity Audit

### Routine
- **Fix 1:** Add `ideMatches` guard to `heartbeatAlive` path in `_getAliveAutobanTerminalRegistry()` (`src/services/TaskViewerProvider.ts` line 1846) — single-line conditional change.
- **Fix 2:** Add `ideMatches` guard to `heartbeatAlive` path in sidebar terminal enrichment (`src/services/TaskViewerProvider.ts` line 9921) — single-line conditional change.
- **Fix 3:** Scope `clearGridBlockers()` state deletion to only delete entries where `info.ideName` matches current IDE (`src/extension.ts` line 2089–2095) — 4-line conditional block.

### Complex / Risky
- None. All three changes are additive guards on existing conditionals. No new patterns, no key changes, no cross-file coordination.

## Edge-Case & Dependency Audit
- **Race Conditions:** Two IDEs writing `state.terminals["Lead Coder"]` still share the same key. Last-writer-wins applies. However, since each IDE now only _reads_ entries matching its own `ideName`, the stale cross-IDE data is invisible. The next heartbeat from the owning IDE overwrites the entry with correct data. The `updateState()` file-lock prevents partial writes.
- **Security:** No new surface. No user input involved.
- **Side Effects:**
  - CLI-registered agents (no `ideName` set) remain visible everywhere — the `!termIdeName` early-return in `ideMatches` preserves this.
  - If a user switches IDEs on the same workspace (e.g., closes Cursor, opens Windsurf), the old Cursor entries will expire via heartbeat (60–120s) and no longer appear. This is correct behavior.
  - The `housekeepStaleTerminals()` 24-hour pruner at line 9096 does NOT check `ideName`, but its 24h threshold makes cross-IDE mis-pruning extremely unlikely. Not addressed here; can be a follow-up if needed.
- **Dependencies & Conflicts:**
  - **Deregistration Bug plan** (`brain_a0e34fcfef7ac778b33a42b10ad0aa99cab1b5ca183e15c384208a673e906964_deregistraiton_bug.md`): Changes `HEARTBEAT_THRESHOLD_MS` from 60s to 120s. Fully orthogonal — threshold value doesn't affect the IDE filter logic. Can be applied in either order.
  - **IDE Isolation via Terminal Suffixing plan** (`brain_642190a87717983852fe71172da1058c68062269f9932769d695e21d6b5eea41.md`): This plan is a **lighter alternative** to that plan. If this plan is sufficient, the suffixing plan can be closed as unnecessary. If same-IDE-window collision also needs solving, the suffixing plan (Path B with PID) would still be needed.
  - **Capture Review Outcome Data plan** (`capture_review_outcome_data_for_adaptive_routing.md`): No conflict. That plan adds DB columns; this plan modifies liveness checks.

## Adversarial Synthesis

### Grumpy Critique
*Three one-line fixes? That's it? Let me poke at this "simple" plan:*

1. *The `heartbeatAlive` path exists for a REASON. It's the only way CLI-registered agents (MCP tools, external scripts) without a live VS Code terminal show up in the sidebar. If you gate it behind `ideMatches`, and the CLI agent didn't set `ideName` when registering... oh wait, `ideMatches` returns `true` when `termIdeName` is empty. Fine. But what about the MCP server's `registerTerminalsBatch` — does it always set `ideName`? If the MCP server registers a terminal without `ideName`, your filter treats it as "compatible with everyone", which is EXACTLY the collision you're trying to prevent.*

2. *You're still sharing the same `state.json` key across IDEs. Cursor writes `state.terminals["Lead Coder"] = { ideName: "Cursor", lastSeen: "..." }`. Then Windsurf writes `state.terminals["Lead Coder"] = { ideName: "Windsurf", lastSeen: "..." }`. Now Cursor's entry is GONE — overwritten, not expired. Next time Cursor reads state, its "Lead Coder" entry has `ideName: "Windsurf"`, fails `ideMatches`, and the agent vanishes from Cursor's sidebar until the next heartbeat. You'll get a 60-second flicker every time Windsurf writes.*

3. *`clearGridBlockers()` fix is good but incomplete. You check `info.ideName` before deleting, but `createAgentGrid()` also writes `state.terminals[reg.name]` at line 2170. If both IDEs run `createAgentGrid()` simultaneously, they both write to `state.terminals["Lead Coder"]` — last writer wins. The Cursor entry might get Windsurf's `ideName`. This isn't a crash, but it's a data-correctness issue.*

### Balanced Response
Grumpy raises valid concerns. Here's the honest assessment:

1. **`ideName` is always set for grid terminals.** `createAgentGrid()` at `extension.ts` line 2136 explicitly sets `ideName: vscode.env.appName` on every batch registration. MCP `createTerminal` does NOT set `ideName` — but MCP-created terminals are by definition local to the calling IDE and are detected via PID match (`isLocal`), so the `heartbeatAlive` path isn't their primary liveness signal. **Risk: low.**

2. **Last-writer-wins flicker is real but bounded.** If both IDEs heartbeat the same key, the entry oscillates between `ideName` values. Each IDE sees a 60s window where the agent may briefly disappear after the other IDE overwrites. **This is a known limitation of the shared-key approach.** The full suffixing plan eliminates it entirely. For most users (who don't have both IDEs actively heartbeating simultaneously), this is a non-issue. For heavy dual-IDE users, escalate to the suffixing plan.

3. **Simultaneous `createAgentGrid()` is rare.** Users typically start Agent Grid once per session. The file-lock in `updateState()` serializes writes, so the entries won't be corrupted — just potentially overwritten. The owning IDE's next heartbeat (within 60s) corrects the `ideName`. **Acceptable for a complexity-3 fix.**

**Bottom line:** This plan eliminates the most common cross-IDE collision symptoms (phantom agents, mutual deletion) with minimal risk. The remaining edge case (heartbeat flicker under simultaneous active use) is a known limitation documented in the plan. If that edge case is unacceptable, escalate to the suffixing plan.

## Proposed Changes

> [!IMPORTANT]
> **3 targeted fixes.** No new helpers, no naming changes, no cross-file coordination.

### Fix 1: Heartbeat IDE Guard in Autoban Registry
#### [MODIFY] `src/services/TaskViewerProvider.ts` (line 1846)
- **Context:** `_getAliveAutobanTerminalRegistry()` determines which terminals are alive for autoban pool management. The `heartbeatAlive` path currently bypasses `ideMatches`, causing terminals from another IDE to appear alive.
- **Logic:** Gate `heartbeatAlive` behind `ideMatches` so that only heartbeats from the current (or compatible) IDE count.
- **Implementation:**
```typescript
// BEFORE (line 1846):
const alive = isLocal || heartbeatAlive;

// AFTER:
const alive = isLocal || (heartbeatAlive && ideMatches);
```
- **Edge Cases Handled:** CLI agents without `ideName` still pass `ideMatches` (the `!termIdeName` guard returns `true`). Only cross-IDE entries with a mismatched `ideName` are filtered out.

### Fix 2: Heartbeat IDE Guard in Sidebar Enrichment
#### [MODIFY] `src/services/TaskViewerProvider.ts` (line 9921)
- **Context:** The sidebar terminal enrichment loop (inside `_refreshTerminalStatuses`) computes `termInfo.alive` for display. Same bypass: `heartbeatAlive` ignores IDE origin.
- **Logic:** Same fix as Fix 1 — gate `heartbeatAlive` behind `ideMatches`.
- **Implementation:**
```typescript
// BEFORE (line 9921):
termInfo.alive = termInfo._isLocal || heartbeatAlive;

// AFTER:
termInfo.alive = termInfo._isLocal || (heartbeatAlive && ideMatches);
```
- **Edge Cases Handled:** Identical to Fix 1. The `ideMatches` variable is already computed at line 9908–9911 in the same scope.

### Fix 3: Scope `clearGridBlockers()` to Current IDE
#### [MODIFY] `src/extension.ts` (line 2089–2095)
- **Context:** When `createAgentGrid()` starts, it clears stale `state.json` entries for all grid agent names. This unconditionally deletes entries regardless of which IDE wrote them — so Cursor starting Agent Grid wipes Windsurf's `"Lead Coder"` entry.
- **Logic:** Before deleting, check if the entry's `ideName` matches the current IDE. Only delete if it matches (or if `ideName` is missing, indicating a legacy entry).
- **Implementation:**
```typescript
// BEFORE (line 2089-2095):
await taskViewerProvider.updateState(async (state: any) => {
    if (!state.terminals) state.terminals = {};
    for (const name of agentNames) {
        delete state.terminals[name];
    }
});

// AFTER:
await taskViewerProvider.updateState(async (state: any) => {
    if (!state.terminals) state.terminals = {};
    const currentIde = (vscode.env.appName || '').toLowerCase();
    for (const name of agentNames) {
        const entry = state.terminals[name];
        if (!entry) continue;
        const entryIde = (entry.ideName || '').toLowerCase();
        // Only clear entries belonging to this IDE (or legacy entries with no ideName)
        if (!entryIde || entryIde === currentIde ||
            (entryIde === 'antigravity' && currentIde.includes('visual studio code')) ||
            (entryIde.includes('visual studio code') && currentIde === 'antigravity')) {
            delete state.terminals[name];
        }
    }
});
```
- **Edge Cases Handled:** Legacy entries without `ideName` are still cleaned up (the `!entryIde` guard). Antigravity↔VS Code compatibility is preserved. Entries from other IDEs are left untouched.

## Verification Plan

### Automated Tests
- **Unit test: Fix 1 & 2** — Mock `state.terminals` with two entries for `"Lead Coder"`: one with `ideName: "Cursor"`, one with `ideName: "Windsurf"`. Set `vscode.env.appName = "Cursor"`. Verify only the Cursor entry passes the `alive` check. Verify an entry with no `ideName` passes for both.
- **Unit test: Fix 3** — Mock `state.terminals` with `"Lead Coder": { ideName: "Windsurf" }`. Call `clearGridBlockers()` from Cursor context. Verify the entry is NOT deleted. Add a second entry `"Lead Coder": { ideName: "Cursor" }` and verify it IS deleted.
- **Manual test:** Open Cursor + Windsurf on same workspace. Start Agent Grid in Cursor. Verify Windsurf's sidebar does NOT show Cursor's agents. Start Agent Grid in Windsurf. Verify Cursor's agents remain unaffected. Close Windsurf — verify Cursor's sidebar is unchanged.

## Known Limitations
- **Shared key flicker:** If both IDEs actively heartbeat `state.terminals["Lead Coder"]`, the `ideName` field oscillates. Each IDE may briefly lose its agent from the sidebar (up to 60s) after the other IDE overwrites. This is cosmetic and self-correcting. If this is unacceptable, escalate to the full suffixing plan.
- **`housekeepStaleTerminals()` not IDE-aware:** The 24-hour pruner at line 9096 doesn't check `ideName`. Given the 24h threshold, cross-IDE mis-pruning is extremely unlikely. Can be addressed in a follow-up if needed.

## Implementation Review

### Files Changed
- `src/extension.ts` — Refactored `clearGridBlockers()` to use existing `isCompatibleIdeName()` helper instead of inline IDE matching logic (Fix 3 cleanup).
- `src/services/TaskViewerProvider.ts` — Removed redundant `.toLowerCase()` call on already-lowercased `currentIdeName` (line 10068).

### Validation Results
- `npx tsc --noEmit` passes cleanly. Only error is pre-existing `ArchiveManager` import in `KanbanProvider.ts` (unrelated).
- All three plan fixes (Fix 1, Fix 2, Fix 3) are correctly implemented in the codebase.

### Review Findings

#### MAJOR — IDE matching logic duplicated across files
The Antigravity↔VS Code cross-compatibility check is inlined in 3 locations (TaskViewerProvider.ts lines 1848–1851, 10072–10075; extension.ts clearGridBlockers). A proper helper `isCompatibleIdeName()` already exists at extension.ts:383. **Fix applied**: Refactored `clearGridBlockers()` to call the helper. The two TaskViewerProvider instances remain inline because the helper lives in extension.ts and isn't exported. **Recommend**: Extract to a shared utility in a follow-up.

#### NIT — Redundant `.toLowerCase()` in sidebar enrichment
`currentIdeName` (line 10060) is already lowercased, but line 10068 called `.toLowerCase()` again into `currentIdeNameLower`. Harmless but misleading. **Fix applied**: Removed redundant call.

#### NIT — Chat agents lack IDE guard
At line 10113, chat agent liveness (`alive: heartbeatAlive`) does not check `ideMatches`. If chat agents ever gain `ideName` semantics, this becomes a cross-IDE leak. Low risk currently since chat agents are typically local.

#### NIT — Heartbeat threshold discrepancy (pre-existing)
Autoban registry uses 60s threshold (line 1854), sidebar enrichment uses 120s (line 10082). Not introduced by this plan; the "Deregistration Bug" plan addresses this separately. Noting for awareness.

### Remaining Risks
- **Shared-key flicker**: Documented in plan. Simultaneous dual-IDE heartbeats cause 60s visibility gaps. Acceptable for complexity-3 fix; escalate to suffixing plan if user reports issues.
- **IDE matching drift**: Three inline copies of the matching logic could diverge. Extracting to shared utility would eliminate this.
- **`housekeepStaleTerminals()` not IDE-scoped**: 24h threshold makes this low-risk. Follow-up candidate.
