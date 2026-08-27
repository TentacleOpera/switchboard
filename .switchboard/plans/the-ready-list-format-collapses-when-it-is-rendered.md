# The ready-list format is space-aligned columns rendered as chat prose, so markdown collapses it into one line

## Goal

Give the ready-card summary an output template that survives markdown rendering and gives the
operator a token they can reply with. The current template depends on whitespace alignment the
renderer discards, and addresses cards by raw plan id.

### Problem Analysis

**The prescribed shape depends on alignment markdown does not preserve.**
`.agents/protocols/switchboard-mission-control/SKILL.md:114` — *The shape of the answer* — says
"one line per card: type, title, planId", with this example:

```
Ready to go — 43 to code, 13 to plan.

To code (PLAN REVIEWED):
  feature  Teams You Can See, Start and Trust                 7c52086e
  plan     Clear the CLI input line before every slash command a1b2c3d4
To plan (CREATED):
  plan     A Phone-a-Friend Seat Has No Brand Identity         5eac4e60
```

Three columns held apart by runs of spaces; rows separated by single newlines. **In the document
that block sits inside a code fence**, so it renders exactly as written and looks correct to anyone
reading the spec. The instruction never says to emit it inside a fence. An agent following the spec
writes those lines as ordinary chat text, where markdown collapses every run of spaces to one and
every single newline to a space — producing one long line of titles and hex fragments.

**The upstream helper hands the agent pre-aligned text, so the collapse is inherited.** The
`ready ()` function at `:104-112` ends with:

```
.[] | "\(if .isFeature == 1 then "feature" else "plan  " end)\t\(.topic)\t\(.planId)"
```

Tabs, plus a padded `"plan  "` literal — column alignment performed in `jq` and discarded by the
renderer. The agent is given something that looks formatted and told to present it.

**There is no reply token.** The template's only per-card identifier is the plan id. After the
collapse there is nothing to point at, and even intact, "reply with `a1b2c3d4`" is a poor
affordance next to "reply with 2". A number also has to be tracked internally anyway for the
follow-up action to resolve.

**The lanes are not separated.** In the example, `To plan (CREATED):` follows the last coding row
with no blank line, so even inside a fence the two lanes read as one block.

### Root Cause

The template was designed as fixed-width terminal output and is consumed by a markdown chat
renderer. Neither the template nor its example states the target surface, and the example's own
fencing in the source document hides the defect from anyone reviewing the spec — it is only visible
at the moment an agent emits it.

### Non-goals

- **Not changing what is listed.** Lane definitions, subtask exclusion, the project filter and the
  25-row cap are correct and unchanged.
- **Not removing plan ids from the pipeline.** The agent still resolves them to act; the question is
  only whether they are printed.
- **Not restyling other output.** The ready summary specifically — not digests, reports, or logs.

## Metadata

**Complexity:** 2
**Tags:** bugfix, ux, docs

## User Review Required

Yes — one decision.

**Numbered titles, or titles plus a short id?** Recommendation: **numbered titles, ids held
internally.** A markdown ordered list needs no alignment and no trailing-space trick, so it cannot
collapse; the number is a one-character reply token; and the agent already needs the number→planId
map to act on the answer.

Keep what the current template gets right: the counts line, the `feature`/`plan` type marker (as a
prefix word, never a padded column), and the `+N more` remainder rule.

The alternative — keep an 8-char id per row — is only worth it if the operator copies ids into other
tools. If they do, a fenced block becomes mandatory rather than optional, and the instruction must
say so explicitly.

## Complexity Audit

### Routine

- Rewriting one template block and its example.
- Reordering the `jq` output so it stops emitting pre-aligned text.

### Complex / Risky

- **A template without an emission rule regenerates this bug.** Whatever shape is chosen must be
  specified together with *how it is emitted* — plain markdown list, or explicitly inside a fence.
  The current defect is precisely a correct-looking example with no emission rule.
- **The type marker must not become an alignment column again.** `feature`/`plan` is useful; padding
  it to a fixed width is what breaks. Prefix word, not column.
