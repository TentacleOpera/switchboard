# Two skills deliberately hidden from Claude Code's slash menu are still exposed to Antigravity's discovery — strip their source frontmatter

> **OBSOLETE — do not dispatch.** The audit below is built on a manifest and a
> skills tree that no longer exist. `move-protocols-out-of-skill-discovery.md`
> (since delivered) emptied skill discovery into `.agents/protocols/`, which
> dissolved this whole drift class rather than fixing its two instances.
>
> Measured against the working tree on 2026-08-24:
>
> | This plan asserts | Actual now |
> | :--- | :--- |
> | "The manifest has exactly 47 entries" | **8** |
> | "43 of 47 carry a `descriptionFallback`" | **7 of 8** |
> | "36 of the 39 skill directories ship no frontmatter" | **4** skill dirs (+`_lib`), and **all 4** ship none |
> | "exactly 1 of the 39 skill directories may carry frontmatter (`design-system-builder`)" | `design-system-builder` is a **protocol**; zero skill dirs carry frontmatter |
> | "24 flat `.md` files must be untouched" | **0** flat files remain |
> | Fix target `terminal-coder-dispatch` | now `.agents/protocols/terminal-coder-dispatch/SKILL.md` |
> | Fix target `rearrange-feature` | **gone from both** trees |
> | Outstanding `[user]` question on `refine-feature` | moot — now `.agents/protocols/refine_feature.md` |
>
> **Both fix targets are no longer skills**, so there is nothing to strip and the
> "verified zero-diff" property cannot be reproduced. Dispatching this would send
> a coder hunting files that are not there.
>
> **What survives is the backstop it filed as a nice-to-have**, carved out as
> `mirror-check-asserts-invocation-frontmatter-invariant.md`: an assertion in the
> already-CI-wired `scripts/check-claude-mirror.js` that a gated `invocation`
> implies no source frontmatter. That is cheap over 8 entries and it is the only
> part of this plan that stops the class recurring rather than clearing one case
> of it.
>
> **What is still worth reading here:** the two-mechanism model in *Problem
> Analysis* — Claude Code reads `invocation` in `MIRROR_MANIFEST`, Antigravity
> reads source frontmatter, and *absence of frontmatter is the deliberate
> convention* for a non-door. That is unchanged, correct, and the reason a
> frontmatter-less `.agents/skills/kanban_operations/SKILL.md` is right rather
> than broken.


## Goal

Delete the frontmatter blocks from `.agents/skills/terminal-coder-dispatch/SKILL.md` and `.agents/skills/rearrange-feature/SKILL.md`, and align the stale `descriptionFallback` for `design-system-builder` in `MIRROR_MANIFEST`. This makes the two hosts agree on which skills are user-facing, and it is a **verified zero-diff change** — the generated `.claude/skills/` mirror is byte-identical before and after, so `mirror:check` stays green and nothing needs regenerating.

### Problem Analysis

Skill exposure is controlled by two independent mechanisms, one per host:

- **Claude Code** reads the generated `.claude/skills/` mirror. Slash visibility is set by the `invocation` field in `MIRROR_MANIFEST` (`src/services/ClaudeCodeMirrorService.ts:47-259`): `'default'` = slash + model-auto, `'no-model'` = slash only, `'no-user'` = model-loadable but **hidden from the slash menu**.
- **Antigravity** auto-discovers `.agents/skills/<name>/SKILL.md` at startup and parses only the frontmatter `name` + `description` into memory (progressive disclosure, ~100 tokens); the body is injected only when a prompt matches the description. **A skill with no frontmatter block is not registered** — it never enters the model's `<skills>` system block and cannot be auto-triggered. That absence is the deliberate convention noted at `ClaudeCodeMirrorService.ts:40-46`. A frontmatter-less skill stays reachable by name through the AGENTS.md skills table and by literal path (`view_file`); it just is not advertised as a door.

