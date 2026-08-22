# Generate channel-declaration text in the Connections tab for the user to paste into a cloud agent

## Goal

Add a text generator to the Connections tab that produces a ready-to-paste description of this workspace's routes to Switchboard state. The user copies it and pastes it into their cloud interface's add-skill box. No file emission, no mirroring, no committed artefact.

### Problem Analysis

A cloud agent has no window into the local machine. It cannot read extension settings, cannot see which trackers are configured, and cannot know about channels the user built — a separate git plans repo, a wiki, a Linear or Notion workspace wired to this board. The user knows all of it and has no way to hand it over.

**The transport already exists and is proven.** `tickets.js` builds `AGENT_API_CAPABILITIES` entries from live provider config, renders them with a "Copy prompt" button, and does `navigator.clipboard.writeText(filledPrompt)` — the extension's involvement ends at the clipboard, and the user pastes into whatever agent they like. That is exactly the right shape here, and for the same reason: a copied block is the only channel that crosses from a local extension to a session running elsewhere.

**Generation from live config is the point.** The Connections tab already knows what is configured — which tracker, which board mapping, whether context sync is on. So the text can be produced accurately at the moment the user asks for it, rather than the user writing prose from memory. That removes the authoring burden and most of the inaccuracy.

**But generated-from-config still is not the same as reachable.** In the session that produced this plan, Linear was configured locally and unavailable to the agent — it needed an OAuth flow the session could not run. So even accurate generation must emit *checks with fallbacks*, not an inventory:

> Linear may be reachable via MCP for this board's project. Verify by listing issues; if the call fails or requires authorisation, fall back to the plan files in the repo.

not:

> This board syncs with Linear.

That is the difference between text that degrades gracefully and text that misleads confidently. It is the fifth instance in this codebase of the same hazard — after six stale protocol paths, a pre-flight check naming a DB path a pending plan invalidates, an import rule naming a configurable directory, and a skills table advertising two `no-model` skills.

**Staleness is handled by the transport rather than by machinery.** Because the text is pasted deliberately by the user at a moment they choose, going stale is visible and fixable: regenerate, re-paste. A committed file would age silently. This is the same property that makes the Agent API modal's clipboard prompts safe.

### Root Cause

Channel configuration lives where agents cannot read it, and the only agent-facing description of how to reach state ships with the extension and therefore cannot know anything the user built.

### Non-goals

- Emitting a skill file, mirroring it, or committing it. An earlier draft of this plan proposed exactly that, reusing `AgentSkillExporter` and the mirror's dynamic `.agents/skills/` scan. It works, but it is unnecessary machinery for a clipboard problem and it reintroduces a silently-ageing artefact in the repo.
- Auto-detecting reachability. The extension cannot know whether a future cloud session will authenticate to Linear.
- Resident text in `CLAUDE.md` / `AGENTS.md`.
- Replacing per-skill preconditions. Shipped capabilities declare their own (see the paired plan); this covers only what Switchboard does not ship.

## Metadata

**Complexity:** 3
**Tags:** ui, ux, feature, docs

## User Review Required

Yes — one decision.

**How much does the generator infer versus ask?** Options: (a) generate entirely from config — tracker, board mapping, context-sync state — with no free text; (b) generate that, plus an optional free-text area for channels the extension cannot see (a plans repo, a wiki); (c) free text only. Recommendation: **(b)**. (a) misses the channels that motivate the feature, since a git plans repo is not a Switchboard setting. (c) throws away the accuracy the extension can supply for free. The free-text portion should be a three-field entry — channel, how to verify, fallback — so the output stays check-shaped rather than becoming claims.

## Complexity Audit

### Routine

- A Connections-tab section rendering the generated text with a "Copy" button, modelled on `renderAgentApiModal` in `tickets.js`.
- Composing the text from existing config reads: active tracker, board/project mapping, context-sync state.
- A three-field repeatable entry for user-supplied channels, persisted to the `config` table.

### Complex / Risky

