# Audit and Restructure Agent Skills to Prevent Discovery Failures

We audited the `.agents/skills` directory and found skills that are invisible to at least one
host's discovery layer, or whose frontmatter is inconsistent. The user's goal is to make the
skill **set** discoverable and coherent across *every* host, and to draw a clear line between
user-callable workflows, model-invocable skills, and backend/deep-linked helpers. The fix is
**host-split**: satisfy Antigravity's filesystem auto-discovery (directory + frontmatter) *and*
Claude Code's manifest-driven generation *at the same time* — moving a source file and updating
its `MIRROR_MANIFEST` entry in lockstep — while reconciling both against the `AGENTS.md` hint
table.

## Goal

Restructure and reconcile Switchboard's skill layer so every skill that should be discoverable
*is* discoverable on both hosts, no skill is advertised-but-unreachable or present-but-orphaned,
and each skill's invocation category (user-callable workflow / model-invocable skill /
backend-only helper) is correct and consistent. Concretely: convert real, auto-invocable skills
from flat `.md` files into `<name>/SKILL.md` directories with `name`+`description` frontmatter
(so Antigravity registers them), update each corresponding `MIRROR_MANIFEST` `source:` path in
the same change (so Claude Code keeps generating them), keep deliberately-unregistered backend
hooks flat, and fix the concrete registry drift already found.

### Background Context & Root Cause Analysis

**Observed problem (preserved — this is what the user saw):** Multiple skills in
`.agents/skills` appear malformed or inconsistently structured — some directories/files are
missing `name` and/or `description` frontmatter, and there is genuine ambiguity about which
files are user-callable workflows, which are model-invocable helper skills, and which are
backend-consumed or remote-only tools. Some advertised skills are not actually reachable.

**The mechanism is host-split — this is the corrected, research-confirmed root cause:**

- **Antigravity — filesystem auto-discovery (the original premise, CONFIRMED for this host).**
  Antigravity auto-discovers skills at startup from `<customization-root>/skills/<name>/SKILL.md`
  (workspace root = `.agents/`). Each `SKILL.md` **must** carry YAML frontmatter with `name` and
  `description` (progressive disclosure: only name+description are parsed at startup;
  the body loads on match). **Flat markdown files placed directly in `.agents/skills/` are
  ignored by the auto-discovery registry** — they cannot be semantically auto-triggered and do
  not appear in the model's `<skills>` block (they remain readable via direct file-view / markdown
  links, but are not *registered*). Workflows, by contrast, are flat files in `.agents/workflows/*.md`,
  invoked by slash-command. So for Antigravity the original plan was right: real skills need the
  directory + frontmatter shape.

  > **Superseded (my own first-pass over-correction):** *"The premise is incorrect; flat files
  > are mirrored fine and directory-vs-flat is irrelevant — this plan's approach would break
  > generation."*
  > **Reason:** That statement was true only for the Claude Code host and wrongly generalized to
  > "the premise is wrong." Web research (Agent Skills open spec, Dec 2025; Antigravity behavior)
  > confirms Antigravity **does** auto-discover `.agents/skills/<name>/SKILL.md` and **does**
  > ignore flat files — so the original premise holds for the host the protocol was authored for.
  > **Replaced with:** the host-split model in this section — the restructure is *correct*, and
  > the only thing the original plan omitted is that it must be done **in lockstep with
  > `MIRROR_MANIFEST`**, or Claude Code loses the skill.

- **Claude Code — manifest-driven generation (no filesystem discovery).** The Claude Code layer
  (`.claude/skills/<name>/SKILL.md`) is generated from a **hardcoded manifest**, `MIRROR_MANIFEST`
  in `src/services/ClaudeCodeMirrorService.ts:46–156`. Verified behavior:
  - A skill appears in Claude Code iff it has a manifest entry. Flat files are mirrored fine
    (`resolveSourceFile()` reads a flat `.md` directly and reads `<dir>/SKILL.md` for a directory
    entry — both shapes first-class).
  - Output `name` comes from the **manifest** (kebab-case), not source frontmatter; output
    `description` is `frontmatter.description || entry.descriptionFallback || ''`. So source
    frontmatter is *vestigial for Claude Code* but *load-bearing for Antigravity*.
  - **Therefore moving `skills/foo.md` → `skills/foo/SKILL.md` requires changing that entry's
    `source:` from `'skills/foo.md'` to `'skills/foo'` in the same commit.** Omit that, and
    `resolveSourceFile` returns `null` → the skill silently drops from Claude Code for ~4,000
    installs. This is the single most important execution rule in this plan.