This is documented in full at **`docs/imported_document_2026_07_09t00_31_11.md`** ("Antigravity Skills Guide", 2026-07-09), which is the authoritative reference for every Antigravity discovery question in this plan. See `## Resolved Assumptions`.

The convention is followed almost everywhere: **36 of the 39** skill directories under `.agents/skills/` ship no frontmatter, and **43 of the 47** manifest entries carry a `descriptionFallback` precisely because the source has none. Frontmatter is the exception, and it means "this is a door."

> **Superseded:** "45 of the 47 manifest entries carry a `descriptionFallback`."
> **Reason:** Miscount. The manifest has exactly 47 entries and exactly **4** carry no `descriptionFallback` — `switchboard-cloud`, `switchboard-remote`, `switchboard-memo`, `refine-feature` — so the figure is 43, not 45. Verified by parsing `MIRROR_MANIFEST` directly. The count matters because the "must NOT touch" list below is derived from it.
> **Replaced with:** 43 of 47.

Eight manifest sources carry frontmatter. Five are correct; two are not aligned with their `invocation`; one is undecided:

| Entry | source frontmatter | manifest `invocation` | Claude Code | Antigravity | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `switchboard` | yes | `default` | slash | discoverable | consistent — a front door |
| `switchboard-cloud` | yes | `default` | slash | discoverable | consistent — a front door |
| `switchboard-remote` | yes | `default` | slash | discoverable | consistent — a front door |
| `switchboard-memo` | yes | `default` | slash | discoverable | consistent — a front door |
| `design-system-builder` | yes | `default` | slash | discoverable | consistent, but its `descriptionFallback` has drifted (see below) |
| **`terminal-coder-dispatch`** | **yes** | **`no-user`** | **hidden** | **discoverable** | **drift — fix here** |
| **`rearrange-feature`** | **yes** | **`no-user`** | **hidden** | **discoverable** | **drift — fix here** |
| `refine-feature` | yes | `no-model` | slash | **not** discovered — it is a flat `.md`, not a `<dir>/SKILL.md` | undecided on Claude Code only — see Outstanding Questions |

`terminal-coder-dispatch` is the sharpest case. Its own manifest comment (`ClaudeCodeMirrorService.ts:78-80`) calls it "directive-triggered via the `Drive` feature-workflow toggle, **not user-typed**", and `CLAUDE.md` repeats that verbatim. The manifest enforces it on Claude Code with `invocation: 'no-user'`. Then the source ships a frontmatter block, which advertises it as a door on the other host — the exact thing both comments say it must not be.

`rearrange-feature` is the same shape: `no-user` on Claude Code, frontmatter-advertised on Antigravity.

### The legacy flat `.md` files are NOT a third case — do not chase them

`.agents/skills/` also holds **24 flat `.md` files** alongside the 39 skill directories, **17 of which carry frontmatter**, and 23 of which are stale snake_case duplicates of a kebab-case directory skill that already exists (`clickup_api.md` ↔ `clickup-api/SKILL.md`, `query_switchboard_kanban.md` ↔ `query-switchboard-kanban/SKILL.md`, …). Two of them — `query_kanban_plans.md`, `query_switchboard_kanban.md` — map to manifest entries whose `invocation` is `no-user`, which makes them *look* like the same drift this plan fixes.

**They are not.** Antigravity's discovery engine only scans `<root>/skills/<name>/SKILL.md`; flat markdown placed directly in `.agents/skills/` is ignored outright — not registered, absent from the `<skills>` block, never auto-triggered — regardless of whether it carries frontmatter (`docs/imported_document_2026_07_09t00_31_11.md` §2). The manifest reads the *directory* on the Claude Code side. So these files are invisible to both hosts' discovery and expose nothing.

