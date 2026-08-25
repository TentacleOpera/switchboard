# Atomic team context lifecycle per feature run

## Goal

Treat a team as one atomic context for a feature run: clear the full roster once when a new `featureId ?? planId` enters the team, preserve context through coder reports, review, fixes, and handoffs, then clear only the accepted coder when the lead marks that subtask complete. Prevent per-card and per-subtask dispatches from repeatedly resetting the team.

### Problem Analysis

The current implementation mixes three different lifecycle events:

1. A per-terminal last-plan map clears a destination whenever its subtask `planId` changes.
2. `_handleTriggerAgentActionInternal` clears every sibling except the destination on every team card dispatch.
3. `queue/done` clears a coder as soon as the coder self-reports completion.

All three are wrong for an atomic team working a large feature:

- Different subtask plans inside one feature are one team work context, not independent resets.
- A coder’s self-report starts lead review; context must survive fix requests.
- Clearing every card dispatch can wipe active sibling work and makes context length unpredictable.
- Waiting until a future dispatch is too late; accepted coders need their context reset before later subtasks accumulate beyond limits.

The repository already has the correct acceptance signal: `POST /kanban/task/complete`. A lead calls it after review is satisfied. It is idempotent, writes `completed_at`, and currently states “no terminal clear.” That contract should become the accepted-subtask clear owner.

### Work-Context Boundary

Resolve host-side from the canonical plan row:

```ts
const workContextKey = record.featureId || record.planId;
```

- Feature subtask → parent `featureId`.
- Feature card → its own `planId`.
- Featureless plan → its `planId`.
- Caller-supplied feature/team identity is never trusted.

## Metadata

**Tags:** backend, bugfix, reliability, feature
**Complexity:** 8
**Project:** Browser Switchboard

## User Review Required

None. The operator explicitly defined the lifecycle: new feature clears the whole atomic team; coder report preserves context; lead acceptance clears that coder.

## Complexity Audit

### Routine

- Read `featureId` already present on `KanbanPlanRecord`.
- Reuse `resolveTeamStanding`/group roster resolution.
- Reuse per-terminal clear locks/readiness results.
- Extend the existing idempotent task-complete endpoint.

### Complex / Risky

- Team and non-team work-context maps need different keys/lifecycles.
- A feature-run clear is a full-roster barrier, not fire-and-forget hygiene.
- `queue/done` currently combines report, clear, and queue progression; team clear must be removed without breaking completion notifications or queue sequencing.
- Acceptance must clear the recorded coder, not the lead named in `from`.
- Duplicate `task/complete` calls must not clear twice.

## Edge-Case & Dependency Audit

### Race Conditions

- New team run: clear all active roster members concurrently, but do not dispatch the first prompt until all readiness/manual waits complete.
- Store team work key only after successful barrier or explicit policy skip; failed preparation must not look initialized.
- Two simultaneous first-subtask dispatches for one team must share one per-team preparation chain.
- `task/complete` writes completion once, then clears once. Idempotent repeats return prior result without another clear.
- A lead can request fixes before acceptance; no clear occurs until task-complete.

### Security

- Resolve plan, feature, dispatched terminal, team, and roster from DB/host state.
- `from` remains the lead identity supplied to the authenticated endpoint; never clear `from` by default.
- Resolve the accepted coding seat host-side. Prefer the current `dispatchedTerminal` only when dispatch role/history proves it is the coder/intern accepted for this plan; otherwise use canonical dispatch history/events. Never clear a lead, planner, reviewer, or arbitrary caller-supplied seat.

### Side Effects

- Team coders retain context between self-report and lead acceptance.
- Accepted coders clear promptly, controlling context growth across large features.
- Planner/reviewer/lead contexts are not cleared merely because a coder subtask completes.
- Non-team queue behavior can retain its existing completion-clear contract.
- Full team reset occurs at next feature-run boundary, covering seats not individually accepted/cleared.

### Dependencies & Conflicts

- Depends on the PTY clear-readiness engine for correct direct-PTY barriers.
- Dispatch curtain presents the barrier but does not own policy.
- Supersedes per-card roster clearing in `clear-all-team-terminals-on-card-move.md` while preserving its atomic-team intent.
- Generalizes host auto-clear from `planId` to `featureId ?? planId`.

## Dependencies

- `bracketed-paste-submit-cr-not-firing-on-devin-3000-5-20-under-load.md` — reliable clear primitive and timing policy.

## Adversarial Synthesis

The dangerous simplifications are clearing on coder report (too early), clearing on next dispatch (too late), or comparing subtask plan IDs (too often). The single coherent lifecycle is team-run barrier at `featureId ?? planId`, no clear during review/fix, and one coder clear on the lead’s first successful acceptance post.

## Proposed Changes

### 1. Shared work-context resolver

