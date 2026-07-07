# Activity light clears on next plan-file edit — drop the column-echo guard

## Goal

Replace the agent-authored-text-based activity-light OFF-switch with an mtime-based one. Today the light only turns off when the agent appends `**Stage Complete:** <COLUMN>` AND the echoed column byte-matches the card's `kanbanColumn`. Agents paraphrase, miscase, or typo the column name (e.g. `Coded` vs `CODED`), the stale-marker guard blocks the clear, and the light stays on forever. The fix: **the next edit of the plan file after dispatch turns off the light**, regardless of what text the agent wrote (or didn't write). The file edit is the signal.

### Problem Analysis

**Symptom:** A dispatched card's activity light never turns off even though the agent finished and appended `**Stage Complete:** Coded` to the plan file (e.g. `feature_plan_20260703100715_project-panel-theme-live-update.md:228`).

**Root cause:** `GlobalPlanWatcherService.ts:844-862` gates the `clearWorkingState` call on a strict, case-sensitive string equality between the agent-echoed column text and the card's DB `kanbanColumn`:

```ts
if (echoed === '' || echoed === currentCol) {
    await db.clearWorkingState(...)
} else {
    // "stale marker, not clearing" → light stays on forever
}
```

The DB stores column IDs in UPPERCASE (`CREATED`, `PLAN REVIEWED`, `LEAD CODED`, `CODER CODED`, `CODE REVIEWED`, `ACCEPTANCE TESTED`, `COMPLETED` — see `kanban.html:3853-3860`). The dispatch directive (`agentPromptBuilder.ts:516-518`) falls back to the literal placeholder `<the column you were dispatched for>` whenever `destinationColumn` is empty, forcing the agent to **guess the exact spelling and casing**. Agents naturally write Title Case (`Coded`, `Reviewed`). `"Coded" !== "CODED"` → guard blocks → `dispatched_at` never nulled → light on forever. The agent has no feedback that its marker was rejected; the user's only signal is a light that never turns off.

> ### Re-Review Note (the quoted block above is the ORIGINAL pre-fix state — the current code has since been partially rewritten)
>
> The strict `echoed === currentCol` block quoted above was the state at original authoring. It has since been superseded by the **multi-marker tolerance plan** (`fix-stage-complete-multi-marker-regex.md`, shipped in commit `4cabd8e` "Fix stage complete parser and watcher to tolerate multiple accumulated markers"). The **actual current code** at `GlobalPlanWatcherService.ts:836-864` is:
>
> ```ts
> if (metadata.stageComplete !== undefined && metadata.stageComplete.length > 0) {
>     const currentCol = updatedRecord.kanbanColumn || '';
>     const hasBare = metadata.stageComplete.some(v => v.trim() === '');
>     const hasMatch = metadata.stageComplete.some(v => v.trim() === currentCol);
>     if (hasBare || hasMatch) {
>         // clearWorkingState(...)
>     } else {
>         // "stale markers, not clearing" → light stays on
>     }
> }
> ```
>
> **This partial fix does NOT close the bug this plan targets.** The multi-marker plan added `hasBare` (a bare `**Stage Complete:**` with NO column now clears unguarded) and tolerates accumulated markers via `.some()`. But `hasMatch` is **still strict `===`** (`v.trim() === currentCol`), so any **non-empty, non-matching** marker — the common case, since the dispatch directive (`agentPromptBuilder.ts:516-518`) explicitly tells the agent to write the column and agents write Title Case — still hits the `else` branch and the light stays on forever. `hasBare` only rescues agents who write the marker with no column at all, which the directive discourages. The root cause (trusting agent-authored text + strict case compare) is intact; this plan supersedes the partial fix by removing the trust entirely.
>
> **Line drift:** the block to replace is now **lines 836-864** (was 836-863 at original authoring). The Proposed Changes section below uses the current line range and quotes the current code.

**Why the design is fragile by construction:** The off-switch depends on an LLM reproducing a specific board-internal string byte-for-byte. The board already owns the column ID in the DB — asking the agent to echo it back is a lossy round-trip that penalizes the light when the round-trip is lossy. Three independent failure modes all produce the same silent failure: (1) agent doesn't know the exact ID (empty `destinationColumn` placeholder), (2) case mismatch (strict `===`), (3) typo/paraphrase. Patching the compare (case-insensitive) only fixes #2; #1 and #3 remain.

