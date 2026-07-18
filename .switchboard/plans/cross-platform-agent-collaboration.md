# Cross-platform agent collaboration (exploratory — phase 2 on content-pull)

## Goal

Explore and specify making Switchboard a coordination substrate where AI agents on **different platforms** (Linear, Notion, ClickUp, Claude Desktop, CLIs) collaborate on the **same plan** through the board — each driving a different column/role — with the board as the shared blackboard.

### Problem Analysis (why this is now within reach)

Switchboard is already structurally a **blackboard**: agents coordinate through shared artifacts, not direct messaging. Most of the substrate exists — an open roster (any agent), **file-based completion** (host-agnostic "done"), a **two-way comment bus**, and **columns that already encode a handoff protocol** (Planned → Coding → Review) with per-column role dispatch. The one missing piece was a shared, mutable *spec*: plan content only flowed outward. The **remote-content-pull-all-providers** plan closes that gap. Once the plan body syncs bidirectionally across providers, agents on different platforms can collaborate on one plan through the board with no direct integration between them — the elegant form being *"each column/role is driven by an agent on a different platform, and column transitions are the handoffs."*

This is cross-**vendor** collaboration no single platform will ever build (their incentive is to keep you in their garden), which makes it structurally defensible — a moat made of competitors' incentives.

## Dependencies

**Hard dependency on `remote-content-pull-all-providers`** — a shared, bidirectional spec is the prerequisite. This is explicitly phase 2.

## Metadata

**Tags:** integrations, remote, architecture, exploratory
**Complexity:** 7

## User Review Required

This is an exploratory/design plan. Approve the direction and the coordination-model choice before any implementation.

## The real problem: coordination, not plumbing

Emergent collaboration (implicit, through the shared plan + columns + comments) is nearly free once content-pull ships, and works when agents take turns naturally. Turning it into a deliberate feature needs coordination primitives:

- **Turn-taking / soft locks** so two agents don't edit one plan simultaneously. This is exactly where content-pull's deferred "conflicts are rare, last-write-wins" model breaks: with concurrent collaborators, conflicts become the *normal* case, not the exception. The conflict model must be **pluggable** — last-write-wins today, lock/turn-token for collaboration.
- **Attribution / provenance** — which platform/agent made each change. Partly present already (comment `authoredBySelf`, plan `sourceType`); needs extending to state and content changes.
- **Handoff semantics** — formalize "column = whose turn / which role acts", allowing a column to be owned by a specific platform's agent.
- **Presence** (optional) — which agents are active on a plan right now.

## Proposed exploration

1. **Prototype "different platforms own different columns":** a Linear agent owns Planning (deepens the spec → content-pull brings it local), the local CLI owns Coding, a Notion reviewer owns Review (comment bus carries feedback). Verify the round-trip end to end.
2. **Design the pluggable conflict interface** (strategy: `last-write-wins | lock | turn-token`) plus a soft-lock mechanism keyed per plan.
3. **Design attribution:** stamp each state/content/comment change with its originating platform/agent.
4. **Decide the coordination surface:** columns-as-handoff vs. an explicit per-role assignment field.

## Prior art & integration targets

The industry is building exactly this coordination layer — which validates the direction and gives concrete integration surfaces rather than only competitors:

- **Notion Developer Platform — External Agents API** (May 2026). Notion's version of this: third-party agents (Claude, Codex, Cursor, Devin, etc.) join a workspace as first-class collaborators via webhook triggers + REST/MCP + per-resource permissions, running in Notion Workers or the vendor's cloud. It is the **hub/integration/cloud** realization — agents integrate *into Notion* to act on *Notion content*. Switchboard's differentiator is the inverse: **local + open + repo-centric**, no integration required. Two concrete ties:
  - **Switchboard-as-external-agent:** register a Switchboard-orchestrated pipeline *as* a Notion external agent, so a Notion-native team assigns work in Notion and Switchboard executes it locally on the repo and reports back. This is the neutral-broker role — the collaboration feature reaching users who live in Notion.
  - **Webhooks over polling:** the External Agents API is webhook-driven. Where an exposed endpoint is acceptable, Notion webhooks could replace the remote poll loop for lower latency (keep polling as the no-host default; see the remote-boards "you are the remote part" model).
- **Linear agent SDK / AgentSession** and **ClickUp** offer analogous (if narrower) agent-participant models — same integration-required shape.

The lesson for this plan: design the coordination surface so Switchboard can both **drive** external-platform agents and **appear as** one, rather than assuming Switchboard is always the top-level orchestrator.

## Edge-Case & Dependency Audit
- **Concurrency is the crux** — the whole feature stands on the conflict model. Ship content-pull with a *pluggable* conflict interface so this plan can add locking without a rewrite.
- **Rate limits multiply** with more active agents/providers — reuse the per-provider pacing.
- **ClickUp lacks the comment bus** — collaboration there is state/content-only, no conversation.

### Repo
switchboard (extension).

## Definition of Done (for the exploration)
A validated end-to-end demo of two different-platform agents collaborating on one plan via columns, plus a concrete design for the pluggable conflict model + attribution — ready to promote into an implementation plan.
