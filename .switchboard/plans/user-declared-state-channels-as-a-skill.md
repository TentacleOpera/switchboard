# Let the user declare their own state channels, emitted as a discoverable skill

## Goal

Give the user a place to describe the routes to Switchboard state that only they know about — a separate git plans repo, a wiki, a tracker they have wired up — and emit it as a skill any agent discovers. Phrased as checks to run, never as an inventory of what exists.

### Problem Analysis

Shipped skills can declare their own preconditions (see `skills-declare-preconditions-and-degrade.md`). What no shipped skill can know is the channels a particular user has built: plans committed to a dedicated repo, a wiki holding board state, a Linear or Notion workspace wired to this board, a synced project-context document. An agent with a clone and nothing else has no way to learn any of that exists.

**Both halves of the mechanism already exist and need no building.**

`AgentSkillExporter.exportCustomAgent(agent, resolvedRoot)` already takes user-authored configuration and writes it as a skill file under `.agents/skills/`, called from `TaskViewerProvider.ts:12744` on creation and `removeExportedSkill` on delete. So "user configures something in the UI, it becomes a skill" is a shipped pattern.

And `ClaudeCodeMirrorService` does not only walk its static `MIRROR_MANIFEST` — at line 301 it *"Dynamically scan[s] for generated agent skills under `.agents/skills/`"* with a `readdirSync` at 305, so anything the exporter writes is forwarded to `.claude/skills/` and discovered by Claude Code. Verified against the live tree: `.claude/skills/` holds all eight mirrored entries.

So this plan is an authoring surface plus content rules, not new plumbing.

**The content rule is the whole risk, and there is direct evidence for it.** In the session that produced this plan, Linear MCP was configured and unavailable — it required an OAuth flow the session could not run. A note asserting "you have Linear MCP" would have sent the agent down a dead path with confidence. Every entry must therefore be a *check with a fallback*, not a claim:

> Plans may also live in `<repo>`. Verify with `<command>`. If unavailable, fall back to the local plans directory.

rather than:

> Plans live in `<repo>`.

This is the same defect this codebase has already been bitten by four times: a hardcoded fact in agent-facing text that drifts. Six stale `.switchboard/protocols/` paths, a pre-flight check naming a DB path that a pending plan invalidates, an import rule naming a configurable directory, and a skills table advertising two `no-model` skills. A user-authored channels note is the fifth opportunity, and the only defence is the phrasing.

### Root Cause

Channel configuration lives in the extension's settings, where agents cannot read it, and the only agent-facing description of how to reach state is a shipped block that by definition cannot know about anything the user built.

### Non-goals

- Auto-detecting channels. A generated manifest only exists if the extension ran, which fails in exactly the cloud case that motivates this, and is stale the moment auth expires.
- A discovery phase. Covered as a non-goal in the paired plan; discovery belongs at point of use.
- Resident text in `CLAUDE.md` / `AGENTS.md`. This is a skill, discovered when relevant.
- Validating the user's claims. The extension cannot check whether their wiki is reachable from a future cloud session.

## Metadata

**Complexity:** 4
**Tags:** ui, ux, feature, docs, infrastructure

## User Review Required

Yes — two decisions.

1. **Is a second channel configuration actually in use?** The system's author currently runs one channel — a clone — with Linear configured but unauthed. If no user runs multiple channels yet, this is speculative and `skills-declare-preconditions-and-degrade.md` delivers most of the value alone. Recommendation: ship the paired plan first, and this when a second configuration exists. Building an authoring surface nobody fills is worse than not having one, because an empty skill still occupies a slot in every agent's skill list.
2. **Authoring surface placement.** Connections tab (where channels are configured) or Setup? Recommendation: Connections — it is where a user thinks about routes to state, and `ConnectionsPanelProvider` is a thin forwarder so the verb lands in Setup or Planning anyway.

## Complexity Audit

### Routine

- A textarea in the Connections tab, persisted to the `config` table.
- Emitting it via the existing `AgentSkillExporter` write path.
- Deleting the emitted file when the content is cleared, mirroring `removeExportedSkill`.

### Complex / Risky

