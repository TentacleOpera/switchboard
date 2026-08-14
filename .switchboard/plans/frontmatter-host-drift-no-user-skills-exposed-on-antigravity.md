# Two skills deliberately hidden from Claude Code's slash menu are still exposed to Antigravity's discovery — strip their source frontmatter

## Goal

Delete the frontmatter blocks from `.agents/skills/terminal-coder-dispatch/SKILL.md` and `.agents/skills/rearrange-feature/SKILL.md`, and align the stale `descriptionFallback` for `design-system-builder` in `MIRROR_MANIFEST`. This makes the two hosts agree on which skills are user-facing, and it is a **verified zero-diff change** — the generated `.claude/skills/` mirror is byte-identical before and after, so `mirror:check` stays green and nothing needs regenerating.

### Problem Analysis

Skill exposure is controlled by two independent mechanisms, one per host:

- **Claude Code** reads the generated `.claude/skills/` mirror. Slash visibility is set by the `invocation` field in `MIRROR_MANIFEST` (`src/services/ClaudeCodeMirrorService.ts`): `'default'` = slash + model-auto, `'no-model'` = slash only, `'no-user'` = model-loadable but **hidden from the slash menu**.
- **Antigravity** reads `.agents/skills/` from the filesystem. The absence of a frontmatter block is what keeps a skill out of that discovery — the deliberate convention documented at `ClaudeCodeMirrorService.ts:40-46`. A frontmatter-less skill stays reachable by name through the AGENTS.md skills table and by literal path; it just is not advertised as a door.

The convention is followed almost everywhere: **36 of the 39** skill directories under `.agents/skills/` ship no frontmatter, and **45 of the 47** manifest entries carry a `descriptionFallback` precisely because the source has none. Frontmatter is the exception, and it means "this is a door."

Eight manifest sources carry frontmatter. Five are correct; three are not aligned with their `invocation`:

| Entry | source frontmatter | manifest `invocation` | Claude Code | Antigravity | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `switchboard` | yes | `default` | slash | discoverable | consistent — a front door |
| `switchboard-cloud` | yes | `default` | slash | discoverable | consistent — a front door |
| `switchboard-remote` | yes | `default` | slash | discoverable | consistent — a front door |
| `switchboard-memo` | yes | `default` | slash | discoverable | consistent — a front door |
| `design-system-builder` | yes | `default` | slash | discoverable | consistent, but its `descriptionFallback` has drifted (see below) |
| **`terminal-coder-dispatch`** | **yes** | **`no-user`** | **hidden** | **discoverable** | **drift — fix here** |
| **`rearrange-feature`** | **yes** | **`no-user`** | **hidden** | **discoverable** | **drift — fix here** |
| `refine-feature` | yes | `no-model` | slash | discoverable | undecided — see Outstanding Questions |

`terminal-coder-dispatch` is the sharpest case. Its own manifest comment calls it "directive-triggered via the `Drive` feature-workflow toggle, **not user-typed**", and `CLAUDE.md` repeats that verbatim. The manifest enforces it on Claude Code with `invocation: 'no-user'`. Then the source ships a frontmatter block, which advertises it as a door on the other host — the exact thing both comments say it must not be.

`rearrange-feature` is the same shape: `no-user` on Claude Code, frontmatter-advertised on Antigravity.

### Root Cause

The two mechanisms live in different files and neither validates the other. Setting `invocation: 'no-user'` is an edit to `src/services/ClaudeCodeMirrorService.ts`; suppressing Antigravity discovery is the *absence* of a block in a file under `.agents/`. An author who correctly hides a skill on one host gets no signal that the other host still shows it, because absence is not something a diff draws attention to. Both of these skills are recent additions authored the same way — a complete SKILL.md with a proper header — which is the natural thing to write and the wrong thing for a non-door.

This is the same lockstep-edit class as the `delegates` manifest miss (`mirror-check-red-delegates-skill-missing-manifest-entry.md`): one host's registry updated, the other's not. There the omission deleted a skill; here it over-exposes two.

### Why this is safe: neither skill is reached through frontmatter

Removing frontmatter cannot break either skill, because neither is invoked by filesystem discovery:

- **`terminal-coder-dispatch` is dispatched by literal path.** `src/services/KanbanProvider.ts:75` — `const DRIVE_FEATURE_PREFIX = 'This feature is to be driven through a coder terminal. Read and follow .agents/skills/terminal-coder-dispatch/SKILL.md.'` A path read does not consult frontmatter on any host.
- **`rearrange-feature` has no `src/` references at all** beyond its manifest entry. On Claude Code it is found by the mirror's `description:` line, which is produced by `descriptionFallback` and does not change. On Antigravity it is named in the AGENTS.md skills table, the same route the other 36 frontmatter-less skills use.

After the change both sit on exactly the footing every other non-door skill already sits on.

## Metadata

**Tags:** infrastructure, devops, refactor, reliability
**Complexity:** 3

## User Review Required

None.

## Complexity Audit

### Routine

- Delete a 4-line and a 5-line frontmatter block from two markdown files; change one word in one string literal. No code paths, no schema, no runtime behaviour, no migration.
- **Verified zero-diff.** Both removals were simulated through the generator's own `parseSource` + `buildSkillMd` and reproduce the committed mirror byte-for-byte (`terminal-coder-dispatch` sha `5ae7b747581f`, `rearrange-feature` sha `9a55f4fb6950`, unchanged in both directions). `.claude/skills/` needs no regeneration and no commit.
- Both skills' descriptions already exist verbatim as `descriptionFallback` in the manifest, so nothing is lost when the frontmatter goes.

### Complex / Risky

- **The temptation to keep going.** The audit table lists eight frontmatter-carrying sources. Exactly two are in scope. `design-system-builder` and the four front doors **must keep their frontmatter** — they are doors, and `switchboard-cloud` / `switchboard-remote` / `switchboard-memo` have **no `descriptionFallback` at all**, so stripping them would silently emit a mirror with no `description:` line. `refine-feature` is undecided and out of scope. An implementer who "finishes the job" breaks three front doors.
- **Do not regenerate the mirror.** This change is zero-diff by design; the only way `.claude/` moves is if something was done wrong. Treat any change under `.claude/skills/` as a failed edit, not as expected output.

## Edge-Case & Dependency Audit

- **Race conditions.** None. Static file content consumed at generation time.

- **Security.** None. No tool grants change — `allowedTools` is a manifest field and is untouched. Reducing a skill's advertisement is not a privilege change in either direction.

- **Side effects.** On Antigravity, the two skills stop appearing in frontmatter-driven discovery. They remain invocable by name via the AGENTS.md skills table (both are listed there) and, for `terminal-coder-dispatch`, by the literal path the `Drive` toggle already uses. On Claude Code nothing changes at all — the mirror is byte-identical.

- **The `body` is unaffected by the removal.** `parseSource()` already excludes the frontmatter block from `parsed.body`, and `buildSkillMd()` writes `parsed.body.replace(/^\n+/, '').trimEnd()`. Deleting the block from the source therefore yields the identical body string. This is why the change is zero-diff, and it is the property to preserve: delete **only** the `---` fence and the lines between the fences, nothing after.

