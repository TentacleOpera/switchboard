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
registered, the other fixes *how one skill behaves* on entry. A third subtask bumps the
extension version so those control-plane changes actually reach the ~4,000 installs — the
scaffolder that regenerates a workspace's skill layer is version-gated, so without the bump the
changes propagate to no one.

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
- **Release: Bump Extension Version to 1.7.6 to Propagate the Skill Changes**: The two content
  subtasks edit control-plane source (`MIRROR_MANIFEST`, `.agents/skills/**`, `AGENTS.md`) that
  only re-scaffolds into an existing install when the version-gated migration fires. This subtask
  bumps `package.json` `1.7.5 → 1.7.6` so that gate trips and the changes actually reach the
  ~4,000 installs. Contributes the "does any of this reach users" step — the feature's shipping
  gate.

## Dependencies & sequencing

- **Cross-feature dependencies:** None. All three subtasks are self-contained within this feature.
- **Shared surface (within-feature):** The two content subtasks both touch
  `.agents/skills/switchboard-manage/SKILL.md`, but in **disjoint regions** — the audit touches
  only frontmatter/registry (and finds this skill already correct there), while the entry-fix
  rewrites the body (§1/§2/§6). No merge conflict. There is a one-way *informational* dependency:
  the audit subtask documents the mirror-generation mechanism (`MIRROR_MANIFEST` → `.claude/skills/`)
  that the entry-fix's "regenerate the mirror after editing" note relies on.
- **Shipping order:** The two content subtasks are independent of each other (either first;
  suggested: entry-fix first — self-contained/low-risk — then the audit). The **version bump MUST
  land last**, with or after both content subtasks: bumping before they land trips a regen that
  ships the old skill layer and burns the version window (forcing a second bump later).
- **Prerequisites / guards:** All prerequisites for the content subtasks are cleared. The three
  product decisions are confirmed (wire up `worktree_cleanup`; regularize `create-feature-from-plans`;
  keep only `refine_ticket`/`refine_feature` flat), and the Antigravity discovery question is
  resolved (web research confirmed filesystem auto-discovery of `SKILL.md` directories). Both
  content subtasks are execution-ready; the entry-fix is gated only on the standard control-plane
  approval gate. The version bump is gated on both content subtasks being merged, and its VSIX
  build/publish is a manual release step.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Audit and Restructure Agent Skills to Prevent Discovery Failures](../plans/audit-agent-skills-structure.md) — **PLAN REVIEWED**
- [ ] [Fix `switchboard-manage` Entry: Local-Markdown-First, Workspace-Scoped, Low-Noise Console](../plans/switchboard-manage-entry-local-md-and-workspace-scoping.md) — **PLAN REVIEWED**
- [ ] [Release: Bump Extension Version to 1.7.6 to Propagate the Skill Changes](../plans/release-version-bump-1.7.6-propagate-skill-changes.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

