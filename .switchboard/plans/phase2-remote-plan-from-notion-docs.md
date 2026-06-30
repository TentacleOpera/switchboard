# Phase 2 (4/4): Remote Agent Orientation — Plan From Notion Codebase Docs (No Repo)

## Goal

Teach the remote planning agent (claude.ai + Notion connector, or Claude Code web) that the codebase now lives in Notion as the "Switchboard Codebase Docs" database, and orient it to **read those docs, author a plan grounded in real code, and write the plan back to Notion with the trigger status — all without any repo access.** This closes the Phase 2 loop: plans 1–3 put the codebase in Notion; this plan makes the remote agent use it.

### Problem & Background

Today every remote-orientation skill assumes one of two things: the agent reads the repo (the Linear surface in `add-switchboard-remote-skill.md` explicitly relies on GitHub MCP), or the agent plans blind from the plan-card text alone (`switchboard_remote_notion.md:33-39` — "the plan text in the Notion page body is the sole source of truth"; no codebase access). Neither tells the agent that a structured, queryable copy of the codebase exists in Notion. After plans 1–3 ship, it does — but no skill mentions it, so the agent won't use it.

### Root Cause

Orientation gap, not a code gap. The consumption path already works end-to-end: a remote agent that writes a plan into the Notion plans DB with the trigger column is picked up by the shipped `RemoteControlService` poll + the Phase-1 startup reconciler (`improve-remote-plan-skill.md` / `kanban-startup-reconciler.md`). The only missing piece is telling the agent (a) the codebase docs DB exists, (b) how to navigate overview → module → file, (c) that it can now plan from those docs with zero repo/GitHub-MCP dependency.

## Metadata

**Complexity:** 2
**Tags:** docs, cli
**Depends on:** `phase2-notion-codebase-docs-sync.md` (2/4) — the docs DB must exist for the orientation to be true. Soft-depends on 1/4 and 3/4.
**Parent epic:** `epic-remote-planning-infrastructure-7421946e-dea1-4d2b-985d-5de52d088f4d.md`

## User Review Required

None. Documentation-only change. The user should skim the generated skill text for accuracy before merge (standard for skill plans).

## Decisions (made, not deferred)

