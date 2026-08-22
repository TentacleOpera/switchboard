# Flatten the 30 non-user-facing protocols out of the skill shape

## Goal

> **MERGED into `protocols-as-db-rows-not-scaffolded-files.md` — do not build separately.** The two ship together, and together they overlap almost entirely: the 30 files this plan would `git mv` are the same ones the rows plan converts to DB rows, so flattening them is work on files that cease to exist. The reference rewrite — the expensive half — happens once, in the rows plan, to resolver calls rather than to flat paths.
>
> What survives from here is already recorded in the rows plan: the two committed survivors keep `<name>/SKILL.md` deliberately (their paths are user-editable field defaults), the seeding crawl reads both shapes because `refine_feature.md` is flat, and no source file is reshaped to suit the crawl. Retained for the measurements — 2.9% of script lines, 47 tab-namespaced identifiers, the root-anchored `_lib` finding, packaging safety via `!.agents/**`.


Stop 30 non-discoverable protocol files from occupying the `<name>/SKILL.md` convention that exists solely for host skill discovery, by flattening them to `.agents/protocols/<name>.md` — the shape `refine_feature.md` already uses correctly. `improve-plan` and `improve-feature` are explicitly **excluded**; see Scope below.

### Scope: why `improve-plan` and `improve-feature` keep their directory shape

An earlier revision of this plan covered all 32 and offered the reader a choice between this plan and `protocols-as-db-rows-not-scaffolded-files.md`. That framing was wrong on both counts — the two plans are not alternatives, and the scope is not 32.

The rows plan establishes that these two are **the default values of a user-editable path field**: `kanban.html:3464` exposes `workflowFilePath` as a text input defaulting to `.agents/protocols/improve-plan/SKILL.md`, with a `Validate` button beside it, presented as an equal to third-party paths like `.claude/get-shit-done/agents/gsd-planner.md`. `plannerFeatureWorkflowFilePath` (`:3568`) is the same for features.

That makes their path part of a user-facing contract surface, not an internal detail. Flattening them would change a string a user sees in a settings field, invalidate a manually-typed value, and require a settings migration — for zero benefit, since the shape argument in this plan is about files nothing discovers *and nothing exposes*. These two are exposed. They stay as `<name>/SKILL.md`.

This is also why the two plans do not conflict: the rows plan keeps exactly these two committed as files and converts the other 31 to rows. The shape question therefore divides along the same line the rows plan already draws — the 30 with no user-facing surface, plus `refine_feature` which is already flat.

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

**Complexity:** 4
**Tags:** refactor, docs, reliability

## User Review Required

- **Cancel this plan if the rows plan is scheduled — do not sequence them.** The two are not alternatives in scope (see Scope above) but they are alternatives in *work*: the expensive part of this plan is rewriting the reference sites, and the rows plan rewrites the same sites again to `resolveProtocol(name)` calls. Doing both means doing that twice. The file moves are near-free `git mv`s; the references are the cost. So:
  - **Rows scheduled** → cancel this. Carry two sentences into the rows plan: the seeding crawl reads both shapes, and no source file is reshaped to suit it.
  - **Rows shelved or uncertain** → build this. It is the standalone form of the same correction, and after it the survivors' shape is settled by the Scope section above rather than left open.
  This is a scheduling consequence of one decision you already own — whether the rows plan is in the storage programme's near queue — not a second decision.
- Confirm the two frontmatter blocks (`archive`, `design-system-builder`) should be dropped rather than preserved (see Proposed Changes item 3).

## Complexity Audit

### Routine

- 30 `git mv .agents/protocols/<name>/SKILL.md .agents/protocols/<name>.md` operations, then removing the emptied directories. `improve-plan/` and `improve-feature/` are untouched; `refine_feature.md` is already flat.
- Rewriting the reference sites, which are concentrated: `agentPromptBuilder.ts` (29), `tickets.js` (14), `PlanningPanelProvider.ts` (9), `TaskViewerProvider.ts` (8), `KanbanProvider.ts` (7), `externalAgentPrompts.ts` (4), `SparkContextExporter.ts` (2), plus single sites in `planning.js`, `sharedDefaults.js`, `bootstrap.ts`, `DesignPanelProvider.ts`.

### Complex / Risky

