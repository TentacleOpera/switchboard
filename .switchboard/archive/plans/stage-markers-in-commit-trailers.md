# Stage Markers in Git — a Commit Says Which Stage Finished, for the Orchestrator and the Board

## Goal

When a role that has been given a commit strategy commits, its commit carries a machine-readable trailer naming the stage and the plan. Anything that needs to know "is this done" — starting with the orchestrator's tick — reads git instead of inferring.

### Why

**Every completion signal in this system today is an inference.** Plan-file mtime advance (`OversightPassService.ts:29`, `PlanIngestionEngine.ts:448`), pty-stream silence, a card's column — each is a proxy that has to be interpreted, and each has a documented failure: mtime is unreliable, a lead is idle by design so silence means nothing, and cards move on coding *start* so a column never means finished. The board has struggled for the same reason: it has no fact to display, only estimates.

**A commit is a fact.** It is durable (unlike mtime, which does not survive a fresh checkout), attributable (a role and a plan, not a guess), verifiable (the diff is right there), and it exists at exactly the moment a stage ends.

**The orchestrator already tries to read git, and reads it too coarsely.** `.agents/skills/switchboard-orchestrator/SKILL.md:93-105` — *"Verify via Git (status of record)"* — currently offers `git rev-list --count <base>..HEAD > 0` (any commit, by anyone, for any reason), `git status --porcelain`, and a stall counter keyed on branch-tip SHA. It cannot tell a coder's commit from a reviewer's, and it has no per-plan attribution at all. This plan gives that section something precise to query.

**Three stages, three markers.** With the planner, lead, coder, intern and reviewer each able to commit (see `retire-auto-commit-agents-commit-their-own-work.md`), the pipeline emits one marker per stage: planned, coded, reviewed. "Reviewed" is the one nothing can currently express — the reviewer both approves and fixes, and neither the plan file nor the board distinguishes its output from the coder's.

## The marker

Git trailers on the commit the role already makes — no extra commit, no separate file:

```
reviewer: fix null guard in team lookup and verify against plan

Switchboard-Stage: reviewed
Switchboard-Plan: 5f3e165f-d7ce-46e3-8291-f41d07380d38
```

- **`Switchboard-Stage`** — `planned` | `coded` | `reviewed`. One value per stage, emitted by that role's commit clause.
- **`Switchboard-Plan`** — the planId(s) the dispatch carried.

Trailers rather than a message prefix: they are machine-readable, they leave the subject line free to describe the actual change, and they survive rebase and cherry-pick (both preserve the message). A subject-line convention would put parsing pressure on text a human writes.

The query form is verified against the repo's git (2.50.1):

```
git log --format='%(trailers:key=Switchboard-Stage,valueonly)'
git log --format='%(trailers:key=Switchboard-Plan,valueonly)'
```

> **Superseded:** "The role's dispatch prompt already knows both values, so the commit clause emits them — the agent is not asked to remember or invent anything."
> **Reason:** True of the prompt, false of the *builder*. `buildGitPolicyBlock` (`agentPromptBuilder.ts:601`) is a **pure function over `{branch, commit, push, guardrail, worktreeActive, worktreePerPlanActive}`** — it receives neither the role nor any planId. The clause it emits physically cannot name a stage or a plan today. Twelve call sites inside `buildKanbanBatchPrompt` plus one in `AgentSkillExporter.ts:193` consume it, and the exporter has no planId at all. Threading the two values in is the actual work of this plan, and it was not costed.
> **Replaced with:** `buildGitPolicyBlock` gains two **optional** inputs, `stage` and `planIds`, and emits the trailer instruction only when it has a stage. `role` and `plans` are already parameters of `buildKanbanBatchPrompt` (`:1136-1137`), so all twelve call sites can supply them; `AgentSkillExporter` supplies neither and its exported skills keep today's clause verbatim. Detail in *What changes*.

### The stage is derived from the role, and the role list is wider than "planner, lead, reviewer"

The stage cannot come from the agent — asking it to pick would reintroduce exactly the human-written-text parsing the trailer format exists to avoid. It comes from a static map keyed on the `role` already passed to `buildKanbanBatchPrompt`:

| role | `Switchboard-Stage` |
| :--- | :--- |
| `planner` | `planned` |
| `lead`, `coder`, `intern`, `claude_designer` | `coded` |
| `reviewer` | `reviewed` |
| anything else (custom agents, tester, analyst, …) | *no stage trailer* |

> **Superseded:** "When the planner, lead or reviewer commits, its commit carries a machine-readable trailer."
> **Reason:** Names the wrong middle role. `coder` and `intern` have carried `gitCommitStrategy` since the granular git-policy work (`sharedDefaults.js`, `DEFAULT_ROLE_CONFIG.coder` / `.intern`; `KanbanProvider.ts:5397-5407`), and the coder is the role that actually does the coding in the normal pipeline — a lead often leads without touching a file. A map covering only the three named roles would leave the most common `coded` commit unmarked, so the orchestrator would still have to infer the one stage it most needs.
> **Replaced with:** The role→stage table above. Every role that can be given a commit strategy is covered; unknown roles emit no stage trailer, because a wrong stage is worse than a missing one.

### One prompt can carry many plans

Batch dispatch is **M plans : 1 prompt : 1 terminal** — `buildKanbanBatchPrompt(role, plans: BatchPromptPlan[], …)` takes an array, and the plan list already renders `PLAN_ID=<id>` per entry (`agentPromptBuilder.ts:434-441`). So a single `Switchboard-Plan` value is undefined for a batch.

Git trailers legitimately repeat a key. The clause therefore instructs: **one `Switchboard-Plan` trailer per plan this commit covers**, and `%(trailers:key=Switchboard-Plan,valueonly)` returns all of them. A reader matching a specific plan does a membership test, not an equality test — state that explicitly wherever a reader is written, because equality is the obvious wrong implementation.

Plans whose `planId` is absent (`plan.planId` is optional on `BatchPromptPlan`, `:35`) are simply omitted from the list; if none of the batch's plans has an id, emit the stage trailer alone.

## Who reads them

**The orchestrator's tick — in this plan.** Replace the coarse bullets in `.agents/skills/switchboard-orchestrator/SKILL.md:93-105` with trailer queries: "has this plan been coded" becomes a `Switchboard-Stage: coded` + `Switchboard-Plan: <id>` match instead of `rev-list --count > 0`, and "has it been reviewed" becomes expressible for the first time. Keep the existing bullets as the fallback for un-marked commits — see *Additive, not a replacement*.

**The board — explicitly deferred.** Displaying a plan's real stage needs a git-reading service, a refresh trigger, and a UI surface. None of that is in this plan.

> **Superseded:** Verification item — "The board can show a plan as reviewed on the strength of the marker alone."
> **Reason:** Unpassable as scoped. The plan's *What changes* covers emission only; no board reader is designed, built or wired anywhere in it. Leaving the item in makes the plan fail its own verification, or invites a coder to improvise a board feature nobody specified — the classic gap where a plan appears to achieve its goal while the goal is unmet.
> **Replaced with:** *"A marker written by a reviewer is retrievable for a named plan by a single `git log --format='%(trailers:…)'` query, with no bespoke parsing."* That is the fact the board would later consume, verified at the layer this plan actually builds. Board display is a follow-on plan.

## Additive, not a replacement

**Existing detection stays.** Do not remove mtime-advance completion (`PlanIngestionEngine.ts:448`, `OversightPassService.ts:430`), the turn-end classification, or anything else that currently drives the board — markers are a second, better source that must prove itself first. A missing commit is a missing marker, and until markers are demonstrably reliable, losing the old signal would trade a noisy detector for a silent one.

A role set to `dontCommit`, or to `notSpecified`, emits no marker at all. Absence must never be read as failure — only presence carries information.

Reconciling the two — or retiring the weaker — is a later decision made with evidence, not part of this plan.

## Metadata

**Complexity:** 5
**Tags:** backend, reliability, feature

> **Superseded:** **Complexity:** 4
> **Reason:** 4 assumed the values were already at hand in the clause builder. They are not: this threads two new inputs through a pure builder consumed at thirteen sites, adds a role→stage map, defines repeated-key semantics for batch dispatch, and rewrites a section of the orchestrator skill.
> **Replaced with:** **Complexity:** 5

## User Review Required