- **`AGENTS.md` is a hint table, not a registry (research-confirmed).** The `AGENTS.md` skills
  table is a *user-maintained prompt-level convention* that helps the model pick/`skill:`-invoke
  a skill — it is **not** Antigravity's authoritative registration database (that is filesystem
  discovery of `SKILL.md` YAML). Keep it in sync as documentation, but do not treat presence in
  the table as "registered."

**Concrete registry drift already found (additive to the restructure):**
- **`worktree_cleanup.md`** — a real skill (frontmatter `description`, calls `POST /worktree/cleanup`),
  advertised in `AGENTS.md:111`, but **absent from `MIRROR_MANIFEST`** → never generated →
  invisible in Claude Code (confirmed: `worktree-cleanup` does not appear in the Claude Code
  skill list) **and** flat → invisible to Antigravity auto-discovery. Doubly unreachable.
- **`create-feature-from-plans`** — advertised in `AGENTS.md:109` and present as
  `.claude/skills/create-feature-from-plans/SKILL.md`, but has **no `.agents/` source** and **no
  `MIRROR_MANIFEST` entry** — a hand-authored `.claude`-only orphan that will not regenerate and
  has nothing for Antigravity to discover.
- **Mirror staleness** — `switchboard-manage` *is* in `MIRROR_MANIFEST` (line 65) yet
  `.claude/skills/switchboard-manage/` does not exist on disk (mirror regenerates only on
  version-change / Setup). "In the manifest" ≠ "currently on disk."
- **Frontmatter gaps** — `advise_research/SKILL.md` has no frontmatter; `group-into-features/SKILL.md`
  and `switchboard-orchestration/SKILL.md` have `description:` but no `name:`. Harmless for the
  Claude Code mirror, but these three are already directories, so on Antigravity the missing
  `name` blocks/degrades registration — a real fix, not just hygiene.

### Core Problems (restated against the real, host-split cause)
- **Flat skills are invisible to Antigravity auto-discovery.** Every real, auto/model-invocable
  skill currently shipped as a flat `.agents/skills/*.md` file does not register on Antigravity.
- **Advertised-but-unreachable / orphaned skills:** `worktree_cleanup` and
  `create-feature-from-plans` are live inconsistencies across hosts.
- **Restructure must be two-host-coordinated:** the Antigravity fix (flat→dir) silently breaks
  Claude Code unless `MIRROR_MANIFEST` `source:` paths are updated in lockstep.
- **Category ambiguity:** the workflow / skill / backend-helper distinction is real. It maps onto
  concrete layout + the existing `MIRROR_MANIFEST` `invocation` field (`default` / `no-user` /
  `no-model`) — not a new taxonomy to invent.

## Metadata

- **Tags:** refactor, devops, infrastructure, docs
- **Complexity:** 6

## User Review Required

**None outstanding — all three decisions confirmed by the user (2026-07-09):**

1. **`worktree_cleanup` → WIRE UP.** Restructure to `worktree_cleanup/SKILL.md` + add a
   `MIRROR_MANIFEST` entry (`no-model`, `Bash`). The `POST /worktree/cleanup` endpoint is live
   and implemented (verified: `LocalApiServer.ts:2390` → `cleanupWorktree` option →
   `KanbanProvider._cleanupWorktree` at `:10259`), so the skill body is correct — this fixes pure
   registry drift. `no-model` keeps it from auto-triggering, honoring its "only after a
   user-confirmed merge" precondition.
2. **`create-feature-from-plans` → REGULARIZE.** Author an
   `.agents/skills/create-feature-from-plans/SKILL.md` source (from the existing `.claude/` body)
   + add a `MIRROR_MANIFEST` entry (`default`) so it regenerates and is discoverable on both
   hosts, completing the local/remote pair with `create-feature`.
3. **Backend-only stay-flat set → ONLY `refine_ticket` + `refine_feature`.** These are the
   AGENTS.md-flagged button hooks ("not invocable via `skill:`") — they stay flat/unregistered.
   Every other skill that is meant to be user- or model-invocable (including the `no-model`
   proxies) converts to directory form.

## Complexity Audit