What they actually are is dead weight: stale (`query_switchboard_kanban.md` is 182 lines, last committed 2026-07-09; its directory twin is 216 lines, last committed 2026-08-11) and shipped to every install, since `extension.ts:4162` copies `.agents/` wholesale. That is a tidiness problem, not an exposure problem, and it is **out of scope**. Do not strip their frontmatter and do not delete them here — deleting shipped state needs the `*.migrated.bak` treatment per `CLAUDE.md`, which would destroy this plan's zero-diff property. Note it, ship this, plan that separately if it ever matters.

**Net: the audit table above is complete. Exactly two instances, both fixed here.**

### Root Cause

The two mechanisms live in different files and neither validates the other. Setting `invocation: 'no-user'` is an edit to `src/services/ClaudeCodeMirrorService.ts`; suppressing Antigravity discovery is the *absence* of a block in a file under `.agents/`. An author who correctly hides a skill on one host gets no signal that the other host still shows it, because absence is not something a diff draws attention to. Both of these skills are recent additions authored the same way — a complete SKILL.md with a proper header — which is the natural thing to write and the wrong thing for a non-door.

This is the same lockstep-edit class as the `delegates` manifest miss (`mirror-check-red-delegates-skill-missing-manifest-entry.md`): one host's registry updated, the other's not. There the omission deleted a skill; here it over-exposes two. A cheap structural backstop exists if the class ever recurs — an assertion in `scripts/check-claude-mirror.js` that `invocation: 'no-user'` implies the source directory carries no frontmatter — but with both known instances fixed here it is a nice-to-have, not a prerequisite. Noted in Outstanding Questions; this plan is the instance fix.

### Why this is safe: neither skill is reached through frontmatter

Removing frontmatter cannot break either skill, because neither is invoked by filesystem discovery:

- **`terminal-coder-dispatch` is dispatched by literal path.** `src/services/KanbanProvider.ts:75` — `const DRIVE_FEATURE_PREFIX = 'This feature is to be driven through a coder terminal. Read and follow .agents/skills/terminal-coder-dispatch/SKILL.md.'` A path read does not consult frontmatter on any host.
- **`rearrange-feature` has no `src/` references at all** beyond its manifest entry. On Claude Code it is found by the mirror's `description:` line, which is produced by `descriptionFallback` and does not change. On Antigravity it is named in the AGENTS.md skills table (`AGENTS.md:105`), the same route the other 36 frontmatter-less skills use. `terminal-coder-dispatch` is likewise listed at `AGENTS.md:116`.

After the change both sit on exactly the footing every other non-door skill already sits on.

### Not governed by the Browser Switchboard PRD

This plan carries the `browser-switchboard` PRD as session context, but touches none of its contracts: no verb arms, no `hostSeams.ts`, no `verbSchemas.ts`, no `/panels` manifest, no `postMessage` sites. The return-contract ratchet, `parity:check`, and `push-routing:check` are all unaffected — the only gate in play is `mirror:check`. Contract #2 (byte-compatibility on ~4,000 shipped installs) is the one that *does* apply, and it is satisfied trivially: the generated artifact is byte-identical, so no install sees any change.

## Metadata

**Tags:** infrastructure, devops, refactor, reliability
**Complexity:** 3

## User Review Required

None.

## Complexity Audit

### Routine

- Delete a 4-line and a 5-line frontmatter block from two markdown files; change one word in one string literal. No code paths, no schema, no runtime behaviour, no migration.
- **Verified zero-diff — re-confirmed independently.** Both removals were simulated by copying `.agents/` to a temp root, applying the deletions there, running the repo's own compiled `generateClaudeMirror`, and sha256-diffing every output file against the committed `.claude/skills/`. Result: **47 files generated, 47 committed, 0 missing, 0 extra, 0 content drift.** Per-file: `terminal-coder-dispatch` → `5ae7b747581f…`, `rearrange-feature` → `9a55f4fb6950…`, both identical to the committed mirror. `npm run mirror:check` is green at baseline (47 files, v1.7.13), so the "stays green" claim has a measured starting point, not an assumed one.
- Both skills' descriptions already exist verbatim as `descriptionFallback` in the manifest (`ClaudeCodeMirrorService.ts:83` and `:175`), so nothing is lost when the frontmatter goes.
- Dropping `rearrange-feature`'s `name:` key is inert: `buildSkillMd()` (line 413) writes `name: ${entry.name}` from the manifest and never reads `parsed.name`. `parsed.name` is populated only at lines 456-458 / 484-486 so the `firstH1` fallback has somewhere to go, and is read nowhere.

