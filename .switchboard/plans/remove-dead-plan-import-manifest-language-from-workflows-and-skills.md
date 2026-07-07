# Remove Dead Plan-Import Manifest Language from Workflows and Skills

## Goal

The `improve-plan` and `switchboard-chat` workflows (and their mirrored `.claude/skills/` SKILL.md copies) document a "Plan-Import Manifest" mechanism — a v1 JSON schema that remote agents are told to emit so the extension ingests kanban column transitions and feature relationships. **The extension no longer ingests these manifests.** There is no manifest-file watcher, no `plan-import`/`importManifest`/`manifest.json` parsing code anywhere in `src/` (verified by grep). The live ingestion path is the `GlobalPlanWatcherService` plan watcher, which reads `.md` frontmatter (`**Plan ID:**`, `**Project:**`, `**Feature:**`) directly via `parsePlanMetadata` (`src/services/planMetadataUtils.ts` lines 84–117) and applies it with apply-if-empty semantics (`GlobalPlanWatcherService.ts` lines 480, 650, 711, 832). The JSON manifest is dead instruction that misleads agents — most recently causing a planner to tell the user to "move the card to PLAN REVIEWED" when the card was already there (that arrival is what triggered improve-plan in the first place).

This plan removes the dead manifest language from all live workflow/skill files, preserves the live frontmatter-carrier guidance, and corrects the trigger-model framing so the workflow stop telling agents/users to perform a column transition that already happened.

### Problem & Root Cause

**The manifest is dead code.** A repo-wide grep for `plan-import|planImport|importManifest|ingestManifest|manifest\.json|manifestFile` in `src/` returns zero matches. The only `src/` hits for "manifest" are unrelated: `stitch.manifest` (a DB blob, `KanbanDatabase.ts`), `manifestProject` (a project-pin variable in `KanbanProvider.ts`/`agentPromptBuilder.ts`), `.webmanifest` (a MIME type in `PlanningPanelProvider.ts`), and design/context manifests (`DesignPanelProvider.ts`, `ContextBundler.ts`, `ClaudeCodeMirrorService.ts`). None of these read a plan-import manifest JSON. The "manifest ingest path" comments in `KanbanDatabase.ts` (lines 1532, 2195, 2215) refer to the `upsertPlans` batch path (Notion restore / DB-sourced records), NOT a manifest file.

**The trigger model is backwards in the workflow.** `improve-plan.md` line 95 says "the reviewed plan should land in the 'PLAN REVIEWED' kanban column" and line 97 says "The user will move the card to 'PLAN REVIEWED'... that card move is what triggers the next pipeline stage." Both are wrong. The `PLAN REVIEWED` column has `autobanEnabled: true` and `role: 'planner'` (`agentConfig.ts` line 125) — **arrival in PLAN REVIEWED triggers improve-plan**. The card is already in PLAN REVIEWED when the workflow runs. Telling the user to move it there is telling them to redo the trigger. After improve-plan completes, the `**Stage Complete:** PLAN REVIEWED` marker turns off the card's activity light; the card stays in PLAN REVIEWED until the user advances it to the next stage (e.g., dispatches a coder). There is no post-review "move to PLAN REVIEWED" step.

**What IS live and must be preserved:** the `.md` frontmatter carrier. `GlobalPlanWatcherService` reads each plan `.md` on create/save, parses `**Plan ID:**`, `**Project:**`, and `**Feature:** <feature-plan-id>` (planMetadataUtils.ts lines 109/117), and applies them: `**Project:**` pin wins over the active filter (watcher line 650); `**Feature:**` links a subtask to its feature with apply-if-empty semantics and a deferred-retry for subtasks imported before their feature (watcher lines 36, 189, 480, 506, 524, 711, 832). Feature creation is handled atomically by `create-feature.js` via the `create-feature-from-plans` skill (DB upsert + subtask linking + feature-file write + board refresh). The manifest was a parallel, redundant, and now-nonexistent mechanism.

### Verification Confirmations (read during improve-plan review)

Every factual claim above was re-verified against the live source during this review — no claim rests on assumption:

