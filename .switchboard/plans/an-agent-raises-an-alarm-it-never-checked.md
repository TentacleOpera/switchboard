# An Agent Warns the Operator That the System Is About to Work

## Goal

An agent must not present configured, intended behaviour as a hazard. Syncing a feature to a tracker
the operator connected, moving a card the operator asked to move, writing a file the operator asked
for — these are the product doing its job, not risks to seek permission for. Warning about them
stalls authorised work and teaches the operator that this system's alarms are noise.

### Problem analysis

**Observed on this board, 2026-09-15.** The operator asked an agent to group ungrouped cards into
features. The agent read this at the top of `.agents/skills/kanban_operations/create-feature.js`:

> *"NOTE on sync: feature creation DOES fan out to Linear/ClickUp. `createFeatureFromPlanIds` ends
> in `_syncFeatureOutbound`, which pushes the feature as a parent issue/task and links each subtask
> as a child…"*

The agent surfaced this to the operator as a risk and made it a **blocking question**, stopping work
that had already been asked for.

**The question was not merely unverified — it was incoherent.** The operator's response was exact:
*"an agent never needs to fucking warn about linear."* If a tracker is connected, features appearing
in that tracker is the entire reason it is connected. There is no state of the world in which
"your feature will show up in your issue tracker" is news, let alone a hazard. The agent was asking
permission for the software to do what the operator configured it to do.

An earlier draft of this plan proposed that the agent should have checked whether the sync flags were
on before warning. That was wrong, and wrong in a revealing way: it accepted that the warning could
be legitimate under some configuration. It cannot. With both flags on, the correct behaviour is
still to create the feature and say nothing.

**The docblock manufactured the alarm, and that class of text should not exist.** Seven lines of
agent-facing narration about `_syncFeatureOutbound`, its gating flags, and its per-subtask linking
sat at the top of a 191-line script — 38 of whose lines were comments. That is not code
documentation; it is instruction content, and instruction content belongs in the control plane where
it can be reviewed, versioned and delivered, not scattered through source files where it is read out
of context by whichever agent opens the file. The operator's second objection was exactly this:
*"I'm pissed off that instructions are apparently in random js files."*

Measured across `.agents/skills/`: `create-feature.js` 38 comment lines of 191,
`reconcile-features.js` 31 of 90, `_lib/cli-call.js` 27 of 188, `assign-to-feature.js` 14 of 96.
The pattern is systemic, not one file.

**Why this costs more than one interruption.** A warning's worth is its base rate of being real.
Once alarms prove to be recitals of normal behaviour, the rational operator stops reading them —
which is precisely when the system loses the ability to warn about anything that matters.

### Root cause

Two mistakes compound. First, a script's docblock was used as a channel for agent behavioural
guidance, so the guidance escapes control-plane review and is read by agents as authoritative
context. Second, that guidance described **intended, configured behaviour in the vocabulary of
risk** — `DOES fan out`, capitalised — so an agent pattern-matching for hazards found one where none
exists. Nothing in the instruction set tells an agent that the system performing its configured
function is not an event worth reporting.

## Metadata

**Tags:** reliability, docs, ux
**Complexity:** 4
**Repo:** switchboard

## User Review Required

No. The operator stated the rule directly: an agent never needs to warn about Linear.

## Settled Design

- **Configured behaviour is never a hazard.** If the operator connected a tracker, enabled a sync,
  or asked for an action, the system doing that thing is the expected outcome. It is not reported,
  not flagged, and never gated behind a question.
- **The bar for stopping authorised work is that proceeding would be unsafe under every
  assumption.** Not "has a side effect" — every useful action has side effects. Not "touches an
  external system" — that is what integrations are. Unsafe, genuinely, either way.
- **Agent-facing instruction text does not live in source files.** A script's comments describe what
  the code does for someone editing it. Guidance about how an agent should behave belongs in the
  control plane. Where behaviour genuinely must be constrained, constrain it in code — a guard, not
  a paragraph.
- **Delete rather than relocate.** The `create-feature.js` sync narration does not need a new home;
  it needs to not exist. Outbound sync is correct behaviour requiring no agent awareness. (Applied
  2026-09-15: the docblock was cut from 23 lines to 9 — invocation and fallback only.)
- **Not a licence to suppress real warnings.** Data loss, an unrecoverable delete, an action
  contradicting what was asked — those are raised immediately and plainly. The target is narrating
  *correct* behaviour as risk.

## Complexity Audit

### Routine
- Deleting instruction prose from the skill scripts.

### Complex / Risky
- **Telling warnings from narration requires judgment**, and a sweep that over-deletes removes a
  genuine hazard note. Each comment must be classified, not pattern-matched: does it describe a way
  the code can *fail or destroy*, or a way it *works*?
