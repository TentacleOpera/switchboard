# Audit and Restructure Agent Skills to Prevent Discovery Failures

We audited the `.agents/skills` directory and found skills that are missing from the host
discovery layers, or whose frontmatter is inconsistent. The user's goal is to make the skill
**set** discoverable and coherent across every host, and to draw a clear line between
user-callable skills, model-only skills, and backend/deep-linked helpers. This plan replaces
the original "flat files are ignored by auto-discovery → move them into subdirectories"
approach with a registry-reconciliation approach, because investigation of the actual code
(`ClaudeCodeMirrorService.ts`) showed the original root cause was incorrect and its proposed
action would have **broken** skill generation.

## Goal

Reconcile the three surfaces that together define Switchboard's skill set — the `.agents/`
source, the generated Claude Code mirror (`MIRROR_MANIFEST` → `.claude/skills/`), and the
`AGENTS.md` skills table — so that every skill that should be discoverable *is* discoverable
on every host, no skill is advertised-but-missing (or present-but-orphaned), and each skill's
invocation category (user-callable / model-only / backend) is correct and consistent. Along
the way, normalize source-file frontmatter for robustness.

### Background Context & Root Cause Analysis

**Observed problem (preserved — this is what the user saw):** Multiple skills in
`.agents/skills` appear malformed or inconsistently structured — some directories/files are
missing `name` and/or `description` frontmatter, and there is genuine ambiguity about which
files are user-callable workflows, which are model-only helper skills, and which are
backend-consumed or remote-only tools. Some advertised skills are not actually reachable.

