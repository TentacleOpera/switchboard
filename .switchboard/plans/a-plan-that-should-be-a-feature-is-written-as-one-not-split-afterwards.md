# A Plan That Should Be a Feature Is Written as One, Not Split Afterwards

## Goal

The decision "is this one plan or a feature?" is made **before** the plan is
written, by a mechanical test, using machinery that already exists. A planner
that finds it is writing a feature writes the subtasks and assembles them —
that is a normal outcome, not a remedial one.

## Problem analysis

### The protocol already exists — and is never shown to an agent in the repo

`.agents/plan-authoring-protocol.md` carries a **"📝 Plan Authoring & Problem
Analysis Protocol"** section today. Its own header says why nobody sees it:

> These sections used to live inside the `AGENTS.md` managed block, which made
> them resident in every agent's context on every turn. They are *action-local* —
> they matter only while a plan is being written — so they were cut from the
> resident block (see `shrink-the-injected-agent-protocol-block.md`) and moved
> here, where the one consumer that genuinely needs them can still read them.
>
> **This file is NEVER scaffolded into a managed block and never injected into a
> prompt.**

That cut was right. The resident block went from 14,826 chars to a three-rule
body, and `claude-protocol-block-size-contract.test.js` pins it under an
**800-char gate** so *"the next individually-justified addition"* cannot silently
undo it.

But the file's only remaining consumer is `SparkContextExporter`, which curates
it into a one-shot artifact for an external surface with no filesystem. **An
agent working in this repo — the common case — is never pointed at it.** The
authoring protocol exists and is unreachable.

**Improve-pass finding (verified 2026-09-20):** the file already contains a
**"Plan Sizing — split before drafting"** bullet inside that section
(`.agents/plan-authoring-protocol.md`, lines 33–36) carrying both signals —
"3+ distinct deliverables" and "2+ independently-shippable phases". The test
itself therefore does not need to be *added*; it needs to be *upgraded* to the
feature-first framing and made reachable. Also note the section body cites the
retired path `.switchboard/protocols/improve-plan/SKILL.md` (line 29) — that
reference should be corrected in the same edit.

### Three surfaces author plans, and two of them cannot read a file

- **An agent in the repo** — can read `.agents/…`. A pointer is enough.
- **An external upload (Spark et al.)** — no filesystem. Already served:
  `SparkContextExporter` curates the protocol into a one-shot artifact.
- **The chat prompt buttons** in the project and kanban panels — **no
  filesystem.**

> **Superseded:** "`Copy Prompt` routes `copyKanbanPlanPrompt` → `promptSelected`
> → `buildKanbanBatchPrompt`, so the clipboard gets exactly what a dispatched
> seat gets" and "the chat prompt buttons … are not served at all."
> **Reason:** Two factual errors. (a) `copyKanbanPlanPrompt` does **not** route
> through `promptSelected` — it calls `buildKanbanBatchPrompt('chat', …)`
> directly (`KanbanProvider.ts:13302`), and role `chat` never emits a workflow
> reference at all; it emits `DEFAULT_CHAT_BASE_INSTRUCTIONS`, which **already
> inlines** the "Assess scope — split before drafting" step with both signals
> and the grouping gate (`agentPromptBuilder.ts:1787–1795`). The chat surface
> is served the *split test* — what it lacks is the rest of the authoring
> protocol and the workflow body. (b) The dead-path defect is real but located
> elsewhere: `promptSelected` and dispatched planner seats produce the
> *planner* prompt, which opens with `Read
> .agents/protocols/improve-plan/SKILL.md and follow it step-by-step` — an
> instruction a pasted-into-chat recipient cannot follow.
> **Replaced with:** Three surfaces, accurately: repo agents (need a pointer),
> Spark uploads (already curated), and clipboard prompts carrying the *planner
> role* — `promptSelected` to a planner destination, and planner seat
> dispatches whose prompt is later pasted into a chat. Those carry the dead
> path instruction. The `chat`-role button is a fourth, separate surface that
> already inlines the split test but not the full protocol.

