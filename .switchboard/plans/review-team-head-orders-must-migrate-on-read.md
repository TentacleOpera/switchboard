# Review-Team Head Standing Orders Must Migrate On Read

## Goal

Add a read-path rewriter for **Review**-team head standing orders, so prompt-text changes to `NEW_REVIEW_TEAM_HEAD_PROMPT` reach already-spawned Review teams instead of only new ones.

### The problem

Every head prompt lives in **two** independent stores:

1. the team definition's `headPrompt` (in `terminals.groups`), migrated by `migrateAgentGroups`; and
2. the persisted `team-head` scoped **standing order** (in `terminals.standingOrders`), written once by `wireSpawnedTeam` and thereafter migrated only on the read path.

For the **Coding** team both stores migrate: `migrateAgentGroups` steps 1b–1f fix the definition, and `migrateCodingTeamOrders` (`teamWiring.ts:2474`) rewrites the persisted order on every read via `loadEffectiveStandingOrders`.

For the **Review** team only store 1 migrates. `migrateCodingTeamOrders` recognises Coding rows exclusively — its four fragments (`OLD_HEADPROMPT_FRAGMENT`, `BUGGY_HEADPROMPT_FRAGMENT`, `PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT`, `PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT`) appear in no Review prompt generation. There is no Review counterpart. Store 2 is therefore **frozen at whatever generation the team was spawned on, forever**.

### Root cause

`wireSpawnedTeam` writes the head order keyed on `(scope, teamId)` and skips it when one already exists (`teamWiring.ts:2092-2094`):

```ts
const headExists = next.some((o: StandingOrder) =>
    o.scope === 'team-head' && o.teamId === groupId);
if (!headExists) { /* … push the order … */ }
```

That skip is correct — it is what stops a re-run from duplicating the row and what protects an operator's edits. But it means a re-spawn does **not** refresh the text. The read-path rewriter is the only mechanism that can update store 2, and Review has none. Consequence, measured against the four shipped generations:

| On-disk generation | Has self-fix routing | Has commit instruction | Has card-movement rules |
| :--- | :--- | :--- | :--- |
| `OLD_REVIEW_TEAM_HEAD_PROMPT` | no | no | no |
| `PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT` | yes | no | no |
| `PRE_CARD_MOVEMENT_RULE_REVIEW_HEAD_PROMPT` | yes | yes | no |
| `NEW_REVIEW_TEAM_HEAD_PROMPT` (current) | yes | yes | yes |

Three of four generations are stale on disk right now, and the two most recent changes to the Review prompt — the durable commit instruction and the card-movement rules from `team-heads-must-not-move-cards.md` — reach **no already-spawned Review team at all**.

### Why this plan is additive-only

The two missing changes are both pure edge additions, which is what makes this tractable without a whole-text replace. Verified against the compiled constants:

```
REVIEW_HEAD_CARD_MOVEMENT_RULE + PRE_CARD_MOVEMENT_RULE_REVIEW_HEAD_PROMPT               === NEW_REVIEW_TEAM_HEAD_PROMPT   ✓
REVIEW_HEAD_CARD_MOVEMENT_RULE + PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT + TEAM_HEAD_COMMIT_INSTRUCTION === NEW_REVIEW_TEAM_HEAD_PROMPT   ✓
```

So a **prepend** transform plus an **append** transform, each with its own negative marker gate, carry both recent generations to the exact current text. Additive transforms need no `{coder}` substitution and destroy no operator edits — the two properties that make a whole-text replace expensive here (see `review-team-head-order-old-generation-supersession.md`, which handles the one generation that genuinely needs a replace).

The `OLD_REVIEW_TEAM_HEAD_PROMPT` generation is **out of scope for this plan**: `OLD → PRE_COMMIT` was a body edit (the "Do NOT fix code yourself" prohibition was replaced by the ≤100-line self-fix threshold), so `RULE + OLD + COMMIT !== NEW` — verified false. An OLD row is left as `RULE + OLD + COMMIT` by this plan: strictly better than today (it gains both rules and the commit instruction) and still recognisable by its unique `Do NOT fix code yourself` fragment, which the follow-up plan supersedes.

## Metadata

**Complexity:** 5
**Tags:** bugfix, backend, reliability, migration

## User Review Required

None.

## Complexity Audit

### Routine

