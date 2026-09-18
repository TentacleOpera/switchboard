# Team head prompt withholds the head's own seat name and never teaches the message recipe

## Goal

Make a pty-hosted team lead able to use `POST /terminals/verb/ptySendPrompt` correctly on
its first attempt, without a human intervening — by emitting the head's own terminal name
into its dispatch prompt and giving it a MESSAGE recipe (non-dispatch send, with `origin`)
alongside the existing STAGING recipe.

### The observed failure

An operator watched a live lead (`Coding`) send a fix round to `Coding-coder-1`. The lead
composed the call by hand with `name`, `data`, `clearBeforePrompt` and nothing else. When
the operator asked "did it reach the terminal?", the lead had no way to answer, guessed at
a cause, and only produced a correctly-shaped call — `origin: "Coding"` — after the human
prompted it. The lead did not know the message API.

### Root cause

The head's own seat name is resolved by the prompt builder and then deliberately discarded,
while the same prompt forbids the head from discovering it and then requires it three times.

1. `KanbanProvider._resolveTeamRosterForPrompt` (`src/services/KanbanProvider.ts:5496`)
   resolves the head's name at line 5540, then drops the head from the roster it returns:
   `const rosterNames = externalHead ? members : members.slice(1);` (line 5555), with the
   comment "the head is the agent receiving this prompt and doesn't need to be in its own
   roster." The name is computed and thrown away — it never reaches the prompt.
2. Both head-prompt builders open with an explicit prohibition: *"Do NOT check your own
   terminal name"* (`_buildBatchDrivePrefix`, line 5711; `_buildDrivePrefix`, line 5770).
3. The same prompts then require that name: `CLOSE OUT` asks for
   `{"from":"<your terminal name>"}` on `POST /kanban/task/complete` (line 5725 and the
   `_buildDrivePrefix` equivalent at line 5786). The lead is told not to look it up and then
   asked for it.
4. `origin` is required for correct sends from a seat, and is documented in exactly one
   place the lead is never pointed at: `.agents/skills/switchboard-orchestration/SKILL.md:214`
   — *"Messaging or dispatching from your own seat? Pass `origin: "<your own terminal name>"`
   … Without it a lead can wipe its own context with its own dispatch."* Neither head-prompt
   STAGING recipe carries `origin` (`KanbanProvider.ts:5721` and the `_buildDrivePrefix`
   recipe at line 5782), so the shipped example teaches the wrong shape.
5. There is no MESSAGE recipe at all. The head prompt shows one send shape, STAGING, which
   carries `dispatch`. Every non-dispatch send a lead must make — fix rounds, questions,
   stand-downs, review verdicts — is improvised from that one example, and the orchestration
   skill explicitly forbids reusing it: *"Never send `dispatch` on a plain message or on a
   report back to your head."*

`origin` is a real correctness field, not decoration. It is read only by
`computeRosterClearTargets` (`src/services/workContextResolver.ts:229-240`) and only to
REMOVE a name from the clear set. When a new work context enters a team, the roster barrier
(`TaskViewerProvider.ts:784`) clears every active roster member except the destination and
the origin. A lead that omits `origin` on a `dispatch`-bearing send is in its own clear set;
the only thing that saves it is the busy check, which holds only while it happens to be
emitting output.

### What this plan does NOT claim

The operator's session concluded that the first send produced a "hollow ack" and that adding
`origin` made it land. That conclusion is not supported by the code and must not be encoded
as a mechanism anywhere in this work:

- `origin` cannot affect whether the destination receives anything. It is only ever used to
  subtract a name from the clear set (`workContextResolver.ts:236-240`), and the security
  note there is explicit: "used only to REMOVE a name from the target set, never to add one".
- The roster barrier that reads `origin` did not run for that call at all. It is gated on
  `contextIdentity`, which requires either a `dispatch` field or `extractDispatchIdentity`
  matching the prompt body (`TaskViewerProvider.ts:617-706`). That matcher requires the
  literal string `PLANS TO PROCESS:` (`src/services/dispatchIdentity.ts:41`). The fix-round
  prompt had neither.
- `success: true` on this verb is not a hollow ack. `ptyHost.ts:275-320` returns it only
  after `sendPromptToPty` completes its writes; a boot-time exit returns `success: false`,
  and a barrier failure returns `success: false` from `TaskViewerProvider.ts:906-914`.

The defect is that the lead was not taught the API, and that the response carries no
delivery evidence for it to reason from — not that `origin` is a delivery switch. Do not
add a "pass origin or the send is lost" line to any prompt; it would be false.

