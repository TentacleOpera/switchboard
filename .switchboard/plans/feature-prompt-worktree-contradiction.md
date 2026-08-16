# Feature Prompt — Fix the Worktree Self-Contradiction, Retire Inert `featureWorktreeMode`

## Goal

Stop the feature-dispatch prompt telling a coder two opposite things about git worktrees in the same message, and remove the plumbing that made the contradiction invisible: `featureWorktreeMode`, which is threaded all the way into the prompt builder and has no effect on the prompt.

> **Line references.** Every `file:line` in this plan was re-resolved against HEAD on 2026-08-16. The original draft's `KanbanProvider.ts` references were drifted by 60–115 lines; they are corrected inline below. `agentPromptBuilder.ts` references were accurate.

### Problem analysis and root cause

**On default settings, a feature dispatch contains two contradictory statements about worktrees.**

With `useWorktreesPerPlan` off (the default) and the git safety guardrail on (the default), the coder receives:

> **FEATURE MODE:** … `Do NOT create git worktrees for this dispatch.`

> **GIT POLICY:** … `You may remove git worktrees you created with `git worktree remove` to clean up after merging…`

The two blocks are selected by different conditions:

- The git block flips to its worktree variant on `useWorktreesPerPlanEnabled || options?.featureMode === true` (`agentPromptBuilder.ts:1370`, and the sibling branches listed under "Ten sibling git-block call sites" below). `featureMode` alone is enough.
- The feature directive's worktree clause reads **only** `useWorktreesPerPlanEnabled`, passed into `buildFeatureSubagentClause` at `:1281`, which emits either "Use a dedicated git worktree for each subtask" or "Do NOT create git worktrees for this dispatch."

So in feature mode the git block assumes the agent provisions worktrees while the feature directive forbids it. Both sentences land in the same prompt.

**The material harm is the guardrail swap, not the awkward reading.** The two sentences are only *cosmetically* contradictory — "do not create any" and "you may remove ones you created" are jointly satisfiable by doing nothing. What is not cosmetic is *which guardrail string shipped*. `buildGitPolicyBlock` (`:638-640`) chooses between two constants:

- `GIT_SAFETY_DIRECTIVE` (`:558`) — bans "branch/**worktree** deletion" outright.
- `GIT_SAFETY_DIRECTIVE_WORKTREE_MODE` (`:568`) — bans branch deletion but **explicitly permits `git worktree remove`**.

The `|| featureMode` disjunct means every feature dispatch, on default settings, silently downgrades from the first to the second. The narrowed guardrail's own header comment states the precondition for that permission: *"The standard guardrail above forbids worktree deletion because agents don't own the lifecycle in the pre-assigned-worktree path; here they do."* In feature mode the agent **never** owns the lifecycle — under `feature_worktree_mode = 'none'` no worktree exists, and under `'per-feature'` the host provisions it (`_ensureFeatureIntegrationWorktree`, `KanbanProvider.ts:12547-12579`) and the host removes it (`_removeWorktreeRow`, `:12589-12607`). The disjunct grants worktree-removal permission on precisely the path where the agent is standing inside a worktree it did not create and does not own.

**Root cause: `featureMode` should never have been in that disjunct.** It reads as an assumption that feature mode implies agent-self-provisioned worktrees. That was true only under the per-subtask / high-low feature-worktree modes, which were removed. What remains — `'none'` and `'per-feature'` — are the two cases where the agent provisions nothing.

**`featureWorktreeMode` is fully plumbed and inert in the prompt.** It is read from the DB (`KanbanProvider.ts:5155`), stamped into `batchOptions` (`:5179`), and passed as the **first parameter** of `resolveFeatureOrchestrationDirective` (`agentPromptBuilder.ts:1277-1278`). Inside that function, `mode` is used for exactly one thing — a `console.warn` on unrecognised values (`:970-972`). Both valid values, `'none'` and `'per-feature'`, produce byte-identical output.

