# Agent skills improvements

**Complexity:** 3

## Goal

Make Switchboard's agent-skill layer coherent and correct across hosts. Two independent
defects motivated this feature: (1) the skill *registry* has drifted — some skills are
advertised but not generated (or generated but have no source), so they are unreachable on
one host or another; and (2) one specific skill, `switchboard-manage`, has an entry protocol
that reports the wrong workspace on multi-root machines and is needlessly network-noisy. The
subtasks are grouped because both are "agent-skill correctness" work on the shared
`.agents/skills/` control-plane surface — one fixes *which* skills exist and how they are
registered, the other fixes *how one skill behaves* on entry.

## How the Subtasks Achieve This

- **Audit and Restructure Agent Skills to Prevent Discovery Failures**: Reconciles the three
  registries that define the skill set — the `.agents/` source, the generated Claude Code
  mirror (`MIRROR_MANIFEST` → `.claude/skills/`), and the `AGENTS.md` skills table — fixing
  concrete drift (e.g. `worktree_cleanup` advertised but unmirrored; `create-feature-from-plans`
  mirrored but sourceless) and normalizing source frontmatter. Contributes the "which skills
  exist / are they reachable everywhere" half of the goal. (Its original "flat files are ignored
  by auto-discovery → move them to subdirectories" premise was corrected during review — the
  Claude Code layer is manifest-driven, not auto-discovered, and blind file moves would break
  generation.)
- **Fix `switchboard-manage` Entry: Local-Markdown-First, Workspace-Scoped, Low-Noise Console**:
  Rewrites `switchboard-manage/SKILL.md` so a consultative entry does one liveness check, then
  reads the *current workspace's* local markdown (structurally workspace-correct), and defers
  all live API calls to action-time with an explicit `workspaceRoot=$ROOT`. Contributes the
  "one skill behaves correctly and quietly" half of the goal, eliminating the wrong-workspace
  data-integrity bug.

## Dependencies & sequencing

- **Cross-feature dependencies:** None. Both subtasks are self-contained within this feature.
- **Shared surface (within-feature):** Both touch `.agents/skills/switchboard-manage/SKILL.md`,
  but in **disjoint regions** — the audit touches only frontmatter/registry (and finds this
  skill already correct there), while the entry-fix rewrites the body (§1/§2/§6). No merge
  conflict. There is a one-way *informational* dependency: the audit subtask documents the
  mirror-generation mechanism (`MIRROR_MANIFEST` → `.claude/skills/`) that the entry-fix's
  "regenerate the mirror after editing" note relies on.
- **Shipping order:** Independent — either order is safe. Suggested: land the `switchboard-manage`
  entry-fix first (self-contained, low-risk, doc-only, behind an explicit approval gate), then
  the skills audit (broader, edits control-plane `MIRROR_MANIFEST`, and carries a genuine
  product decision about `worktree_cleanup`'s fate).
- **Prerequisites / guards:** The audit subtask must be gated on two things before execution —
  (a) the user's decisions on `worktree_cleanup` (wire up vs retire) and `create-feature-from-plans`
  (regularize vs accept Claude-only), and (b) resolving whether Antigravity auto-discovers
  `.agents/skills/` or reads only `AGENTS.md` (see that plan's "Uncertain Assumptions"). The
  entry-fix is gated only on the standard control-plane approval gate.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Audit and Restructure Agent Skills to Prevent Discovery Failures](../plans/audit-agent-skills-structure.md) — **PLAN REVIEWED**
- [ ] [Fix `switchboard-manage` Entry: Local-Markdown-First, Workspace-Scoped, Low-Noise Console](../plans/switchboard-manage-entry-local-md-and-workspace-scoping.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