### Routine
- Mechanically moving a flat `skills/foo.md` → `skills/foo/SKILL.md` and adding `name`+`description`
  frontmatter.
- Editing `MIRROR_MANIFEST` entries and the `AGENTS.md` skills table.
- Deleting the `switchboard_remote_notion.md.migrated.bak` dead file (optional hygiene).

### Complex / Risky
- **Two-host lockstep is the whole risk.** `MIRROR_MANIFEST` is control-plane TS shipping to
  ~4,000 installs; every moved file must have its `source:` updated in the same change or the
  skill silently disappears from Claude Code. This is the dominant failure mode.
- **Bulk file moves** (~18–20 skills) touch many files at once; a single missed manifest update
  is invisible until a regeneration runs.
- Skill bodies traverse upward for `.agents/skills/_lib/sb_api_call.sh`; moving a skill one level
  deeper does not change that (the loop walks up to `.agents/skills`) — verify, don't assume.
- (`worktree_cleanup`'s `POST /worktree/cleanup` endpoint is confirmed live — no longer an open
  risk; its fate is a keep/retire product choice, not a liveness question.)

## Edge-Case & Dependency Audit

- **Race Conditions:** None at author time. The Claude Code mirror regenerates on
  version-change/Setup, not on save — so manifest/source edits are invisible in `.claude/` until
  a regeneration; Antigravity re-discovers at startup. Verify on both after changes.
- **Security:** None. No new endpoints (unless `worktree_cleanup` is wired up, reusing the
  existing token-authed `sb_api_call`).
- **Side Effects:** The generator only overwrites files tracked in `.claude/.switchboard-generated.json`;
  hand-authored `.claude/skills/` dirs are left alone (why the `create-feature-from-plans` orphan
  persists). Moving source files does not touch `_lib/` (never mirrored) or `*.migrated.bak`
  (excluded by naming).
- **Dependencies & Conflicts:** Shares the `switchboard-manage/SKILL.md` surface with the sibling
  subtask, but disjoint regions (this: frontmatter/registry — and that skill is *already* a proper
  directory with valid frontmatter + a correct manifest entry, so it needs no restructure; sibling:
  body §1/§2/§6). No conflict. See `## Dependencies`.

## Dependencies

- `sess_local_agent_skills_improvements — feature "Agent skills improvements"` — sibling subtask
  *"Fix `switchboard-manage` Entry: Local-Markdown-First, Workspace-Scoped, Low-Noise Console"*.
  Non-blocking, complementary. This subtask documents the mirror-generation mechanism
  (`MIRROR_MANIFEST` → `.claude/skills/`) that the sibling's "regenerate the mirror" note relies
  on. Order-independent (this one edits registry/frontmatter, the sibling edits the body).

## Adversarial Synthesis

**Risk Summary:** The restructure is correct for both hosts but carries a real blast radius: it
bulk-moves ~18–20 skill source files, and each move MUST update its `MIRROR_MANIFEST` `source:`
path in the same commit or the skill vanishes from Claude Code for ~4,000 installs. Mitigation:
treat file-move + manifest-edit as one atomic unit per skill; after the change, regenerate the
Claude Code mirror and diff `.claude/skills/` against the manifest, and restart/re-discover on
Antigravity to confirm each skill registers. (`worktree_cleanup`'s endpoint is confirmed live, so
its keep/retire is a product choice, not a risk.)

## Proposed Changes

### `.agents/skills/*` — restructure flat skills into directories (primary action)
- **Context:** Real, auto/model-invocable skills currently shipped as flat `.md` files
  (`archive.md`, `clickup_*.md`, `linear_*.md`, `notion_api.md`, `get_tickets.md`,
  `generate_diagram.md`, `query_*.md`, `web_research.md`, `deep_planning.md`,
  `complexity_scoring.md`, `constitution_builder.md`, `tuning.md`, `improve_remote_plan.md`,
  `create_feature.md`, and `worktree_cleanup.md`) are invisible to Antigravity discovery. Keep
  only `refine_ticket.md` + `refine_feature.md` flat (button-only backend hooks).
- **Logic:** For each, create `skills/<name>/SKILL.md` (kebab-case dir name matching the manifest)
  with `name:` + `description:` frontmatter, moving the body in.
- **Implementation:** Prefer `git mv` to preserve history. Keep the **deliberately-unregistered
  backend hooks** (`refine_ticket`, `refine_feature`) flat unless the user decides otherwise.
