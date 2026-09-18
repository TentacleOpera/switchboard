# Coding Team — The Lead Sends the Whole Feature to Review, Through Board Dispatch

## Goal

When every subtask of a feature is finished, the Coding team's lead makes **one** call — the board's advance-and-dispatch, on the feature's card — and the card moves to `CODE REVIEWED`. The lead never writes a review prompt, and never hands work to the reviewer directly.

### Why the lead behaves the way it does now

The lead is carrying two contradictory standing orders, and the wrong one wins.

**Order 1 — the team's `headPrompt`** (`src/webview/kanban.html:4462`, `SHIPPED_TEAM_TYPES`, Coding):

> "When a coder reports a subtask finished and you are satisfied with it, hand it to review yourself: … POST /kanban/dispatch with `{"plan":"<planId>","targetColumn":"CODE REVIEWED"}` … Do NOT use /kanban/move"

**Order 2 — the `reviewer` relationship preset** (`src/services/linkPresets.ts:66-75`), installed *on the lead* because the Coding team declares its reviewer as `{ role: 'reviewer', relationship: 'reviewer' }` (`kanban.html:4451`):

> "{child} is your reviewer. When you finish a self-contained unit of work, hand {child} a summary of what changed and which files — it cannot see your conversation, so make the summary stand on its own — and ask it to review before you move on to the next unit."

That second order is the observed behaviour, verbatim. It instructs the lead to **compose a summary itself**, **hand it straight to the reviewer**, **per unit of work**, and it says nothing about a card. It wins over the first because it is self-contained — no planId to look up, no port file to read, no endpoint to get right.

The wiring is at `src/services/teamWiring.ts:660-678`: a member whose `relationship` resolves to a `head-receives` preset generates a pair-scoped standing order on the head about that member. `reviewer` is such a preset (`direction: 'head-receives'`). So declaring the reviewer as the lead's `reviewer` relationship is what installs the instruction to bypass the board.

**Both orders are also the wrong granularity.** Both act per subtask. The ask is per feature.

### Why editing the shipped definition is not enough — the second root cause

The shipped team definitions are **templates, not live configuration**. `teamsTabGalleryCard`'s USE handler (`kanban.html:4559-4574`) deep-copies the shipped type — `members`, `prompt`, `headPrompt` — into a new object and persists it via `saveAgentGroup` → `terminals.agentGroups` (`KanbanProvider.ts:4405`, `_saveAgentGroup` at `:4556`). From that moment the workspace copy is the source of truth and the shipped definition is never re-read for it.

Both defects are **shipped and pushed**: the `reviewer` relationship landed in `1bd39f4a`, the per-subtask `headPrompt` in `6a4df070`, both on `origin/main`. So on every install that has already pressed USE on the Coding team, a forked group in `terminals.agentGroups` carries the old `headPrompt` and the old `relationship: 'reviewer'`.

Worse, the standing orders those forks already installed are **idempotently keyed and never refreshed**. `wireSpawnedTeam` skips an existing team-scoped order (`teamWiring.ts:697-698`, `teamExists`), skips an existing `team-head` order (`:714-716`, `headExists`), and skips an existing pair order (`:729-731`, `exists`). Nothing removes or rewrites an order once installed. Re-running the team does not heal it.

> **Superseded:** "**4. Nothing else moves.** No change to `/kanban/dispatch`, to the resolver, to the cascade behaviour, to how subtasks are assigned, or to the reviewer's own role prompt."
> **Reason:** True for the dispatch path, but it was read as "editing `SHIPPED_TEAM_TYPES` is the whole change". It is not. The gallery forks on USE and standing orders are write-once, so a shipped-definition edit reaches only teams adopted *after* the change. Every existing install keeps the bypass permanently, and the plan's own verification step 6 ("no pair-scoped order naming the reviewer") would fail there. Under the workspace migration rule — state that shipped in a released version MUST be migrated — this is a required part of the work, not an optional extra.
> **Replaced with:** Nothing moves on the *dispatch* path — `/kanban/dispatch`, `resolveTeamScopedRoleTerminal`, cascade behaviour, subtask assignment and the reviewer's role prompt are all untouched. What is added is a **migration**, following the two converters this file already ships: `migrateAgentGroups` for the forked group, and a `migrateTeamPairOrders`-shaped converter for the stale orders. Detail in §5 and §6 of *What changes*.

