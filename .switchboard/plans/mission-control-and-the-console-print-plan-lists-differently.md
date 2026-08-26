# Mission Control prints plan lists as space-aligned columns that markdown collapses into an unformatted run-on

## Goal

Give plan lists one output template that survives markdown rendering and addresses cards by a
number the user can reply with. Mission Control currently prescribes a whitespace-aligned table of
raw plan IDs, which the renderer flattens into a run-on line — and which the other front-door
document explicitly forbids.

### Problem Analysis

**The prescribed format depends on whitespace alignment that markdown discards.**
`.agents/protocols/switchboard-mission-control/SKILL.md:114` — *The shape of the answer* — specifies:

> Lead with the two counts, then one line per card: type, title, planId.

with this example:

```
Ready to go — 43 to code, 13 to plan.

To code (PLAN REVIEWED):
  feature  Teams You Can See, Start and Trust                 7c52086e
  plan     Clear the CLI input line before every slash command a1b2c3d4
To plan (CREATED):
  plan     A Phone-a-Friend Seat Has No Brand Identity         5eac4e60
```

Three columns held apart by runs of spaces, and rows separated by single newlines. In the document
that block sits inside a code fence, so it renders exactly as written and looks correct to whoever
wrote it. **The instruction never says to emit it inside a fence.** An agent following the spec
writes those lines as chat prose, where standard markdown collapses every run of spaces to one and
every single newline to a space. The result is one long line of titles and hex fragments — the
reported "unformatted list", produced by following the specification.

**The other front door knows this and the protocol does not.** The console persona carries the rule
explicitly (`.claude/skills/switchboard/SKILL.md:130-133`):

> **Markdown line breaks:** standard Markdown collapses single newlines into spaces. End every line
> that must break within a block with **two trailing spaces**…

It applies that only to the board snapshot. The Mission Control protocol never mentions it at all,
and the protocol's format is *more* whitespace-dependent than the snapshot it was written for.

**The upstream helper emits tab-separated output, which collapses the same way.** The `ready ()`
function at `:104-112` ends with:

```
.[] | "\(if .isFeature == 1 then "feature" else "plan  " end)\t\(.topic)\t\(.planId)"
```

Tabs and a padded `"plan  "` literal — column alignment done in `jq`, discarded by the renderer. The
agent is handed pre-aligned text and told to present it, so the collapse is inherited rather than
introduced.

**The two documents also disagree on whether plan IDs may be shown at all.** The protocol makes the
planId a required column. The console persona forbids it twice:

- Hard Rule 8 (`.claude/skills/switchboard/SKILL.md:578`): "**Never display raw UUIDs or raw plan
  filenames** anywhere in conversation. Reference plans by a stable list number + their human
  title; resolve the number back to the planId/path internally when an action needs one."
- The list template (`:203-214`): "**numbered titles only** — no UUIDs, no plan filenames, no raw
  field dumps. Keep an internal number→planId/path map per list you print."

**The disagreement is not cosmetic — it decides how the user addresses a card.** With numbers, the
user replies "2". With IDs, the user is expected to read back `a1b2c3d4`. The protocol's format
offers no number at all, so after a collapsed run-on line there is no usable way to refer to a
card. Formatting and addressability fail together.

**Neither format separates its lanes.** In the example, `To plan (CREATED):` follows the last
coding row with no blank line — so even in a fence the two lanes read as one block.

### Root Cause

The two documents were written by different passes with different rendering assumptions, and the
one that specified the richer layout had the weaker model of the surface it renders on. The
protocol's format was designed as fixed-width terminal output; the console's was designed for a
markdown chat. Both are reasonable for their assumed target, neither states its target, and only
one is right about where the text actually lands.

### Non-goals

- **Not changing what is listed.** The lane definitions, subtask exclusion, project filter, and
  25-row cap are correct and stay exactly as they are.
- **Not removing plan IDs from the pipeline.** The agent still needs them to act; the question is
  only whether they are *printed*.
- **Not restyling every message.** Plan lists specifically — not reports, digests, or logs.
- **Not resolving which persona owns `/switchboard`.** That is
  `the-skill-sync-overwrote-the-mission-control-launcher.md`.

## Metadata

**Complexity:** 3
**Tags:** bugfix, ux, docs

## User Review Required

Yes — one decision.

**Numbered titles, or titles plus a short ID?** Recommendation: **numbered titles, IDs held
internally** — adopt the console's rule as the single template, for both personas:

- It is render-safe: a markdown ordered list needs no alignment and no trailing-space trick.
- It gives the user a reply token that is one character long.
- The agent keeps the number→planId map internally, which it needs anyway to act.
- It matches the rule already written down as a hard rule, so one document changes instead of two.

Keep the protocol's genuine improvements: the lead-with-counts line, the `feature`/`plan` type
marker (as a word before the title, not an aligned column), and the `+N more` remainder rule.

The alternative — keep an 8-char ID suffix per row — is only worth it if the operator actually
copies IDs into other tools. If they do, a fenced block is mandatory, not optional, and the
instruction must say so.

## Complexity Audit

### Routine

- Rewriting one template block in the protocol.
- Reordering the `jq` output so the agent is not handed pre-aligned text.

### Complex / Risky

- **The renderer, not the author, decides.** Whatever template is chosen must be specified along
  with *how it is emitted* — plain markdown list, or explicitly inside a fence. The current bug is
  precisely a correct-looking example with no emission rule. **A template without an emission rule
  regenerates this defect.**