That is why the contradiction went unnoticed: the setting whose *name* says it governs the worktree clause does not touch it, so the clause reads from an unrelated per-role add-on instead.

**And the mode is not merely decorative elsewhere — it is actively set.** Orchestration mode writes `feature_worktree_mode = 'per-feature'` (`KanbanProvider.ts:8465`) and dispatches into a real per-feature worktree, restoring the prior value on exit (`:2248-2257`, `:8473`). So the system creates a worktree, dispatches the coder into it, and hands it a prompt saying "Do NOT create git worktrees for this dispatch." The setting is live for worktree *creation* and dead for the prompt — this plan removes the dead half only.

**Two smaller dead pieces in the same function.** `FeatureOrchestrationDirectiveContext` is an empty interface (`:914-915`) retained "for caller compatibility"; its parameter is `_context` (underscore-prefixed as unused) and the sole call site passes `undefined`. And `featurePromptTemplate` is still read (`KanbanProvider.ts:5154`) and prepended to the directive (`agentPromptBuilder.ts:1289-1291`), but the on-board feature-manage modal that wrote it was removed and `updateFeatureConfig` explicitly no longer writes it (`KanbanProvider.ts:12287-12294`) — so only a value left over from an old install can ever surface.

**Blast radius.** Prompt text only. No dispatch, worktree-creation or board behaviour changes. `feature_worktree_mode` keeps its real job in orchestration; only its unused prompt-builder parameter goes.

## Metadata

- **Complexity:** 4
- **Tags:** bugfix, refactor, reliability

> **Superseded:** `**Complexity:** 3` / `**Tags:** prompts, features, worktrees, bug`
> **Reason:** Two problems. (a) None of the four tags is in the allowed vocabulary — the parser drops unknown tags, so the plan was effectively untagged. (b) The call-site count is ten, not five, and the change alters shipped prompt text on the **default** feature path for every role. A 3 routes to Intern; a ten-site edit to the file that feeds every dispatch is not intern work.
> **Replaced with:** Complexity 4 (still the Coder band), tags drawn from the allowed list.

## User Review Required

None. The correct behaviour is unambiguous: the prompt must describe the worktree arrangement the dispatch actually set up, and worktree-removal permission must be granted only to an agent that was told to create worktrees.

## Complexity Audit

### Routine

- Deleting an unused parameter and an empty interface.
- Deleting a `console.warn` whose subject is no longer passed.
- Deleting one identical disjunct from ten identical call sites.

### Complex / Risky

- **Ten sibling git-block call sites, not five.** The expression `worktreePerPlanActive: useWorktreesPerPlanEnabled || options?.featureMode === true` is duplicated verbatim at `agentPromptBuilder.ts:1370, 1502, 1559, 1618, 1671, 1724, 1766, 1800, 1862, 1913`. Verified by exact-string count at HEAD: 10 occurrences. Fixing one and missing nine leaves the contradiction alive on the other role paths.

  > **Superseded:** "**Five sibling git-block call sites.** The worktree-variant condition is duplicated across `:1370`, `:1502`, `:1559`, `:1618`, `:1671`."
  > **Reason:** Miscounted — the draft listed the first five occurrences and stopped. `grep -c` for the exact expression returns 10. The plan's own headline risk is "fix one and miss the rest"; shipping it with half the sites unlisted would have caused exactly that.
  > **Replaced with:** The ten-site list above. After the fix the expression collapses to the bare local `useWorktreesPerPlanEnabled`, so there is nothing left to drift.

- **`buildFeatureSubagentClause` has three call sites, not one.** `:987` (inside `resolveFeatureOrchestrationDirective`, reached from `:1277`), `:1677` (the **feature-coder** path, which does *not* consume `featureDirectiveBlock` — see the comment at `:1668-1669`, "no feature directive (replaced by featureExecutionBlock)" — and therefore emits the worktree clause independently), and `:2030` (`buildCustomAgentPrompt`). All three already read `useWorktreesPerPlan`, so none needs a behaviour change — but any edit to the clause's *text* must be made once in the helper, not at a call site.

