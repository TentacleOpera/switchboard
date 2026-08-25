# Delete the dead `.agent/` fallback paths, keep the `.agent/` migration

## Goal

Remove eleven runtime file-resolution fallbacks that point into a `.agent/` (singular) directory at locations that never held the files they name, while leaving intact the five sites that legitimately detect, read, or clean up a pre-rename user workspace.

> **Superseded:** "nine runtime file-resolution fallbacks … the four sites that legitimately"
> **Reason:** the two sites this plan left unclassified are now settled by history rather than by guess (see Root Cause). `.agent/AGENTS.md` and `.agent/plan-authoring-protocol.md` never existed in any commit, making them the tenth and eleventh dead entries; `.agent/personas/` did exist and is the fifth retained site.
> **Replaced with:** eleven dead entries, five retained sites.

### Problem Analysis

`.agent/` is the pre-rename form of `.agents/`. It does not exist in this repo and should not — that part is already true. What exists is ten-odd references to it in `src/`, and they are not one thing. They divide cleanly, and the division is the whole plan.

**Legitimate — keep.** Three mechanisms serve users who still have the old directory, which the project's install base (~4,000 installs, many on older versions) makes mandatory:
- `extension.ts:3759-3776` — `hasSwitchboardProtocolFiles` treats `.agent/workflows/` as evidence of a configured workspace so setup does not re-scaffold over a pre-rename install.
- `SetupPanelProvider.ts:1842` and `:1931` — the "CLEAN UP SELECTED SCAFFOLDING" scan reports a leftover `.agent/` dir and offers to delete it. This is the user-facing path that removes the directory; deleting the code would strand it forever.
- `TaskViewerProvider._getPersonaForRole` (`:23275`) — reads a legacy persona from `.agent/personas/`. **Load-bearing, and the one retained site that reads a legacy *asset* rather than detecting or migrating one.** `.agent/personas/` genuinely existed (9 files across 7 commits: `coder.md`, `grumpy.md`, `intern.md`, `lead_coder.md`, `lead_developer.md`, `planner.md`, `researcher.md`, `reviewer.md`, `switchboard_operator.md`), personas are user-editable, and — decisively — **`.agents/personas/` is not seeded on activation** (see Root Cause), so a legacy workspace that never re-runs the Setup wizard has personas at the legacy path only.
- `TaskViewerProvider._normalizeAgentToAgents` (`:2686`) — rewrites a leading `.agent/` to `.agents/` in persisted `workflowFilePath` config, gated by the `switchboard.plannerWorkflowPathAgentToAgents.v1` flag. Chained with `RETIRED_WORKFLOW_PATH_MAP` (`agentPromptBuilder.ts:1478`) this gives persisted config a complete path: `.agent/skills/X/SKILL.md` → `.agents/skills/X/SKILL.md` → `.agents/protocols/X/SKILL.md`.

**Dead — delete.** Nine entries in `skillPaths`-style `[current, legacy]` arrays, a different mechanism from the config chain above: they are runtime candidate lists tried in order when reading a file.

| Site | Legacy path named |
|---|---|
| `externalAgentPrompts.ts:57` | `.agent/workflows/switchboard-memo.md` |
| `externalAgentPrompts.ts:68` | `.agent/skills/improve-plan/SKILL.md` |
| `externalAgentPrompts.ts:79` | `.agent/skills/improve-plan/SKILL.md` |
| `externalAgentPrompts.ts:90` | `.agent/skills/improve-feature/SKILL.md` |
| `PlanningPanelProvider.ts:5084` | `.agent/skills/improve-feature/SKILL.md` |
| `PlanningPanelProvider.ts:5085` | `.agent/skills/refine_feature.md` |
| `SparkContextExporter.ts:182` | `.agent/skills/improve-plan/SKILL.md` |
| `SparkContextExporter.ts:189` | `.agent/skills/improve-feature/SKILL.md` |
| `SparkContextExporter.ts:196` | `.agent/workflows/switchboard-memo.md` |
| `SparkContextExporter.ts:145` | `.agent/plan-authoring-protocol.md` — newly classified |
| `SparkContextExporter.ts:147` | `.agent/AGENTS.md` — newly classified |

### Root Cause

