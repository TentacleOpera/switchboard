# Delete the dead `.agent/` fallback paths, keep the `.agent/` migration

## Goal

Remove nine runtime file-resolution fallbacks that point into a `.agent/` (singular) directory at locations that never held the files they name, while leaving intact the four sites that legitimately detect or clean up a pre-rename user workspace.

### Problem Analysis

`.agent/` is the pre-rename form of `.agents/`. It does not exist in this repo and should not — that part is already true. What exists is ten-odd references to it in `src/`, and they are not one thing. They divide cleanly, and the division is the whole plan.

**Legitimate — keep.** Three mechanisms serve users who still have the old directory, which the project's install base (~4,000 installs, many on older versions) makes mandatory:
- `extension.ts:3728-3743` — `hasSwitchboardProtocolFiles` treats `.agent/workflows/` as evidence of a configured workspace so setup does not re-scaffold over a pre-rename install.
- `SetupPanelProvider.ts:1829` and `:1931` — the "CLEAN UP SELECTED SCAFFOLDING" scan reports a leftover `.agent/` dir and offers to delete it. This is the user-facing path that removes the directory; deleting the code would strand it forever.
- `TaskViewerProvider._normalizeAgentToAgents` (`:2591`) — rewrites a leading `.agent/` to `.agents/` in persisted `workflowFilePath` config, gated by the `switchboard.plannerWorkflowPathAgentToAgents.v1` flag. Chained with `RETIRED_WORKFLOW_PATH_MAP` (`agentPromptBuilder.ts:1470`) this gives persisted config a complete path: `.agent/skills/X/SKILL.md` → `.agents/skills/X/SKILL.md` → `.agents/protocols/X/SKILL.md`.

**Dead — delete.** Nine entries in `skillPaths`-style `[current, legacy]` arrays, a different mechanism from the config chain above: they are runtime candidate lists tried in order when reading a file.

| Site | Legacy path named |
|---|---|
| `externalAgentPrompts.ts:57` | `.agent/workflows/switchboard-memo.md` |
| `externalAgentPrompts.ts:68` | `.agent/skills/improve-plan/SKILL.md` |
| `externalAgentPrompts.ts:79` | `.agent/skills/improve-plan/SKILL.md` |
| `externalAgentPrompts.ts:90` | `.agent/skills/improve-feature/SKILL.md` |
| `PlanningPanelProvider.ts:5084` | `.agent/skills/improve-feature/SKILL.md` |
| `PlanningPanelProvider.ts:5085` | `.agent/skills/refine_feature.md` |
| `SparkContextExporter.ts:165` | `.agent/skills/improve-plan/SKILL.md` |
| `SparkContextExporter.ts:172` | `.agent/skills/improve-feature/SKILL.md` |
| `SparkContextExporter.ts:179` | `.agent/workflows/switchboard-memo.md` |

### Root Cause

These are **doubly stale**, which is why they are dead rather than merely redundant. Each encodes two superseded facts at once: the old directory name (`.agent/`) *and* the old classification (`skills/`, when the content is now a protocol). A user's pre-rename workspace would have had `.agent/skills/` holding files that were skills *at that time* — but the fallback is consulted by today's code looking for today's protocol content, so the only workspace it could satisfy is one that never existed: old directory name, new file organisation.

They were added as defensive `[current, legacy]` pairs during the rename, then carried through two further relocations (`skills/` → `protocols/`, and the brief `.switchboard/protocols/` detour) without anyone re-asking whether the legacy half still described a real state. A fallback that cannot fire is not free: it is read as evidence that a location is supported.

## Metadata

**Complexity:** 2
**Tags:** refactor, reliability, docs

## User Review Required

- Confirm the classification above, in particular that the `SetupPanelProvider` cleanup scan is the intended way a user removes a leftover `.agent/` and must be preserved.
- Two sites are **not** classified here and are left untouched pending a decision (see Outstanding Questions): `SparkContextExporter.ts:131` (`.agent/AGENTS.md`) and `TaskViewerProvider.ts:23060` (`.agent/personas/`).

## Complexity Audit

### Routine

- Deleting nine array entries and collapsing any now-single-element candidate array to a direct path.
- Removing the `skillRelPathLegacy` local in `PlanningPanelProvider.ts:5083-5085` once its two entries go.

### Complex / Risky

- **A candidate array that becomes single-element must not silently change resolution semantics.** `skillPaths` consumers iterate and take the first readable file; with one entry the "not found" branch becomes the only alternative. Verify each consumer still has a defined behaviour when the single path is missing — `PlanningPanelProvider.ts:5087` has `fallbackContent`, but the other consumers must be checked individually rather than assumed to match.
- **`externalAgentPrompts.ts` and `SparkContextExporter.ts` serve external/remote surfaces**, where a missing file cannot be recovered by the user opening a different tab. These are the two sites where an over-eager deletion is least visible, so each needs its absent-file path exercised, not just its happy path.
- **Do not touch `_normalizeAgentToAgents` or `RETIRED_WORKFLOW_PATH_MAP`.** They look like the same cleanup and are not: they migrate *persisted user config*, and the migration flag means a user who has not yet activated on a new version still needs them. Deleting them silently breaks a stored `workflowFilePath`.