- **An empty or stale skill is worse than none.** It occupies a slot in every agent's discovered skill list, costing description tokens on every session, and a stale entry actively misleads. Emit nothing when the content is empty, and give the file a `Last updated` stamp so an agent can weigh it — the same staleness header the tracker-synced project context already carries.
- **The phrasing rule cannot be enforced, only prompted.** A user will write "plans are in the platform repo" because that is how people write. The authoring UI has to lead them into check-and-fallback form — a template with the three fields pre-labelled (channel, how to verify, fallback) rather than a free textarea. A free textarea will produce claims.
- **Untrusted content becoming agent instructions.** This is user-authored text emitted into a file agents read as guidance. It is the user's own machine and their own words, so the risk is low, but it must be inert prose — a channel description, never a directive an agent executes. Do not template shell commands the agent will run unreviewed.
- **It must not duplicate what shipped skills now declare.** With the paired plan landed, `query-kanban` states its own database requirement. If a user also writes "the kanban DB is at …", there are two sources. The template should scope itself to channels Switchboard does not ship.

## Edge-Case & Dependency Audit

**Race conditions**
- Editing while a sync regenerates the mirror: the exporter writes then the mirror scans, so a partial write could be mirrored. Write to a temp file and rename, matching the atomicity used elsewhere.

**Security**
- User-authored content in an agent-read file. Keep it descriptive; no executable templates.
- If a channel description names a private endpoint or repo, it is now in a file that may be committed. `.agents/skills/` is currently tracked, so the emitted file would be too — worth defaulting it to ignored, or warning at authoring time.

**Side effects**
- Adds one entry to every agent's discovered skill list in that workspace, with its description injected per session. Keep the description to one clause.
- The paired plan's precondition work reduces how much this needs to say.

**Migration**
- Additive. Absent content means no emitted file and no behaviour change.

## Dependencies

- **Reuses** `AgentSkillExporter`'s write path and `ClaudeCodeMirrorService`'s dynamic `.agents/skills/` scan (line 301). Neither needs extending.
- **Should follow** `skills-declare-preconditions-and-degrade.md`, which handles shipped capabilities and shrinks what this must cover.

## Adversarial Synthesis

**"The user already knows their setup — why tell the agent?"** Because the agent is the one that has to work in it, and in a cloud session it has no window into extension settings. The asymmetry is the whole problem: the user knows and cannot act, the agent can act and does not know.

**"This will rot like everything else."** Almost certainly, which is why the phrasing is the deliverable rather than the textarea. A note written as checks degrades gracefully — a check that fails routes the agent to the fallback. A note written as claims degrades into confident wrongness. Four instances of the latter have already been found in this codebase's agent-facing text.

**"Ship it and see."** The counter is the empty-skill cost: an unfilled entry is not neutral, it consumes description tokens in every session in that workspace and implies a capability that is not there. Better to wait for a real second configuration, which is why decision (1) exists.

## Proposed Changes

1. **Connections-tab authoring surface** — a repeatable three-field entry (channel, how to verify, fallback when unavailable) rather than a free textarea, so the output is check-shaped by construction.
2. **Persist to the `config` table**, per workspace.
3. **Emit via `AgentSkillExporter`'s existing write path** to `.agents/skills/`, atomically, with a `Last updated` stamp. Emit nothing when empty; delete on clear.
4. **Rely on the existing dynamic mirror scan** (`ClaudeCodeMirrorService.ts:301`) to reach `.claude/skills/`. No manifest change.
5. **Scope the template** to channels Switchboard does not ship, so it does not restate what shipped skills declare.
6. **Default the emitted file to gitignored**, or warn if a channel description looks like a private endpoint.

### Migration

None. Additive; no content means no file.

## Verification Plan

### Goal Invariants

- With no channels declared, no skill file is emitted and no entry appears in any agent's skill list.
- Every emitted entry contains a verification step and a fallback; none is a bare claim.
- The emitted file contains no executable template an agent would run unreviewed.

### Automated Tests

- **Empty means absent:** clear the content; assert the file is deleted and the mirror drops it from `.claude/skills/`.
- **Mirror reach:** declare a channel; assert the emitted file appears in `.agents/skills/` **and** is mirrored to `.claude/skills/` by the dynamic scan, without touching `MIRROR_MANIFEST`.
- **Check-shape enforcement:** assert an entry cannot be saved without a verification step and a fallback.
- **Staleness stamp:** assert every emitted file carries a `Last updated` date.
- **Atomicity:** write during a mirror scan 50 times; assert the mirrored file is never partial.
- **No duplication:** assert the template's guidance excludes channels shipped skills already declare.
- **Cloud reachability:** in a bare clone with the emitted file committed, assert an agent discovers it and follows a failing check to its stated fallback rather than reporting a fault.

## Outstanding Questions

- **[user]** Does any user, including you, currently run more than one state channel? If not, this is speculative and the paired plan should ship alone. Proceeding on the assumption that it should be written now and scheduled later.
- Should the emitted file be committed or ignored by default? Committed makes it available to cloud agents from the clone — which is the main use case — but puts channel descriptions in git.
