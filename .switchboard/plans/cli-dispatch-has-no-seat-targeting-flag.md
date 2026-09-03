# CLI dispatch ignores planner round-robin — all dispatches land on the same seat

## Goal

Fix the planner round-robin so that sequential `switchboard dispatch` calls actually spread work across planner seats, and add a `--seat <name>` escape hatch for explicit targeting.

### Problem Analysis

**Round-robin is implemented but not working from the CLI.** `KanbanProvider.ts:10619-10625` has a planner rotation cursor (`getPlannerRotationCursor` / `advancePlannerRotationCursor`, `TaskViewerProvider.ts:8158-8170`) that picks `terminals[cursor % terminals.length]` and advances after successful dispatch. This is wired on both the `custom-user` branch (`:10521`) and the built-in branch (`:10619`). The cursor is stored in `globalState` (`switchboard.planner.rotationCursor`), keyed by `locationKey` from `getRoleTerminalSet`.

**Observed behaviour:** dispatching 2 cards via `switchboard dispatch <id> "PLAN REVIEWED"` sent both to `planner-1`. The second dispatch should have gone to `planner-2` because the cursor should have advanced after the first successful dispatch.

**Possible root causes (original investigation):**
1. **The CLI path doesn't reach the round-robin branch.** `performKanbanDispatch` (`LocalApiServer.ts:2007`) calls `kanbanVerb('triggerAction', ...)` which enters the `triggerAction` case. The round-robin lives inside `if (canDispatch)` at `:10590` — if `canDispatch` was false (no agent CLI available), the round-robin is never reached and the card dispatches through a fallback that doesn't rotate.
2. **`advancePlannerRotationCursor` failed silently.** The advance is inside a `if (dispatched && plannerCursorLocationKey && tvp)` guard (`:10633`). If `dispatched` came back `false` or `undefined` despite the card moving, the cursor stays at 0.
3. **`getRoleTerminalSet` returned a different `locationKey`** between calls, so the second dispatch read a fresh cursor (0) instead of the advanced one.
4. **`globalState` is VS Code extension state** — the standalone/CLI host may not have a real `globalState` implementation, so the cursor writes go nowhere and every dispatch reads 0.

> **Superseded:** Root cause 4 is the most likely. The standalone host's `ExtensionContext` mock may not persist `globalState` across requests, which would make the round-robin permanently stuck on terminal index 0.
> **Reason:** The standalone host's `globalState` IS persistent. `bootstrap.ts:1079-1112` defines `fileBackedMemento`, which reads the state file at construction into an in-memory Map and writes synchronously to disk on every `update()` call. The cursor persists across requests and across server restarts. The plan's root cause was disproven by reading the code.
> **Replaced with:** The real root cause is a composition-root divergence — see below.

### Root Cause

**The standalone host intercepts `triggerAction` before it reaches KanbanProvider, bypassing the round-robin entirely.**

The extension host routes ALL kanban verbs through `kanbanProvider.handleServiceVerb` (TaskViewerProvider.ts:4177):
```js
kanbanVerb: async (verb, payload, wsRoot) => {
    return await this._kanbanProvider.handleServiceVerb(verb, p);
}
```

The standalone host's `kanbanVerb` (bootstrap.ts:1462) has an explicit `case 'triggerAction':` (line 1652) that routes to `handlePtyVerb` — NOT to `kanbanProvider.handleServiceVerb`:
```js
case 'triggerAction':
case 'sendToTerminal': {
    return await handlePtyVerb(verb, payload, root);
}
default: {
    return await kanbanProvider.handleServiceVerb(verb, ...);
}
```

The round-robin cursor logic lives inside KanbanProvider's `triggerAction` case (KanbanProvider.ts:10440-10643). Because standalone never calls `handleServiceVerb('triggerAction', ...)`, the round-robin is unreachable.

`handlePtyVerb`'s `triggerAction` case (bootstrap.ts:2430-2629) does its own terminal resolution with no rotation:
```js
const overrideName: string | undefined = payload.terminalName;
if (overrideName) {
    terminal = active.find(t => t.friendlyName === overrideName);
}
if (!terminal) {
    terminal = matchedWtPath
        ? active.find(t => t.worktreePath === matchedWtPath && t.role === targetRole)
            || active.find(t => t.worktreePath === matchedWtPath)
        : active.find(t => t.role === targetRole);  // ← always first match
}
```

`active.find(t => t.role === targetRole)` always returns the first planner terminal (`planner-1`).