None. The trailer format is verified against the repo's git, the role→stage map is derived from which roles can hold a commit strategy, repeated `Switchboard-Plan` keys are standard git trailer behaviour, and board consumption is explicitly deferred rather than left open.

## Complexity Audit

### Routine
- Adding two optional fields to a pure function's options object and one conditional block to its body.
- A static `Record<string, string>` role→stage map.
- Adding the same two arguments at twelve structurally identical call sites.
- Rewriting a section of a markdown skill file.

### Complex / Risky
- **Thirteen consumers, one of which has no planId.** `AgentSkillExporter.ts:193` exports agent skills with no dispatch context. Both new inputs must be optional and the trailer block must be skipped entirely when `stage` is absent, or every exported skill gains an instruction to emit `Switchboard-Plan: undefined`.
- **A shadowed binding at `agentPromptBuilder.ts:1296`.** The `planner` branch re-declares `gitBranchStrategy` / `gitCommitStrategy` / `gitPushStrategy` in an inner scope. Hoisting a shared arguments object at the top of `buildKanbanBatchPrompt` would silently capture the *outer* bindings and mis-build the planner's block. Add the two fields at each call site individually — mechanical, and immune to the trap.
- **Squash-merge is the one trailer-loss path.** Rebase and cherry-pick preserve the commit message and therefore the trailers. `git merge --squash` composes a new message from the squashed commits (trailers survive but may duplicate); a UI "squash and merge" that writes its own message drops them. This is why existing detection must stay.
- **A batch commit's `Switchboard-Plan` is a list, not a value.** A reader written with `===` looks correct on single-plan dispatches — the common case in testing — and silently fails on batches.
- **Prompt text is not a guarantee.** The agent may ignore the clause. Markers are best-effort by construction, which is precisely why this plan is additive.

## Edge-Case & Dependency Audit

**Race Conditions**
- None introduced. `buildGitPolicyBlock` is pure and synchronous, and this plan adds no I/O, no subprocess and no persisted state.
- Reading trailers from the orchestrator's tick is a read-only `git log` against a worktree the orchestrator already queries with `rev-list` and `status --porcelain` in the same section.

**Security**
- `planId` values are UUIDs from the DB, interpolated into prompt text the agent then places in a commit message. They are not shell-interpolated by the extension. Do not templatise a planId into any command string in the emitted clause — state the value and let the agent write it.
- No new network surface.

**Side Effects**
- Every commit made under a `whenDone` strategy by a mapped role gains two trailer lines. Commit messages get longer; nothing downstream parses them today, so nothing breaks.
- The trailers are visible in `git log`, PR descriptions and blame views. That is the intent.
- The orchestrator skill's guidance changes — a behaviour change to an unattended agent, which lands with no code deploy because skills are read from disk.

**Dependencies & Conflicts**
- Touches `agentPromptBuilder.ts` and `.agents/skills/switchboard-orchestrator/SKILL.md`. `AgentSkillExporter.ts` needs no edit provided the new inputs are optional — confirm rather than assume.
- **Shared surface with `retire-auto-commit-agents-commit-their-own-work.md`:** both edit `GIT_COMMIT_CLAUSES.whenDone`. **That plan owns the rewrite; this one extends the rewritten text.** It must land first. Per the project PRD's one-agent-stream-per-provider-file rule, the two must not be coded in parallel.
- The role→stage map's `planner` and `reviewer` rows only produce a marker once that plan has given those roles a commit strategy. The map is harmless before then — those roles simply resolve `notSpecified` and no commit clause is emitted at all.
- No overlap with `coding-team-sends-the-feature-to-review-not-each-subtask.md`.

## Dependencies

- `sess_retire_auto_commit — GIT_COMMIT_CLAUSES.whenDone rewrite (must land first)`
- `sess_git_policy_granular — buildGitPolicyBlock signature and its thirteen consumers`
- `sess_orchestrator_persona — Verify via Git section of the orchestrator skill`

## Adversarial Synthesis