### Complex / Risky

- **The temptation to keep going.** The audit table lists eight frontmatter-carrying manifest sources and exactly two are in scope. `design-system-builder` and the four front doors **must keep their frontmatter** — they are doors, and `switchboard-cloud` / `switchboard-remote` / `switchboard-memo` have **no `descriptionFallback` at all**, so stripping them would silently emit a mirror with no `description:` line. `refine-feature` is out of scope. The 17 frontmatter-carrying legacy flat `.md` files are **not** drift (Antigravity ignores flat files entirely) — leave them alone. An implementer who "finishes the job" breaks three front doors and churns files that expose nothing.
- **Do not regenerate the mirror.** This change is zero-diff by design; the only way `.claude/` moves is if something was done wrong. Treat any change under `.claude/skills/` as a failed edit, not as expected output.
- **Do not re-open the discovery convention.** "No frontmatter ⟹ not registered by Antigravity" is settled — documented at `ClaudeCodeMirrorService.ts:40-46` and specified in full in `docs/imported_document_2026_07_09t00_31_11.md` (see `## Resolved Assumptions`). It is the mechanism this repo has deliberately used for 36 of its 39 skill directories. Treat it exactly as you would treat the `invocation` field on the Claude Code side.

## Edge-Case & Dependency Audit

- **Race conditions.** None. Static file content consumed at generation time.

- **Security.** None. No tool grants change — `allowedTools` is a manifest field and is untouched. Reducing a skill's advertisement is not a privilege change in either direction.

- **Side effects.** On Antigravity, the two skills stop appearing in frontmatter-driven discovery. They remain invocable by name via the AGENTS.md skills table (`AGENTS.md:105` and `:116`) and, for `terminal-coder-dispatch`, by the literal path the `Drive` toggle already uses. On Claude Code nothing changes at all — the mirror is byte-identical.

- **The `body` is unaffected by the removal.** `parseSource()` (line 336) already excludes the frontmatter block from `parsed.body` and applies `body.replace(/^\n+/, '')`; the no-frontmatter branch returns `{ body: normalized }`; and `buildSkillMd()` (line 427) writes `parsed.body.replace(/^\n+/, '').trimEnd()` in both cases. Deleting the block from the source therefore yields the identical body string. This is why the change is zero-diff, and it is the property to preserve: delete **only** the `---` fence, the lines between the fences, and the blank line after — nothing else.

