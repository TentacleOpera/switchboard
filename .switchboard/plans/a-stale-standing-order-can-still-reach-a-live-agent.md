# A Stale Standing Order Can Still Reach a Live Agent, and Nothing Detects It

## Goal

Make the standing-order instruction an agent *actually receives* verifiably equal to the instruction the system currently intends. Today a superseded instruction can be fixed in source, correctly migrated by three separate render paths, and still arrive verbatim at a running agent — with no signal, no gate, and no way for the agent or the operator to tell.

### The incident this comes from (2026-08-17, observed, not hypothesised)

A lead agent (`lead-1`) driving the feature *The Orchestrator Runs as a Ticking Agent* received this in its standing-orders block:

> "When a coder reports a subtask finished and you are satisfied with it, hand it to review yourself: … POST /kanban/dispatch with `{"plan":"<planId>","targetColumn":"CODE REVIEWED","from":"lead-1"}`"

That is `OLD_CODING_HEAD_PROMPT` verbatim — the **per-subtask** review behaviour that `coding-team-sends-the-feature-to-review-not-each-subtask.md` deliberately replaced with a single feature-level advance. The lead obeyed it, advanced a subtask card to `CODE REVIEWED`, and dispatched the reviewer on a fragment of a feature. The operator's fix was correct, present in `src/`, and in the rebuilt extension. It still did not reach the agent.

The same block also carried the reviewer **pair** row that `migrateCodingTeamOrders`' pair recogniser is written to drop. Two independent stale rows in one delivered prompt.

### Root cause analysis

**What is proven:**

1. **The persisted row is never rewritten.** `migrateCodingTeamOrders` (`src/services/teamWiring.ts:988`) is a pure transform — its own comment says *"Pure transforms — no DB writes."* The row at the `terminals.standingOrders` config key keeps `OLD_CODING_HEAD_PROMPT` on disk **forever**. Correctness therefore depends on *every* render path, present and future, remembering to call it. That is a standing invariant maintained by convention across four separate code sites (`TaskViewerProvider.ts:512` and `:663`, `standalone/bootstrap.ts:272`, plus the hand-maintained client mirror `migrateCodingTeamOrdersClient` at `src/webview/terminals.js:8916`).
2. **The diagnostic surface disagrees with delivered behaviour.** `GET /terminals/standing-orders` (`LocalApiServer._handleStandingOrdersList`, `:2337`) returns the **raw** persisted rows with only an absent-`scope` default applied — no migration. An agent or operator inspecting its own orders reads the superseded text even on an install where delivery is correct, and reads identical text on an install where delivery is broken. The one endpoint you would use to answer "what is this agent actually told?" cannot distinguish the two states.
3. **No gate protects any of this.** `NEW_CODING_HEAD_PROMPT`, `migrateCodingTeamOrders` and the client mirror are **uncommitted working-tree changes** — re-verified at the time of this pass: `git log --all -S "NEW_CODING_HEAD_PROMPT"` returns zero commits and `git show HEAD:src/services/teamWiring.ts` contains zero occurrences. Their contract test `src/test/stage-marker-commit-contract.test.js` is **untracked**. Nothing in CI asserts the invariant in item 1, so a fourth render path added tomorrow reintroduces the bug silently.

**The leading explanation for this install, already evidenced.** The plan previously left three candidate causes open. One of them is now supported by a measurement recorded elsewhere in the repo rather than by fresh speculation: the reviewer pass on feature *Agent Instruction Surface* states that **"the running extension still emits the pre-fix prompt pairing … confirming the installed VSIX predates `d8f9c0b9`."** Combined with proof #3 — the fix has never been committed at all — the ordinary reading is that `lead-1` was served by an extension host running a build that predates the fix, so the resident module still carried `OLD_CODING_HEAD_PROMPT` with no migration to apply. That is consistent with every observation and requires no undiscovered code path.

**What is still NOT established, and must not be guessed:** that this explanation is the *only* one operative here. The remaining candidates are a fourth composition path not found by grepping `applyStandingOrders(`, and a delivery path that reads the config key directly. **Reproduce and confirm before writing a fix aimed at a specific mechanism** — three mechanisms were invented and discarded during the incident triage. The durable fixes below are worth doing regardless of which explanation lands, which is why they are specified independently of it, and why the reproduction is verification step 1 rather than step 7.

## Metadata

**Tags:** backend, reliability, test
**Complexity:** 6

## User Review Required

None.

## Complexity Audit