Key risks: the two new builder inputs are consumed at thirteen sites including one with no dispatch context, so a non-optional signature breaks exported agent skills; a hoisted arguments object would capture the planner branch's shadowed bindings; and a batch commit's repeated `Switchboard-Plan` trailers invite an equality-based reader that passes single-plan tests and fails batches. Mitigations: both inputs optional with the trailer block skipped when `stage` is absent, per-call-site argument addition rather than hoisting, and membership-test semantics stated in the plan and in the skill's query examples. Residual: prompt text is advisory, so markers are best-effort — which is exactly why every existing completion signal stays in place.

## Proposed Changes

### `src/services/agentPromptBuilder.ts` — `buildGitPolicyBlock` (`:601-640`)

- **Context:** Pure composer of the `GIT POLICY:` block from Branch → Commit → Push → Safety clauses. Options are `{branch, commit, push, guardrail, worktreeActive, worktreePerPlanActive}`.
- **Logic:** Add `stage?: string` and `planIds?: string[]`. Inside the existing commit-clause branch (`:619-623`), when `stage` is present, append a trailer instruction naming `Switchboard-Stage: <stage>` and one `Switchboard-Plan: <id>` line per entry in `planIds`. When `stage` is absent, emit nothing new.
- **Implementation:** Keep the function pure and keep the `GIT POLICY:` literal prefix — existing substring-based assertions depend on it. The trailer instruction belongs *inside* the commit clause, so `dontCommit` and `notSpecified` cannot produce it. Preserve the existing worktree suffix behaviour (`:621`) — the appended `" Commit inside your assigned worktree."` and the trailer text must read coherently together.
- **Edge Cases:** `planIds` empty or undefined → stage trailer only. `stage` present but unmapped → callers pass `undefined`, not a fallback string.

### `src/services/agentPromptBuilder.ts` — role→stage map

- **Context:** New module-level constant beside `GIT_COMMIT_CLAUSES` (`:573`).
- **Logic:** `const STAGE_BY_ROLE: Record<string, string> = { planner: 'planned', lead: 'coded', coder: 'coded', intern: 'coded', claude_designer: 'coded', reviewer: 'reviewed' }`. Lookup misses yield `undefined`.
- **Implementation:** Export it — a reader (and its tests) needs the same vocabulary, and a second hand-maintained copy is how the vocabularies drift.
- **Edge Cases:** No `default` branch, no `'unknown'` sentinel. An unmapped role must produce no trailer.

### `src/services/agentPromptBuilder.ts` — the twelve `buildGitPolicyBlock` call sites (`:1353, 1485, 1542, 1601, 1654, 1707, 1749, 1783, 1845, 1896`, and the remaining sites in `buildKanbanBatchPrompt`)

- **Context:** All pass an identical argument object; `role` and `plans` are parameters of the enclosing function (`:1136-1137`).
- **Logic:** Add `stage: STAGE_BY_ROLE[role]` and `planIds: plans.map(p => p.planId).filter(Boolean)`.
- **Implementation:** Edit each site individually. **Do not hoist a shared arguments object** — `:1294-1297` re-declares the three strategy bindings inside the `planner` branch, and a hoisted object would capture the outer ones.
- **Edge Cases:** `buildCustomAgentPrompt`'s block (`:2057`) is the custom-agent path with no built-in role — leave it passing neither field.

### `src/services/AgentSkillExporter.ts` (`:193-200`)

- **Context:** Builds a `### Git Safety Guardrail` block for an exported skill file, with no dispatch context and no planId.
- **Logic:** No change.
- **Implementation:** Verify only — with both new fields optional, this call is unaffected and the exported skill's git block is byte-identical to today's.
- **Edge Cases:** If a future exporter change wants markers, it needs a planId source; there is none, so do not invent one.

### `.agents/skills/switchboard-orchestrator/SKILL.md` (`## Verify via Git`, `:93-105`)

- **Context:** The orchestrator's status-of-record checks — `rev-list --count`, `status --porcelain`, card column, stall counter.
- **Logic:** Add marker queries as the **preferred** check, keeping the existing bullets as the fallback when no marker is present. Give the exact `git log --format='%(trailers:key=Switchboard-Stage,valueonly)'` / `key=Switchboard-Plan` forms, and state that `Switchboard-Plan` may repeat on a batch commit so a plan match is a **membership** test.
- **Implementation:** Say plainly that a missing marker means "no information", never "not done" — the stall counter keeps owning the not-done judgement.
- **Edge Cases:** The stall counter keys on branch-tip SHA and stays as-is; markers refine *what finished*, not *whether anything moved*.