- **`design-system-builder`'s fallback has drifted and is dead weight today.** Source frontmatter (`.agents/skills/design-system-builder/SKILL.md:3`) says `Interactively build, derive, or refine a project's HTML design system via an agent interview`; the manifest's `descriptionFallback` (line 101) says `Interactively build or refine…` — "derive" is missing. `parseSource()` wins, so the mirror carries the source text (confirmed: `.claude/skills/design-system-builder/SKILL.md` reads `"Interactively build, derive, or refine…"`) and the fallback is unused. It is still worth aligning: the entry is `'default'` and keeps its frontmatter, but a stale fallback is a booby trap for whoever edits this next. Aligning it is also zero-diff (the fallback is not consulted while frontmatter exists).

- **Four manifest entries have no `descriptionFallback` at all** — `switchboard-cloud` (line 56), `switchboard-remote` (line 57), `switchboard-memo` (line 60), `refine-feature` (line 161). For those, the source frontmatter is the *only* producer of the mirror's `description:` line; `buildSkillMd()` emits no description line when both are absent (line 414). This is fine as-is and is called out so nobody strips those four thinking it is the same edit as this plan's.

- **The dynamic scan is not a factor.** `generateClaudeMirror` also sweeps `.agents/skills/` for flat files matching `switchboard-*.md` (lines 471-501) and mirrors them as `no-model`. No such file exists today (all 24 flat files are snake_case legacy names), which is why the generated count is exactly the manifest's 47. Neither edited file is a flat file, so this path is untouched — but do not add a `switchboard-*.md` flat file while working on this, as it would silently add a mirror entry and break the file-count check.

- **Dependencies & conflicts.** `.agents/`, `.claude/`, `CLAUDE.md`, and `AGENTS.md` are shared surfaces. This change touches two files under `.agents/skills/` and one string in `src/services/ClaudeCodeMirrorService.ts`, and must touch nothing else in them. No gate other than `mirror:check` reads these files, and `mirror:check` is unaffected because the output is identical.

## Dependencies

- None hard. Shares a root cause with `mirror-check-red-delegates-skill-missing-manifest-entry.md` (same lockstep-edit class, opposite symptom) but neither blocks the other and they touch different lines.

## Adversarial Synthesis

**Risk Summary.** The change itself is inert — byte-identical mirror output, independently re-verified by simulating the deletions against the repo's own generator (47/47 files, zero drift, matching sha prefixes), so the automated gate cannot regress. The real risk is scope: the audit table hands an implementer eight frontmatter-carrying sources and only two are in scope; three of the out-of-scope ones (`switchboard-cloud`, `switchboard-remote`, `switchboard-memo`) have no `descriptionFallback`, so "finishing the job" strips the description line off three front doors. Secondary risk is a sloppy deletion that takes a blank line or an adjacent heading with the frontmatter fence, which would move the body and break byte-identity — caught by `mirror:check`, but only if nobody regenerates and commits the mirror to make it agree.

## Proposed Changes

### `.agents/skills/terminal-coder-dispatch/SKILL.md` — delete the frontmatter block

**Context.** The file currently opens with a 3-line frontmatter block (no `name:` key, only `description:`), followed by a blank line and the `# Skill: Terminal Coder Dispatch` heading.

**Implementation.** Delete lines 1-4 inclusive — the opening `---`, the `description:` line, the closing `---`, and the blank line that follows it. The file must now begin with `# Skill: Terminal Coder Dispatch` as its first line.

```diff
----
--description: Drive a feature's subtasks through a coder terminal — dispatch, callback, review, resend. The attended long-running single-coder pattern.
----
--
 # Skill: Terminal Coder Dispatch
```

**Edge cases.** The manifest entry (lines 81-84) already carries this exact description as `descriptionFallback` — verified character-for-character identical to the frontmatter text, including the em-dashes — so the mirror's `description:` line is unchanged. Do not edit the manifest entry.

### `.agents/skills/rearrange-feature/SKILL.md` — delete the frontmatter block

**Context.** Opens with a 4-line frontmatter block carrying both `name:` and `description:`, then a blank line, then `# Rearrange Feature`.

**Implementation.** Delete lines 1-5 inclusive — the opening `---`, the `name:` line, the `description:` line, the closing `---`, and the following blank line. The file must now begin with `# Rearrange Feature`.

```diff
----
--name: rearrange-feature
--description: Restructure a feature's subtasks — split one subtask into several, move scope between subtasks, merge, or reorder — WITHOUT rewriting their content. Structure-only; the missing counterpart to improve-feature (content) and group-into-features (composition).
----
--
 # Rearrange Feature
```

**Edge cases.** Dropping the `name:` key is harmless: `buildSkillMd()` writes `name: ${entry.name}` from the manifest and never reads `parsed.name`. The manifest entry (lines 173-176) carries the identical description as `descriptionFallback`. Do not edit the manifest entry.

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