## Metadata

**Tags:** backend, cli, reliability, bugfix
**Complexity:** 4
**Project:** Browser Switchboard

## User Review Required

None. Every change is to strings the extension composes and to one private resolver's return
shape. The one behavioural choice — that an external-head team keeps the original prohibition
and the `<your terminal name>` placeholder rather than being handed a name it cannot use — is
decided below and covered by a regression test.

## Complexity Audit

### Routine

- Widening a private resolver's return from an array to `{ head, members }`.
- Threading one field through `_resolveRosterAndPort`.
- Adding two lines and one recipe block to each of two prompt builders.
- Interpolating a resolved name into an existing template string.

### Complex / Risky

- **Two builders, one behaviour.** `_buildBatchDrivePrefix` and `_buildDrivePrefix` are
  independent literal blocks with no shared body. Every change here is a change in two places,
  and a change landed in one is a silent half-fix that no compile step catches.
- **The external-head branch is a real fork.** `externalHead: true` groups keep `members[0]`
  in the roster and have no pty seat the lead can name itself as. Emitting an identity line
  there would name a seat the lead cannot use; the prohibition and the placeholder must both
  survive on that path.
- **The false mechanism is one careless sentence away.** The originating session's wrong
  conclusion — that `origin` is what makes a send land — is easier to write than the true one.
  A negative test is the only durable guard.

## Edge-Case & Dependency Audit

### Race Conditions

- None introduced. `_resolveTeamRosterForPrompt` is a read-only resolver over
  `terminals.groups` config and a fleet-liveness snapshot; this plan carries an already-bound
  value out of it and changes no ordering.
- The liveness snapshot can be stale or empty, in which case the resolver deliberately does
  not block (`livenessByName` empty ⇒ head accepted). Unchanged: a head name is emitted for
  the group the resolver already selected, so the identity line is exactly as fresh as the
  roster beside it.

### Security

- The emitted name is a friendly terminal name the lead already dispatches to, drawn from
  workspace config. Nothing new crosses a trust boundary.
- `origin` is caller-supplied and only ever subtracts from a clear set
  (`workContextResolver.ts:236-240`), so teaching a lead to send its own name cannot widen
  what any barrier clears.

### Side Effects

- The prompt grows by roughly six lines per builder. Both blocks are already long; there is no
  size gate on this path.
- Deleting the "Do NOT check your own terminal name" sentence removes a turn-saving
  prohibition. The YOUR SEAT line replaces the need for it — the lead is handed the answer the
  prohibition was protecting it from having to look up.
- Interpolating the head name into CLOSE OUT changes a string that contract tests assert on
  (`src/test/drive-mode-prompt-overhaul-contract.test.js` and siblings). Those assertions must
  be updated, not deleted — an assertion on `<your terminal name>` becomes an assertion on the
  external-head branch.

### Dependencies & Conflicts

- **Ships after the companion subtask.** Step 5 below documents what the `ptySendPrompt`
  response proves. Those fields (`promptSeq`, `bytesWritten`) do not exist at HEAD; the
  companion subtask (`…ptysendprompt-returns-delivery-evidence.md`) adds them.
- **No file overlap with the companion.** This plan touches `src/services/KanbanProvider.ts`
  only. The companion touches `src/standalone/ptyPromptDelivery.ts`, `ptyFleetService.ts`,
  `ptyHost.ts`, `bootstrap.ts` and `.agents/skills/switchboard-orchestration/SKILL.md`.
- **Both composition roots.** `KanbanProvider` is shared; the standalone host wires role
  resolution through `setLiveTerminalsProvider` (`bootstrap.ts:2998`) and the extension host
  falls through to `_taskViewerProvider.listFleetTerminals()`. Both reach these builders.

## Dependencies

- None as a session dependency. As a **shipping** dependency, land
  `feature_plan_20260830121000_ptysendprompt-returns-delivery-evidence.md` first — step 5's
  documentation block names response fields that plan creates.

## Adversarial Synthesis

Key risks: the change lives in two hand-maintained prompt literals with no shared body, so a
one-builder fix is a silent half-fix; the external-head fork must keep both the prohibition
and the `<your terminal name>` placeholder or a lead is handed a seat name it cannot use; and
the originating session's false "origin makes the send land" mechanism is one sentence away
from being re-encoded in the very prompt this plan writes. Mitigations: assert every string on
BOTH builders in the contract test rather than one, keep a dedicated external-head regression,
and hold a negative assertion that the prompt never describes `origin` as a delivery switch.

