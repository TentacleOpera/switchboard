# Flatten protocols out of the skill shape: `<name>/SKILL.md` → `<name>.md`

## Goal

Stop 32 non-discoverable protocol files from occupying the `<name>/SKILL.md` convention that exists solely for host skill discovery, by flattening them to `.agents/protocols/<name>.md` — the shape `refine_feature.md` already uses correctly.

### Problem Analysis

`SKILL.md` plus `name:`/`description:` frontmatter is not a neutral filename. It is the contract a host scans for to discover an invocable skill. Protocols are defined by *not* being that: AGENTS.md describes them as "not discoverable — delivered by path reference."

Measured, the shape is empty of its own meaning:

| | count |
|---|---|
| Protocol entries under `.agents/protocols/` | 33 |
| In `<name>/SKILL.md` form | 32 |
| Of those, starting with frontmatter | **2** (`archive`, `design-system-builder`) |
| Of those, with no frontmatter at all — a bare body in a `SKILL.md` file | **30** |
| Flat `<name>.md`, with proper frontmatter | 1 (`refine_feature.md`) |

Nothing consumes the shape. `ClaudeCodeMirrorService` dynamically scans `.agents/skills/` (`:301-305`) and never `.agents/protocols/` — the word "protocols" appears in that file once, in a comment recording that these files were moved *out*. There is no glob, no crawl, no enumeration anywhere in `src/` or `scripts/`: all ~178 references name their file by explicit full path. `.vscodeignore:57` is a blanket `!.agents/**`, so packaging is shape-independent, and `vsix-packaging-contract.test.js:231` walks the directory recursively, so it is shape-agnostic too.

So the two frontmatter blocks are inert, and the `SKILL.md` filename advertises a discoverability that is deliberately absent.

### Root Cause

A completed plan in this directory, `audit-agent-skills-structure.md`, converted flat `skills/foo.md` → `skills/foo/SKILL.md` for an explicit reason: the flat files "are invisible to Antigravity discovery." Discovery was the whole point of the shape. The same plan deliberately exempted the button-only backend hooks — *"Keep the **deliberately-unregistered backend hooks** (`refine_ticket`, `refine_feature`) flat"* — because a file nothing discovers has no use for a discoverable shape.

These 32 were then reclassified as protocols and moved to `.agents/protocols/`, which made every one of them a deliberately-unregistered hook. The exemption's own logic now covers the entire directory. The shape was not re-examined because the move preserved paths mechanically.

**The consequence is that the exception looks like the error.** `refine_feature.md` is the one file whose shape matches its role, and it reads as the anomaly — earlier in this programme it was described as "the only protocol whose declared location is a lie" and slated for normalisation *into* the vestigial shape. Flattening the other 32 removes the trap rather than documenting it.

## Metadata

**Complexity:** 5
**Tags:** refactor, docs, reliability

## User Review Required

- **This plan and `protocols-as-db-rows-not-scaffolded-files.md` partially overlap and should not both be built.** That plan deletes these files entirely, moving their bodies into `control_plane` rows. Flattening 32 files and then deleting all 32 is wasted work. Choose one:
  - **Rows deferred or uncertain** → do this. It is cheap, self-contained, and makes the directory legible now.
  - **Rows imminent** → skip this, and carry one sentence into that plan's seeding step: the crawl handles both shapes, and no file is reshaped to suit it.
  The recommendation is to decide this before either is scheduled, not to sequence them.
- Confirm the two frontmatter blocks (`archive`, `design-system-builder`) should be dropped rather than preserved (see Proposed Changes item 3).

## Complexity Audit

### Routine

- 32 `git mv .agents/protocols/<name>/SKILL.md .agents/protocols/<name>.md` operations, then removing the emptied directories.
- Rewriting the reference sites, which are concentrated: `agentPromptBuilder.ts` (29), `tickets.js` (14), `PlanningPanelProvider.ts` (9), `TaskViewerProvider.ts` (8), `KanbanProvider.ts` (7), `externalAgentPrompts.ts` (4), `SparkContextExporter.ts` (2), plus single sites in `planning.js`, `sharedDefaults.js`, `bootstrap.ts`, `DesignPanelProvider.ts`.

### Complex / Risky

