# Cut the injected agent protocol block from 14,826 chars to ~740

## Goal

Reduce the block Switchboard writes into every user's `CLAUDE.md` from ~3,700 tokens to ~195, keeping only the four rules that cannot work anywhere else, and relocating one role-scoped rule into the per-role prompt builder where it belongs.

### Size accounting — one authoritative figure

Earlier revisions of this plan carried four different targets (~320 in the title, ~130 tokens here, ~530 in Non-goals, under 800 in the gate). Only one of those was measured against the actual proposed text. Measured now, from the body in Proposed Changes item 1:

| | chars | tokens |
|---|---|---|
| Resident body — three rules | 528 | ~132 |
| Docs pointer (fourth rule) | 124 | ~31 |
| **Resident body total** | **652** | ~163 |
| Markers + `CLAUDE_PROTOCOL_HEADER` | 122 | ~30 |
| **Emitted managed block** | **~774** | **~194** |
| Current emitted block | 14,826 | ~3,706 |
| Reduction | **94.8%** | |

**The gate needs adjusting, and this is why it is stated here rather than discovered in CI.** At 774 the previous under-800 gate leaves 26 chars of headroom — not enough to rephrase a rule, so the gate would start failing on edits it was designed to permit. Two fixes, both already established as safe elsewhere in this plan:
- **Drop the emitted `CLAUDE_PROTOCOL_HEADER`** (−34). It stays in code as the legacy-markerless *detector* (`extension.ts:3927`) but need not be written into new blocks. → 740.
- **Shorten the markers** to `<!--sb:start-->` / `<!--sb:end-->` (−54), with a migration recognising both pairs so existing files are rewritten rather than duplicated. → 686 with the header also gone.

Adopt the header removal at minimum, keeping the gate at **under 800** with ~60 chars of headroom. Any future figure quoted for this plan is derived from this table, not from prose.

**Why 528 and not the ~320 the title used to claim.** The earlier figure predated the section-by-section review, during which three rules had their *explanatory* halves reinstated: the `query-kanban` label trap, the reason memo suppression exists at all, and the commit-is-irrelevant half of the import rule. Those clauses are the load-bearing parts — a bare prohibition without its reason is what invites route-shopping — and they cost roughly 200 chars. The growth was correct; leaving the old number in the title was not.

### Problem Analysis

`ClaudeCodeMirrorService.buildManagedInner(sourceContent, preamble)` writes the entire `AGENTS.md` body into a managed block in the user's `CLAUDE.md`, prefixed by a 678-char host-translation note. Measured: **14,826 chars, ~3,706 tokens**, resident on every turn of every session in every Switchboard workspace, inside a file the user also writes their own instructions in. It is the most-multiplied text the product ships.

A section-by-section pass found that almost none of it can act. The content falls into eight disqualifying categories:

**1. Dead — the tool no longer exists.** `send_message` appears exactly once in all of `src/`: in the preamble bullet telling agents to ignore it. No implementation, no verb, no MCP. Yet Rule #2, Rule #3 and the whole Code-Level Enforcement table document its valid actions and auto-routing behaviour, and Execution Rules #4 threatens that violations "will be rejected by the tool layer" — an enforcement mechanism that was deleted. ~1,150 chars describing a removed MCP, dead in **both** files, not just this one.

**2. Antigravity-only, shipped with a note saying to ignore it.** `view_file` (twice), `IsArtifact: false`, "persona adoption", `// turbo`, `skill: "<name>"` invocation syntax. The 678-char preamble exists solely to translate these; remove them and it has nothing left to translate. It is errata for content that should not be present.

**3. Already injected by the host.** The Workflow Registry (1,279) and the Available Skills table (1,919) restate what Claude Code supplies from `.claude/skills/` before the block is read — all four workflows and both model-visible skills, with descriptions.

**4. Advertising capability the agent does not have.** Two rows of the skills table name `kanban_operations` and `worktree-cleanup`, both `invocation: 'no-model'` — deliberately hidden from the model by the mirror manifest. The architecture prose also directs the agent to `kanban_operations` for manual card moves. This is worse than redundant: it invites an agent to claim a capability, then fail.

