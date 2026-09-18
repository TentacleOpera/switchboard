# Agent Skills Are Undiscoverable to Any Harness That Validates Frontmatter

## Goal

Every skill under `.agents/skills/` carries `name` + `description` frontmatter and a correct
invocation category, so a harness that validates on discovery registers it instead of rejecting
it — and the categories match what each skill actually is, rather than putting reference documents
and backend hooks in the user's slash-command menu.

### The problem, and the root cause

**Observed 2026-09-18 on the tower.** `pi` (`@earendil-works/pi-coding-agent` 0.85.1) scanned the
repo and rejected seven of seven skills:

```
[Skill conflicts]
  ~/switchboard/.agents/skills/external-team-lead/SKILL.md        description is required
  ~/switchboard/.agents/skills/improve-feature/SKILL.md           description is required
  ~/switchboard/.agents/skills/kanban_operations/SKILL.md         description is required
  ~/switchboard/.agents/skills/kanban_operations/SKILL.md         name contains invalid characters
                                                                  (must be lowercase a-z, 0-9, hyphens only)
  ~/switchboard/.agents/skills/manage-features/SKILL.md           description is required
  ~/switchboard/.agents/skills/query-kanban/SKILL.md              description is required
  ~/switchboard/.agents/skills/switchboard-orchestration/SKILL.md description is required
  ~/switchboard/.agents/skills/worktree-cleanup/SKILL.md          description is required
```

**The two trees diverged and only one was ever correct.** All eight `.claude/skills/*/SKILL.md`
carry frontmatter. **Zero** of the seven `.agents/skills/*/SKILL.md` did — every one began
straight into markdown. The same divergence produced the naming fault:
`.claude/skills/kanban-operations` (hyphen, valid) against `.agents/skills/kanban_operations`
(underscore, rejected).

**This has been true for the entire life of the files.** `git log` on
`.agents/skills/query-kanban/SKILL.md` shows 14 commits and **not one revision with frontmatter**.
It was never added and then lost; it was never there.