**Secondary bug — field name mismatch on `targetTerminalOverride`:** `performKanbanDispatch` sends the override as `targetTerminalOverride` in the `triggerAction` payload (LocalApiServer.ts:1940), but `handlePtyVerb` reads `payload.terminalName` (bootstrap.ts:2499). These are different field names. Even when `teamOverride` is resolved via team-scoped routing (LocalApiServer.ts:2079-2081, wired in standalone at bootstrap.ts:3335), the override is silently discarded by `handlePtyVerb`. This means team-scoped routing is also broken for every `kanbanVerb('triggerAction')` call in standalone.

## Metadata

**Complexity:** 5
**Tags:** cli, bugfix, reliability
**Project:** Browser Switchboard

## User Review Required

This plan corrects the root cause from the original investigation. The original root cause (globalState not persistent) was disproven by code reading. The real root cause is a composition-root divergence in the standalone host's verb routing. Reviewer should confirm the divergence analysis matches their understanding before implementation proceeds.

## Complexity Audit

### Routine
- Adding `--seat <name>` flag parsing to `cmdDispatch` (cli.ts:1233-1246) — follows the existing `--project` parsing pattern.
- Threading `seat` through `doDispatch` → POST body → `_handleKanbanDispatch` → `dispatchOptions.targetTerminalOverride` — straightforward field passing.
- Reading `payload.targetTerminalOverride` alongside `payload.terminalName` in `handlePtyVerb` — one-line field alias.

### Complex / Risky
- Adding round-robin cursor logic to `handlePtyVerb`'s `triggerAction` terminal resolution (bootstrap.ts:2497-2512) — must mirror KanbanProvider's logic (pick without advancing, advance after successful delivery) using `taskViewerProvider.getRoleTerminalSet` / `getPlannerRotationCursor` / `advancePlannerRotationCursor`. The advance must be gated on successful delivery (not just terminal selection) to avoid skipping a planner slot on a failed dispatch.
- The field name mismatch fix (`targetTerminalOverride` → `terminalName`) affects team-scoped routing behavior in standalone — changing it means team-scoped overrides will now actually be honored, which is correct but changes observable behavior for any standalone dispatch that previously silently ignored the override.

## Edge-Case & Dependency Audit

**Race Conditions:**
- Two concurrent `switchboard dispatch` calls could read the same cursor value before either advances. The existing `getPlannerRotationCursor` / `advancePlannerRotationCursor` pair is not atomic — it reads, then writes. This is the same race that exists in the extension host (KanbanProvider.ts:10630-10642). The fix mirrors the extension's behavior; it does not introduce a new race, but it also does not fix the existing one. Acceptable: sequential CLI dispatches are the expected usage pattern.

**Security:**
- `--seat <name>` passes a terminal name through the API to `handlePtyVerb`. The name is used in `active.find(t => t.friendlyName === overrideName)` — if no match, it falls through to role-based matching. No injection risk (terminal names are looked up, not executed).

**Side Effects:**
- Fixing the `targetTerminalOverride` field name mismatch will change behavior for team-scoped routing in standalone: overrides that were previously silently discarded will now be honored. This is a correctness fix, but any standalone dispatch that relied on the broken behavior (unlikely — the override was never applied) would change.

**Dependencies & Conflicts:**
- `taskViewerProvider` is accessible from `handlePtyVerb`'s closure (module-level variable at bootstrap.ts:237, set at line 1162). No new import needed.
- `getRoleTerminalSet`, `getPlannerRotationCursor`, `advancePlannerRotationCursor` are all public methods on TaskViewerProvider — no new public API needed.

## Dependencies

None — this plan is self-contained.

## Adversarial Synthesis

Key risks: (1) the round-robin advance must be gated on successful prompt delivery, not terminal selection — a failed dispatch must not skip a planner slot; (2) the `targetTerminalOverride` field name fix changes team-scoped routing behavior in standalone (previously broken, now honored); (3) concurrent dispatches share the same non-atomic cursor race as the extension host. Mitigations: mirror KanbanProvider's advance-after-success guard exactly; the field name fix is a correctness restoration, not a behavior change; the race is pre-existing and acceptable for sequential CLI usage.

## Proposed Changes

### src/standalone/bootstrap.ts — `handlePtyVerb` `triggerAction` terminal resolution (lines 2497-2512)

**Context:** The terminal resolution block picks a PTY terminal for dispatch. When no override is supplied and the role is `planner`, it currently does `active.find(t => t.role === targetRole)` — always the first match. The round-robin cursor logic that exists in KanbanProvider (KanbanProvider.ts:10627-10643) is never reached because `kanbanVerb` intercepts `triggerAction` at line 1652.