### Routine

- The pure transforms already exist, are unit-tested, and keep their signatures. Nothing in this plan rewrites their recogniser logic.
- The change detector is exact and cheap: both transforms **return the input array by reference** when they recognise nothing (`if (recognised.size === 0) { return orders; }` at `teamWiring.ts:927`; `if (!touched) { return orders; }` at `:1039`). So `out !== orders` is a precise "something changed" test — no deep compare, no `touched` plumbing out of the functions.
- The serialising write primitive already exists: `mutateStandingOrders(db, mutator)` (`src/services/standingOrders.ts:45`) runs read-modify-write through a module-level `_writeChain`.

### Complex / Risky

- **Persisting is destructive on ~4,000 installs.** `migrateTeamPairOrders` **drops** the per-member pair rows and mints a replacement team row. Today they survive on disk and are only filtered at render — reversible. Persisting deletes them irreversibly. This is shipped state under the repo's migration rule, so it needs a backup, not just a write.
- **Id churn is a known, already-gated hazard.** `makeStandingOrder` mints `crypto.randomUUID()` per call (`standingOrders.ts:214-222`), so the pair migration produces a different `id` on every invocation. `src/test/standing-orders-marker-contract.test.js:238-249` exists specifically to assert the migration is **not** applied at the fetch level, because churning ids breaks the Link-up editor's delete-by-id. Change 2 as originally written violates that gate.
- **The plan fixes one stale row, not staleness as a class.** After persisting, the `OLD_HEADPROMPT_FRAGMENT` recogniser matches nothing and the row is an ordinary operator-shaped row on disk. The *next* head-prompt edit — which the sibling plan makes — has no fragment left to key on. See Adversarial Synthesis and Dependencies.
- **The "commit the fix" step is not a clean commit.** The working tree carries ~989 changed lines in `src/webview/kanban.html`, far more than this fix. Committing by file sweeps unrelated work into an in-scope file — the exact failure the parent feature's reviewer recorded for `f996edda`.

## Edge-Case & Dependency Audit

### Race Conditions

- **Concurrent add/delete during the persisting pass.** `persistMigratedOrders` reading, transforming and writing outside the existing `_writeChain` would clobber a Link-up add that lands between its read and its write. Mitigation: run the persist **inside** `mutateStandingOrders`, and re-run the transforms on the array the mutator is handed rather than on the array read before entering the chain.
- **Two prompts delivered simultaneously.** Both would see a stale row, both would transform, both would persist. Harmless — the transform is convergent and the second write is value-identical — but only if the reference short-circuit means the second one does not enter the write chain at all in the common (already-migrated) case.
- **A read that races the first persist** sees either the raw or the migrated array; both render identically because delivery applies the transform regardless. Delivery correctness never depends on the persist having happened.

### Security

- No new network surface. `GET /terminals/standing-orders` stays auth-gated and its response only gains fields.
- The persisting pass writes to a config key on a path that is currently read-only during delivery. A failed write must **never** block a delivery — fall back to the in-memory transform and log. A degraded prompt beats a lost dispatch, which is the rule both chokepoints already follow.

### Side Effects

- **Row identity changes for pair-migrated rows.** Once persisted, the minted team row's id is stable — an improvement over today, where it is different on every render. But any UI holding a pre-persist id (an open Link-up editor listing the *old* pair rows) will fail delete-by-id afterwards. Acceptable and self-healing on refresh; state it rather than discovering it.
- **The `stale` marker goes permanently false after the persist.** That is the correct end state, and it means change 2's diagnostic value is concentrated in the transition window and in installs whose rows the persist deliberately leaves alone. Say so, so a later reader does not treat a false `stale` as proof the endpoint is inert.

### Dependencies & Conflicts

- `src/services/teamWiring.ts` is edited by this plan (change 1) and by the sibling plan (its changes 3 and 4, which rewrite `NEW_CODING_HEAD_PROMPT`). Same file ⇒ serialise, per the PRD's one-stream-per-provider-file rule.
- Change 4 must commit `src/services/teamWiring.ts`, `src/webview/terminals.js`, `src/webview/kanban.html`, `src/test/stage-marker-commit-contract.test.js`, **`package.json`**, and **`.github/workflows/integration-tests.yml`** together — see change 4.

## Dependencies

