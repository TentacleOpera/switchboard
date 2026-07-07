# Remove the dead Stage Complete label + parser field

## Goal

Delete the now-vestigial `**Stage Complete:**` parsing surface. After the activity-light OFF-switch became mtime-based (`activity-light-clears-on-next-plan-file-edit`, commit `c5185aa`), the watcher no longer reads any Stage Complete marker, and the dispatch prompt no longer instructs agents to write one (`buildStageCompleteDirective` + its two call sites were removed). What remains is dead code: a parser field that is populated on every plan re-parse but read by nobody, plus the constant that feeds its regex.

### Problem analysis & root cause

The `**Stage Complete:**` mechanism was the old activity-light OFF-switch: agents appended `**Stage Complete:** <COLUMN>` to a plan file, the parser (`parsePlanMetadata`) captured it into `PlanMetadata.stageComplete`, and the watcher cleared the card's `working` state when the echoed column matched. Two later fixes dismantled it:

- The **multi-marker fix** (`4cabd8e`) widened `stageComplete` from `string` to `string[]` and made the watcher tolerant of accumulated markers (`hasBare`/`hasMatch`).
- The **mtime fix** (`c5185aa`) then deleted that watcher guard entirely — the light now clears on the *next plan-file edit* regardless of text — and removed the agent directive.

Net result (verified by grep, 2026-07-07): the only remaining references to `stageComplete` are the parser itself, and the only remaining references to `STAGE_COMPLETE_LABEL` are the constant declaration + the parser's import/regex. **Nothing consumes the field.** It is populated-but-unread on every parse — pure dead weight and a source of confusion for the next maintainer (the JSDoc still describes a watcher that no longer exists).

Verified current references:
- `src/services/planMetadataUtils.ts:5` — `import { STAGE_COMPLETE_LABEL } from './agentPromptBuilder';`
- `src/services/planMetadataUtils.ts:57-63` — JSDoc + `stageComplete?: string[];` interface field.
- `src/services/planMetadataUtils.ts:125-136` — the `matchAll` parser block.
- `src/services/planMetadataUtils.ts:145` — `stageComplete` in the returned object literal.
- `src/services/agentPromptBuilder.ts:504` — `export const STAGE_COMPLETE_LABEL = 'Stage Complete';` (plus an orphaned/blank comment left by the earlier directive removal).

## Metadata

- **Tags:** refactor, backend, cleanup
- **Complexity:** 2 (routine dead-code deletion, two files, one cross-file import to sever; no new behavior, no schema/DB/settings touch)
- **Pinning:** none — the workspace's `kanban.activeProjectFilter` is empty and no project was named, so this plan lands unassigned (reassign on the board if desired). "Switchboard" is the *workspace*, not a project — do not pin it.
- *No `**Repo:**` line — single-repo workspace.*

## User Review Required

None. This is a pure dead-code deletion with no behavioral change and no product decision. The one judgment call — leave historical `**Stage Complete:**` text in existing plan `.md` files untouched — is stated as a boundary below and is the safe default.

## Migration

**None required.** `stageComplete` is an in-memory parse-time field — there is no persisted DB column, no settings key, and no on-disk file-format contract keyed on it. Removing it changes no stored shape. Existing plan `.md` files that still contain `**Stage Complete:** …` lines are left exactly as-is; those lines simply stop being parsed into a field nobody reads. This holds regardless of whether the field ever shipped in a released VSIX (the CLAUDE.md migration rule governs *persisted* released state; an in-memory parse field is not that).

## Proposed Changes

### 1. `src/services/planMetadataUtils.ts` — remove the field, parser, and import

- Delete the import on **line 5**: `import { STAGE_COMPLETE_LABEL } from './agentPromptBuilder';`.
- Delete the interface JSDoc + field on **lines 57-63** (the `stageComplete?: string[];` member and its comment block).
- Delete the parser block on **lines 125-136** (the `// Activity-light OFF-switch` comment, `let stageComplete`, `stageRegex`, `matchAll`, and the `if (stageMatches.length > 0)` assignment).
- Remove `stageComplete` from the returned object literal on **line 145** (and the trailing comma on the preceding `feature` entry so the literal stays valid).

### 2. `src/services/agentPromptBuilder.ts` — remove the now-unused constant

- Delete `export const STAGE_COMPLETE_LABEL = 'Stage Complete';` on **line 504**, along with any adjacent orphaned/blank JSDoc left over from the earlier `buildStageCompleteDirective` removal (tidy the gap so no dangling comment remains).

## Boundaries (do NOT touch)

- **`destinationColumn` is NOT dead — leave it entirely alone.** It is load-bearing for role/column routing: `KanbanProvider.ts:5149-5237` (`_generatePromptForDestinationRole`, `roleSourceColumn`, the `PLAN REVIEWED` routing), `KanbanProvider.ts:4221`, `agentConfig.ts:68`, and `src/test/kanban-prompt-generation-unit.test.js`. Only its former use *inside the removed Stage Complete directive* went away; the field still drives which role a card dispatches to. Its JSDoc at `agentPromptBuilder.ts:286` was already corrected during review to note the directive is gone.
- **`extractEmbeddedMetadata` (`planMetadataUtils.ts`) is out of scope** — it parses single-value ClickUp/Linear IDs and shares no code with the Stage Complete path.
- **Do not rewrite existing plan `.md` files** to strip historical `**Stage Complete:**` lines — they are harmless display text; a mass file rewrite is out of scope and risks churn/merge noise.

## Edge-Case & Dependency Audit

- **Cross-file import:** `planMetadataUtils.ts` imports `STAGE_COMPLETE_LABEL` from `agentPromptBuilder.ts`. Remove the *consumer* import first (step 1) so that when the constant is deleted (step 2) there is no dangling import — order matters only for a clean intermediate compile, not the end state.
- **Other importers of the constant:** none (grep confirmed only `planMetadataUtils.ts` imports it).
- **Tests:** no test references `stageComplete` (grep confirmed zero literal consumers, including under `src/test/`). The multi-marker plan's earlier grep guard already established this; re-run it before merge.
- **Type surface:** removing a field from `PlanMetadata` is only a breaking change to code that *reads* `.stageComplete` — there is none. The return-literal edit is the only spot the compiler will care about.

## Verification Plan

1. **Consumer grep (must be empty after the change):** `grep -rn "stageComplete\|STAGE_COMPLETE_LABEL" src/` → expect **zero** matches. If anything remains, it was missed.
2. **Typecheck:** `npm run compile` (webpack/tsc) succeeds with no new errors — confirms the `PlanMetadata` field removal and the severed import both typecheck. (Only needed to prove the deletion is clean; `dist/` output itself is not used in dev/testing.)
3. **Boundary check:** `grep -rn "destinationColumn" src/` still shows the routing usages intact (KanbanProvider, agentConfig, test) — confirm none were removed.
4. **Behavioral smoke (manual, installed VSIX):** dispatch a card, edit its plan file → the activity light still clears on the edit (mtime path, unaffected by this change). Re-parse a plan file that contains a stray `**Stage Complete:** …` line → no error, card behaves normally (the line is now ignored).

## Recommendation

**Send to Intern.** Complexity 2 — mechanical two-file dead-code deletion, one cross-file import to sever, no new behavior, no migration. The only ways to get it wrong are (a) touching `destinationColumn`, or (b) leaving a dangling import/comment — both covered by the Boundaries section and the grep-empty verification gate.