- **~178 references across 30 files, and 14 of those files are tests.** `planner-workflow-path-migration.test.js` (16), `minimal-prompt.test.js` (15), `agentPromptBuilder.test.ts` (7), `prompt-split-guidance-sync.test.js` (4), `orchestrator-tick-and-reports-contract.test.js` (4), `spark-context-exporter-contract.test.js` (4), `vsix-packaging-contract.test.js` (4), `kanban-default-prompt-previews.test.js` (3), and six more. Several byte-pin emitted prompt text, so they fail as designed and must be updated deliberately rather than mass-replaced.
- **Persisted user config names these paths, and this is the migration.** `DEFAULT_PLANNER_WORKFLOW` and `DEFAULT_FEATURE_PLANNER_WORKFLOW` are config *defaults*, so a user's stored `planner.workflowPath` may hold `.agents/protocols/improve-plan/SKILL.md` literally. `RETIRED_WORKFLOW_PATH_MAP` (`agentPromptBuilder.ts:1470-1489`) already carries three generations of this exact problem — `.agents/workflows/*.md`, `.agents/skills/*/SKILL.md`, and the `.switchboard/protocols/` detour — and needs a fourth. Note it maps only the four user-reachable protocols (`improve-plan`, `improve-feature`, `accuracy`, `switchboard-orchestrator`), not all 32, so the migration is four entries, not thirty-two.
- **Four protocol bodies cross-reference other protocols by path** — `switchboard-contracts/SKILL.md` (4 references), `terminal-coder-dispatch/SKILL.md` (2), `switchboard-orchestrator/SKILL.md`, `switchboard-orchestration/SKILL.md`. These are content, not code: a stale path here hands an agent a file that does not exist and fails silently, with the agent either reporting a missing file or proceeding without the instructions.
- **13 protocols are delivered by clipboard** from `tickets.js`, where the body is inlined rather than pathed. Those 14 references are to source locations for building the prompt, so they change, but the emitted text should not — verify the emitted clipboard payload is byte-identical where it does not name a path.
- **`git mv` for all 32** to preserve history. A copy-and-delete loses provenance on files that carry design rationale in their comments.
- **User-edited protocol files.** Users can edit these; a flatten orphans an edit at the old path. Unlike the shrink plan this is a real file move on a published extension, so each old path must be checked and, if it holds content differing from the bundled version, preserved as `<name>/SKILL.md.migrated.bak` rather than removed.

## Edge-Case & Dependency Audit

**Migration.** Four `RETIRED_WORKFLOW_PATH_MAP` entries for the user-reachable protocols; `.migrated.bak` preservation for any locally-edited file. Both follow the pattern the map already establishes, so this is an extension of existing machinery, not new machinery.

**Packaging.** Safe and needs no change: `.vscodeignore:57` negates `.agents/**` recursively, and the packaging contract test walks recursively.

**Security.** Neutral. No path leaves the workspace; no new user-supplied path is resolved.

**Ordering.** Must land **after** `shrink-the-injected-agent-protocol-block.md`. That plan deletes the `CLAUDE.md`/`AGENTS.md` lines asserting `.agents/protocols/<name>/SKILL.md`. If this plan lands first, those lines become false for all 33 files instead of one, and the injected block ships a wrong shape claim to every user until the shrink lands. If the shrink lands first, nothing documents a shape and the move is invisible to agents.

**Side effects.** The `.claude/skills` mirror is unaffected — it scans `.agents/skills/`, not protocols — so `mirror:check` should not fire. Confirm rather than assume: if it does fire, the mirror is reading protocols somewhere this audit missed.

## Dependencies

- **Requires** `shrink-the-injected-agent-protocol-block.md` to land first, for the reason above.
- **Reduced by** `remove-dead-agent-singular-fallback-paths.md`: nine reference sites are deleted there rather than rewritten here.
- **Conflicts with** `protocols-as-db-rows-not-scaffolded-files.md` — see User Review Required. Build one, not both.

## Adversarial Synthesis

**"The shape is harmless — this is churn."** It is not harmless: it is actively misleading, and this session has the evidence. The vestigial shape caused a documented-contract claim to be written into every user's `CLAUDE.md`, then caused the one correctly-shaped file to be diagnosed as the defect and slated for conversion into the wrong shape. A convention that makes the correct case look broken is a bug in the convention.

**"Then just fix the docs and leave the files."** The shrink plan already deletes the docs. That removes the false statement but leaves the shape, so the next reader re-derives the same wrong conclusion from the filenames alone — which is exactly how this arose, since the filenames were the evidence, not the docs.

**"32 moves and 178 edits for a naming preference."** The edits are concentrated in ten source files and are mechanical; the genuine work is the four migration entries and the test updates, both of which follow an established pattern. If that still does not clear the bar, the honest answer is not to do a cheaper version — it is to build the rows plan instead, which subsumes it.

**"Preserve the two frontmatter blocks — they might be used later."** They are inert today because nothing scans the directory. Keeping a `description:` on a file no host reads is the same error one level down: a marker of discoverability on something undiscoverable.

## Proposed Changes