- **`design-system-builder`'s fallback has drifted and is dead weight today.** Source frontmatter says `Interactively build, derive, or refine a project's HTML design system via an agent interview`; the manifest's `descriptionFallback` says `Interactively build or refine…` — "derive" is missing. `parseSource()` wins, so the mirror carries the source text and the fallback is unused. It is still worth aligning: the entry is `'default'` and keeps its frontmatter, but a stale fallback is a booby trap for whoever edits this next. Aligning it is also zero-diff (the fallback is not consulted while frontmatter exists).

- **Four manifest entries have no `descriptionFallback` at all** — `switchboard-cloud`, `switchboard-remote`, `switchboard-memo`, `refine-feature`. For those, the source frontmatter is the *only* producer of the mirror's `description:` line; `buildSkillMd()` emits no description line when both are absent. This is fine as-is and is called out so nobody strips those four thinking it is the same edit as this plan's.

- **Dependencies & conflicts.** `.agents/`, `.claude/`, `CLAUDE.md`, and `AGENTS.md` are shared surfaces. This change touches two files under `.agents/skills/` and one string in `src/services/ClaudeCodeMirrorService.ts`, and must touch nothing else in them. No gate other than `mirror:check` reads these files, and `mirror:check` is unaffected because the output is identical.

## Dependencies

- None hard. Shares a root cause with `mirror-check-red-delegates-skill-missing-manifest-entry.md` (same lockstep-edit class, opposite symptom) but neither blocks the other and they touch different lines.

## Adversarial Synthesis

**Risk Summary.** The change itself is inert — byte-identical mirror output, verified by simulation in both directions, so the automated gate cannot regress. The real risk is scope: the audit table hands an implementer eight frontmatter-carrying sources and only two are in scope, and three of the six out-of-scope ones (`switchboard-cloud`, `switchboard-remote`, `switchboard-memo`) have no `descriptionFallback`, so "finishing the job" strips the description line off three front doors. Secondary risk is a sloppy deletion that takes a blank line or an adjacent heading with the frontmatter fence, which would move the body and break byte-identity — caught by `mirror:check`, but only if nobody regenerates and commits the mirror to make it agree.

## Proposed Changes

### `.agents/skills/terminal-coder-dispatch/SKILL.md` — delete the frontmatter block

**Context.** The file currently opens with a 4-line frontmatter block (no `name:` key, only `description:`), followed by a blank line and the `# Skill: Terminal Coder Dispatch` heading.

**Implementation.** Delete lines 1-4 inclusive — the opening `---`, the `description:` line, the closing `---`, and the blank line that follows it. The file must now begin with `# Skill: Terminal Coder Dispatch` as its first line.

```diff
----
--description: Drive a feature's subtasks through a coder terminal — dispatch, callback, review, resend. The attended long-running single-coder pattern.
----
--
 # Skill: Terminal Coder Dispatch
```

**Edge cases.** The manifest entry (lines 81-84) already carries this exact description as `descriptionFallback` — verified character-for-character identical to the frontmatter text — so the mirror's `description:` line is unchanged. Do not edit the manifest entry.

### `.agents/skills/rearrange-feature/SKILL.md` — delete the frontmatter block

**Context.** Opens with a 5-line frontmatter block carrying both `name:` and `description:`, then a blank line, then `# Rearrange Feature`.

**Implementation.** Delete lines 1-5 inclusive — the opening `---`, the `name:` line, the `description:` line, the closing `---`, and the following blank line. The file must now begin with `# Rearrange Feature`.

```diff
----
--name: rearrange-feature
--description: Restructure a feature's subtasks — split one subtask into several, move scope between subtasks, merge, or reorder — WITHOUT rewriting their content. Structure-only; the missing counterpart to improve-feature (content) and group-into-features (composition).
----
--
 # Rearrange Feature
```

**Edge cases.** Dropping the `name:` key is harmless: `buildSkillMd()` writes `name: ${entry.name}` from the manifest and never reads `parsed.name`. (`parsed.name` is only populated so the `firstH1` fallback has somewhere to go; it is unused in the output.) The manifest entry (lines 173-176) carries the identical description as `descriptionFallback`. Do not edit the manifest entry.

### `src/services/ClaudeCodeMirrorService.ts` — align the stale `design-system-builder` fallback

**Context.** Manifest entry at lines 99-102. Its `descriptionFallback` predates a source edit that added "derive" to the frontmatter description; the two have silently diverged. `design-system-builder` is `invocation: 'default'` and **keeps its frontmatter** — it is a genuine door. This edit only removes the divergence so the fallback is not a trap later.

**Implementation.**

```diff
     {
         source: 'skills/design-system-builder', name: 'design-system-builder', invocation: 'default',
--        descriptionFallback: 'Interactively build or refine a project\'s HTML design system via an agent interview'
++        descriptionFallback: 'Interactively build, derive, or refine a project\'s HTML design system via an agent interview'
     },
```

**Edge cases.** Zero-diff: `parseSource()` returns a description for this source, so `descriptionFallback` is not consulted and the mirror does not move. Keep the `\'` escape in `project\'s` — the literal is single-quoted.

### Files that must NOT be touched

