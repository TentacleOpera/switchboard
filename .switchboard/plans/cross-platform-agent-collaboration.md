# Cross-platform agent collaboration (exploratory — phase 2 on content-pull)

## Goal

Explore and specify making Switchboard a coordination substrate where AI agents on **different platforms** (Linear, Notion, ClickUp, Claude Desktop, CLIs) collaborate on the **same plan** through the board — each driving a different column/role — with the board as the shared blackboard.

### Problem Analysis (why this is now within reach)

Switchboard is already structurally a **blackboard**: agents coordinate through shared artifacts, not direct messaging. Most of the substrate exists — an open roster (any agent), **file-based completion** (host-agnostic "done"), a **two-way comment bus**, and **columns that already encode a handoff protocol** (Planned → Coding → Review) with per-column role dispatch. The one missing piece was a shared, mutable *spec*: plan content only flowed outward. The **remote-content-pull-all-providers** plan closes that gap. Once the plan body syncs bidirectionally across providers, agents on different platforms can collaborate on one plan through the board with no direct integration between them — the elegant form being *"each column/role is driven by an agent on a different platform, and column transitions are the handoffs."*

This is cross-**vendor** collaboration no single platform will ever build (their incentive is to keep you in their garden), which makes it structurally defensible — a moat made of competitors' incentives.

## Metadata

**Tags:** backend, api, feature, docs
**Complexity:** 7

## User Review Required

This is an exploratory/design plan. Approve the direction **and** the following coordination-model decisions before any implementation:

1. **Conflict strategy for the prototype** — `turn-token` vs. `lock`. (Recommendation: turn-token — see Adversarial Synthesis and Proposed Changes.)
2. **Coordination surface** — columns-as-handoff with a per-column `ownerPlatform` pin vs. an explicit per-role assignment field on the plan. (Recommendation: columns-as-handoff + pin; see Proposed Changes.)
3. **Attribution audit surface** — extend `SessionActionLog` vs. a new `plan_activity_log` table. (Recommendation: extend `SessionActionLog`.)
4. **Demo scope** — Linear+Notion as the collaborating pair (both have a comment bus). Linear is the primary integration target (mature AgentSession, rich webhooks, 5k req/hr); Notion is via **standard internal integration** (the External Agents API is private-beta — do not build against it for the demo). ClickUp is content/state-only with no named-agent surface — excluded from the demo. Confirm this scoping.

## The real problem: coordination, not plumbing

Emergent collaboration (implicit, through the shared plan + columns + comments) is nearly free once content-pull ships, and works when agents take turns naturally. Turning it into a deliberate feature needs coordination primitives:

- **Turn-taking / soft locks** so two agents don't edit one plan simultaneously. This is exactly where content-pull's deferred "conflicts are rare, last-write-wins" model breaks: with concurrent collaborators, conflicts become the *normal* case, not the exception. The conflict model must be **pluggable** — last-write-wins today, lock/turn-token for collaboration.
- **Attribution / provenance** — which platform/agent made each change. Partly present already (comment `authoredBySelf` at `RemoteControlService.ts:31,546-549`, plan `sourceType` at `:366`); needs extending to state and content changes. **Clarification:** `authoredBySelf` is a boolean (bot-or-not) and `sourceType` is a creation-origin string (`linear-import`, `linear-automation`) — neither carries "which agent on which platform made this *state* change." State changes (column moves) route through `KanbanProvider` dispatch (`_columnToRole` / `roleForColumn` at `KanbanProvider.ts:6700-6743`) and are not stamped with an external actor today. Extending attribution to state changes is therefore a **new audit surface**, not an extension of an existing field — see Proposed Changes.
- **Handoff semantics** — formalize "column = whose turn / which role acts", allowing a column to be owned by a specific platform's agent.
- **Presence** (conditional, not unconditionally optional) — which agents are active on a plan right now. **Clarification:** presence is *optional only if the conflict strategy is turn-token* (turn-tokens are self-pacing and degrade to last-write-wins on timeout). A *lock* strategy requires presence + liveness to detect dead lock-holders — so "optional presence" is conditional on the conflict choice, not a free default.

## Complexity Audit

### Routine
- Reuse of the existing two-way comment bus (`RemoteControlService._pollComments`) for the conversation half of collaboration — no new transport.
- Reuse of file-based completion (plan-file mtime advance) as the host-agnostic "done" signal — already cross-platform.
- Reuse of the existing column→role dispatch (`KanbanProvider._columnToRole`, `roleForColumn` at `KanbanProvider.ts:6700-6743`) as the backward-compatible fallback when no per-column platform pin is set.
- Extending `SessionActionLog` (`src/services/SessionActionLog.ts`) with a `platform` / `agentId` stamp on state-change entries — additive column, no schema rewrite.