- **The type marker must not become an alignment column again.** `feature`/`plan` is useful
  information; padding it to a fixed width is what breaks. Write it as a prefix word.
- **The number→ID map is load-bearing and easy to lose.** If numbers replace IDs, the agent must
  hold the mapping for the life of the turn, and a later action must resolve through it. A number
  the agent cannot resolve is worse than an ID the user cannot read.
- **Numbering across two lanes needs a decision.** Two lanes are printed together; per-lane
  numbering means two cards share number 1. Either number continuously across both lanes, or
  qualify the reply ("code 2"). Continuous numbering is simpler and should be stated.
- **The 25-cap remainder must survive.** "Never truncate without printing the remainder" is an
  existing guarantee; a template rewrite must carry `+N more` forward.
- **Both mirrors move together** if the console template is touched —
  `.claude/skills/switchboard/SKILL.md` and `.agents/workflows/switchboard.md`.

## Edge-Case & Dependency Audit

**Race conditions**
- A card moves between the list and the follow-up action, so the number resolves to a card no longer
  in that column. The action path already verifies before mutating; the list is a snapshot and the
  resolve must re-check rather than trust the number's provenance.

**Security**
- None. Output formatting only.

**Side effects**
- Anything that parses Mission Control's list output (a script, a log scraper, a test) breaks on a
  template change. Grep for consumers before landing.
- Plan titles containing markdown — backticks, underscores, brackets, a leading `#` — render
  unexpectedly inside a list item where a fence would have protected them. Titles in this codebase
  are prose-like and long ("A Phone-a-Friend Seat Has No Brand Identity"), so this is likely, not
  theoretical.
- Very long titles wrap in a list item where a fixed-width column truncated. Wrapping is the better
  failure, but the template should not also number the wrapped continuation.

**Migration**
- Documentation and one `jq` expression. No schema, settings, stored state, or endpoint changes.

## Dependencies

- **Related:** `the-skill-sync-overwrote-the-mission-control-launcher.md` (decides whether the
  console template needs to survive at all) and
  `the-pre-flight-names-six-checks-and-supplies-one-command.md` (the pre-flight report ends with
  this very summary, so its output contract and this template must agree). Neither blocks this one.

## Adversarial Synthesis

Key risks: (1) rewriting the template and again omitting the emission rule, so the next agent
renders a correct-looking spec into a collapsed line — the identical defect, one pass later;
(2) keeping the aligned columns and merely wrapping them in a fence, which fixes rendering but
leaves the user with hex IDs and no reply token, so addressability stays broken; (3) numbering
per-lane and producing two cards numbered 1 in one message; (4) dropping the `+N more` remainder or
the type marker while simplifying; (5) unescaped markdown in plan titles corrupting the list in a
way the old fixed-width block hid. Mitigations: state the emission rule in the same sentence as the
template and verify by rendering, not by reading; number continuously across lanes and say so; carry
the cap, remainder and type marker forward explicitly; and include a markdown-bearing title in the
verification set.

## Proposed Changes

1. **Replace *The shape of the answer* with one render-safe template**: the counts line, a blank
   line, then per lane a heading and a markdown ordered list of `<type> — <title>`, continuously
   numbered across both lanes. No alignment, no printed IDs.
2. **State the emission rule beside the template** — plain markdown list, no fence, no padding — so
   a correct-looking example cannot be rendered wrong.
3. **Require the internal number→planId map** in the same place, matching Hard Rule 8's wording, and
   require the follow-up action to resolve through it and re-verify.
4. **Reorder the `ready ()` `jq` output** (`:104-112`) so it stops emitting tab-aligned, padded text
   — return the fields the agent needs, not a pre-formatted row.
5. **Blank line between lanes**, in the template and the example.
6. **Carry forward** the 25-row cap, the `+N more` remainder rule, and the `feature`/`plan` type
   marker as a prefix word.
7. **Reconcile with the console template** (`.claude/skills/switchboard/SKILL.md:203-214`) so one
   wording covers both, and mirror any edit into `.agents/workflows/switchboard.md`.
8. **Note the markdown-collapse rule once** in the protocol, as the console does at `:130-133`.

### Migration

Documentation plus one `jq` expression. No schema, settings, stored state, or endpoint changes.

## Verification Plan

1. **Renders, not reads.** Emit a two-lane list through the actual chat renderer and assert one line
   per card — the current format collapses here, so this test must fail before the fix.
2. **No raw IDs.** Assert no planId, UUID, or plan filename appears in a printed list.
3. **Numbers resolve.** Print a list, reply with a number, and assert the agent acts on the matching
   card — including a number from the second lane, proving continuous numbering.
4. **No duplicate numbers.** With cards in both lanes, assert every number in the message is unique.
5. **Lanes are separated.** Assert a blank line between the coding and planning lanes.
6. **Cap and remainder.** With more than 25 cards in a lane, assert 25 rows, newest first, and a
   `+N more` line with the correct N.
7. **Markdown-bearing titles.** Include titles with backticks, underscores, brackets and a leading
   `#`; assert each renders as its literal text and the list structure is intact.
8. **Long titles wrap cleanly.** Assert a title longer than the terminal width wraps without
   producing a second number or breaking the list.
9. **Stale number.** Move a card after printing, then reply with its number; assert the agent
   re-verifies and reports the change rather than acting on the stale row.
10. **Both mirrors agree.** If the console template changed, `diff` the two front-door files — only
    frontmatter differs.
11. **Pre-flight agrees.** Assert the `Pre-flight clear.` report's trailing summary uses this same
    template.