- **The custom-agent path is already correct and is the shape to copy.** `buildCustomAgentPrompt` passes `worktreePerPlanActive: addons?.useWorktreesPerPlan === true` (`:2080`) and gates its subagent clause on the same flag (`:2033`). No `featureMode` disjunct, no contradiction. It is the one path that already satisfies this plan's goal; the built-in role paths should converge on it rather than on a new mechanism.

- **"Worktree already provided" is already expressed in the prompt.** `worktreeActive` is derived at `:1223` from the deduped per-plan `worktreePath` set, and `:1249-1253` already emits `WORKTREE: You are working in a git worktree at <path> — an isolated sibling checkout of the main repository. Do all work inside it; the plan file paths below already point inside it.` on every role path (it rides `dispatchPrefixCore` → `dispatchContextPrefix` → `assembleSuffix`). In `feature_worktree_mode = 'per-feature'`, `_buildActiveWorktreePathMap` (`KanbanProvider.ts:4289-4315`) maps `feature_id` → path and `buildDispatchPlans` (`:4156-4192`) stamps it onto each dispatched plan, so `worktreeActive` is true and that block does fire.

  > **Superseded:** "**'Worktree already provided' is the missing state.** … the feature directive just never reads it. That is the natural source for the third state." — and the Complex/Risky claim that "the prompt currently cannot express the first [state]".
  > **Reason:** Factually wrong. The state is already expressed, with the concrete path, by the `WORKTREE:` block that ships today on every role branch. Adding a third directive variant would state the same fact a second time in weaker terms (no path), and would introduce a new tri-state to keep in sync across three consumers to achieve nothing the prompt does not already say.
  > **Replaced with:** No third state. `worktreeActive` keeps its existing two jobs in `buildGitPolicyBlock` (suppress the Branch clause `:618`, anchor the Commit clause `:625`) and the `WORKTREE:` block keeps its job of naming the provided worktree. The fix is confined to the guardrail-variant selector.

- **`featurePromptTemplate` must stay readable.** Per the repo's migration rule, a legacy key that shipped is still read as a fallback even once nothing writes it. Removing the read path would silently drop text an old install still relies on. Leave it; it is not the bug.

## Edge-Case & Dependency Audit

**Race Conditions** — none. Pure prompt construction.

**Security** — none in the network sense. There *is* a blast-radius reduction: the default feature dispatch stops handing `git worktree remove` permission to an agent that owns no worktree lifecycle.

**Side Effects** — the shipped default feature prompt changes. On a default feature dispatch (`useWorktreesPerPlan` off) the guardrail reverts from `GIT_SAFETY_DIRECTIVE_WORKTREE_MODE` to `GIT_SAFETY_DIRECTIVE`, i.e. worktree deletion goes back to being forbidden. That is the intent. Feature dispatches with `useWorktreesPerPlan` **on** are byte-identical to today.

**Dependencies & Conflicts**