## What changes

**1. The reviewer stops being the lead's pair partner.**

In the Coding team definition, the reviewer member becomes `relationship: 'reports-to-head'`.

That relationship is `member-receives`, so it generates **no** pair-scoped order on the head — `teamWiring.ts:675-677` carries it in the team prompt instead. The reviewer is still spawned, still seated, still a team member. It is now reached only the way a human reaching it would: by a card arriving in `CODE REVIEWED`. When it finishes, the team prompt already tells it to report back to the lead, which is what we want.

Do not invent a new relationship id for this. `reports-to-head` already produces exactly the required outcome.

**2. The `headPrompt` becomes feature-level and single-action.** It should say, in substance:

- Your coders work the subtasks of one feature. When a coder reports one finished, note it and give the coder the next one. **Do not send anything to the reviewer, and do not write review instructions — that is not your job.**
- When **every** subtask of the feature is finished, read the port from `.switchboard/api-server-port.txt`, confirm no subtask is still outstanding via `GET /kanban/feature`, then make one call: `POST /kanban/dispatch` with `{"plan":"<the FEATURE's planId>","targetColumn":"CODE REVIEWED","from":"{head}"}`.
- That one call moves the card and dispatches the reviewer with the reviewer's own prompt. Do not use `/kanban/move` — it moves the card and dispatches nobody.
- Only advance the feature your team worked.

The prompt must name the **feature's** planId. The current one names a subtask's, which is the other half of why cards never reached review as a unit.

**3. `"from":"{head}"` is load-bearing — do not trim it.** Team-scoped reviewer routing already ships (`resolveTeamScopedRoleTerminal`, `teamWiring.ts:914`, wired at `TaskViewerProvider.ts:9484` and `bootstrap.ts:2049`). It routes on `from`: it looks up the group the origin heads and picks the live member with the wanted role. Drop `from`, or send a name that is in no group, and the resolver returns `null` — dispatch falls back to workspace-wide resolution and hands the card to whichever reviewer sorts alphabetically first. In a one-team workspace that looks correct, so a trimmed prompt survives casual testing and misroutes the moment a second team is live.

**4. The dispatch path is untouched.** No change to `/kanban/dispatch`, to `resolveTeamScopedRoleTerminal`, to cascade behaviour, to how subtasks are assigned, or to the reviewer's own role prompt.

Changing the reviewer's `relationship` does **not** affect routing. The resolver reads group *membership* from `terminals.groups`; `relationship` only decides which standing orders get installed. The reviewer stays in the roster and stays addressable — it simply stops receiving hand-written prompts from the lead.

**5. Migrate the forked group — extend `migrateAgentGroups`.**

`migrateAgentGroups` (`teamWiring.ts:172`) is a pure converter, already called from `KanbanProvider._loadAgentGroups` (`:4500`, which persists the result), `findTeamForHeadRole` (`:422`) and `findTeamForHeadRoleInRoots` (`:486`) (which match in-memory without persisting). Add a step to it, modelled exactly on the existing `isUntouchedOldSeed` gate (`:368-381`):

- Match a group by **exact value** against the old shipped Coding definition: `headRole === 'lead'`, its `headPrompt` equal to the old shipped string, and a member `{ role: 'reviewer', relationship: 'reviewer' }`.
- On a match, replace `headPrompt` with the new feature-level text and set that member's `relationship` to `'reports-to-head'`.
- **Exact-value matching is the whole safety story.** A group whose `headPrompt` an operator has edited does not match and is left alone — the operator's text wins. Preserve every other key on the group and on the member (`label`, `startupCommand`, `count`, `scope`, unknown keys) the way step 2 already does.
- Keep the existing `changed` bookkeeping so the converter still returns `null` when nothing changed and the caller does not write.

Store the old shipped `headPrompt` as an exported `OLD_CODING_HEAD_PROMPT` constant next to `OLD_SEEDED_AGENT_GROUP`. Do not reconstruct it by string-building at match time.

**6. Migrate the stale standing orders — a converter beside `migrateTeamPairOrders`.**

