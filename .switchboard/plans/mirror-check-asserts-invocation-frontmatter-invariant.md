# `mirror:check` must assert that a gated skill carries no source frontmatter

## Goal

Add one assertion to `scripts/check-claude-mirror.js`: for every `MIRROR_MANIFEST`
entry whose `invocation` is `'no-user'` or `'no-model'`, the source directory under
`.agents/skills/` must carry **no frontmatter block**. Fail `mirror:check` when it
does, naming the entry and both files.

### Problem Analysis

Skill exposure is controlled by two independent mechanisms, one per host, and
neither validates the other:

- **Claude Code** reads the generated `.claude/skills/` mirror. Visibility comes
  from the `invocation` field in `MIRROR_MANIFEST` (`src/services/ClaudeCodeMirrorService.ts:47`):
  `'default'` = slash + model-auto, `'no-model'` = slash only (the user may type
  it, the model may not call it), `'no-user'` = model-loadable but hidden from
  the slash menu.
- **Antigravity** auto-discovers `.agents/skills/<name>/SKILL.md` and parses only
  the frontmatter `name` + `description`. **A skill with no frontmatter block is
  not registered** — it never enters the `<skills>` system block and cannot be
  auto-triggered. That absence is the deliberate convention (noted at
  `ClaudeCodeMirrorService.ts:40-46`); frontmatter means "this is a door".

So hiding a skill on one host is an edit to a TypeScript file, and hiding it on
the other is the *absence* of a block in a markdown file. Do the first and forget
the second, and the skill is gated on Claude Code while still advertised on
Antigravity.

**This has already happened twice**, in `terminal-coder-dispatch` and
`rearrange-feature` — both `no-user` in the manifest, both shipping a complete
SKILL.md with a proper header, which is the natural thing to write and the wrong
thing for a non-door. Those two instances are now moot: they became protocols
when skill discovery was emptied into `.agents/protocols/` (see
`move-protocols-out-of-skill-discovery.md`, and the OBSOLETE marker on
`frontmatter-host-drift-no-user-skills-exposed-on-antigravity.md`, the plan this
one is carved out of). **The instances went; the mechanism that produced them did
not.**

**Extend the invariant to `no-model`, not just `no-user`.** The parent plan scoped
itself to `no-user` because that was where its two instances sat. `no-model` is
the same asymmetry pointed the other way, and it is the more dangerous half: the
two `no-model` entries are `kanban-operations` and `worktree-cleanup` — the board
and worktree **mutators**. `kanban-operations` is `no-model` precisely so an agent
cannot talk itself into a card move, which `CLAUDE.md` forbids outright
("Execution agents must NEVER attempt to update kanban columns directly") and
which the skill's own banner repeats ("MANUAL FALLBACK ONLY … ONLY when the user
has explicitly requested a card move"). It also carries a **direct-DB fallback**
when the API server is down, so a bypass writes `kanban.db` without tracker sync.
Adding frontmatter to that source would advertise it to Antigravity's model as a
door — re-opening, on the other host, the exact hole the `no-model` flag exists
to close.

### Root Cause

Absence is not something a diff draws attention to. There is no signal at the
moment an author sets a gated `invocation` that the sibling file also needs
changing, and no gate that notices afterwards. `mirror:check` already runs in CI
and already owns the mirror's integrity — it checks byte-for-byte drift and the
packaging origin — but it does not check this, so the one place positioned to
catch it stays silent.

## Metadata

**Complexity:** 2
**Tags:** devops, reliability, refactor

## Complexity Audit

### Routine

- One loop over `MIRROR_MANIFEST` inside the existing `main()`, using the same
  `console.error('❌ mirror:check — …')` + non-zero exit shape as the packaging
  and drift assertions already there.

### Complex / Risky

- **`MIRROR_MANIFEST` is not exported.** It is `const MIRROR_MANIFEST: MirrorEntry[] = [`
  at `ClaudeCodeMirrorService.ts:47` with no `export`, and the compiled module
  exposes only `CLAUDE_PROTOCOL_HEADER`, `CLAUDE_BLOCK_START`, `CLAUDE_BLOCK_END`,
  `RESIDENT_PROTOCOL_BODY`, `DOCS_POINTER_RULE`, `buildManagedInner` and
  `generateClaudeMirror`. **Export it** rather than regexing the TypeScript source
  from the script — a source-parsing check drifts the first time the literal is
  reformatted, which is the failure mode this plan exists to prevent, one level up.
  Exporting a `const` changes no behaviour.
