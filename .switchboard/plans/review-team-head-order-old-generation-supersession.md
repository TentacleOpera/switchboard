# Review-Team Head Orders: Supersede The First-Generation Text

## Goal

Replace the **first-generation** Review-team head standing order (`OLD_REVIEW_TEAM_HEAD_PROMPT`) on the read path, recovering the coder's terminal name from the on-disk text so `{coder}` can be re-substituted.

### The problem

`OLD_REVIEW_TEAM_HEAD_PROMPT → PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT` was a **body edit**, not an addition. The old text forbade the reviewer from fixing anything:

> `Do NOT fix code yourself — send fix instructions to your coder at {coder} via POST /terminals/verb/ptySendPrompt with {"name":"{coder}","data":"<fix instructions …>","clearBeforePrompt":false} …`

The current text replaced that with a threshold and a delegation rule:

> `Apply a fully diagnosed fix set under approximately 100 lines directly. Delegate larger, broad, or parallelisable sets to your coder at {coder} via POST /terminals/verb/ptySendPrompt. For mechanical findings, specify the exact fix. For judgment calls, send the diagnosis and reasoning and let the coder choose the fix.`

Because the middle of the prompt changed, no amount of edge-appending reaches the current text. Verified against the compiled constants:

```
REVIEW_HEAD_CARD_MOVEMENT_RULE + OLD_REVIEW_TEAM_HEAD_PROMPT + TEAM_HEAD_COMMIT_INSTRUCTION === NEW_REVIEW_TEAM_HEAD_PROMPT   → false
```

A reviewer on a first-generation persisted order is therefore still told **"Do NOT fix code yourself"** and still round-trips every one-line typo through its coder — the behaviour the ≤100-line self-fix threshold was introduced to stop. `migrateAgentGroups` fixes the team *definition* (`teamWiring.ts:1175`), but `wireSpawnedTeam` skips the head order when one already exists for the teamId (`:2092-2094`), so the persisted order never changes.

### Root cause

Two compounding facts:

1. There is no read-path rewriter for Review head orders at all. (Closed by `review-team-head-orders-must-migrate-on-read.md`, which adds `migrateReviewTeamOrders` with two additive transforms. This plan adds the third, non-additive one.)
2. A whole-text **replace** needs the placeholders re-substituted, and the Review prompt's placeholder is `{coder}` — a value the standing-order row does not record. `StandingOrder.parent` is the head's own name; `child` is deliberately `''` for `team-head` scope (old-build safety, see `selectOrders`). The Coding rewriter gets away with a replace because its only placeholder is `{head}`, which *is* `o.parent`. Review has no such luck, which is exactly why the additive plan was separated out and shipped first.

### The mechanism: recover the coder name from the text

Every Review generation contains the coder's substituted name between two stable literals:

| Generation | Surrounding text |
| :--- | :--- |
| `OLD` | `send fix instructions to your coder at ` **NAME** ` via POST /terminals/verb/ptySendPrompt with {…}` |
| `PRE_COMMIT` / `PRE_CARD_MOVE` / `NEW` | `Delegate larger, broad, or parallelisable sets to your coder at ` **NAME** ` via POST /terminals/verb/ptySendPrompt.` |

The common anchors `'to your coder at '` and `' via POST /terminals/verb/ptySendPrompt'` are present in all four generations (verified). Slicing between them recovers the name with `indexOf`/`slice` — no `RegExp`, so a coder name containing regex metacharacters is safe.

`wireSpawnedTeam` leaves `{coder}` unsubstituted and warns when a team has no coder child (`:2104`), so a persisted row may literally contain the string `{coder}`. Recovery then yields `'{coder}'`, and re-substituting `{coder}` → `{coder}` is a correct no-op that preserves the existing warn-and-carry-on behaviour.

## Metadata

**Complexity:** 6
**Tags:** bugfix, backend, reliability, migration

## User Review Required

None.

## Complexity Audit

### Routine

- One more branch in an existing converter, ahead of the two additive ones.
- One frozen-snapshot fragment constant, declaration-site two-copy rule.

### Complex / Risky