Add a host-side helper that resolves a dispatch’s canonical plan record from `planId` or `planFile`, then returns:

```ts
{
  planId: record.planId,
  featureId: record.featureId || null,
  workContextKey: record.featureId || record.planId
}
```

Use the pinned workspace database. Do not add trusted `featureId` to the public dispatch payload.

### 2. Team and terminal context maps

**Files:**

- `src/services/TaskViewerProvider.ts`
- `src/standalone/bootstrap.ts`

Replace terminal-name → last-plan tracking with:

- non-team terminal name → last work-context key;
- team ID → last work-context key;
- per-team promise chain for preparation.

Map lifecycle:

- Host/fleet restart: maps empty; handles are fresh.
- Team stop/delete: remove team key.
- Team rename/membership change: preserve by stable team ID; new member joining an active run must clear before receiving work.
- Individual accepted-coder clear: do not delete team run key.
- Clear-all/team reset: remove relevant keys.

### 3. Once-per-run full-roster preparation

On dispatch to a registered team:

1. Resolve `teamId`, live roster, and work-context key.
2. If key matches, send with `clearBeforePrompt:false` and no roster clear.
3. If key differs, enqueue one team preparation operation.
4. Clear every active member, including destination, concurrently.
5. Await all clear readiness/manual results as a barrier.
6. Abort first dispatch if any active member clear fails; do not start a partially stale team.
7. Store team key.
8. Send first prompt without another destination clear.

When `terminal.clearBeforePrompt` is disabled, skip clear but explicitly store the new key/policy outcome so every subtask does not retry the disabled operation.

For a non-team terminal, compare its work-context key and clear only that destination when changed.

### 4. Replace unconditional per-card roster clear

Remove the current `TaskViewerProvider._handleTriggerAgentActionInternal` block that resolves the roster and clears all `others` for every card. Its replacement is the team preparation operation above.

Batch dispatches whose cards share one feature must coalesce onto one team barrier. Different feature keys competing for the same atomic team serialize; the later run begins only after the earlier operation releases.

### 5. `queue/done` becomes report/progress for team members

**File:** `src/services/LocalApiServer.ts`

For team queue/done paths:

- Preserve working-state release, lead relay, evidence, failure escalation, and queue progression.
- Do not call `clearTerminalContext` for the reporting team seat.
- Return `cleared:false`/an explicit reason such as `awaiting-lead-acceptance` if response compatibility requires the field.
- Non-team queue/done may keep existing proactive clearing.

Update standing-order text that currently promises “the system will … clear your terminal” immediately after report.

### 6. Lead acceptance clears the accepted coder

**File:** `src/services/LocalApiServer.ts`

Extend `POST /kanban/task/complete`:

1. Read the canonical plan row and dispatch history before writing `completed_at`.
2. Resolve the accepted coding seat from host evidence: current `dispatchedTerminal` only when its dispatch role is coder/intern, otherwise the latest canonical coding dispatch event for this plan. A feature aggregate, lead, planner, or reviewer is not a clear target.
3. Preserve the existing idempotency check.
4. On first successful completion write/event, call `clearTerminalContext(workspaceRoot, acceptedCodingSeat)` when one resolves.
5. Never clear the lead in `from` or trust a caller-supplied seat without validating it against dispatch history/team membership.
6. Clear failure does not roll back accepted completion; log and return `{ cleared:false, clearError? }`.
7. Idempotent repeat returns the stored completion and does not clear again.

Update endpoint contract comment from “no terminal clear” to “clear accepted work’s recorded seat once.”

### 7. Drive/standing-order contract

Update `_buildDrivePrefix` and team queue orders:

- Coder self-report does not clear context.
- Lead reviews diff and resends fixes to same seat with context preserved.
- Lead posts task-complete only after acceptance.
- Successful acceptance clears the coder.
- Team roster clears once when a new feature run starts.
- Do not manually clear between subtasks/fixes before acceptance.

### 8. Tests

Update/replace host auto-clear and team-clear contracts:

- Work key uses canonical feature ID.
- New feature clears full roster once.
- Different subtask plan IDs under same feature do not clear.
- Featureless plan uses plan ID.
- Concurrent first dispatches coalesce.
- Team queue/done does not clear.
- Fix resend before acceptance preserves context.
- First task-complete clears the host-resolved accepted coder/intern once and never clears a lead/planner/reviewer.
- Duplicate task-complete does not clear twice.
- Clear failure does not undo `completed_at`.
- Non-team behavior remains covered.

## Verification Plan

### Automated Tests

- Atomic team work-context resolver/map tests.
- Team preparation chain/barrier tests.
- `queue/done` team versus non-team clear tests.
- `task/complete` acceptance-clear and idempotency tests.
- Existing queue relay/escalation/feature-watch contracts.

### Goal Invariants