These are **doubly stale**, which is why they are dead rather than merely redundant. Each encodes two superseded facts at once: the old directory name (`.agent/`) *and* the old classification (`skills/`, when the content is now a protocol). A user's pre-rename workspace would have had `.agent/skills/` holding files that were skills *at that time* — but the fallback is consulted by today's code looking for today's protocol content, so the only workspace it could satisfy is one that never existed: old directory name, new file organisation.

They were added as defensive `[current, legacy]` pairs during the rename, then carried through two further relocations (`skills/` → `protocols/`, and the brief `.switchboard/protocols/` detour) without anyone re-asking whether the legacy half still described a real state. A fallback that cannot fire is not free: it is read as evidence that a location is supported.

**Verified per path, not inferred.** On a full (non-shallow) clone, `git log --all -- <path>` gives a per-entry verdict. Every deleted entry names a path with **zero** commits in the entire history; the retained persona path has seven:

| Legacy path | Commits touching it | Verdict |
|---|---|---|
| `.agent/skills/improve-plan/SKILL.md` | 0 | dead |
| `.agent/skills/improve-feature/SKILL.md` | 0 | dead |
| `.agent/skills/refine_feature.md` | 0 | dead |
| `.agent/workflows/switchboard-memo.md` | 0 | dead |
| `.agent/AGENTS.md` | 0 | dead |
| `.agent/plan-authoring-protocol.md` | 0 | dead |
| `.agent/personas/*` | 7 | **real — keep** |

What `.agent/` actually held is the proof of the doubly-stale claim: `.agent/workflows/` carried `improve-plan.md`, `accuracy.md`, `archive.md`, `challenge.md`, `handoff*.md`; `.agent/skills/` carried `apply_patch/`, `archive.md`, `complexity_scoring.md`, `fix_plans_dropdown/`, `gemini_interactive/`, `get_kanban_state/`. So `improve-plan` did exist under `.agent/` — as `workflows/improve-plan.md`, never as `skills/improve-plan/SKILL.md`. The fallback names the file under the directory *name* it had in one era and the *layout* it acquired in another. No workspace ever had both.

**Seeding does not rescue these paths, and is not the argument for deleting them.** Worth recording because it is easy to get backwards: activation (`refreshWorkspaceControlPlane`, `extension.ts:328`, called at `:851`) seeds **skills and workflows only** — confirmed three ways: its two crawl loops (`:342`, `:387`), the `pruneRetiredBundleFiles` contract (*"skills + workflows, blocklist already excluded by the caller's crawl scope"*, `ControlPlaneMigrationService.ts:1165-1166`), and the on-disk ledger `.agents/.switchboard-bundled.json`, which lists exactly 18 files and no `personas/` or `protocols/` entry. `scaffoldProtocolLayers` (`:4048`) copies no `.agents/` files at all — it writes the AGENTS.md/CLAUDE.md blocks and regenerates the `.claude/skills` mirror. The full bundled-`.agents/` crawl lives in `performSetup` (`:4318`), whose only live caller is the user-triggered `switchboard.setup` command (`:4469`).

Two consequences. First, `.agents/protocols/` and `.agents/personas/` are absent on a legacy workspace until the user re-runs Setup — which is precisely why the persona fallback is retained. Second, any "the fallback can't fire because seeding fills the primary" reasoning is false here; the deletions stand on the history table above, which needs no assumption about seeding at all.

## Metadata

**Complexity:** 2
**Tags:** refactor, reliability, docs

## User Review Required

- Confirm the classification above, in particular that the `SetupPanelProvider` cleanup scan is the intended way a user removes a leftover `.agent/` and must be preserved.

> **Superseded:** "Two sites are **not** classified here and are left untouched pending a decision … `SparkContextExporter.ts:131` (`.agent/AGENTS.md`) and `TaskViewerProvider.ts:23060` (`.agent/personas/`)."
> **Reason:** both are now settled by the history table in Root Cause, which is evidence rather than the guess this bullet was avoiding. `.agent/AGENTS.md` has zero commits — dead, deleted. `.agent/personas/` has seven and is not seeded on activation — real, retained. A third entry the bullet did not name, `.agent/plan-authoring-protocol.md`, is also dead by the same test.
> **Replaced with:** nothing outstanding. Both sites are classified in the table above.

## Complexity Audit

### Routine

- Deleting eleven array entries and collapsing any now-single-element candidate array to a direct path.
- Removing the `skillRelPathLegacy` local in `PlanningPanelProvider.ts:5084-5085` once its two entries go.