- **`String.replace` interprets `$` patterns in a string replacement.** `.replace(/\{coder\}/g, name)` silently mangles a coder name containing `$&`, `$'`, `` $` `` or `$1`. The existing Coding rewriter has the same latent hazard on `{head}` (`teamWiring.ts:2555`), but this plan introduces a *second* substitution from a value recovered out of free text, so use a **replacer function** — `.replace(/\{coder\}/g, () => name)` — which passes the name through verbatim. Pin it with a test using a `$&`-bearing name. Do not "fix" the pre-existing `{head}` site as part of this plan.
- **A full client mirror of the Review prompt is new surface.** `terminals.js` currently has no Review head prompt constant — only the Coding one (`NEW_CODING_HEAD_PROMPT_CLIENT`). A replace branch in the client mirror needs a hand-copied `NEW_REVIEW_TEAM_HEAD_PROMPT_CLIENT` (1154 chars) plus a byte-identity gate, modelled exactly on the existing `OLD/NEW headPrompt constants are byte-identical across host and webview mirror` test. This is the single largest cost in the plan and the most likely place for silent drift.
- **The recogniser must survive the additive transforms.** After the additive plan ships, an on-disk first-generation row becomes `RULE + OLD + COMMIT`. The replace recogniser must match that hybrid as well as the bare `OLD` text. `Do NOT fix code yourself` is present in `OLD` and absent from `NEW` (verified both), and neither additive transform touches it — so a single positive fragment covers both shapes with no marker gate. Order the replace branch **before** the additive branches so a first-generation row is superseded in one pass rather than being decorated first.
- **Replace destroys operator edits, by design.** An operator who edited a first-generation Review head order but kept the `Do NOT fix code yourself` sentence loses their wording. That is the established convention for supersessions across every prior recogniser (the removed fragment is the signal that the text is superseded), and it is why this plan is separate from the additive one: the additive transforms never destroy anything, this one can. State it in the test's comment, as the Coding operator-edit test does.

## Edge-Case & Dependency Audit

### Race Conditions

None new. Same synchronous pure transform inside the same `loadEffectiveStandingOrders` read/persist sequence.

### Security

None. The recovered coder name is written back into a prompt the head already had; no new endpoint, no new file path, no shell interpolation.

### Side Effects

- **The reviewer stops round-tripping small fixes.** The point of the change: a first-generation reviewer gains the ≤100-line self-fix threshold, the mechanical-vs-judgment split, the commit instruction and the card-movement rules in one pass.
- **`{coder}` is preserved verbatim when unrecoverable.** If either anchor is missing (a heavily rewritten row), the branch must **not fire** — leave the row to the additive transforms rather than emitting a prompt containing a literal unsubstituted `{coder}` that the head would `ptySendPrompt` as a terminal name. Fail closed.
- **`describeStandingOrderMigrations` marks the row stale for free** — it diffs the composed result by id.

### Dependencies & Conflicts

- **`review-team-head-orders-must-migrate-on-read.md` should ship first.** It creates `migrateReviewTeamOrders`, the three shared constants, and the four composition sites this plan extends. Shipping this one first is possible but would mean building the converter and its composition here and then merging — strictly more work. Treat the additive plan as the prerequisite.
- **`terminals.js` cannot import from `teamWiring.ts`.** The new fragment and the full `NEW_REVIEW_TEAM_HEAD_PROMPT_CLIENT` are hand-mirrored, gated by `stage-marker-commit-contract.test.js`.
- **`readQuotedChain` (`standing-orders-marker-contract.test.js:49`)** requires `NEW_REVIEW_TEAM_HEAD_PROMPT` to stay a pure quoted `+` chain. Unchanged by this plan — do not refactor it.
- **`OLD_REVIEW_TEAM_HEAD_PROMPT` is a frozen snapshot.** Never edit it. It is what is on disk on first-generation installs.

## Dependencies

`review-team-head-orders-must-migrate-on-read.md` — supplies `migrateReviewTeamOrders`, `REVIEW_HEAD_ORDER_FRAGMENT`, and the composition wiring.

## Adversarial Synthesis

Key risks and their mitigations. (1) **`$`-pattern mangling** of a recovered coder name silently corrupts the delivered prompt — mitigated by a replacer function and a `$&`-bearing-name test. (2) **Firing with an unrecoverable name** would emit a literal `{coder}` into a prompt the head then treats as a terminal name; mitigated by failing closed — if either anchor is missing, do not fire. (3) **A drifted `NEW_REVIEW_TEAM_HEAD_PROMPT_CLIENT`** ships divergent text between host delivery and webview rendering with every other gate green — mitigated by the byte-identity assertion, which is the only thing standing between a 1154-character hand copy and silent divergence. (4) **Branch ordering**: putting the replace after the additive transforms would produce `RULE + OLD + COMMIT` on pass 1 and only supersede it on pass 2, reintroducing an intermediate window the additive plan deliberately avoided — mitigated by ordering the replace first and pinning single-pass convergence in a test. (5) **The recogniser missing the post-additive hybrid** would leave first-generation installs stale forever once the additive plan ships — mitigated by testing convergence from both the bare `OLD` text and from `RULE + OLD + COMMIT`. (6) **A `{coder}`-bearing row** (no coder child at spawn time) round-tripping to a broken value — mitigated by an explicit test asserting the literal `{coder}` survives.

## Proposed Changes

### Part 1 — Fragment constant

**1a. `src/services/teamWiring.ts` — beside `REVIEW_HEAD_ORDER_FRAGMENT`**

```ts
/**
 * Substitution-independent fragment unique to the FIRST-GENERATION Review team
 * head prompt (OLD_REVIEW_TEAM_HEAD_PROMPT). The sentence is REMOVED from the
 * current text, so this is a traditional positive match — a superseded row does
 * not contain it and does not re-match.
 *
 * Needs no marker gate: neither additive transform in migrateReviewTeamOrders
 * touches this sentence, so it matches the bare OLD text and the post-additive
 * hybrid (RULE + OLD + COMMIT) alike.
 *
 * Two DECLARATIONS only: this one and the terminals.js mirror.
 */