1. **`git mv` all 32** `.agents/protocols/<name>/SKILL.md` → `.agents/protocols/<name>.md`; remove the emptied directories. `refine_feature.md` is already correct and is not touched.
2. **Rewrite the reference sites** across the ten source files and fourteen test files, plus the four protocol bodies that cross-reference other protocols by path.
3. **Drop the two inert frontmatter blocks** from `archive` and `design-system-builder`, keeping their bodies. `refine_feature.md` keeps its frontmatter, which is genuinely used as the dispatch description.
4. **Add four `RETIRED_WORKFLOW_PATH_MAP` entries** mapping `.agents/protocols/<name>/SKILL.md` → `.agents/protocols/<name>.md` for `improve-plan`, `improve-feature`, `accuracy`, `switchboard-orchestrator`.
5. **Preserve local edits**: for each moved file, if the old path's content differs from the bundled version, write `<name>/SKILL.md.migrated.bak` rather than deleting.
6. **Record the convention** in one place — flat `.md` under `.agents/protocols/` means path-delivered and undiscoverable; `<name>/SKILL.md` under `.agents/skills/` means host-discoverable. Not in the injected block, which is being emptied.

### Migration

Four retired-path entries plus `.migrated.bak` preservation for locally-edited files. No DB or config schema change.

## Verification Plan

### Goal Invariants

- `.agents/protocols/` contains 33 flat `.md` files and zero subdirectories.
- No occurrence of `protocols/<anything>/SKILL.md` remains in `src/`, `scripts/`, or any `.agents/` body.
- Every protocol named by any consumer resolves to an existing file.

### Automated Tests

- **Shape gate:** assert `.agents/protocols/` contains no subdirectory and no file named `SKILL.md`. This is the invariant that prevents the shape returning with the next added protocol.
- **Every referenced path resolves:** extract every `.agents/protocols/...` string literal from `src/`, `scripts/` and the protocol bodies, and assert each names an existing file. This is the test whose absence let the `refine_feature` shape mismatch persist, and it catches the cross-reference class the grep gate cannot.
- **Retired-path migration:** for each of the four mapped protocols, assert a persisted `workflowFilePath` at the old `<name>/SKILL.md` path resolves to the new flat path. Assert also that the three pre-existing generations still resolve — the regression risk is appending to that map, not the new entry.
- **Packaging unchanged:** `vsix-packaging-contract.test.js` passes unmodified. If it needs editing, the recursive walk assumption was wrong and the packaging claim in this plan is wrong with it.
- **Mirror unaffected:** `mirror:check` passes with no `.claude/skills` regeneration. A failure here means something reads protocols that this audit missed.
- **Emitted prompts unchanged except paths:** the prompt-pinning tests (`minimal-prompt.test.js`, `agentPromptBuilder.test.ts`, `kanban-default-prompt-previews.test.js`, `prompt-split-guidance-sync.test.js`) pass after path-only updates. Any change beyond a path is a defect in this plan, not an expected diff.
- **Clipboard payloads unchanged:** for the 13 clipboard-delivered protocols, assert the emitted text is byte-identical where it does not name a path.
- **Local-edit preservation:** stage a workspace with a modified protocol file; assert a `.migrated.bak` exists after the move and no content is lost.
- **`_lib` references stay root-anchored:** assert no protocol body sources `_lib` via a relative path (`../`). All current references anchor to `$CUR` or the git toplevel, which is why this move is depth-safe; the gate keeps it that way.

### Manual Verification

- Click Refine on a feature with zero subtasks and on one with subtasks; confirm both dispatch and read their protocol.
- Copy one clipboard protocol from the Tickets Agent API modal and confirm the payload is unchanged.

## Outstanding Questions

- **[user]** Build this, or the rows plan? They overlap and both should not ship.
- Do any of the 33 protocols reference a *sibling* by relative path rather than workspace-relative? A relative reference survives a flatten differently from an absolute one, and the four known cross-references need reading before the move, not after.
- **Resolved — no `_lib` depth hazard.** `_lib` is referenced in at least 10 protocol bodies (the ClickUp/Linear/Notion proxies, `get-tickets`, `generate-diagram`), but every reference is **workspace-root-anchored, not file-relative**: `source "$CUR/.agents/skills/_lib/sb_api_call.sh"`, and in one case `source "$(git rev-parse --show-toplevel)/.agents/skills/_lib/sb_api_call.sh"`. Depth-independent, so flattening cannot break them. The audit plan's warning applied to the original conversion because that move changed which directory the file sat in relative to `_lib`; anchoring to the root is what makes this move safe, and it is worth asserting so a future body written with a relative path is caught.