## Current State

- `src/services/KanbanProvider.ts:5496-5593` — `_resolveTeamRosterForPrompt` resolves the
  group, binds the head's name inside the selection loop, excludes `members[0]` from the
  returned roster, and returns `Array<{name, role, active}>` with no head field.
- `src/services/KanbanProvider.ts:5670-5696` — `_resolveRosterAndPort` formats `rosterLines`
  and the port line. Shared by both head-prompt builders.
- `src/services/KanbanProvider.ts:5698-5742` — `_buildBatchDrivePrefix` (loose-plan batch).
- `src/services/KanbanProvider.ts:5744-5820` — `_buildDrivePrefix` (feature drive).
- `src/standalone/bootstrap.ts:2998` — `kanbanProvider.setLiveTerminalsProvider(...)`, the
  standalone role-resolution seam.
- `.agents/skills/switchboard-orchestration/SKILL.md:214` — the only correct, complete
  description of `ptySendPrompt`'s fields, including `origin`. The head prompt does not
  reference this skill.
- `src/services/verbSchemas.ts:1395-1412` — `origin` is a declared, typed, optional field on
  the verb. No code change is needed on the API side for this plan.

## Proposed Changes

### `src/services/KanbanProvider.ts` — `_resolveTeamRosterForPrompt`

**Context.** Lines 5496-5593. Signature is
`Promise<Array<{ name: string; role: string; active: boolean }> | null>`. The group-selection
loop (lines 5533-5551) binds `const headName: string = String(g.name);` **inside the loop
body** and assigns the winning group to `targetGroup` before breaking.

**Logic.** Return `{ head: string; members: Array<{name, role, active}> } | null`. Keep the
`members.slice(1)` exclusion — the head still does not appear in YOUR TEAM; it appears as its
own identity line.

**Implementation.** Resolve the head from `targetGroup`, not from the loop-scoped binding:

> **Superseded:** "`headName` is already bound at line 5540 — return it rather than dropping it."
> **Reason:** `headName` is `const`-bound inside the `for (const g of groups)` body and is out
> of scope at the return site. The value survives only on `targetGroup`.
> **Replaced with:** after the `if (!targetGroup) return null;` guard, resolve
> `const head = externalHead ? '' : String(targetGroup.name);` and return
> `{ head, members: roster }`.

For `externalHead === true` groups the head is not a pty seat the lead can name itself as;
return `head: ''` and let the builders omit the identity line rather than emit an unusable name.

**Edge cases.** All three existing `return null` arms (no db, no group, empty roster) are
unchanged — callers already treat `null` as "fall back to the static prefix".

### `src/services/KanbanProvider.ts` — `_resolveRosterAndPort`

**Context.** Lines 5670-5696. Returns `{ rosterLines, portLine, portResolved } | null`.

**Logic.** Add `head` to the return object alongside the existing three. Its guard becomes
`if (!resolved || resolved.members.length === 0) return null;` against the new resolver shape.
No formatting decisions here — this function only passes the value through.

### `src/services/KanbanProvider.ts` — both head-prompt builders

Apply every item below to **both** `_buildBatchDrivePrefix` and `_buildDrivePrefix`. They
share no body; each change is two edits.

**1. Emit a YOUR SEAT line**, immediately above `YOUR TEAM:`:

```
YOUR SEAT: <head>. Use this exact string wherever an instruction below says "your terminal name".
```

Omit the line entirely when `head` is empty.

**2. Delete the self-contradicting prohibition.** Replace *"Do NOT check your own terminal
name — you dispatch TO named seats (see YOUR TEAM below), and standing orders handle
callbacks."* in both openers with *"Your seat name is below — do not go looking it up."* The
prohibition existed to stop the lead burning a turn on discovery; the YOUR SEAT line removes
the need without leaving the lead unable to fill in fields the same prompt demands. When
`head` is empty (external head), keep the original prohibition text unchanged.

**3. Add `origin` to both STAGING recipes** —
`{"name":"<seat>", …, "origin":"<head>", "dispatch":{…}}` — with a one-line justification
alongside the existing `clearBeforePrompt` note:

```
origin is your own seat name — it keeps the team-wide context reset from clearing you.
```

One line. Do not restate the barrier mechanics. When `head` is empty, keep
`"origin":"<your terminal name>"` as a placeholder rather than dropping the field: an external
head still has a name, it is just not one this resolver can supply.

**4. Add a MESSAGE recipe**, directly under STAGING:

```
MESSAGE (fix rounds, questions, verdicts — anything that is not a new subtask):
curl -s -X POST "$BASE/terminals/verb/ptySendPrompt" -H "Content-Type: application/json" --max-time 30 \
  -d '{"name":"<seat>","data":"<your message>","clearBeforePrompt":false,"origin":"<head>"}'
No dispatch field on a message — it would make the recipient write a plan file and report a false completion.
```

The `dispatch`-omission rationale is lifted from the orchestration skill, which already states
it; the head prompt is where the lead actually reads.

**5. Say what the response proves.** One line under MESSAGE:

```
The response tells you it landed: promptSeq is that seat's delivery ordinal and bytesWritten is what was written to it. bytesWritten counts the host's appended directives too, so it is larger than your data — that is normal.
```

This line names fields the companion subtask creates. Do not write it before that subtask has
landed; a prompt describing fields that do not exist is worse than the silence it replaces.

**6. Substitute the seat name into the CLOSE OUT block.** Both builders currently emit the
literal `{"from":"<your terminal name>"}`. When `head` is non-empty, interpolate it:
`{"from":"<head>", …}`. Keep the placeholder in the external-head branch.

**Edge cases.**

- **`head` empty (external head).** No YOUR SEAT line, original prohibition text, placeholder
  in both recipes and in CLOSE OUT. This is the one path where the lead genuinely must resolve
  its own name, and the prompt must not pretend otherwise.
- **A head name containing a double quote.** Names come from workspace config and are
  interpolated into a single-quoted shell `-d` argument containing JSON. Escape on
  interpolation rather than assuming the name is quote-free.
- **The static fallback.** `_buildFeatureDirectivePrefix` falls back to `DRIVE_FEATURE_PREFIX`
  when the drive block returns `null`. That static prefix is untouched by this plan and
  carries no roster, so it needs no identity line.

### Both composition roots

`_resolveTeamRosterForPrompt` reads roles through `_liveTerminalsProvider` (standalone, wired
at `bootstrap.ts:2998`) with a `_taskViewerProvider.listFleetTerminals()` fallback (extension),
so the builder itself is shared. Confirm by hand that `src/standalone/bootstrap.ts` and
`src/extension.ts` both construct `KanbanProvider` on a path that reaches these prefixes. If
either root reaches a different prefix builder, this plan is incomplete — say so rather than
shipping the extension half.

## Out of scope — stated deliberately

- **Member→head report fragments** (`src/services/teamWiring.ts:69,92,222,258,649`,
  `src/services/standingOrderFragments.ts:69,127`, `src/services/standingOrders.ts:681`,
  `src/services/linkPresets.ts:105`) also omit `origin`. They are reports and fix relays with
  no `dispatch` field and no `PLANS TO PROCESS:` body, so `contextIdentity` is null and the
  barrier never runs for them. Adding `origin` there is correct-but-inert and touches eight
  string fragments across four files; it belongs in its own pass, not this one.
- **Delivery evidence on the `ptySendPrompt` response.** With `clearBeforePrompt: false`
  there is no readiness result, so the body is `{"success":true,"directivesAttached":[]}` and
  a lead genuinely cannot tell a landed send from a lost one. That is the reason the operator's
  session invented a mechanism. It is a real gap and a separate deliverable — it changes an
  API response shape in both hosts and needs its own contract test. It is the companion
  subtask in this feature, not this plan's work.

## Verification Plan

### Automated Tests

1. **Unit — resolver carries the head.** Extend the existing head-prompt coverage: build a
   team group `{ name: 'Coding', headRole: 'lead', teamGroup: true, members: ['Coding','Coding-coder-1','Coding-intern'] }`
   and assert `_resolveTeamRosterForPrompt` returns `head === 'Coding'` and that `'Coding'`
   is absent from `members`.
2. **Contract — both prefixes.** For `_buildBatchDrivePrefix` **and** `_buildDrivePrefix`,
   assert the emitted block: contains `YOUR SEAT: Coding`; does NOT contain the string
   `Do NOT check your own terminal name`; contains `"origin":"Coding"` in the STAGING recipe;
   contains a `MESSAGE (` section whose curl body has `origin` and does NOT have `dispatch`;
   and contains `{"from":"Coding"` rather than `{"from":"<your terminal name>"`. Run every
   assertion against both builders — a single-builder assertion passes on a half-landed fix.
3. **External-head regression.** With `externalHead: true`, assert no `YOUR SEAT:` line, the
   original prohibition text intact, and `<your terminal name>` still present in CLOSE OUT and
   in both recipes' `origin`.
