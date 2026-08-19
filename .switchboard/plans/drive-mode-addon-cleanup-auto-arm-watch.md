# Drive-Mode Addon Cleanup + Auto-Arm Feature Watch

## Goal

Two follow-on defects from the same observed session, both involving things the extension injects into the lead's prompt that are wrong for drive mode:

1. **Irrelevant addons:** The lead's dispatch prompt carried addons that describe implementation work — Accuracy Mode ("solo, in-conversation workflow"), SKIP COMPILATION, SKIP TESTS, SUPPRESS WALKTHROUGH. A drive-mode lead dispatches to coders and reviews diffs; it doesn't implement. The coders get their own seat-scoped directive blocks independently, so the lead's copies are pure noise. The agent read the accuracy skill, couldn't apply it, and silently carried it without flagging the mismatch.

2. **False stall notice from feature watch:** The skill presents `stopColumns: ["CODE REVIEWED"]` as an optional commented-out line. The lead omitted it. When all subtasks moved to CODE REVIEWED (handed to the reviewer), the watch saw them as un-accepted (default stop column is COMPLETED only) and fired a false stall notice — interrupting the lead during a phase where its job is done and the reviewer is working. The correct value is deterministic for drive-mode leads — the extension should arm the watch itself, not leave it to the agent.

### Root Cause

1. **Addons are resolved per-role without drive-mode awareness.** `_getPromptsConfig` maps addons by role name (`lead`, `coder`, etc.) with no consideration of whether the role is in drive mode. A lead implementing directly (non-drive) needs Accuracy Mode, SKIP COMPILATION, SKIP TESTS. A lead dispatching to coders (drive mode) does not.

2. **The feature watch arming is delegated to the agent when the extension has all the inputs.** The extension knows the feature ID, the head terminal, the workspace root, and that this is a drive-mode dispatch. The `stopColumns` value is always `["CODE REVIEWED"]` for drive-mode leads. There is no reason for the agent to make this call.

## Metadata