**5. Unactionable *and false*.** The Available Skills section is 1,943 chars, of which the protocol material is ~996: a 735-char list of 31 protocol names, a 143-char "Usage" line, and a 118-char "Skill Files Location" line. Three faults, escalating:
- **Self-refuting.** The list's own parenthetical says protocols are "not discoverable — delivered by path reference". A bare name list with no descriptions cannot route a choice, and by its own admission is not how protocols arrive. It is a catalogue of things it tells you that you cannot look up.
- **Factually wrong.** Both the "Usage" line and "Skill Files Location" assert protocols live at `.agents/protocols/<name>/SKILL.md`. That is false for `refine_feature`, which is a bare `.agents/protocols/refine_feature.md` — so the block instructs an agent to construct a path that does not exist for one of its 33 entries. This is not bloat; it is a resident instruction that is wrong, which is the one category that cannot be left in place on a size argument alone.
- **Already stale by construction.** The list is a hand-maintained mirror of a directory. It was wrong in six places until corrected earlier in this programme, and `refine_feature` shows the shape claim drifting too.

The architecture diagram is orientation and goes for the ordinary reason.

**6. Restatement.** Execution Rules restates Rule #1 and pre-flight step 3. Pre-flight step 1 ("scan for commands") and step 5 ("otherwise respond normally") are self-evident. Rule #1 itself is enforced by the harness: a slash command arrives already expanded, so an agent cannot fail to follow a workflow it was handed.

**7. Action-local.** Plan Authoring (1,748), Workspace Detection (1,013) and the memo mechanics only matter while the action is underway, by which point a protocol or workflow file is loaded.

**8. Actively harmful.** Pre-flight step 2 — "do not auto-trigger on generic language (review this, delegate this, quick start)" — attaches a do-not-act gloss to three phrases of ordinary English, in a file governing all behaviour, with no scope boundary. Claude Code has its own `/code-review` skill and `Agent` tool. The rule was written when `improve-plan`, `accuracy` and others *were* slash commands and collision was plausible; now all four commands are `/switchboard*`-prefixed and unambiguous. It guards a vanished ambiguity at the cost of suppressing legitimate non-Switchboard work.

### What survives, and why each survives on a different mechanism

Four rules qualify. The useful finding is that each earns its place for a *different* reason, and none of the reasons is "the agent would not otherwise know".

**Persistence — memo capture suppression.** Agents asked to capture memos start discussing the issues instead. This is not a discovery failure: the agent read the workflow at entry and knew the rule. It is drift. The user's next message is a substantive problem, and a coding assistant's entire default disposition is to analyse and act; the instruction is several turns back and loses. A file loaded once at mode entry cannot hold this — resident text can, because it is re-presented every turn. The `[MEMO CAPTURE ACTIVE]` marker compounds it: an agent required to emit it every turn re-asserts the mode to itself every turn.

**Motive-closing — the card-move prohibition.** A bare prohibition invites route-shopping: forbid SQL and the agent reaches for `move-card.js`; forbid moves and it wonders how the card will ever advance, then improvises. Stating that transitions happen automatically removes the incentive rather than blocking one route. **But this rule is role-scoped and does not belong in a role-agnostic file** — leads and the orchestrator legitimately move cards, which is why the current text spends most of its length enumerating exceptions. It relocates to `agentPromptBuilder`'s per-role branches.

**Absence of a completion signal — the import rule.** Agents repeatedly ask how plans reach the board: whether they must import them, whether only committed plans count. This is not covered by any other category — the agent writes a file, has no way to know the job is finished, and invents an action to close the gap: a manual import, an unnecessary commit, or telling the user to do something that is not needed. It sits upstream of the card-move rule, removing the anxiety that sends an agent looking for board operations at all.

The facts are checkable and the common assumption is backwards. `GlobalPlanWatcherService` registers a filesystem watcher over the plans and features directories with no git precondition anywhere, so an untracked file imports exactly like a committed one. And `isGitOpActive` (`PlanIngestionEngine.ts:852`) sets a **15-second suppression window** during git operations — so committing does not trigger import and can briefly *delay* it.