**The reliable signal:** The plan file is always the last thing the agent edits when it works (per user's domain knowledge of the workflow). The dispatch flow itself does NOT write the plan file — `updateDispatchInfo` / `updateDispatchInfoByPlanFile` (`KanbanDatabase.ts:7380-7394`) only run a SQL `UPDATE` on the `plans` table; they never touch the file on disk. So any mtime advance of the plan file after dispatch is, by construction, the agent's work — and the agent's final edit is the completion signal. The watcher already fires exactly once per mtime advance (self-advancing `updatedAt := fileMtime` gate). Therefore: **mtime advance + `dispatched_at` set → clear the light.** No text parsing required.

## Metadata

**Complexity:** 3
**Tags:** bugfix, backend, reliability

> **Re-Review scoring note:** bumped 2 → 3. The change is a routine 2-file delete that reuses `clearWorkingState`, but it is NOT trivial config/copy: it deletes the off-switch for **every dispatched card** and removes a directive **every agent receives**. One wrong line and every light on the board breaks. Scored Low (routine, localized) with an explicit reliability caveat. Route per the workflow table: 1-3 → Intern; the human may override to Coder given the reliability dimension.

## Complexity Audit

### Routine
- Two-file change: `GlobalPlanWatcherService.ts` (delete the marker-parse-and-guard block) and `agentPromptBuilder.ts` (delete `buildStageCompleteDirective` + its 2 call sites). No new files.
- Reuses the existing `db.clearWorkingState(relativePath, workspaceId)` helper (`KanbanDatabase.ts:7415`) — no new SQL, no new DB surface.
- The replacement logic is a strict subset of the current logic (one `if` on a field already present) — strictly less code, strictly fewer branches.
- Parser file (`planMetadataUtils.ts`) is intentionally untouched; the `STAGE_COMPLETE_LABEL` constant is retained so the existing import does not break.

### Complex / Risky
- Reliability-loaded off-switch: the cleared path gates the activity light for **every** dispatched card. A regression here breaks the light board-wide, and the failure is silent (the `if (updatedRecord.dispatchedAt)` branch simply never fires if the field is absent — no parse error, no log line beyond the missing clear).
- Directive removal changes the prompt sent to **all** agents (built-in roles via the shared prefix at `agentPromptBuilder.ts:934`, custom agents at `:1644`). Existing/historical plan files may still carry `**Stage Complete:**` markers; the parser keeps parsing them (display-only), so the surface is contained — but any future feature that expects the marker on new plans would need to re-introduce a directive.
- Accepted false-clear surface: non-agent edits (git checkout, importer re-sync, manual edit) advance mtime and now clear the light. This is the user's explicit design call (a false-off is less harmful than a stuck-on), mitigated by re-dispatch re-arming `dispatched_at` and the timeout sweep backstop.

## User Review Required

Yes — confirm the design call that the file edit (not agent-authored text) is the completion signal, and that the stale-marker guard is deleted rather than retained as log-only. Confirm the edge cases below are acceptable.

## Proposed Changes

### 1. `src/services/GlobalPlanWatcherService.ts` — Clear on mtime advance, drop the marker guard

**Context:** Lines **836-864** contain the activity-light OFF-switch. It parses `metadata.stageComplete`, runs the stale-marker column-equality guard, and only calls `clearWorkingState` when a marker either is bare (`hasBare`) or byte-matches the card's current column (`hasMatch`). The **actual current code** at 836-864 (rewritten by the multi-marker plan, commit `4cabd8e`) is:

```ts
if (metadata.stageComplete !== undefined && metadata.stageComplete.length > 0) {
    const currentCol = updatedRecord.kanbanColumn || '';
    const hasBare = metadata.stageComplete.some(v => v.trim() === '');
    const hasMatch = metadata.stageComplete.some(v => v.trim() === currentCol);
    if (hasBare || hasMatch) {
        try {
            await db.clearWorkingState(relativePath, workspaceId);
            this._outputChannel?.appendLine(
                `[GlobalPlanWatcher] Stage Complete marker cleared working state for: ${relativePath}`
            );
        } catch (clearErr) {
            this._outputChannel?.appendLine(
                `[GlobalPlanWatcher] clearWorkingState failed for ${relativePath}: ${clearErr}`
            );
        }
    } else {
        this._outputChannel?.appendLine(
            `[GlobalPlanWatcher] Stage Complete markers [${metadata.stageComplete.join(', ')}] none match current '${currentCol}' — stale markers, not clearing: ${relativePath}`
        );
    }
}
```

**Logic:** Replace the entire marker-parse-and-guard block with: if the card has `dispatched_at` set (i.e. it is in a working state), clear it. The watcher only fires on mtime advance — the gate at **`GlobalPlanWatcherService.ts:589`** early-`return`s when `new Date(fileMtime).getTime() <= new Date(plan.updatedAt).getTime()`, so reaching the marker block at all means the file's mtime advanced past the DB's `updated_at`. Since dispatch does not write the plan file (see `KanbanDatabase.ts:7391-7394`, pure SQL `UPDATE ... SET dispatched_at = ?, updated_at = ?`), the first mtime advance after dispatch is the agent's edit — the completion signal. (Note the ordering: dispatch sets DB `updated_at = now`; the agent's subsequent save has `fileMtime > dispatch_time`, so the gate passes. Correct by construction.)