- **~178 references across 30 files, and 14 of those files are tests.** `planner-workflow-path-migration.test.js` (16), `minimal-prompt.test.js` (15), `agentPromptBuilder.test.ts` (7), `prompt-split-guidance-sync.test.js` (4), `orchestrator-tick-and-reports-contract.test.js` (4), `spark-context-exporter-contract.test.js` (4), `vsix-packaging-contract.test.js` (4), `kanban-default-prompt-previews.test.js` (3), and six more. Several byte-pin emitted prompt text, so they fail as designed and must be updated deliberately rather than mass-replaced.
- **Persisted user config names two of the moved paths.** `RETIRED_WORKFLOW_PATH_MAP` (`agentPromptBuilder.ts:1470-1489`) maps four protocols reachable from `planner.workflowPath`: `improve-plan`, `improve-feature`, `accuracy`, `switchboard-orchestrator`. The first two are out of scope here, so this plan adds **two** entries, for `accuracy` and `switchboard-orchestrator` — a user may have either persisted from when they were workflow paths. Excluding the user-facing pair is what shrinks this from a settings-migration problem to a two-line map append; the map already carries three generations of the same problem and the new entries follow that pattern exactly.
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
- **Subsumed by** `protocols-as-db-rows-not-scaffolded-files.md` on work, not scope: that plan rewrites the same reference sites to resolver calls, so running both rewrites them twice. It also settles the survivors' shape the same way this plan does — the two files it keeps committed are the two this plan excludes. Cancel this if that one is scheduled; see User Review Required.

## Adversarial Synthesis

**"The shape is harmless — this is churn."** It is not harmless: it is actively misleading, and this session has the evidence. The vestigial shape caused a documented-contract claim to be written into every user's `CLAUDE.md`, then caused the one correctly-shaped file to be diagnosed as the defect and slated for conversion into the wrong shape. A convention that makes the correct case look broken is a bug in the convention.

**"Then just fix the docs and leave the files."** The shrink plan already deletes the docs. That removes the false statement but leaves the shape, so the next reader re-derives the same wrong conclusion from the filenames alone — which is exactly how this arose, since the filenames were the evidence, not the docs.

**"32 moves and 178 edits for a naming preference."** The edits are concentrated in ten source files and are mechanical; the genuine work is the four migration entries and the test updates, both of which follow an established pattern. If that still does not clear the bar, the honest answer is not to do a cheaper version — it is to build the rows plan instead, which subsumes it.

**"Preserve the two frontmatter blocks — they might be used later."** They are inert today because nothing scans the directory. Keeping a `description:` on a file no host reads is the same error one level down: a marker of discoverability on something undiscoverable.

## Proposed Changes

1. **`git mv` the 30** in-scope `.agents/protocols/<name>/SKILL.md` → `.agents/protocols/<name>.md`; remove the emptied directories. `improve-plan/` and `improve-feature/` are excluded per Scope; `refine_feature.md` is already correct.
2. **Rewrite the reference sites** across the ten source files and fourteen test files, plus the four protocol bodies that cross-reference other protocols by path.
3. **Drop the two inert frontmatter blocks** from `archive` and `design-system-builder`, keeping their bodies. `refine_feature.md` keeps its frontmatter, which is genuinely used as the dispatch description.
4. **Add two `RETIRED_WORKFLOW_PATH_MAP` entries** mapping `.agents/protocols/<name>/SKILL.md` → `.agents/protocols/<name>.md` for `accuracy` and `switchboard-orchestrator`. No entry for `improve-plan`/`improve-feature` — they are not moved.
5. **Preserve local edits**: for each moved file, if the old path's content differs from the bundled version, write `<name>/SKILL.md.migrated.bak` rather than deleting.
6. **Record the convention** in one place — flat `.md` under `.agents/protocols/` means path-delivered and undiscoverable; `<name>/SKILL.md` under `.agents/skills/` means host-discoverable. Not in the injected block, which is being emptied.

### Migration

Four retired-path entries plus `.migrated.bak` preservation for locally-edited files. No DB or config schema change.

## Verification Plan

### Goal Invariants

- `.agents/protocols/` contains 31 flat `.md` files and exactly two subdirectories: `improve-plan/` and `improve-feature/`. Asserting the two survivors *positively* matters as much as asserting the flatness — a later cleanup reading the invariant as "flatten everything" would break the user-facing default paths.
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

- **[user]** Is the rows plan in the storage programme's near queue? That single answer decides whether this plan is built or cancelled — no separate decision needed, and the scope question it used to carry is now settled in Scope above.
- Do any of the 33 protocols reference a *sibling* by relative path rather than workspace-relative? A relative reference survives a flatten differently from an absolute one, and the four known cross-references need reading before the move, not after.
- **Resolved — no `_lib` depth hazard.** `_lib` is referenced in at least 10 protocol bodies (the ClickUp/Linear/Notion proxies, `get-tickets`, `generate-diagram`), but every reference is **workspace-root-anchored, not file-relative**: `source "$CUR/.agents/skills/_lib/sb_api_call.sh"`, and in one case `source "$(git rev-parse --show-toplevel)/.agents/skills/_lib/sb_api_call.sh"`. Depth-independent, so flattening cannot break them. The audit plan's warning applied to the original conversion because that move changed which directory the file sat in relative to `_lib`; anchoring to the root is what makes this move safe, and it is worth asserting so a future body written with a relative path is caught.