**The rule must not name a path.** The scanned location is user-configurable: `switchboard.planScanner.customSources` accepts globs, absolute or workspace-relative, resolved by `readPlanScannerCustomSourceDirs` (`planIngestionHost.ts:290`) and fed to the engine as `extraRoots` covering both the periodic scan and the watcher. So `.switchboard/plans/` is a default, not the rule. Naming it would be wrong for anyone using custom sources, and it is the same staleness trap as pre-flight step 4's hardcoded `.switchboard/workspace-id` — which is why "the block contains no filesystem path" is already a goal invariant here. The rule is about the *mechanism*: markdown in a designated plans directory becomes a kanban plan by itself.

**Silent-failure prevention — the query-kanban redirect.** Not about discovery: `query-kanban` is `invocation: 'no-user'`, so a general agent already has it listed with a description. The gap is that an agent will hand-roll trivial-looking SQL, and the column labels lie. `DEFAULT_KANBAN_COLUMNS` maps `CREATED`→"New", `PLAN REVIEWED`→"Planned", `CODE REVIEWED`→"Reviewed". A user asks about "Planned"; `WHERE kanban_column = 'Planned'` returns zero rows and the agent reports an empty column. Wrong answer, no error. The clause explaining *why not to improvise* is the load-bearing half.

### Root Cause

Every section was individually justified — each prevents a real mistake. What was never asked is whether a rule needs to be *resident* to prevent it. Content that could arrive at the moment of use was placed in the always-loaded file because that is where the previous rule went. Compounding it, one shared body serves two hosts, so each carries the other's requirements and the preamble exists to paper over the mismatch.

### Non-goals

- Removing capability. Every rule that moves keeps applying; it arrives closer to the work.
- Touching this repo's own dev rules. They live only in this repo's hand-authored `CLAUDE.md`, are absent from `AGENTS.md`, and correctly never reach users.
- Splitting the body per host. Antigravity discovers skills correctly, so the same 652-char body serves both.

## Metadata

**Complexity:** 5
**Tags:** docs, refactor, performance, infrastructure, reliability

## User Review Required

Yes — two decisions.

1. ~~Per-host bodies.~~ **Resolved: not needed.** Antigravity discovers skills correctly, so the Workflow Registry and skills table are redundant on both hosts and both bodies collapse to the same ~530 chars. `buildManagedInner` keeps its single body and its per-host preamble parameter, which is now unused for CLAUDE.md — the preamble had nothing left to translate once the Antigravity-only content went.
2. **Confirm the memo natural-language trigger is still needed.** It exists "for chats without slash commands". If both supported hosts have slash commands, "start memo capture" may be removable from the skill description too — but it is cheap to keep and harmless.

## Complexity Audit

### Routine

- Rewriting the resident body to the three-line form.
- Deleting the preamble, which has nothing left to translate.
- Deleting the sections in categories 1–8 above.

### Complex / Risky

- **`AGENTS.md` is a governance file.** Editing it changes every user's injected block on next sync. Explicit approval required, and the diff should be reviewed as content, not as a refactor.
- **The card-move rule's role set is settled: present for planner, coder, intern, reviewer and tester; absent only for lead and orchestrator.** Those two legitimately move cards — the orchestrator via `move-card.js`/`POST /kanban/move`, a lead when dispatching — which is why the current resident text spends most of its length enumerating exceptions. Getting the set backwards either blocks legitimate dispatch or leaves the original gap.
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
- **Requires** `move-the-docs-site-to-switchboard-dev.md` before the docs pointer can ship. The domain is registered before this reaches users, so the slip contingency an earlier revision described (ship three rules, add the fourth later) is unnecessary — but the ordering still holds: never emit the pointer before the URL serves.
- **Protects** the global-database plan: pre-flight step 4 hardcodes `.switchboard/workspace-id` as the DB-path source, which that plan invalidates. Cutting it removes a silent-staleness coupling between the two.
- **Overlaps `protocols-as-db-rows-not-scaffolded-files.md` on the same ~996 chars, and neither plan said so until now.** That plan's Complex/Risky list requires that "nothing outside the extension may name a protocol by path" and calls for a test asserting no protocol path appears in `CLAUDE.md`. This plan deletes those same lines for a different reason. Consequences of leaving the overlap unstated:
  - If **this** plan ships first, the protocols plan's `CLAUDE.md` assertion is already satisfied — its test is still worth keeping as a regression guard, but it is not the discovery it reads as.
  - If **the protocols plan** ships first, it removes chars this plan still counts, so the 14,826 baseline and the under-800 size gate both go stale and the gate could pass or fail for reasons unrelated to this work.
  - Either way the size gate must be computed from the block as emitted at merge time, not from a number recorded in this plan. Whichever lands second re-measures rather than trusting the figure written here.