### Complex / Risky

- **A candidate array that becomes single-element must not silently change resolution semantics.** `skillPaths` consumers iterate and take the first readable file; with one entry the "not found" branch becomes the only alternative. Verify each consumer still has a defined behaviour when the single path is missing — `PlanningPanelProvider.ts:5100` has `fallbackContent`, but the other consumers must be checked individually rather than assumed to match.
- **`externalAgentPrompts.ts` and `SparkContextExporter.ts` serve external/remote surfaces**, where a missing file cannot be recovered by the user opening a different tab. These are the two sites where an over-eager deletion is least visible, so each needs its absent-file path exercised, not just its happy path.
- **Do not touch `_normalizeAgentToAgents` or `RETIRED_WORKFLOW_PATH_MAP`.** They look like the same cleanup and are not: they migrate *persisted user config*, and the migration flag means a user who has not yet activated on a new version still needs them. Deleting them silently breaks a stored `workflowFilePath`.

## Edge-Case & Dependency Audit

**Migration.** None required. No user state names these eleven paths — persisted config is handled by the normalizer chain, which is untouched. This is the rare case where a deletion needs no migration precisely because a *different* mechanism owns the compatibility.

**Security.** Mildly positive: eleven fewer filesystem candidate paths read at runtime, and one fewer place where a legacy directory name appears to be honoured.

**Side effects.** `SparkContextExporter` output shrinks slightly if any emitted text enumerated candidate paths — verify against `spark-context-exporter-contract.test.js`, which pins that output.

**Ordering.** Independent of the protocol-shape work. Doing this first is cheaper: it removes eleven of the paths that would otherwise need rewriting there.

## Dependencies

- **Reduces** the work in the protocol-relocation line of plans: eleven of their reference sites are deleted here rather than rewritten.

> **Superseded:** `flatten-protocols-out-of-the-skill-shape.md`
> **Reason:** no plan of that name exists in `.switchboard/plans/`. The live successors are `move-protocols-out-of-skill-discovery.md` (itself superseded on destination) and `protocols-as-db-rows-not-scaffolded-files.md`. Naming a nonexistent plan as a dependency sends a reader looking for a file that was never there.
> **Replaced with:** the generic reference above; `protocols-as-db-rows-not-scaffolded-files.md` is the one to sequence against, and this plan should land first for the reason stated under Ordering.
- Otherwise independent.

## Adversarial Synthesis

**"A dead fallback is harmless — leave it."** It is not inert: it documents a supported location. This session reached the wrong conclusion twice by reading a path list as evidence of what is supported, and the plan for the protocol move nearly carried a fallback to `.agent/skills/` forward on that basis. The cost of the deletion is one commit; the cost of keeping it is every future reader re-deriving that it cannot fire.

**"Deleting a fallback risks breaking a legacy install."** That is the right instinct and is why the four migration sites stay. The distinction is mechanism, not sentiment: the migration sites read *the user's actual directory*, the deleted entries read a path that would only exist in a workspace with an old directory name and a new file layout.

**"Just normalise the legacy paths instead of deleting them."** Rewriting `.agent/skills/improve-plan/SKILL.md` to `.agents/protocols/improve-plan/SKILL.md` makes the entry a duplicate of the first element in the same array. The correct simplification of a two-element array whose elements are equal is a one-element array.

## Proposed Changes

1. **Delete the eleven legacy entries** listed in the table, and the `skillRelPathLegacy` local that exists only to hold two of them.
2. **Collapse single-element candidate arrays** to a direct path where the consumer allows it, preserving each consumer's existing absent-file behaviour.
3. **Leave untouched**: `extension.ts:3759-3776`, `SetupPanelProvider.ts:1829`/`:1931`, `_normalizeAgentToAgents`, `RETIRED_WORKFLOW_PATH_MAP`, and the two unclassified sites.
4. **Add a comment at each retained migration site** naming it as deliberate legacy-workspace support, so the next cleanup pass does not delete it. This is the cheap half of the fix: the reason these were indistinguishable is that nothing said which was which.

### Migration

None. Persisted config compatibility is owned by the untouched normalizer chain.

## Verification Plan

### Goal Invariants

