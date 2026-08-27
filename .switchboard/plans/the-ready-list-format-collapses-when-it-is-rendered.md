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
`ready ()` function at `:101-109` ends with:

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
  Number continuously across both lanes and say so. In CommonMark, two separate ordered lists each
  start at 1 unless the second list's first item explicitly carries the continuation number (e.g.
  `6.`) — so the second lane's list must begin at N+1 where N is the first lane's last item number.
- **The number→planId map is load-bearing.** A number the agent cannot resolve is worse than an id
  the operator cannot read. The follow-up action must resolve through the map and re-verify, since
  a card can move between the list and the reply.
- **Empty lanes.** A lane with zero cards must produce no heading and no list — omit it entirely
  rather than printing an empty heading or a bare "None".

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
- Anything parsing this output (a script, a test) breaks on the change. **Verified by grep:
  no test, script, or other file parses this template format.** The only consumers are the
  mission-control skill file itself and this plan.

**Migration**
- One protocol section and one `jq` expression. No schema, settings, stored state, or endpoints.

## Dependencies

- **Consumed by the pre-flight.** The pre-flight report ends with this summary (line 169: "The
  report ends with the ready-card summary in the format below"), so its output contract and this
  template must agree.
- Independent of everything else.

## Adversarial Synthesis

Key risks: (1) rewriting the template and again omitting the emission rule, so the next agent
renders a correct-looking spec into a collapsed line — the identical defect one pass later; (2)
keeping the aligned columns and merely wrapping them in a fence, which fixes rendering but leaves
the operator with hex ids and no reply token, so addressability stays broken; (3) numbering
per-lane and emitting two cards numbered 1 — the CommonMark start-number mechanism must be
specified explicitly; (4) dropping the `+N more` remainder or the type marker while simplifying;
(5) unescaped markdown in titles corrupting the list in a way the old block concealed; (6) leaving
the jq replacement as prose, so the implementer invents a field format. Mitigations: state the
emission rule in the same sentence as the template and verify by rendering rather than by reading;
number continuously with the second lane starting at N+1; carry the cap, remainder and marker
forward explicitly; include a markdown-bearing title in the verification set; and specify the
concrete jq expression rather than describing it.

## Proposed Changes

All edits are in a single file: `.agents/protocols/switchboard-mission-control/SKILL.md`.

### 1. Replace the template at `:114-132` (the "shape of the answer" section)

Replace the current space-aligned example and its surrounding instruction with:

- A counts line (unchanged).
- A blank line.
- Per lane: a heading (`To code (PLAN REVIEWED):` / `To plan (CREATED):`), then a markdown ordered
  list of `<type> — <title>`, numbered continuously across both lanes, no printed ids.
- A blank line between lanes.
- **Empty lane handling:** a lane with zero cards is omitted entirely — no heading, no list.
- **Continuous numbering:** the second lane's list starts at N+1 where N is the last number used in
  the first lane. In CommonMark the first item's number determines the list's start, so write the
  actual number (e.g. `6.`), not `1.`.

Concrete replacement example (to be placed inside the "shape of the answer" section, replacing the
current fenced block):

```markdown
Ready to go — 43 to code, 13 to plan.

To code (PLAN REVIEWED):
1. feature — Teams You Can See, Start and Trust
2. plan — Clear the CLI input line before every slash command
3. plan — A Phone-a-Friend Seat Has No Brand Identity
```

Note: the example above shows only the coding lane for brevity. When both lanes have cards, the
planning lane follows after a blank line, continuing the numbering:

```markdown
To plan (CREATED):
4. plan — Another Plan Title Here
5. feature — Another Feature Title Here
```

### 2. State the emission rule beside the template

Plain markdown list, no fence, no padding. The instruction must say: "Emit this as ordinary
markdown text — an ordered list, not a fenced code block. Markdown collapses runs of spaces and
single newlines, so the template must use structural markdown (lists, headings) rather than
whitespace alignment."

### 3. Require the internal number→planId map

In the same section, state: "The agent maintains an internal number→planId map for the duration of
the reply exchange. The follow-up action resolves the reply number through this map and re-verifies
the card is still in the expected column before acting."

### 4. Reorder the `ready ()` jq output (`:101-109`, expression at `:108`)

> **Superseded:** Reorder the `ready ()` jq output (`:104-112`) to return fields rather than a
> pre-formatted, tab-padded row.
> **Reason:** The line range was imprecise (function spans lines 101-109, expression at 108), and
> "return fields" was underspecified — an implementer could produce JSON, CSV, or any delimiter.
> **Replaced with:** The concrete change below.

Remove the padded `"plan  "` literal from the jq expression. The tabs remain as field separators
for the agent to parse; the agent formats them into the markdown list per the template above. The
change is one word — `"plan  "` → `"plan"`:

```bash
# Before (line 108):
.[] | "\(if .isFeature == 1 then "feature" else "plan  " end)\t\(.topic)\t\(.planId)"

# After:
.[] | "\(if .isFeature == 1 then "feature" else "plan" end)\t\(.topic)\t\(.planId)"
```

The agent reads the three tab-separated fields (type, topic, planId), assigns sequential numbers,
builds the markdown list, and holds the number→planId map internally. The jq output is intermediate
data, not the final presentation.

### 5. Blank line between lanes

In both the template instruction and the example, ensure a blank line separates the coding lane's
last item from the planning lane's heading.

### 6. Carry forward the 25-row cap, `+N more`, and the type marker

- 25-row cap per lane (API already orders newest first).
- `+N more` remainder line at the end of a truncated lane.
- Type marker as a prefix word (`feature` / `plan`), never a padded column.

### 7. Note the markdown-collapse rule once in the protocol

Add one sentence immediately after the template example (before the "If a lane holds more than 25
cards" paragraph at `:130`):

> "Markdown collapses runs of spaces to one and single newlines to spaces in normal text. This
> template uses structural markdown (ordered lists, headings) rather than whitespace alignment, so
> it survives rendering. Do not emit it inside a code fence — the operator must be able to reply
> with a number, and a fence makes the list copy-paste-only."

### Migration

Documentation plus one `jq` expression (one word change: `"plan  "` → `"plan"`). No schema,
settings, stored state, or endpoint changes.

## Verification Plan

### Automated Tests

> **Note:** Compilation and automated tests are skipped for this run per dispatch directives. The
> checks below remain written down for execution when the plan is dispatched to a coder.

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
11. **Empty lane.** With zero cards in one lane, assert that lane's heading and list are absent — no
    empty heading, no "None" placeholder.
12. **Continuous numbering across lanes.** With 3 cards in lane 1 and 2 in lane 2, assert the second
    lane's first item is numbered `4.`, not `1.`.

### Goal Invariants

- Assert `.agents/protocols/switchboard-mission-control/SKILL.md` line 108 does not contain the
  string `"plan  "` (double-space padded literal).
- Assert the template example in the "shape of the answer" section (`:114-132`) contains a markdown
  ordered list (lines starting with `1.`, `2.`, etc.), not space-aligned columns.
- Assert no `planId` or hex id fragment appears in the template example output.
- Assert a blank line exists between the `To code` and `To plan` lane headings in the example.
- Assert the emission rule text contains the word "markdown" and does not contain the word "fence"
  as a prescribed emission method (fencing is explicitly discouraged for the list output).

## Recommendation

Complexity 2 — **Send to Intern**.