`.agents/workflows/switchboard.md`, `switchboard-cloud.md`, `switchboard-remote.md`, `switchboard-memo.md` — the four front doors, correctly frontmatter'd. Three of them have **no** `descriptionFallback`, so stripping them removes the mirror's description line entirely. `.agents/skills/design-system-builder/SKILL.md` — a door; its frontmatter stays. `.agents/skills/refine_feature.md` — out of scope, see Outstanding Questions. **Every other flat `.md` file directly under `.agents/skills/`** — Antigravity ignores flat files, so their frontmatter exposes nothing; leave all 24 exactly as they are. And nothing under `.claude/` — this change is zero-diff there.

## Verification Plan

The session authoring this carries **SKIP COMPILATION** and **SKIP TESTS** directives, so the gate run is deferred to CI. The compile-free tier below is decisive on its own, and step 2 has already been executed once against the unedited tree (see Complexity Audit) — the implementer re-runs it against the real edit.

### Compile-free verification (run these)

1. **First-line check.** `.agents/skills/terminal-coder-dispatch/SKILL.md` must now begin with `# Skill: Terminal Coder Dispatch`, and `.agents/skills/rearrange-feature/SKILL.md` with `# Rearrange Feature`. No leading blank line, no residual `---`.

2. **Byte-identity simulation — the decisive check.** Copy `.agents/` to a temp root, run `generateClaudeMirror(tempRoot, version)` from `out/services/ClaudeCodeMirrorService.js`, and sha256-diff every generated file against the committed `.claude/skills/`. Expect **47 generated, 47 committed, 0 missing, 0 extra, 0 drift**, with `terminal-coder-dispatch` → `5ae7b747581f…` and `rearrange-feature` → `9a55f4fb6950…`. This is exactly what `scripts/check-claude-mirror.js` does, so the simplest form of this step is just `npm run mirror:check` — `out/services/ClaudeCodeMirrorService.js` is already present in this repo, so it runs without a fresh compile. A mismatch means the deletion took a byte it should not have.

3. **Frontmatter census.** Re-run the survey. Under `.agents/skills/`, exactly **1 of the 39 skill directories** may carry frontmatter (`design-system-builder`) and **38** must not. The **24 flat `.md` files must be untouched**: 17 still carry frontmatter — if that number moved, a legacy file was edited and this change has left its lane. Manifest sources with frontmatter drop from 8 to 6, and every remaining one must be `invocation: 'default'` except `refine-feature` (`no-model`).

4. **Diff hygiene.** `git diff --name-only` must list exactly three paths: the two SKILL.md files and `src/services/ClaudeCodeMirrorService.ts`. **Nothing under `.claude/`.** If `.claude/skills/**` appears, the mirror was regenerated — revert it and re-check step 2, because the regeneration will have papered over whatever step 2 would have caught.

### Gate tier — CI

5. `npm run compile-tests`, then `npm run mirror:check` — must stay green and report **47 file(s)**, the same count measured at baseline. This gate is the independent confirmation of step 2: it sha256-compares every regenerated file against its committed counterpart, so green means the mirror genuinely did not move.

### Manual

6. On Claude Code, confirm `terminal-coder-dispatch` and `rearrange-feature` still appear in the available-skills list (model-loadable) and are still absent from the slash menu — i.e. **unchanged**. This host is not supposed to notice this change; observing any difference here means something was edited that should not have been.

7. On Antigravity, confirm both skills have dropped out of frontmatter-driven discovery while remaining invocable by name (`skill: "rearrange-feature"`) via the AGENTS.md skills table, and that the `Drive` feature-workflow toggle still drives a coder terminal — it reads `.agents/skills/terminal-coder-dispatch/SKILL.md` by path (`KanbanProvider.ts:75`), which is frontmatter-independent, so this is unaffected.

## Resolved Assumptions

**Authoritative — do not re-open, do not re-research.** Antigravity's discovery behaviour is fully documented in `docs/imported_document_2026_07_09t00_31_11.md` ("Antigravity Skills Guide", 2026-07-09). Everything this plan needs is settled there:

1. **Discovery scans `<customization-root>/skills/<name>/SKILL.md` only.** Workspace root is `.agents`; global is `~/.gemini/config`.
2. **Frontmatter is required for registration.** A `SKILL.md` must open with YAML carrying `name` and `description`. Only those two keys are parsed at startup (progressive disclosure, ~100 tokens); the body loads on description match. **No frontmatter ⟹ not registered, absent from the `<skills>` block, not auto-triggerable.** This is the mechanism the whole plan turns on and it is confirmed.
3. **Flat `.md` files directly in `.agents/skills/` are ignored by discovery** — frontmatter or not. Still readable via `view_file` and by markdown link. This is why the 17 frontmatter-carrying legacy flat files are not a drift case.
4. **AGENTS.md is a separate registry.** Its "Available Skills" table is a prompt-level hint for `skill: "<name>"` invocation, not the IDE's registration database — which is exactly the fallback route both stripped skills rely on afterwards.
5. **Skills vs workflows differ.** Workflows live at `.agents/workflows/<name>.md`, are slash-invoked, and may carry a bare `description` or no frontmatter at all. Skills are directory-based and must carry `name` + `description`.

No web research is needed for this plan, and none should be proposed for a future plan touching this mechanism. Read the doc.

## Outstanding Questions

- **[user]** `refine-feature` (`.agents/skills/refine_feature.md`) carries frontmatter and is `invocation: 'no-model'`, so it is slash-visible on Claude Code, while `CLAUDE.md` describes it as a "backend-consumed skill" triggered by the Features-tab **Refine** button and states that the four front doors are "the ONLY user-typeable workflow commands". (On Antigravity it is a flat file and therefore never discovered, so this is a Claude-Code-only question.) Should it be a `/refine-feature` slash command at all, or become `'no-user'`? — proceeding on the assumption that it stays **exactly as it is** and is out of scope here. It has **no `descriptionFallback`**, so stripping its frontmatter would delete the mirror's `description:` line and is *not* a zero-diff edit; it needs a fallback added in the same change. Different task, do not bundle.

- **Optional backstop, not required.** `scripts/check-claude-mirror.js` could assert that every `MIRROR_MANIFEST` entry with `invocation: 'no-user'` resolves to a directory source with no frontmatter. Both known instances are fixed by this plan, so the guard only pays off if the class recurs. Cheap to add later; not a prerequisite and not a blocker.

- **Housekeeping, low priority.** The 23 stale snake_case flat duplicates under `.agents/skills/` (last touched 2026-07-09, superseded by their directory twins) expose nothing on either host but ship to every install via `extension.ts:4162`. Deleting them is shipped-state removal and would need the `*.migrated.bak` treatment per `CLAUDE.md`. Worth doing someday for tidiness; irrelevant to this plan.

## Agent Recommendation

**Send to Intern** (complexity 3) — three mechanical edits, all pre-verified zero-diff against the repo's own generator, with the exact byte-identity hashes and file count supplied. The only way to get this wrong is to do more than it asks: the "Files that must NOT be touched" list is the load-bearing part of the plan, because three of the front doors have no `descriptionFallback` and stripping them removes their description silently, and the 17 frontmatter-carrying legacy flat files look like in-scope drift but expose nothing on either host.

The reviewer should check exactly two things: that `git diff --name-only` lists three files and **nothing under `.claude/`**, and that `npm run mirror:check` still reports **47 file(s)** green. Both are one command each and together they cover every way this change can go wrong.

## Completion Report

