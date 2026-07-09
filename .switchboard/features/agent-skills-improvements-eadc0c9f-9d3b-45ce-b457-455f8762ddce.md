# Agent skills improvements

**Complexity:** 6

## Goal

Make Switchboard's agent-skill layer coherent and correct across hosts. Two independent
defects motivated this feature: (1) the skill *registry* has drifted — some skills are
advertised but not generated (or generated but have no source), so they are unreachable on
one host or another; and (2) one specific skill, `switchboard-manage`, has an entry protocol
that reports the wrong workspace on multi-root machines and is needlessly network-noisy. The
two content subtasks are grouped because both are "agent-skill correctness" work on the shared
`.agents/skills/` control-plane surface — one fixes *which* skills exist and how they are
registered, the other fixes *how one skill behaves* on entry. A third subtask reduces the
*interaction cost* of driving the board from an agent (the skill layer's ergonomics, distinct
from discovery) — chiefly the missing clean way to add a single plan to a feature. A fourth
subtask bumps the extension version so all these control-plane changes actually reach the
~4,000 installs — the scaffolder that regenerates a workspace's skill layer is version-gated,
so without the bump the changes propagate to no one.

## How the Subtasks Achieve This

- **Audit and Restructure Agent Skills to Prevent Discovery Failures**: Makes the skill set
  discoverable across *both* hosts, whose discovery mechanisms differ: **Antigravity**
  filesystem-auto-discovers `.agents/skills/<name>/SKILL.md` directories (flat files are
  invisible; `name`+`description` frontmatter required), while **Claude Code** generates from a
  hardcoded `MIRROR_MANIFEST` (layout-agnostic, but hardcodes `source:` paths). The subtask
  restructures flat skills into directory form *and* updates each `MIRROR_MANIFEST` `source:` in
  lockstep (a move without the manifest edit silently drops the skill from Claude Code), fixes
  concrete drift (`worktree_cleanup` advertised but unreachable on both hosts;
  `create-feature-from-plans` mirrored but sourceless), and normalizes frontmatter. Contributes
  the "which skills exist / are they reachable everywhere" half of the goal.
- **Fix `switchboard-manage` Entry: Local-Markdown-First, Workspace-Scoped, Low-Noise Console**:
  Rewrites `switchboard-manage/SKILL.md` so a consultative entry does one liveness check, then
  reads the *current workspace's* local markdown (structurally workspace-correct), and defers
  all live API calls to action-time with an explicit `workspaceRoot=$ROOT`. Contributes the
  "one skill behaves correctly and quietly" half of the goal, eliminating the wrong-workspace
  data-integrity bug.
- **Make Board/Feature Ops Ergonomic for Agents: Declarative-First, No UUID Choreography**:
  Addresses the skill layer's *ergonomics* (distinct from discovery) — the interaction cost once
  an agent has found the right tool. Headline gap: there is no clean way to add a single plan to a
  feature (`assign-to-feature.js` needs two UUIDs; `reconcile` is converge-to-set; the `**Feature:**`
  file-line silently no-ops on import). Adds an additive path/slug-addressed assign primitive,
  fixes the file-based link, makes `reconcile` the documented default for restructures, and cleans
  up `get-state.js` stdout. Contributes the "cheap to operate" half of a usable skill layer.
- **Release: Bump Extension Version to 1.7.6 to Propagate the Skill Changes**: The three content
  subtasks edit control-plane source (`MIRROR_MANIFEST`, `.agents/skills/**`, `AGENTS.md`, the plan
  watcher, `kanban_operations`) that only re-scaffolds/ships into an existing install when the
  version-gated migration fires. This subtask bumps `package.json` `1.7.5 → 1.7.6` so that gate
  trips and the changes actually reach the ~4,000 installs. Contributes the "does any of this reach
  users" step — the feature's shipping gate.

## Dependencies & sequencing

- **Cross-feature dependencies:** None. All four subtasks are self-contained within this feature.
- **Shared surface (within-feature):** The three content subtasks touch **disjoint** files. The
  audit and the entry-fix both touch `.agents/skills/switchboard-manage/SKILL.md` but in disjoint
  regions — the audit only frontmatter/registry (and finds this skill already correct there), the
  entry-fix only the body (§1/§2/§6); no conflict. The ergonomics subtask touches the plan
  watcher + `kanban_operations` scripts + guidance — no overlap with the other two. One-way
  *informational* dependency: the audit subtask documents the mirror-generation mechanism
  (`MIRROR_MANIFEST` → `.claude/skills/`) that the entry-fix's "regenerate the mirror" note relies on.