## Verification Plan

1. A planner finishing a plan produces a commit trailing `Switchboard-Stage: planned` and the correct planId.
2. Same for a coder and a lead (`coded`) and a reviewer (`reviewed`).
3. `git log --format='%(trailers:key=Switchboard-Stage,valueonly)'` and the `Switchboard-Plan` equivalent return the markers without any bespoke parsing.
4. A batch dispatch of three plans produces one commit carrying three `Switchboard-Plan` trailers, all three returned by one query.
5. A marker written by a reviewer is retrievable for a named plan by a single `git log --format='%(trailers:…)'` query — the fact a board reader would later consume.
6. Markers survive a rebase and a cherry-pick of the branch carrying them. A `--squash` merge is checked and its behaviour recorded, not fixed.
7. A role set to `dontCommit` or `notSpecified` emits no marker, and nothing downstream treats its absence as an error.
8. An unmapped role (custom agent, tester) with `whenDone` emits a commit clause with **no** stage trailer.
9. Exported agent skills (`AgentSkillExporter`) contain a git block byte-identical to before this change.
10. The planner's `GIT POLICY:` block is correct — the shadowed-binding trap at `:1296` did not corrupt it.
11. With markers present, every existing completion path still behaves exactly as it does today: mtime-advance completion, turn-end classification and card movement are unchanged.
12. The orchestrator, following the rewritten skill section, treats a marker-less commit as "no information" and falls back to the existing checks rather than reporting a stall.

### Automated Tests

- Unit tests over `buildGitPolicyBlock`: stage present → trailer instruction inside the commit clause; stage absent → block byte-identical to today; `dontCommit` + stage → no trailer; `planIds` empty → stage trailer only; `planIds` of three → three plan lines; worktree-active suffix composes coherently with the trailer text.
- A test pinning `STAGE_BY_ROLE`, so adding a committing role without giving it a stage is caught rather than silently unmarked.
- `src/test/minimal-prompt.test.js` and `src/test/agent-prompt-builder-subagents.test.js` assert git-policy text — read them before editing and update in the same commit.

*Per session directive, compilation and automated tests are not run as part of this pass — the coder runs them.*

**Recommendation: Send to Coder** (complexity 5).

## Completion Report — stage markers in commit trailers

**Builder signature + trailer logic (`agentPromptBuilder.ts:619-661`).** `buildGitPolicyBlock` gained two optional inputs, `stage?: string` and `planIds?: string[]`, destructured alongside the existing six. The trailer instruction is emitted **inside** the commit clause branch — only when `commit` is a real strategy (`whenDone`) AND `stage` is present — so `dontCommit`, `notSpecified`, and absent-stage callers produce byte-identical output to before. When `stage` is set, the commit text is extended with: `Add these git trailers to the commit message (after the subject line, one per line): Switchboard-Stage: <stage>` plus one `Switchboard-Plan: <id>` line per planId (omitted entirely when `planIds` is empty/undefined → stage trailer only), closing with `Do not put the trailers in the subject line.` The trailer text precedes the worktree suffix (`Commit inside your assigned worktree.`) so both read coherently together. The `GIT POLICY:` literal prefix is unchanged — existing substring assertions stay valid.

**`STAGE_BY_ROLE` map (`agentPromptBuilder.ts:587-594`).** Exported `Record<string, string>` beside `GIT_COMMIT_CLAUSES`: `planner → planned`, `lead/coder/intern/claude_designer → coded`, `reviewer → reviewed`. No default, no `'unknown'` sentinel — unmapped roles yield `undefined` and emit no trailer. Exported so readers/tests share one vocabulary.

