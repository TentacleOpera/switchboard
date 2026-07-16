---
created: 2026-07-14T00:00:00.000Z
---

# [Chore] [Docs/Copy] Correct Claude Desktop connection wording — Code mode is not MCP-only

## Goal

Remove the now-dead `switchboard-mcp` documentation and skill-metadata husks that claim Claude Desktop can only reach the Switchboard board through the MCP bridge. The MCP bridge code has been fully removed from this extension and is not being offered anymore. Claude Desktop's **Code mode** has full filesystem access and drives the board directly, exactly like any CLI agent: add the workspace folder that holds the scaffolding (`.claude/` + `.switchboard/`) and use `/switchboard` (and the other slash commands) — **no MCP**. Claude in any other mode (including claude.ai) does **not** have filesystem access and has no path to the board — this is deliberate and there is nothing to document for those modes.

### Problem Analysis

**Background.** The switchboard-site docs were corrected to this model. The extension repo's own skill metadata and Setup panel still carry the old assumption that Claude Desktop is an "MCP-only chat host with no shell/filesystem." Confirmed inaccurate by the maintainer: Claude Desktop Code mode has full filesystem access and runs `/switchboard` against the live board (auto-discovers the local API port), with no MCP involved.

**Root cause.** The `switchboard-mcp` skill and registry rows were written treating Claude Desktop as MCP-only. That is true only for modes without filesystem access; Code mode has full filesystem access and behaves like Claude Code / Antigravity.

### Repo-State Finding (improve-pass)

> **Clarification (factual, verified during planning):** The MCP bridge **code** is no longer present in this repo. `src/mcp/`, `src/services/ClaudeDesktopConnector.ts`, and `src/services/CoworkSkillExporter.ts` were deleted by commit `a536ccf` (the sibling `remove-claude-desktop-mcp-bridge-and-cowork-skill.md` plan). The `btn-connect-claude-desktop` button and `connectClaudeDesktop`/`@switchboard/mcp` references are **absent from `src/`** (zero grep hits). However, commit `5eee0c6` ("Pre-release backup of in-progress work") **restored the documentation/skill-metadata husks** — the `switchboard-mcp` SKILL.md copies, the `CLAUDE.md`/`AGENTS.md` registry rows, and the `switchboard.md` workflow note — without restoring the code. The maintainer has confirmed the MCP server is fully removed and is not being offered in this extension anymore. The correct action is therefore to **remove the doc/skill husks**, not reword them.