What a planner prompt contains is decided by `renderPlannerWorkflowRef`
(`protocolDirectives.ts:132`):

```ts
if (workflowPath.includes('/') || /\.md$/i.test(workflowPath)) {
    return `Read ${workflowPath} and follow it step-by-step.`;
}
// Bare protocol name → resolve (inline body when delivery === 'inline').
```

`DEFAULT_PLANNER_WORKFLOW` is `'.agents/protocols/improve-plan/SKILL.md'`
(`agentPromptBuilder.ts:1801`) — **a path**. So the composed prompt says *"Read
.agents/protocols/improve-plan/SKILL.md and follow it step-by-step"*, and a
chat surface is told to read a file it has no way to open.

**That is a live defect independent of this plan.** Every planner-role
clipboard prompt today hands a chat an instruction it cannot follow, and the
planning protocol silently never arrives. The bare-name branch already inlines
a resolved body — the mechanism exists and the configured value does not use
it.

### The only authoring guidance a planner does get is a skill for a different job

`DEFAULT_PLANNER_WORKFLOW` points at `improve-plan`, and `plannerBase`
(`agentPromptBuilder.ts:2204–2206`) is essentially that reference plus the
routing map and batch rules. `.agents/protocols/` contains exactly two entries —
`improve-plan` and `improve-feature`.

So a planner authoring a NEW plan is handed a workflow whose opening line is
*"Use this workflow to strengthen an **existing** feature plan in a single fluid
pass"*, and whose only write permission is *"updating the existing Feature Plan
document"*.

### The right test already exists — in the wrong place, too late, and unable to act

`improve-plan` step 2 is exactly the test this plan wants:

> **Assess scope — flag if split needed.** Before strengthening, check whether
> the plan covers **3+ distinct deliverables or 2+ independently-shippable
> phases**. If so, surface that in chat and recommend splitting … or promoting to
> a feature via `create-feature-from-plans` — do not silently strengthen a
> mega-plan.

Three problems, none of them with the test itself:

1. **It runs on a plan that already exists.** By the time it fires, the
   mega-plan has been written, imported, and is on the board.
2. **It is advisory.** *"The recommendation is the action, the user decides."*
   Nothing prevents the plan being worked as written.
3. **It cannot act even if it wanted to** — the skill says so: *"This skill is
   single-plan and non-destructive, so it cannot retroactively split
   mid-improve."*