`.agents/workflows/switchboard.md`, `switchboard-cloud.md`, `switchboard-remote.md`, `switchboard-memo.md` — the four front doors, correctly frontmatter'd. Three of them have **no** `descriptionFallback`, so stripping them removes the mirror's description line entirely. `.agents/skills/design-system-builder/SKILL.md` — a door; its frontmatter stays. `.agents/skills/refine_feature.md` — out of scope, see Outstanding Questions. And nothing under `.claude/` — this change is zero-diff there.

## Verification Plan

The session authoring this carries **SKIP COMPILATION** and **SKIP TESTS** directives, so the gate run is deferred to CI. The compile-free tier below is decisive on its own.

### Compile-free verification (run these)

1. **First-line check.** `.agents/skills/terminal-coder-dispatch/SKILL.md` must now begin with `# Skill: Terminal Coder Dispatch`, and `.agents/skills/rearrange-feature/SKILL.md` with `# Rearrange Feature`. No leading blank line, no residual `---`.

2. **Byte-identity simulation — the decisive check.** Run the generator's `parseSource` + `buildSkillMd` logic over each edited source with its manifest entry and hash the result against the committed mirror. Both must match: `terminal-coder-dispatch` → `5ae7b747581f…`, `rearrange-feature` → `9a55f4fb6950…`. A mismatch means the deletion took a byte it should not have.

3. **Frontmatter census.** Re-run the survey: `.agents/skills/` must now report **1** directory with frontmatter (`design-system-builder`) and **38** without. Manifest sources with frontmatter drop from 8 to 6, and every remaining one must be `invocation: 'default'` except `refine-feature`.

4. **Diff hygiene.** `git diff --name-only` must list exactly three paths: the two SKILL.md files and `src/services/ClaudeCodeMirrorService.ts`. **Nothing under `.claude/`.** If `.claude/skills/**` appears, the mirror was regenerated — revert it and re-check step 2, because the regeneration will have papered over whatever step 2 would have caught.

### Gate tier — CI

5. `npm run compile-tests`, then `npm run mirror:check` — must stay green, reporting the same file count as before the change. This gate is the independent confirmation of step 2: it sha256-compares every regenerated file against its committed counterpart, so green means the mirror genuinely did not move.

### Manual

6. On Claude Code, confirm `terminal-coder-dispatch` and `rearrange-feature` still appear in the available-skills list (model-loadable) and are still absent from the slash menu — i.e. **unchanged**. This host is not supposed to notice this change; observing any difference here means something was edited that should not have been.

7. On Antigravity, confirm both skills have dropped out of frontmatter-driven discovery while remaining invocable by name (`skill: "rearrange-feature"`) via the AGENTS.md skills table, and that the `Drive` feature-workflow toggle still drives a coder terminal — it reads `.agents/skills/terminal-coder-dispatch/SKILL.md` by path (`KanbanProvider.ts:75`), which is frontmatter-independent, so this should be unaffected.

## Outstanding Questions

- **[user]** `refine-feature` (`.agents/skills/refine_feature.md`) carries frontmatter and is `invocation: 'no-model'` — slash-visible on Claude Code, discoverable on Antigravity — while `CLAUDE.md` describes it as a "backend-consumed skill" triggered by the Features-tab **Refine** button and states that the four front doors are "the ONLY user-typeable workflow commands". Should it be a `/refine-feature` slash command at all, or should it become `'no-user'` with its frontmatter stripped? — proceeding on the assumption that it stays **exactly as it is** and is out of scope here. Unlike the two skills in this plan it has **no `descriptionFallback`**, so stripping its frontmatter would delete the mirror's `description:` line and is *not* a zero-diff edit; it needs a fallback added in the same change. That makes it a different, non-inert task and it should not be bundled in.

## Agent Recommendation

**Send to Intern** (complexity 3) — three mechanical edits, all pre-verified zero-diff, with the exact byte-identity hashes supplied. The only way to get this wrong is to do more than it asks: the "Files that must NOT be touched" list is the load-bearing part of the plan, because three of the front doors have no `descriptionFallback` and stripping them removes their description silently.

The reviewer should check exactly two things: that `git diff --name-only` lists three files and **nothing under `.claude/`**, and that the frontmatter census now reads 1-with / 38-without under `.agents/skills/`. Both are one command each and together they cover every way this change can go wrong.