1. **Add the orientation to the existing Notion remote skill**, `.agents/skills/switchboard_remote_notion.md`, as a new "Planning from Codebase Docs (no repo)" section. Do not create a fourth parallel skill (avoids the orientation drift the epic warns about). **Correction:** the original plan referenced folding this into a `/sw-remote` workflow (`sw-remote-entry-skill.md`) — that workflow and entry skill **do not exist** in the codebase (verified: `.agents/workflows/` contains only `accuracy.md`, `improve-plan.md`, `memo.md`, `switchboard-chat.md`). Edit `switchboard_remote_notion.md` directly; there is no `/sw-remote` to coordinate with.
2. **Source of truth = `.agents/`**, mirrored to `.claude/` via `ClaudeCodeMirrorService` (per the control-plane rule — `ClaudeCodeMirrorService.ts:40-46`, invariant: `.agents/` is the single source, `.claude/` is generated). Edit the `.agents/skills/` source and `AGENTS.md`, never the generated `CLAUDE.md`/`.claude/` copies.
3. **Codebase doc pages are regenerated artifacts — edits are silently overwritten.** The skill tells the agent these pages are extension-generated and that any edit it makes will be clobbered on the next sync (plan 2/4's full-clobber). Frame this as a *consequence* ("your edits will be destroyed"), not just a prohibition — and direct the agent to write *plans* to the plans DB, not edits to doc pages.

## What Gets Built

### 1. `.agents/skills/switchboard_remote_notion.md` — new section

Add after the existing "how the loop works" / pre-flight content:

```markdown
## Planning from Codebase Docs (no repo access)

If the board's Notion workspace contains a **"Switchboard Codebase Docs"** database,
the codebase is available to you directly in Notion — you do NOT need GitHub access,
a cloned repo, or a local Claude Code session to write a code-grounded plan.

### How the docs are organised
- **Overview page** — repo name, a tree of modules, and an excluded-files list. Start here.
- **Module pages** (`Doc Kind = module`) — one per directory; list the files in that module.
- **File pages** (`Doc Kind = file`) — one per source file; a generated summary header plus
  the file's source in a code block. The `Path` property is the repo-relative path.

### To plan from the docs
1. Open the Codebase Docs database. Read the **overview** to locate the relevant modules.
2. Query file pages by `Path` (or `Module`) for the files your change touches; read their
   source blocks to ground the plan in real symbols, signatures, and call sites.
3. Author the plan in a **new plans-DB page** (not a doc page), following the standard
   Switchboard plan structure (Goal + problem/root-cause, Tasks, Edge Cases, Out of Scope).
   Cite concrete file paths from the doc pages so the local executing agent can find them.
4. Set the plan's `Kanban Column` to the improvement/trigger column. The local extension
   picks it up on next startup (startup reconciler) and dispatches it.

### Important
- **Do not edit the codebase doc pages — your edits will be overwritten.** They are regenerated
  by the extension on every commit/sync (full-clobber). Treat them as read-only artifacts; write
  your *plan* to the plans DB instead.
- Docs reflect the **last sync**, not the live working tree. If a file looks stale, note it;
  the user can trigger "Sync Codebase Docs Now" in the Kanban Remote tab.
- If there is **no** Codebase Docs database, fall back to the plan-card text as the source
  of truth (the original behaviour) and tell the user codebase-docs sync isn't enabled.
```

### 2. Registration — `AGENTS.md`

No new skill row is needed (the `switchboard_remote_notion` row already exists at line 92). The new section lives entirely inside `.agents/skills/switchboard_remote_notion.md`. **No `/sw-remote` coordination:** the original plan referenced a `/sw-remote` workflow and `sw-remote-entry-skill.md` — neither exists in the codebase (verified). Edit `switchboard_remote_notion.md` directly; there is no archived-into-`/sw-remote` branch to fold into.

## Key Reuse (do not reinvent)

| Reuse | Source |
|------|--------|
| Notion remote loop / pre-flight content | `.agents/skills/switchboard_remote_notion.md` (lines 33-39) |
| Plan write-back + trigger-column → dispatch | shipped `RemoteControlService` (poll at `169-172`) + `kanban-startup-reconciler.md` |
| Mirror to `.claude/` | `ClaudeCodeMirrorService` MIRROR_MANIFEST (`ClaudeCodeMirrorService.ts:40-46`) |

## Complexity Audit

### Routine
- Appending a new markdown section to an existing skill file (`.agents/skills/switchboard_remote_notion.md`).
- No new skill row in `AGENTS.md` (the `switchboard_remote_notion` row already exists at line 92).
- Mirror to `.claude/` is automatic via `ClaudeCodeMirrorService` on the next mirror run.

### Complex / Risky
- **Notion MCP connector query capability (uncertain):** the skill instructs the agent to query file pages by `Path`/`Module`. If the connector cannot filter by property, the orientation is still correct but the agent's navigation is less efficient (scan vs. query). See "Uncertain Assumptions."
- **Single-source correctness:** the section must live in exactly one place (the notion skill). The original plan's `/sw-remote` coordination fiction is removed; the implementer must not re-introduce a parallel copy.

## Dependencies

- `sess_phase2-notion-codebase-docs-sync` — Notion Codebase-Docs DB + Incremental Push (the docs DB must exist for the orientation to be true).
- `sess_phase2-codebase-doc-generator` — Codebase Doc Generator (soft; the doc structure the skill describes comes from this plan).
- `sess_phase2-codebase-docs-sync-triggers-and-ui` — Continuous Sync Triggers (soft; the "Sync Now" instruction references the Remote-tab control).

## Adversarial Synthesis

Key risks: (1) the original plan coordinated around a nonexistent `/sw-remote` workflow — corrected to edit `switchboard_remote_notion.md` directly, eliminating the drift risk; (2) the Notion MCP connector's query/filter capability is unverified — if it can't filter by property, the agent falls back to scanning, which works but is slower on large repos; (3) the read-only warning is reframed as a consequence (edits overwritten) rather than a prohibition, improving agent compliance. The orientation prose is sound; the only material uncertainty is the MCP query capability.

## Uncertain Assumptions

- **Notion MCP connector can query/filter a database by property values (`Path`, `Module`, `Doc Kind`).** The skill instructs the remote agent to "query file pages by `Path`." If the connector only supports fetching pages by ID or returning the entire database, the agent cannot efficiently navigate overview→module→file and must scan all file pages. The orientation remains *correct* either way (the fallback is scanning), but the efficiency claim is unverified. The user was advised to run web research to confirm the Notion MCP connector's query/filter capabilities before implementation.

## Edge-Case & Dependency Audit

- **Docs DB absent (feature off):** the skill's fallback paragraph keeps old behavior — plan from card text. No hard failure.
- **Stale docs:** the skill tells the agent docs reflect the last sync and how to request a fresh one. Prevents the agent silently planning against outdated code.
- **Agent edits a doc page:** the skill frames this as a consequence (edits are overwritten on next sync); even if it happens, plan 2/4's full-clobber repairs it (doc pages are owned artifacts).
- **Mirror correctness:** editing `.agents/` source (not `.claude/`) means the next mirror run regenerates the Claude Code copy — no manual `.claude/` edit, no drift.
- **Notion MCP connector query capability (UNCERTAIN):** the skill instructs the agent to "query file pages by `Path` (or `Module`)." This assumes the Notion MCP connector can filter a database by property values. If the connector can only fetch pages by ID or return the whole database, the agent must scan all file pages to find relevant ones — feasible but slow on a large repo. See "Uncertain Assumptions" below.

## Verification Plan

## Proposed Changes

### `.agents/skills/switchboard_remote_notion.md`
- **Context:** The skill (lines 33-39) currently treats the plan-card text as the sole source of truth; no codebase access.
- **Logic:** Append a "Planning from Codebase Docs (no repo)" section after the existing pre-flight content: doc organisation (overview/module/file), plan-authoring steps (read overview → query file pages by `Path` → author plan in plans DB → set trigger column), the "edits overwritten" consequence warning, and the no-docs-DB fallback.
- **Implementation:** Append-only markdown edit to the `.agents/` source. The `ClaudeCodeMirrorService` mirror run regenerates the `.claude/` copy.
- **Edge Cases:** No docs DB → fallback paragraph keeps old behavior. Stale docs → skill tells the agent to request a fresh sync.

### `AGENTS.md`
- **Context:** The `switchboard_remote_notion` skill row already exists (line 92).
- **Logic:** No change needed — no new skill row. (The original plan's `/sw-remote` cross-reference is removed; that workflow does not exist.)
- **Implementation:** No edit.
- **Edge Cases:** None.

## Verification Plan

### Automated Tests

> Suite run separately by the user. This is a documentation-only plan; "automated" checks are content/mirror assertions, not unit tests.

1. **Skill content check:** the new section exists in the `.agents/` source with the four required parts (organisation, plan steps, read-only warning, fallback).
2. **Mirror check:** after a mirror run, the Claude Code copy reflects the new section.
3. **No-duplication check:** the codebase-docs orientation appears in exactly one place (`switchboard_remote_notion.md`) — no parallel copy in a nonexistent `/sw-remote`.
4. **Manual end-to-end:** in a claude.ai session with the Notion connector and a synced Codebase Docs DB, follow the skill — read overview → file pages → author a plan citing real paths → set trigger column → confirm the local extension dispatches it on startup.

## Out of Scope

- Generating/pushing the docs (plans 1–3).
- Any code change to the sync pipeline or extension backend.
- Linear/ClickUp codebase-docs orientation (Notion-only per epic).
- Agent-side write *fidelity* improvements to plan pages (Remote Sync Refactor epic).

## Recommendation

Complexity 2 → **Send to Intern.** Pure orientation prose; the only care point is keeping the section in the single source of truth (`switchboard_remote_notion.md`) and confirming the Notion MCP connector's query capability (see Uncertain Assumptions).