**Logic:**
1. **Field name fix:** Read the override from BOTH `payload.terminalName` and `payload.targetTerminalOverride` (the latter is what `performKanbanDispatch` sends at LocalApiServer.ts:1940). Prefer `targetTerminalOverride` if set, fall back to `terminalName`.
2. **Round-robin for planner role:** When no override is supplied and `targetRole === 'planner'` and `taskViewerProvider` is available:
   - Call `await taskViewerProvider.getRoleTerminalSet('planner', root)` to get `{ terminals, locationKey }`.
   - If `terminals.length > 0`, read `const cursor = taskViewerProvider.getPlannerRotationCursor(locationKey)` and pick `terminals[cursor % terminals.length]`.
   - Look up that terminal name in the active PTY fleet: `active.find(t => t.friendlyName === pickedName)`.
   - If found, use it. If not found (terminal not alive), fall through to the existing role-based matching.
   - Store `plannerCursorLocationKey` for advancement after successful delivery.
3. **Advance after success:** After `deliverPrompt` succeeds (delivery is not an exit failure), if `plannerCursorLocationKey` is set, call `await taskViewerProvider.advancePlannerRotationCursor(plannerCursorLocationKey, 1)`. This mirrors KanbanProvider.ts:10641-10642 — advance only after successful dispatch so a failed dispatch doesn't skip a planner slot.

**Implementation:**
```typescript
// Replace the terminal resolution block (lines 2497-2512):
const active = ptyFleetService.listActive();
let terminal: any;
// Field name fix: performKanbanDispatch sends targetTerminalOverride;
// switchboard.triggerAgentFromKanban sends terminalName. Accept both.
const overrideName: string | undefined = payload.targetTerminalOverride || payload.terminalName;
let plannerCursorLocationKey: string | undefined;
if (overrideName) {
    terminal = active.find(t => t.friendlyName === overrideName);
}
if (!terminal && targetRole === 'planner' && taskViewerProvider) {
    const { terminals, locationKey } = await taskViewerProvider.getRoleTerminalSet('planner', root);
    if (terminals.length > 0) {
        const cursor = taskViewerProvider.getPlannerRotationCursor(locationKey);
        const pickedName = terminals[cursor % terminals.length];
        const picked = active.find(t => t.friendlyName === pickedName);
        if (picked) {
            terminal = picked;
            plannerCursorLocationKey = locationKey;
        }
    }
}
if (!terminal) {
    terminal = matchedWtPath
        ? active.find(t => t.worktreePath === matchedWtPath && t.role === targetRole)
            || active.find(t => t.worktreePath === matchedWtPath)
        : active.find(t => t.role === targetRole);
}
if (!terminal) {
    terminal = await ptyFleetService.create(targetRole, overrideName, matchedWtPath || root, matchedWtPath);
}
```

Then after the `deliverPrompt` call and the exit-failure check (after line 2591), add the cursor advance:
```typescript
if (plannerCursorLocationKey && taskViewerProvider) {
    await taskViewerProvider.advancePlannerRotationCursor(plannerCursorLocationKey, 1);
}
```