- **Numbering spans two lanes.** Per-lane numbering gives two cards numbered 1 in one message.
  Number continuously across both lanes and say so.
- **The number→planId map is load-bearing.** A number the agent cannot resolve is worse than an id
  the operator cannot read. The follow-up action must resolve through the map and re-verify, since
  a card can move between the list and the reply.

## Edge-Case & Dependency Audit

**Race conditions**
- A card moves between listing and the follow-up action, so a number resolves to a card no longer in
  that column. The action path verifies before mutating; the resolve must re-check rather than trust
  the number's provenance.

**Security**
- None. Output formatting only.

**Side effects**
- Plan titles containing markdown — backticks, underscores, brackets, a leading `#` — render
  unexpectedly inside a list item where a fixed-width block hid them. Titles in this codebase are
  long and prose-like, so this is likely rather than theoretical.
- Long titles wrap in a list item where a column truncated. Wrapping is the better failure, but the
  wrapped continuation must not acquire its own number.
- Anything parsing this output (a script, a test) breaks on the change. Worth a grep first.

**Migration**
- One protocol section and one `jq` expression. No schema, settings, stored state, or endpoints.

## Dependencies

- **Consumed by the pre-flight.** The pre-flight report ends with this summary, so its output
  contract and this template must agree.
- Independent of everything else.

## Adversarial Synthesis

Key risks: (1) rewriting the template and again omitting the emission rule, so the next agent renders
a correct-looking spec into a collapsed line — the identical defect one pass later; (2) keeping the
aligned columns and merely wrapping them in a fence, which fixes rendering but leaves the operator
with hex ids and no reply token, so addressability stays broken; (3) numbering per-lane and emitting
two cards numbered 1; (4) dropping the `+N more` remainder or the type marker while simplifying;
(5) unescaped markdown in titles corrupting the list in a way the old block concealed. Mitigations:
state the emission rule in the same sentence as the template and verify by rendering rather than by
reading; number continuously and say so; carry the cap, remainder and marker forward explicitly; and
include a markdown-bearing title in the verification set.

## Proposed Changes

1. **Replace the template at `:114`**: counts line, blank line, then per lane a heading and a
   markdown ordered list of `<type> — <title>`, numbered continuously across both lanes, no printed
   ids.
2. **State the emission rule beside it** — plain markdown list, no fence, no padding.
3. **Require the internal number→planId map** in the same place, and require the follow-up action to
   resolve through it and re-verify.
4. **Reorder the `ready ()` jq output** (`:104-112`) to return fields rather than a pre-formatted,
   tab-padded row.
5. **Blank line between lanes**, in template and example.
6. **Carry forward** the 25-row cap, `+N more`, and the type marker as a prefix word.
7. **Note the markdown-collapse rule once** in the protocol, so the next template author has it.

### Migration

Documentation plus one `jq` expression. No schema, settings, stored state, or endpoint changes.

## Verification Plan

1. **Renders, not reads.** Emit a two-lane list through the actual chat renderer; assert one line per
   card. The current format collapses here, so this must fail before the fix.
2. **No raw ids.** Assert no planId, UUID or plan filename appears in a printed list.
3. **Numbers resolve.** Print a list, reply with a number, assert the agent acts on the matching card
   — including a number from the second lane, proving continuous numbering.
4. **No duplicate numbers.** With cards in both lanes, assert every number in the message is unique.
5. **Lanes separated.** Assert a blank line between the coding and planning lanes.
6. **Cap and remainder.** With >25 cards in a lane, assert 25 rows newest-first and a correct
   `+N more`.
7. **Markdown-bearing titles.** Titles with backticks, underscores, brackets and a leading `#` render
   as literal text with the list structure intact.
8. **Long titles wrap cleanly**, without a second number.
9. **Stale number.** Move a card after printing, reply with its number; assert the agent re-verifies
   and reports the change rather than acting on the stale row.
10. **Pre-flight agrees.** Assert the `Pre-flight clear.` report's trailing summary uses this template.