## Edge-Case & Dependency Audit

**Migration.** None required. No user state names these nine paths — persisted config is handled by the normalizer chain, which is untouched. This is the rare case where a deletion needs no migration precisely because a *different* mechanism owns the compatibility.

**Security.** Mildly positive: nine fewer filesystem candidate paths read at runtime, and one fewer place where a legacy directory name appears to be honoured.

**Side effects.** `SparkContextExporter` output shrinks slightly if any emitted text enumerated candidate paths — verify against `spark-context-exporter-contract.test.js`, which pins that output.

**Ordering.** Independent of the protocol-shape work. Doing this first is cheaper: it removes nine of the paths that would otherwise need rewriting there.

## Dependencies

- **Reduces** the work in `flatten-protocols-out-of-the-skill-shape.md`: nine of its reference sites are deleted here rather than rewritten.
- Otherwise independent.

## Adversarial Synthesis

**"A dead fallback is harmless — leave it."** It is not inert: it documents a supported location. This session reached the wrong conclusion twice by reading a path list as evidence of what is supported, and the plan for the protocol move nearly carried a fallback to `.agent/skills/` forward on that basis. The cost of the deletion is one commit; the cost of keeping it is every future reader re-deriving that it cannot fire.

**"Deleting a fallback risks breaking a legacy install."** That is the right instinct and is why the four migration sites stay. The distinction is mechanism, not sentiment: the migration sites read *the user's actual directory*, the deleted entries read a path that would only exist in a workspace with an old directory name and a new file layout.

**"Just normalise the legacy paths instead of deleting them."** Rewriting `.agent/skills/improve-plan/SKILL.md` to `.agents/protocols/improve-plan/SKILL.md` makes the entry a duplicate of the first element in the same array. The correct simplification of a two-element array whose elements are equal is a one-element array.

## Proposed Changes

1. **Delete the nine legacy entries** listed in the table, and the `skillRelPathLegacy` local that exists only to hold two of them.
2. **Collapse single-element candidate arrays** to a direct path where the consumer allows it, preserving each consumer's existing absent-file behaviour.
3. **Leave untouched**: `extension.ts:3728-3743`, `SetupPanelProvider.ts:1829`/`:1931`, `_normalizeAgentToAgents`, `RETIRED_WORKFLOW_PATH_MAP`, and the two unclassified sites.
4. **Add a comment at each retained migration site** naming it as deliberate legacy-workspace support, so the next cleanup pass does not delete it. This is the cheap half of the fix: the reason these were indistinguishable is that nothing said which was which.

### Migration

None. Persisted config compatibility is owned by the untouched normalizer chain.

## Verification Plan

### Goal Invariants

- No occurrence of `.agent/skills` or `.agent/workflows` remains anywhere in `src/`.
- The four migration sites are present and each carries a comment naming it as intentional.
- A pre-rename workspace containing only `.agent/workflows/` is still detected as configured, and still offered for cleanup.

### Automated Tests

- **Grep gate:** assert `src/**` contains no `.agent/skills` or `.agent/workflows` string. This is the invariant that stops the pair being reintroduced by the next defensive edit.
- **Legacy detection survives:** construct a workspace with `.agent/workflows/` and no `.agents/`; assert `hasSwitchboardProtocolFiles` returns true.
- **Cleanup scan survives:** construct a workspace with a `.agent/` dir; assert the cleanup scan reports it as present and deletable.
- **Config normalizer untouched:** assert a persisted `workflowFilePath` of `.agent/skills/improve-plan/SKILL.md` still resolves to `.agents/protocols/improve-plan/SKILL.md` end-to-end. `planner-workflow-path-migration.test.js` already covers the normalizer in isolation (`:127-128`); this asserts the full chain including `RETIRED_WORKFLOW_PATH_MAP`.
- **Absent-file behaviour per consumer:** for each of the three touched files, remove the single remaining path and assert the consumer's defined fallback runs — `fallbackContent` for the feature-refine dispatch, and whatever each of the other two does. Do not share one assertion across all three.
- **Spark output unchanged:** `spark-context-exporter-contract.test.js` passes without modification, or its diff is reviewed deliberately.

### Manual Verification

- On a scratch workspace with a real `.agent/` directory: setup does not re-scaffold, and the cleanup button removes it.

## Outstanding Questions

- **[user]** `SparkContextExporter.ts:131` resolves its source from `['AGENTS.md', '.agent/AGENTS.md']`. Was `AGENTS.md` ever written inside `.agent/`, or has it always been at the workspace root? If it was always at the root, this is a tenth dead entry; if not, it is legitimate migration. Not classified either way here because guessing would either strand a legacy read or leave a dead path the grep gate then has to exempt.
- **[user]** `TaskViewerProvider.ts:23060` reads a legacy persona from `.agent/personas/`. Personas are user-authored, so this looks like genuine migration — but unlike the other retained sites it has no visible cleanup path. Keep, or migrate-then-retire?
- Do any of the three touched files emit their candidate list into text an agent reads? If so, deletion changes emitted output, not just resolution, and the size of that change should be recorded.