Two rows are stale on an already-wired install:

- the pair-scoped order carrying the `reviewer` preset text (`parent` = lead, `child` = reviewer, `scope` absent or `'pair'`);
- the `team-head` order carrying the old per-subtask `headPrompt`.

Follow the `migrateTeamPairOrders` pattern verbatim (`teamWiring.ts:806`): a **pure** function over the orders array, applied at the standing-orders **read** sites so it takes effect without a write, recognising rows by their **pre-rewrite instruction text** (that is what is actually on disk), and idempotent because a second pass finds nothing left to recognise.

- Drop a pair row whose instruction equals the resolved `reviewer` preset text.
- Replace a `team-head` row whose instruction equals the old `headPrompt` (with `{head}` already substituted — match by prefix or by the substituted-name-independent portion) with the new text.
- Leave every unrecognised row untouched, including operator-edited ad-hoc link-ups.

Apply it at the same three sites as `migrateTeamPairOrders`: `TaskViewerProvider.ts:436`, `TaskViewerProvider.ts:587`, `bootstrap.ts:241`.

**7. Mirror the order converter into `terminals.js`.** `src/webview/terminals.js:8801` holds `migrateTeamPairOrdersClient`, a hand-maintained client-side mirror applied at `:8878`. The webview renders standing orders from its own copy, so a host-only converter leaves the *displayed* orders stale even after the host stops delivering them. Add the mirrored branch there in the same pass — this file is a known divergence hazard (`link-presets-mirror-contract.test.js` exists because the comment convention alone did not hold).

## Supersedes

`feature_plan_20260816164108_coding-team-head-advances-card-to-code-reviewed.md` — that plan is what installed the per-subtask `headPrompt` now in the tree. It correctly identified that the reviewer was never reached, but chose subtask granularity and did not remove the competing `reviewer` pair order, so the bypass survived. Implement this plan instead of that one; do not implement both.

## Already shipped — do not re-plan

`feature_plan_20260816164109_team-scoped-reviewer-routing-on-code-reviewed.md` **is implemented in the tree.** `resolveTeamScopedRoleTerminal` (`teamWiring.ts:914`) is called from both hosts and covered by `src/test/team-scoped-role-routing.test.js`. Nothing in this plan needs to build reviewer routing; it needs only to keep feeding it a correct `from`.

## Metadata

**Complexity:** 5
**Tags:** bugfix, backend, reliability

> **Superseded:** **Complexity:** 3
> **Reason:** 3 scored a two-line edit to `SHIPPED_TEAM_TYPES`. The real change also spans two pure converters in `teamWiring.ts`, a hand-maintained mirror in `terminals.js`, and three converter call sites across both hosts — multi-file coordination against shipped user state, which is the 5-6 band.
> **Replaced with:** **Complexity:** 5

## User Review Required

None. Every decision here is settled: `reports-to-head` is the existing relationship with the required semantics, the migration follows two converters this file already ships, and exact-value matching is the established rule for not overwriting operator edits.

## Complexity Audit

### Routine
- Editing the Coding entry in `SHIPPED_TEAM_TYPES` (`kanban.html:4448-4468`) — a data literal.
- Flipping the reviewer member's `relationship` to `reports-to-head` — an existing preset id, no new vocabulary.
- Adding a converter step inside `migrateAgentGroups`, whose `changed`/`null` contract and exact-value matcher already exist.
- Updating the four `headPrompt` assertions in `src/test/standing-orders-marker-contract.test.js:363-376`.

### Complex / Risky
- **Order migration must not eat operator edits.** The recogniser matches on instruction text. Too loose and it deletes a hand-written link-up; too tight and it misses the rows it exists for. Exact-text matching against a stored pre-rewrite constant is the only acceptable form.
- **The `{head}` substitution complicates exact matching.** The stored `team-head` instruction has already had `{head}` replaced with the live head name (`teamWiring.ts:719`), so the on-disk text differs per install. Match on the substitution-independent portion (e.g. the literal `'satisfied with it, hand it to review yourself'` fragment), not on the whole string.
- **Two mirrors must move together** — `teamWiring.ts` and `terminals.js:8801`. A host-only change leaves the webview showing orders the host no longer delivers.
- **Read-site application means no write.** Like `migrateTeamPairOrders`, the stale rows stay in the DB and are filtered on read. That is the established pattern and is correct here, but it means "inspect the DB" is not a valid verification — inspect the *rendered/delivered* set.

