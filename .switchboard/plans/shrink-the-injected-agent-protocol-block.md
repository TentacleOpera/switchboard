# Cut the injected agent protocol block from 14,826 chars to ~320

## Goal

Reduce the block Switchboard writes into every user's `CLAUDE.md` from ~3,700 tokens to under 100, keeping only the three rules that cannot work anywhere else, and relocating one role-scoped rule into the per-role prompt builder where it belongs.

### Problem Analysis

`ClaudeCodeMirrorService.buildManagedInner(sourceContent, preamble)` writes the entire `AGENTS.md` body into a managed block in the user's `CLAUDE.md`, prefixed by a 678-char host-translation note. Measured: **14,826 chars, ~3,706 tokens**, resident on every turn of every session in every Switchboard workspace, inside a file the user also writes their own instructions in. It is the most-multiplied text the product ships.

A section-by-section pass found that almost none of it can act. The content falls into eight disqualifying categories:

**1. Dead — the tool no longer exists.** `send_message` appears exactly once in all of `src/`: in the preamble bullet telling agents to ignore it. No implementation, no verb, no MCP. Yet Rule #2, Rule #3 and the whole Code-Level Enforcement table document its valid actions and auto-routing behaviour, and Execution Rules #4 threatens that violations "will be rejected by the tool layer" — an enforcement mechanism that was deleted. ~1,150 chars describing a removed MCP, dead in **both** files, not just this one.

**2. Antigravity-only, shipped with a note saying to ignore it.** `view_file` (twice), `IsArtifact: false`, "persona adoption", `// turbo`, `skill: "<name>"` invocation syntax. The 678-char preamble exists solely to translate these; remove them and it has nothing left to translate. It is errata for content that should not be present.

**3. Already injected by the host.** The Workflow Registry (1,279) and the Available Skills table (1,919) restate what Claude Code supplies from `.claude/skills/` before the block is read — all four workflows and both model-visible skills, with descriptions.

**4. Advertising capability the agent does not have.** Two rows of the skills table name `kanban_operations` and `worktree-cleanup`, both `invocation: 'no-model'` — deliberately hidden from the model by the mirror manifest. The architecture prose also directs the agent to `kanban_operations` for manual card moves. This is worse than redundant: it invites an agent to claim a capability, then fail.

**5. Unactionable reference.** The 31-protocol name list carries no descriptions, so it cannot route a choice; protocols arrive by directive anyway. The architecture diagram is orientation. "Skill Files Location" describes directory layout an agent never needs — and was wrong in six places until corrected.

**6. Restatement.** Execution Rules restates Rule #1 and pre-flight step 3. Pre-flight step 1 ("scan for commands") and step 5 ("otherwise respond normally") are self-evident. Rule #1 itself is enforced by the harness: a slash command arrives already expanded, so an agent cannot fail to follow a workflow it was handed.

**7. Action-local.** Plan Authoring (1,748), Workspace Detection (1,013) and the memo mechanics only matter while the action is underway, by which point a protocol or workflow file is loaded.

**8. Actively harmful.** Pre-flight step 2 — "do not auto-trigger on generic language (review this, delegate this, quick start)" — attaches a do-not-act gloss to three phrases of ordinary English, in a file governing all behaviour, with no scope boundary. Claude Code has its own `/code-review` skill and `Agent` tool. The rule was written when `improve-plan`, `accuracy` and others *were* slash commands and collision was plausible; now all four commands are `/switchboard*`-prefixed and unambiguous. It guards a vanished ambiguity at the cost of suppressing legitimate non-Switchboard work.

### What survives, and why each survives on a different mechanism

Three rules qualify. The useful finding is that each earns its place for a *different* reason, and none of the reasons is "the agent would not otherwise know".

**Persistence — memo capture suppression.** Agents asked to capture memos start discussing the issues instead. This is not a discovery failure: the agent read the workflow at entry and knew the rule. It is drift. The user's next message is a substantive problem, and a coding assistant's entire default disposition is to analyse and act; the instruction is several turns back and loses. A file loaded once at mode entry cannot hold this — resident text can, because it is re-presented every turn. The `[MEMO CAPTURE ACTIVE]` marker compounds it: an agent required to emit it every turn re-asserts the mode to itself every turn.

**Motive-closing — the card-move prohibition.** A bare prohibition invites route-shopping: forbid SQL and the agent reaches for `move-card.js`; forbid moves and it wonders how the card will ever advance, then improvises. Stating that transitions happen automatically removes the incentive rather than blocking one route. **But this rule is role-scoped and does not belong in a role-agnostic file** — leads and the orchestrator legitimately move cards, which is why the current text spends most of its length enumerating exceptions. It relocates to `agentPromptBuilder`'s per-role branches.

