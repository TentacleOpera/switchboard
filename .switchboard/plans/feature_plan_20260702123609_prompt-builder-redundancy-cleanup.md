# Prompt Builder Redundancy Cleanup — Lean Dispatch Prompts

**Plan ID:** 693A425D-7362-4346-B931-357E9FBF5333

## Goal

Strip the redundant, contradictory, and host-specific boilerplate out of every prompt produced by `buildKanbanBatchPrompt` / `buildCustomAgentPrompt` (the pipeline behind the kanban Prompts tab, Copy Prompt buttons, autoban, and CLI dispatch), so a dispatched prompt contains each instruction exactly once and only instructions relevant to the dispatched role.

### Problem analysis / root cause

An audit of the full prompt pipeline (`agentPromptBuilder.ts`, options assembly in `KanbanProvider.generateUnifiedPrompt`, plans array from `_cardsToPromptPlans` / `expandEpicSubtaskPlans`) found that roughly half of a typical dispatch prompt is removable. Root causes:

1. **Double labelling.** `expandEpicSubtaskPlans` (KanbanProvider.ts:2854) bakes `[SUBTASK] ` into `topic`, and two renderers prepend their own `[SUBTASK]` label → `[SUBTASK] [SUBTASK] <topic>` in real prompts: `buildPromptDispatchContext` (agentPromptBuilder.ts:329) and `EPIC_ORCHESTRATION_DIRECTIVE_PER_SUBTASK` (:444). (A third site at :490 uses a `[complexity]` label, not `[SUBTASK]` — it still surfaces the stamped prefix inside `${sp.topic}`, but the double-labelling bug is the two explicit `[SUBTASK]` prepends.)
2. **Copy-pasted role branches drift.** The "safety session" worktree loop exists 4× (reviewer :880, lead :1000, coder :1051, intern :1098); the suffix-block assembly is repeated in all nine role branches with inconsistencies; `batchExecutionRules` is duplicated inline in `buildCustomAgentPrompt` (:1359) alongside an inline PRD block (:1412-1422); a hardcoded copy of FOCUS lives in the testing-failure prompt (KanbanProvider.ts:7368).
3. **Blocks are injected unconditionally instead of contextually.** Batch rules go into single-plan prompts for every role except planner; epic mode gets both "treat each plan as completely isolated" and "all subtasks are a single delivery unit" (direct contradiction); GIT POLICY goes to roles that never touch code (ticket_updater, researcher, chat); the worktree path is stated twice (WORKING DIRECTORY block + safety-session block name the same path, because `resolveWorkingDirForWorktree` sets `workingDir = worktreePath`).
4. **Verbose directives restate themselves.** AUTHORIZATION TO EXECUTE says one thing four ways; GIT POLICY says "don't discard work" three ways; the reviewer prompt restates its framing three times (intro, Mode block, base instructions); the epic intro counts the epic doc as a plan ("execute the following 5 plans" vs "4 subtask(s)"); single-card dispatches read "1 plans".

**User decision (2026-07-02):** the safety-session block is not needed at all. The agent only needs to know it is working in a worktree — an isolated sibling checkout of the main repo. No "will corrupt the main branch" warnings, no navigate-first ritual.

**Merged (2026-07-02):** this plan incorporates and supersedes `slim-epic-coder-dispatch-prompt.md` (a targeted investigation of the epic-mode coder dispatch). Its unique contributions are rolled in as §10 (epic-file-only coder dispatch), §11 (dispatch-boundary diagnostic logging for observed runtime string mangling — "subageentially" for "sequentially", truncated "remotroject" path, neither reproducible from source), and the stale-epic-file safety net in Edge Cases. Two conflicts resolved in favor of this plan: (a) its proposed worktree block kept the "will corrupt it" warning — overridden by the user decision above (one line, no corruption warnings); (b) its `[SUBTASK]` fix is identical to §2 here — implemented once.

## Metadata

**Complexity:** 7
**Tags:** refactor, backend, bugfix

## User Review Required

None.

## Complexity Audit

### Routine
- Dropping the `[SUBTASK]` prefix stamp at KanbanProvider.ts:2854 (single line).
- Tightening verbose directive constants (AUTHORIZATION, FOCUS, GIT POLICY, SKIP_COMPILATION, SKIP_TESTS) — same meaning, fewer words.
- Fixing pluralisation ("1 plans" → "1 plan") and epic intro counting.
- Gating `batchExecutionRules` on `plans.length > 1` for all roles.
- Replacing the hardcoded FOCUS copy in the testing-failure prompt (KanbanProvider.ts:7368) with the constant.
- Updating the four string-pinning test files to new expectations.