4. **Negative — no false mechanism.** Assert neither prefix contains the substrings `hollow`,
   `not delivered`, or `the send is lost`. `origin` is a context-preservation field; a prompt
   that tells a lead it is a delivery switch is the bug this plan exists to avoid re-creating.
5. **Both hosts.** Run the head-prompt contract test under the standalone composition path as
   well as the extension path (mirroring the existing standalone contract tests), so the
   `_liveTerminalsProvider` branch of role resolution is exercised, not only
   `listFleetTerminals()`.
6. **Existing assertions updated, not deleted.** The prompt contract suites that currently
   assert on `<your terminal name>` or on the prohibition sentence must be re-pointed at the
   external-head branch rather than dropped. A deleted assertion is how this change loses its
   own guard.

### Goal Invariants

- **Negative:** the string `Do NOT check your own terminal name` is absent from the
  non-external-head output of both `_buildBatchDrivePrefix` and `_buildDrivePrefix`.
- **Positive (paired):** both builders emit a `YOUR SEAT: ` line carrying the resolved head
  name on that same path — the name the deleted prohibition was withholding is now present.
- **Positive:** `_resolveTeamRosterForPrompt`'s return type names a `head` field, and
  `_resolveRosterAndPort` passes it through.
- **Positive:** both builders contain exactly one `MESSAGE (` block, and that block's curl
  body contains `origin` and does not contain `dispatch`.
- **Negative (paired with the external-head fork):** on `externalHead: true` the `YOUR SEAT: `
  line is absent and `<your terminal name>` is still present in CLOSE OUT.

### Live smoke

With a real team up, dispatch a feature and read the lead's pasted prompt in its terminal:
YOUR SEAT names the lead's seat, STAGING and MESSAGE both show the lead's own name in
`origin`, and CLOSE OUT names it in `from`. Then have the lead send a plain fix round and
confirm it uses the MESSAGE shape unprompted.

## Implementation Summary

Implemented all changes in `src/services/KanbanProvider.ts` to emit the head seat name and MESSAGE recipe into both `_buildBatchDrivePrefix` and `_buildDrivePrefix`. `_resolveTeamRosterForPrompt` now returns `{ head, members }` with `head: ''` for external-head teams, and `_resolveRosterAndPort` passes `head` through. Both prompt builders emit `YOUR SEAT: <head>`, replace the prohibition with `Your seat name is below — do not go looking it up.`, include `origin` in STAGING and CLOSE OUT, and add a complete MESSAGE curl recipe describing delivery evidence. Updated and extended contract tests across `drive-mode-prompt-overhaul-contract.test.js`, `batch-move-team-prompt-contract.test.js`, and `terminal-groups-headrole-contract.test.js`.


## Review Findings

Reviewed commit `2bd5f0c7`. Goal achieved: `_resolveTeamRosterForPrompt` returns `{ head, members }`, `_resolveRosterAndPort` passes `head` through, and both `_buildBatchDrivePrefix` and `_buildDrivePrefix` emit `YOUR SEAT:`, carry `"origin"` in STAGING, add exactly one `MESSAGE (` block with `origin` and no `dispatch`, and interpolate the head into CLOSE OUT's `from` — with the original prohibition and `<your terminal name>` preserved on the `externalHead` branch. Verified against the writer, not the plan's claim: `teamWiring.ts:1566` persists `name: headName` and `members: [headName, ...childNames]`, so `targetGroup.name` really is the head's terminal friendlyName; `origin` is read by both composition roots (`TaskViewerProvider.ts:788`, `bootstrap.ts:2077`) and declared in `verbSchemas.ts:1412`. No fix was needed in `KanbanProvider.ts`. Suites green after compiling `out/`: `drive-mode-prompt-overhaul`, `batch-move-team-prompt`, `terminal-groups-headrole`, `coding-head-prompt` — all four are CI-wired.

## Deferred Findings

- NIT — `src/services/KanbanProvider.ts:5717` — `originVal` uses `JSON.stringify(head).slice(1,-1)`, which escapes `"` but not `'`; a head name containing an apostrophe breaks the single-quoted shell `-d` argument. Pre-existing codebase-wide pattern (cf. `teamWiring.ts:223`), so not fixed here.
- NIT — `src/test/drive-mode-prompt-overhaul-contract.test.js:82` — the head-prompt assertions run against the extension role-resolution path and a `_liveTerminalsProvider` stub, but never construct the standalone host; the plan's step-5 "both hosts" item is satisfied only at the resolver seam, not end to end.