- A third pure converter alongside two existing ones, same signature and same reference short-circuit contract.
- Three small two-copy constants (fragment, prepend text, marker), same hand-mirror rule as the five existing ones.
- Composing the converter at four sites (three host, one client mirror).

### Complex / Risky

- **The reference short-circuit is load-bearing.** Both `describeStandingOrderMigrations` (`teamWiring.ts:2640-2643`) and `loadEffectiveStandingOrders` (`:2691-2692`) test `effective === raw` to mean "nothing is stale" — the first returns an empty note map, the second skips `backupOnce` and the persist entirely. `migrateReviewTeamOrders` MUST return its input **by reference** when it recognises nothing, or every read of an already-current install starts writing the config key and spending the one-shot backup. The existing test `an install with nothing stale is never written to` is the gate.
- **`CARD_MOVEMENT_RULE_MARKER` and `REVIEW_HEAD_ORDER_FRAGMENT` cannot use the walkSrc carrier-count rule.** Both texts legitimately appear inside shipped prompt bodies in **three** files (`teamWiring.ts`, `terminals.js`, `kanban.html`), so the `carriers === exactly two files` assertion used for `PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT` would fail. Follow the established precedent for exactly this case: `COMMIT_INSTRUCTION_MARKER exists in exactly two files and is byte-identical` (`stage-marker-commit-contract.test.js:731-752`) pins the **declaration sites** by regex and compares the two extracted values, and says so in a comment. Copy that shape.
- **The pinned client composition literal.** `stage-marker-commit-contract.test.js:524` asserts the exact string `migrateCodingTeamOrdersClient(migrateTeamPairOrdersClient(orders))` is present in `terminals.js`. Adding a third converter changes that expression, so the assertion must be updated in lockstep — it is not a wildcard.
- **Coding/Review recogniser disjointness.** Verified: no Review generation contains any of the four Coding fragments, and no Coding generation contains `You are the reviewer on a review team`. The two converters cannot both fire on one row, so composition order is behaviourally irrelevant — but the converters must still be composed *after* `migrateTeamPairOrders`, which is what normalises the array shape.

## Edge-Case & Dependency Audit

### Race Conditions

None new. `migrateReviewTeamOrders` is a synchronous pure transform over an in-memory array, composed inside the same single `loadEffectiveStandingOrders` read/persist sequence that already serialises through `mutateStandingOrders`. No new write path, no new watcher, no new timer.

### Security

None. No new endpoint, no new user input surface, no new file path.

### Side Effects

- **One-pass convergence, unlike the Coding rewriter.** Both transforms are gated on independent markers and both may fire on the same row in a single pass, so a `PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT` row reaches the exact current text on read 1. There is no two-pass intermediate window here (contrast `team-heads-must-not-move-cards.md`, where the Coding append and replace blocks are separated by `continue`).
- **Operator edits survive.** Both transforms only add text at an edge. An operator who rewrote the middle of their Review head order keeps every word and gains the rules — the same promise the commit-instruction append makes for Coding, and the reason this plan deliberately avoids a replace.
- **A row already carrying one addition gains only the other.** The gates are independent, so `PRE_CARD_MOVEMENT_RULE` rows (commit marker present, rule marker absent) get the prepend only.
- **`describeStandingOrderMigrations` picks this up for free.** It derives notes by diffing the composed result by id rather than re-implementing recognisers, so `GET /terminals/standing-orders` will mark Review head rows stale with no extra work — provided the new converter is added to *its* composition too, not just to `loadEffectiveStandingOrders`.

### Dependencies & Conflicts

