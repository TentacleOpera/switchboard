# Release: Bump Extension Version to 1.7.6 to Propagate the Skill Changes

**Feature:** eadc0c9f-9d3b-45ce-b457-455f8762ddce

## Goal

Bump the extension version `1.7.5 → 1.7.6` so the control-plane changes made by this feature's
other two subtasks actually reach the ~4,000 installs. This is the feature's **final, shipping
subtask** — it lands last, after both content subtasks are merged, and is the mechanism that
propagates them.

### Background & root cause (why this is required, not optional)

The other two subtasks edit control-plane source: `MIRROR_MANIFEST`
(`src/services/ClaudeCodeMirrorService.ts`), `.agents/skills/**`, `.agents/skills/switchboard-manage/SKILL.md`,
and the `AGENTS.md` table. None of these propagate to an existing install on their own. The
scaffolder that regenerates a workspace's `.agents/` + `.claude/skills/` + `AGENTS.md`/`CLAUDE.md`
is **version-gated**:

- `shouldRefreshAgentWorkspaceFiles` (`src/extension.ts:219`) and
  `ControlPlaneMigrationService._shouldRefreshAgentVersion` (`:795`) both compute
  `needsRefresh = getExtensionVersion(extensionPath) !== lastCopiedVersion(workspaceRoot)`.
- There is **no separate agent/protocol version constant** — the gate reads the VSIX's
  `package.json` version directly. So with the version unchanged, `current === last` → the gate
  returns `false` → the regenerated skill layer is **never re-scaffolded** for the install base.
- Bumping `package.json` to `1.7.6` (and shipping the VSIX) makes `current !== last` on every
  existing install → on next activation the scaffolder regenerates their `.agents/`/`.claude/`
  from the new bundle. **That bump is the propagation trigger.**

## Metadata

- **Tags:** devops, infrastructure, docs
- **Complexity:** 2

## User Review Required

- **None outstanding.** One coordination note (not a decision): 1.7.6 is a release train — it
  ships *everything* currently unreleased on `main`, not only this feature. Cut it when `main`
  is in a releasable state, not mid-flight on unrelated work.

## Complexity Audit

### Routine
- One-line edit to `package.json` `"version"`.
- Optional matching `CHANGELOG.md` entry if the repo keeps one.

### Complex / Risky
- **- None** for the edit itself. The only real constraint is *sequencing* (must land with/after
  both content subtasks) and the fact that the VSIX build/publish is a separate manual release
  step — not risk in the code sense.

## Edge-Case & Dependency Audit

- **Race Conditions:** None.
- **Security:** None.
- **Side Effects:** Bumping the version re-trips the scaffolder for ALL workspaces on next
  activation — intended. Per the migration rules, the scaffolder preserves user-authored
  `.claude/skills/` dirs and only overwrites generated (manifest-tracked) files, so a regen is
  safe for the install base.
- **Dependencies & Conflicts:** **Hard ordering** — must land *with or after* both content
  subtasks. If it lands first (or alone), it trips a regen that ships the *old* skill layer and
  wastes the version window (the next content change then needs *another* bump to propagate).

## Dependencies

- `sess_local_agent_skills_improvements — feature "Agent skills improvements"` — depends on both
  sibling subtasks:
  - *"Audit and Restructure Agent Skills to Prevent Discovery Failures"* (edits `MIRROR_MANIFEST`,
    `.agents/skills/**`, `AGENTS.md`).
  - *"Fix `switchboard-manage` Entry"* (edits `.agents/skills/switchboard-manage/SKILL.md`).
  Both must be merged to `main` before this bump so the release carries their changes.

## Adversarial Synthesis

**Risk Summary:** Trivial one-line change whose only failure mode is *sequencing* — bumping
before the content subtasks land ships nothing useful and burns the version window, forcing a
second bump later. Mitigation: land this last; treat the VSIX build/publish as the explicit,
manual release step that follows.

## Proposed Changes

### `package.json`
- **Context:** Line ~2, `"version": "1.7.5"`.
- **Logic:** Change to `"version": "1.7.6"`.
- **Implementation:** Single-line edit.
- **Edge Cases:** Ensure no other manifest (e.g. a `package-lock.json` version field, if tracked)
  drifts; align if the repo keeps them in sync.

### `CHANGELOG.md` (if present)
- Add a `1.7.6` entry summarizing the skill-registry reconciliation + `switchboard-manage` entry
  fix, so the release note reflects what propagated.

### Release step (manual, out of code scope)
- Build the VSIX (`npm run compile` + package) and publish. Per project rules, compile is only
  needed at release time; it is not part of dev/testing. This subtask's *code* change is just the
  version bump; the build/publish is the human release action.

## Verification Plan

> Per session directive, no compilation / no automated tests in this session.

### Automated Tests
- None.

### Manual acceptance
1. `package.json` reads `"version": "1.7.6"`.
2. After a VSIX built from this commit is installed over an existing (≤1.7.5) install, on next
   activation the workspace's `.claude/skills/` regenerates (e.g. the newly-directoried skills and
   `worktree-cleanup` appear; `switchboard-manage/SKILL.md` reflects the entry rewrite) — i.e. the
   version gate tripped and the content subtasks' changes propagated.
3. Confirm the release carries both content subtasks (they are on `main` at the tagged commit).

## Recommendation

**Complexity 2 → Send to Intern.** Mechanically a one-line bump, but it MUST land last (with or
after both content subtasks) — the only thing an executor can get wrong is ordering. Ready to
execute once both siblings are merged.