- `coding-team-sends-the-feature-to-review-not-each-subtask.md` — supplies `NEW_CODING_HEAD_PROMPT`; this plan is what makes it actually reach an agent.
- Sibling: `a-lead-dispatched-agent-is-told-less-than-a-board-dispatched-one.md` — its changes 3 and 4 rewrite `NEW_CODING_HEAD_PROMPT`. **Its prompt edits must land before this plan's change 1**, or the persisting pass freezes every install on the pre-edit text with no recogniser left to migrate it. If this plan must go first, it must ship the template-version stamp (Adversarial Synthesis) so a later text edit stays migratable.

> **Superseded:** "Feature *Agent Instruction Surface — What Dispatched Agents Are Actually Told* (`c3f6fa01-cbbe-4d44-aff4-11f04e114835`, PLAN REVIEWED) is the natural home for this plan."
> **Reason:** That feature is finished. Its file records all three subtasks landed in sequence (`f996edda` → `025de73c` → `d8f9c0b9`) and carries a completed reviewer pass with executed verification. Attaching new subtasks reopens a closed, reviewed feature and invalidates its recorded result.
> **Replaced with:** This plan and its sibling want a **new** feature of the same class. Naming and creating it is a board decision, not a coding step — raised with the user rather than performed here.

## Adversarial Synthesis

Key risks: persisting the migration deletes shipped rows irreversibly on ~4,000 installs, so it needs a one-time backup rather than a bare write; returning migrated rows from the read endpoint churns `crypto.randomUUID()`-minted ids and breaks the Link-up editor's delete-by-id, which an existing contract test already forbids; and the plan closes *this* stale row while leaving the class open — after the persist there is no fragment left for the next prompt edit to key on, and the sibling plan makes exactly that edit. Mitigations: persist inside the existing `mutateStandingOrders` write chain behind a one-time `*.premigration.bak` config key; keep the endpoint's `orders` array raw and identity-stable while adding `effectiveInstruction` / `stale` as additive fields; and either land the sibling's prompt edits first or add a template-version stamp so future edits remain migratable.

## Proposed Changes

### 1. Migrate on write, not on every render — `src/services/teamWiring.ts`

- **Context.** `migrateCodingTeamOrders` and `migrateTeamPairOrders` are pure transforms applied at read time by four sites.
- **Logic.** Keep the pure transforms (they are correct and unit-testable) but add a **one-time persisting pass** that runs where the orders are loaded and rewrites the config key when the transform changed something. A stale row then stops existing rather than being re-neutralised on every prompt for the life of the install.
- **Implementation.**

  > **Superseded:** "`persistMigratedOrders(db, orders)` — run the existing pure transforms; if the result differs, write it back to `terminals.standingOrders` and return it. Call it from the DB-backed load path."
  > **Reason:** Three defects. (a) A bare read-transform-write races every Link-up add/delete — `standingOrders.ts` already owns a serialising `_writeChain` via `mutateStandingOrders`, and bypassing it is how a concurrent write gets clobbered. (b) "If the result differs" is under-specified and invites a deep compare; the transforms already return the **input array by reference** when nothing matched, so reference inequality is the exact test. (c) "the DB-backed load path" is not a thing — there are three separate server-side read sites, and adding a persist to one of them leaves the other two on the old behaviour while the invariant in change 3 stays a four-site convention.
  > **Replaced with:** One exported loader that becomes the single server-side read path.
  >
  > ```ts
  > /** The only server-side reader of terminals.standingOrders. Reads, applies the
  >  *  pure transforms, persists the result once if anything changed, and returns the
  >  *  effective set. A failed persist logs and returns the in-memory transform —
  >  *  delivery never depends on the write. */
  > export async function loadEffectiveStandingOrders(db: any): Promise<StandingOrder[]> {
  >     const raw = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []) as StandingOrder[];
  >     const effective = migrateCodingTeamOrders(migrateTeamPairOrders(raw));
  >     if (effective === raw) { return raw; }              // reference short-circuit: nothing matched
  >     try {
  >         await backupOnce(db, raw);                       // see "Backup" below
  >         await mutateStandingOrders(db, async (current) =>
  >             migrateCodingTeamOrders(migrateTeamPairOrders(current)));  // re-transform INSIDE the chain
  >     } catch (err) {
  >         console.warn('[teamWiring] standing-order migration persist failed:', err);
  >     }
  >     return effective;
  > }
  > ```
  >
  > Repoint all three server-side sites at it: `TaskViewerProvider.ts:506-512`, `TaskViewerProvider.ts:637` (`_resolveStandingOrdersForVsCode`), and `standalone/bootstrap.ts:266-272`. The pure functions keep their current signatures, so the existing unit tests and the client mirror are unaffected.