**Implementation:** Replace lines **836-864** (the entire `if (metadata.stageComplete !== undefined ...)` block through its closing brace, immediately before `plan = updatedRecord;` at line 865) with:

```ts
// Activity-light OFF-switch: the next plan-file edit after dispatch turns off
// the light. The watcher only fires on mtime advance (the gate at line 589
// early-returns when fileMtime <= plan.updatedAt), and the dispatch flow does
// not write the plan file (updateDispatchInfoByPlanFile only runs SQL), so any
// mtime advance reaching here while dispatched_at is set is the agent's
// completion edit. No agent-authored text is trusted.
if (updatedRecord.dispatchedAt) {
    try {
        await db.clearWorkingState(relativePath, workspaceId);
        this._outputChannel?.appendLine(
            `[GlobalPlanWatcher] Plan file edit cleared working state for: ${relativePath}`
        );
    } catch (clearErr) {
        this._outputChannel?.appendLine(
            `[GlobalPlanWatcher] clearWorkingState failed for ${relativePath}: ${clearErr}`
        );
    }
}
```

**`updatedRecord.dispatchedAt` — VERIFIED AVAILABLE (re-review resolved the open question):**
- `plan` is fetched at `GlobalPlanWatcherService.ts:574` via `db.getPlanByPlanFile(relativePath, workspaceId)`.
- `getPlanByPlanFile`'s row mapper populates `dispatchedAt` from the `dispatched_at` column: `dispatchedAt: row.dispatched_at !== null && row.dispatched_at !== undefined ? String(row.dispatched_at) : null` (`KanbanDatabase.ts:7573`).
- `updatedRecord` is built at `GlobalPlanWatcherService.ts:766` as `{ ...plan, topic, complexity, tags, project, updatedAt: fileMtime }` — the `...plan` spread carries `dispatchedAt` onto `updatedRecord`.
- `insertFileDerivedPlan` (called at watcher:777) preserves `dispatched_at` on conflict (the upsert's ON CONFLICT clause does not touch `dispatched_at` — see the `record.dispatchedAt ?? null` bind at `KanbanDatabase.ts:6847` and the omitted-from-UPDATE preservation), so the pre-edit fetch value is accurate for the clear decision.
- Therefore `if (updatedRecord.dispatchedAt)` is sound: it is truthy exactly when the card is dispatched. **No fallback read or select change is required.** (The original plan flagged this as "the one verification point before coding" — re-review verified it; the open question is closed.)

### 2. `src/services/agentPromptBuilder.ts` — Remove the Stage Complete directive entirely

**Context:** `buildStageCompleteDirective` (lines 516-518) emits a `STAGE COMPLETE (MANDATORY)` directive telling the agent the marker is "the ONLY signal the board uses to turn off your card's activity light." With the mtime-based off-switch, this is now false — and per user direction, the agent should not be writing this marker at all.

**Logic:** Delete the `buildStageCompleteDirective` function and remove its call site(s) from the dispatch prompt assembly. The agent is no longer instructed to append any `**Stage Complete:**` line. The light clears automatically on the next plan-file save; the agent does not participate in the off-switch.

**Implementation:**
- Delete `buildStageCompleteDirective` (definition at `agentPromptBuilder.ts:515-518`).
- Remove its **exactly two** call sites (verified by re-review grep — there are no others):
  1. `agentPromptBuilder.ts:934` — `const stageCompleteBlock = buildStageCompleteDirective(options?.destinationColumn);` folded into `dispatchPrefixCore` (line 935) so it reaches **every built-in role** (planner, lead, coder, reviewer, tester, …). Remove the line and drop `stageCompleteBlock` from the `[dispatchContextBlock, worktreeBlock, remoteModeBlock, prdBlock, stageCompleteBlock]` array on line 935.
  2. `agentPromptBuilder.ts:1644` — `prompt += '\n\n' + buildStageCompleteDirective(addons?.destinationColumn);` appended to **custom-agent** prompts. Remove the line (and the now-stale `// Activity-light OFF-switch — custom agents get the same Stage Complete directive...` comment on lines 1642-1643 above it).
- Keep the `STAGE_COMPLETE_LABEL` constant (`agentPromptBuilder.ts:504`) — `planMetadataUtils.ts` still imports it for parsing existing/historical markers in plan files (used in the regex at `planMetadataUtils.ts:130`). Removing the constant would break the parser import; removing the directive does not require removing the constant.

### 3. `src/services/planMetadataUtils.ts` — Keep parser for historical markers (no change)

**Context:** `parsePlanMetadata` (lines 128-136) still parses `**Stage Complete:**` into `metadata.stageComplete`. With the watcher no longer consuming it for the clear decision and the directive removed, no new markers will be written, but old plan files may still contain them.

**Logic:** No change. The parser continues to populate `stageComplete` for any pre-existing markers so historical plan files still display correctly. The field is now display-only (no runtime consumer gates behavior on it). Future cleanup of the field can be a separate plan if desired.

## Edge-Case & Dependency Audit

- **Dispatch writing the plan file (false-clear risk):** Verified — `updateDispatchInfo` / `updateDispatchInfoByPlanFile` (`KanbanDatabase.ts:7380-7394`) only run SQL `UPDATE` on the `plans` table; they do not write the file on disk. Dispatch does not advance the plan file's mtime. Safe.
- **Non-agent edits clearing the light (git checkout, importer re-sync, manual edit):** These advance mtime and would clear the light. Acceptable per the user's design call — a false clear (light off when agent is nominally still working) is far less harmful than a false on (light stuck forever). If the card is re-dispatched, `dispatched_at` is reset and the light comes back on. The timeout sweep (`working-state-timeout-sweep.md`) is the complementary backstop.
- **Agent edits the file mid-work, then continues:** The user states plans are always the LAST thing edited when the agent works, so this does not occur in practice. If it ever did, the light would clear early — same acceptable-failure mode as above.
- **Re-dispatch after a false clear:** `updateDispatchInfo*` overwrites `dispatched_at` with a fresh timestamp (line 7393), re-arming the light. The next file edit clears it again. Self-healing.
- **Feature cards:** `dispatched_at` is written/cleared on the feature row itself for dispatch-identity (`KanbanDatabase.ts:7389-7390`), but the working flag is derived from subtasks' `dispatched_at` values (line 4687). The watcher clears per-plan-file; feature-level working derivation is unchanged. Verify the watcher handler runs per-subtask-file and the feature aggregate recomputes — this is existing behavior, not introduced by this change.
- **Timeout sweep interaction:** `clearStaleWorkingState` (`KanbanDatabase.ts:7424-7436`) nulls `dispatched_at` older than N minutes. This is the backstop for the case where the agent writes nothing and never edits the file. Unchanged by this plan; the two mechanisms are complementary (mtime clear = agent edited; timeout = agent went silent).
- **Race conditions:** None introduced. The watcher's mtime gate ensures one handler pass per mtime advance. `clearWorkingState` is idempotent (nulling an already-null column is a no-op). Re-dispatch overwrites `dispatched_at` atomically.
- **Security:** None. No new input source; the off-switch no longer trusts agent-authored text at all, which is a security improvement (removes a text-injection-adjacent surface).

## Dependencies

None — self-contained. **Clarification (re-review):** the related plan `fix-stage-complete-multi-marker-regex.md` has **already shipped** (commit `4cabd8e` "Fix stage complete parser and watcher to tolerate multiple accumulated markers"). It delivered a PARTIAL fix to the same bug class: it added `hasBare` (a bare `**Stage Complete:**` with no column now clears unguarded) and multi-marker tolerance via `.some()`. It did NOT fix the case-mismatch core (`hasMatch` is still strict `===`), so the common case — agent writes a non-empty, non-matching column per the directive — still leaves the light stuck. This plan **supersedes** the multi-marker plan for the activity-light purpose: once the column-echo guard is deleted, the marker text is irrelevant to the clear decision, so the multi-marker bug no longer affects the light. The multi-marker plan's residual value after this ships is limited to the display/log consumer of `stageComplete` (parser field, now display-only) — it does not need to be reverted.

## Adversarial Synthesis

**Key risks:** (1) Non-agent file edits (git checkout, importer) now clear the light — mitigated by the user's explicit design call that file-edit = done is reliable for the agent-work case, and by re-dispatch re-arming `dispatched_at`. (2) ~~The `updatedRecord.dispatchedAt` field availability is assumed but not yet verified~~ — **RESOLVED by re-review**: the field IS available (`getPlanByPlanFile` row mapper `KanbanDatabase.ts:7573` populates it; `updatedRecord = {...plan}` at watcher:766 spreads it; `insertFileDerivedPlan` preserves `dispatched_at` on conflict). No pre-code check remains. (3) Removing the directive means new plan files will no longer carry `**Stage Complete:**` markers; the `stageComplete` parser field will only be populated for pre-existing plan files. This is acceptable — the field is display-only after this change — but any future feature that expects the marker on new plans would need to re-introduce a directive.

**Why not just case-insensitive compare:** That patches one failure mode (#2 of three). The agent still doesn't know the exact column ID when `destinationColumn` is empty (#1), and typos/paraphrase still fail (#3). The mtime approach eliminates all three by not trusting agent text at all. The column-echo guard is the thing creating the bug class; deleting it is the fix.

## Verification Plan

> Per session directives: SKIP compilation (`npm run compile`) and SKIP automated tests. Verification is manual only.

1. **The core bug (case mismatch):** Dispatch a card to a coded column. Let the agent finish and append `**Stage Complete:** Coded` (wrong casing, as an existing agent habit). Save the file.
   - **Expected:** Activity light turns off immediately on save. (Today: stays on forever.)
2. **No marker at all (the new norm):** Dispatch a card. Let the agent finish and edit the plan file WITHOUT appending any `**Stage Complete:**` line (the directive is gone, so agents won't write it).
   - **Expected:** Light turns off on save. (Today: stays on — no marker parsed.)
3. **Re-dispatch re-arms:** After a clear, re-dispatch the same card. Confirm `dispatched_at` is set and the light is on. Edit the file → light off.
4. **Non-agent edit (git checkout):** With a card dispatched, `git checkout` overwrites the plan file. Confirm the light clears (acceptable per design) and that re-dispatch re-arms it.
5. **Timeout sweep still works:** Dispatch a card and do NOT edit the file. Confirm the timeout sweep (`clearStaleWorkingState`) eventually clears the light (unchanged behavior).
6. **Directive is gone:** Inspect the dispatch prompt sent to a freshly-dispatched agent. Confirm there is no `STAGE COMPLETE (MANDATORY)` text and no instruction to append `**Stage Complete:**`.
7. **Old block fully removed (re-review addition):** Grep the watcher for `metadata.stageComplete` and `hasMatch` — confirm neither appears (the entire `if (metadata.stageComplete !== undefined ...)` block at the former lines 836-864 is gone, replaced by the single `if (updatedRecord.dispatchedAt)` block). Also confirm `db.clearWorkingState(relativePath, workspaceId)` is still called exactly once in the handler (inside the new block), and `stageCompleteBlock` no longer appears in `agentPromptBuilder.ts` (both call sites 934 and 1644 removed).

## Recommendation

Complexity 3 → **Send to Intern**. Two-file change (watcher + prompt builder); parser untouched; no new SQL or DB surface. Delete the column-echo guard; the file edit is the off-switch. Remove the `STAGE COMPLETE` directive entirely (both call sites: `agentPromptBuilder.ts:934` and `:1644`) — the agent does not write the marker. **Reliability caveat for the human:** this deletes the off-switch for every dispatched card and the directive every agent receives — a single-line regression (e.g. `updatedRecord.dispatchedAt` mistyped, or the block placed above the mtime gate) breaks every light board-wide silently. If that risk profile is preferred at the Coder tier, override to **Send to Coder**; the work itself is Intern-scope.

**Stage Complete:** PLAN REVIEWED

**Stage Complete:** LEAD CODED

