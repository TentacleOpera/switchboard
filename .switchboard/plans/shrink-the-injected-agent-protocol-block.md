# Cut the protocol block injected into every user's CLAUDE.md and AGENTS.md by roughly half

## Goal

Reduce the ~3,537 tokens Switchboard writes into every user's `CLAUDE.md` and `AGENTS.md` to roughly 1,400, by moving action-specific reference material into the protocols and workflows that already load at the moment it is needed, and by cutting guidance that guards against a recoverable mistake.

### Problem Analysis

`ClaudeCodeMirrorService.buildManagedInner(sourceContent, preamble)` writes the entire `AGENTS.md` body into a managed block in the user's files — verbatim into `AGENTS.md`, and with a 678-char host-translation preamble into `CLAUDE.md`. Measured payload: **14,148 chars, ~3,537 tokens**, resident on every turn of every session in every Switchboard workspace, inside a file the user also writes their own instructions in.

Broken down by section (measured on `AGENTS.md`, the actual injected source):

| Section | Chars | Needed resident? |
| :--- | ---: | :--- |
| 📌 Plan Project Pinning | 2,785 | **No** — deleted outright by the sticky-project plan |
| 📚 Available Skills | 1,919 | Partly — see host-duplication note |
| 📝 Plan Authoring & Problem Analysis Protocol | 1,748 | No — only while authoring a plan |
| Workflow Registry | 1,279 | **Yes** — routing |
| 🏗️ Switchboard Global Architecture | 1,182 | No — orientation diagram, not routing |
| 📌 Memo Capture Mode — Priority Rule | 1,122 | No — only inside memo capture |
| 📂 Workspace Detection for Plan Creation | 1,013 | No — only while authoring a plan |
| ⚠️ MANDATORY PRE-FLIGHT CHECK | 913 | **Yes** — routing discipline |
| 🚨 STRICT PROTOCOL ENFORCEMENT | 804 | **Yes** — the framing the registry depends on |
| Execution Rules | 593 | **Yes** — routing |
| Code-Level Enforcement | 341 | **Yes** — small, and it is a hard constraint |

**The distinction that matters is resident-routing versus action-reference.** A block injected into a user's instruction file has to be resident because the agent cannot know whether the *next* message triggers a workflow. That argument applies to the registry, the pre-flight check, and the execution rules. It does not apply to anything that only matters *while* an action is underway, because at that moment a protocol or workflow file is already being read.

Four sections are action-reference: plan authoring, workspace detection, memo-capture priority, and project pinning. Each has a natural home. Plan authoring and workspace detection belong in `improve-plan` (already read by the planner) and in the cloud and remote workflows (already read on entry). Memo-capture priority belongs in `switchboard-memo.md`, which is by definition open when capture mode is active.