### Complex / Risky
- Killing the four safety-session worktree loops (agentPromptBuilder.ts:880, :1000, :1051, :1098) and replacing with one shared `worktreeBlock` emitted via `dispatchPrefixCore` — touches every role branch.
- §3 epic-mode contradiction fix: suppressing `batchExecutionRules` + `subagentBlock` + `WORKTREES_PER_PLAN_DIRECTIVE` when `epicMode` is true, and relocating the epic directive + `epicPromptTemplate` out from under the `PLANS TO PROCESS:` heading (agentPromptBuilder.ts:727-730).
- §6 `assembleSuffix(role, parts)` helper extraction across all nine role branches — new shared helper, signature must be specified to prevent per-branch drift (the exact disease this plan cures).
- §10 epic-mode coder dispatch: replacing per-subtask enumeration with a single epic-file reference. **Depends on `_regenerateEpicFile` (KanbanProvider.ts:9117) having run pre-dispatch** — a stale SUBTASKS block means the coder reads a wrong plan list. The pre-dispatch regenerate call is a REQUIRED step, not an edge case.
- §11 diagnostic logging in `terminalUtils.ts` (`pasteTextViaClipboard` :51-92, `sendRobustText` :118-183, 500-char chunking :125, newline flattening :153) — diagnostic only, no behaviour change. Optional; can be deferred without affecting the core refactor.

## Current State

- `src/services/agentPromptBuilder.ts` — all directive constants and the nine role branches of `buildKanbanBatchPrompt`, plus `buildCustomAgentPrompt`.
- `src/services/KanbanProvider.ts` — `generateUnifiedPrompt` (options assembly), `_cardsToPromptPlans`, `expandEpicSubtaskPlans` (:2854, the only `[SUBTASK]` stamp site — verified no other file stamps it), testing-failure prompt with inline FOCUS copy (:7368).
- `src/services/terminalUtils.ts` — `pasteTextViaClipboard` (:51-92) and `sendRobustText` (:118-183), the dispatch boundary where runtime mangling is suspected (§11).
- Tests pinning exact prompt strings: `src/test/minimal-prompt.test.js`, `src/test/agent-prompt-builder-subagents.test.js`, `src/test/autoban-reviewer-prompt-regression.test.js`, `src/services/__tests__/agentPromptBuilder.test.ts`.
- Prompt text is generated at dispatch time, not persisted → **no data migration needed**. `defaultPromptOverrides` (prepend/append/replace) semantics are unchanged.
- `slim-epic-coder-dispatch-prompt.md` was already merged into this plan and removed from `.switchboard/plans/` — no standalone card to clean up. (Verified absent.)

## Dependencies

- None blocking. This plan must land BEFORE the sibling `feature_plan_20260702063927_write-epic-description-if-empty-addon.md` (Write Epic Description Add-on), which adds a directive into the planner branch this plan restructures. Reverse order risks merge conflicts.

## Adversarial Synthesis

Key risks: (1) line-number drift in the original plan would have misdirected edits — corrected against verified source. (2) the "three `[SUBTASK]` prepend sites" claim was overstated — only two explicit prepends exist (:329, :444); the third (:490) uses a complexity label but still surfaces the stamped prefix, so the single-stamp fix at :2854 remains correct. (3) §10 epic-mode coder dispatch bets on a fresh epic file — the pre-dispatch `_regenerateEpicFile` call is promoted from edge case to REQUIRED step; without it a stale SUBTASKS block produces silent wrong-plan execution. (4) `assembleSuffix` helper needs an explicit signature or per-branch drift recurs — specified. (5) §11 diagnostic logging is optional scope creep — marked deferrable. No data-migration risks (prompts are generated at dispatch time, not persisted).

## Proposed Changes

### 1. Kill the safety-session blocks; one worktree line in the shared prefix