- **Edge Cases:** Verify the `_lib` upward-traversal in skill bodies still resolves after the move.

### `src/services/ClaudeCodeMirrorService.ts` (`MIRROR_MANIFEST`, lines 46–156) — lockstep source updates
- **Context:** Authoritative Claude Code registry; hardcodes `source:` paths.
- **Logic:** For every skill moved above, change its entry's `source:` from `'skills/foo.md'` to
  `'skills/foo'`. Add entries for `create-feature-from-plans` (regularized, `default`) and
  `worktree-cleanup` (`no-model`, `Bash`). Note the `/switchboard-*` alias entries (lines 141–155)
  reuse the same `source:` — update those too so aliases don't break.
- **Implementation:** Edit entries in place; do not reorder/restyle unrelated ones. **Never move a
  file without its matching manifest edit in the same commit.**
- **Edge Cases:** Every `source:` must resolve; a directory source must contain `SKILL.md`.

### `.agents/skills/` frontmatter normalization (for the already-directory skills)
- Add `name:` to `group-into-features/SKILL.md` and `switchboard-orchestration/SKILL.md`; add
  `name:`+`description:` to `advise_research/SKILL.md`. These are directories already, so the
  missing `name` is a real Antigravity-registration gap.

### New source: `.agents/skills/create-feature-from-plans/SKILL.md`
- Author from the existing `.claude/skills/create-feature-from-plans/SKILL.md` content; add a
  `MIRROR_MANIFEST` entry (`invocation: 'default'`) so it regenerates on both hosts instead of
  surviving as an untracked mirror.

### `AGENTS.md` (skills table, ~lines 100–115)
- Keep the hint table in sync: ensure every row maps to a reachable skill; remove `worktree_cleanup`
  if retired. Do not hand-edit the generated `CLAUDE.md` / `.claude/skills/`.

### Dead-file hygiene (optional)
- Remove `.agents/skills/switchboard_remote_notion.md.migrated.bak` (legacy artifact, not a skill).

## Verification Plan

> Per session directive, **no compilation and no automated test runs** in this session.
> Verification is registry-parity, regeneration, and (ideally) a two-host discovery check.

### Automated Tests
- None run in this session (directive). If added later, a unit test over `MIRROR_MANIFEST`
  asserting every `source` resolves on disk and every `name` is unique/kebab-case would catch the
  exact "moved a file, forgot the manifest" regression.

### Manual acceptance
1. **Manifest ↔ source parity:** every `MIRROR_MANIFEST` `source:` resolves to a real file/dir
   (a directory source contains `SKILL.md`) after the moves.
2. **Claude Code (manifest→disk):** regenerate (Setup / version bump), confirm `.claude/skills/`
   contains exactly the manifest's names — no orphans, none missing.