### Complex / Risky
- **Pluggable conflict resolver — second implementation.** The dependency plan ships the seam (`ContentConflictResolver` + `LastWriteWinsResolver`). This plan must add a **second** implementation (`TurnTokenResolver` or `LockResolver`) and exercise it — without it, "pluggable" is an interface with one stub and the collaboration behavior is unvalidated.
- **Per-column `ownerPlatform` pin** — new metadata on kanban column config; must fall back to role-based dispatch when unset (backward compat) and must survive column reorder/rename. Touches column-config persistence + the dispatch path in `KanbanProvider`.
- **Turn-token lifecycle** — acquiring, releasing, and *timing out* a token across platforms where there is no shared clock and no reliable presence. Timeout/expire semantics must degrade safely to last-write-wins.
- **Attribution for state changes** — column moves today go through `KanbanProvider` dispatch with no external-actor stamp; threading `platform`/`agentId` through the dispatch + remote-state-apply paths is a multi-file change.
- **Demo with a deliberate concurrent-edit case** — orchestrating two agents to write inside the same poll window is a test-harness problem, not a feature.
- **ClickUp asymmetry** — ClickUp has no comment bus; collaboration there is state/content-only. The design must not assume the conversation half exists on every provider.

## Edge-Case & Dependency Audit

- **Race Conditions**
  - Two agents edit the plan body inside the same poll window — the *normal* case under collaboration, not the exception. The chosen conflict strategy must resolve it deterministically (turn-token: the non-holder's write is deferred/rejected; lock: the non-holder blocks or fails).
  - Turn-token timeout vs. in-flight write: if the token expires while the holder is mid-write, a second agent may start writing against a stale base. Mitigation: token release is a write barrier — the holder must complete + push before releasing; on timeout, the next holder pulls before writing.
  - Column-move race: agent A moves the card to "Review" (its handoff) while agent B (the planner) is still writing the spec. The handoff must not fire until the spec write is reconciled — column transitions must be gated on a quiescent plan body.
- **Security**
  - A malicious or buggy remote agent could hold a turn-token indefinitely (DoS on the plan). Mitigation: mandatory token timeout with a bounded max, plus an admin force-release.
  - Attribution stamps are asserted by the originating platform — a compromised agent could spoof `agentId`. Out of scope for this plan (trust the provider's identity), but flag it.
- **Side Effects**
  - Adding a per-column `ownerPlatform` pin changes column-config schema; existing boards must migrate cleanly (default = unset = role-based dispatch).
  - Extending `SessionActionLog` changes a shared log shape; readers (oversight, archive) must tolerate the new fields.
  - A turn-token resolver that defers writes must not silently drop them — deferred writes need a durable queue or an explicit rejection back to the agent.
- **Dependencies & Conflicts**
  - **Hard dependency on `remote-content-pull-all-providers`** — the bidirectional plan body is the prerequisite. This plan is explicitly phase 2; do not start until the dependency's `ContentConflictResolver` seam + `LastWriteWinsResolver` have shipped.
  - The conflict seam designed in the dependency plan must accept a second resolver without modification — if the seam needs changes to support turn-token, that is a scope expansion of the dependency plan, not this one. Confirm the seam's `shouldPull(...)` signature can carry turn-token state (current holder, acquired-at) before committing.
  - Rate limits multiply with more active agents/providers — reuse the per-provider pacing already in `RemoteControlService`.
  - ClickUp lacks the comment bus — collaboration there is state/content-only, no conversation. Scope the prototype demo to Linear+Notion.

## Dependencies

- `remote-content-pull-all-providers` — hard dependency; shared bidirectional plan body is the prerequisite. This plan is explicitly phase 2.
- The dependency plan's `ContentConflictResolver` seam + `LastWriteWinsResolver` implementation must be landed before this plan's second resolver work begins.

## Uncertain Assumptions

Research completed (2026-07-19). Findings below; the "Prior art & integration targets" section is updated to reflect them.

- **Notion Developer Platform — External Agents API**: CONFIRMED exists, announced May 13, 2026 — but **Private Beta (waitlist)** as of mid-2026. Notion Workers + `ntn` CLI are Public Beta; the External Agents API and Agent SDK are gated. Webhook-triggered, REST + native MCP, per-resource permissions, two hosting paths (Notion Workers / vendor cloud). `created_by` and `last_edited_by` are returned **directly on page and database-query objects** (Partial User with UUID) — no extra call. This validates the dependency plan's Notion echo-guard approach. **Blocker:** 3 req/s per integration token is severe for multi-agent; webhooks are signal-only (force a follow-up GET), doubling cost per event.
- **Linear agent SDK / AgentSession**: CONFIRMED mature and production-ready. OAuth `actor=app` installs the agent as a standalone workspace member; `app:assignable` + `app:mentionable` scopes; agents are **delegates** (not assignees), preserving human ownership. Webhook-driven (Agent Session Events category), 5s response SLA, 10s initial-activity SLA. Payloads carry XML `promptContext` + `guidance` + `previousComments` — rich context, no extra fetch needed. 5,000 req/hour per token. **Linear is the safest first integration target.**
- **ClickUp agent-participant model**: CONFIRMED ABSENT — no public developer-facing external-agent API. Native "Super Agents" (ClickUp Brain) and closed App Center partners (e.g. Cursor) exist; third parties must use standard OAuth/API tokens acting as a system bot, with no named-participant surface. The ClickUp MCP Server is available for read/query by external models.
- **ClickUp `markdownDescription` round-trip fidelity**: CONFIRMED BUG — ClickUp parses markdown into an internal Lexical rich-text schema on write and **injects duplicate vertical paragraph spacing** between headings/text and lists/text on API writes (not reproducible in the UI editor). Read-back returns normalized output. Byte-identical round-trip is impossible. This validates the dependency plan's ClickUp cursor-advance-on-push mitigation and confirms the byte-guard echo check is unreliable for ClickUp.

**Net impact on this plan:**
- The provider-agnostic coordination-model design is unaffected — proceed.
- **Demo scoping tightened:** Linear is the primary integration target (mature, rich webhook context, generous rate limits). Notion is viable for a *prototype* using standard internal integrations but the External Agents API is private-beta — **do not ship a Notion-external-agent integration publicly without partnership access**, and budget for the 3 req/s bottleneck. ClickUp is **content/state-only and has no named-agent surface** — treat as a second-class collaborator via standard OAuth, not as a first-class platform agent.
- The "Switchboard-as-external-agent" integration target is **Linear-first**; the Notion version is blocked on External Agents API GA + rate-limit relief.

## Adversarial Synthesis

Key risks: (1) the conflict strategy is left as multiple-choice — the prototype must commit to **turn-token** (self-pacing, no presence/liveness dependency, degrades safely to last-write-wins on timeout) over **lock** (which requires presence and dead-lock-holder detection); (2) the DoD's "validated demo" can pass without a deliberate concurrent-edit case — the demo **must** include a forced collision inside one poll window, else the resolver is untested scaffolding; (3) "columns-as-handoff" is a hypothesis, not a designed mechanism — the per-column `ownerPlatform` pin and its backward-compat fallback must be specified, not assumed. Mitigations: commit to turn-token, mandate the collision case in the DoD, scope the demo to Linear+Notion (comment-bus pair) and treat ClickUp as content/state-only, and flag the Notion External Agents API as a research assumption rather than a concrete integration target.

## Proposed exploration

1. **Prototype "different platforms own different columns" (Linear+Notion).** A Linear agent (AgentSession, `actor=app`) owns Planning (deepens the spec → content-pull brings it local), the local CLI owns Coding, a Notion reviewer owns Review (comment bus carries feedback, via standard internal integration — **not** the private-beta External Agents API). Verify the round-trip end to end. **Mandatory: include a deliberate concurrent-edit case** — both the Linear planner and the local CLI write to the plan body inside the same poll window — to exercise the turn-token resolver. A demo that never collides proves nothing. Budget for Notion's 3 req/s per-token limit — use a single integration token and pace the demo accordingly.
2. **Implement the second conflict resolver: `TurnTokenResolver`.** The dependency plan ships the `ContentConflictResolver` seam + `LastWriteWinsResolver`. This plan adds `TurnTokenResolver` (acquire / release / timeout-expire) and injects it for the collaboration demo. Confirm the seam's `shouldPull(...)` signature can carry turn state (current holder, acquired-at) before implementing — if not, that is a scope expansion of the dependency plan.
3. **Design the per-column `ownerPlatform` pin.** Add an optional `ownerPlatform` (and optional `ownerAgentId`) to kanban column config. Dispatch falls back to role-based `_columnToRole` when the pin is unset (backward compat). Specify behavior on column reorder/rename (pin travels with the column) and on platform disconnect (pin remains, dispatch degrades).
4. **Implement attribution for state changes.** Stamp column moves and content pulls with `platform` + `agentId` by extending `SessionActionLog` (`src/services/SessionActionLog.ts`). Comment attribution already exists (`authoredBySelf`); content-pull attribution is added by the dependency plan; this plan closes the state-change gap.
5. **Decide the coordination surface (formalize step 3).** Columns-as-handoff + per-column pin (recommended) vs. an explicit per-role assignment field on the plan. The demo validates the recommended option; the alternative is documented as a fallback if the pin proves brittle under column rename/reorder.

## Prior art & integration targets

The industry is building exactly this coordination layer — which validates the direction and gives concrete integration surfaces rather than only competitors. Findings below are research-confirmed (2026-07-19); see Uncertain Assumptions for the evidence trail.

- **Linear AgentSession** — the **primary integration target**. Mature and production-ready: OAuth `actor=app` installs the agent as a standalone workspace member; `app:assignable` + `app:mentionable` scopes; agents are **delegates** (not assignees), preserving human ownership. Webhook-driven (Agent Session Events category) with a 5s response SLA and a 10s initial-activity SLA. Payloads carry XML `promptContext` + `guidance` + `previousComments` — rich context, no extra fetch. 5,000 req/hour per token. Two concrete ties:
  - **Switchboard-as-Linear-agent:** register a Switchboard-orchestrated pipeline as a Linear agent (delegate), so a Linear-native team assigns an issue and Switchboard executes it locally on the repo and reports back via `agentSessionUpdate` (e.g. `externalUrls` for PR widgets). This is the neutral-broker role — the collaboration feature reaching users who live in Linear.
  - **Webhooks over polling:** Linear's Agent Session webhooks carry rich context and could replace the remote poll loop for Linear (keep polling as the no-host default for other providers; see the remote-boards "you are the remote part" model).
- **Notion Developer Platform — External Agents API** (announced May 13, 2026; **Private Beta / waitlist** as of mid-2026). Notion's version of this: third-party agents (Claude, Codex, Cursor, Devin, etc.) join a workspace as first-class collaborators via webhook triggers + REST/MCP + per-resource permissions, running in Notion Workers (Public Beta) or the vendor's cloud. It is the **hub/integration/cloud** realization — agents integrate *into Notion* to act on *Notion content*. Switchboard's differentiator is the inverse: **local + open + repo-centric**, no integration required. Two concrete ties, **both gated on External Agents API GA**:
  - **Switchboard-as-Notion-external-agent:** register a Switchboard-orchestrated pipeline as a Notion external agent. **Blocked for public release** — the API is private-beta; do not ship without partnership access. Viable for an internal prototype using standard internal integrations.
  - **Webhooks over polling:** the External Agents API is webhook-driven, but Notion webhooks are **signal-only** (payload carries resource IDs, forcing a follow-up GET). Combined with the **3 req/s** per-token rate limit, multi-agent on Notion is bottlenecked — keep polling as the default and treat webhook adoption as a later optimization once rate limits relax or batch endpoints ship.
- **ClickUp** — **no public external-agent API**. Native "Super Agents" (ClickUp Brain) and closed App Center partners (e.g. Cursor) exist; third parties must use standard OAuth/API tokens acting as a system bot, with no named-participant surface. The ClickUp MCP Server is available for read/query by external models. **ClickUp is a content/state-only collaborator via standard OAuth, not a first-class platform agent.** The `markdownDescription` round-trip bug (duplicate paragraph spacing on API writes) makes byte-identical content sync impossible — see the dependency plan's cursor-advance-on-push mitigation.

The lesson for this plan: design the coordination surface so Switchboard can both **drive** external-platform agents and **appear as** one, rather than assuming Switchboard is always the top-level orchestrator. **Sequencing:** Linear first (mature, rich, generous limits); Notion second (prototype only until External Agents API GA + rate-limit relief); ClickUp last (content/state-only, no named-agent surface).

## Proposed Changes

### `src/services/remote/ContentConflictResolver.ts` (or equivalent seam location from dependency plan)
- **Context:** The dependency plan ships the `ContentConflictResolver` interface + `LastWriteWinsResolver`. This plan adds the second implementation that makes "pluggable" meaningful.
- **Logic:** Add `TurnTokenResolver implements ContentConflictResolver`. State: per-plan `currentHolder: agentId | null`, `acquiredAt: timestamp`. `shouldPull(remoteUpdatedAt, cursor, remoteBody, localBody, ctx)` returns `false` while `ctx.currentHolder !== ctx.remoteAgentId` and the holder has not timed out; on timeout, advances the holder to the remote agent and returns `true`. Acquire on push (write barrier: holder must complete + push before release); release on column-transition handoff.
- **Implementation:** New class in the same module as the seam; inject alongside `LastWriteWinsResolver` with a per-plan config switch (collaboration on/off). Confirm the seam signature carries turn state before implementing — if `shouldPull` cannot accept `ctx`, escalate as a dependency-plan scope expansion.
- **Edge Cases:** Token timeout vs. in-flight write (release is a write barrier); force-release admin path (DoS mitigation); crash of the holder (timeout expire → next agent pulls before writing).

### `src/services/KanbanProvider.ts` (column config + dispatch)
- **Context:** Column→role dispatch today is `_columnToRole` / `roleForColumn` (`KanbanProvider.ts:6700-6743`), mapping to intern/coder/lead. There is no column→platform mapping.
- **Logic:** Add optional `ownerPlatform` + `ownerAgentId` to kanban column config. In the dispatch path (`_targetColumnForDispatchRole` and the `triggerAgentFromKanban` / `triggerBatchAgentFromKanban` call sites at `:8390,8534`), when a column has an `ownerPlatform` pin, route to that platform's remote agent instead of the local role dispatch. When unset, fall back to the existing role-based path (backward compat).
- **Implementation:** Column-config schema migration (additive, default unset); dispatch branch reads the pin; remote-agent trigger path reuses the existing remote-control dispatch surface.
- **Edge Cases:** Column rename/reorder (pin travels with the column key); platform disconnect (pin remains, dispatch degrades to role-based with a logged warning); pin set on a non-coding column (validate on set).

### `src/services/SessionActionLog.ts` (attribution for state changes)
- **Context:** `SessionActionLog` already records actions (lines `:182-196,273,521`) but does not stamp `platform` / `agentId` on state changes. Comment attribution exists via `authoredBySelf`; content-pull attribution is added by the dependency plan.
- **Logic:** Add `platform` and `agentId` fields to state-change action entries. Thread the originating platform/agent through the column-move dispatch path and the remote-state-apply path.
- **Implementation:** Additive columns on the action record; populate at the dispatch + remote-apply call sites. Readers (oversight, archive) tolerate missing fields (default `null` = local/unknown).
- **Edge Cases:** Local user-initiated moves (no platform → `null`); remote agent spoofing `agentId` (out of scope — trust the provider); backfill of existing rows (default `null`).

### Demo harness (exploratory; not production code)
- **Context:** The DoD requires a validated end-to-end demo, and the adversarial review mandates a deliberate concurrent-edit case.
- **Logic:** A scripted two-agent scenario (Linear planner + local CLI coder) that includes a forced collision: both write to the plan body inside one poll window, exercising `TurnTokenResolver`. Assert the non-holder's write is deferred/rejected and the holder's write lands.
- **Implementation:** Test/script artifact, not shipped production code. Reuse the existing remote-control test fixtures (`src/test/integrations/shared/remote-control-service.test.js`).
- **Edge Cases:** Timing flakiness (use deterministic clock injection, not real sleeps); poll-window alignment (drive the poll loop manually in the test rather than waiting on the interval).

## Verification Plan

### Automated Tests
Per session directive, automated test execution is **skipped** as part of this verification plan. The plan is exploratory; verification is the **demo + design review**:

- **Demo (manual, scripted):** Linear planner + local CLI coder round-trip on one plan, including the deliberate concurrent-edit case exercising `TurnTokenResolver`. Pass = non-holder write deferred/rejected, holder write lands, column handoff fires only after the plan body is quiescent.
- **Design review (user):** Confirm the four coordination-model decisions in *User Review Required* before promoting to an implementation plan.
- **Compilation:** Skipped per session directive.
- **Automated test suite:** Skipped per session directive. (When this plan is promoted to implementation, the demo harness above becomes the seed for an integration test under `src/test/integrations/shared/`.)

## Definition of Done (for the exploration)

A validated end-to-end demo of two different-platform agents collaborating on one plan via columns — **including a deliberate concurrent-edit case that exercises the second conflict resolver** — plus a concrete design for the pluggable conflict model (with `TurnTokenResolver` implemented, not just the `LastWriteWinsResolver` stub from the dependency plan) and attribution (state-change stamps in `SessionActionLog`) — ready to promote into an implementation plan.

**Recommendation:** Complexity 7 → **Send to Lead Coder** (once the dependency plan has shipped the `ContentConflictResolver` seam and the user has approved the four coordination-model decisions above).