- **`team-heads-must-not-move-cards.md`** — already implemented and committed. This plan closes the gap that plan's Review half documented and accepted. `NEW_REVIEW_TEAM_HEAD_PROMPT` and `PRE_CARD_MOVEMENT_RULE_REVIEW_HEAD_PROMPT` already exist as exported constants; nothing about them changes here.
- **`review-team-head-order-old-generation-supersession.md`** — the follow-up that handles the `OLD_REVIEW_TEAM_HEAD_PROMPT` generation. Independent of this plan in both directions: its recogniser (`Do NOT fix code yourself`) is unaffected by these two additions, and this plan's gates are unaffected by its replace. Either may ship first.
- **`readQuotedChain` (`standing-orders-marker-contract.test.js:49`) constrains the constant's shape.** It bails unless the character after `=` is `'`, so `NEW_REVIEW_TEAM_HEAD_PROMPT` must stay a pure quoted `+` chain. Do **not** refactor it to `REVIEW_HEAD_CARD_MOVEMENT_RULE + '…'` — that breaks the kanban.html↔teamWiring.ts byte-identity gate at `:408-416`. Pin the relation with a `startsWith` assertion instead.
- **`terminals.js` cannot import from `teamWiring.ts`.** All three constants are hand-mirrored. `TEAM_HEAD_COMMIT_INSTRUCTION` and `COMMIT_INSTRUCTION_MARKER` mirrors already exist at `terminals.js:10937-10943` and are reused as-is.

## Dependencies

None blocking. `team-heads-must-not-move-cards.md` is already committed and supplies the constants this plan migrates toward.

## Adversarial Synthesis

Key risks and their mitigations. (1) **Losing the reference short-circuit** turns every read into a write and burns the one-shot pre-migration backup on installs that had nothing stale — mitigated by returning `orders` unchanged when `!touched`, and pinned by the existing `an install with nothing stale is never written to` test. (2) **Copying the walkSrc carrier-count assertion** for the marker and fragment fails on a correct implementation, because both texts appear in three shipped prompt bodies — mitigated by following the `COMMIT_INSTRUCTION_MARKER` declaration-site precedent instead. (3) **Updating the client mirror's converters but not the pinned composition literal** at `:524` leaves a green-looking test asserting a string that no longer exists in the file — mitigated by updating that assertion as part of Part 3. (4) **Refactoring `NEW_REVIEW_TEAM_HEAD_PROMPT` into `RULE + '…'`** to make the prepend provably correct breaks `readQuotedChain` and with it the kanban.html byte-identity gate — mitigated by keeping the quoted chain and asserting `NEW_REVIEW_TEAM_HEAD_PROMPT.startsWith(REVIEW_HEAD_CARD_MOVEMENT_RULE)` plus the two full-arithmetic equalities. (5) **A Coding row matching the Review recogniser** would clobber a lead's orders with reviewer text — verified impossible (disjoint fragments) and pinned by a negative test. (6) **Prepending twice** on a re-read would double the rules — prevented by the negative marker gate and pinned by an idempotency assertion.

## Proposed Changes

### Part 1 — Constants

**1a. `src/services/teamWiring.ts` — add three constants beside `PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT` (`:2420`)**

```ts
/**
 * Substitution-independent fragment identifying a persisted `team-head` row as
 * a REVIEW team head order. Present in all four shipped Review generations and
 * in no Coding generation, so the Coding and Review rewriters are disjoint and
 * cannot both fire on one row.
 *
 * Two DECLARATIONS only: this one and the terminals.js mirror. The text itself
 * also appears inside the shipped prompt bodies in kanban.html, so the contract
 * test pins the declaration sites, not a walkSrc carrier count — same as
 * COMMIT_INSTRUCTION_MARKER.
 */
export const REVIEW_HEAD_ORDER_FRAGMENT = 'You are the reviewer on a review team';

/**
 * The card-movement rules, PREPENDED to a stale Review team head order.
 * Byte-identical to the opening of NEW_REVIEW_TEAM_HEAD_PROMPT — asserted, not
 * assumed. Additive, so an operator's edits survive intact.
 */
export const REVIEW_HEAD_CARD_MOVEMENT_RULE =
    'Never move a card backwards to an earlier pipeline stage — only the orchestrator may do that. '
    + 'Never move a card to a new column yourself. ';

/**
 * Substring unique to REVIEW_HEAD_CARD_MOVEMENT_RULE — the negative gate that
 * makes the prepend idempotent. Declaration-site two-copy rule (the text is
 * inside three shipped prompt bodies).
 */