- Independent of the teams work.
- `AgentSkillExporter` imports both `buildGitPolicyBlock` (`:193`) and `WORKTREES_PER_PLAN_DIRECTIVE` (`:317`, emitted under an `addons.useWorktreesPerPlan` gate at `:314`). It has no `featureMode` concept, so deleting the disjunct cannot change exported skill text. Re-read the export once after the change to confirm.
- **`protocol-catalog.json` does NOT need regenerating.** `featureWorktreeMode` appears twice in the catalog (≈`:10902`, `:13440`) — both are the `worktreeConfig` **push payload key** posted by `_sendWorktreeConfig` (`KanbanProvider.ts:12761` reads the DB key, `:12821` posts it) for the Worktrees-tab UI. That path is live and untouched. The prompt-builder option is not in the generated verb surface, so `catalog:check` / `parity:check` / `verb-returns:check` are structurally blind to this change.
- **No test or webview consumer of the prompt-builder option.** A repo-wide search for `featureWorktreeMode` outside `.switchboard/plans/` returns only `agentPromptBuilder.ts`, `KanbanProvider.ts`, and the two catalog rows above. `src/services/__tests__/agentPromptBuilder.test.ts` exercises `buildFeatureSubagentClause` directly (`:386-412`) and never passes a mode. Removal is safe.
- **Pre-existing red test in the blast area.** `src/test/agent-prompt-builder-subagents.test.js` is **red at HEAD**, failing at `testMultiplePlans` ("Role planner SHOULD include sequential instruction by default") before it ever reaches `testGitGuardrailCoexistsWithWorktrees` (`:110-122`). Record this before starting so the failure is not attributed to this change. Note that `:120` asserts `prompt.includes('create worktrees')` under `useWorktreesPerPlanEnabled: true` — that path is unaffected here, but the assertion string does not appear in either guardrail constant, so it may be a second latent failure hiding behind the first.

## Dependencies

None.

## Adversarial Synthesis

**Risk Summary.** The contradiction is real but cosmetic; the real defect is that `|| options?.featureMode === true` silently swaps the git guardrail to the variant that permits `git worktree remove`, on exactly the dispatches where the host — not the agent — owns the worktree. The fix is a deletion, not an addition: drop the disjunct at all **ten** call sites so both blocks read `useWorktreesPerPlanEnabled`, matching the already-correct custom-agent path. The dominant execution risk is incomplete application across those ten sites (the draft plan listed five); the secondary risk is over-building — the "worktree already provided" state the plan wanted to invent is already emitted verbatim by the `WORKTREE:` block. Mitigations: pin the ten-site count with an exact-string assertion, and state acceptance in lifecycle terms (removal permission iff the agent was told to create) rather than as "no contradictory sentences", which a green grep can satisfy by deleting the wrong sentence.

## Implementation

> **Superseded:** Steps 1–3 of the original: "Derive the feature directive's worktree clause and the git block's worktree variant from a single resolved state, covering three cases … Add the 'already provided' case to the feature directive, sourced from `worktreeActive` … Apply the corrected condition at all five git-block call sites."
> **Reason:** A tri-state threaded to three consumers is more machinery than the defect needs, and its third case duplicates the `WORKTREE:` block that already ships. The two blocks disagree because one of them reads an input it should never have read; deleting that input makes them agree structurally, with no shared state to keep in sync and nothing new to drift. It also closes the guardrail hole, which the tri-state design did not address. And the site count was wrong.
> **Replaced with:** Steps 1–3 below.

1. **Delete `|| options?.featureMode === true` from the `worktreePerPlanActive` argument at all ten `buildGitPolicyBlock` call sites** in `buildKanbanBatchPrompt` — `agentPromptBuilder.ts:1370, 1502, 1559, 1618, 1671, 1724, 1766, 1800, 1862, 1913`. Each becomes `worktreePerPlanActive: useWorktreesPerPlanEnabled`. `useWorktreesPerPlanEnabled` is declared once at `:1185` and is in scope at all ten. Do **not** touch `:2074-2081` (`buildCustomAgentPrompt`) — it already reads the right flag.
2. **Leave `buildFeatureSubagentClause` and its three call sites alone.** Once step 1 lands, the feature directive and the git block read the same flag by construction. No new state, no new directive variant, no "already provided" text — `:1249-1253` already emits it with the worktree path.
3. **Update the comment at `:633-637`** so it stops naming `featureMode` as a trigger for the narrowed guardrail, and record the lifecycle rule that replaces it: the worktree-mode guardrail is selected **iff** the agent was told to create worktrees (`useWorktreesPerPlan`); a host-provisioned worktree (`feature_worktree_mode = 'per-feature'`) is owned and removed by the host, so the agent keeps the standard guardrail. Same correction to the header comment on `GIT_SAFETY_DIRECTIVE_WORKTREE_MODE` at `:560-567`, which currently says "(useWorktreesPerPlanEnabled or featureMode)".
4. Remove `mode` / `featureWorktreeMode` from `resolveFeatureOrchestrationDirective`'s signature (`:948-949`) and from `PromptBuilderOptions` (`:316-321`), along with the `console.warn` at `:970-972`, the argument at `:1278`, and the stamping at `KanbanProvider.ts:5179`. The DB read at `KanbanProvider.ts:5155` goes with it (nothing else in that scope consumes `featureWorktreeMode`); leave the *other* reads — `:2249`, `:8454`, `:8465`, `:8473`, `:11959`, `:12761`, `:13470` — untouched. That half is live.
5. Remove the empty `FeatureOrchestrationDirectiveContext` interface (`:909-915`) and its `_context` parameter (`:953`). The sole call site passes `undefined` (`:1282`) — delete that argument too, and shift the remaining positional arguments up.
6. Leave `featurePromptTemplate`'s read path in place as a legacy fallback; add a comment at `KanbanProvider.ts:5154` recording that its writer was removed (`updateFeatureConfig`, `:12287-12294`) so it is not mistaken for live configuration.