export const PRE_SELF_FIX_REVIEW_HEAD_FRAGMENT = 'Do NOT fix code yourself';
```

**1b. `src/webview/terminals.js`** — mirror it as `var`, and add `NEW_REVIEW_TEAM_HEAD_PROMPT_CLIENT` as a hand copy of `NEW_REVIEW_TEAM_HEAD_PROMPT`, with a docblock naming it a mirror and pointing at the byte-identity gate.

### Part 2 — Coder-name recovery helper

**2a. `src/services/teamWiring.ts` — exported pure helper**

```ts
/**
 * Recover the coder terminal name substituted into a persisted Review team head
 * order, so a superseded row can be rewritten with {coder} re-substituted. The
 * standing-order row does not record it: `parent` is the head and `child` is ''
 * for team-head scope, so the on-disk text is the only source.
 *
 * Both anchors are present in all four shipped Review generations. Returns ''
 * when either is missing — callers MUST fail closed on '' rather than emitting a
 * prompt containing a literal unsubstituted {coder}, which the head would then
 * ptySendPrompt as a terminal name.
 *
 * indexOf/slice only — a coder name may contain regex metacharacters.
 */
export function recoverCoderNameFromReviewOrder(instruction: string): string {
    if (typeof instruction !== 'string') { return ''; }
    const OPEN = 'to your coder at ';
    const CLOSE = ' via POST /terminals/verb/ptySendPrompt';
    const start = instruction.indexOf(OPEN);
    if (start === -1) { return ''; }
    const from = start + OPEN.length;
    const end = instruction.indexOf(CLOSE, from);
    if (end === -1 || end <= from) { return ''; }
    return instruction.slice(from, end);
}
```

**2b. `src/webview/terminals.js`** — mirror as `function recoverCoderNameFromReviewOrderClient(instruction)`.

### Part 3 — The replace branch

**3a. `src/services/teamWiring.ts` — first branch inside `migrateReviewTeamOrders`**, ahead of the two additive transforms:

```ts
        // Superseded first-generation text: the "Do NOT fix code yourself"
        // prohibition was replaced by the <=100-line self-fix threshold, a body
        // edit no edge-append can reach. REPLACE, which discards an operator's
        // wording — the established convention for a removed fragment, and the
        // reason this branch is separate from the additive ones below.
        //
        // Fail closed when the coder name is unrecoverable: leave the row to the
        // additive transforms rather than delivering a literal {coder}.
        if (o.instruction.indexOf(PRE_SELF_FIX_REVIEW_HEAD_FRAGMENT) !== -1) {
            const coder = recoverCoderNameFromReviewOrder(o.instruction);
            if (coder) {
                touched = true;
                // Replacer FUNCTION, not a string: a name containing $&, $' or
                // $1 would otherwise be reinterpreted by String.replace.
                const instruction = NEW_REVIEW_TEAM_HEAD_PROMPT
                    .replace(/\{coder\}/g, () => coder);
                console.log(
                    `[teamWiring] Migration: superseded first-generation Review team-head `
                    + `standing order '${o.id}' — self-fix threshold, commit instruction, card-movement rules.`
                );
                return { ...o, instruction };
            }
        }