**Ten batch call sites inside `buildKanbanBatchPrompt` (`:1470, 1602, 1659, 1718, 1771, 1824, 1866, 1900, 1962, 2013`).** Each now passes `stage: STAGE_BY_ROLE[role]` and `planIds: plans.map(p => p.planId).filter((id): id is string => !!id)`. Edited per-site via `replace_all` on the identical one-liner — **no hoisted shared arguments object**, so the planner branch's shadowed `gitBranchStrategy`/`gitCommitStrategy`/`gitPushStrategy` bindings (`:1412-1414`) are captured correctly in their own scope, not the outer ones. `role` and `plans` are function parameters of `buildKanbanBatchPrompt` (`:1230-1233`), unshadowed, in scope at all ten sites. The type guard `(id): id is string => !!id` narrows the `(string | undefined)[]` to `string[]` so the builder's `planIds` param type is satisfied without a cast. The plan named "twelve" call sites; the actual count after line drift is ten inside `buildKanbanBatchPrompt` (the other two `buildGitPolicyBlock` consumers — `buildSeatDirectiveBlock` at `:1000` and `buildCustomAgentPrompt` at `:2174` — are not batch dispatch sites and were left untouched per the plan's traps #2 and #3).

**`AgentSkillExporter.ts` — verified, no edit.** Its call (`:193-200`) passes neither `stage` nor `planIds`; both are optional, so the exported skill's git block is byte-identical to before. Confirmed by grep: no `stage`/`planIds`/`STAGE_BY_ROLE` references in the file.

**Orchestrator skill (`.agents/skills/switchboard-orchestrator/SKILL.md:94-128`).** Rewrote `## Verify via Git` per "Who reads them": stage-marker queries are now the **preferred** check (`git log --format='%(trailers:key=Switchboard-Stage,valueonly)'` / `key=Switchboard-Plan`), with the existing bullets (`rev-list --count`, `status --porcelain`, card column, tests, stall counter) kept verbatim as the **fallback** for un-marked commits. The section states explicitly that `Switchboard-Plan` may repeat on a batch commit so a plan match is a **membership test, not equality**; that a missing marker means "no information", never "not done"; and that the stall counter (keyed on branch-tip SHA) stays as-is — markers refine *what finished*, not *whether anything moved*. Additive only: mtime-advance completion, turn-end classification, and card movement are untouched.

**Off-limits surfaces untouched:** `kanban.html`, `teamWiring.ts`, `terminals.js`. No commit trailers or stage markers were added to any file other than the builder and the skill. Per session directive, compilation and automated tests were not run; the plan's Automated Tests section (unit tests over `buildGitPolicyBlock`, a `STAGE_BY_ROLE` pinning test, and reading/updating `minimal-prompt.test.js` + `agent-prompt-builder-subagents.test.js`) remains written down for the coder to execute. Existing tests that call `buildGitPolicyBlock` without `stage`/`planIds` (seat-safeguards, feature-worktree-guardrail) get byte-identical output because both new inputs are optional and the trailer block is skipped when `stage` is absent.

## Review Findings

**Verdict: passed after fixes — two CRITICALs, both of which made the marker unreadable while every layer looked correct.** (1) The clause instructed the agent to put the trailers "after the subject line", but git parses trailers **only in the message's final paragraph**: verified against git 2.50.1, a commit whose trailer lines follow the subject with no blank line returns EMPTY from `git log --format='%(trailers:key=Switchboard-Stage,valueonly)'` — the exact query this plan and the rewritten orchestrator skill prescribe — so every marker would have been written as ordinary body text and read as unmarked. The clause now requires the blank line and says why. (2) `dontCommit` is a key in `GIT_COMMIT_CLAUSES`, so the `commit !== 'notSpecified'` guard admitted it and emitted *"Do NOT commit. … End the commit message with a git trailer block"*, breaking verification item 7; the trailer is now gated on an explicit `COMMITTING_STRATEGIES` allowlist. Verified as specified: `STAGE_BY_ROLE` matches the plan's table exactly, ten batch call sites pass `stage`/`planIds` with no hoisted arguments object, the three non-dispatch consumers (`AgentSkillExporter:193`, `buildSeatDirectiveBlock:1022`, `buildCustomAgentPrompt:2205`) pass neither and `AgentSkillExporter.ts` is untouched with byte-identical output, a batch emits one `Switchboard-Plan` line per plan and one query returns all of them (membership, not equality), markers survive rebase and cherry-pick, and `--squash` drops them — recorded, not fixed, as the plan directs. Files changed in review: `agentPromptBuilder.ts` only; new coverage at `src/test/stage-marker-commit-contract.test.js`, wired into CI, which commits into a throwaway repo and asserts on what git actually returns rather than on what the prompt appears to say.
