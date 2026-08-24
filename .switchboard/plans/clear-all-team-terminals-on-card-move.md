# Clear All Team Terminals When a Card Moves Into a Team

## Goal

When a card is moved into a team (dispatched to any seat on a registered team), `/clear` must be sent to **every** terminal on that team — not just the destination seat. This ensures the team lead and all coders start from a clean context, so the team lead can review and commit the new work without stale context from a previous run bleeding in.

### The problem, and the root cause

Today, when a card is dragged into a team column, only the destination seat's terminal gets `/clear` before the prompt. The team lead and other coders keep whatever context they accumulated from prior runs. When the team lead later needs to review or commit the new work, it's carrying an unrelated prior card's context — leading to confused reviews, wrong-file commits, and stale assumptions.

The root cause is architectural: the clear happens inside `_attemptDirectTerminalPush`, which only targets the one terminal the card is being dispatched to. There is no team-aware step in the dispatch path that would clear sibling terminals.

## Metadata

**Complexity:** 3
**Tags:** backend, feature, reliability
**Project:** Browser Switchboard

## Implementation Plan

### Step 1: Add team-wide clear in `_handleTriggerAgentActionInternal`

**File:** `src/services/TaskViewerProvider.ts`
**Location:** `_handleTriggerAgentActionInternal` (~line 21851), after `targetAgent` is resolved and validated, but before the prompt generation and dispatch.

After the target agent is resolved and the F-04 security validation passes (line ~21864), insert a fire-and-forget team-wide clear:

```typescript
// Team-wide clear: when a card is dispatched to a seat on a registered team,
// clear ALL team members' terminals — not just the destination seat. The
// destination seat is cleared by the dispatch path's own clearBeforePrompt
// logic; this clears the team lead and any other coders so they start fresh
// for review/commit of the new work. Fire-and-forget: the clipboard lock in
// terminalUtils.ts serializes the actual /clear pastes, and a clear failure
// for one member must not block the dispatch. Respects terminal.clearBeforePrompt
// (clearTerminalContext returns {cleared:false} when the config is off).
try {
    const roster = await this.resolveTeamMembers(resolvedWorkspaceRoot, targetAgent);
    if (roster && roster.length > 1) {
        const others = roster.filter(name => name !== targetAgent);
        if (others.length > 0) {
            void Promise.allSettled(
                others.map(name => this.clearTerminalContext(resolvedWorkspaceRoot, name))
            );
        }
    }
} catch { /* best-effort — team resolution failure does not block dispatch */ }
```

**Why fire-and-forget:** The clears for other team members are background hygiene — they should not delay the dispatch to the target seat. The `clearTerminalContext` method uses `withTerminalSendLock` per terminal and the shared `_clipboardLock` serializes clipboard pastes, so parallel clears are safe. A clear failure is logged inside `clearTerminalContext` and returns `{cleared: false}` — the `Promise.allSettled` wrapper ensures one failure doesn't reject the batch.

**Why `resolveTeamMembers` works for non-head targets:** `resolveTeamMembersForHead` (the underlying implementation) first tries to find a group headed by the given terminal, then falls back to the first group that contains the terminal as a member. So passing a coder or intern name as `originName` correctly resolves to that coder's team roster (head + all members).

### Step 2: Verify the batch dispatch path is covered

**File:** `src/services/TaskViewerProvider.ts`

`handleKanbanBatchTrigger` dispatches multiple cards, each via `_handleTriggerAgentAction` → `_handleTriggerAgentActionInternal`. Since the team-wide clear is in `_handleTriggerAgentActionInternal`, each card in the batch triggers its own team-wide clear. This is redundant (the same team lead gets cleared N times) but harmless — the second clear is a no-op if the terminal is already clean. No additional change needed for the batch path.

### Step 3: Verify the `dispatchConfiguredKanbanColumnAction` path is covered

**File:** `src/services/TaskViewerProvider.ts`

The custom-user column branch in `KanbanProvider.triggerAction` calls `dispatchConfiguredKanbanColumnAction`, which for single cards calls `_handleTriggerAgentAction` → `_handleTriggerAgentActionInternal`. Covered by Step 1. No additional change needed.

## Edge Cases

| Case | Behavior |
|------|----------|
| Target not on any team | `resolveTeamMembers` returns null → no additional clears, normal dispatch proceeds |
| Target is the only team member | Roster has 1 entry → `others` is empty → no additional clears |
| `terminal.clearBeforePrompt` config is off | `clearTerminalContext` returns `{cleared:false}` without sending — no clears for anyone, including the target (which also respects this config in the dispatch path) |
| Clear failure for one team member | Logged inside `clearTerminalContext`, returns `{cleared:false}` — `Promise.allSettled` isolates it, dispatch proceeds |
| PTY fleet vs VS Code terminals | `clearTerminalContext` handles both (PTY fleet first, then registered VS Code terminals, then open terminals) |
| Standing orders after clear | `clearTerminalContext` already calls `_deliverStandingOrdersAfterClear` — cleared team members get their callback instructions restored |
| Concurrent dispatches to same team | Each dispatch triggers its own team-wide clear; clipboard lock serializes pastes; redundant clears are no-ops on already-clean terminals |

## Verification Plan

1. **Manual test — single card to team coder:**
   - Set up a team with a lead, coder, and intern
   - Move a card to a coder seat
   - Verify: coder terminal gets `/clear` + prompt (existing behavior), lead terminal gets `/clear` (new), intern terminal gets `/clear` (new)

2. **Manual test — low-complexity card to intern:**
   - Move a low-complexity card to an intern seat on a team
   - Verify: intern gets `/clear` + prompt, lead and coder get `/clear`

3. **Manual test — card to non-team terminal:**
   - Move a card to a standalone terminal (not on any team)
   - Verify: only the target gets `/clear` (no team-wide clear, no error)

4. **Manual test — `clearBeforePrompt` config off:**
   - Disable `terminal.clearBeforePrompt` in settings
   - Move a card to a team seat
   - Verify: no clears happen for any terminal (target or team members)

5. **Test — standing orders restored after team-wide clear:**
   - Set a team-scoped standing order on the team lead
   - Move a card to a coder on that team
   - Verify: team lead gets `/clear` then its standing orders re-delivered

6. **Run existing tests:**
   - `node --check src/services/TaskViewerProvider.ts` — syntax check
   - Run `src/test/seat-safeguards-fleet-prompt-path.test.js` — existing dispatch path assertions still pass
   - Run `src/test/standing-orders-marker-contract.test.js` — standing orders delivery after clear still works

## Implementation Summary

Implemented Step 1 only (Steps 2–3 verified no change needed). Inserted a fire-and-forget team-wide clear block in `_handleTriggerAgentActionInternal` (`src/services/TaskViewerProvider.ts`, after the F-04 security validation at line ~22079, before the terminal-focus block). After `targetAgent` is resolved and validated, the code calls `resolveTeamMembers(resolvedWorkspaceRoot, targetAgent)`; if the roster has >1 member, it filters out the destination seat and runs `void Promise.allSettled(others.map(name => this.clearTerminalContext(...)))`. The roster DB read is awaited (fast), but the sibling clears are detached — dispatch to the target proceeds without waiting. `clearTerminalContext` respects `terminal.clearBeforePrompt` (returns `{cleared:false}` when off), never throws, and re-delivers standing orders after a successful clear. Batch and custom-column dispatch paths route through the same `_handleTriggerAgentActionInternal`, so they inherit the team-wide clear (redundant clears on already-clean terminals are no-ops). Compilation and tests skipped per run directives.