3. **Antigravity (filesystem discovery):** the restructured skills now appear as directories with
   `name`+`description` frontmatter; on restart, the intended skills register (appear in the
   model's skills block / are `skill:`-invocable) and the backend-only hooks deliberately do not.
4. **AGENTS.md parity:** every advertised row maps to a reachable skill and vice versa.

## Resolved Assumption (was "Uncertain")

The one open question at first-pass — *does Antigravity auto-discover `.agents/skills/<name>/SKILL.md`
or rely solely on the `AGENTS.md` table?* — was **resolved by web research** (Agent Skills open
spec, Dec 2025): Antigravity **does** auto-discover `.agents/skills/<name>/SKILL.md` directories,
**requires** `name`+`description` frontmatter, **ignores** flat files in `skills/`, and treats
`AGENTS.md` as a hint table, not the registry. This plan is written to that finding. (Minor,
non-blocking: research noted legacy `.agent/skills/` singular matching in older versions and an
optional `skills.json` manual-registration override — neither changes this plan.)

## Recommendation

**Complexity 6 → Send to Coder** (upper Coder / Coder-Lead boundary due to the ~4,000-install
blast radius of `MIRROR_MANIFEST`). Execute as atomic per-skill units (move file + update manifest
`source:` + aliases together), then verify on both hosts. All three product decisions are
confirmed — **ready to execute**.

---

## Code Review — In-Place Reviewer Pass (2026-07-09)

Reviewed the committed implementation (`a4ad186`) against this plan. **Result: implementation is
correct and complete for the plan's stated scope; one MAJOR consumer-side regression found and
fixed** — the file moves left dangling `.agents/skills/<name>.md` references in code that emits
agent prompts, exactly the "advertised-but-unreachable" class this plan set out to eliminate, but
via consumers the plan did not enumerate.

### Findings by severity
- **MAJOR — dangling skill-path references introduced by the moves (FIXED).** The flat→dir moves
  broke 8 hardcoded `.agents/skills/<name>.md` references that resolve to now-404 paths. These are
  emitted as agent prompts / doc links and would 404 for ~4,000 installs once 1.7.6 scaffolds the
  new layout:
  - `src/services/PlanningPanelProvider.ts:1435` — `constitution_builder.md` → `constitution-builder/SKILL.md`
  - `src/services/PlanningPanelProvider.ts:1441` — `tuning.md` → `tuning/SKILL.md`
  - `src/services/PlanningPanelProvider.ts:4633` / `:4652` — `constitution_builder.md` (build + update button flows) → `constitution-builder/SKILL.md`
  - `src/services/KanbanProvider.ts:9682` — `worktree_cleanup` skill (`worktree_cleanup.md`) → `worktree-cleanup` skill (`worktree-cleanup/SKILL.md`)
  - `.agents/workflows/switchboard-orchestrator.md:102` — `worktree_cleanup.md` → `worktree-cleanup/SKILL.md`
  - `.agents/skills/query-switchboard-kanban/SKILL.md:182` and `.agents/skills/query_archive/SKILL.md:55` — cross-links to `query_kanban_plans.md` (also a machine-absolute `file:///Users/...` path) → workspace-relative `../query-kanban-plans/SKILL.md`
- **NIT — pre-existing bare underscore skill-name refs (NOT fixed; out of scope).** `agentPromptBuilder.ts:622` (`skill: "complexity_scoring"`), `:641/643` (`web_research skill`), `:663` (`deep_planning skill`), `planning.js:161/182/…` (`get_tickets skill`, `generate_diagram skill`). The manifest diff confirms every `name:` slug was ALREADY kebab before this commit — so these mismatches pre-date this change and were not introduced by it. They are natural-language references (LLM-tolerant), so low-impact, but a follow-up should align them and the plan's proposed manifest unit-test should also assert in-code skill-name references match a manifest `name`.

### Verified GOOD (no change needed)
- **Manifest ↔ disk parity:** all 41 `MIRROR_MANIFEST` sources resolve — every directory source contains `SKILL.md`, every flat source exists (script-verified).
- **Frontmatter:** all 30 directory skills carry BOTH `name:` and `description:` (the three gaps the plan called out — `advise_research`, `group-into-features`, `switchboard-orchestration` — are fixed).
- **No orphans:** every on-disk skill dir (except `_lib`) is referenced by the manifest.
- **`_lib` traversal safe:** skill bodies resolve `_lib/sb_api_call.sh` via a `$PWD` walk-up loop (or workspace-root-relative `$CUR/.agents/skills/_lib/...`), independent of the skill file's own depth — deeper nesting cannot break it, as the plan predicted.
- **Drift fixed:** `worktree-cleanup` wired (manifest `no-model` + dir); `create-feature-from-plans` regularized (`.agents/` source + `default` manifest entry); dead `switchboard_remote_notion.md.migrated.bak` removed; `refine_ticket`/`refine_feature` correctly kept flat.

### Files changed by this review
- `src/services/PlanningPanelProvider.ts`, `src/services/KanbanProvider.ts`,
  `.agents/workflows/switchboard-orchestrator.md`,
  `.agents/skills/query-switchboard-kanban/SKILL.md`, `.agents/skills/query_archive/SKILL.md`.

### Validation (per directive: no compile, no tests)
- Re-ran the stale-path sweep → **zero** remaining `.agents/skills/<name>.md` file-path references.
- Confirmed the four new targets exist on disk. Edits are string-literal-content only (backtick balance preserved) — no type/syntax surface touched.

### Remaining risks
- The two-host mirror was not regenerated in-session (regen fires on version bump / Setup — the release subtask). Parity is verified at the manifest↔source level; the actual `.claude/skills/` regen should be spot-checked after 1.7.6 installs.
- The pre-existing underscore skill-name NIT remains for a follow-up (not shipped-state regression).