**Silent-failure prevention — the query-kanban redirect.** Not about discovery: `query-kanban` is `invocation: 'no-user'`, so a general agent already has it listed with a description. The gap is that an agent will hand-roll trivial-looking SQL, and the column labels lie. `DEFAULT_KANBAN_COLUMNS` maps `CREATED`→"New", `PLAN REVIEWED`→"Planned", `CODE REVIEWED`→"Reviewed". A user asks about "Planned"; `WHERE kanban_column = 'Planned'` returns zero rows and the agent reports an empty column. Wrong answer, no error. The clause explaining *why not to improvise* is the load-bearing half.

### Root Cause

Every section was individually justified — each prevents a real mistake. What was never asked is whether a rule needs to be *resident* to prevent it. Content that could arrive at the moment of use was placed in the always-loaded file because that is where the previous rule went. Compounding it, one shared body serves two hosts, so each carries the other's requirements and the preamble exists to paper over the mismatch.

### Non-goals

- Removing capability. Every rule that moves keeps applying; it arrives closer to the work.
- Touching this repo's own dev rules. They live only in this repo's hand-authored `CLAUDE.md`, are absent from `AGENTS.md`, and correctly never reach users.
- Deciding the AGENTS.md target. Antigravity may not self-discover skills or support slash commands, so the registry, the skills table and the natural-language trigger may be load-bearing there. That is the per-host split below.

## Metadata

**Complexity:** 5
**Tags:** docs, refactor, performance, infrastructure, reliability

## User Review Required

Yes — two decisions.

1. **Per-host bodies.** `buildManagedInner` already takes a per-host *preamble*; it should take a per-host *body*. Claude Code needs ~320 chars; Antigravity plausibly needs the Workflow Registry and the skills table, because it may not self-discover and may lack slash commands (the natural-language trigger exists for exactly that: *"host-independent, for chats without slash commands"*). Recommendation: split, and size each host to what it actually needs. Without the split, the floor is whichever host needs more.
2. **Confirm Antigravity's discovery behaviour.** This is the input to (1) and cannot be tested from this repo. If Antigravity *does* self-discover, both bodies collapse to ~320 and no split is needed.

## Complexity Audit

### Routine

- Rewriting the resident body to the three-line form.
- Deleting the preamble, which has nothing left to translate.
- Deleting the sections in categories 1–8 above.

### Complex / Risky

- **`AGENTS.md` is a governance file.** Editing it changes every user's injected block on next sync. Explicit approval required, and the diff should be reviewed as content, not as a refactor.
- **Relocating the card-move rule needs the role set enumerated correctly.** It goes into the coder, intern, reviewer and tester prompts and must be *absent* from lead and orchestrator, which legitimately move cards. Getting that backwards either blocks legitimate dispatch or leaves the original gap. `CODE_TOUCHING_ROLES` (`agentPromptBuilder.ts:1510`) enumerates planner/lead/coder/intern/reviewer/tester and is the starting point, not the answer — planner does not move cards either.
- **`minimal-prompt.test.js` constrains the planner default, not the reviewer.** All fourteen of its minimality assertions target `'planner'`; its single reviewer call is a newline check. So per-role additions are permitted, but the planner prompt must stay one line.
- **The memo suppression may not hold even when prominent.** The section's own last clause concedes it: the sidebar path exists "backend-driven, immune to host system prompt overrides". If drift persists once the rule is one of three lines rather than one of fourteen sections, the answer is mechanical — the sidebar, or a `no-model`-style gate — not more prose. Do not treat the reduction as the fix for that.
- **Three places restate the plan format independently** — `SparkContextExporter.ts:201`, `TaskViewerProvider.ts:6538`, and the block itself. Removing one leaves two that will drift.

## Edge-Case & Dependency Audit

**Race conditions**
- None. Content relocation.

**Security**
- Slightly positive: a smaller resident block is a smaller prompt-injection surface via a compromised `AGENTS.md`.

**Side effects**
- Users who hand-edited inside the managed markers lose those edits on next sync. Existing behaviour, but a 14,500-char deletion makes it conspicuous. Release note.
- Every user's per-turn token cost drops by ~3,600 tokens. Small per turn, large in aggregate.
- The natural-language trigger "start memo capture" is not in the `switchboard-memo` skill description, which mentions only the exit command. If the registry is removed from this host's body, that gap should be closed in the skill description rather than left implicit.

**Migration**
- The managed block is regenerated from source on every sync, so no user-data migration. Shorter output replaces longer automatically.
- Nothing is deleted from the repo: relocated rules land in the per-role prompt builder.