## Proposed Changes

### `agentPromptBuilder.ts` — guardrail variant selector

- **Context:** The git block flips its safety-guardrail variant on `useWorktreesPerPlanEnabled || options?.featureMode === true`; the feature directive's worktree clause reads only `useWorktreesPerPlanEnabled`. They disagree on the default, and the disagreement grants `git worktree remove` permission on a host-owned worktree.
- **Logic:** Delete the `featureMode` disjunct at all ten call sites. Both blocks then read one flag with no shared state to thread.
- **Implementation:** Ten identical single-expression edits at `:1370, 1502, 1559, 1618, 1671, 1724, 1766, 1800, 1862, 1913`, plus the two comment corrections at `:560-567` and `:633-637`.
- **Edge Cases:** `:1671` sits one nesting level deeper than the others (inside the feature-coder branch) — the same edit applies. `:2074-2081` is out of scope and must stay as-is.

### `agentPromptBuilder.ts` / `KanbanProvider.ts` — `featureWorktreeMode` prompt plumbing removal

- **Context:** Threaded DB → `batchOptions` → `PromptBuilderOptions` → function parameter; used only in a `console.warn`.
- **Logic:** Drop it from the prompt path; keep the DB key and all seven non-prompt read/write sites for orchestration.
- **Implementation:** `agentPromptBuilder.ts` `:316-321` (option field), `:948-949` (parameter), `:970-972` (warn), `:1278` (argument); `KanbanProvider.ts` `:5155` (read), `:5179` (stamp).
- **Edge Cases:** Do not remove the orchestration read/restore paths (`:2249`, `:8454`, `:8465`, `:8473`, `:11959`), the Worktrees-tab config push (`:12761`, `:12821`), or the feature-creation snapshot (`:13470`) — all live. The catalog is unaffected.

### `agentPromptBuilder.ts` — dead signature cleanup

- **Context:** Empty interface plus an unused `_context` parameter, retained for compatibility with a caller that passes `undefined`.
- **Logic:** Delete both, and delete the `undefined` argument at the sole call site.
- **Implementation:** `:909-915`, `:953`, `:1282`.
- **Edge Cases:** `resolveFeatureOrchestrationDirective` is positional — removing two parameters shifts the remaining six. `:1277-1287` is the only call site in the repo; re-align it in the same edit.

## Verification Plan

> Per the dispatching session's directives, this pass ran **no** project compilation or test suite as verification. The type-check baseline below was captured once as *research* (to correct a false claim in the draft) and is recorded so the implementer does not have to re-derive it.

