# A Team Lead Must Spread Subtasks Across Idle Seats, Not Burn One Coder to Its Context Limit

## Goal

A lead with three coders and three subtasks puts one on each. A lead that gets a completion back sends the next subtask to a seat with nothing in flight — not back to the seat that just reported. The team's throughput scales with its roster instead of being pinned to one seat's context window while its siblings sit at an idle prompt.

### Problem & background

The lead's dispatch behaviour is not code. It is prose, delivered as a `team-head`-scoped standing order, and the prose currently tells the lead to do exactly the wrong thing.

`NEW_CODING_HEAD_PROMPT` (`src/services/teamWiring.ts:275-293`) is the shipped head prompt for the Coding team. Two of its clauses produce the reported behaviour:

1. > *"Each subtask carries a recommendedRole; dispatch it to a seat of that role on your team. **If your team has no such seat, dispatch to a coder**"*

   "a coder" names no seat. An LLM resolving "a coder" with no selection rule picks the first candidate it can name — and the first candidate it can name is whichever seat it has already been talking to, because that name is the one in its context. Every subsequent subtask resolves to the same name for the same reason.

2. > *"When a coder reports a subtask finished, **note it and give that coder the next subtask.**"*

   This is an explicit instruction to re-use the reporting seat. It is followed correctly. The lead is not misbehaving — it is doing what it was told, and what it was told is single-threaded round-tripping through one seat.

Nothing anywhere in the prompt mentions the other seats, their liveness, or whether they are busy. There is no "prefer an idle seat", no "never give a seat two subtasks", and no instruction to enumerate the roster before choosing. The only spread-shaped rule present is the twice-failed-review escalation ladder (`intern → coder → lead`), which fires on *quality* failure, not on load — so it never triggers on a healthy team and never redistributes anything.

### Root cause

**The head prompt encodes seat re-use as the assignment rule, and gives the lead no roster and no busy/idle signal to do anything else with.** Two halves:

- **The rule is wrong.** "give that coder the next subtask" is a sticky-assignment rule. It reads as continuity ("the coder who just finished has warm context") but the cost is the opposite: that seat's context is the one filling up, and a seat at its limit is a seat that starts truncating or compacting mid-subtask.
- **The facts the right rule needs are available and never named.** `POST /terminals/verb/ptyListTerminals` already returns, per seat: `friendlyName`, `role`, `status`, `parentInstanceId`, `lastDataAt`, and — stamped by both hosts' plan-attribution pass (`TaskViewerProvider.ts:3235-3240`, `bootstrap.ts:1549-1554`) — `planId` and `planTitle` for whatever that seat currently has dispatched to it. A row with `planId: null` is a seat with nothing in flight. That is a ready-made idle signal the prompt never mentions, and the verb is already documented for exactly this audience in the `switchboard-orchestration` skill (`.agents/skills/switchboard-orchestration/SKILL.md:194`).

So this is a prompt-text defect with a migration obligation, not a missing mechanism. No new endpoint is required.

### Why the fix is a text rewrite plus a migration, and nothing more

The head prompt is shipped state in three places and persisted in a fourth, and the repo already has the exact machinery for rewriting it in place — built the last time this same prompt was rewritten:

- `NEW_CODING_HEAD_PROMPT` (`teamWiring.ts:275`) — the constant the order migration writes.
- `NEW_CODING_HEAD_PROMPT_CLIENT` (`src/webview/terminals.js:8877`) — the client mirror, asserted **byte-identical** by `src/test/stage-marker-commit-contract.test.js:357`.
- The Coding team gallery entry in `src/webview/kanban.html:4679` — asserted byte-identical by the same test file at `:373`.
- `terminals.standingOrders` in every install's `kanban.db`, as a `team-head` row with `{head}` already substituted at install time.