- No occurrence of `.agent/skills`, `.agent/workflows`, `.agent/AGENTS.md` or `.agent/plan-authoring-protocol.md` remains anywhere in `src/`.
- `.agent/personas` **is still present** at `TaskViewerProvider.ts:23275`. The grep gate below must assert this rather than sweep it up — a gate written as "no `.agent/` in src" would delete a load-bearing read on its next run.
- The four migration sites are present and each carries a comment naming it as intentional.
- A pre-rename workspace containing only `.agent/workflows/` is still detected as configured, and still offered for cleanup.

### Automated Tests

- **Grep gate:** assert `src/**` contains no `.agent/skills`, `.agent/workflows`, `.agent/AGENTS.md` or `.agent/plan-authoring-protocol.md` string, **and** that `.agent/personas` is still matched exactly once. Both halves are the invariant: the first stops the dead pairs being reintroduced by the next defensive edit, the second stops the next cleanup pass deleting the persona read.
- **Legacy detection survives:** construct a workspace with `.agent/workflows/` and no `.agents/`; assert `hasSwitchboardProtocolFiles` returns true.
- **Cleanup scan survives:** construct a workspace with a `.agent/` dir; assert the cleanup scan reports it as present and deletable.
- **Persona fallback survives:** construct a workspace with `.agent/personas/coder.md` and **no** `.agents/personas/`; assert `getPersonaForRole` returns that content. This is the one deletion-adjacent behaviour with a silent failure mode — `_getPersonaForRole` returns `undefined`, so a regression drops a persona block from a dispatched prompt with no error anywhere.
- **Config normalizer untouched:** assert a persisted `workflowFilePath` of `.agent/skills/improve-plan/SKILL.md` still resolves to `.agents/protocols/improve-plan/SKILL.md` end-to-end. `planner-workflow-path-migration.test.js` already covers the normalizer in isolation (`:127-128`); this asserts the full chain including `RETIRED_WORKFLOW_PATH_MAP`.
- **Absent-file behaviour per consumer:** for each of the three touched files, remove the single remaining path and assert the consumer's defined fallback runs — `fallbackContent` for the feature-refine dispatch, and whatever each of the other two does. Do not share one assertion across all three.
- **Spark output unchanged:** `spark-context-exporter-contract.test.js` passes without modification, or its diff is reviewed deliberately.

### Manual Verification

- On a scratch workspace with a real `.agent/` directory: setup does not re-scaffold, and the cleanup button removes it.

## Outstanding Questions

> **Superseded:** all three questions below.
> **Reason:** each is answerable from the repository rather than by a decision, and all three were checked. Left standing they invite a second guess at something now settled.

**Resolved — `.agent/AGENTS.md` (was: was AGENTS.md ever written inside `.agent/`?).** Never, in any commit. It is the tenth dead entry, deleted. `.agent/plan-authoring-protocol.md` — not named in the original question — is the eleventh by the same test. The root-level `AGENTS.md` candidate in the same `resolveSourceFile` list **stays**: the comment at `SparkContextExporter.ts:138-149` documents it as load-bearing for a workspace scaffolded by an older release that has the fat `AGENTS.md` and no `plan-authoring-protocol.md`, and it is not a `.agent/` path.

**Resolved — `.agent/personas/` (was: keep, or migrate-then-retire?).** Keep, unchanged. Seven commits touched it and nine persona files lived there. The question's instinct — "this looks like genuine migration but has no cleanup path" — was right on the first half and wrong to worry about the second: the cleanup path is the Setup-tab button, which removes the whole `.agent/` directory once `.agents/` exists. What makes it load-bearing rather than merely historical is that `.agents/personas/` is not seeded on activation, so the legacy read is the only source until the user re-runs Setup. Migrate-then-retire would need a persona-specific import first, which is a different plan and not worth opening for it.

**Resolved — do any touched files emit their candidate list into agent-read text?** No. `composeExternalPrompt` (`externalAgentPrompts.ts:13`) composes the prompt from the resolved file's *content*, never from the candidate paths, and `SparkContextExporter` writes no candidate path into the artifact (its `content +=` sites carry no resolved path). The lists surface only in two `console.warn` calls on total-miss — `SetupPanelProvider.ts:380` and `PlanningPanelProvider.ts:5111` — whose text is a diagnostic, not agent input. So this is a resolution-only change: no emitted output shrinks, and `spark-context-exporter-contract.test.js` should pass with no diff to review.