## Adversarial Synthesis

**"Every rule exists because an agent got it wrong."** True, and the three that survive are the three where resident text is the mechanism that fixes it. The rest fail for reasons the block cannot address: a rule an agent ignores 3,500 tokens up the context is not more governed than one that arrives with the action. Proximity and persistence are different problems, and most of this block was solving neither.

**"Compliance will get worse."** The opposite is more likely for the survivors. If agents still move cards and still drift out of capture mode with 14,826 chars present, the current text is not working — so "keep it" is not the safe option. One prohibition among three lines is dramatically more salient than one among fourteen sections. And if prominence does not fix it, that is diagnostic: the rule is being disregarded rather than missed, which points at enforcement.

**"3,700 tokens is not much."** Per turn, no. Across every turn of every session in every workspace for every user, it is the single most-multiplied text the product ships — and by this analysis roughly 98% of it cannot act.

**"This is a lot of deletion on one person's reading."** Which is why the categories are stated with evidence rather than judgement: `send_message` has one occurrence in `src/`, the `no-model` rows are in the mirror manifest, the label/ID mismatch is in `DEFAULT_KANBAN_COLUMNS`, and the host-discovery duplication is observable in any Claude Code session's skill list. Each is checkable in under a minute.

## Proposed Changes

1. **The resident body becomes:**

   ```
   - Plans reach the board on their own: a `.md` file written to a designated
     plans directory is imported automatically by a watcher. Committing is
     irrelevant — untracked files import too. Never import a plan yourself.
   - Memo capture mode: while active, append each user message verbatim — do not
     analyse, plan, or write code. Begin every reply with `[MEMO CAPTURE ACTIVE]`.
   - Kanban questions: use the `query-kanban` skill. Displayed column labels differ
     from the stored IDs, so hand-written SQL silently returns nothing.
   - How Switchboard works: the docs are at https://switchboard.dev/docs. If you
     cannot reach them, say so rather than guessing.
   ```

   **The fourth rule earns residency on the same test as the others, by a fifth mechanism: no trigger to attach to.** A user asks how some part of Switchboard works out of nowhere — mid-task, in a fresh session, with no workflow entered and no skill invoked. There is no action underway for a how-to file to arrive with, which is the condition that makes a rule resident rather than delivered. It is structurally the same argument as the `query-kanban` line: not a discovery failure, but the absence of any other channel that could carry it at the moment it is needed.

   Two constraints on it, both easy to get wrong because the line itself is trivial:
   - **It ships only once the URL is live.** `switchboard.dev` does not exist yet — the site is served from `tentacleopera.github.io` with base `/switchboard-site/` (`astro.config.mjs:5-6`). A resident pointer to a 404 is worse than no pointer: the agent fetches, fails, and either reports the product's docs as broken or answers from guesswork. On ~4,000 installs that is a self-inflicted support problem. See `move-the-docs-site-to-switchboard-dev.md`, which is a hard prerequisite.
   - **It must degrade, not assume a fetch.** Many sessions have no network or no fetch tool at all. The "say so rather than guessing" clause is the load-bearing half — without it the line silently converts an unavailable capability into a fabricated answer. Same pattern as `skills-declare-preconditions-and-degrade.md`.