**Improve-pass finding:** a fourth fact reframes the enforcement story —
`src/test/prompt-split-guidance-sync.test.js` already pins both split signals
across **nine** plan-writing surfaces (chat base, cloud/memo/remote workflows,
`_buildMemoPlannerPrompt`, AGENTS.md, CLAUDE.md, deep-planning Phase 0, and
improve-plan's `## Steps`). **It is currently red on `main`**: assertions 6–7
require `Plan Sizing — split before drafting` in `AGENTS.md` and `CLAUDE.md`,
and neither file contains it (the shrink removed it; the test was written
against the pre-shrink layout). This plan's changes are how that gate goes
green again — assertions 6–7 must be reconciled (see Proposed Changes, item 3)
rather than silently left failing.

### Measured today, by the assistant, twice

Two plans were written at complexity 7 with eight numbered changes each. Both
were then split, at the operator's instruction, into eight subtasks apiece. The
remedial work was: 16 subtask plan files, 2 feature files, re-pointing 16 parent
references, repairing 2 unrelated plans that cited the parent ids, and deleting
2 superseded parents through the delete endpoint with `deleteFile=true`.

Every one of those steps was avoidable by asking the question before writing.

### Splitting late is not free, and it is where drift enters

`a-trimmed-plan-outranks-its-feature-summary-and-says-so-at-the-point-of-review`
records what a stale feature summary costs: a lead rejected a correct
implementation and sent a fix round demanding scope a trimmed plan had removed —
the operator had to intervene. That plan is **written and not implemented**.

A late split re-homes the analysis from the plan into a feature file, which is
precisely the moment the two can disagree. Writing it as a feature from the start
means the argument is authored where it will live.

### The signal is already on the card

Every plan carries `**Complexity:** 1-10`, parsed by `planMetadataUtils` and
already used for routing — 7+ routes to a lead. Nothing uses it as a signal about
the plan's **shape**. A cx-7 plan with eight changes and a cx-7 plan with one
hard change are treated identically at authoring time.

## Metadata

**Tags:** docs, feature, test

> **Superseded:** `**Tags:** planning, protocols, prompts, features, process`
> **Reason:** All five were invented tags; none are in the allowed vocabulary
> (frontend, backend, auth, authentication, database, api, ui, ux, bugfix,
> feature, refactor, test, docs, security, performance, reliability, mobile,
> devops, infrastructure, cli, library).
> **Replaced with:** `docs, feature, test` — protocol/doc edits, a prompt-builder
> behaviour change, and contract-test updates.

**Complexity:** 6

> **Superseded:** `**Complexity:** 2`
> **Reason:** Underscored. The work touches a size-gated managed block with a
> hard char budget, a prompt-resolution path with a Validate-button UX edge,
> ~6 pinning test files, and a currently-red sync contract that must be
> reconciled — multi-file coordination with a real (if small) behavioural
> change, not a routine edit.
> **Replaced with:** 6 (medium — majority routine edits, one well-scoped risk
> in the managed-block budget).

## User Review Required

- **The 800-char gate.** A managed-block pointer costs ~52 chars of the ~53
  remaining after `RESIDENT_PROTOCOL_BODY` (533) + `DOCS_POINTER_RULE` headroom
  (127) + markers (~85). Options: a ≤52-char pointer, or amend the headroom
  test with operator sign-off. The plan proceeds on the ≤52-char option and
  records the alternative.
- **`prompt-split-guidance-sync.test.js` assertions 6–7** currently demand the
  full Plan Sizing *text* in AGENTS.md/CLAUDE.md — incompatible with both the
  shrink and this plan's pointer-only approach. The plan proceeds by amending
  those assertions to accept pointer-form for the two always-on files; if the
  operator wants the full directive resident again, that is a larger change to
  the resident block, not a pointer.
- **`improve-feature` symmetry** — the plan now includes switching
  `DEFAULT_FEATURE_PLANNER_WORKFLOW` to the bare name `improve-feature` (same
  defect, same mechanism). Flagging because it widens the diff beyond the
  original wording.

## Constraints

**Do not ban large plans.** Some work is genuinely one deliverable that happens
to be hard. The test is **deliverables and shippable phases**, never length,
word count or number of headings — a plan with eight changes to one file is one
deliverable; a plan with three changes to three subsystems is three.

**Do not make the planner guess.** The trigger must be mechanical enough to
apply without judgement, because a planner deep in an analysis is the worst
placed to notice it has written a feature. `improve-plan`'s "3+ deliverables or
2+ independently-shippable phases" is the existing wording and should be reused,
not reinvented.

**Reuse `create-feature-from-plans`.** Feature assembly already exists
(`POST /kanban/feature`, `createFeatureFromPlanIds`). Authoring N subtask plans
and assembling them is a supported path today; this plan makes it the *expected*
path, not new machinery.

**A feature must be self-contained** (operator rule, 2026-09-20). The feature
file carries the full argument — analysis, constraints, feature-wide invariants —
and each subtask is self-sufficient on its own scope. Where they disagree, the
subtask plan wins, and that precedence is stated in the subtask, not left to a
document the lead has to think to consult.

**No confirmation dialogs.**

## Complexity Audit

### Routine
- Rewording the Plan Sizing bullet in `.agents/plan-authoring-protocol.md` (the
  signals and file already exist; only framing and the feature-assembly path
  description change).
- Fixing the stale `.switchboard/protocols/improve-plan/SKILL.md` reference in
  the same file.
- Two one-line constant changes in `agentPromptBuilder.ts`
  (`DEFAULT_PLANNER_WORKFLOW`, `DEFAULT_FEATURE_PLANNER_WORKFLOW`).
- Updating the six test files that pin the literal workflow path string.

### Complex / Risky
- **Managed-block budget.** `RESIDENT_PROTOCOL_BODY` is 533 chars; the contract
  test additionally requires `body + DOCS_POINTER_RULE` (127) + markers (~85)
  < 800, leaving ≈52 chars for the pointer. Wording must be measured, and the
  emitted block must contain **no `.agents/` or `.switchboard/` token** (the
  dead-references gate bans both) — the pointer names the file by basename
  only.
- **Validate-button regression.** The Setup "Validate" button posts
  `fileExists` for the workflow path field (`agent-control.js:3431–3438`); a
  bare protocol name fails a filesystem check unless the handler (or the
  webview) treats names resolvable via `ProtocolService.resolveProtocol` as
  valid.
- **Sync-test reconciliation.** `prompt-split-guidance-sync.test.js` is red on
  `main`; assertions 6–7 must be amended to the pointer contract, not merely
  left failing.
- **Prompt size.** `improve-plan`'s bundled body is ~17.7 KB — inlined into
  every planner prompt. Acceptable but must be measured and recorded.

## Edge-Case & Dependency Audit

- **Race Conditions:** none — constant changes and doc edits; `resolveProtocolSet`
  is already per-prompt and never throws (records `null` on failure).
- **Security:** `normalizeProtocolName` rejects `..` and `\`; a bare name can
  never resolve outside the control_plane/bundled sets. No new injection
  surface — `collectBareName` only collects non-path values.
- **Side Effects:** every planner and feature-planner prompt gains the inlined
  body (~17.7 KB / ~9.1 KB respectively); every `promptSelected` clipboard
  payload for a planner destination changes shape (contains `--- BEGIN PROTOCOL
  improve-plan ---`). `RETIRED_WORKFLOW_PATH_MAP` entries that map to the
  constants automatically normalize persisted old paths to the new bare names —
  that is desired, but means a persisted custom path equal to the old default
  resolves to the protocol body rather than the on-disk file; the bundled body
  and the shipped file are the same content, so the outcome is equivalent.
- **Dependencies & Conflicts:** `SparkContextExporter` selects sections by
  literal `###` title — the Plan Authoring heading text must not change. The
  AGENTS.md packaged-block drift test requires the file's managed block to equal
  `RESIDENT_PROTOCOL_BODY` byte-for-byte — after editing the constant, the
  packaged `AGENTS.md`/`CLAUDE.md` managed blocks must be regenerated/updated
  to match. Standalone and extension share this code path (bootstrap wires the
  same `KanbanProvider`), so no dual-root divergence is introduced.

## Dependencies

- None.

## Adversarial Synthesis

Key risks: the 52-char managed-block budget makes the pointer the tightest edit
in the plan; the `fileExists` Validate path can regress the Setup UX if bare
names are not recognized; and the red sync test must be amended, not ignored.
Mitigations: measure the emitted block in the verification step; teach the
validation path that protocol names resolve via `ProtocolService`; amend
assertions 6–7 to the pointer contract in the same diff that adds the pointer.
The goal-vs-appearance gap named in review — inlining `improve-plan` delivers
the *wrong-job* workflow body unless the authoring-protocol pointer also lands —
is covered by keeping Changes 1–4 as one indivisible change set.

## Proposed Changes

### 1. `.agents/plan-authoring-protocol.md` — upgrade the existing Plan Sizing bullet to feature-first

- **Context:** The "📝 Plan Authoring & Problem Analysis Protocol" `###` section
  already contains **"Plan Sizing — split before drafting"** (lines 33–36) with
  both signals but framed as *split into plan files, then maybe group at the
  gate*. The `###` heading titles must stay byte-identical —
  `SparkContextExporter`'s `WANTED_AGENTS_SECTIONS` selects by literal title.
- **Logic:** Promote the bullet to the section's first decision and reframe the
  outcome: when either signal fires, the planner authors one plan file per
  deliverable **and assembles them into a feature via `manage-features`
  (Create from Plans / `POST /kanban/feature`) as the expected path** — not a
  split followed by an optional grouping offer. Add the operator's
  self-containment rule: the feature file carries the full argument
  (analysis, constraints, feature-wide invariants); each subtask is
  self-sufficient on its own scope; where they disagree, the subtask wins and
  the subtask says so.
- **Implementation:** Edit the bullet in place; keep both signal sentences
  verbatim (nine other surfaces and the sync test pin them). In the same edit,
  fix the stale `.switchboard/protocols/improve-plan/SKILL.md` citation at
  line 29 → `.agents/protocols/improve-plan/SKILL.md`.
- **Edge cases:** "If the user explicitly asks for a single plan, respect that
  and write one" must survive verbatim — the sync test asserts it on multiple
  surfaces.

### 2. (folded into 1 — the feature-outcome description lives in the same bullet)

> **Superseded:** A separate change item describing "write a feature is a normal
> outcome" as its own edit.
> **Reason:** It is the same paragraph in the same file; splitting it implied
> two edits where one rewording does both.
> **Replaced with:** folded into Change 1's Logic bullet.

### 3. `src/services/protocolScaffolder.ts` + `AGENTS.md`/`CLAUDE.md` — one pointer line inside the budget

- **Context:** `RESIDENT_PROTOCOL_BODY` (protocolScaffolder.ts:61–67) is the
  single source for both managed blocks. The emitted block must stay < 800
  chars **including** the reserved `DOCS_POINTER_RULE` headroom (127 chars) and
  must contain neither `.agents/` nor `.switchboard/`.
- **Logic:** Append a fourth rule of ≤ ~52 chars naming the file by basename
  only, e.g. `- Writing a plan? Read \`plan-authoring-protocol.md\` first.`
  (measure the final wording against the gate, not this draft).
- **Implementation:** Edit the constant; regenerate/update the packaged
  `AGENTS.md` and `CLAUDE.md` managed blocks so the drift test (`packaged
  AGENTS.md has not drifted`) stays green; amend
  `prompt-split-guidance-sync.test.js` assertions 6–7 to accept pointer-form
  for the two always-on files (the full directive text returning to every-turn
  context is exactly what the shrink removed — the test's intent is preserved
  by asserting the *reachability* pointer instead).
- **Edge cases:** if the pointer cannot be worded inside the budget, the
  alternative is amending the headroom test — an explicit operator-visible
  change to the contract, not a silent gate raise.

### 4. `src/services/agentPromptBuilder.ts` — defaults become bare protocol names

- **Context:** `DEFAULT_PLANNER_WORKFLOW` (line 1801) and
  `DEFAULT_FEATURE_PLANNER_WORKFLOW` (line 1802) are path literals.
  `KanbanProvider.ts:7546–7554` already collects bare-name values into the
  resolve set (`collectBareName`), `improve-plan`/`improve-feature` are bundled
  `delivery: "inline"` protocols, and `RETIRED_WORKFLOW_PATH_MAP` maps every
  retired path spelling to the constants — so persisted old values normalize
  to the new names automatically.
- **Logic:** `DEFAULT_PLANNER_WORKFLOW = 'improve-plan'`,
  `DEFAULT_FEATURE_PLANNER_WORKFLOW = 'improve-feature'`. `renderPlannerWorkflowRef`
  then takes its resolving branch and inlines the body for both repo agents and
  clipboard prompts. Unresolved fallback emits a live
  `switchboard api GET /protocol/<name>` instruction — never a dead path.
- **Implementation:** Also update the `config.get` default literal at
  `KanbanProvider.ts:7793` for readability (the normalize map already catches
  it — this is cosmetic). Teach the `fileExists` validation path
  (`agent-control.js:3431–3438` and its backend handler) that a value
  resolvable via `ProtocolService.resolveProtocol` is valid — otherwise the
  Validate button reports a false failure on the new default.
- **Edge cases:** custom user paths still take the path branch unchanged;
  unresolved bare names degrade to the live fetch instruction, not a crash.

### 5. Tests that pin the path literal — update in the same diff

- `src/test/claude-protocol-block-size-contract.test.js:262–265` — asserts
  `Read .agents/protocols/improve-plan/SKILL.md`; update to the inline-body or
  bare-name form.
- `src/test/minimal-prompt.test.js`, `src/test/batch-move-team-prompt-contract.test.js:116`,
  `src/test/kanban-default-prompt-previews.test.js`,
  `src/services/__tests__/agentPromptBuilder.test.ts:682`,
  `src/test/goal-invariant-verification.test.js:311` — same literal, same fix.
- `src/test/prompt-split-guidance-sync.test.js` assertions 6–7 — amend to the
  pointer contract (see Change 3).

### 6. Nothing else

**No new protocol file, no metadata field, no flag, no import-time check.**
Earlier drafts proposed a new `write-plan` protocol, a declaration field and an
import-time gate. All were dropped (operator, 2026-09-20): the protocol already
exists, and what it needs is to be reachable from each of the three surfaces.

Change 4 is the one code change, and it is a configured value taking an existing
branch — not new machinery.

A gate earns its place when a machine catches something people get wrong
**silently**. A planner that was never shown a protocol is a *missing pointer*,
and `improve-plan` step 2 already surfaces a mega-plan to a human downstream.

## Verification Plan

### Automated Tests

- `prompt-split-guidance-sync.test.js` passes with amended assertions 6–7;
  all other assertions unchanged (the nine surfaces still carry both signals).
- `claude-protocol-block-size-contract.test.js` passes: emitted block < 800
  with `DOCS_POINTER_RULE` headroom, no `.agents/`/`.switchboard/` token, and
  the packaged AGENTS.md block still equals `RESIDENT_PROTOCOL_BODY`.
- A `buildKanbanBatchPrompt('planner', …)` prompt with no explicit
  `plannerWorkflowPath` contains `--- BEGIN PROTOCOL improve-plan ---` and the
  workflow body — asserted on the composed prompt, not the constant.
- A `promptSelected` clipboard payload for a planner destination contains the
  inlined body, not a `Read <path>` instruction.
- A repo agent's prompt still resolves correctly, and the prompt size delta
  (~17.7 KB for the planner body) is measured and recorded.
- The two fixture plans from 2026-09-20 (eight deliverables each) resolve to
  "feature" under the upgraded bullet; a genuinely single-deliverable
  high-complexity plan resolves to "plan" — both asserted directly.
- The `fileExists` validation accepts `improve-plan` (resolves via
  `ProtocolService`) and still rejects a nonexistent custom path.
- **No new protocol file, metadata field, flag or import-time check is
  introduced** — asserted, because the pull toward adding one is what this plan
  had to be talked out of three times.
- A feature authored through this path has the argument in the feature file and
  self-sufficient subtasks — the operator's self-containment rule, asserted.

### Goal Invariants

- `DEFAULT_PLANNER_WORKFLOW` in `agentPromptBuilder.ts` equals `'improve-plan'`
  (no `/`, no `.md` suffix) — the value that makes `renderPlannerWorkflowRef`
  take its resolving branch.
- `RESIDENT_PROTOCOL_BODY` in `protocolScaffolder.ts` contains
  `plan-authoring-protocol.md` and its emitted block stays < 800 chars with
  the docs-pointer headroom.
- `plan-authoring-protocol.md` still contains both signal strings
  (`3+ distinct deliverables`, `2+ independently-shippable phases`) **and** now
  names feature assembly (`manage-features`/`POST /kanban/feature`) inside the
  same `###` section.
- Negative+positive pair: no prompt composed by `buildKanbanBatchPrompt` for
  role `planner` contains `Read .agents/protocols/improve-plan/SKILL.md`;
  the same prompt does contain `BEGIN PROTOCOL improve-plan`.

### Manual

Ask a planner seat for a plan covering three subsystems and confirm it returns a
feature with subtasks rather than one large plan. Then ask for a single hard
change and confirm it returns one plan. Separately: click the Setup Validate
button on the default workflow field and confirm it reports valid.

## Outstanding Questions

- **Does complexity participate in the test at all?** It is tempting to say
  "cx 7+ is a feature", and it would have caught both of today's cases — but it
  would also catch a single hard change, which is exactly the false positive that
  would teach planners to ignore the rule. Deliverables are the real test;
  complexity may be worth recording alongside the flag as corroboration, not as
  the trigger. — proceeding on the assumption that complexity stays out of the
  trigger.
- **[user] Should the sync test's AGENTS.md/CLAUDE.md assertions accept a
  pointer, or should the full Plan Sizing directive return to the resident
  files?** The shrink's rationale (action-local content out of every-turn
  context) argues for the pointer; the test's original intent (identical
  signals on every surface) argues for full text. — proceeding on the
  assumption that pointer-form is correct and amending assertions 6–7.