- Delete all four `safetySessionBlock` loops (reviewer/lead/coder/intern branches).
- In `buildKanbanBatchPrompt`, before the role branches, dedupe `plans[].worktreePath` and build a shared `worktreeBlock`, emitted via `dispatchPrefixCore` (same channel as the remote-mode and PRD blocks so every role gets it identically):
  - One distinct worktree: `WORKTREE: You are working in a git worktree at <path> — an isolated sibling checkout of the main repository. Do all work inside it; the plan file paths below already point inside it.`
  - Multiple distinct worktrees (e.g. two epics batched together): one such line per path. Per-subtask and high-low epic modes already list per-subtask/tier worktrees in their own directives — when `epicMode` is true and the epic directive variant lists worktrees, emit no generic worktree lines.
- Suppress the `WORKING DIRECTORY:` dispatch-context block when its directory equals an emitted worktree path (it is the same path stated twice today). The multi-repo per-plan directory listing is unaffected.

### 2. Stop stamping `[SUBTASK]` into topics

- `KanbanProvider.ts:2854`: `topic: st.topic` (drop the prefix). Renderers already derive the label from `isSubtask`. Grep consumers of `BatchPromptPlan.topic` during implementation to confirm only prompt renderers read it (dispatch toasts use card data, not these entries). Note: only two renderers (agentPromptBuilder.ts:329, :444) explicitly prepend `[SUBTASK]`; the high-low list at :490 uses a `[complexity]` label but still surfaces the stamped prefix inside `${sp.topic}` — dropping the stamp fixes all three.

### 3. Fix the epic-mode contradictions