2. **Delete the preamble.** With the Antigravity content gone it translates nothing.
3. **Relocate the card-move rule** into `agentPromptBuilder`'s per-role composition: present for planner, coder, intern, reviewer and tester; absent for lead and orchestrator. Phrased to close the motive — transitions happen automatically — not merely to forbid SQL.
4. **`buildManagedInner` takes a per-host body**, not just a per-host preamble.
5. **Close the "start memo capture" gap** in the `switchboard-memo` skill description, since the registry that documented it is being removed from this host's body.
6. **Regenerate** and confirm the emitted size.

### Migration

None. Regenerated from source on sync.

## Verification Plan

### Goal Invariants

- The emitted `CLAUDE.md` managed block is **under 800 chars** (currently 14,826) — see the size-accounting table in the Goal for the derivation. Assert against the emitted block including markers and header, not the body alone; the two differ by 122 chars and quoting the wrong one is how this plan previously ended up with four conflicting targets.
- The block contains no filesystem path, no reference to `send_message`, `view_file`, `IsArtifact`, `skill: "<name>"`, and no skill or protocol name list.
- No rule removed from the block is absent from the place it moved to.

### Automated Tests

- **Size gate:** assert the emitted block is under the threshold, so it cannot silently regrow. This is the test that stops the next individually-justified addition undoing the cut.
- **No dead references:** grep the emitted block for `send_message`, `view_file`, `IsArtifact`, `// turbo`, `persona adoption`, and any `.agents/` or `.switchboard/` path. All must be absent.
- **No hidden-capability advertising:** assert the block names no skill whose manifest `invocation` is `no-model`.
- **Card-move rule placement:** compose prompts for all seven roles; assert the rule is present for planner, coder, intern, reviewer and tester, and absent for lead and orchestrator.
- **Import rule names no path:** assert the line describes a "designated plans directory" and contains no filesystem path, so it stays true under `switchboard.planScanner.customSources`.
- **Planner default unaffected:** `minimal-prompt.test.js` passes in full — the relocation must not reach the planner's one-line default.
- **Memo suppression survives:** compose a capture-mode turn and assert the suppression and the marker requirement are both present in the resident block.
- **Import rule states the git-independence:** assert the line says committing is irrelevant, not merely that import is automatic. The common wrong assumption is that a commit is required, so the negation is the load-bearing half — and `isGitOpActive`'s 15-second suppression means a commit can actually delay import.
- **Label/ID trap:** assert the `query-kanban` line names the mismatch, not merely the skill. A line that only names the skill does not prevent the failure.
- **Marker integrity:** regenerate over an existing 14,826-char block and assert exactly one clean marker pair remains, exercising `stripProtocolMarkers`.

### CI wiring (verified — easy to miss)

- **`mirror:check` will fail this plan's commit unless `.claude/skills` is regenerated alongside it.** `scripts/check-claude-mirror.js` (CI: `.github/workflows/integration-tests.yml:53`) regenerates `generateClaudeMirror(.agents)` and diffs it against the committed `.claude/skills`, failing on missing, extra **or drifted content**. Because this plan relocates rules into `.agents/` skill and protocol bodies, and `buildSkillMd` copies `parsed.body` and `parsed.description` verbatim, every relocation is a content change the mirror must be regenerated for. Note the narrower true scope: `buildSkillMd` does **not** embed `CLAUDE_PREAMBLE`, so shrinking the preamble alone causes no mirror drift — only edits to `.agents/` sources do.
- **A new contract test does not run until it is added to CI by hand.** There is exactly one workflow (`integration-tests.yml`) and every contract test is individually enumerated in it — no `test:contract:*` sweeper exists in `scripts/`. The size gate above is the whole point of this plan's durability, so it must land as both a `package.json` script and a workflow step; a `package.json` entry alone is a test that never runs.
- `buildSkillMd` emits `disable-model-invocation: true` for `invocation: no-model` (`ClaudeCodeMirrorService.ts:252`), which is the mechanism the no-hidden-capability-advertising test above relies on. Assert against the emitted frontmatter, not the manifest field.

## Outstanding Questions

- **[user]** Does Antigravity self-discover skills and support slash commands? Decides whether the per-host split is needed or both bodies collapse to ~320 chars.
- Do agents still drift out of capture mode once the rule is one of two lines? If so the answer is mechanical, not textual, and this plan does not deliver it.