- **Shipping order:** The three content subtasks (audit, entry-fix, ergonomics) are independent of
  each other and can land in any order (suggested: entry-fix first — self-contained/low-risk). The
  **version bump MUST land last**, with or after all three: bumping before they land trips a regen
  that ships the old skill layer and burns the version window (forcing a second bump later).
- **Prerequisites / guards:** All prerequisites for the content subtasks are cleared. The three
  product decisions are confirmed (wire up `worktree_cleanup`; regularize `create-feature-from-plans`;
  keep only `refine_ticket`/`refine_feature` flat), and the Antigravity discovery question is
  resolved (web research confirmed filesystem auto-discovery of `SKILL.md` directories). The
  content subtasks are execution-ready; the entry-fix is gated only on the standard control-plane
  approval gate. The version bump is gated on all three content subtasks being merged, and its VSIX
  build/publish is a manual release step.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Audit and Restructure Agent Skills to Prevent Discovery Failures](../plans/audit-agent-skills-structure.md) — **CODE REVIEWED**
- [ ] [Fix `switchboard-manage` Entry: Local-Markdown-First, Workspace-Scoped, Low-Noise Console](../plans/switchboard-manage-entry-local-md-and-workspace-scoping.md) — **CODE REVIEWED**
- [ ] [Release: Bump Extension Version to 1.7.6 to Propagate the Skill Changes](../plans/release-version-bump-1.7.6-propagate-skill-changes.md) — **CODE REVIEWED**
- [ ] [Make Board/Feature Ops Ergonomic for Agents: Declarative-First, No UUID Choreography](../plans/agent-board-op-ergonomics-declarative-first.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Completion Report

All four subtasks have been completed under the accuracy workflow.

### Audit and Restructure Agent Skills (completed in prior thread)
- Flat `.agents/skills/*.md` files moved into `.agents/skills/<name>/SKILL.md` directories.
- `ClaudeCodeMirrorService.ts` `MIRROR_MANIFEST` updated to mirror the new directory paths.
- `AGENTS.md` updated with the new skill names (kebab-case) and removed stale references.
- `create-feature-from-plans` source created and `worktree_cleanup` made reachable.

### Fix `switchboard-manage` Skill Entry (completed in prior thread)
- `switchboard-manage/SKILL.md` rewritten to be local-markdown-first, workspace-scoped, and low-noise.
- Entry protocol reads the current workspace's markdown state first, then drives actions with `workspaceRoot`.

### Make Board/Feature Ops Ergonomic (completed in this session)
- **Single-add primitive:** Added `POST /kanban/features/assign` (`LocalApiServer.ts`) with `{ feature, plan }` (or `{ feature, plans }` for batch) and routed it through `KanbanProvider.assignPlansToFeature`.
- **Path/slug resolution:** Added `KanbanDatabase.resolveFeatureIdentifier` and updated `KanbanProvider.assignPlansToFeature` to resolve both the feature and each plan by path, slug, name, or UUID.
- **Fixed `**Feature:**` frontmatter linking:** `GlobalPlanWatcherService._applyFeatureLink` now uses `resolveFeatureIdentifier` (supports UUID or name), links to the resolved `featureRow.planId`, and regenerates the parent feature file so the `Subtasks` block stays current.
- **Clean `get-state.js` stdout:** `kanban_operations/get-state.js` now routes all `console.log/info/warn/debug` to stderr and flushes JSON on stdout with `process.stdout.end`, so `get-state | jq` works cleanly.
- **Updated `assign-to-feature.js`:** Accepts a single plan ref (path/slug/id) or a JSON array of refs, and calls the new `/kanban/features/assign` endpoint.
- **Updated guidance:** `kanban_operations/SKILL.md` and `switchboard-manage/SKILL.md` now document the new single-add endpoint, path/slug refs, clean `get-state | jq`, and `**Feature:**` self-linking.

### Release: Bump Extension Version to 1.7.6
- `package.json` and `package-lock.json` updated to `1.7.6`.
- `npm run compile` completed successfully; `dist/extension.js` rebuilt with the new endpoint and `1.7.6` version.

### Verification
- `npx tsc -p .`: only pre-existing relative-import file-extension warnings (5 errors unrelated to this change).
- `npx tsc -p tsconfig.test.json`: compiled cleanly and updated `out/`.
- `npm run compile`: webpack finished with 3 optional dependency warnings (bufferutil, utf-8-validate, canvas).
- `npm run lint`: 0 errors, 2000 pre-existing warnings.
- `node .agents/skills/kanban_operations/get-state.js <workspace> | jq .`: emits parseable JSON.
- `node .agents/skills/kanban_operations/assign-to-feature.js ...` reaches the running API (server reload required to pick up the new endpoint).