> **Superseded:** The original plan's approach — keep the `switchboard-mcp` skill/registry/docs and merely qualify their wording (Code mode vs chat/cowork mode + localhost-only caveat).
> **Reason:** The MCP bridge code is deleted and the maintainer confirms it is not being offered anymore. Rewording husks that describe a feature whose code and npm package no longer exist would leave docs pointing users at a 404 package (`npx -y @switchboard/mcp`) and a "Connect Claude Desktop" button absent from setup.html. The maintainer also confirmed Claude in any non-Code mode (including claude.ai) has no filesystem access and no path to the board — so there is no chat/cowork-mode use case left to document. The only Claude Desktop path is Code mode, which is already covered by the existing `/switchboard` workflow and `switchboard` skill (CLI-agent docs). There is nothing new to document for the MCP bridge.
> **Replaced with:** Remove the `switchboard-mcp` skill copies, registry rows, and workflow note entirely (finish the sibling remove-plan's doc layer), across both the switchboard dev-repo and the frozen loaded `Gitlab/` workspace copies.

## Metadata
- **Tags:** docs
- **Complexity:** 2

## User Review Required

- Confirm the MCP server is fully removed and not being offered (maintainer has confirmed this — recorded here for audit).
- Confirm Claude Desktop Code mode has full filesystem access and runs `/switchboard` directly (maintainer has confirmed this).
- Confirm Claude in any other mode (including claude.ai) has no filesystem access and no path to the board, and that this is deliberate (maintainer has confirmed this).

## Complexity Audit

### Routine
- Delete the `switchboard-mcp` skill directories (`.agents/skills/switchboard-mcp/` and `.claude/skills/switchboard-mcp/`) in the switchboard repo.
- Remove the `switchboard-mcp` registry row from `CLAUDE.md` and `AGENTS.md` (switchboard repo).
- Remove the Claude Desktop MCP note block from `.agents/workflows/switchboard.md` and `.claude/skills/switchboard/SKILL.md` (switchboard repo).
- Reconcile the frozen loaded-workspace copies under `Gitlab/` (delete the same husks there).
- Verify the setup.html "Claude Desktop bridge" card is absent (no edit needed — already removed).

### Complex / Risky
- None for execution. Removal of dead documentation; no runtime impact.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Static documentation/skill deletions; no runtime state.
- **Security:** None. Removing dead docs that describe a deleted feature.
- **Side Effects:**
  - Any agent whose available-skills list references `switchboard-mcp` will no longer find it — but the skill describes a feature whose code is gone, so this is correct.
  - The `ClaudeCodeMirrorService` mirrors `.agents/skills/` into `.claude/skills/`; deleting the `.agents/` source and re-running the mirror removes the `.claude/` copy automatically. Deleting both by hand is also acceptable but the mirror must stay consistent.
  - Loaded `Gitlab/` copies were installed with `overwrite:false` and are frozen — a version bump will not refresh them; they must be reconciled manually (delete the same husks), not just the dev-repo source.
- **Dependencies & Conflicts:**
  - **Sibling plan alignment:** `remove-claude-desktop-mcp-bridge-and-cowork-skill.md` (complexity 5, has a Completion Summary) deleted the bridge code and claims to have removed the doc references — but commit `5eee0c6` restored the doc husks. This plan finishes that remove-plan's doc layer. The two plans are now consistent in intent: remove, not reword.
  - The existing `/switchboard` workflow and `switchboard` skill already document the Code-mode (direct, filesystem) path; removing the MCP husks does not leave a documentation gap for the only supported Claude Desktop path.

## Dependencies
- None (docs-removal chore).

## Adversarial Synthesis

Key risks: (1) removing the husks could leave a documentation gap if any supported Claude Desktop mode still needed the MCP bridge — but the maintainer confirms the bridge is gone and only Code mode (already documented elsewhere) is supported, so no gap; (2) the frozen `Gitlab/` copies must be reconciled too or they will keep broadcasting the dead "MCP-only / not shell" claim, failing the acceptance criterion in the loaded workspace; (3) the `ClaudeCodeMirrorService` mirror must stay consistent between `.agents/` and `.claude/` copies. Mitigations: enumerate all loaded-copy locations in the work list; re-run the mirror (or delete both copies by hand) and diff to confirm consistency.

## Proposed Changes

### `.agents/skills/switchboard-mcp/` and `.claude/skills/switchboard-mcp/` (switchboard repo)
- **Context:** Both directories contain a `SKILL.md` describing the deleted MCP bridge. The `.agents/` source is mirrored into `.claude/` by `ClaudeCodeMirrorService`.
- **Logic:** The bridge is gone; the skill describes a non-existent feature. Remove both.
- **Implementation:** Delete `.agents/skills/switchboard-mcp/` (source) and `.claude/skills/switchboard-mcp/` (mirror). Either re-run the mirror to drop the `.claude/` copy automatically, or delete both by hand and confirm the mirror ledger (`.claude/.switchboard-generated.json`) no longer references `switchboard-mcp`.
- **Edge Cases:** If the mirror service runs on next activation it will simply not find the deleted `.agents/` source and omit the `.claude/` copy — safe.

### `CLAUDE.md` (switchboard repo, line 145) and `AGENTS.md` (switchboard repo, line 114)
- **Context:** Both carry a `switchboard-mcp` skill-registry row: "Local stdio MCP server bridging Claude Desktop (and other MCP-only hosts with no shell/filesystem) to LocalApiServer. Claude Desktop reaches the management surface via this MCP server, not shell. Use the in-extension **Connect Claude Desktop** button (Setup panel) to write the config entry."
- **Logic:** The row documents a deleted feature. Remove it.
- **Implementation:** Delete the `| \`switchboard-mcp\` | … |` row from both files.
- **Edge Cases:** None. Table formatting stays intact with one fewer row.

### `.agents/workflows/switchboard.md` (switchboard repo, lines 308-313) and `.claude/skills/switchboard/SKILL.md` (switchboard repo, lines 310-315)
- **Context:** Both carry an identical note block: "> **Claude Desktop** reaches this surface via the **local stdio MCP server** (`@switchboard/mcp` / `switchboard-mcp`), not shell — it has no shell or filesystem… Use the in-extension **Connect Claude Desktop** button…"
- **Logic:** The note describes the deleted bridge and makes the inaccurate "not shell" claim. These two locations were **missing from the original work list** and directly violate the acceptance criterion.
- **Implementation:** Delete the note block from both files. The `.claude/skills/switchboard/SKILL.md` copy mirrors the workflow content — keep them consistent.
- **Edge Cases:** None. Removing the block leaves the surrounding "Guided setup / Guided tour" content intact.

### `src/webview/setup.html` (switchboard repo)
> **Superseded:** "src/webview/setup.html:592-594 — the 'Claude Desktop bridge' card. Clarify that the bridge is for Claude Desktop chat/cowork mode…"
> **Reason:** Verified during planning — the card does not exist. Lines 592-594 are the "GIT IGNORE STRATEGY" section. `btn-connect-claude-desktop` and `btn-setup-cowork` return **zero grep hits** in setup.html; the card was removed by commit `a536ccf` and not restored by `5eee0c6`. Dispatching a coder to edit it would target a non-existent element.
> **Replaced with:** No edit required. Instead, **verify** (grep) that setup.html contains no `Claude Desktop`, `btn-connect-claude-desktop`, `connectClaudeDesktop`, or `@switchboard/mcp` reference.

### Loaded workspace copies — `Gitlab/` (frozen, `overwrite:false`)
- **Context:** The loaded workspace at `/Users/patrickvuleta/Documents/Gitlab` carries the same dead husks in its own copies, and a version bump will not refresh them.
- **Implementation:** Delete/reconcile the following loaded copies to match the cleaned dev-repo:
  - `Gitlab/AGENTS.md:114` — `switchboard-mcp` registry row
  - `Gitlab/CLAUDE.md:124` — `switchboard-mcp` registry row (**missing from the original propagation note**)
  - `Gitlab/.agents/skills/switchboard-mcp/SKILL.md` — delete the skill directory
  - `Gitlab/.claude/skills/switchboard-mcp/SKILL.md` — delete the skill directory
  - `Gitlab/.agents/workflows/switchboard.md:308` — Claude Desktop MCP note block
  - `Gitlab/.claude/skills/switchboard/SKILL.md:310` — mirrored note block
- **Edge Cases:** These loaded copies are not git-tracked by the switchboard repo; reconciliation is a manual / scripted sync step, not a commit into this repo.

## Work Items

1. **Delete `switchboard-mcp` skill directories** — `.agents/skills/switchboard-mcp/` and `.claude/skills/switchboard-mcp/` (switchboard repo). Keep the mirror consistent.
2. **Remove `switchboard-mcp` registry rows** — `CLAUDE.md:145` and `AGENTS.md:114` (switchboard repo).
3. **Remove the Claude Desktop MCP note block** — `.agents/workflows/switchboard.md:308-313` and `.claude/skills/switchboard/SKILL.md:310-315` (switchboard repo). *(Added during improve-pass — missing from the original work list.)*
4. **`src/webview/setup.html`** — no edit; verify the "Claude Desktop bridge" card is absent (already removed). *(Superseded from an edit into a verification step.)*
5. **Reconcile frozen loaded `Gitlab/` copies** — delete the same husks: `Gitlab/AGENTS.md:114`, `Gitlab/CLAUDE.md:124`, `Gitlab/.agents/skills/switchboard-mcp/`, `Gitlab/.claude/skills/switchboard-mcp/`, `Gitlab/.agents/workflows/switchboard.md:308`, `Gitlab/.claude/skills/switchboard/SKILL.md:310`. *(Original propagation note missed `Gitlab/CLAUDE.md:124`, the workflow note, and the `switchboard` skill note — all added.)*

## Acceptance Criteria

- No file in the repo (or the loaded `Gitlab/` workspace) states or implies Claude Desktop can only reach the board via MCP.
- The `switchboard-mcp` skill no longer exists in `.agents/skills/` or `.claude/skills/` (switchboard repo or `Gitlab/`).
- The `switchboard-mcp` registry row is gone from `CLAUDE.md` and `AGENTS.md` (switchboard repo and `Gitlab/`).
- The Claude Desktop MCP note block is gone from `switchboard.md` and `.claude/skills/switchboard/SKILL.md` (switchboard repo and `Gitlab/`).
- `setup.html` contains no Claude Desktop / `btn-connect-claude-desktop` / `@switchboard/mcp` reference (verified — card already removed).
- `claude.ai` is not asserted as a working path anywhere (untested, and deliberately unsupported).

## Out of Scope

- The switchboard-site docs (already corrected).
- Any change to the MCP server code itself — already deleted by the sibling remove-plan.
- Any re-creation or restoration of the MCP bridge — the maintainer has confirmed it is not being offered anymore.

## Verification Plan

### Automated Tests
- Tests skipped per session directive. No automated tests to run.

### Manual Verification
1. **Grep audit (acceptance criterion):** across the switchboard repo, search for `switchboard-mcp`, `not shell`, `MCP-only`, `no shell/filesystem`, `reaches the management surface via this MCP server`, `@switchboard/mcp`, `Connect Claude Desktop` — every remaining hit must be a historical plan file under `.switchboard/plans/` (acceptable) or zero. Target files: `CLAUDE.md`, `AGENTS.md`, `.agents/skills/`, `.claude/skills/`, `.agents/workflows/switchboard.md`.
2. **Skill-directory check:** `ls .agents/skills/switchboard-mcp .claude/skills/switchboard-mcp` must report "No such file or directory" in the switchboard repo.
3. **setup.html presence check:** `grep -ci "btn-connect-claude-desktop\|connectClaudeDesktop\|@switchboard/mcp\|Claude Desktop" src/webview/setup.html` must return `0`.
4. **Mirror consistency:** confirm `.claude/skills/switchboard-mcp/` is gone and the mirror ledger (`.claude/.switchboard-generated.json`) no longer references `switchboard-mcp`.
5. **Loaded-copy reconciliation:** confirm the six `Gitlab/` locations listed above are also cleaned (registry rows gone, skill dirs gone, note blocks gone).
6. **No compilation step** (skipped per session directive).

## Recommendation

Complexity 2 → **Send to Intern**. (Mechanical deletion of dead docs across documented locations; no judgment calls remain — the keep-vs-remove decision was resolved by the maintainer in favor of removal.)

## Completion Summary

Removed all dead `switchboard-mcp` documentation/skill husks across three workspaces (switchboard dev-repo, frozen `Gitlab/` root, and `Gitlab/analytics-dashboard` — the last was not enumerated in the plan's work items but carried identical husks and was reconciled to satisfy the broad acceptance criterion). Deleted the six `switchboard-mcp` skill directories (`.agents/skills/` + `.claude/skills/` in each workspace); removed the `switchboard-mcp` registry row from `CLAUDE.md` and `AGENTS.md` (6 files); removed the Claude Desktop MCP note block from `.agents/workflows/switchboard.md` and `.claude/skills/switchboard/SKILL.md` (6 files); and removed the `switchboard-mcp` entry from each `.claude/.switchboard-generated.json` mirror ledger (3 files), fixing the trailing comma on the preceding `switchboard-research` entry. Verified: all six skill dirs gone, all three ledgers parse as valid JSON, `setup.html` returns 0 hits for Claude Desktop / `btn-connect-claude-desktop` / `@switchboard/mcp`. Remaining grep hits are confined to historical `.switchboard/plans|features` files (acceptable per the verification plan), a `NotebookLM` bundle manifest (historical artifact), the `mcp_monitor` role fallback in `src/services/TaskViewerProvider.ts` (general MCP-server monitor, unrelated to Claude Desktop reaching the board), and a stale `package (1).json` backup — none state or imply Claude Desktop is MCP-only for the board. No issues encountered; no compilation or tests run per session directives.