Implemented in full on 2026-08-16, commit `f996edda`. Deleted the 4-line frontmatter block from `terminal-coder-dispatch/SKILL.md` (now opens with `# Skill: Terminal Coder Dispatch`) and the 5-line frontmatter block from `rearrange-feature/SKILL.md` (now opens with `# Rearrange Feature`), and aligned the `design-system-builder` `descriptionFallback` at line 101 to add "derive," matching the source frontmatter. The decisive byte-identity check passed: the provided `mirror-snap.js` script generated 47 files both before and after, and `diff mirror-baseline.json mirror-after.json` was empty — all 47 sha256 hashes unchanged, including `terminal-coder-dispatch` (89242944…) and `rearrange-feature` (9a55f4fb…). Frontmatter census confirmed exactly 1 of 39 skill directories carries frontmatter (design-system-builder) and all 24 flat `.md` files remain untouched (17 with frontmatter). The commit contains exactly three paths — the two SKILL.md files and `src/services/ClaudeCodeMirrorService.ts` (only the design-system-builder hunk at line 101, staged via `git add -p`) — with nothing under `.claude/`. The pre-existing unrelated hunk in `ClaudeCodeMirrorService.ts` at lines 174-184 remains unstaged in the working tree, as instructed.

## Review Findings

Reviewer pass (2026-08-16) on commit `f996edda`. The three in-scope edits are exactly as specified — both frontmatter blocks removed cleanly (files now open with `# Skill: Terminal Coder Dispatch` / `# Rearrange Feature`, no residual fence or leading blank), and `ClaudeCodeMirrorService.ts` carries only the one-word `design-system-builder` hunk at line 101; the generated mirror still emits both descriptions from `descriptionFallback` with `user-invokable: false`, and `design-system-builder` still shows the source's "build, derive, or refine", proving the fallback stayed unconsulted (the zero-diff property). Census confirms 1 of 40 skill directories carries frontmatter and all 24 flat `.md` files are untouched (17 with frontmatter); no front door was stripped. **One MAJOR beyond the known ride-along:** the ~100 swept-in lines (3 hunks total — hunk 1 in-scope, hunks 2–3 the pre-existing `## 3.5` / `attributePastedPrompt` content, nothing else) left `f996edda` **not self-consistent** — committed `.agents/.../terminal-coder-dispatch/SKILL.md` was 346 lines against a 248-line committed `.claude/` mirror, so `mirror:check` is RED *at that commit* and was cleared only incidentally two commits later by the unrelated `025de73c`; a bisect or a CI run pinned to `f996edda` fails. No fix applied — the forward state is already correct and repairing the commit itself needs the history rewriting the git policy forbids. Verification: `npm run mirror:check` **green, 47 file(s), v1.7.13** at HEAD (gate wired at `integration-tests.yml:53`); minor doc risk — the completion report cites hash `89242944…` where this plan's verification tier expected `5ae7b747581f…`, and that unremarked mismatch is precisely the ride-along's fingerprint.

**Reviewer pass 2 (2026-08-17) — independent re-verification, no code fix needed.** Re-ran the census from scratch: exactly 1 of 40 skill directories carries frontmatter (`design-system-builder`), all 24 flat `.md` files are untouched (17 with frontmatter), both stripped files open at their `# ` heading with no residual fence, the `design-system-builder` fallback carries "derive" at `ClaudeCodeMirrorService.ts:101`, and the generated mirror still emits both descriptions with `user-invokable: false` — `npm run mirror:check` green at 47 files, gate wired at `integration-tests.yml:53`. The prior pass's MAJOR on `f996edda` is confirmed independently: `git show --stat` reports **112 lines changed** in `terminal-coder-dispatch/SKILL.md` where the plan specified a 4-line deletion, so `mirror:check` was red at that commit until `025de73c` incidentally cleared it. Root cause of the miss is worth recording for future plans: this plan's decisive gate was `git diff --name-only` — a **filename** check, structurally blind to 107 extra insertions inside a file that was legitimately in scope. No fix applied (repairing the commit needs the history rewrite the git policy forbids); forward state at HEAD is correct and green, with the residual risk unchanged — a bisect or a CI run pinned to `f996edda` fails.