1. **Guardrail lifecycle rule holds — this is the acceptance criterion, not "no contradictory sentences".** Inspect the generated prompt for four cases and confirm the guardrail constant matches who owns the worktree lifecycle:

   | Case | `useWorktreesPerPlan` | `featureMode` | Expected guardrail |
   | :--- | :--- | :--- | :--- |
   | Default feature dispatch | off | true | `GIT_SAFETY_DIRECTIVE` (worktree deletion **forbidden**) — *changes; fails at HEAD* |
   | Per-feature orchestration worktree | off | true | `GIT_SAFETY_DIRECTIVE` — *changes; fails at HEAD* |
   | Agent self-provisions per subtask | on | true | `GIT_SAFETY_DIRECTIVE_WORKTREE_MODE` — *unchanged* |
   | Non-feature batch | off | false | `GIT_SAFETY_DIRECTIVE` — *unchanged* |

   A prompt can be internally consistent and still be wrong here: deleting either sentence would make a "no contradiction" grep pass while leaving the wrong guardrail shipping. Check the constant, not the coherence.

2. **All ten sites, not one.** `grep -c "worktreePerPlanActive: useWorktreesPerPlanEnabled || options?.featureMode === true" src/services/agentPromptBuilder.ts` must return `0`, and `grep -c "worktreePerPlanActive: useWorktreesPerPlanEnabled" src/services/agentPromptBuilder.ts` must return `10`. Pin these two numbers — a partial application is the single most likely way this ships half-done.

3. **A feature dispatched into a per-feature worktree still receives the `WORKTREE:` block** naming its path (`:1249-1253`), and receives `Do NOT create git worktrees for this dispatch.` — which is now the correct instruction, since the host provisioned and owns it.

4. **A non-feature batch dispatch is unchanged, byte for byte.**

5. **All ten role paths produce a matching pair of blocks**, not just the planner path. Generate one prompt per role branch and diff the guardrail constant against the feature directive's worktree clause.

6. **Setting `feature_worktree_mode` by hand changes no prompt text** — confirming the prompt plumbing is gone — while orchestration's worktree creation (`KanbanProvider.ts:13470-13473`) still honours it and the Worktrees tab still reflects it (`:12821`).

7. **`AgentSkillExporter` output still reads correctly** — its `useWorktreesPerPlan`-gated block (`:314-320`) and its `buildGitPolicyBlock` call (`:193`) both have no `featureMode` input, so no change is expected; confirm by inspection.

8. **Type-check baseline (deferred per session directive; recorded for comparison).** `npx tsc --noEmit` at HEAD on 2026-08-16 reports **9 errors**, not 5:
   - 5 × `TS2835` — `ClickUpSyncService.ts:3165`, `KanbanProvider.ts:9254`, `NotionFetchService.ts:704`, `TaskViewerProvider.ts:11229`, `TaskViewerProvider.ts:11283`
   - 2 × `TS2367` — `TaskViewerProvider.ts:9826`, `terminalUtils.ts:154`
   - 1 × `TS2322` — `TaskViewerProvider.ts:10264`
   - 1 × `TS2304` — `bootstrap.ts:1276` (`Cannot find name 'team'`)

   > **Superseded:** "`npx tsc --noEmit` introduces no new errors against the pre-existing baseline (5 `TS2835` errors at HEAD)."
   > **Reason:** Measured wrong. There are 5 `TS2835` errors but 9 errors total across 4 codes. A coder holding the stated baseline sees 4 unexplained errors after a change that cannot have caused them, and either chases them or, worse, "fixes" unrelated files.
   > **Replaced with:** the full 9-error breakdown above. Step 5 of the implementation removes two positional parameters from an exported function with one call site — that is the only realistic source of a *new* type error, and it will surface at `agentPromptBuilder.ts:1277-1287` if the argument list is not re-aligned.

9. **Pre-existing red test, do not attribute.** `src/test/agent-prompt-builder-subagents.test.js` fails at HEAD before reaching its worktree assertion (see the Dependencies audit). Capture its output before starting.

## Recommendation