- **Only `<dir>/SKILL.md` sources are in scope.** A manifest `source` can be a
  workflow file (`workflows/switchboard.md`) rather than a skill directory. Those
  are `'default'` today and are surfaced in Antigravity only when *typed*, so they
  are outside the invariant — skip any source that is not a directory, and skip it
  explicitly rather than by falling through a path that happens not to exist.
- **The check must fail on the source tree, not the mirror.** The generated
  `.claude/` copy always has frontmatter — the generator synthesises it, including
  `disable-model-invocation: true`. Asserting against the mirror would fail
  everything; the assertion is about `.agents/`.

## Edge-Case & Dependency Audit

**Migration.** None. No persisted state, no on-disk format, no user-visible
surface. The repo satisfies the invariant today (all four skill dirs ship no
frontmatter), so the assertion is green on arrival.

**Security.** Positive, and it is the point: the invariant protects the gate on
the two mutating skills.

**Side effects.** `mirror:check` gains a failure mode. It is already wired
(`package.json:926` → `.github/workflows/integration-tests.yml:53`), so no gate
wiring is needed — which is most of why this is worth doing at all.

**Ordering.** Independent, shippable now.

## Dependencies

- **Carved out of** `frontmatter-host-drift-no-user-skills-exposed-on-antigravity.md`,
  now marked OBSOLETE — its two instances are gone, this is the part that stops
  recurrence.
- **Follows** `move-protocols-out-of-skill-discovery.md`, which shrank the manifest
  from 47 entries to 8 and is what makes this check cheap.

## Adversarial Synthesis

**"Four skills and eight entries — a check for a set this small is ceremony."**
The set being small is what makes the check cheap, not what makes it unnecessary.
The invariant's whole job is to hold while nobody is looking at it, and the class
has already fired twice on a *larger* set where it was likelier to be noticed.

**"Just document the convention."** It is documented, in the manifest comment at
`:40-46` and in `CLAUDE.md`. Both instances were authored anyway. A convention
that has already been missed twice by authors who had access to it needs a gate,
not another sentence.

**"Assert it in a contract test instead."** `mirror:check` is where the mirror's
other integrity assertions live, it is already CI-invoked, and it already loads
the compiled module. A new test file would need its own npm script and its own CI
step — and an unwired test file is this repo's documented "green while incomplete"
hole.

## Proposed Changes

1. **Export `MIRROR_MANIFEST`** from `src/services/ClaudeCodeMirrorService.ts`.
2. **Assert the invariant in `scripts/check-claude-mirror.js`:** for each entry
   whose `invocation` is `'no-user'` or `'no-model'`, and whose `source` resolves
   to a directory under `.agents/`, read `<source>/SKILL.md` and fail if its first
   line is `---`.
3. **Name both files in the failure message**, plus which host over-exposes and
   what to do: strip the frontmatter block from the source, or change the entry's
   `invocation` if the skill really is meant to be a door.
4. **Skip non-directory sources explicitly**, with a comment saying why workflows
   are out of scope.

### Migration

None.

## Verification Plan

### Goal Invariants

- No `no-user` or `no-model` manifest entry has a frontmatter block in its source
  skill directory.
- `mirror:check` fails, loudly and by name, when one does.
- The four `default` workflow entries are unaffected.

### Automated Tests

- **Green on the current tree:** run `npm run mirror:check` unchanged and assert it
  passes. The invariant holds today, so a red run means the assertion is wrong, not
  the repo.
- **Red on a seeded violation:** add a frontmatter block to
  `.agents/skills/kanban_operations/SKILL.md` in a scratch copy of the tree, run
  the check, assert non-zero exit and that the message names both
  `kanban-operations` and the source path. This is the assertion that would have
  caught both historical instances, and it is the one that fails if the check is
  written against the generated mirror instead of the source.
- **Workflow entries are exempt:** assert the four `workflows/switchboard*.md`
  entries do not trip the check. They carry frontmatter and are `default`; a
  careless implementation that skips the directory test flags all four.
- **The manifest is read, not parsed from text:** assert
  `require('out/services/ClaudeCodeMirrorService.js').MIRROR_MANIFEST` is an array
  and that the script does not read `ClaudeCodeMirrorService.ts` as a string. A
  source-regex implementation passes every behavioural test above and rots on the
  next reformat.

### Manual Verification

- Read the failure message from the seeded-violation run and check it reads as an
  instruction, not a diagnostic: it should name the entry, the source file, which
  host is over-exposing it, and the two valid fixes (strip the block, or change
  `invocation`). A future author hits this message once and should not need to open
  this plan to act on it.

## Outstanding Questions

None.