**Edge Cases:**
- If `getRoleTerminalSet` returns terminals that are not in the active PTY fleet (e.g., terminal died between calls), the `active.find` returns undefined and the code falls through to role-based matching. The cursor is NOT advanced (no `plannerCursorLocationKey` set), so the next dispatch retries the same cursor. This is correct — a dead terminal should not skip a slot.
- If `taskViewerProvider` is null (shouldn't happen in standalone, but defensive), the round-robin is skipped and the existing behavior applies.
- If `payload.targetTerminalOverride` is an empty string (falsy), it falls through to `payload.terminalName`, then to round-robin. Correct — empty string is not a valid terminal name.

### src/standalone/cli.ts — `cmdDispatch` `--seat` parsing (lines 1233-1246)

**Context:** `cmdDispatch` parses positional args and flags. Currently supports `--project` and `--json`. Need to add `--seat <name>`.

**Logic:** Add `--seat` parsing in the existing arg loop. Pass the seat name to `doDispatch`.

**Implementation:**
```typescript
// In cmdDispatch, add seat parsing:
let seat: string | undefined;
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { continue; }
    if (a === '--project') { project = argv[++i]; continue; }
    if (a === '--seat') { seat = argv[++i]; continue; }
    if (!a.startsWith('-') && !ref) { ref = a; continue; }
    if (!a.startsWith('-') && ref && column === 'auto') { column = a; continue; }
}
```

Update the usage string (line 1250):
```
Usage: npx switchboard dispatch <planId|prefix> [column] [--project <name>] [--seat <terminal>] [--json]
```

Pass `seat` to `doDispatch`:
```typescript
await doDispatch(port, workspaceRoot, planId, column, jsonFlag, seat);
```

### src/standalone/cli.ts — `doDispatch` seat threading (line 1207)

**Context:** `doDispatch` sends the POST body to `/kanban/dispatch`. Need to include `seat` in the body.

**Implementation:**
```typescript
async function doDispatch(port: number, workspaceRoot: string, planId: string, targetColumn: string, jsonFlag = false, seat?: string): Promise<void> {
    const res = await apiPost(port, '/kanban/dispatch', workspaceRoot, {
        plan: planId,
        targetColumn,
        workspaceRoot,
        ...(seat ? { seat } : {}),
    });
    // ... rest unchanged
}
```

### src/services/LocalApiServer.ts — `_handleKanbanDispatch` seat reading (lines 1869-1894)

**Context:** `_handleKanbanDispatch` reads the POST body and calls `performKanbanDispatch`. Need to read `seat` from the body and pass it as `dispatchOptions.targetTerminalOverride`.

**Implementation:**
```typescript
// In _handleKanbanDispatch, after reading `from` (line 1879):
const seat = String(body?.seat || '').trim();
// Then in the performKanbanDispatch call (line 1892-1893):
const outcome = acked
    ? await this.performKanbanDispatchAcked(
        workspaceRoot, ref, rawColumn || undefined,
        { originTerminal: from || undefined, ...(seat ? { targetTerminalOverride: seat } : {}) }
    )
    : await this.performKanbanDispatch(
        workspaceRoot, ref, rawColumn || undefined,
        { originTerminal: from || undefined, ...(seat ? { targetTerminalOverride: seat } : {}) }
    );
```

`performKanbanDispatch` already passes `dispatchOptions.targetTerminalOverride` through to `kanbanVerb('triggerAction', { ..., targetTerminalOverride: teamOverride })` at line 1940. With the `handlePtyVerb` field name fix above, the override will now be honored in standalone.

## Verification Plan

### Automated Tests
- Test that `handlePtyVerb`'s `triggerAction` reads `payload.targetTerminalOverride` (not just `payload.terminalName`).
- Test that sequential planner dispatches advance the rotation cursor (mock `getRoleTerminalSet` returning `['planner-1', 'planner-2']`, verify second dispatch picks `planner-2`).
- Test that a failed dispatch (exit during boot) does NOT advance the cursor.
- Test that `--seat planner-3` override bypasses the round-robin and dispatches to `planner-3`.
- Test that `cmdDispatch` parses `--seat <name>` correctly and passes it to the POST body.
- Test that `_handleKanbanDispatch` reads `seat` from the body and passes it as `targetTerminalOverride`.

### Goal Invariants
- `handlePtyVerb` in `bootstrap.ts` reads `payload.targetTerminalOverride` (in addition to `payload.terminalName`) at the terminal resolution block — assert the string `payload.targetTerminalOverride` appears in the `case 'triggerAction':` block of `handlePtyVerb`.
- `handlePtyVerb` in `bootstrap.ts` calls `taskViewerProvider.getPlannerRotationCursor` within the `case 'triggerAction':` block — assert the string `getPlannerRotationCursor` appears in `handlePtyVerb`'s `triggerAction` case.
- `handlePtyVerb` in `bootstrap.ts` calls `taskViewerProvider.advancePlannerRotationCursor` after the `deliverPrompt` call — assert the string `advancePlannerRotationCursor` appears after the `deliverPrompt` call in the `triggerAction` case.
- `cmdDispatch` in `cli.ts` parses `--seat` — assert the string `--seat` appears in the arg-parsing loop of `cmdDispatch`.
- `doDispatch` in `cli.ts` accepts a `seat` parameter — assert the function signature includes `seat`.
- `_handleKanbanDispatch` in `LocalApiServer.ts` reads `body?.seat` — assert the string `body?.seat` or `body.seat` appears in `_handleKanbanDispatch`.

### Manual Verification
1. `switchboard dispatch <id1> "PLAN REVIEWED"` → lands on `planner-1`.
2. `switchboard dispatch <id2> "PLAN REVIEWED"` → lands on `planner-2` (not `planner-1`).
3. `switchboard dispatch <id3> "PLAN REVIEWED"` → lands on `planner-3`.
4. `switchboard dispatch <id4> "PLAN REVIEWED"` → lands on `planner-4`.
5. `switchboard dispatch <id5> --seat planner-3` → lands on `planner-3` regardless of cursor.
6. Rotation cursor persists across server restarts (verified by `fileBackedMemento` writing to `standalone-state.json`).

**Recommendation: Send to Coder** (Complexity 5 — multi-file changes across CLI, API server, and standalone bootstrap, with moderate logic for the round-robin cursor integration).