export const CARD_MOVEMENT_RULE_MARKER = 'Never move a card backwards to an earlier pipeline stage';
```

**1b. `src/webview/terminals.js` — mirror all three** beside the existing `COMMIT_INSTRUCTION_MARKER` / `TEAM_HEAD_COMMIT_INSTRUCTION` mirrors (`:10937-10943`), as `var`, with a comment naming each as a mirror of its host constant.

### Part 2 — `migrateReviewTeamOrders`

**2a. `src/services/teamWiring.ts` — new exported converter, placed after `migrateCodingTeamOrders`**

```ts
/**
 * Migrate stale Review-team head standing orders on read — the read-site
 * counterpart to the `migrateAgentGroups` Review steps. `wireSpawnedTeam` skips
 * the head order when one already exists for the teamId, so this is the ONLY
 * mechanism that can update an already-spawned Review team's persisted text.
 *
 * Both transforms are ADDITIVE and independently gated, so both may fire on one
 * row in a single pass and an operator's wording is never discarded:
 *  - prepend REVIEW_HEAD_CARD_MOVEMENT_RULE when CARD_MOVEMENT_RULE_MARKER is absent;
 *  - append TEAM_HEAD_COMMIT_INSTRUCTION when COMMIT_INSTRUCTION_MARKER is absent.
 *
 * Returns its input BY REFERENCE when it recognises nothing. Callers
 * (`loadEffectiveStandingOrders`, `describeStandingOrderMigrations`) treat
 * `result === input` as "nothing is stale" and skip the persist and the backup.
 *
 * Matches by `indexOf` on literal fragments — never a constructed `RegExp`,
 * because a substituted coder name may contain regex metacharacters.
 */