## Recommendation

**Send to Coder** (complexity 6 — multi-file coordination, one well-scoped
budget/UX risk, majority routine edits).

---

*Improve-pass completion summary (2026-09-20): verified every code claim
against the repo and corrected three factual errors — the `copyKanbanPlanPrompt`
routing claim, the "chat surface unserved" claim (chat base already inlines the
split test), and "add the test" (the Plan Sizing bullet already exists in
`.agents/plan-authoring-protocol.md`). Added concrete file:line implementation
detail, the managed-block char budget math (≈52 chars), the `fileExists`
Validate-button edge, the `improve-feature` symmetry change, and the
currently-red `prompt-split-guidance-sync.test.js` reconciliation. Filled in
all missing required sections; tags and complexity corrected to schema.*

---

*Implementation summary (2026-09-20): Plan Sizing bullet rewritten feature-first — signals verbatim, carve-out verbatim, feature assembly via manage-features/`POST /kanban/feature` named as the expected path, and the feature/subtask self-containment rule added; stale `.switchboard/protocols/` citation corrected to `.agents/protocols/`. Planner defaults are now bare protocol names (`improve-plan`/`improve-feature`) across `DEFAULT_*_WORKFLOW`, `KanbanProvider` config reads, `sharedDefaults.js`, the Setup webview, and the persisted-config migrations; `RETIRED_WORKFLOW_PATH_MAP` normalizes every retired spelling (including the still-on-disk `.agents/protocols/` paths) to the name. `fileExists` in both `KanbanProvider` and `kanbanService` validates bare names via `ProtocolService.resolveProtocol`, with the webview reporting "Protocol resolves" vs "File exists". `RESIDENT_PROTOCOL_BODY` carries a basename-only pointer to `plan-authoring-protocol.md` (emitted block 662 chars, 790 with docs-pointer headroom — under the 800 gate), mirrored into packaged `AGENTS.md`/`CLAUDE.md`. Also fixed: standalone `improvePlan` read a never-existent `.agents/skills/` path (now fs → `resolveProtocol` → embedded fallback in both roots), `renderPlannerWorkflowRef`/`collectBareName` now treat `\` as a path separator, and the provider's `fileExists` containment check matches the service's sibling-prefix guard. Compilation and tests skipped per dispatch directives; edited files syntax-checked and reviewed by diff.*

---

## Review Findings

Reviewed `cd4a81a0` (25 files) plus three review fixes in `src/services/ProtocolService.ts`,
`src/services/ClaudeCodeMirrorService.ts`, `src/services/protocolDirectives.ts`,
`src/test/minimal-prompt.test.js`, `package.json` and `.github/workflows/integration-tests.yml`.
One CRITICAL was found and fixed: resolving `improve-plan` by name returned the 17,416-char
*shipped* body while the retired `Read <path>` instruction had named the 19,018-char
operator-edited `.agents/protocols/improve-plan/SKILL.md` that `ClaudeCodeMirrorService`
deliberately preserves — so this change silently deleted 18 lines of `[user]`-question
discipline from every planner prompt, and the plan's Edge-Case audit claim that "the bundled
body and the shipped file are the same content" is false; resolution now prefers the
workspace file and every `ResolvedProtocol` carries a `source` that is logged at the dispatch
site. One MAJOR was fixed: `prompt-split-guidance-sync.test.js` — this plan's primary
automated check — had no `package.json` script and no CI step, which is why it sat red on
`main` unnoticed, so it is now wired as `test:contract:prompt-split-guidance`. Verified green:
`prompt-split-guidance`, `claude-protocol-block` (17/17), `minimal-prompt` (incl. the new
workspace-precedence guard), `batch-move-team-prompt`, `unattended-batch`,
`standing-order-fragment-store`, `agents-seed-deletion-guard`, `standalone-parity:check`,
`compile-tests`, `compile`, eslint (0 errors); and against the **live host on :7777** a planner
preview for one plan carries `--- BEGIN PROTOCOL improve-plan ---` with no
`Read .agents/protocols/improve-plan/SKILL.md`, while `fileExists` accepts `improve-plan`,
rejects a junk name and still accepts a real path. Remaining risk: the running host predates
the rebuilt `dist/standalone/cli.js`, so it still serves the pre-fix bundled body until it is
restarted.

## Deferred Findings

- MAJOR — `src/test/planner-workflow-path-migration.test.js:58` is red (`Expected kanban DB to initialize for migration test 1`) and is invoked by neither `package.json` nor CI; verified red at `cd4a81a0^` too, so it is pre-existing and out of this plan's diff, but it is the only coverage of `normalizeRetiredWorkflowPath`'s new bare-name targets.
- MAJOR — `src/test/kanban-default-prompt-previews.test.js:163` fails (`Accuracy Mode: Before coding, read and follow the workflow`): the mocked preview builder threads no `resolvedProtocols`, so `protocolPhrase` emits the fetch fallback. Pre-existing (reproduced against `cd4a81a0^`), but this check *is* CI-wired, so CI is red independently of this plan.
- MAJOR — `src/test/goal-invariant-verification.test.js:204` fails (`vsix-packaging-contract.test.js has must-not-exist assertions`); pre-existing since `e26ac375`, CI-wired, unrelated to this plan.
- MAJOR — `src/test/mission-control-tick-and-reports-contract.test.js` has 3 pre-existing failures (dispatch-directive occurrence count, `agent-control.js` seat-routing line, handoff queue predicate); unrelated to this plan.
- NIT — `src/services/KanbanProvider.ts:7659` `collectBareName` has no automated coverage: every builder test stubs `resolvedProtocols`, so deleting the collector would leave all suites green. Verified against the live host instead.
- NIT — `src/services/protocolScaffolder.ts:69` the resident pointer names `plan-authoring-protocol.md` by basename with no directory (the dead-references gate bans `.agents/`), so an agent must search for the file rather than open it.
- NIT — `src/services/ProtocolService.ts:109` the new workspace-file read is a synchronous `readFileSync` per resolution for the two projected survivors; a concurrent `ClaudeCodeMirrorService` projection write could in principle be read mid-write (guarded only by a `.trim()` emptiness check).
- NIT — prompt size, which the plan asked to be "measured and recorded", was not recorded: measured live, a planner prompt for one plan is 26,613 chars with the shipped body and ~28.2 KB with the operator-edited one.