**Project pinning is the largest section in the file, and the responsibility it documents should not be the agent's at all.** 2,785 chars — a fifth of the entire payload — instruct an agent on how to transcribe board state into a plan file, where the extension already read that state at prompt-generation time and reads the same config key again as the importer's fallback (`_resolveProjectForInsert` precedence #2, `KanbanDatabase.ts:2242`). A board-level sticky-project toggle removes the transport step and the rules that guard it; see `replace-agent-project-pinning-with-a-sticky-ui-setting.md`. Nothing needs relocating, because nothing needs saying.

**A duplication worth confirming: the Available Skills table may already be provided by the host.** Claude Code discovers `.claude/skills/*/SKILL.md` and injects each skill's name and description itself — an agent in this repo receives `manage-features` and `query-kanban` in its skill list without reading `AGENTS.md` at all. If Antigravity does not self-discover, the table is load-bearing there and redundant here. Because both hosts receive the same body, each currently carries the other's requirements.

### Root Cause

The protocol block grew by accretion, and every addition was individually justified — each rule prevents a real mistake. What was never asked is whether a rule needs to be *resident* to prevent it. Content that could arrive at the moment of use was placed in the always-loaded file because that is where the previous rule went.

### Non-goals

- Reducing capability. Every rule that moves keeps applying; it arrives later rather than never.
- Changing the marker mechanism or the managed-block upsert. `buildManagedInner` and the `<!-- switchboard:claude-protocol:start/end -->` wrap stay as they are.
- Splitting the shared body into per-host variants. Recorded as a follow-up, since it would cut further but changes the mirror's contract.
- Touching this repo's own dev rules ("NEVER add confirmation dialogs", Build, Users & migrations). Those live only in this repo's hand-authored `CLAUDE.md`, are absent from `AGENTS.md`, and correctly never reach users.

## Metadata

**Complexity:** 5
**Tags:** docs, refactor, performance, infrastructure

## User Review Required

Yes — two decisions.

1. ~~How far to cut project pinning.~~ **Resolved: the whole section goes.** `replace-agent-project-pinning-with-a-sticky-ui-setting.md` removes the PROJECT PIN directive entirely in favour of a board-level sticky-project toggle, so there is no directive left for a residual line to reference. All 2,785 chars are deleted rather than reduced. This plan should land after or alongside that one.
2. **Whether the Available Skills table can go.** It appears redundant for Claude Code, which self-discovers. Needs confirming against Antigravity before removing, and if it is needed there, that is the strongest argument for the per-host split recorded as a follow-up.

## Complexity Audit

### Routine

- Cutting Plan Project Pinning to a single line.
- Moving the Memo Capture priority rule into `.agents/workflows/switchboard-memo.md`, which already documents the full protocol.
- Deleting the Switchboard Global Architecture diagram from the injected block (it is orientation, and `ARCHITECTURE.md` covers the same ground for anyone who wants it).
- Leaving a one-line pointer in place of each moved section.

### Complex / Risky

- **Plan authoring and workspace detection have more than one consumer.** The planner reads `improve-plan`, but plans are also authored by `/switchboard-cloud` (this repo's own cloud sessions), by the remote flow via tracker docs, and by memo processing. Moving the rules into `improve-plan` alone would silently drop them from three paths. Each destination must be enumerated before anything is removed from the resident block, and the tracker-synced context is one of them — which ties this to the outward context sync in the protocols plan.
- **`AGENTS.md` is a governance file, and editing it changes every user's injected block on next sync.** It needs explicit approval, and the diff should be reviewed as content rather than as a refactor.
- **A pointer that names a file an agent cannot reach is worse than the text it replaced.** "See `improve-plan/SKILL.md` for pinning rules" is useless to a remote agent with no repo. Pointers must name a destination reachable from the context where the rule applies, which for remote means the tracker-synced context document.
- **The 55% figure assumes all four sections move cleanly.** If plan authoring has to stay resident because too many paths need it, the achievable cut is closer to 35%. Measure after the consumer enumeration, not before.

## Edge-Case & Dependency Audit

**Race conditions**
- None. Content relocation.

**Security**
- None. Note that shrinking the resident block slightly reduces the surface for prompt-injection via a compromised `AGENTS.md`, but that is incidental.

**Side effects**
- Users who have hand-edited inside the managed markers will see their edits replaced on next sync — that is existing behaviour, but a larger-than-usual diff makes it more visible. Worth a release note.
- `SparkContextExporter.ts:201` restates the required-section list independently ("Required sections, in order: `## Goal`, `## Metadata`…"). If the schema moves, that exporter is a second copy that will drift.
- `TaskViewerProvider.ts:6538` also restates the plan format inline. Same drift risk.
- Reducing the resident block reduces per-turn token cost for every user on every turn — the benefit is small per turn and large in aggregate.

**Migration**
- The managed block is regenerated from `AGENTS.md` on every sync, so no user-data migration. Existing blocks are replaced by the shorter one automatically.
- Nothing is deleted from the repo: moved content lands in a protocol or workflow file.

## Dependencies

- **Requires** `replace-agent-project-pinning-with-a-sticky-ui-setting.md` for the largest single reduction (2,785 chars). That plan can ship independently; this one's size gate assumes it has.
- **Interacts with** the protocols-as-rows plan: the tracker-synced context document is one of the destinations for relocated plan-authoring rules, and that plan is what establishes the sync as a delivery tier.
- **Independent of** the storage programme otherwise. Can ship on its own.

## Adversarial Synthesis

**"Every one of these rules exists because an agent got it wrong."** True, and none is being deleted except the bulk of project pinning — where the mistake is recoverable by reassignment and the importer already refuses bad pins. The rest arrive at the moment of use instead of being resident, which is strictly better for compliance too: a rule read immediately before the action it governs is more likely to be followed than one read 40 turns earlier.

**"Moving rules into protocol files means agents that skip the protocol skip the rules."** The real risk, and the reason the consumer enumeration is a gate rather than a step. But note the resident block already fails this way: an agent that ignores a rule 3,500 tokens up the context is not meaningfully more governed than one that never loaded it. Proximity to the action is the more reliable mechanism.

**"3,500 tokens is not much."** Per turn, no. Across every turn of every session in every workspace for every user, it is the single most-multiplied text Switchboard ships. And roughly half of it is being carried for actions that are not currently happening.

**"Just tell users to trim it themselves."** They cannot — it is inside managed markers and regenerated on every sync. The only party who can shrink it is Switchboard.

## Proposed Changes

1. **`AGENTS.md`: Plan Project Pinning deleted in full** — owned by `replace-agent-project-pinning-with-a-sticky-ui-setting.md`, which removes the directive the section exists to explain. Nothing relocates; the responsibility leaves the agent entirely.
2. **Memo Capture priority rule → `.agents/workflows/switchboard-memo.md`**, replaced by one line in the registry noting that capture mode overrides default behaviour while active.
3. **Plan Authoring & Problem Analysis + Workspace Detection → `improve-plan/SKILL.md`**, plus every other plan-authoring entry point enumerated first (`switchboard-cloud.md`, the remote flow's tracker context, memo processing).
4. **Switchboard Global Architecture diagram removed** from the injected block; `ARCHITECTURE.md` retains it.
5. **Available Skills table**: confirm host self-discovery on Antigravity; remove if redundant, otherwise keep and note it as the case for a per-host split.
6. **Regenerate** the managed block and confirm the emitted size.

### Migration

None. The block is regenerated from `AGENTS.md` on sync; shorter output replaces longer automatically.

## Verification Plan

### Goal Invariants

- The managed block emitted by `buildManagedInner` is **under 6,000 chars** (currently 14,148), and the `CLAUDE.md` variant under 6,700 including the preamble.
- Every rule removed from the resident block is present in at least one file that is loaded before the action it governs, for **every** enumerated entry point — not just one.
- No pointer in the resident block names a path unreachable from a context where that rule applies.

### Automated Tests

- **Size gate:** assert the emitted managed block is under the threshold, so the block cannot silently regrow. This is the test that keeps the reduction from being undone by the next individually-justified addition.
- **Coverage:** for each relocated rule, assert it appears in every enumerated authoring path — `improve-plan`, `switchboard-cloud.md`, the tracker-synced context template, memo processing.
- **No dangling pointers:** assert every path named in the resident block resolves in a bare clone.
- **Marker integrity:** regenerate over an existing longer block and assert exactly one clean marker pair remains, exercising `stripProtocolMarkers`.
- **Plan authoring still works:** author a plan via `/switchboard-cloud` and via the planner path; assert both produce the required sections and a correct project pin from a directive.
- **Duplicate schema copies:** assert `SparkContextExporter.ts:201` and `TaskViewerProvider.ts:6538` either reference the single source or are updated in lockstep — they are independent restatements today.

## Outstanding Questions

- **[user]** Does Antigravity self-discover skills, or does it need the Available Skills table? Determines whether ~1,900 chars can go, and whether the per-host split is worth doing.
- How many distinct plan-authoring entry points exist? The consumer enumeration is the gate on the largest relocation, and the honest answer is that I have identified four and am not confident that is all of them.
- Should the resident block carry a version or size stamp so growth is visible in review rather than only in a test?