Complexity 4 → **Send to Coder.** Independent of the teams set, and it stops a wrong instruction shipping to coders today — including a guardrail that grants `git worktree remove` on a worktree the agent does not own. The care needed is entirely in coverage: ten duplicated call sites, of which the draft plan named five. Pin the count with the grep assertions in Verification step 2 before calling it done.

## Completion Report

Implemented in full on 2026-08-16, commit `d8f9c0b9`. All ten `buildGitPolicyBlock` call sites now read `worktreePerPlanActive: useWorktreesPerPlanEnabled` (the `|| options?.featureMode === true` disjunct is gone — grep returns 0 for the old expression and 10 for the new). The inert `featureWorktreeMode` prompt plumbing was removed from `PromptBuilderOptions`, `resolveFeatureOrchestrationDirective`'s signature, the `console.warn`, the call-site argument, and the `KanbanProvider` DB read/stamp; the empty `FeatureOrchestrationDirectiveContext` interface and `_context` parameter were deleted and the sole call site re-aligned positionally. The live orchestration read/restore paths, Worktrees-tab config push, and feature-creation snapshot were left untouched; `featurePromptTemplate`'s read path was retained as a legacy fallback with a documenting comment. Verification: `npx tsc --noEmit` reports 5 TS2835 errors (the tree has moved since the plan's 9-error baseline — the 4 non-TS2835 errors are no longer present, and none are in `agentPromptBuilder.ts`, confirming the positional re-alignment introduced no new errors); the pre-existing red test (`agent-prompt-builder-subagents.test.js`, "Role planner SHOULD include sequential instruction by default") fails identically before and after the change. Only my own hunks were committed — the unrelated PHONE-A-FRIEND edit in `agentPromptBuilder.ts` and the ~488 lines of unrelated changes in `KanbanProvider.ts` remain unstaged in the working tree.

## Review Findings

Reviewer pass (2026-08-16) on commit `d8f9c0b9` (2 files). Judged on the **lifecycle rule**, not on grep counts: `buildGitPolicyBlock:637` selects `GIT_SAFETY_DIRECTIVE_WORKTREE_MODE` iff `worktreePerPlanActive`, all ten call sites (`:1353, 1485, 1542, 1601, 1654, 1707, 1749, 1783, 1845, 1896`) now pass the bare `useWorktreesPerPlanEnabled`, and `buildCustomAgentPrompt:2063` still reads `addons?.useWorktreesPerPlan` — so all four acceptance cases resolve correctly and a host-provisioned per-feature worktree now keeps the standard guardrail. Critically, **neither guardrail constant's body was edited** — the commit touches only their doc comments, so the "green grep satisfied by deleting the wrong sentence" failure mode did not occur; `GIT_SAFETY_DIRECTIVE` still bans "branch/worktree deletion" verbatim. The dead-plumbing removal is clean: `FeatureOrchestrationDirectiveContext` has **zero** remaining references, `resolveFeatureOrchestrationDirective`'s 9→7 positional re-alignment is exact against its sole call site (`:1262`), `buildFeatureSubagentClause` was not touched, `featurePromptTemplate`'s read path survives with the requested legacy comment, and every live `feature_worktree_mode` site (`KanbanProvider.ts:2262-2300, 12080, 12882, 13591`) is intact. **One MAJOR — gate wiring:** `src/test/agent-prompt-builder-subagents.test.js` holds `testGitGuardrailCoexistsWithWorktrees`, the only automated coverage of the behaviour this plan changed, and it is referenced by **neither `package.json` nor `.github/workflows/`** — it is also red at HEAD (fails at "Role planner SHOULD include sequential instruction by default", identically before and after, pre-existing and not attributable), which is how it stayed red unnoticed; the lifecycle rule therefore ships with no CI protection and a future re-add of the disjunct would go undetected. Verification: `npx tsc --noEmit` = 5 pre-existing `TS2835` errors, none in `agentPromptBuilder.ts` (the plan's 9-error baseline is stale — the tree moved); no fix applied, the change itself is correct and complete as specified.