export function migrateReviewTeamOrders(orders: StandingOrder[]): StandingOrder[] {
    if (!Array.isArray(orders) || orders.length === 0) { return orders; }

    let touched = false;
    const next = orders.map((o) => {
        if (!o || typeof o !== 'object') { return o; }
        if (o.scope !== 'team-head' || typeof o.instruction !== 'string') { return o; }
        if (o.instruction.indexOf(REVIEW_HEAD_ORDER_FRAGMENT) === -1) { return o; }

        let instruction = o.instruction;
        if (instruction.indexOf(CARD_MOVEMENT_RULE_MARKER) === -1) {
            instruction = REVIEW_HEAD_CARD_MOVEMENT_RULE + instruction;
        }
        if (instruction.indexOf(COMMIT_INSTRUCTION_MARKER) === -1) {
            instruction = instruction + TEAM_HEAD_COMMIT_INSTRUCTION;
        }
        if (instruction === o.instruction) { return o; }

        touched = true;
        console.log(
            `[teamWiring] Migration: upgraded Review team-head standing order `
            + `'${o.id}' — card-movement rules and/or commit instruction added.`
        );
        return { ...o, instruction };
    });

    return touched ? next : orders;
}
```

The row keeps its `id`, `parent`, `child`, `teamId` and every unknown key (spread), so `describeStandingOrderMigrations` can diff it by id and the Link-up editor's delete-by-id keeps working.

### Part 3 — Compose the converter

**3a. `src/services/teamWiring.ts` — three host sites**, each becoming `migrateReviewTeamOrders(migrateCodingTeamOrders(migrateTeamPairOrders(x)))`:

- `describeStandingOrderMigrations` (`:2640`)
- `loadEffectiveStandingOrders`, the `effective` computation (`:2691`)
- `loadEffectiveStandingOrders`, the `mutateStandingOrders` re-computation (`:2696`)

Leave both `=== raw` reference short-circuits exactly as they are — they stay correct because all three converters honour the by-reference contract.

**3b. `src/webview/terminals.js` — the client mirror**

Add `migrateReviewTeamOrdersClient(orders)` as a faithful `var`-style port of Part 2a, then update the composition (`:11087`) to `migrateReviewTeamOrdersClient(migrateCodingTeamOrdersClient(migrateTeamPairOrdersClient(orders)))` and refresh the comment above it to name three converters.

### Part 4 — Tests

**4a. `src/test/stage-marker-commit-contract.test.js`**

1. `REVIEW_HEAD_ORDER_FRAGMENT` and `CARD_MOVEMENT_RULE_MARKER`: declaration-site two-copy tests modelled on `COMMIT_INSTRUCTION_MARKER exists in exactly two files and is byte-identical` (`:731-752`) — regex-extract from both files, `strictEqual` the values, assert both declarations exist. Include the comment explaining why the carrier count does not apply.
2. `REVIEW_HEAD_CARD_MOVEMENT_RULE`: byte-identity between host and client mirror, and the three arithmetic pins —
   - `NEW_REVIEW_TEAM_HEAD_PROMPT.startsWith(REVIEW_HEAD_CARD_MOVEMENT_RULE)`
   - `REVIEW_HEAD_CARD_MOVEMENT_RULE + PRE_CARD_MOVEMENT_RULE_REVIEW_HEAD_PROMPT === NEW_REVIEW_TEAM_HEAD_PROMPT`
   - `REVIEW_HEAD_CARD_MOVEMENT_RULE + PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT + TEAM_HEAD_COMMIT_INSTRUCTION === NEW_REVIEW_TEAM_HEAD_PROMPT`
   - `REVIEW_HEAD_CARD_MOVEMENT_RULE.includes(CARD_MOVEMENT_RULE_MARKER)` — or the gate never sees the marker and every read re-prepends.
3. Per-generation convergence, one test each: a `team-head` row carrying `PRE_CARD_MOVEMENT_RULE_REVIEW_HEAD_PROMPT` and one carrying `PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT` each become exactly `NEW_REVIEW_TEAM_HEAD_PROMPT` after **one** pass, and a second pass returns the input **by reference**.
4. Reference short-circuit: an array whose only `team-head` row already carries `NEW_REVIEW_TEAM_HEAD_PROMPT` satisfies `migrateReviewTeamOrders(orders) === orders`.
5. Disjointness: a `team-head` row carrying `NEW_CODING_HEAD_PROMPT` is returned by reference by `migrateReviewTeamOrders`, and a row carrying `NEW_REVIEW_TEAM_HEAD_PROMPT` is returned by reference by `migrateCodingTeamOrders`.
6. Operator-edit preservation: a `PRE_CARD_MOVEMENT_RULE_REVIEW_HEAD_PROMPT` row plus a house rule keeps the house rule verbatim and gains the prepend; the row's `id`, `parent` and `teamId` are unchanged.
7. Partial-generation gate: a row already carrying the rules but not the commit instruction gains only the append (and vice-versa).
8. Update the pinned client composition assertion at `:524` to the three-converter expression.

**4b. `src/test/standing-orders-marker-contract.test.js`**

No change required — the kanban.html↔teamWiring.ts Review byte-identity gate at `:408-416` keeps passing because `NEW_REVIEW_TEAM_HEAD_PROMPT` stays a pure quoted chain. Re-run it to confirm that is still true after Part 1.

## What does NOT change

- **`NEW_REVIEW_TEAM_HEAD_PROMPT`, `PRE_CARD_MOVEMENT_RULE_REVIEW_HEAD_PROMPT`, and every other frozen snapshot** — no prompt text is edited by this plan. It only moves already-current text onto disks that never received it.
- **`migrateCodingTeamOrders`** — untouched. The Review converter is a separate function.
- **`migrateAgentGroups`** — untouched. Store 1 already migrates correctly.
- **`wireSpawnedTeam`'s `headExists` skip** — deliberately preserved. It is what stops duplicate rows and protects operator edits; the read-path rewriter is the correct place to update text.
- **`OLD_REVIEW_TEAM_HEAD_PROMPT` rows** — reach `RULE + OLD + COMMIT`, not the current text. Superseded by `review-team-head-order-old-generation-supersession.md`.
- **The Coding `team-head` path** — unchanged in behaviour, including its two-pass append→replace window.

## Verification Plan

### Automated

1. `npx tsc -p tsconfig.test.json` — clean.
2. `npm run test:contract:stage-marker-commit` — all existing tests plus the new Review converter tests. **Already wired to CI** at `.github/workflows/integration-tests.yml:255`.
3. `npm run test:contract:standing-orders-marker` — the Review byte-identity gate still passes. **Already wired to CI** at `integration-tests.yml:177`.
4. `npm run test:contract:standing-orders-fleet-root` — the fleet-root read path is unaffected. **Already wired to CI**.
5. `npm run test:contract:team-scoped-routing` — Review team resolution unaffected. **Already wired to CI**.
6. `npx eslint src/services/teamWiring.ts` — no new errors.

No new npm script is needed; every check above is an existing CI-invoked gate, so the new assertions gate on merge the moment they land in these two files.

### Manual Verification

7. Confirm `migrateReviewTeamOrders` contains no `new RegExp(` and no constructed pattern — `indexOf` only.
8. Confirm all three host composition sites were updated (grep `migrateTeamPairOrders(` in `teamWiring.ts` — three hits, each wrapped by both other converters).
9. Confirm both `=== raw` reference short-circuits in `teamWiring.ts` are unmodified.