- Team context key equals canonical `featureId ?? planId`.
- One new feature run produces one full-roster clear barrier.
- Same-feature subtask dispatch produces zero roster clears.
- Team coder `queue/done` produces zero clear calls.
- First successful lead task-complete clears exactly one host-resolved coder/intern and never the lead/planner/reviewer.
- Duplicate task-complete produces zero additional clear calls.
- Team run key survives individual accepted-coder clear.

### Manual Verification

1. Feature A → Feature B: all team seats clear once before B starts.
2. B subtask 1 coder reports: no clear; lead requests fix; coder retains context.
3. Lead accepts subtask 1: coder clears immediately.
4. B subtask 2 to same coder: no team barrier; coder starts clean from acceptance clear.
5. Reviewer/lead context persists across B.
6. New Feature C: full roster clears once.

## Recommendation

Send to Lead Coder.

## Implementation Summary

Implemented atomic team work-context lifecycle keyed by canonical `featureId ?? planId` across extension and standalone hosts. Replaced unconditional per-card team clears with a once-per-run full-roster preparation barrier, ensuring sibling contexts are preserved throughout subtask dispatches and review fix cycles. Updated `queue/done` so team member self-reports preserve context for lead verification and fix requests without clearing. Extended `POST /kanban/task/complete` to resolve the accepted coding seat from host evidence and clear that seat once upon lead acceptance. Updated standing orders, drive rules, and contract tests to reflect the new lifecycle.


## Review Findings

Reviewed and fixed. **Files changed:** `src/standalone/bootstrap.ts`, `src/services/TaskViewerProvider.ts`, `src/services/LocalApiServer.ts`, `src/services/workContextResolver.ts`, `src/standalone/ptyPromptDelivery.ts`, `src/test/host-auto-clear-on-plan-change.test.js`, `src/test/atomic-team-feature-run-context-lifecycle.test.js`, `package.json`, `.github/workflows/integration-tests.yml`. Five defects, in severity order: the standalone roster barrier called `clearPty()`, which returns ~70ms after writing `/clear` and never waits for readiness — so the barrier released while a Devin seat was still rebuilding and the first prompt then went out with `clearBeforePrompt:false`, i.e. with no detector at all, reproducing the original race on the team path (`clearPty` now takes `awaitReadiness`); `resolveTeamGroupForTerminal` matched any `terminals.groups` row instead of calling `isSpawnedTeamGroup`, so a hand-saved terminal *selection* containing the dispatched seat would `/clear` every other terminal in it; the non-team compare OR-ed `lastPlanId !== planId` back in beside the work-context compare, which clears a solo seat between two subtasks of one feature — exactly what this plan removes; `task/complete`'s "canonical dispatch event" fallback scanned `plan_events` for `role` + `terminal` rows that no writer produces (the only writers are this handler's own `completed` event and SessionActionLog's `workflow_event`), so it was dead code wearing the shape of evidence — replaced with a live-fleet role lookup that covers the real case where `attributePasteDispatch` moves `dispatched_terminal` without touching `routed_to`; and `isTeamMember` was resolved twice in `queue/done`, letting the relay text and the clear decision disagree. Also added the plan's missing team-key teardown on member close (both hosts) so a seat joining mid-run gets its clear. **Validation:** `compile-tests`, `compile`, `lint` (0 errors) clean; `atomic-team-lifecycle`, `task-complete`, `host-auto-clear`, `queue-done-relay`, `pty-route-surface`, `pty-prompt-delivery-framing`, `clear-readiness` all green, and the first three are newly invoked by CI (they had no npm script at all). **Remaining risks:** the standalone host still wires no `clearTerminalContext`, so lead acceptance clears nothing there — pre-existing, not introduced here, and it needs its own plan; and `_lastDispatchedPlanByTerminal` is now write-only in both hosts, kept only for its map-maintenance contract.

### Correction (post-review, operator direction)

The readiness barrier described above is withdrawn. Within a team the clear is
always separated from the next write by lead latency — the lead has to read a
diff and compose a prompt — so detecting CLI readiness on a roster clear or an
acceptance clear buys nothing and stalls the run behind the slowest seat.
Readiness detection is now confined to `sendPromptToPty`, the one path where a
prompt follows the clear with no gap; `clearPty` is fire-and-forget again, the
roster clear covers siblings only, and the destination clears itself through the
delivery path. The real defect this plan should have addressed is that the
lead's completion post was optional in practice: it was described in three
inconsistent places (the only complete example carried the FEATURE planId), and
both mechanisms that could have caught its absence — the feature nudge and the
team in-flight 409 — key on `kanbanColumn`, which is CONSTANT while a team works
a card and therefore carries no progress information. The post is now
unconditional in the lead's orders, rendered as an executable call in the
queue/done relay with the subtask's real planId, and the nudge keys on
`completed_at`; `stopColumns` is removed end to end.