> **Superseded:** *"Antigravity's skill auto-discovery engine expects skills to be directories
> inside the customization root's `skills/` directory (e.g., `.agents/skills/my-skill/`)
> containing a `SKILL.md` file … this `SKILL.md` must have YAML frontmatter declaring both
> `name` and `description` to be successfully registered. … There are 26 flat markdown files
> directly in `.agents/skills/` … Because they are flat files rather than subdirectories
> containing a `SKILL.md`, they are completely ignored by the auto-discovery engine."*
>
> **Reason:** Investigation of the actual generator (`src/services/ClaudeCodeMirrorService.ts`,
> `generateClaudeMirror()` + `MIRROR_MANIFEST` at lines 46–156) refuted this for the Claude
> Code host, which is the host this repo currently generates for:
> - There is **no filesystem auto-discovery**. The Claude Code layer (`.claude/skills/<name>/SKILL.md`)
>   is generated from a **hardcoded manifest** (`MIRROR_MANIFEST`). A skill appears iff it has
>   a manifest entry — **flat `.md` files are mirrored just fine** (e.g. `skills/complexity_scoring.md`
>   → `complexity-scoring`, with a `descriptionFallback`). Directory-vs-flat is irrelevant to
>   Claude Code discovery.
> - `resolveSourceFile()` reads `<dir>/SKILL.md` for directory entries and the `.md` file
>   directly for flat entries — both shapes are first-class.
> - The output `name` comes from the **manifest** (kebab-case, hand-authored), *not* from
>   source frontmatter; `buildSkillMd` never uses the parsed frontmatter `name`. The output
>   `description` is `frontmatter.description || entry.descriptionFallback || ''`. So source
>   frontmatter `name` is vestigial for Claude Code, and a missing source `description` is
>   covered by the manifest fallback.
> - **Antigravity has no generated skills mirror at all** — per `package.json` `switchboard.protocol.target`,
>   Antigravity reads `AGENTS.md` (and `.agents/` raw); only the `claude` target runs
>   `generateClaudeMirror`. (Whether Antigravity performs its *own* filesystem auto-discovery
>   of `.agents/skills/<name>/SKILL.md` is unverified — see **## Uncertain Assumptions**.)
> - The flat-file count is 25 (excluding one `*.migrated.bak`), not 26.
>
> **Replaced with — the actual root cause: three-surface registry drift.** Skill discoverability
> is governed by three registries that have drifted apart, not by file layout:
> 1. **`.agents/` source** — `.agents/skills/*.md` (flat) + `.agents/skills/<dir>/SKILL.md` +
>    `.agents/workflows/*.md`. Also the dynamic `switchboard-*.md` per-agent exports.
> 2. **`MIRROR_MANIFEST`** (`ClaudeCodeMirrorService.ts:46`) → generated `.claude/skills/` — the
>    authoritative Claude Code registry.
> 3. **`AGENTS.md` skills table** — the human/Antigravity-facing registry.
>
> Concrete drifts found by auditing these against each other:
> - **`worktree_cleanup.md`** — a real skill (frontmatter `description`, calls `POST /worktree/cleanup`),
>   advertised in `AGENTS.md:111`, but **absent from `MIRROR_MANIFEST`** → never generated →
>   invisible in Claude Code (confirmed: `worktree-cleanup` does not appear in the Claude Code
>   skill list). Advertised-but-unreachable.
> - **`create-feature-from-plans`** — advertised in `AGENTS.md:109` and present as
>   `.claude/skills/create-feature-from-plans/SKILL.md`, but has **no `.agents/` source** and
>   **no `MIRROR_MANIFEST` entry**. It is a hand-authored `.claude`-only orphan: it will not
>   regenerate, and there is nothing for Antigravity/other-host targets to read.
> - **Mirror staleness** — `switchboard-manage` *is* in `MIRROR_MANIFEST` (line 65) yet
>   `.claude/skills/switchboard-manage/` does **not** exist, because the mirror only regenerates
>   on version-change / Setup. Manifest ⟷ `.claude/` drift is expected between regenerations,
>   but means "in the manifest" ≠ "currently on disk."
> - **Frontmatter inconsistency (source hygiene, not a Claude-Code discovery blocker):**
>   `advise_research/SKILL.md` has no frontmatter; `group-into-features/SKILL.md` and
>   `switchboard-orchestration/SKILL.md` have `description:` but no `name:`. Harmless for the
>   Claude Code mirror (manifest supplies name; description falls back), but it is the exact
>   thing that *would* matter to any host that reads source frontmatter directly.

### Core Problems (restated against the real cause)
- **Advertised-but-unreachable / orphaned skills:** `worktree_cleanup` (advertised, not
  generated) and `create-feature-from-plans` (generated, no source) are live registry
  inconsistencies that make the skill set incoherent across hosts.
- **No single reconciliation pass:** the three registries are edited independently, so drift
  accrues silently. There is no check that source ↔ manifest ↔ AGENTS.md agree.
- **Invocation-category ambiguity:** the user-callable vs model-only vs backend distinction is
  real, but it is *already modeled* by `MIRROR_MANIFEST`'s `invocation` field
  (`default` / `no-user` / `no-model`). The task is to verify each skill's category matches
  intent — not to invent a new taxonomy.

## Metadata

- **Tags:** refactor, devops, infrastructure, docs
- **Complexity:** 4

## User Review Required

- **`worktree_cleanup` — wire up or retire?** It is advertised but not generated, and prior
  project notes indicate the `POST /worktree/cleanup` route may not be implemented server-side
  (the shipped merge path is a bare `git merge`). Decision: (a) add a `MIRROR_MANIFEST` entry
  and confirm/implement the endpoint, or (b) remove it from source **and** `AGENTS.md` as a
  dead advertisement. Recommendation: **(b) retire** unless the endpoint is confirmed live —
  don't ship a skill that calls a non-existent route. *This is a genuine product decision; the
  user should confirm the endpoint's status.*
- **`create-feature-from-plans` — regularize or accept as Claude-only?** Recommendation:
  **regularize** — add an `.agents/skills/create_feature_from_plans.md` (or `<dir>/SKILL.md`)
  source and a `MIRROR_MANIFEST` entry so it regenerates and ships to every host, rather than
  surviving as an untracked hand-authored mirror.
- Everything else (manifest additions, frontmatter normalization) is mechanical and needs no
  product decision.

## Complexity Audit

### Routine
- Adding/removing `MIRROR_MANIFEST` entries (append to a typed array, mirror the existing entry
  shape).
- Adding `name:`/`description:` frontmatter to source files/dirs that lack it.
- Editing the `AGENTS.md` skills table rows.
- Deleting the `switchboard_remote_notion.md.migrated.bak` dead file (optional hygiene).

### Complex / Risky
- **`MIRROR_MANIFEST` is control-plane source that ships to ~4,000 installs.** It generates the
  user-facing skill set. A wrong `source:` path silently drops a skill (`resolveSourceFile`
  returns `null`); a wrong `invocation` changes whether a skill is user- or model-invocable.
  Edits here are low-LOC but high-blast-radius.
- **Never move/rename a source file referenced by `MIRROR_MANIFEST` without updating the entry
  in the same change.** This is the specific footgun the original plan would have triggered.
- The `worktree_cleanup` endpoint-liveness question is a real dependency, not a doc tweak.

## Edge-Case & Dependency Audit

- **Race Conditions:** None at author time. At apply time, the mirror regenerates on
  version-change/Setup, not on file save — so manifest edits are not visible in `.claude/`
  until a regeneration runs. Verification must trigger a regeneration explicitly.
- **Security:** None. No secrets, no new endpoints (unless `worktree_cleanup` is wired up,
  which reuses the existing token-authed `sb_api_call`).
- **Side Effects:** Regenerating the mirror overwrites only files tracked in
  `.claude/.switchboard-generated.json`; hand-authored `.claude/skills/` dirs (like the current
  `create-feature-from-plans`) are left untouched by the generator — which is exactly why the
  orphan persists. Regularizing it means the generator will start managing it.
- **Dependencies & Conflicts:** Shares the `.agents/skills/` surface with the sibling subtask
  *"Fix `switchboard-manage` Entry"*. That subtask rewrites the **body** (§1/§2/§6) of
  `switchboard-manage/SKILL.md`; this subtask only touches **frontmatter/registry**
  (manifest entry, category), and `switchboard-manage` already has valid frontmatter and a
  correct `no-model` manifest entry — so there is **no file-region overlap**. See `## Dependencies`.

## Dependencies

- `sess_local_agent_skills_improvements — feature "Agent skills improvements"` — sibling subtask
  *"Fix `switchboard-manage` Entry: Local-Markdown-First, Workspace-Scoped, Low-Noise Console"*.
  Non-blocking, complementary. This subtask supplies the mirror-generation mechanism
  (`MIRROR_MANIFEST` → `.claude/skills/`) that the sibling's "regenerate the mirror" note
  depends on. They edit disjoint regions of `switchboard-manage/SKILL.md` (registry vs body) and
  can land in either order.

## Adversarial Synthesis

**Risk Summary:** The dominant risk is editing `MIRROR_MANIFEST` — control-plane TS that
defines the skill set for ~4,000 installs — where a wrong `source:` path silently drops a skill
and a wrong `invocation` mis-scopes it. Mitigation: treat the manifest as authoritative, edit
entries in place (never relocate a referenced source file without updating its entry in the
same commit), and verify by regenerating the mirror and diffing the resulting `.claude/skills/`
against both the manifest and `AGENTS.md`. Secondary risk is deciding `worktree_cleanup`'s fate
without confirming its endpoint is live — flagged for user review rather than guessed.

## Proposed Changes

### `src/services/ClaudeCodeMirrorService.ts` (`MIRROR_MANIFEST`, lines 46–156)
- **Context:** The authoritative Claude Code skill registry. Each entry = `{ source, name,
  invocation, allowedTools?, descriptionFallback? }`.
- **Logic:** Reconcile against `.agents/` and `AGENTS.md`:
  - Add an entry for `create-feature-from-plans` (pending the user's "regularize" decision),
    pointing at a new source (below), `invocation: 'default'` (it is user-callable per its
    AGENTS.md row).
  - Add or remove `worktree_cleanup` per the User-Review decision (add
    `{ source: 'skills/worktree_cleanup.md', name: 'worktree-cleanup', invocation: 'no-model', allowedTools: 'Bash' }`
    if wired up; otherwise remove the source + AGENTS.md row instead).
- **Implementation:** Append to the array following the existing formatting; do not reorder or
  restyle unrelated entries.
- **Edge Cases:** Every `source:` must resolve (`resolveSourceFile`); a directory source must
  contain `SKILL.md`. Do not move any currently-referenced source file.

### `AGENTS.md` (skills table, ~lines 100–115)
- **Context:** Human/Antigravity-facing registry; source of truth per project convention
  (edit `.agents/`/`AGENTS.md`, never generated `CLAUDE.md`/`.claude/`).
- **Logic:** Ensure every advertised row has a real, reachable skill; remove `worktree_cleanup`
  if retired; keep `create-feature-from-plans` (now backed by a source).
- **Edge Cases:** The generated `CLAUDE.md` and `.claude/skills/` are regenerated from source —
  do not hand-edit them.

### `.agents/skills/` source frontmatter (normalization)
- **Context:** Robustness/consistency for any host that reads source frontmatter directly.
- **Logic:** Add `name:` (kebab-case, matching the manifest) + `description:` to
  `advise_research/SKILL.md`; add `name:` to `group-into-features/SKILL.md` and
  `switchboard-orchestration/SKILL.md` (both already have `description:`). Optionally add
  frontmatter to the no-frontmatter flat files (`complexity_scoring.md`, `deep_planning.md`,
  `web_research.md`, `archive.md`, `constitution_builder.md`, `get_tickets.md`, `tuning.md`).
- **Implementation:** Additive frontmatter only — this cannot break the Claude Code mirror
  (manifest `name` still wins; a real `description:` simply replaces the fallback).
- **Edge Cases:** Keep the manifest `name` and any new frontmatter `name` in sync to avoid
  confusion, even though the manifest is what the generator uses.

### New source: `.agents/skills/create_feature_from_plans.md` (or `<dir>/SKILL.md`)
- **Context:** Regularize the orphaned `.claude`-only skill.
- **Logic:** Author a source from the existing `.claude/skills/create-feature-from-plans/SKILL.md`
  content, then point the new `MIRROR_MANIFEST` entry at it so it regenerates on the next Setup.
- **Edge Cases:** Once managed by the generator, the file becomes tracked in
  `.switchboard-generated.json` and will be overwritten on regen — author the *source*, not the
  mirror.

### Dead-file hygiene (optional)
- Remove `.agents/skills/switchboard_remote_notion.md.migrated.bak` (a legacy migration
  artifact; not a skill, correctly ignored by the generator, but clutter).

## Verification Plan

> Per session directive, **no compilation and no automated test runs** are part of this
> verification. Verification is registry-parity and regeneration-based.

### Automated Tests
- None run in this session (directive). If added later, a unit test over `MIRROR_MANIFEST`
  asserting every `source` resolves on disk and every `name` is unique/kebab-case would prevent
  regression of exactly the drift class this plan fixes.

### Manual acceptance
1. **Source→manifest parity:** every non-`_lib`, non-`.bak` file/dir under `.agents/skills/`
   (and intended `.agents/workflows/`) has a `MIRROR_MANIFEST` entry, OR is deliberately
   excluded with a stated reason. (Re-run the audit that found `worktree_cleanup`.)
2. **Manifest→disk parity after regen:** trigger a mirror regeneration (Setup command /
   version bump), then confirm `.claude/skills/` contains exactly the manifest's names — no
   orphans (`create-feature-from-plans` no longer orphaned), no missing (`worktree-cleanup`
   present iff kept, `switchboard-manage` now present).
3. **AGENTS.md parity:** every skills-table row maps to a reachable skill and vice versa; no
   advertised-but-unreachable rows remain.
4. **Frontmatter:** `advise_research`, `group-into-features`, `switchboard-orchestration` now
   carry a `name:` (and `advise_research` a `description:`).

## Uncertain Assumptions

The following is **not** verified in-code and was flagged to the user to confirm via web
research before implementation:

- **Does Antigravity perform its own filesystem auto-discovery of `.agents/skills/<name>/SKILL.md`
  (requiring the directory-plus-frontmatter shape), or does it register skills solely from the
  `AGENTS.md` skills table (model-invoked by description)?** This is the one thing that decides
  whether the source flat-vs-directory layout and source frontmatter matter *functionally* on
  Antigravity, or are pure hygiene. Everything about the Claude Code host is verified in
  `ClaudeCodeMirrorService.ts` (manifest-driven; layout-agnostic); only the Antigravity engine's
  behavior is unconfirmed. If Antigravity *does* auto-discover directories, the frontmatter
  normalization above becomes load-bearing (not just hygiene) and flat files may need directory
  wrappers **with coordinated `MIRROR_MANIFEST` source-path updates** — never a blind move.

## Recommendation

**Complexity 4 → Send to Coder.** Low LOC but control-plane-sensitive (`MIRROR_MANIFEST`) with
one genuine product decision (`worktree_cleanup`'s fate) already surfaced for the user. Ready to
execute once the User-Review decisions are confirmed and the Antigravity-discovery assumption is
resolved (or explicitly scoped to Claude Code only).