- **No manifest ingestion code:** repo-wide grep of `src/` for `plan-import|planImport|importManifest|ingestManifest|manifest\.json|manifestFile` returns **zero matches**. Confirmed.
- **Frontmatter carrier is live:** `parsePlanMetadata` (`src/services/planMetadataUtils.ts` lines 84–123) parses `**Project:**` (line 109) and `**Feature:**` (line 117) with list-item-prefix tolerance. `GlobalPlanWatcherService.ts` applies them with apply-if-empty semantics (comments at lines 517–518, 712, 832) and a deferred-retry for subtasks imported before their feature (lines 39, 491–511, 537). The `**Project:**` pin wins over the active filter (lines 650–656, 763–764). Confirmed load-bearing.
- **Trigger model is backwards:** `agentConfig.ts` line 125 defines `PLAN REVIEWED` with `autobanEnabled: true, role: 'planner'` — i.e. arrival in the column auto-dispatches a planner (improve-plan). The card is already in PLAN REVIEWED when this workflow runs. Confirmed by the runtime context of this very review session.
- **KanbanDatabase "manifest ingest path" comments are NOT a manifest file:** the `manifest` hits in `KanbanDatabase.ts` are (a) `stitch.manifest` — a DB blob promoted to first-class tables in migration V32 (lines 610, 629, 5803, 5813), and (b) three comments at lines 1532, 2195, 2215 that self-describe the `upsertPlans`/Notion-restore batch path as "the manifest ingest path" — confusing legacy naming for a DB-sourced-record batch upsert, NOT a plan-import JSON manifest file reader. None read a manifest JSON.
- **`agentPromptBuilder.ts` `manifestProject` is the project-pin prompt variable:** lines 285 (type def), 1539–1540 (`PROJECT_LINE_DIRECTIVE(options.manifestProject)`). Legacy variable NAME carried over from the manifest era; it injects the `**Project:**` pin directive into planner prompts. Unrelated to plan-import manifests. (Plan body cites line 1541; actual hit is 1539–1540 — trivial, non-target.)
- **`.switchboard/api-server-port.txt` remote-detection check is NOT orphaned by this plan:** the check is documented and used in 11+ other live locations — `switchboard-index.md` (the front-door router), `memo.md`, `improve-feature.md`, `create_feature.md`/`create-feature/SKILL.md`, `create-feature-from-plans/SKILL.md`, `switchboard/SKILL.md`, and every `kanban_operations/*.js` script plus `_lib/sb_api_call.sh`. Dropping the reference from the `improve-plan.md` manifest section orphans nothing.
- **Remote column-advance IS covered by skills (Linear case):** `improve-remote-plan/SKILL.md` lines 16 and 94 advance the Linear issue status so the **startup reconciler moves the kanban card** on next IDE startup; `kanban_operations/SKILL.md` `move-card.js` advances the column directly (routes through the extension API when reachable; direct-DB fallback otherwise). See User Review Required #1 for the two real gaps (Notion unsupported; move-card.js fallback reconcile-away risk).

## Metadata

**Complexity:** 3
**Tags:** docs, refactor

## User Review Required

Yes — confirm decisions before coding. The Linear remote case is now **evidence-settled** (see Verification Confirmations); the decisions that remain open are the two flagged gaps:

1. **Remote column-advance path (Linear = settled; gaps = open):** removing the manifest section removes a *fictional* mechanism — the manifest's `fromColumn`/`kanbanColumn`/`stale-manifest guard` was never ingested (zero src/ code), so no remote agent ever successfully advanced a column via manifest. The live skill-based replacement is verified:
   - **Linear-stored plans:** `improve-remote-plan/SKILL.md` (lines 16, 94) advances the Linear issue status in a single `issueUpdate` mutation; the **startup reconciler moves the kanban card** on next IDE startup. Fully covers the manifest's remote column-advance role for Linear. ✅ settled.
   - **Direct card moves:** `kanban_operations/SKILL.md` `move-card.js` advances the column directly — routes through the extension's `POST /kanban/move` API when reachable (cascades subtasks + pushes Linear/ClickUp sync); falls back to a direct-DB write when the extension is unreachable. ✅ covers the explicit-move role.
   - **GAP A — Notion remote plans:** `improve-remote-plan` is **Linear-only** (its "Out of Scope", line 101, states Notion read/write is unsupported). A remote agent improving a Notion-stored plan has no skill-based column-advance. **Decision needed:** is the Notion-remote path in active use? If yes, file a follow-up plan to document the Notion-remote column-advance path (do NOT resurrect the manifest — it never worked). If no, accept the gap and note it.
   - **GAP B — `move-card.js` direct-DB fallback caveat:** the fallback warns (skill line 29) that a direct-DB write **"may be reconciled away on the next inbound poll"** if real-time sync is enabled. So a remote agent using the fallback to advance a column is not guaranteed durable when sync is on. **Decision needed:** is this caveat acceptable for the remote-recovery use case, or should the replacement guidance explicitly recommend "prefer the extension-reachable path; treat direct-DB fallback as recovery-only and verify the move stuck"? (Recommended: the latter — it matches `move-card.js`'s own "MANUAL FALLBACK ONLY" framing.)
   - **Not a regression:** the manifest's `fromColumn`/stale-manifest guard was a *robustness that never existed in code*. `move-card.js` (even with its fallback caveat) is strictly better than a nonexistent mechanism. This decision is about documentation honesty, not restoring lost functionality.
2. **Trigger-model rewrite:** confirm the corrected framing (arrival in PLAN REVIEWED triggers improve-plan; no post-review column move) matches the actual pipeline wiring. (Verified during review: `agentConfig.ts` line 125 — `autobanEnabled: true, role: 'planner'` — plus the runtime context of this review session confirm it. This is now a rubber-stamp confirmation, not an open question.)

## Complexity Audit

### Routine
- Deleting/replacing markdown sections in 4 workflow/skill files — no code logic, no schema, no state.
- Rewording 2 single-line "no manifest needed" phrases in `CLAUDE.md` and `AGENTS.md` to drop the now-meaningless manifest reference.
- All edits are in documentation/instruction files (`.agents/workflows/`, `.claude/skills/`, `CLAUDE.md`, `AGENTS.md`) — no `src/` changes.

### Complex / Risky
- The replacement guidance must not lose the live frontmatter-carrier instructions (`**Plan ID:**`, `**Project:**`, `**Feature:**` embedding) or the `create-feature-from-plans` skill recommendation — those are load-bearing for the watcher. A careless delete-and-replace could strip live guidance along with the dead manifest. Mitigation: the edits are surgical section replacements, not wholesale file rewrites; each replacement is specified below with the exact text to keep.

## Edge-Case & Dependency Audit

**Race Conditions:** None — these are static markdown files read by agents at workflow invocation time, not concurrent runtime state.

**Security:** None — no code, no endpoints, no auth surface.

**Side Effects:**
- **Agent behavior change:** remote agents will no longer be told to emit a manifest JSON. Since nothing ingests it, this changes nothing observable — the manifest was already a no-op. The only behavioral change is that agents stop wasting tokens generating a JSON payload that gets ignored.
- **Local agent guidance change:** local agents will no longer be told "the user will move the card to PLAN REVIEWED." This corrects the trigger-model error; no local agent was correctly acting on the old instruction anyway (it was wrong).
- **Feature-grouping path unchanged:** `switchboard-chat`'s "Feature Grouping" section (lines 77–84) and the `create-feature-from-plans` recommendation are preserved. Only the "Plan-Import Manifest (Trigger B)" section is removed.

**Dependencies & Conflicts:**
- The historical plan `.switchboard/plans/add-direct-create-feature-skill.md` references "Trigger A"/"Trigger B" and the manifest — it is an already-implemented artifact (its own review note cites commit `8949e07`). It is NOT edited (historical plans are immutable artifacts, not live instructions).
- `.agents/scripts/stage-artifacts.js` writes a `staging_manifest_*.json` for artifact copying — completely unrelated to plan-import manifests. NOT touched.
- `agentPromptBuilder.ts` `manifestProject` variable (lines 285, 1540, 1541) — the project-pin prompt variable, NOT the plan-import manifest. NOT touched. The planner prompts contain zero plan-import-manifest language (verified by grep); the manifest instruction lives only in the workflow/skill markdown.

## Dependencies

- None. Self-contained documentation cleanup with no prerequisite plans or sessions.

## Adversarial Synthesis

Key risks: (1) a careless delete could strip the live frontmatter-carrier guidance (`**Plan ID:**`/`**Project:**`/`**Feature:**`) along with the dead manifest — mitigated by surgical section replacements that explicitly retain the frontmatter lines; (2) removing the manifest's `fromColumn`/`kanbanColumn` documentation leaves the remote column-advance path undocumented — mitigated by flagging it for user confirmation and pointing to the existing `improve-remote-plan`/`kanban_operations` skills as the live replacement; (3) the mirrored `.claude/skills/` copies could drift from the `.agents/workflows/` originals if only one set is edited — mitigated by editing both copies in the same pass and listing every file explicitly below.

## Proposed Changes

### [MODIFY] `.agents/workflows/improve-plan.md` — replace "Plan-Import Manifest" section (lines 93–141)

**Delete** the entire `## Plan-Import Manifest (Trigger A — column transition)` section (lines 93–141), including the v1 JSON schema, field rules, stale-manifest guard, and the "Trigger A/Trigger B" naming.

**Replace** with a concise `## Post-Review Board State` section that:
1. States the corrected trigger model: improve-plan is triggered BY the card's arrival in PLAN REVIEWED (the column has `autobanEnabled: true`, `role: 'planner'`). The card is already in PLAN REVIEWED when this workflow runs — do NOT instruct the user to move it there.
2. States that after review, the agent appends `**Stage Complete:** PLAN REVIEWED` to the plan `.md` (the sole signal that turns off the card's activity light) and informs the user the review is complete. The user advances the card to the next pipeline stage (e.g., dispatches a coder) when ready — the workflow does not move the card.
3. Preserves the frontmatter-carrier guidance: each plan `.md` should embed `**Plan ID:** <uuid>` for stable identity across re-imports. If the agent restructured plans into a feature during review, invoke the `create-feature-from-plans` skill (runs `create-feature.js`: DB upsert, subtask linking, feature-file write, board refresh — atomic) AFTER the review and AFTER user approval — never mid-review (the NO-IMPLEMENTATION constraint forbids side-effecting writes). The feature relationship is carried by `**Feature:** <feature-plan-id>` lines written in each subtask's `.md` (applied on import with apply-if-empty semantics by the plan watcher).
4. Drops all mention of: manifest JSON, `kanbanColumn`, `fromColumn`, `isFeature`/`featureId` manifest fields, `status`, stale-manifest guard, "Trigger A"/"Trigger B", the `.switchboard/api-server-port.txt` remote-detection check, and the v1 schema code block.

### [MODIFY] `.claude/skills/improve-plan/SKILL.md` — mirror the above (lines 94–142)

Apply the identical replacement as `.agents/workflows/improve-plan.md`. This file is the mirrored skill copy and must stay in sync.

### [MODIFY] `.agents/workflows/switchboard-chat.md` — replace "Plan-Import Manifest (Trigger B)" section (lines 29–76)

**Delete** the entire `## Plan-Import Manifest (Trigger B — feature grouping)` section (lines 29–76), including the v1 JSON schema, field rules, and stale-manifest guard.

**Replace** with a concise `## Feature Relationships (frontmatter carrier)` section that:
1. States that feature relationships are carried by `**Feature:** <feature-plan-id>` and `**Project:** <name>` lines written directly in each plan `.md` — the plan watcher applies these on import with apply-if-empty semantics. No manifest file; no batch payload.
2. States that each plan `.md` must embed `**Plan ID:** <uuid>` (features use the `feature-<uuid>.md` filename) so `featureId` links resolve and identity is stable across re-imports.
3. Preserves the existing `create-feature-from-plans` recommendation (already present in the "Feature Grouping" section at lines 77–84 — do NOT duplicate; just cross-reference it).
4. Drops all mention of: manifest JSON, `kanbanColumn`, `isFeature`/`featureId` manifest fields, stale-manifest guard, "Trigger B", and the v1 schema code block.

**Do NOT touch** the "Feature Grouping" section (lines 77–84) — it is live and correct.

### [MODIFY] `.claude/skills/switchboard-chat/SKILL.md` — mirror the above (lines 30–76)

Apply the identical replacement as `.agents/workflows/switchboard-chat.md`. This file is the mirrored skill copy and must stay in sync.

### [MODIFY] `CLAUDE.md` — reword line 178

**Before:** `Write the pin as \`**Project:** <name>\` — plain or as a \`- \` list item; both parse. No manifest is needed for project pinning — the .md metadata is the carrier.`

**After:** `Write the pin as \`**Project:** <name>\` — plain or as a \`- \` list item; both parse. The .md metadata is the carrier — the plan watcher reads it directly on import.`

(Drops the now-meaningless "No manifest is needed" phrasing — there is no manifest to not need.)

### [MODIFY] `AGENTS.md` — reword line 151

Apply the identical rewording as `CLAUDE.md` line 178. (`AGENTS.md` and `CLAUDE.md` carry the same protocol block; both must stay in sync.)

### No other files need changes

- `src/` — no code changes. The manifest was never ingested; removing the instruction changes no runtime behavior.
- `.agents/scripts/stage-artifacts.js` — unrelated `staging_manifest_*.json` (artifact-copying build manifest). NOT touched.
- `.switchboard/plans/add-direct-create-feature-skill.md` — historical implemented-plan artifact referencing Trigger A/B. NOT touched (immutable history).
- Planner prompts (`agentPromptBuilder.ts`) — contain zero plan-import-manifest language (verified). The `manifestProject` variable is the project-pin prompt mechanism, unrelated. NOT touched.
- All other skills (`improve-remote-plan`, `create-feature`, `create-feature-from-plans`, `improve-feature`, `switchboard-split`, `kanban_operations`, etc.) — verified by repo-wide grep: no "manifest"/"Trigger A"/"Trigger B"/"plan-import" language. NOT touched.

## Edge Cases & Risks

- **Mirrored-copy drift:** the `.agents/workflows/` and `.claude/skills/` copies must be edited together. If only one set is changed, agents loading the skill vs. the workflow would see different instructions. Mitigation: both copies are listed explicitly above; the coder should diff the two pairs after editing to confirm byte-identical replacement sections.
- **Frontmatter guidance loss:** the replacement sections must retain the `**Plan ID:**`, `**Project:**`, `**Feature:**` embedding instructions — these are live and load-bearing for `GlobalPlanWatcherService`. The edits above are surgical replacements that explicitly preserve these lines; the coder must not delete them.
- **Remote column-advance gap:** see User Review Required #1. If the `improve-remote-plan`/`kanban_operations` skills do not fully cover the remote column-advance cases the manifest documented, a follow-up plan should document the skill-based path. This plan does not attempt to fill that gap — it only removes the dead manifest instruction per the user's directive.
- **No runtime regression:** removing the manifest instruction cannot break the extension because the extension never ingested manifests. The only observable change is that agents stop generating ignored JSON payloads and stop issuing the wrong "move card to PLAN REVIEWED" instruction.

## Verification Plan

### Automated Tests

No automated tests cover the workflow/skill markdown files (they are agent instructions, not code). Per session directives, automated tests are not run. The existing `src/services/__tests__/GlobalPlanWatcherService.test.ts` and `planMetadataUtils.test.ts` confirm the frontmatter carrier (`**Project:**`/`**Feature:**` parsing + apply-if-empty) is live and tested — these are NOT affected by the markdown edits and serve as proof that the replacement guidance (frontmatter carrier) is the correct live mechanism.

### Manual Verification

1. After editing, grep the repo (excluding `node_modules/`, `dist/`, `.switchboard/plans/` historical artifacts) for `plan-import|Trigger A|Trigger B|stale-manifest|kanbanColumn.*PLAN REVIEWED.*manifest` — confirm zero matches in `.agents/`, `.claude/`, `CLAUDE.md`, `AGENTS.md`.
2. Grep `.agents/workflows/improve-plan.md`, `.claude/skills/improve-plan/SKILL.md`, `.agents/workflows/switchboard-chat.md`, `.claude/skills/switchboard-chat/SKILL.md` for `**Plan ID:**`, `**Project:**`, `**Feature:**`, `create-feature-from-plans` — confirm the frontmatter-carrier guidance and skill recommendation are STILL present (not accidentally deleted).
3. Confirm `CLAUDE.md` line 178 and `AGENTS.md` line 151 no longer contain "manifest" but still state the `.md` metadata is the carrier.
4. Diff each `.agents/workflows/` file against its `.claude/skills/` mirror — confirm the replacement sections are byte-identical.
5. Read the new `## Post-Review Board State` section in `improve-plan.md` — confirm it states that arrival in PLAN REVIEWED triggers the workflow (NOT that the user moves the card there after review).

**Recommendation:** Complexity 3 → **Send to Intern**.

**Stage Complete:** PLAN REVIEWED
