# Remote Agent Orientation — Plan From Project-Context Docs (No Repo)

**Plan ID:** 0f7e723e-9327-4073-a18a-0fde08c3e99f

## Goal

Orient the remote planning agent (claude.ai + Notion connector, or Linear-native) to **read the synced project-context docs — Dev Docs + PRDs + constitution — and author a code-grounded plan with no repo access, no GitHub MCP, no git branches**. This closes the context loop: `project-context-sync-to-notion-and-linear.md` puts the curated context in Notion/Linear; this plan makes the remote agent use it.

### Problem & background

Every remote-orientation path today either assumes repo access (GitHub MCP) or plans blind from the plan-card text alone (`switchboard_remote_notion.md` — "the plan text is the sole source of truth"). Neither tells the agent that curated developer context now exists on the tracker. After the Dev Docs tab + project-context sync ship, it does — but no skill mentions it, so the agent won't use it, and remote plans stay shallow ("post-it notes" that make execution agents do wrong work).

**Scope correction from the original Phase-2 plan:** the context is **not** a code-mirrored per-file "Codebase Docs" database (that whole approach — repo-walker generator, per-file Notion pages, incremental hash-diff sync — is **cut**). It is the curated **Dev Docs + PRDs + constitution** authored in `project.html` and synced provider-agnostically to **Notion and Linear**. The orientation is correspondingly simpler and provider-agnostic.

## What gets built

An orientation section added to the single remote skill (source of truth `.agents/skills/switchboard_remote_notion.md`, mirrored to `.claude/` via `ClaudeCodeMirrorService` — edit `.agents/`, never the generated copy). It teaches the agent to:

1. **Locate the project-context docs** on whichever provider it's attached to — the Notion project page / context area, or the Linear project docs/description.
2. **Read Dev Docs + PRD + constitution** to ground the plan in real modules, conventions, and constraints before writing.
3. **Author the plan** into the plans surface (Notion plans DB page / Linear issue) following the standard Switchboard plan structure, citing concrete paths/symbols from the Dev Docs so the local executing agent can find them.
4. **Set the trigger column/status** — the shipped `RemoteControlService` poll + the startup reconciler pick it up and dispatch locally. Zero git.

Also fold in the consolidation: this is the **one** orientation skill (the duplicate `/switchboard-remote` stub is deleted; `/sw-remote` is the single entry). No parallel copies.

## Edge cases

- **No project-context docs present** — fall back to the plan-card text (original behavior) and tell the user context sync isn't enabled.
- **Stale docs** — docs reflect the last sync; tell the agent to note staleness and how to trigger a fresh sync from the Remote tab.
- **Provider tier differences (Notion)** — precise property queries are tier-gated; document the `notion-search` / `notion-fetch` fallback for lower tiers. Orientation stays correct; only navigation efficiency varies.
- **Do not edit synced doc content on the tracker** — it is regenerated from `project.html` (the source of truth); frame edits as a consequence (they'll be overwritten) and direct the agent to write *plans*, not doc edits.

## Dependencies

- `project-context-sync-to-notion-and-linear.md` — the context must be synced for the orientation to be true.
- `project-html-dev-docs-tab-and-ia.md` — the Dev Docs authoring surface.
- Consumes the shipped `RemoteControlService` poll + the startup reconciler (`kanban-startup-reconciler.md`).

## Metadata

**Complexity:** 2
**Tags:** docs, cli
**Repo:** switchboard
