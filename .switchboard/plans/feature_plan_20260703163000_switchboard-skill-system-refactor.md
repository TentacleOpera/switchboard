# Switchboard Skill-System Refactor: /switchboard front door, improve-epic, remote gap-fills

**Plan ID:** f8fd74eb-ecbb-4230-a8f9-760c2aea8e53

## Goal

Document — for post-merge review by another agent — the skill-system and manifest work done this session, so it can be audited as one unit. This plan is a **record of completed, already-committed work** (branch `claude/plans-added-today-pi6s0e`), not a forward implementation task. A reviewer should verify the changes are correct, consistent, and safe to ship.

**Out of scope (self-documented elsewhere):** the MCP Monitor improvements epic review/consolidation (its own epic + subtask `.md` files under `.switchboard/`). This plan covers only the skill/infrastructure changes.

### Background & motivation

Three problems drove the work:
1. **A remote-execution gap in the manifest ingestor.** `PlanManifestService` only moved a plan's kanban column when the row was still at `CREATED`, so a remote agent could never advance a plan (e.g. `PLAN REVIEWED → CODED`) via manifest.
2. **`improve-plan` had the wrong contract for epics.** Its hard "never delete content / only update the plan document" rules are correct for a single plan but actively block the highest-value epic action — reconciling/restructuring the subtask set (merge/delete/rewrite). Running it on an epic also didn't fan out to the subtasks in a remote session (the local dispatcher's `expandEpicSubtaskPlans` behaviour had no remote equivalent).
3. **The skill surface was sprawling and hard to discover** — `/sw`, `/sw-remote`, `improve-remote-plan`, `notion-api`, `linear-api`, etc., with no single entry point, and two local-only capabilities (the splitter agent, `high-low` epic tiering) had no remote skill.

## Metadata

- **Tags:** refactor, docs, cli, backend, reliability
- **Complexity:** 5
- **Repo:** switchboard
- **Status:** active
- **Kanban:** leave in CREATED (review-only record; do not auto-advance)

## User Review Required

- Confirm the naming convention `/switchboard-*` for the discoverable aliases is the desired long-term scheme.
- Confirm `/sw` and `/sw-remote` should stay retired (the `sw-remote.md` playbook is preserved and loaded by the router; only the slash commands are gone).
- The two remote gap-fills (`switchboard-split`, `improve-epic` high/low mode) are authored as skill definitions but were **not exercised end-to-end** this session — the reviewer should run each against a real plan/epic once.

## What changed (grouped, with anchors)

### 1. Manifest: forward column transitions — `src/services/PlanManifestService.ts` (commit `c0c50ba`)
- Added optional `fromColumn` to `ManifestEntry` (default `'CREATED'`). The column override now applies only when the plan is currently in `fromColumn`, so a fresh manifest can make a legitimate forward transition (`PLAN REVIEWED → CODED`) while a stale one is still skipped.
- Backward compatible: entries without `fromColumn` behave exactly as before.
- Schema docs updated in `.claude/skills/improve-plan`, `.claude/skills/switchboard-chat` and their `.agents/workflows` mirrors.

### 2. `/improve-epic` skill (new) — restructure-first epic reconciliation (commit `daaa9a8`, gap-fill `87d8678`)
- New `.agents/workflows/improve-epic.md` (+ `.claude` mirror). Contract is the inverse of `improve-plan`: **authorised to cut** (merge/delete/rewrite/split subtasks); invoking it is the sign-off, no per-run gating.
- Guardrails swapped, not removed: preserve information (not files), git is the undo, never hand-edit the auto-generated subtasks block, route set changes via `git rm` + manifest (remote) or `assign-to-epic` (local), report the restructure.
- Steps: expand epic → run improve-plan on every subtask → cross-subtask reconciliation audit → restructure → backfill epic description.
- Added a **high/low mode**: consolidate subtasks into two complexity-tier plans (HIGH ≥5, LOW ≤4) linked to the epic — the remote equivalent of the local `high-low` epic worktree mode.
- `improve-plan`'s former "Epic Mode" (commits `1eca852`, `682d613`) was reverted to a one-line pointer to `improve-epic`; its single-plan non-destructive rules are unchanged.

### 3. `/switchboard` front-door router (new) — `workflows/switchboard-index.md` (commit `2c6ae08`)
- Single entry point. Detects local vs remote (presence of `.switchboard/api-server-port.txt`) and routes the user's plain-language request to the right skill via an intent table. Flags which skills need the LocalApiServer (unreachable when remote) and offers git/file alternatives.

### 4. Retire `/sw` and `/sw-remote`; add `/switchboard-*` aliases — `src/services/ClaudeCodeMirrorService.ts` (commit `8e32e01`)
- Removed the `sw` and `sw-remote` entries from `MIRROR_MANIFEST` (the slash commands are gone). `sw-remote.md` is retained under `.agents/workflows/` (ships with the plugin) and is loaded by the router in remote mode, so its full Linear/Notion playbook is preserved.
- Added additive `/switchboard-*` aliases (`switchboard-plan`, `-epic`, `-remote-plan`, `-notion`, `-linear`, `-clickup`, `-kanban`, `-research`) — same sources as the canonical skills, so typing `/switchboard-` surfaces the family; canonical names keep working.
- Removed stale generated `.claude/skills/sw` and `.claude/skills/sw-remote` command dirs.