- **The behavioural rule is delivered on every dispatch**, so it must be a few lines or it taxes
  every prompt in the system.
- **Over-correction is the dangerous direction.** An agent reading this as "never warn" produces
  silent failures, which are far harder to detect than noise. The operative clause must be *do not
  narrate correct behaviour as risk*, never *warn less*.

## Edge-Case & Dependency Audit

- **Race conditions / security.** None; prompt and comment content.
- **Side effects.** Fewer stalled tasks; fewer confirmation round-trips on routine work.
- **Dependencies & conflicts.**
  - `protocols-as-db-rows-not-scaffolded-files.md` — the same principle for protocols. This plan
    extends it from protocol files to skill-script comments; the two should not implement separate
    mechanisms.
  - `standing-order-fragments-belong-in-the-store-like-every-other-control-plane-document.md` —
    same principle for standing-order fragments.
  - `an-operator-prompt-replaces-the-protocol-instead-of-adding-to-it.md` — the additive core this
    rule is delivered through.
  - `.agents/protocols/improve-plan/SKILL.md`'s four-part `[user]`-question gate (added
    2026-09-15) is the plan-authoring instance of the same principle.
  - **Not a conflict:** CLAUDE.md's confirmation duty for hard-to-reverse actions. That governs
    destructive actions an agent takes; this governs correct behaviour an agent describes.

## Adversarial Synthesis

**Risk summary.** Two changes with opposite failure modes. The comment sweep risks deleting a real
hazard note along with the narration, which is silent — so classification must be per-comment and
reviewed, never a regex. The prompt rule risks over-correction into suppressed warnings, also
silent. Both failure modes are invisible, unlike the noise being removed, so the verification has to
carry the weight the observable symptoms will not.

## Proposed Changes

### Change A — the rule, in the standing-order system core

- **Context:** the additive core composed at delivery and never persisted (see
  `an-operator-prompt-replaces-the-protocol-instead-of-adding-to-it.md`). Locate the composition
  site; it is assembled in code, not stored as a row.
- **Logic:** add a short block, in substance:

  > **The system doing its job is not an event.** If the operator configured an integration, enabled
  > a setting, or asked for an action, do not warn them that it will happen — it happening is the
  > point. Never stop authorised work to ask permission for a documented, intended effect. Raise a
  > problem when something will be lost, destroyed, or done contrary to what was asked; then say it
  > immediately and plainly.

- **Edge case:** keep it under ~70 words; it is paid on every dispatch.

### Change B — classify and cut the instruction prose in `.agents/skills/`

- **Context:** `create-feature.js` (done), `reconcile-features.js` (31/90),
  `_lib/cli-call.js` (27/188), `assign-to-feature.js` (14/96), and the rest of `kanban_operations/`.
- **Logic:** classify every comment block as (a) how to invoke or edit this code — keep;
  (b) how an agent should behave — delete, or move to the control plane if the guidance is real;
  (c) narration of correct behaviour dressed as risk — delete.
- **Edge case:** a comment describing a genuine failure mode (`_lib/workspace-root.js`'s resolution
  rules, for instance) is category (a) and stays. When in doubt, keep — an over-cut is silent.

### Change C — a guard, where behaviour genuinely must be constrained

- **Logic:** if any script's comment exists because an agent must *not* do something, that is a
  missing guard, not a missing paragraph. Identify any such case found during Change B and file it
  separately rather than restoring the comment.
- **Edge case:** this change may produce nothing. That is a valid outcome, not a gap.

## Verification Plan

### Automated Tests
1. **The rule reaches every role.** The composed standing-order core carries the block for every
   built-in role, not a subset.
2. **Budget.** The block is under the stated word count, asserted as a count.
3. **Comment-density ratchet on `.agents/skills/`.** Assert no script exceeds a comment-to-code
   ratio threshold, so instruction prose cannot silently re-accumulate. Fails today against
   `create-feature.js`'s pre-change state, which is the regression this pins.
4. **No tracker vocabulary in skill-script comments.** No comment under `.agents/skills/` mentions
   Linear, ClickUp or Notion sync behaviour — the specific narration that caused this.

### Goal Invariants
1. The composed standing-order core contains the directive, exercised for every built-in role.
2. The directive names both halves: configured behaviour is not reported, and genuine loss is
   reported immediately.
3. The directive is under the stated word budget.
4. `create-feature.js` contains no comment mentioning `_syncFeatureOutbound`, Linear or ClickUp.
   *(Paired positive: it still documents its own invocation — the cut removed narration, not the
   usage line a caller needs.)*
5. No file under `.agents/skills/` exceeds the comment-density threshold.