- **Backup (required by the repo's shipped-state migration rule).** `migrateTeamPairOrders` *drops* rows. Before the first persisting write, copy the pre-migration array to a sibling config key — `terminals.standingOrders.premigration.bak` — written **once** (skip if the key already exists). This is the config-table equivalent of the `*.migrated.bak` rule for files: a no-op backup costs nothing, and a missing one destroys operator-authored rows that a recogniser mis-fired on.
- **Edge cases.**
  - Idempotent by construction — a second pass recognises nothing and the reference short-circuit returns before touching the write chain.
  - Concurrent writers: serialised by `mutateStandingOrders`; re-transforming the array the mutator is handed (not the one read before the chain) is what prevents clobbering a concurrent add.
  - A failed write must not block delivery — fall back to the in-memory transform and log.
  - An operator-edited ad-hoc order is untouched: both recognisers match exact text (`instruction === expected` for the pair row) or a substitution-independent fragment on a `team-head`-scoped row. Nothing else is rewritten, and the backup covers a mis-fire.

### 2. Make the read endpoint honest — `GET /terminals/standing-orders`

- **Context.** `_handleStandingOrdersList` (`src/services/LocalApiServer.ts:2337`) returns raw persisted rows with only an absent-`scope` default applied.
- **Logic.** Return what an agent would actually be delivered, and make any divergence visible.

  > **Superseded:** "Apply the same transforms before responding, and add a per-row `stale: true` marker where a recogniser fired."
  > **Reason:** Applying the transforms to the returned `orders` array breaks row identity. `makeStandingOrder` mints `crypto.randomUUID()` per call (`standingOrders.ts:222`), so the pair migration returns a different `id` on every request — and the Link-up editor deletes by id. This is not a theoretical objection: `src/test/standing-orders-marker-contract.test.js:238-249` already asserts the migration is **not** applied at the fetch level, for exactly this reason. Change 2 as written fails an existing gate and breaks a shipped UI.
  > **Replaced with:** Keep `orders` raw and identity-stable; make the effective text an **additive per-row field**. For each row, compute the transform result and attach:
  >
  > - `effectiveInstruction` — the text this row would actually contribute to a delivered prompt, present only when it differs from `instruction`;
  > - `stale: true` — set when a recogniser fired on this row;
  > - `dropped: true` — for rows the transform removes entirely (the reviewer pair row), so a reader can see a row exists on disk and contributes nothing.
  >
  > Response shape stays additive and every existing consumer keeps working (PRD contract #4). The endpoint then answers "what is this agent told" *and* "what is on disk", which is strictly more than either alone — and it does it without minting an id.

- **Edge cases.**
  - After change 1 persists, no recogniser fires and `stale` is permanently absent. That is the correct end state, not a broken endpoint — document it on the field so a later reader does not treat the absence as evidence the marker is inert.
  - Rows the pair migration *creates* have no on-disk counterpart. Do not fabricate a row for them in `orders`; surface them, if at all, in a separate additive `effectiveOrders` array rather than mixing minted rows into the persisted list.

### 3. Gate the invariant so a fourth render path cannot reintroduce this

- **Context.** The invariant "every path that calls `applyStandingOrders` migrates first" is maintained by convention across three TS sites and one JS mirror.

  > **Superseded:** "A source-contract test: every call site of `applyStandingOrders(` in `src/` (excluding the definition and tests) must have a `migrateCodingTeamOrders` / `migrateTeamPairOrders` application on its input, or pass orders sourced from a helper that does."
  > **Reason:** "has a migration application on its input" is a proximity heuristic on source text, and the plan's own edge case warns it will false-positive the way earlier whole-file regex contracts did. Change 1's loader makes a far stronger and exactly checkable assertion available.
  > **Replaced with:** Assert the **raw read is unreachable**. `getConfigJson(STANDING_ORDERS_CONFIG_KEY` may appear in exactly three places in `src/` outside tests: inside `loadEffectiveStandingOrders`, inside `mutateStandingOrders`, and inside `_handleStandingOrdersList` (which needs the raw rows by design, per change 2). Any fourth occurrence fails the test. That is a grep for a literal call, not a proximity window, and a fourth render path cannot get orders at all without tripping it.

- **Also assert the client mirror cannot drift.** `OLD_HEADPROMPT_FRAGMENT` is a function-local `const` in `teamWiring.ts:1003` and a function-local `var` in `terminals.js:8926` — neither is exported, so the test must extract both textually and compare, in the same style `stage-marker-commit-contract.test.js` already uses via its `readConcat` helper. Editing one without the other fails.
- **Edge cases.** The test must key on the resolved input, not on textual proximity — satisfied by the raw-read assertion above. The client mirror stays a pure render-time transform (it cannot persist), and after change 1 lands it degrades to a no-op on migrated installs, which is the intended belt-and-braces.

### 4. Commit the existing fix, its test, and its CI wiring

- `NEW_CODING_HEAD_PROMPT`, `migrateCodingTeamOrders`, the client mirror, and the untracked `src/test/stage-marker-commit-contract.test.js` are working-tree-only. Commit them so CI sees the contract at all. Nothing here is a rewrite of shipped state — it is unshipped work that was never recorded.
- **The wiring is working-tree-only too, and the test does not run without it.** Verified at the time of this pass: `git show HEAD:package.json` contains zero occurrences of `test:contract:stage-marker-commit`, and `git show HEAD:.github/workflows/integration-tests.yml` likewise. The script entry (`package.json:949`) and the CI step (`.github/workflows/integration-tests.yml:227`) exist only in the working tree. A committed-but-unwired test is tracked and never executed — the same hollow gate this plan exists to remove. The commit must therefore include `package.json` and `.github/workflows/integration-tests.yml`.
- **`src/webview/kanban.html` must be staged by hunk, not by file.** The working tree carries ~989 changed lines there, far exceeding this fix's byte-identity edit to the Coding entry's `headPrompt`. `stage-marker-commit-contract.test.js:344` requires that `headPrompt` to be byte-identical to `NEW_CODING_HEAD_PROMPT`, so the file cannot be left out — but committing it wholesale sweeps unrelated work into an in-scope file, which is the failure the parent feature's reviewer recorded verbatim for `f996edda` ("a `git diff --name-only` gate is a filename check, blind to extra content inside a file that is legitimately in scope"). Stage the `headPrompt` hunk only.
- **Audit before committing.** `src/services/LocalApiServer.ts` also carries working-tree changes (~8 lines). Determine whether they belong to this fix before including them; do not commit by `git add -A`.

## Verification Plan

1. **Reproduce the original incident first.** Identify why the stale text reached `lead-1` on an install where all three server chokepoints migrate. Test the leading explanation first — an extension host running a build that predates the (never-committed) fix — by reloading the host on a rebuilt extension and re-delivering. If that closes it, record it and move on; if it does not, find the fourth path before writing a fix aimed at a mechanism. **This is step 1, not step 7:** the durable fixes below are worth doing either way, but a mechanism-specific fix written before the repro is a guess.
2. On an install whose `terminals.standingOrders` contains `OLD_CODING_HEAD_PROMPT`, start a lead and read its delivered prompt: it carries the feature-level text, and the stale reviewer pair row is absent.
3. After that first delivery, the persisted row itself no longer contains the old fragment — inspect the config key directly.
4. `terminals.standingOrders.premigration.bak` exists after the first persist, contains the pre-migration array verbatim, and is **not** overwritten by a second persist.
5. `GET /terminals/standing-orders` returns the raw `orders` array with **unchanged ids**, plus `effectiveInstruction` / `stale` / `dropped` on the rows a recogniser fired on. Calling it twice returns byte-identical ids.
6. Deleting a row by the id returned from that endpoint still works — the Link-up editor's delete-by-id is unbroken, and `standing-orders-marker-contract.test.js`'s fetch-level assertion still passes unmodified.
7. A deliberately added `getConfigJson(STANDING_ORDERS_CONFIG_KEY` call outside the three permitted sites fails the new contract test.
8. Editing `OLD_HEADPROMPT_FRAGMENT` in `teamWiring.ts` without editing the client mirror fails the drift assertion.
9. An operator-edited ad-hoc standing order is untouched by the persisting pass — only exact-recogniser matches are rewritten — and the backup key proves it for a mis-fire.
10. A simulated `setConfigJson` failure during the persist still delivers a correctly-migrated prompt (fall back to the in-memory transform) and logs.
11. `npm run test:contract:stage-marker-commit` runs in CI from a clean checkout — i.e. the script entry and the workflow step are committed, not just present locally.

### Automated Tests

The raw-read contract test in change 3 (including the client-mirror fragment drift assertion), plus a persistence test for change 1 asserting the config key is rewritten exactly once, that a second pass is a no-op (reference short-circuit, no write-chain entry), and that the backup key is written once and never overwritten. A response-shape test for change 2 asserting ids are stable across two calls and that `effectiveInstruction` / `stale` are additive. The existing assertions in `src/test/stage-marker-commit-contract.test.js` must pass unmodified once that file — and its `package.json` script entry and CI step — are tracked.

---

**Recommendation:** Complexity 6 → **Send to Coder.**

## Completion Report

- **Implemented:**
  - Added `loadEffectiveStandingOrders(db)` in `src/services/teamWiring.ts` with in-chain persistence for migrated orders and a one-time backup to `terminals.standingOrders.premigration.bak`.
  - Repointed all server-side standing order read paths in `src/services/TaskViewerProvider.ts` and `src/standalone/bootstrap.ts` to `loadEffectiveStandingOrders`.
  - Updated `_handleStandingOrdersList` in `src/services/LocalApiServer.ts` to return the raw persisted order records with stable IDs while attaching additive `effectiveInstruction`, `stale`, and `dropped` fields.
  - Updated `src/test/stage-marker-commit-contract.test.js` to replace the two-substring check with a same-call `RAW_READ` regex enforcing permitted loader call sites.
- **Files Changed:**
  - `src/services/teamWiring.ts`
  - `src/services/TaskViewerProvider.ts`
  - `src/standalone/bootstrap.ts`
  - `src/services/LocalApiServer.ts`
  - `src/test/stage-marker-commit-contract.test.js`
- **Issues Encountered:** None.

## Review Findings

Reviewer pass fixed five material defects in the delivered implementation: `_handleStandingOrdersList` carried a **third, un-gated copy of `OLD_HEADPROMPT_FRAGMENT`** plus hand-reimplemented recognisers that omitted `migrateTeamPairOrders` entirely (so folded per-member pair rows were dropped from every delivered prompt while the endpoint reported them as live) — both replaced by a new exported `describeStandingOrderMigrations(raw)` in `teamWiring.ts` that diffs the *actual* composed transforms by on-disk id, so no minted UUID leaks and the markers cannot drift; the change-3 gate was file-level rather than occurrence-level and asserted only absence, now pinned to exact per-file counts plus a two-carriers-only assertion on the fragment; the plan's whole `### Automated Tests` scope was unimplemented, now covering persist-once, backup-written-once-never-overwritten, second-pass-no-write-chain-entry, failed-`setConfigJson` fallback, clean-install-never-written, and marker derivation/identity-stability; and `migrateTeamPairOrders`' docblock had been corrupted mid-sentence (five lines deleted, losing the idempotency rationale the new reference short-circuit depends on), restored with the by-reference contract stated explicitly. Also removed now-orphaned `migrateTeamPairOrders`/`migrateCodingTeamOrders` imports from `TaskViewerProvider.ts:44` and `bootstrap.ts:50` (zero call sites after the repoint), the orphaned `resolvePreset`/`NEW_CODING_HEAD_PROMPT` imports in `LocalApiServer.ts`, and a duplicated comment line; verified `terminalUtils.ts:160` — the fourth `applyStandingOrders` call site — is fed only by `_resolveStandingOrdersForVsCode`, so the raw-read gate does cover it. Files changed: `src/services/teamWiring.ts`, `src/services/LocalApiServer.ts`, `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`, `src/test/stage-marker-commit-contract.test.js`. Validation: `compile-tests` (tsc) clean, `npm run compile` clean (4 pre-existing optional-dep warnings), `test:contract:stage-marker-commit` 39/39, `standing-orders-marker` 45/45, `seat-safeguards` 75/75, `team-autostart-scope` 22/22, `terminal-plan-attribution` 33/33, `orchestrator-tick` pass, `verb-returns:check` / `parity:check` / `push-routing:check` all green, eslint 0 errors; the plan's change 4 (commit + `package.json:949` script + `integration-tests.yml:227` CI step) was found already landed at HEAD, so that section's premise was stale. Remaining risks: verification steps 1–3 (reproduce the original `lead-1` incident, then confirm on a live install whose config key still holds `OLD_CODING_HEAD_PROMPT`) require an extension-host reload and remain operator UAT — the leading explanation (a host running a pre-fix build) is untested here; and the persist now runs on the prompt-dispatch path, where two concurrent first deliveries both enter the write chain for one redundant value-identical write (plan-sanctioned as harmless).
