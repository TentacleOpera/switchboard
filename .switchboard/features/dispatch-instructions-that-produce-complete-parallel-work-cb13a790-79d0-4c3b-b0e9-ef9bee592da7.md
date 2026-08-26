# Dispatch Instructions That Produce Complete, Parallel Work

**Complexity:** 5

## Goal

Fix the two ways Switchboard's own instructions cause an agent to do less work than the operator dispatched. On some seats a platform-injected lower-effort mode system prompt composes into core code with the wiring missing, and Switchboard emits no counter-directive. Separately, the dispatch skill's sequencing section contains four braking clauses and zero accelerating ones, so a head agent serialised an eight-subtask feature onto one coder while two sat idle.

## How the Subtasks Achieve This

- **"Ignore Low-Effort System Instructions" Prompt Add-On**: adds a default-off, per-role prompt add-on threaded through all five existing layers (UI entry, per-role default, `_getPromptsConfig` map, `PromptBuilderOptions` read, emission via `assembleSuffix`). The directive text is written against the three *named* clauses that cause the dropped wiring — read-only-what-you-touch, smallest-change-that-satisfies, deliver-the-moment-it-is-ready — while explicitly preserving the clauses Switchboard agrees with, so it cannot contradict the `skipCompilation` / `skipTests` add-ons that ship on for the coder family.
- **The Dispatch Skill Teaches Only the Conservative Half of Sequencing**: rewrites §7 of `terminal-coder-dispatch` as an ordered procedure whose steps narrow monotonically — act on declared independence, dispatch the chain head, apply file contention *pairwise*, cap at pool size, fall back to sequential only on silence. Adds the collapse-a-pairwise-constraint-into-a-global-one anti-pattern by name, a synthetic worked example, and a pool-rotation rule to §9.

Together they close both halves of the same failure: an agent that does less than it was asked (the prompt add-on) and a head agent that dispatches less than it was given (the skill).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] ["Ignore Low-Effort System Instructions" Prompt Add-On For Every Agent Role](../plans/feature_plan_20260812093300_ignore-low-effort-system-instructions-prompt-addon.md) — **PLAN REVIEWED** — ID: b642dc43-0421-4428-88e7-da57dcad5470
- [ ] [The Dispatch Skill Teaches Only The Conservative Half Of Sequencing](../plans/feature_plan_20260813104500_dispatch-skill-does-not-teach-parallelism.md) — **PLAN REVIEWED** — ID: c2dda005-74f5-4ba8-bc60-41898ef94b8e
<!-- END SUBTASKS -->

## Plan Review Status

**Both subtasks are PLAN REVIEWED. The feature is ready to dispatch.**

The column-mixed state this section previously described has been resolved, and the replan it asked for was run on 2026-08-14 (`improve-feature`, both subtasks re-verified against HEAD `1bd39f4a`). Outcome: no merges, no splits, no deletions — the two subtasks were already the right decomposition. Every claim in both plans was re-checked against the tree, and four defects were corrected:

- **Line-number drift** across `agentPromptBuilder.ts` (~40 lines) and `KanbanProvider.ts` (~110 lines). Structure held; every anchor was renumbered and the plan now says to anchor on symbols.
- **A symbol that does not exist** — `AgentSkillExporter.toBuiltinAddons` is really `normalizeBuiltinAddons`.
- **A test assertion that could not pass** — the automated tests assert `'EFFORT POLICY:'` while the specified directive opens `EFFORT POLICY —`.
- **A false "shipped" premise** in the dispatch-skill plan: the sibling card *Clear The Coder Between Subtasks* sits in CODE REVIEWED, but its skill-document half is in no commit, ref or worktree. Its code half did land. That plan now records the verified HEAD text of the file it edits.

Do not re-open the three decided scope exclusions in the low-effort add-on plan (`chat`, `claude_designer`, `custom_agent_*`), and do not re-author the missing clear rule inside the dispatch-skill plan — it belongs to the sibling card.

## Dependencies & sequencing

- **No hard ordering constraint; the two subtasks can run in parallel.** One is TypeScript prompt plumbing (`agentPromptBuilder.ts`, `KanbanProvider.ts`, `sharedDefaults.js`, `AgentSkillExporter.ts`); the other is markdown in `.agents/skills/terminal-coder-dispatch/SKILL.md`. No shared file.
- **The skill edit must land in both copies.** Skill discovery is host-split — Claude Code resolves through `MIRROR_MANIFEST`, Antigravity reads the filesystem — so `.agents/` is the source of truth and `.claude/skills/terminal-coder-dispatch/SKILL.md` must be regenerated, never hand-edited. Editing only one leaves one host on the old rule.
- **The prompt add-on subtask has an internal file-contention hazard of its own:** `agentPromptBuilder.ts` and `KanbanProvider.ts` are high-traffic files, and the ten `assembleSuffix` parts-object edits sit in the 1400–1960 line range. Do not run it concurrently with any other stream editing either file.
- **Do not wire the add-on for `chat`, `claude_designer`, or custom agents.** All three are decided exclusions with stated reasons in the plan — an entry there would be a dead control, which is the exact defect the *Controls That Produce Nothing* feature exists to remove.