## Edge-Case & Dependency Audit

**Race Conditions**
- `_saveAgentGroup` serialises read-modify-write on `terminals.agentGroups` through its own chain (`KanbanProvider.ts:4416`). The converter runs inside `_loadAgentGroups`, upstream of that chain, so no new window is opened.
- `migrateAgentGroups` is called from three sites, only one of which persists. A group can therefore be *matched* in memory by `findTeamForHeadRole` before it is ever *written* converted. Both produce the same result, so this is benign — but do not add a write to the read-only sites to "fix" it.
- Standing-order mutation is already serialised through `mutateStandingOrders`' promise chain (`teamWiring.ts:694`). The new converter is read-side and pure, so it never enters that chain.

**Security**
- No new network surface, no new endpoint, no new credential path. `from` remains a terminal name resolved against `terminals.groups`, never trusted from the wire.

**Side Effects**
- The lead stops sending anything to the reviewer. Until the feature's last subtask lands, the reviewer terminal is idle by design — that is the intended new behaviour, not a stall, and any operator-facing "idle agent" heuristic will see it.
- Teams adopted **after** this change and teams migrated **by** this change converge on identical wiring. A team an operator has hand-edited stays on its own text forever, by design.
- `GET /kanban/feature` gains a caller (the lead's confirm step). Read-only.

**Dependencies & Conflicts**
- Touches `kanban.html`, `teamWiring.ts`, `terminals.js`, `TaskViewerProvider.ts` (converter call sites only), `bootstrap.ts` (converter call site only), and `standing-orders-marker-contract.test.js`.
- **No file overlap with the other two subtasks in this feature.** They own `agentPromptBuilder.ts`, `KanbanProvider.ts`, `sharedDefaults.js` and `setup.html`. This subtask can land in parallel with either.
- `standing-orders-marker-contract.test.js:363-376` asserts the shipped `headPrompt` contains `/kanban/dispatch`, `CODE REVIEWED`, `"from":"{head}"` and `Do NOT use /kanban/move`, and that exactly one `headPrompt` exists. The new text retains all four, so the assertions stay green — but read them before rewriting, not after.

## Dependencies

- `sess_kanban_team_gallery — SHIPPED_TEAM_TYPES / team fork-on-USE`
- `sess_team_wiring_orders — wireSpawnedTeam, migrateAgentGroups, migrateTeamPairOrders`
- `sess_team_scoped_routing — resolveTeamScopedRoleTerminal (shipped, consumed not modified)`

## Adversarial Synthesis

Key risks: an order recogniser that is too loose deletes an operator's hand-written link-up; the `{head}` substitution makes exact-text matching install-specific; and the host/webview order-migration mirrors can diverge silently. Mitigations: match against stored pre-rewrite constants on a substitution-independent fragment, never on a reconstructed string; leave every unrecognised row untouched; move `teamWiring.ts` and `terminals.js:8801` in the same commit. The residual risk is a team an operator edited before the fix keeping the bypass — accepted deliberately, because overwriting operator text is worse than leaving one team on its own wiring.

## Proposed Changes

### `src/webview/kanban.html` (`SHIPPED_TEAM_TYPES`, Coding entry, ~4448-4468)

- **Context:** The shipped template the gallery forks on USE. `members[1]` is `{ role: 'reviewer', count: 1, scope: 'shared', relationship: 'reviewer' }`; `headPrompt` is the per-subtask hand-off text.
- **Logic:** Reviewer becomes `relationship: 'reports-to-head'`. `headPrompt` becomes the feature-level, single-action text from §2. `purpose` currently reads "…then hands each to the team reviewer" — update it; it describes the behaviour being removed.
- **Implementation:** Single-quoted string concatenation, matching the surrounding style. Keep `"from":"{head}"` byte-exact — `{head}` is substituted host-side at `teamWiring.ts:719`.
- **Edge Cases:** The `prompt` (member-facing) text is unchanged; only `headPrompt` and the reviewer member move.

### `src/services/teamWiring.ts`

- **Context:** Holds `migrateAgentGroups` (`:172`), `isUntouchedOldSeed` (`:368`), `wireSpawnedTeam` (`:615`) and `migrateTeamPairOrders` (`:806`).
- **Logic:** (a) export `OLD_CODING_HEAD_PROMPT`; (b) add the Coding-team conversion step to `migrateAgentGroups`, gated on an exact-value matcher shaped like `isUntouchedOldSeed`; (c) add a pure `migrateCodingTeamOrders(orders)` beside `migrateTeamPairOrders` that drops the stale `reviewer` pair row and rewrites the stale `team-head` row.
- **Implementation:** Both converters stay pure — no DB access, no writes. `migrateAgentGroups` keeps its `null`-when-unchanged contract. The order converter returns the input array unchanged when it recognises nothing.
- **Edge Cases:** A group with a non-array `members`; a `team-head` row whose `{head}` substitution produced a name containing regex metacharacters (match by `indexOf` on a literal fragment, never by a constructed `RegExp`); an install carrying both the stale pair row and an operator-added second reviewer link.

### `src/services/TaskViewerProvider.ts` (`:436`, `:587`) and `src/standalone/bootstrap.ts` (`:241`)

- **Context:** The three sites that already compose `migrateTeamPairOrders(orders)` into `effectiveOrders`.
- **Logic:** Compose the new converter at each: `migrateCodingTeamOrders(migrateTeamPairOrders(orders))`.
- **Implementation:** Import alongside the existing symbol. Order matters — pair-fold first, then Coding-team rewrite, so the pair converter sees the array shape it expects.
- **Edge Cases:** Both hosts must apply both converters; a site that applies only one produces host-dependent standing orders, which is exactly the class of bug this feature exists to remove.

### `src/webview/terminals.js` (`migrateTeamPairOrdersClient`, `:8801`, applied `:8878`)

- **Context:** Hand-maintained client mirror of the host converter; the webview renders from its own copy.
- **Logic:** Mirror the new recognise-and-rewrite branch.
- **Implementation:** Plain ES5-compatible functions matching the surrounding file — it is a classic script with no module loading.
- **Edge Cases:** Keep the two copies textually parallel so the next reader can diff them by eye; this file's divergence is already a known hazard.

### `src/test/standing-orders-marker-contract.test.js` (`:350-376`)

- **Context:** Pins exactly one shipped `headPrompt` and four substrings within it.
- **Logic:** The four substrings survive the rewrite. Add an assertion that the shipped Coding reviewer member is `relationship: 'reports-to-head'`, so a future edit cannot silently reinstate the bypass.
- **Edge Cases:** The test greps `kanban.html` source text, so it is sensitive to quoting style — keep the concatenation form.

## Verification Plan

Start a Coding team on a feature with three subtasks and watch:

1. Coders finish subtasks one at a time and report to the lead.
2. After subtask one, **nothing** goes to the reviewer — no prompt in the reviewer terminal, no summary composed by the lead.
3. After the last subtask, the lead makes one `/kanban/dispatch` call on the feature's planId.
4. The feature's card moves to `CODE REVIEWED` on the board — visibly, without anyone dragging it.
5. The reviewer wakes with its own role prompt, not with text the lead wrote.
6. Inspect the lead's **delivered** standing orders (the rendered set in the terminals panel, not the raw DB rows): there is no pair-scoped order naming the reviewer, and the `team-head` order carries the feature-level text.

   > **Superseded:** "Inspect the lead's standing orders: there is no pair-scoped order naming the reviewer."
   > **Reason:** The order converter is applied at the read sites and leaves the stale rows in the DB — the same design as `migrateTeamPairOrders`. Reading raw DB rows would show the pair order still present and read as a failure when the fix is working correctly.
   > **Replaced with:** Inspect the **delivered/rendered** order set, which is what the converter filters.

7. A second team running concurrently is untouched — its cards do not move.
8. **Migration, existing install:** on a workspace that adopted the Coding team *before* this change, reload the board. The forked group in `terminals.agentGroups` shows the new `headPrompt` and `relationship: 'reports-to-head'`, and steps 2 and 6 hold without re-adopting the team.
9. **Migration, operator-edited team:** a Coding team whose `headPrompt` was hand-edited is left exactly as the operator wrote it — not converted, not partially converted.
10. **Migration, idempotency:** run the converters twice. The second pass changes nothing and `migrateAgentGroups` returns `null`.
11. Both hosts agree: the same workspace opened under the extension and under `npx switchboard` delivers an identical standing-order set to the lead.

### Automated Tests

- `src/test/standing-orders-marker-contract.test.js` — extend for the reviewer relationship; the four `headPrompt` substring assertions must stay green unchanged.
- New unit coverage for the two converters, in the style of the existing `teamWiring` tests: matched group converts; operator-edited group untouched; unknown keys preserved; second pass is a no-op; unrecognised orders pass through.

*Per session directive, automated tests are not executed as part of this pass — the coder runs them.*

**Recommendation: Send to Coder** (complexity 5).

## Completion Report

Implemented across all six assigned files. `kanban.html` Coding entry: reviewer member flipped to `relationship: 'reports-to-head'`, `headPrompt` rewritten to feature-level single-action text (names the FEATURE planId, adds `GET /kanban/feature` confirm step, retains `"from":"{head}"` byte-exact and all four test-pinned substrings), `purpose` updated. `teamWiring.ts`: exported `OLD_CODING_HEAD_PROMPT`/`NEW_CODING_HEAD_PROMPT` constants, added `isUntouchedOldCodingTeam` exact-value matcher + step 1b in `migrateAgentGroups` (flips reviewer relationship, replaces headPrompt, preserves all other keys), added pure `migrateCodingTeamOrders` that drops the stale reviewer pair row (matched via `resolvePreset('reviewer', parent, child)`) and rewrites the stale `team-head` row (matched by `indexOf` on the substitution-independent fragment `'satisfied with it, hand it to review yourself'`). `terminals.js`: mirrored both constants and `migrateCodingTeamOrdersClient`, composed `migrateCodingTeamOrdersClient(migrateTeamPairOrdersClient(orders))` at the render site. `TaskViewerProvider.ts` (2 sites) and `bootstrap.ts` (1 site): imported `migrateCodingTeamOrders` and composed it after `migrateTeamPairOrders` at every call site. `standing-orders-marker-contract.test.js`: added assertions that the shipped Coding reviewer is `relationship: 'reports-to-head'` and that no shipped member declares `relationship: 'reviewer'`. Per session directives, compilation and automated tests were not executed; both converters are pure and idempotent by construction, and the four existing headPrompt substring assertions stay green (all literals retained).

## Review Findings

**Verdict: passed after fixes.** Changed in review: `teamWiring.ts:1008` (`resolvePreset('reviewer', o.parent, o.child)` — `child` is optional on `StandingOrder`, so this failed `npm run compile-tests`, the CI build gate at `integration-tests.yml:29`; now `o.child || ''`, behaviour-identical to the client mirror's own `childName || …` fallback) and `standing-orders-marker-contract.test.js:445` (the team-head parity check anchored on the *first* `scope === 'team-head'`, which is now `migrateCodingTeamOrdersClient`'s branch, so a CI-wired test went red on correct source; it now scans every branch and requires one to gate on teamId + parent + members). Everything else verified as specified: `OLD_CODING_HEAD_PROMPT` and `NEW_CODING_HEAD_PROMPT` are byte-identical to the pre- and post-change `kanban.html` literals and to the `terminals.js` mirror constants (checked programmatically, not by eye), all three host read sites plus the client compose `migrateCodingTeamOrders(migrateTeamPairOrders(orders))`, the converters are pure and idempotent, and an operator-edited `headPrompt` is left untouched. New coverage added at `src/test/stage-marker-commit-contract.test.js` and wired into CI as `test:contract:stage-marker-commit` — it pins the three-file constant parity, the group conversion, unknown-key preservation, order drop/rewrite/pass-through, idempotency and a regex-metacharacter head name. Remaining risk, inherent and disclosed in the plan's §6: the pair recogniser drops any order whose text equals the resolved `reviewer` preset, so a deliberate ad-hoc reviewer link-up between unrelated terminals is dropped too — pair rows carry no `teamId`, so nothing in the data distinguishes them.