### 5. `/switchboard-split` skill (new) — remote splitter (commit `87d8678`)
- New `workflows/switchboard-split.md` (+ mirror + manifest entry). Splits one plan into a Complex/Risky file + a `<stem>_routine.md` companion along its `## Complexity Audit`, carrying shared context into both. Remote-safe (file writes) — the file-based equivalent of the local `SPLIT_PLAN_DIRECTIVE` splitter.

### 6. Manifest registration + registries (commits `fa6a186`, `8e32e01`, `87d8678`)
- Registered `switchboard`, `improve-epic`, `switchboard-split` in `MIRROR_MANIFEST` (they were previously phantom — worked in-session but never generated into user workspaces).
- Updated the `CLAUDE.md` and `AGENTS.md` workflow registries and skills tables to match.

## Edge-Case & Dependency Audit

- **`fromColumn` stale guard:** if the plan is not in `fromColumn` (a human/host moved it), the column override is skipped — no card is yanked backward. Idempotent; manifest deleted after apply.
- **Load-bearing names:** the retired `sw`/`sw-remote` names were only referenced by the manifest itself (verified via grep of `src/`); `switchboard-chat` and `improve-remote-plan` are referenced by `agentPromptBuilder`/dispatch and were left intact. Aliases are additive, so no code reference breaks.
- **Mirror vs. hand-authored `.claude/`:** `.claude/skills/` is generated from `.agents/` by `ClaudeCodeMirrorService`; the new skills are registered in the manifest so they regenerate correctly rather than relying on hand-authored dirs.
- **No `confirm()` gates introduced** anywhere.

## Verification Plan

### Automated Tests
- `npm run compile` / `npx tsc --noEmit -p tsconfig.json` — passes with 0 errors (confirmed this session after the `PlanManifestService` and `ClaudeCodeMirrorService` edits).
- Grep invariants the reviewer can re-run:
  - No user-facing `/sw` or `/sw-remote` command references remain outside the preserved `sw-remote.md` playbook.
  - `MIRROR_MANIFEST` contains `switchboard`, `improve-epic`, `switchboard-split`, and the `switchboard-*` aliases; no `sw`/`sw-remote` entries.
- Suggested unit coverage (not yet written): `PlanManifestService` — a `fromColumn: 'PLAN REVIEWED'` entry moves a `PLAN REVIEWED` plan to `CODED`; the same entry is skipped when the plan is elsewhere.

### Manual review checklist (post-merge, another agent)
1. Fresh `ClaudeCodeMirrorService` run generates `.claude/skills/switchboard`, `improve-epic`, `switchboard-split`, and the `switchboard-*` alias dirs; no `sw`/`sw-remote` dirs.
2. `/switchboard` correctly detects remote vs local and routes a sample request each way.
3. `/switchboard-split` run against a real plan produces the two tier files with no content lost.
4. `/improve-epic --high-low` against a real epic produces two tier plans linked to the epic.
5. A manifest with `fromColumn`/`kanbanColumn` advances a non-CREATED card exactly once and is then deleted.

## Recommendation

**Send to Lead Coder** for review. Complexity 5: individually the changes are routine (docs + one additive `PlanManifestService` field + manifest entries), but they touch the skill-generation surface (`ClaudeCodeMirrorService`) and the remote-control ingestor, and two new skills are unexercised — a senior reviewer should run the manual checklist before this ships.

## Review Findings

Reviewed the committed skill-system refactor against the plan: `PlanManifestService.ts` `fromColumn` logic, `ClaudeCodeMirrorService.ts` manifest entries, the three new workflow files, and the AGENTS/CLAUDE registry updates. The `fromColumn` stale-guard logic is sound (backward-compatible default, idempotent no-op when already at target, invalid-column skip) and the manifest invariants pass (no `sw`/`sw-remote` entries; `switchboard`/`improve-epic`/`switchboard-split` + all `switchboard-*` aliases registered). Fixed one MAJOR issue: the `/switchboard` router table directed users to a `deep-research` skill that does not exist in `MIRROR_MANIFEST` — removed the phantom reference from `switchboard-index.md` and its `.claude` mirror so every router-named skill now resolves. Also corrected a stale doc comment in `GlobalPlanWatcherService._processManifest` that still said "only overrides when at CREATED". Files changed: `.agents/workflows/switchboard-index.md`, `.claude/skills/switchboard/SKILL.md`, `src/services/GlobalPlanWatcherService.ts`. Remaining risks: the two new skills (`switchboard-split`, `improve-epic --high-low`) remain unexercised end-to-end (acknowledged in the plan's manual checklist); no unit tests exist yet for the `fromColumn` forward-transition path.