- When `options.epicMode` is true: suppress `batchExecutionRules` entirely (the epic directive owns grouping/sequencing and says the opposite), and suppress `subagentBlock` + `WORKTREES_PER_PLAN_DIRECTIVE` (the epic directive owns orchestration; today the per-subtask variant's "do NOT create your own worktrees" can directly contradict the worktrees-per-plan toggle).
- Move the epic directive + `epicPromptTemplate` out of `planList` (today they render *under* the `PLANS TO PROCESS:` heading — agentPromptBuilder.ts:727-730) into their own prompt part placed immediately before the heading.
- Epic-mode intro for lead/coder: `Please execute the epic described below.` — stop counting the epic doc as a plan.

### 4. Gate batch rules on actual batches

- All roles gate `batchExecutionRules` on `plans.length > 1` (today only planner does). Single-card dispatches lose the "do not mix requirements between plans" noise.

### 5. Tighten the always-on directives (same meaning, fewer words)

- `AUTHORIZATION TO EXECUTE` → one sentence: `AUTHORIZATION: These plans are pre-approved — begin implementation immediately; do not produce a separate planning document first.` Remove it from the **tester** branch entirely (its intro already frames the task, and "implementing the changes" is wrong for an acceptance reviewer).
- `FOCUS_DIRECTIVE` → one sentence: `FOCUS: Each plan file path below is the single source of truth for that plan; ignore any mirrored or 'brain'-directory copies of it.` Replace the hardcoded copy in the testing-failure prompt (KanbanProvider.ts:7368) with the constant.
- `GIT_PROHIBITION_DIRECTIVE` → keep the full prohibition list, cut the three restatements of the rationale (~120 → ~60 words): `GIT POLICY: You may create worktrees and branches, stage, and commit your own work. You MUST NOT run work-discarding commands: git reset, git checkout <path> / git restore, git clean, git stash drop/clear, force pushes, or branch/worktree deletion. Never fix a mistake by discarding — commit first, then correct forward. Do not push or merge to shared branches.`
- `SKIP_COMPILATION_DIRECTIVE` / `SKIP_TESTS_DIRECTIVE` → one sentence each.
- Non-epic intros: `Please execute the plan below.` (1 plan) / `Please execute the ${n} plans below.` — fixes "1 plans".

### 6. Role-scope the suffix

- `gitBlock` only for code-touching roles: lead, coder, intern, reviewer, tester (planner already defaults off). ticket_updater, researcher, analyst, chat no longer receive it.
- Extract one `assembleSuffix(role, parts)` helper used by all nine branches so inclusion rules live in one place and can't drift per-branch. **Signature:** `function assembleSuffix(role: Role, parts: { gitBlock?: string; skipCompilation?: string; skipTests?: string; subagentBlock?: string; batchExecutionRules?: string; prdBlock?: string }): string` — returns the concatenated non-empty parts in canonical order, with `gitBlock` included only for code-touching roles. Lives near the top of `agentPromptBuilder.ts` after the directive constants.

### 7. Deduplicate the reviewer framing

- Merge `buildReviewerExecutionIntro` + `buildReviewerExecutionModeLine` into a single short block: intro sentence + `Do not start any auxiliary workflow — assess the code changes against the plan requirements inline, fix valid material issues, then verify.` The numbered base instructions stay.
- The concise-mode/compact-mode `.replace()` calls are string-coupled to `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` (warning comment at :848) — update them in tandem with any wording change and assert in tests that the replacements still fire (replaced text must differ from input).

### 8. Code-level dedup in `buildCustomAgentPrompt` / `generateUnifiedPrompt`

- `buildCustomAgentPrompt` uses the shared `batchExecutionRules` constant and `buildPrdReferenceBlock` instead of its inline copies (:1359, :1412-1422).
- Extract the duplicated PRD-resolution loop in `generateUnifiedPrompt` (:3242 custom branch, :3309 built-in branch) into one private helper.

### 9. Update the string-pinning tests

- `minimal-prompt.test.js`, `agent-prompt-builder-subagents.test.js`, `autoban-reviewer-prompt-regression.test.js`, `__tests__/agentPromptBuilder.test.ts` — update expectations to the new strings. Add regression assertions: no `[SUBTASK] [SUBTASK]` in any epic prompt; no `batchExecutionRules` in single-plan or epic-mode prompts; exactly one occurrence of the worktree path in a worktree dispatch; epic-mode coder prompt contains the epic file path and no per-subtask lines (§10).

### 10. Epic-mode **coder** dispatch: single epic-file reference instead of per-subtask enumeration *(merged from slim-epic-coder-dispatch-prompt.md)*

- **Scope: coder role epic dispatches only** (per the scope decision recorded in the merged plan). Lead/intern/planner epic dispatches keep the enumeration, leaner via §3. Non-epic coder dispatch keeps per-plan enumeration.
- The epic file's auto-generated `<!-- BEGIN SUBTASKS -->` block (`_regenerateEpicFile`, KanbanProvider.ts:9140) already lists every subtask plan link, and its `<!-- BEGIN WORKTREES -->` block (:9178) already lists per-subtask/per-tier worktree assignments — the prompt's per-subtask enumeration is pure duplication. Replace the coder's epic-mode `PLANS TO PROCESS` block with:

  ```
  EPIC FILE:
  <worktree-resolved absolute path to the epic .md>

  Read the epic file above. Its Subtasks section lists all subtask plan files (relative paths resolve inside this worktree). Its Worktrees section lists any per-subtask or per-tier worktree assignments. Execute each subtask plan in full.
  ```

- For this path, replace all three orchestration directive variants + AUTHORIZATION + batch rules with one consolidated block (they restate the same "execute now, as one unit" message): `EXECUTION MODE: The epic below is pre-approved — begin implementation immediately; do not produce a separate planning document. Execute each subtask plan in full before moving to the next; if a subtask hits an issue, report it clearly and continue with the remaining subtasks when safe. All subtasks are one delivery unit.` The three directive variants remain for other roles' epic dispatches.
- Drop FOCUS for this path — there is only one file path, no ambiguity to resolve.
- **Why safe:** the worktree's epic file was committed at branch time, so its relative `../plans/<basename>` links can only reference plan files committed at that same commit — self-consistent by construction. Keep the relative links; no worktree-specific rewriting (decision carried over from the merged plan).
- **REQUIRED pre-dispatch step (not optional):** call `_regenerateEpicFile` on the epic immediately before assembling the coder's epic-mode prompt. This guarantees the SUBTASKS/WORKTREES blocks reflect the current subtask set. Without this, a stale block would make the coder read and execute a wrong plan list — a silent data-integrity bug. The call is cheap and idempotent.

### 11. Diagnostic logging at the terminal dispatch boundary *(merged from slim-epic-coder-dispatch-prompt.md)*

- Observed in a real dispatched prompt: "subageentially" where source says "sequentially" (agentPromptBuilder.ts:428) and a truncated path "remotroject" — neither reproducible from source. Suspects: clipboard paste-buffer limits in `pasteTextViaClipboard`, chunk-boundary interleaving in the 500-char `sendRobustText` fallback, or the CLI newline flattening (`text.replace(/[\r\n]+/g, ' ')`) shifting chunk boundaries.
- `src/services/terminalUtils.ts`: log length + simple hash + first/last 50 chars (a) at prompt assembly hand-off, (b) after `clipboard.writeText` via read-back compare, (c) per chunk in the `sendRobustText` fallback. Diagnostic only — no behavior change. Next occurrence pinpoints the mangling stage.

## Non-Goals

- Consolidating the 5 dispatch-plans-array builders (separate plan, 2026-06-30).
- The preview card-filter switch duplication (KanbanProvider.ts:~2981 / ~7540) — no prompt-text impact.
- Changing `defaultPromptOverrides`, custom-agent addon semantics, or the epic ultracode//goal prefixes.
- Removing CAVEMAN / SUPPRESS WALKTHROUGH / remote-mode directives (opt-in, working as designed).

## Edge-Case & Dependency Audit

**Race Conditions:** Prompt assembly is single-threaded at dispatch time. The §10 pre-dispatch `_regenerateEpicFile` call writes the epic file; no concurrent writer path exists during dispatch. The diagnostic logging in §11 is read-only (length/hash/char-compare) — no mutation race.

**Security:** No user input flows into directive constants. The worktree path in the shared `worktreeBlock` is derived from `resolveWorkingDirForWorktree` (returns `worktreePath`, terminalUtils.ts:109) — already trusted. No new attack surface.

**Side Effects:** Prompt text changes are dispatch-time only; no persisted state altered. The §11 logging writes to the output channel — additive, no behaviour change. Test string expectations change (§9) — expected, not a side effect.

**Dependencies & Conflicts:** Edits `agentPromptBuilder.ts` (all nine role branches + directive constants + new helper) and `KanbanProvider.ts` (`expandEpicSubtaskPlans`, `_resolvePromptBuilderOptions`, testing-failure prompt, §10 pre-dispatch regenerate). The sibling Write Epic Description plan edits the same two files additively — sequence this plan first. The four string-pinning test files must be updated in the same PR or they will fail.

- **Worktree exists but plan file fell back to workspace-root path** (`resolvePlanPathForWorktree` fallback): the worktree line says paths "already point inside it" — keep the existing console.warn fallback; the line stays accurate for the common case and the plan path itself is absolute either way.
- **Mixed batch: some plans with worktrees, some without** — emit the worktree line(s) for the paths present; plans without worktrees are governed by WORKING DIRECTORY / per-plan directories as today.
- **Epic mode with `switchboardSafeguardsEnabled` off** — already no batch rules; change is a no-op.
- **Reviewer concise/compact `.replace()`** — covered by test assertion in step 7; the warning comment at agentPromptBuilder.ts:848-850 flags the string coupling to `DEFAULT_REVIEWER_BASE_INSTRUCTIONS`.
- **`plans.length === 0` (chat preamble path)** — FOCUS references "plan file paths below"; keep chat's existing behavior but only emit FOCUS when `plans.length > 0`.
- **Stale epic SUBTASKS block (§10)** — handled by the REQUIRED pre-dispatch `_regenerateEpicFile` call above; no longer a residual edge case.
- **Epic dispatched with no worktree (§10)** — the epic file path resolves at workspace root (live-regenerated); same prompt shape, drop the "inside this worktree" clause when no worktree is active.
- **`BatchPromptPlan.topic` consumers (§2)** — grep during implementation to confirm only prompt renderers read subtask topics; `isSubtask` is the canonical signal, the prefix was cosmetic.

## Verification Plan

1. Unit tests above pass (`npm test` targets the four files; user runs the suite separately per session policy when dispatched with SKIP TESTS).
2. Snapshot-style manual check from the Prompts tab preview for: single card (lead), multi-card batch (coder), epic with subtasks (lead, per-subtask worktree mode), **epic coder dispatch (§10 shape: epic file path, no per-subtask lines, SUBTASKS/WORKTREES blocks present in the referenced file)**, reviewer single card, tester, ticket_updater. Confirm: no doubled `[SUBTASK]`, no batch rules on single/epic dispatches, one worktree mention max, no GIT POLICY on ticket_updater, correct plural in intro.
3. Grep the repo for `safety session` — zero hits in `src/` after the change.
4. Trigger a dispatch and confirm the §11 diagnostic logs (length/hash at assembly, clipboard read-back, chunk boundaries) appear in the output channel with no behavior change.

## Recommendation

**Complexity: 7 → Send to Lead Coder.** Structural refactor across nine role branches with a required pre-dispatch safety step (§10). Must land before the sibling Write Epic Description add-on plan.