**Complexity:** 5
**Tags:** backend, refactor, reliability
**Project:** Browser Switchboard
**Depends on:** `inject-context-trim-skill-drive-mode-prompt-payload.md` (Part 1's enriched prompt should not include the `watchFeature` arming call — the system arms it instead)

## User Review Required

No user decision needed. The addon exclusion scope and the auto-arm watch configuration are both deterministic for drive-mode leads.

## Complexity Audit

### Routine
- Adding conditional suppression of addon variables in the lead branch of `buildKanbanBatchPrompt` (Part 1)
- Adding the same suppression in the feature-mode coder branch (Part 1)
- Writing a feature watch record to the DB config (Part 2) — same DB write the `watchFeature` verb already does

### Complex / Risky
- The auto-arm watch must fire at the correct point in the dispatch chain: after a successful drive-mode FEATURE dispatch to a lead, not after subtask dispatches. The `triggerAction` handler at line 9254 checks `dispatched && role === 'lead'` — this is the correct hook, but it must also verify the card is a feature (`card.isFeature === true`) and that drive mode is active (`feature_drive_enabled === 'true'`).
- The `triggerAction` handler is the common dispatch path for both webview drag-drop and API dispatch (`performKanbanDispatch` calls `kanbanVerb('triggerAction', ...)` at LocalApiServer.ts:1454). The auto-arm must not double-fire when both paths are exercised for the same card.
- The addon suppression in the coder branch must handle three injection points: `skipBlock` in `assembleSuffix` (line 2079), `suppressWalkthroughBlock` (line 2092), and `withCoderAccuracyInstruction` (line 2106).

## Edge-Case & Dependency Audit

**Race Conditions:** The auto-arm watch writes to `kanban.featureWatches` using the same filter-then-push pattern as the `watchFeature` verb (line 10843-10844). If the agent also arms a watch manually (old behavior), the filter-then-push replaces it — no duplicate. Safe.

**Security:** No new attack surface. The watch record is written by the extension, not by the agent.

**Side Effects:** The auto-armed watch will nudge the lead if it goes idle with un-accepted subtasks. This is the intended behavior — the nudge replaces the false stall notice with a correct one (gated on `stopColumns: ["CODE REVIEWED"]`).

**Dependencies & Conflicts:** Part 2 (auto-arm watch) depends on the companion plan's Part 1 (enriched prompt no longer tells the agent to arm the watch) and Part 2 (skill updated to note auto-arming). Part 1 (addon exclusion) is independent.

## Dependencies

- Companion plan: `inject-context-trim-skill-drive-mode-prompt-payload.md` — Part 2 (auto-arm watch) depends on Part 1 (enriched prompt no longer tells the agent to arm the watch) and Part 2 (skill updated to note auto-arming).

## Adversarial Synthesis

Key risks: (1) the auto-arm watch could fire on non-feature lead dispatches if the `isFeature` check is missing — mitigated by gating on `card.isFeature === true`; (2) the addon suppression could leak into non-drive leads if the `isDriveMode` check is wrong — mitigated by gating on both `driveMode === true` AND `featureMode === true`; (3) the coder branch suppression could break the non-feature coder path — mitigated by only applying it inside the `options?.featureMode` block. The plan correctly scopes all three.

## Proposed Changes

### `src/services/agentPromptBuilder.ts` — Part 1: Exclude implementation addons from drive-mode lead prompts

**Context:** `buildKanbanBatchPrompt`, lead branch at line 1990. Addons are resolved per-role in `_getPromptsConfig` (KanbanProvider.ts:5738) with no drive-mode awareness. A lead's defaults include `skipCompilation: true` (line 5809), `skipTests: true` (line 5820), and potentially `accurateCoding: true` (if globally enabled, line 5781). These are correct for a non-drive lead that implements directly. They are wrong for a drive-mode lead that dispatches to coders and reviews diffs — the coders receive their own seat-scoped directive blocks independently via `buildSeatDirectiveBlock`, so the lead's copies describe work the lead doesn't do.

**Scope:** This exclusion is gated on `driveMode === true` AND `featureMode === true` only. It does NOT affect:
- **Non-drive leads** — they implement directly and need these addons.
- **Reviewer teams** — the reviewer role already has correct defaults (`accurateCoding` not listed → `false`; `skipCompilation: false`; `skipTests: false`). The reviewer runs tests as part of verification. Drive mode is never set for the reviewer role (only `['lead', 'coder', 'intern']` at KanbanProvider.ts:5648).
- **Planner teams** — the planner role already has correct defaults. Drive mode is never set for the planner role.

**Implementation:** In the lead branch of `buildKanbanBatchPrompt`, after resolving `options?.driveMode`, suppress the implementation-oriented addons when drive mode is active:

```typescript
if (role === 'lead') {
    const isDriveMode = options?.driveMode === true && options?.featureMode === true;

    // Drive-mode leads dispatch to coders and review diffs — they don't
    // implement. These addons describe the coders' work, not the head's.
    // Coders receive their own seat-scoped directive blocks independently.
    const effectiveAccurateCoding = isDriveMode ? false : accurateCodingEnabled;
    const effectiveSkipCompilation = isDriveMode ? false : skipCompilation;
    const effectiveSkipTests = isDriveMode ? false : skipTests;
    const effectiveSuppressWalkthrough = isDriveMode ? false : suppressWalkthroughEnabled;

    // ... use effective* values in place of the originals when building
    //     skipBlock, withCoderAccuracyInstruction, suppressWalkthroughBlock
```

**Addons suppressed in drive mode:**

| Addon | Why irrelevant in drive mode |
|---|---|
| Accuracy Mode | Skill is "solo, in-conversation workflow" with "no cross-agent delegation." Lead dispatches, doesn't implement. |
| SKIP COMPILATION | Lead doesn't compile. Coders do — and get their own skip directives via seat-scoped blocks. |
| SKIP TESTS | Same — lead doesn't test. |
| SUPPRESS WALKTHROUGH | Lead doesn't create walkthroughs. Coders do. |

**Addons kept in drive mode:**

| Addon | Why still relevant |
|---|---|
| CAVEMAN MODE | Cosmetic — applies to any role's output style. |
| COMPLETION REPORT | The lead advances the feature card; the completion report directive is structurally needed for the board's mtime detection chain. (The coders also get it via their seat-scoped blocks.) |
| ORCHESTRATOR REPORT | Lead reports status to the orchestrator. |
| GIT POLICY | Lead commits as team head (§5.6: "the head commits as the team's head"). |
| FOCUS DIRECTIVE | Lead reads plan files. |

**Also apply the same suppression in the feature-mode coder branch** (line 2044) when `driveMode` is true. A drive-mode coder that dispatches subtasks to other coders (not implementing itself) has the same mismatch. The `featureSubagentBlock` at line 2083 already reframes the coder's role to "dispatch each subtask to a seat" in drive mode — the implementation addons should follow suit.

The coder branch has three addon injection points that need suppression:
1. `skipBlock` passed to `assembleSuffix` at line 2079 — replace with empty string when `isDriveMode`
2. `suppressWalkthroughBlock` at line 2092 — set to empty string when `isDriveMode`
3. `withCoderAccuracyInstruction` at line 2106 — pass `false` instead of `accurateCodingEnabled` when `isDriveMode`

### `src/services/KanbanProvider.ts` — Part 2: Arm the feature watch programmatically at dispatch time

**Context:** The `triggerAction` handler at line 9144 is the common dispatch path for both webview drag-drop and API dispatch (`performKanbanDispatch` calls `kanbanVerb('triggerAction', ...)` at LocalApiServer.ts:1454). After a successful dispatch, the handler checks `dispatched && role === 'lead'` at line 9254 and fires pair programming if needed. This is the correct hook for auto-arming the feature watch.

**Problem:** The skill presents `stopColumns` as an optional commented-out line (§3.5, line 288-289). A drive-mode lead omitted it. When all subtasks moved to CODE REVIEWED (handed to the reviewer), the watch saw them as un-accepted (default stop column is COMPLETED only) and fired a false stall notice — interrupting the lead during a phase where its job is done and the reviewer is working.

For a drive-mode lead, `stopColumns: ["CODE REVIEWED"]` is not optional — it's the correct configuration, and it's deterministic. The extension knows at dispatch time:
- The feature ID (from `card.featureId` for a subtask, or `card.planId` for a feature card — but the auto-arm fires when the FEATURE card is dispatched to the lead, so `card.planId` is the feature ID)
- The head terminal name (the terminal the feature was dispatched to — resolved from the dispatch context or `$SWITCHBOARD_TERMINAL`)
- The workspace root
- That this is a drive-mode dispatch (read `feature_drive_enabled` from the DB config)

**Implementation:** After the existing `dispatched && role === 'lead'` check at line 9254, add a drive-mode feature watch auto-arm:

```typescript
if (dispatched && role === 'lead') {
    const card = this._lastCards.find(c => (c.planId || c.sessionId) === sessionId && c.workspaceRoot === workspaceRoot);
    if (card && !this._isLowComplexity(card) && card.complexity !== 'Unknown') {
        await this._dispatchWithPairProgrammingIfNeeded([card], workspaceRoot);
    }
    // Auto-arm feature watch for drive-mode feature dispatches
    if (card?.isFeature && workspaceRoot) {
        const driveDb = this._getKanbanDb(workspaceRoot);
        const isDrive = driveDb && await driveDb.ensureReady()
            ? ((await driveDb.getConfig('feature_drive_enabled')) === 'true')
            : false;
        if (isDrive) {
            const featurePlanId = card.planId || card.sessionId || '';
            const headTerminal = card.dispatchedTerminal || '';
            if (featurePlanId && headTerminal) {
                const WATCH_KEY = 'kanban.featureWatches';
                const watches = await driveDb.getConfigJson<FeatureWatchRecord[]>(WATCH_KEY, []);
                const filtered = watches.filter(w => w.featureId !== featurePlanId);
                filtered.push({
                    featureId: featurePlanId,
                    headTerminal,
                    armedAt: Date.now(),
                    lastNudgedAt: 0,
                    stopColumns: ['CODE REVIEWED'],  // deterministic for drive-mode leads
                });
                await driveDb.setConfigJson(WATCH_KEY, filtered);
            }
        }
    }
}
```

This is the same DB write the `watchFeature` verb does at line 10831-10845 — just done by the extension instead of by the agent. The `stopColumns` value is hardcoded to `['CODE REVIEWED']` because:
1. Drive-mode leads always hand subtasks to review at CODE REVIEWED (per the team head prompt at teamWiring.ts:399-411).
2. The lead's job per subtask ends at CODE REVIEWED — the reviewer takes over.
3. The column pipeline after CODE REVIEWED (ACCEPTANCE TESTED → COMPLETED, or directly to COMPLETED) is not the lead's concern.

**What gets removed from the prompt:** The enriched prompt template (from the companion plan's Part 1) should NOT include the `watchFeature` arming call. Instead, it should include a one-line status note:

```
Feature watch: armed by the system (stopColumns: CODE REVIEWED). You will be nudged if you go idle with un-accepted subtasks. No action needed.
```

**What gets updated in the skill:** The §3.5 section (line 276-301) should note that the system arms the watch automatically for drive-mode dispatches, and the manual arming path is only for non-drive or external-headed teams:

```
The feature watch is armed automatically by the system when a drive-mode feature is dispatched to your terminal. You do not need to arm it yourself. The manual arming path below is for external-headed teams or non-drive dispatches only.
```

**Cancellation:** The existing auto-drop behavior is sufficient — the sweep auto-drops the watch when the feature is done or the head terminal exits (PlanIngestionEngine.ts:1069-1074). The `unwatchFeature` verb remains available for the agent to cancel manually if needed, but the system handles the normal lifecycle.

**Edge cases:**
- Drive mode on but feature mode off (shouldn't happen — drive is feature-only) → addons are kept (the `isDriveMode` check gates on both `driveMode && featureMode`)
- Reviewer team with a coder seat → reviewer prompt unchanged (reviewer role is not in the drive-mode gate)
- Non-drive dispatch → no auto-armed watch (backward compat)
- Auto-armed watch with no live coder seats → watch still arms; the sweep will nudge the lead if subtasks are un-accepted and no dispatch is outstanding
- Feature card dispatched but `dispatchedTerminal` not yet set → skip auto-arm (the watch would have no head terminal to nudge)
- API dispatch via `performKanbanDispatch` → same path (it calls `triggerAction` internally), auto-arm fires correctly

## Verification Plan

### Automated Tests
- Run existing tests: `npm test -- --grep "agentPromptBuilder"` to verify prompt builder tests pass
- Run existing tests: `npm test -- --grep "KanbanProvider"` to verify kanban provider tests pass
- Add a test for Part 1: verify a drive-mode lead prompt does NOT contain `ACCURATE_CODING_DIRECTIVE`, `SKIP_COMPILATION_DIRECTIVE`, `SKIP_TESTS_DIRECTIVE`, or `SUPPRESS_WALKTHROUGH_DIRECTIVE`
- Add a test that a non-drive lead prompt still contains these addons when enabled (backward compat)
- Add a test that a reviewer prompt is unchanged by Part 1 (reviewer addons are not affected by drive mode)
- Add a test for Part 1 coder branch: verify a drive-mode feature coder prompt does NOT contain skip/suppress/accuracy addons
- Add a test for Part 2: verify that dispatching a drive-mode feature to a lead arms a feature watch with `stopColumns: ["CODE REVIEWED"]` in the DB
- Add a test that non-drive dispatches do NOT auto-arm the watch (backward compat)
- Add a test that the auto-armed watch is dropped by the sweep when the feature completes

### Manual
1. Create a Coding team (Agents tab → Agent Groups → Coding)
2. Stage a feature with 2+ subtasks in PLAN REVIEWED
3. Enable the Drive toggle on the board
4. Enable Accuracy Mode globally (Settings → accurateCoding.enabled = true)
5. Dispatch the feature to the lead
6. Verify the lead's prompt does NOT contain:
   - "Accuracy Mode: Before coding, read and follow the workflow at .agents/skills/accuracy/SKILL.md"
   - "SKIP COMPILATION:"
   - "SKIP TESTS:"
   - "SUPPRESS WALKTHROUGH:"
   - A `watchFeature` curl command (system arms it, not the agent)
7. Verify the lead's prompt DOES contain:
   - One-line status note: "Feature watch: armed by the system"
8. Verify the lead does NOT:
   - Read the accuracy skill file
   - Arm a feature watch manually (system already did it)
9. Dispatch a non-drive lead (Drive toggle off) on a single plan → verify Accuracy Mode and skip directives ARE present (backward compat)
10. Dispatch a reviewer on a coded plan → verify reviewer prompt is unchanged (no drive-mode interference)
11. After all subtasks reach CODE REVIEWED, verify the feature watch does NOT fire a stall notice (stopColumns working)
12. Verify `kanban.featureWatches` in the DB contains the auto-armed watch with `stopColumns: ["CODE REVIEWED"]` after dispatch

### Edge cases
- Drive mode on but feature mode off (shouldn't happen — drive is feature-only) → addons are kept (the `isDriveMode` check gates on both `driveMode && featureMode`)
- Reviewer team with a coder seat → reviewer prompt unchanged (reviewer role is not in the drive-mode gate)
- Non-drive dispatch → no auto-armed watch (backward compat)
- Auto-armed watch with no live coder seats → watch still arms; the sweep will nudge the lead if subtasks are un-accepted and no dispatch is outstanding
- Feature card dispatched but `dispatchedTerminal` not yet set → skip auto-arm (the watch would have no head terminal to nudge)
- API dispatch via `performKanbanDispatch` → same path (it calls `triggerAction` internally), auto-arm fires correctly

## Dependencies & Sequencing

- Part 2 (auto-arm watch) depends on the companion plan's Part 1 (enriched prompt no longer tells the agent to arm it) and Part 2 (skill updated to note auto-arming)
- Part 1 (addon exclusion) is independent — can land anytime

Recommended order: Part 1 anytime, Part 2 after the companion plan lands

## Uncertain Assumptions

None remaining. The `triggerAction` handler's role as the common dispatch path was verified by tracing `performKanbanDispatch` (LocalApiServer.ts:1454) which calls `kanbanVerb('triggerAction', ...)`. The `KanbanCard` interface's `isFeature` and `featureId` fields were confirmed at KanbanProvider.ts:132-133. The `FeatureWatchRecord` type and its `stopColumns` field were confirmed at PlanIngestionEngine.ts:110-118.