- **The check-and-fallback phrasing is the deliverable.** A free textarea produces claims, because that is how people write. The generated portions must be templated into check form, and the user-supplied portions must be structurally forced into it by the three-field shape. If the output can express "X is available", the plan has failed.
- **Do not template shell commands the agent runs unreviewed.** The verification step should describe what to try, not paste an executable line, since the destination is an arbitrary agent in an unknown environment.
- **Private endpoints on a clipboard.** A generated block may name a private repo, a workspace URL, or a board id. That is fine going to the user's own agent, but the UI should not encourage pasting it anywhere public, and it must never include tokens — `sb_api_call` works because the extension injects credentials host-side, so no secret needs to travel.
- **It must not restate what shipped skills declare.** With the paired plan landed, `query-kanban` states its own database requirement. The generator should scope itself to channels Switchboard does not ship, or an agent gets two sources for one fact.

## Edge-Case & Dependency Audit

**Race conditions**
- None. Generation is a read plus a clipboard write.

**Security**
- No credentials in the output, ever. The generated text describes routes; the extension holds tokens.
- The output is user-controlled text destined for an agent, so keep it descriptive. No directives, no executable templates.

**Side effects**
- None on the local session. The pasted text costs tokens only in the cloud session the user chose to paste it into, which is the correct place for that cost to land.
- Nothing enters the repo, so nothing ages silently and nothing needs gitignoring.

**Migration**
- Additive. Nothing configured means nothing generated.

## Dependencies

- **Reuses** the clipboard-prompt pattern in `tickets.js` (`renderAgentApiModal`, `navigator.clipboard.writeText`). No new transport.
- **Should follow** `skills-declare-preconditions-and-degrade.md`, which handles shipped capabilities and shrinks what the generator must cover.

## Adversarial Synthesis

**"Why not just emit a skill file?"** That was the previous draft and the machinery exists — `AgentSkillExporter` writes user config as a skill, and `ClaudeCodeMirrorService:301` dynamically scans `.agents/skills/` so it reaches `.claude/skills/`. It works, and it is the wrong trade: it puts a silently-ageing artefact in the repo to solve a problem the clipboard solves with no artefact at all. The file also only helps agents that have the clone, whereas a pasted block reaches any agent anywhere.

**"The user will not bother pasting it."** Possibly, and that is a real limit — this only helps sessions where the user chose to hand over context. But the alternative designs help nobody: a committed file reaches only clone-holders, and a manifest requires the extension to have run. Deliberate handover is the honest ceiling for a local-to-remote channel.

**"Generated text will go stale."** It will, and visibly: the user pasted it, so the user knows to regenerate. That is strictly better than a committed file whose age nobody notices, which is the failure mode this codebase has hit four times already.

## Proposed Changes

1. **Connections-tab generator section** — renders the composed text with a Copy button, modelled on `renderAgentApiModal` in `tickets.js`.
2. **Compose from live config**: active tracker, board/project mapping, context-sync state — each rendered as a check with a fallback, never as an assertion.
3. **Three-field entries** (channel, how to verify, fallback) for channels the extension cannot see, persisted to the `config` table.
4. **Scope the output** to channels Switchboard does not ship, so it does not duplicate per-skill preconditions.
5. **Never include credentials**, and do not template executable commands.

### Migration

None.

## Verification Plan

### Goal Invariants

- The generated text contains no credential, token, or API key.
- Every entry in the output contains a verification step and a fallback; no entry asserts availability.
- Nothing is written to the repository — the feature's only output is a clipboard payload.

### Automated Tests

- **No secrets:** compose the text with a tracker configured and a token present; assert the output contains neither the token nor any `switchboard.apiToken` value.
- **Check-shape:** assert every generated and user-supplied entry contains a verification clause and a fallback clause. A generator run that can produce a bare assertion fails.
- **No repo writes:** assert the feature creates no file under `.agents/`, `.switchboard/`, or `.claude/`.
- **Empty means empty:** with no tracker configured and no user entries, assert the section offers nothing to copy rather than an empty template.
- **No duplication:** assert the output names no capability that a shipped skill already declares a precondition for.
- **Clipboard path:** assert the Copy button writes the composed text and gives feedback, matching the Agent API modal's behaviour.
- **Paste usability:** take a generated block into a bare clone with no extension and no tracker auth, and assert an agent following a failing check reaches the stated fallback rather than reporting a fault.

## Outstanding Questions

- **[user]** Does the cloud interface's add-skill box impose a size or format constraint the generator should respect?
- Should the generator offer a shorter variant for pasting into a single prompt rather than an add-skill slot? The two destinations have different length tolerances.