`migrateCodingTeamOrders` (`teamWiring.ts:1207`) already rewrites that persisted row on read, matched by a substitution-independent fragment (`OLD_HEADPROMPT_FRAGMENT`, `:1177`) via `indexOf` — never a constructed `RegExp`, because the substituted head name may contain regex metacharacters. `loadEffectiveStandingOrders` (`:1343`) applies it at every server read site and persists once, after `backupOnce`. The client mirrors it in `migrateCodingTeamOrdersClient` (`terminals.js:8992`). Adding a second recogniser to that pair is the whole migration.

---

## Metadata

- **Complexity:** 4
- **Tags:** backend, bugfix, reliability
- **Project:** Browser Switchboard

---

## Complexity Audit (Routine vs Complex/Risky)

**Routine:**
- Rewriting one string constant and its two byte-identical copies.
- Adding one recogniser branch to a migration function and its client mirror — the same shape as the branch already there.

**Complex / risky:**
- **The recogniser fragment must not survive into the new text.** `stage-marker-commit-contract.test.js:391` already pins this for the V1 fragment: *"the new text must not contain the fragment the order converter matches on, or it re-converts forever."* The V2 fragment chosen here (`'note it and give that coder the next subtask'`) is the clause being deleted, so it is absent from V3 by construction — but the assertion must be extended to cover it, or a later editor can reintroduce the phrase and create an infinite rewrite.
- **Nine load-bearing literals must survive.** `stage-marker-commit-contract.test.js:385-390` asserts the head prompt still contains `/kanban/dispatch`, `CODE REVIEWED`, `"from":"{head}"`, `Do NOT use /kanban/move`, `GET /kanban/feature`, `FEATURE planId`, `intern → coder → lead`, `seat fails review on the same subtask twice`, and `stop and report to the human instead of dispatching again`. A rewrite that drops any of them breaks the review handoff or the escalation ladder. This is an **insertion**, not a re-authoring.
- **Three copies must stay byte-identical.** Two `assert.strictEqual` checks compare the client mirror and the gallery entry against the constant. A one-file edit fails the suite immediately, which is the intended behaviour of those pins — all three move together.
- **The V1 branch must keep working.** An install that never adopted the V2 text still carries a V1 row. Its branch already rewrites to `NEW_CODING_HEAD_PROMPT`, so once that constant holds V3, V1 rows jump straight to V3 in one pass. No chaining, no ordering dependency between the two branches.
- **Operator-edited head prompts must be left alone.** Both recognisers match on text. A lead whose team the operator edited in the TEAMS tab does not match either fragment and is untouched — deliberately, and the same rule the existing migration states (`:1204-1205`).

---

## Edge-Case & Dependency Audit