```

**3b. `src/webview/terminals.js`** — the same branch in `migrateReviewTeamOrdersClient`, using `NEW_REVIEW_TEAM_HEAD_PROMPT_CLIENT`.

### Part 4 — Tests (`src/test/stage-marker-commit-contract.test.js`)

1. **Byte-identity:** `NEW_REVIEW_TEAM_HEAD_PROMPT_CLIENT === NEW_REVIEW_TEAM_HEAD_PROMPT`, extracted from `terminals.js` by the same technique the Coding mirror test uses.
2. **Fragment declaration-site two-copy rule** for `PRE_SELF_FIX_REVIEW_HEAD_FRAGMENT`, plus `OLD_REVIEW_TEAM_HEAD_PROMPT.includes(fragment)` and `!NEW_REVIEW_TEAM_HEAD_PROMPT.includes(fragment)`.
3. **Convergence from the bare OLD text:** a `team-head` row carrying `OLD_REVIEW_TEAM_HEAD_PROMPT` with `{coder}` → `rev-1` becomes exactly `NEW_REVIEW_TEAM_HEAD_PROMPT` with `{coder}` → `rev-1` in **one** pass; a second pass returns the input by reference.
4. **Convergence from the post-additive hybrid:** the same for `REVIEW_HEAD_CARD_MOVEMENT_RULE + OLD + TEAM_HEAD_COMMIT_INSTRUCTION`.
5. **Regex-metacharacter and `$`-pattern safety:** a coder name of `a$&b.*c[` round-trips verbatim into the rewritten instruction. This is the test that catches a string replacement.
6. **Unrecoverable name fails closed:** a row containing the fragment but with the `via POST /terminals/verb/ptySendPrompt` anchor deleted is **not** replaced, and the result contains no literal `{coder}` beyond what was already there.
7. **`{coder}` passthrough:** a row whose placeholder was never substituted keeps the literal `{coder}` after the rewrite.
8. **`recoverCoderNameFromReviewOrder` unit cases:** all four generations, a missing open anchor, a missing close anchor, a non-string input, and an empty span between the anchors — each returning the expected name or `''`.
9. **Branch ordering:** assert the replace fires instead of the additive transforms on a bare `OLD` row — i.e. the result is `NEW_REVIEW_TEAM_HEAD_PROMPT`, not `RULE + OLD + COMMIT`.

## What does NOT change

- **`OLD_REVIEW_TEAM_HEAD_PROMPT` and every other frozen snapshot** — never edited.
- **`NEW_REVIEW_TEAM_HEAD_PROMPT`** — no prompt wording changes; it stays a pure quoted chain so `readQuotedChain` keeps working.
- **The two additive transforms** from the prerequisite plan — unchanged; the replace branch is inserted ahead of them.
- **The `{head}` substitution in `migrateCodingTeamOrders`** — its string-replacement `$`-pattern hazard is pre-existing and out of scope here.
- **`wireSpawnedTeam`'s `headExists` skip and its `{coder}` warning** — both preserved.
- **`migrateAgentGroups`** — the Review definition path already handles the first generation.

## Verification Plan

### Automated

1. `npx tsc -p tsconfig.test.json` — clean.
2. `npm run test:contract:stage-marker-commit` — all existing tests plus the nine above. **Already wired to CI** at `.github/workflows/integration-tests.yml:255`.
3. `npm run test:contract:standing-orders-marker` — the kanban.html↔teamWiring.ts Review byte-identity gate still passes. **Already wired to CI** at `integration-tests.yml:177`.
4. `npm run test:contract:team-scoped-routing` — Review team resolution unaffected. **Already wired to CI**.
5. `npx eslint src/services/teamWiring.ts` — no new errors.

No new npm script is needed; all four gates above are already invoked by CI, so the new assertions gate on merge as soon as they land.

### Manual Verification

6. Confirm the replace uses `.replace(/\{coder\}/g, () => coder)` — a replacer function, not a string.
7. Confirm `recoverCoderNameFromReviewOrder` contains no `new RegExp(` and no regex literal.
8. Confirm the replace branch precedes both additive branches in `migrateReviewTeamOrders` and in the client mirror.
9. Confirm the branch does not fire when the helper returns `''`.