## Dependencies

- **Requires** `replace-agent-project-pinning-with-a-sticky-ui-setting.md` for the 2,785-char pinning section, which that plan removes at source.
- **Protects** the global-database plan: pre-flight step 4 hardcodes `.switchboard/workspace-id` as the DB-path source, which that plan invalidates. Cutting it removes a silent-staleness coupling between the two.
- Otherwise independent.

## Adversarial Synthesis

**"Every rule exists because an agent got it wrong."** True, and the three that survive are the three where resident text is the mechanism that fixes it. The rest fail for reasons the block cannot address: a rule an agent ignores 3,500 tokens up the context is not more governed than one that arrives with the action. Proximity and persistence are different problems, and most of this block was solving neither.

**"Compliance will get worse."** The opposite is more likely for the survivors. If agents still move cards and still drift out of capture mode with 14,826 chars present, the current text is not working — so "keep it" is not the safe option. One prohibition among three lines is dramatically more salient than one among fourteen sections. And if prominence does not fix it, that is diagnostic: the rule is being disregarded rather than missed, which points at enforcement.

**"3,700 tokens is not much."** Per turn, no. Across every turn of every session in every workspace for every user, it is the single most-multiplied text the product ships — and by this analysis roughly 98% of it cannot act.

**"This is a lot of deletion on one person's reading."** Which is why the categories are stated with evidence rather than judgement: `send_message` has one occurrence in `src/`, the `no-model` rows are in the mirror manifest, the label/ID mismatch is in `DEFAULT_KANBAN_COLUMNS`, and the host-discovery duplication is observable in any Claude Code session's skill list. Each is checkable in under a minute.

## Proposed Changes

1. **The resident body becomes:**

   ```
   - Memo capture mode: while active, append each user message verbatim — do not
     analyse, plan, or write code. Begin every reply with `[MEMO CAPTURE ACTIVE]`.
   - Kanban questions: use the `query-kanban` skill. Displayed column labels differ
     from the stored IDs, so hand-written SQL silently returns nothing.
   ```

2. **Delete the preamble.** With the Antigravity content gone it translates nothing.
3. **Relocate the card-move rule** into `agentPromptBuilder`'s per-role composition: present for coder, intern, reviewer, tester; absent for lead and orchestrator. Phrased to close the motive — transitions happen automatically — not merely to forbid SQL.
4. **`buildManagedInner` takes a per-host body**, not just a per-host preamble.
5. **Close the "start memo capture" gap** in the `switchboard-memo` skill description, since the registry that documented it is being removed from this host's body.
6. **Regenerate** and confirm the emitted size.

### Migration

None. Regenerated from source on sync.

## Verification Plan

### Goal Invariants

- The emitted `CLAUDE.md` managed block is **under 500 chars** (currently 14,826).
- The block contains no filesystem path, no reference to `send_message`, `view_file`, `IsArtifact`, `skill: "<name>"`, and no skill or protocol name list.
- No rule removed from the block is absent from the place it moved to.

### Automated Tests

- **Size gate:** assert the emitted block is under the threshold, so it cannot silently regrow. This is the test that stops the next individually-justified addition undoing the cut.
- **No dead references:** grep the emitted block for `send_message`, `view_file`, `IsArtifact`, `// turbo`, `persona adoption`, and any `.agents/` or `.switchboard/` path. All must be absent.
- **No hidden-capability advertising:** assert the block names no skill whose manifest `invocation` is `no-model`.
- **Card-move rule placement:** compose prompts for all six roles; assert the rule is present for coder, intern, reviewer, tester and absent for lead and orchestrator.
- **Planner default unaffected:** `minimal-prompt.test.js` passes in full — the relocation must not reach the planner's one-line default.
- **Memo suppression survives:** compose a capture-mode turn and assert the suppression and the marker requirement are both present in the resident block.
- **Label/ID trap:** assert the `query-kanban` line names the mismatch, not merely the skill. A line that only names the skill does not prevent the failure.
- **Marker integrity:** regenerate over an existing 14,826-char block and assert exactly one clean marker pair remains, exercising `stripProtocolMarkers`.

## Outstanding Questions

- **[user]** Does Antigravity self-discover skills and support slash commands? Decides whether the per-host split is needed or both bodies collapse to ~320 chars.
- Does `planner` move cards? It is in `CODE_TOUCHING_ROLES` but the card-move rule may need to include it, which changes the role set in change 3.
- Do agents still drift out of capture mode once the rule is one of two lines? If so the answer is mechanical, not textual, and this plan does not deliver it.