| Case | Behaviour |
|---|---|
| Install carrying the V1 head prompt (`'satisfied with it, hand it to review yourself'`) | Existing branch fires and writes V3 (the constant it already points at). One pass, no chaining. |
| Install carrying the V2 head prompt | New branch fires, writes V3 with `{head}` substituted from the row's own `parent`. |
| Install with an operator-edited head prompt | Neither fragment matches. Left untouched. |
| Install with no team ever started | `terminals.standingOrders` has no `team-head` row; both transforms return their input by reference and `loadEffectiveStandingOrders` short-circuits (`:1349`). No write, no backup. |
| Migration runs twice | Idempotent: V3 contains neither fragment, so the second pass recognises nothing and returns by reference. |
| `describeStandingOrderMigrations` (the Link-up editor's "stale" badge) | Needs **no** change — it derives verdicts by running the same transforms and diffing by id (`:1297`), never by re-implementing a recogniser. The new branch is picked up for free. |
| Team started **after** the change | `wireSpawnedTeam` installs V3 directly from the gallery's `headPrompt`; no migration involved. |
| Lead with a single coder | The spread rule degenerates correctly: one seat, no idle sibling, so it gets the next subtask. The new text must not read as "refuse to dispatch when every seat is busy". |
| Lead whose team has no seat of a subtask's `recommendedRole` | Preserved verbatim: fall back to a coder and say why in the status report. The new rule replaces *which* coder is unnamed, not the fallback itself. |
| Every seat busy, subtasks remain | The lead holds the remainder and dispatches on the next completion. Stated explicitly so "never give a busy seat a second subtask" is not read as "drop the work". |
| A seat that failed review twice | The escalation ladder still wins over the spread rule — quality routing outranks load routing. Stated in the text so the two rules cannot be read as contradictory. |
| `planId` stale for a seat whose plan finished but whose card has not moved | The lead may read a just-finished seat as busy for one cycle and prefer a sibling. That is the desired direction of error. |

**Dependencies:** none outside this repo. Uses `ptyListTerminals` as already shipped (no payload or projection change) and the existing standing-order migration machinery.

---

## Proposed Changes

### 1. `src/services/teamWiring.ts`

**1a. New recogniser constant, beside the existing one (`:1177`):**

```ts
export const OLD_HEADPROMPT_FRAGMENT = 'satisfied with it, hand it to review yourself';

/**
 * The V2 fragment — a substitution-independent clause unique to the
 * feature-level head prompt that told the lead to hand the next subtask back to
 * the coder that just reported. That sticky-assignment rule is the reason a lead
 * ran one seat to its context limit while its siblings idled, so the clause is
 * gone from the current text and this fragment is safe to match on.
 *
 * MUST NOT appear in NEW_CODING_HEAD_PROMPT — a recogniser that matches its own
 * replacement rewrites forever (pinned by stage-marker-commit-contract).
 */
export const OLD_HEADPROMPT_V2_FRAGMENT = 'note it and give that coder the next subtask';
```

**1b. Rewrite `NEW_CODING_HEAD_PROMPT` (`:275`) — insertion, not re-authoring.** The two offending clauses are replaced; every other sentence, and all nine pinned literals, stay byte-identical:

- *"If your team has no such seat, dispatch to a coder and say why in your status report."* keeps its fallback but gains the selection rule.
- *"When a coder reports a subtask finished, note it and give that coder the next subtask."* becomes a spread rule.

The replacement clauses:

```
Before every dispatch, list your seats: POST /terminals/verb/ptyListTerminals
with {} against the port in .switchboard/api-server-port.txt. Each row carries
friendlyName, role, status and planId — a row whose planId is null is a seat
with nothing in flight. Dispatch to an idle seat of the subtask's
recommendedRole. If your team has no seat of that role, dispatch to an idle
coder and say why in your status report. Never give a seat a second subtask
while it still has one in flight, and never re-use a seat while another seat of
the same role is idle — one seat worked round after round hits its context limit
while its siblings sit unused. When a coder reports a subtask finished, note it
and dispatch the next subtask by the same rule, which will usually be a
different seat. If every seat of the needed role is busy, hold the remaining
subtasks and dispatch on the next completion — do not queue two on one seat. The
escalation ladder above outranks this rule: a subtask that failed review twice
moves up a rung even if a same-role seat is idle.
```

**1c. Second branch in `migrateCodingTeamOrders` (`:1239`),** placed immediately after the V1 branch, matching its shape exactly:

```ts
// Stale V2 team-head row: the feature-level headPrompt whose assignment rule
// was "give that coder the next subtask". Same indexOf-on-a-fragment
// recognition as the V1 branch above (never a constructed RegExp — the
// substituted head name may carry regex metacharacters), same rewrite target.
// The V1 branch already writes NEW_CODING_HEAD_PROMPT, so a V1 row lands on
// the current text in ONE pass and never needs to chain through V2.
if (o.scope === 'team-head' && typeof o.instruction === 'string') {
    if (o.instruction.indexOf(OLD_HEADPROMPT_V2_FRAGMENT) !== -1) {
        const newInstruction = NEW_CODING_HEAD_PROMPT.replace(/\{head\}/g, o.parent || '');
        rewritten.push({ ...o, instruction: newInstruction });
        drop.add(o.id);
        touched = true;
        continue;
    }
}
```

### 2. `src/webview/terminals.js` — the client mirror

- `NEW_CODING_HEAD_PROMPT_CLIENT` (`:8877`) updated to the new text, **byte-identical** to the constant (`stage-marker-commit-contract.test.js:357` compares them directly).
- `migrateCodingTeamOrdersClient` (`:8992`) gains the twin branch, with its own local `OLD_HEADPROMPT_V2_FRAGMENT` var beside the existing `OLD_HEADPROMPT_FRAGMENT` var at `:9001` — the mirror is deliberately self-contained (a webview cannot import from `src/services/`), which is why parity is enforced by test rather than by sharing.

### 3. `src/webview/kanban.html` — the gallery entry

The Coding team's `headPrompt` (`:4679`) updated to the same text, byte-identical. This is the source a **newly forked** team carries, so a text-only fix here without the migration would leave every existing team on the old rule, and a migration without this would leave every new team on it.

### 4. `src/test/stage-marker-commit-contract.test.js` — extend the pins

- `test('NEW_CODING_HEAD_PROMPT keeps every load-bearing literal')`: keep all nine literals; add the new spread-rule literals `ptyListTerminals`, `planId is null`, `Never give a seat a second subtask`, and `while another seat of the same role is idle`.
- Same test: add a second negative assertion mirroring the existing one —

  ```js
  assert.ok(!NEW_CODING_HEAD_PROMPT.includes(OLD_HEADPROMPT_V2_FRAGMENT),
      'the new text must not contain the V2 fragment the order converter matches on, or it re-converts forever');
  ```
- New migration test, twinning the existing V1 case: a `team-head` order carrying the V2 text (with a head name containing a regex metacharacter, e.g. `lead(1)`, to prove `indexOf` and not `RegExp`) is rewritten to `NEW_CODING_HEAD_PROMPT` with `{head}` substituted; running the transform twice yields the input by reference; an operator-edited `team-head` row is returned untouched.
- New client-parity test: `migrateCodingTeamOrdersClient` contains the V2 fragment literal, so the webview and the host cannot disagree about which rows are stale.

---

## Verification Plan

1. **Unit:** `node src/test/stage-marker-commit-contract.test.js` — green, including the three byte-identity comparisons and both negative fragment assertions.
2. **Regression:** `node src/test/standing-orders-marker-contract.test.js` — green. Its four `headPrompt` substring assertions (`:369-376`) are all preserved by an insertion-only rewrite; if any fails, a load-bearing clause was dropped.
3. **Migration on a real DB.** Take a copy of an install that has started the Coding team. Confirm the persisted `team-head` row carries the V2 text, launch, then re-read `terminals.standingOrders`: the row carries V3, `terminals.standingOrders.premigration.bak` exists and holds the pre-migration array, and a second launch performs no further write.
4. **Idempotency.** Run the migration twice in-process over the same array; the second call returns the same array **by reference** (the short-circuit `loadEffectiveStandingOrders` depends on at `:1349`).
5. **Link-up editor.** Open the standing-orders editor. The V2 row shows its stale badge with the V3 effective text — proving `describeStandingOrderMigrations` picked up the new branch with no edit.
6. **UAT — spread on first dispatch.** Start the Coding team with three coders. Hand the lead a feature with three subtasks. Each subtask lands on a **different** coder. Verify with `ptyListTerminals` that all three rows have a non-null `planId`.
7. **UAT — spread on completion.** Give the same team four subtasks. When the first coder reports, the fourth subtask goes to whichever seat is idle, **not** back to the reporter. If none is idle, the lead holds it and dispatches on the next completion instead of stacking two on one seat.
8. **UAT — single-coder team.** A team with one coder still gets every subtask dispatched sequentially to that seat, with no refusal and no stall.
9. **UAT — escalation still wins.** Force a subtask to fail review twice on a coder while another coder is idle. It escalates up the `intern → coder → lead` rung rather than moving sideways to the idle same-role seat.
10. **UAT — review handoff intact.** On feature completion the lead still makes exactly one `POST /kanban/dispatch` on the feature planId with `targetColumn: "CODE REVIEWED"`, and never calls `/kanban/move`.
11. **UAT — new team.** Fork a fresh Coding team from the gallery after the change. Its head order carries V3 with no migration involved.