**The earlier card was closed without the work happening.** Card `2ba95e8c` ("Audit and Restructure
Agent Skills to Prevent Discovery Failures", created 2026-07-08) sits in the cold store as
`kanban_column = COMPLETED`, `status = completed`, `completed_at` **empty**, `updated_at`
**2026-09-09T06:55:30Z** — the same date carried by 1,636 other completed rows from a bulk
operation. The plan's own review section records three decisions as "confirmed by the user
(2026-07-09)" and lists "Files changed by this review", yet the frontmatter those decisions
required does not exist in any commit. A card marked done, archived, and never done.

### Root cause

Discovery on a filesystem harness is *validating*, and the repo treated frontmatter as decoration.
A skill with no `description` is not a degraded skill — it is an absent one, and the harness says
so loudly while the repo shows a directory that looks present and correct. The `.claude` tree was
kept correct because Claude Code's own generation enforced it; `.agents` had no enforcement and
drifted from day one.

## What has already been done (2026-09-18)

Applied directly and verified with `pi auth check` reporting `ready`:

- **Frontmatter added to all seven** `.agents/skills/*/SKILL.md`. `name` and `description` for
  `kanban_operations`, `manage-features`, `query-kanban` and `worktree-cleanup` were taken verbatim
  from their `.claude` counterparts; the three with no counterpart
  (`external-team-lead`, `improve-feature`, `switchboard-orchestration`) were written from their
  own opening sections.
- **Invocation categories set**, because unrestricted frontmatter had put reference documents and a
  backend hook into the slash-command menu:

  | skill | user-invokable | model auto-invoke | reason |
  | :--- | :---: | :---: | :--- |
  | `manage-features` | yes | yes | genuine user workflow |
  | `kanban_operations` | yes | **no** | its own banner: "MANUAL FALLBACK ONLY" |
  | `worktree-cleanup` | yes | **no** | "only after a user-confirmed merge" |
  | `query-kanban` | **no** | yes | carried from `.claude` |
  | `external-team-lead` | **no** | yes | operating-mode doc an agent adopts |
  | `switchboard-orchestration` | **no** | yes | reference HTTP contract |
  | `improve-feature` | **no** | **no** | backend-dispatched; authorised to delete plan files |

  `improve-feature` carries both restrictions because `agentPromptBuilder.ts:1771` resolves it as
  `DEFAULT_FEATURE_PLANNER_WORKFLOW` and fires it when a card reaches PLAN REVIEWED. Its body states
  "This skill is authorised to cut" and it `git rm`s plan files with no per-run confirmation gate.
  Registering it keeps the path resolvable for the prompt builder while keeping it out of both
  invocation paths.

## What remains

### 1. The `kanban_operations` directory name — measure before renaming

Frontmatter now declares `name: kanban-operations` inside a directory still called
`kanban_operations`. **Check whether pi still reports the name error**: if it reads the name from
frontmatter, this is already resolved and the rename is unnecessary.

If the error persists, the rename is **not a one-line change**. There are **424 references** to
`kanban_operations` in the repo, **187 of them path references**, including live prompt generation
that hands agents a runnable command:

```
src/services/KanbanProvider.ts:7768   node .agents/skills/kanban_operations/move-card.js …
src/services/KanbanProvider.ts:7811   node .agents/skills/kanban_operations/move-card.js …
src/services/SparkContextExporter.ts:296
src/services/bundledProtocols.ts:188  (embedded inside a protocol body string)
```

A rename that misses any of these hands an agent a path that does not exist — strictly worse than a
validation warning. It must be done as one mechanical pass across all 187 sites, including the
strings embedded in `bundledProtocols.ts`, with a grep asserting zero survivors.

### 2. A gate, so this cannot recur

A contract test asserting every `.agents/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md` has
non-empty `name` and `description`, and that `name` matches `^[a-z0-9-]+$`. This is the whole reason
the fault survived fourteen commits and a completed card: nothing checked.

Extend it to assert the two trees do not disagree about a skill that exists in both — same `name`,
same invocation category — since that divergence is what produced the original fault.

### 3. `create-feature-from-plans` has no `.agents` source

The earlier card resolved to author one so the local/remote pair is complete. It still does not
exist. Confirm it is still wanted before writing it.

## Non-goals

- **`MIRROR_MANIFEST` lockstep updates.** The previous revision of this plan devoted five sections
  and 21 references to keeping `ClaudeCodeMirrorService.ts`'s `MIRROR_MANIFEST` in step with every
  source move. **The manifest is being retired** — 400+ lines of code to avoid an agent maintaining
  eight files — so that work is deleted rather than carried forward. Any change here edits the skill
  files directly.
- **Rewriting skill bodies for small models.** Owned by
  `the-skill-layer-installs-to-two-harnesses-and-reads-like-a-manual.md`, which depends on this card.
- **Scaffolding skills into arbitrary harnesses.** Same plan; that is `switchboard agent-setup`.
- **The two deliberately-flat backend hooks.** `refine_ticket` and `refine_feature` are
  AGENTS.md-flagged button hooks, not invocable via `skill:`, and stay flat and unregistered.

## Metadata

**Tags:** bugfix, docs, reliability, cli
**Complexity:** 3

## Scope

`.agents/skills/*/SKILL.md` and a contract test. No host code changes, so no composition-root
divergence to audit. The rename in item 1, if it proves necessary, additionally touches
`KanbanProvider.ts`, `SparkContextExporter.ts` and `bundledProtocols.ts` — mechanically, as string
replacements.

## Complexity Audit

### Routine

- The frontmatter and categories (done).
- The contract test.

### Complex / Risky

- **The 187-site rename**, if item 1 shows it is needed. The risk is not difficulty but coverage:
  a missed site is a runnable command handed to an agent that fails at execution time, inside a
  prompt, where nothing validates it first.
- **Invocation categories are judgement, not mechanics.** Getting one wrong either hides a skill the
  operator wants or exposes a destructive one. `improve-feature` is the case that matters — it
  deletes plan files, and before today's change nothing stopped a model auto-invoking it.

## Edge-Case & Dependency Audit

- **A skill present in one tree and not the other.** Five of seven `.agents` skills have `.claude`
  counterparts; two do not, and `.claude` has one (`switchboard-cloud`, `switchboard-memo`,
  `switchboard`, `switchboard-remote`) with no `.agents` peer. The gate in item 2 should report
  asymmetry rather than fail on it — the trees serve different harnesses and need not be identical.
- **Harnesses disagree about frontmatter keys.** `disable-model-invocation` and `user-invokable` are
  Claude Code spellings. Whether pi honours them is unverified; if it ignores them, the categories
  above are advisory there and the restriction must be expressed however pi expresses it. **Verify
  before assuming the categories hold on pi.**
- **Security.** `improve-feature` deletes plan files and was model-invocable until today. Any new
  skill that mutates the repo must be categorised before it is registered, not after.

## Dependencies

- Blocks `the-skill-layer-installs-to-two-harnesses-and-reads-like-a-manual.md`, which names pi as
  its reference deployment and cannot scaffold a skill layer that the target harness rejects.

## Verification Plan

### Automated Tests

- **Contract** — every `SKILL.md` under both trees has non-empty `name` and `description`, and
  `name` matches `^[a-z0-9-]+$`. Fails against HEAD~1 of this change.
- **Contract** — a skill present in both trees declares the same `name` and the same invocation
  category.
- **Contract (only if item 1 proceeds)** — zero occurrences of `kanban_operations` remain in
  `src/`, `.agents/`, `.claude/` or `AGENTS.md`.

Run `npm run compile-tests` before any `test:contract:*` script.

### Manual Verification

`pi` scans the repo and reports no skill conflicts. The slash-command menu offers
`manage-features`, `kanban-operations` and `worktree-cleanup` — and does **not** offer
`improve-feature`, `switchboard-orchestration`, `external-team-lead` or `query-kanban`.

### Goal Invariants

1. No `SKILL.md` in either tree lacks `name` or `description`.
2. No skill `name` contains a character outside `[a-z0-9-]`.
3. `improve-feature` appears in neither the user's command menu nor the model's auto-invocable set.
4. A skill added with missing or malformed frontmatter fails a test rather than failing at
   discovery on an operator's machine.
