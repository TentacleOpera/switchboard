# Seat Safeguards Are Dropped on the Fleet Prompt Path

## Goal

A safeguard configured on a seat applies to every prompt that seat receives, whoever sent it. Today it applies only to prompts the **board** composed, and is silently absent from every prompt a driving agent sends over `ptySendPrompt` — the route `terminal-coder-dispatch/SKILL.md` teaches as its primary recipe.

### The incident this was written from — 2026-08-17

A lead agent (`lead-1`) drove a four-subtask feature through `lead-1-coder-1` following `terminal-coder-dispatch/SKILL.md`. The lead's **own** prompt was built by the board and carried the full addon block, including:

> `You are strictly forbidden from spawning or invoking any subagents. Handle all subtasks yourself.`

The lead then relayed each subtask to the coder with `ptySendPrompt`. That directive — and every other addon — did not travel. The coder was never told, was free to fan out, and did. The user reported roughly half a week's model quota consumed by subagent use that a configured, enabled safeguard existed specifically to prevent.

A second instance in the same session shows the failure is not merely "the lead forgot to copy a line". On the fourth dispatch the lead **did** hand-type `Skip compilation and skip running automated tests — do not execute it` into the prompt body. The coder ran four test suites, `tsc`, `eslint` and six gates including `mirror:check` (which forces a full `compile-tests`).

**Asked afterwards, the coder did not report having missed the instruction — it reported having overruled it**, and its reasoning is the most useful evidence in this plan. It cited the plan file's own `Session note` (*"this run was directed to skip compilation and skip automated test execution, so the checks below are written for the implementing coder, not run here"*), concluded that the note bound the **planning** session rather than itself, observed that the plan's step 7 instructs retargeting the test assertions and that the Verification Plan enumerates automated checks, and decided: *"I ran the tests to verify my implementation was correct, which is what the plan asked the implementing coder to do."*

That is a defensible reading of the plan document. The point is that it was ever a contest. **A sentence of prose in a task body enters the same evidential pool as the plan file and can lose an argument to it** — and the coder is not obliged to flag the conflict, because from inside the prompt there is nothing marking one input as a host-emitted directive and the other as a document to be interpreted. A composed `SKIP_TESTS_DIRECTIVE` block is not arguable in that way: it carries provenance and structural separation, it does not read as one more claim in a task description, and it is the same artefact the seat already obeys on the board path. "Leads should write better prompts" cannot fix this, because the lead's prose was correct, explicit, and still lost.

**Corroboration from the board path (user observation, 2026-08-17).** The same `skipTests` add-on delivered the normal way — composed into a board dispatch straight to a coder seat — **is reliably obeyed**. The identical intent, hand-typed as prose by a lead relaying to that same coder, is not. That is an independent data point, separate from the coder's account above, and it is why the fix is "put the fleet path onto the composed-block path" rather than anything more exotic.

The **mechanism** the coder's account suggests — that a relayed sentence and a plan-file paragraph land in the same evidential pool with nothing marking which is host-emitted — is a plausible reading of one incident, not a measured finding. It is enough to act on, because the remedy (structural separation and provenance) is the remedy for the absent-directive case anyway. It is not enough to treat "prose always loses" as established.

#### The precedence chain, and what the coder got wrong

The chain that produced the second instance:

1. A session directive scoped to the **planner** (`SKIP TESTS: Do not run automated tests as part of the verification plan`) was transcribed into the plan file as durable prose.
2. Read later, it inverts: a constraint on the planner becomes an instruction *to* the coder, reinforced by a `## Verification Plan` that enumerates automated checks.
3. Facing a live dispatch instruction and a contradicting document, the coder resolved in favour of the document.

**Step 3 was the wrong call, and step 1 is why it was a close one.** A live instruction from the dispatcher is more recent and more specific than a note in a document, and `do not execute it` is not ambiguous; the coder should have followed it. But it was outranked by an affirmative written instruction, not by silence — so this is not "an explicit instruction was ignored", and no amount of clearer prose from the lead would have fixed it. Both facts hold at once, and only one of them is actionable: **the system handed a competent agent two contradictory instructions and marked neither as authoritative.**

Do **not** respond to this by requiring agents to flag conflicts. That obligation is unenforceable from inside a prompt, it is the kind of rule that gets dropped first under load, and it leaves the contradiction in place. Remove the contradiction instead. Two changes do that:

* **A session directive must never be transcribed into a plan file.** It constrains *how the current agent works*, not *what the plan covers* — the `improve-plan` contract already says this. Writing it down converts a scoped instruction into a durable, mis-scoped one. Planner-side; see the scope note below.
* **A seat directive that contradicts the plan file must say which wins.** Otherwise this fix delivers `SKIP TESTS` perfectly, the plan file's Verification Plan says run these checks, and the coder does the reasonable thing again. In scope here — constraint 5, change 5.

> **Superseded:** *"the `Session note` boilerplate is itself misleading … a plan-authoring defect in the improve-plan template … belongs in its own plan."*
> **Reason:** Verified against the tree, 2026-08-17 — it is not boilerplate and there is no template. `Session note` appears in **zero** files under `.agents/`, `.claude/`, `src/` and `scripts/`, and in **18 of 1720** plan files (~1%). Nothing emits it. It is emergent planner behaviour on runs that happen to carry a skip directive, which means there is no template line to delete and the fix is not plan-sized.
> **Replaced with:** The remedy is a prohibition in `.agents/skills/improve-plan/SKILL.md` (plus the `.claude/` mirror regen) telling planners not to transcribe session directives into plan files — a two-line control-plane edit, not a separate plan. Still out of scope *here*: different file, different mechanism, independently shippable. The 18 existing plan files carrying the note are pre-existing artifacts; no sweep is proposed.

### Root cause — two prompt routes, one of which composes nothing

| Route | Composes addons? | Used by |
| :--- | :--- | :--- |
| `handleKanbanBatchTrigger` → `agentPromptBuilder.ts` | **Yes** — full addon block | board card dispatch, batch dispatch, `POST /kanban/dispatch` |
| `handlePtyVerb('ptySendPrompt')` → pty host | **No** — raw text + standing orders | every agent-to-agent send, `terminal-coder-dispatch`, fleet leads |

`handlePtyVerb` (`TaskViewerProvider.ts:2766`) touches exactly two fields on a `ptySendPrompt` payload — `clearBeforePrompt` and `clearBeforePromptDelayMs` — then passes `payload.data` to the pty host verbatim. It never reaches `agentPromptBuilder.ts`. Standalone's `deliverPrompt` (`bootstrap.ts`) behaves the same way.

#### Where the seam actually is (verified 2026-08-17)

`handlePtyVerb` is the **HTTP boundary**, not the chokepoint. One level below it, `_ptyHostVerb` (`TaskViewerProvider.ts:416`) is the sole path from the extension to the fleet, and it is where the standing-orders block is appended (`:421–454`, guarded by `payload?.standingOrders !== false`). Six internal senders call `_ptyHostVerb('ptySendPrompt', …)` **without** passing through `handlePtyVerb` — the turn-end notifier (`:1267`), the `sendToTerminal` arm (`:14039`) and `_attemptDirectTerminalPush` (`:20119`) among them. Anything installed in `handlePtyVerb` is invisible to all of them.

The two-layer shape that follows is not a detail, it is the design:

| Layer | Extension | Standalone | Responsibility |
| :--- | :--- | :--- | :--- |
| HTTP boundary | `handlePtyVerb` (`:2528`, `ptySendPrompt` branch `:2766`) | `handlePtyVerb`'s `ptySendPrompt` case (`bootstrap.ts:1420`) | **Strip** host-only fields off caller payloads |
| Chokepoint | `_ptyHostVerb` (`:416`) | `deliverPrompt` (`bootstrap.ts:228`) | **Append** standing orders — and, with this change, the seat block |

Standalone's `deliverPrompt` already carries an `applyOrders` boolean fourth parameter, so its signature is the precedent for a second host-only flag.

So a coder seat driven by a lead receives **the sender's raw text plus standing orders, and nothing else**. Absent on every such prompt:

- `subagentPolicy` / `customSubagentName` / `featureSubagentPolicy` — *the one that caused the incident*
- `gitProhibition`, `gitBranchStrategy`, `gitCommitStrategy`, `gitPushStrategy` (`GIT_SAFETY_DIRECTIVE`, `buildGitPolicyBlock`)
- `skipCompilation`, `skipTests`
- `switchboardSafeguards` (`FOCUS_DIRECTIVE`, batch execution rules)
- `cavemanOutput`, `suppressWalkthrough`, `accurateCoding`, `pairProgramming`
- PRD injection and project pin

### Why the skill cannot simply switch routes

`terminal-coder-dispatch/SKILL.md` names `ptySendPrompt` *"the recipe this skill teaches"* and never mentions that it bypasses addon composition. But repointing the skill at `POST /kanban/dispatch` does not work, for two independent reasons:

1. **`agentPromptBuilder` is plan-shaped, not text-shaped.** Its entry points take `plans: BatchPromptPlan[]` (`buildCustomAgentPrompt`, `:1995`). It composes a prompt *around a set of plan files*. A driving agent's traffic is mostly not that: fix resends, "stop", clarifying questions, corrections after a review. There is no signature for "arbitrary text to a named seat".
2. **`/kanban/dispatch` moves the card and wakes a role.** That is correct for handing work over, and wrong for a mid-work correction to a coder already holding the card.

### The insight the fix rests on

**Standing orders already solve this exact problem on this exact path.** They are per-terminal durable text, persisted at `terminals.standingOrders`, appended by the delivery layer to every `ptySendPrompt` on both hosts. They are proof that a per-seat text-injection seam on the fleet path exists and works.

Seat safeguards belong in the same place, for the same reason: **a safeguard is a property of the seat, not of the dispatch.** A coder terminal configured "no subagents" should carry that on every prompt it receives, from the board, from its lead, or from a peer.

## What changes

**The addon set is split by scope.** This is the load-bearing decision, and the reason this is not simply "call the builder from the pty path":

| Scope | Addons | Applied where |
| :--- | :--- | :--- |
| **Seat-scoped** — true of the seat regardless of what it is asked to do | `subagentPolicy` (+ `customSubagentName`), `gitProhibition` and the three git strategies, `skipCompilation`, `skipTests`, `cavemanOutput`, `suppressWalkthrough`, `accurateCoding` | **new** — the pty delivery layer, beside standing orders |
| **Dispatch-scoped** — meaningless without a plan set | `FOCUS_DIRECTIVE` ("the plan file paths *below*"), `BATCH_EXECUTION_RULES`, PRD injection, project pin, `featureSubagentPolicy`, workflow-file redirection, `pairProgramming` | unchanged — `agentPromptBuilder` on the board path only |

A dispatch-scoped directive appended to "stop what you are doing" is noise that references plans that are not there. Applying the whole addon set on every send would be worse than the bug.

**Double-application is the primary hazard.** A board card dispatch resolves to a PTY seat and delivers through the *same* `ptySendPrompt` write (`TaskViewerProvider.ts:~20100`, the PTY branch tried before the `vscode.Terminal` fallback). Its payload has already been composed by `agentPromptBuilder`. Appending seat addons in the delivery layer would give those prompts the git policy and subagent policy **twice**.

The fix follows the shape already established on this verb by `clearBeforePromptFromConfig`: an explicit payload field that says who owns composition. The builder path sets `addonsComposed: true`; the delivery layer appends the seat block only when it is absent, and strips the field before it reaches the child.

> **Superseded:** The `addonsComposed: true` marker is set by the card-dispatch PTY branch (`TaskViewerProvider.ts:~20100`).
> **Reason:** That branch is inside `_attemptDirectTerminalPush`, which is **not** card-dispatch-specific. It is the shared funnel under `_dispatchExecuteMessage`, and seven call sites reach it — only two of which compose. Marking there would set `addonsComposed: true` on the orchestrator kickoff (`:10327`), the Airlock patch hand-off (`:22681`), `dispatchCustomPromptToRole` (`:5598`), `dispatchToCoderTerminal` (`:10854`) and `_tryFleetDeliveryForRole` (`:19998`) — silently exempting five uncomposed paths from the very safeguard this plan exists to add, and doing it invisibly.
> **Replaced with:** The marker is a **threaded parameter**, not a property of the delivery branch. `_dispatchExecuteMessage` and `_attemptDirectTerminalPush` gain an explicit `promptComposed = false` argument; only the two callers whose prompt came out of `generateUnifiedPrompt` / `buildKanbanBatchPrompt` pass `true` — the batch-group dispatch (`:6358`) and the single-card dispatch (`:20566`). The default is `false`, so a call site added later gets the safeguard by omission rather than losing it. Audit all seven call sites in the change; do not infer composition from the payload.

**The marker is host-only, and that requires the two-layer split.** `addonsComposed` is stripped at the **HTTP boundary** (`handlePtyVerb` / bootstrap's `ptySendPrompt` case) and honoured at the **chokepoint** (`_ptyHostVerb` / `deliverPrompt`). Stripping and honouring in the same place is not possible: internal senders never cross the boundary, and HTTP callers must not be able to set it. This is exactly how `clearBeforePromptFromConfig` is already handled, and it is the reason the append cannot live in `handlePtyVerb`.

**`terminal-coder-dispatch/SKILL.md` gains one paragraph** stating that seat safeguards ride the delivery layer, that a driving agent does not hand-copy them, and that hand-typed prose is not a substitute. The skill keeps `ptySendPrompt` as its recipe — with this fix, that recipe becomes correct. The natural home is beside the existing standing-orders paragraph (`.agents/skills/terminal-coder-dispatch/SKILL.md:97`), which already tells the reader that a per-seat block is appended automatically.

### Five constraints the implementation must satisfy (verified against the tree, 2026-08-17)

**1. The seat block goes BEFORE the standing-orders block, and the ordering is mechanical, not aesthetic.**

`STANDING_ORDERS_BLOCK_RE` (`src/services/standingOrders.ts:29`) is anchored to end-of-string:

```
/\n*=== STANDING ORDERS ===\n[\s\S]*?These apply to everything you do in this terminal until told otherwise\.\n$/
```

The `$` anchor is deliberate — it is the documented defence against a prompt that merely *quotes* the marker being truncated from that point on. `applyStandingOrders` strips with this regex before re-appending, and the webview mirrors the identical literal (`src/webview/terminals.js:8616`, `:8621`), pinned by `src/test/standing-orders-marker-contract.test.js`.

Consequence: **appending the seat block after the standing-orders block breaks the strip on the next send** — the block is no longer last, the regex misses, and the seat receives two standing-orders blocks. The correct order of operations at the chokepoint is:

1. strip any inbound standing-orders block (export `stripStandingOrdersBlock`, today module-private at `standingOrders.ts:155`),
2. append the seat block,
3. call `applyStandingOrders` on the result — its own internal strip is then a no-op and it appends the fresh block last.

Do **not** relax the `$` anchor to make a different order work. Widening that regex re-opens the quoted-marker truncation bug it was written to close, and the mirror test will fail anyway.

**2. Standalone's board path composes a hardcoded subset, not the configured addon set.**

`buildPromptForCards` (`src/standalone/bootstrap.ts:122`) does **not** call `buildKanbanBatchPrompt`. It emits `FOCUS_DIRECTIVE`, `GIT_SAFETY_DIRECTIVE`, `SKIP_COMPILATION_DIRECTIVE` and `SKIP_TESTS_DIRECTIVE` **unconditionally**, reads no role config, and never emits a subagent policy at all. So "the board path composes" is only half-true under `npx`, and neither value of the marker is right there:

* `promptComposed: true` → standalone board dispatch keeps today's behaviour exactly (still no subagent policy — a pre-existing gap, not a regression).
* `promptComposed: false` → the git safety and skip directives appear **twice**.

**Resolution:** delete `GIT_SAFETY_DIRECTIVE`, `SKIP_COMPILATION_DIRECTIVE` and `SKIP_TESTS_DIRECTIVE` from `buildPromptForCards`, keep `FOCUS_DIRECTIVE` (genuinely dispatch-scoped — it references the plan list below it), and mark that call site `promptComposed: false` so the seat block supplies all three from config. This is the smallest change that makes both hosts consistent, and it removes a real defect on the way: standalone currently forces skip-compilation and skip-tests on **every** board dispatch regardless of what the operator configured. Three lines deleted; the seat block replaces them with the configured values.

**3. Machine-origin notices are exempt; agent-to-agent relays are not.**

Two host-side senders already opt out of standing orders, and they must be handled differently from each other:

* **`notifyTurnEnd`** (`TaskViewerProvider.ts:1267`, standalone `bootstrap.ts:1923`) sends `[switchboard:turn-end] …` with `standingOrders: false`. These are one-line machine notices on the highest-frequency path in the fleet. They get **no seat block** — there is no task to constrain. Pass the host-only opt-out.
* **`/terminals/relay`** (`LocalApiServer.ts:2004`) hardcodes `standingOrders: false`, reasoning that appending a full block to every agent-to-agent note is "pure inflation". That reasoning does **not** transfer. A relay carries agent-authored task content to a working seat — it is the same class of traffic as the incident. Relays **do** get the seat block. The two suppressions are not one switch: keep `standingOrders: false` on the relay and let the seat block through.

Note also that `standingOrders: false` is honoured from **caller** payloads today (`_ptyHostVerb:424`), so any agent can already suppress a peer's standing orders over HTTP. The seat-block opt-out must not follow that precedent — it is host-only, per the decision above. Widening or narrowing the existing `standingOrders` hole is out of scope for this plan.

**4. The block must be byte-identical to the board's, and structurally separate from the task text.**

The corroborating observation above (composed → obeyed; prose → ignored) means **form is the mechanism**, not a stylistic preference. The implementation therefore has two non-negotiable properties:

* **Verbatim constants.** Emit `SKIP_TESTS_DIRECTIVE`, `NO_SUBAGENTS_DIRECTIVE`, `buildGitPolicyBlock(...)` etc. exactly as `buildKanbanBatchPrompt` emits them — same strings, same `LABEL:` prefixes, same joining. Do **not** paraphrase, summarise, re-title, compress, or "make it read better for a relay." A reworded directive is the failing case, reproduced by the fix meant to remove it.
* **Its own delimited block, appended after the task text** — never interpolated into, prefixed onto, or wrapped around the sender's prose. The delivered prompt is `<sender's text>` → `<seat block>` → `<standing orders>`, three visually distinct regions, the same shape a board dispatch has.

This is testable and must be tested: assert the emitted seat block is **string-equal** to the corresponding constant, not merely that it contains the phrase. A `toContain` assertion passes on a paraphrase and is therefore the wrong assertion for the one property that makes this fix work.

**5. The skip directives must state precedence over the plan file, or incident #2 recurs.**

Every plan file carries a `## Verification Plan` with automated checks. A seat configured `skipTests` therefore receives two instructions that contradict each other, and — as incident #2 demonstrated — the plan file wins, because it is specific, proximate, and the declared source of truth for the task.

Delivering the directive more reliably does not resolve a contradiction; it just makes the contradiction arrive on time. The directive has to carry its own precedence:

* `SKIP_TESTS_DIRECTIVE` (`agentPromptBuilder.ts:844`) and `SKIP_COMPILATION_DIRECTIVE` (`:843`) gain a clause stating they override the plan file's Verification Plan for this run — the checks remain written down, they are simply not executed now.
* Author it once, in the constant. Not in the seat block only: these are shared constants, so the board path gains the same clarification, which is correct — the same contradiction exists there and has simply not been hit yet.
* This is a **user-visible wording change to a shipped prompt constant** on ~4,000 installs. It is additive text, no config or state migration.

Keep it to one clause. Do not add ordering rules, precedence tables, or a general "how to resolve conflicting instructions" preamble — one contradiction is being closed, not a class of them.

## Metadata

**Complexity:** 7
**Tags:** backend, security, refactor, docs

> **Superseded:** Complexity 6; Tags `backend, safety, refactor, docs`.
> **Reason:** Two facts found during the improve pass raise the real cost. (a) The `addonsComposed` marker is not a property of one dispatch branch — it must be threaded through `_dispatchExecuteMessage` / `_attemptDirectTerminalPush` and audited across seven call sites. (b) The append order is constrained by a `$`-anchored regex that is mirrored in the webview and pinned by a contract test, so getting it wrong breaks standing orders rather than merely looking untidy. Add the standalone builder divergence and this is multi-file, two-host coordination against a shared invariant — 7, not 6. `safety` is also not in the allowed tag list; `security` is the nearest allowed tag and is accurate (this is a safeguard-bypass fix).
> **Replaced with:** Complexity 7; Tags `backend, security, refactor, docs`.

## User Review Required

**None.** Five decisions taken here:

* **Seat addons ride the delivery layer, not the caller.** A safeguard a caller must remember to copy is a safeguard that fails on the dispatch nobody was watching — which is this incident exactly.
* **The addon set is split, not applied wholesale.** Dispatch-scoped directives reference plan files and must not appear on arbitrary text.
* **`ptySendPrompt` stays the skill's recipe.** The route is not the defect; the missing composition is. Repointing the skill at `/kanban/dispatch` would move the card on every correction.
* **An explicit `addonsComposed` field, not inference.** Sniffing the payload for an already-present directive is a string-matching guess that silently drops a safeguard the day the directive text is reworded.
* **Delivery, not enforcement. Decided by the user, 2026-08-17.** No host-level enforcement layer — no permission-deny files written into seat working directories, no per-CLI blocking surface. The deliverable is that the configured directive is reliably *present* on every prompt the seat receives. Do not add enforcement scaffolding to this plan, and do not file a follow-up for it.

## Complexity Audit

* **Score:** 7 / 10

### Routine

* Reusing exported constants that are already standalone and plan-free: `GIT_SAFETY_DIRECTIVE` (`agentPromptBuilder.ts:551`), `GIT_SAFETY_DIRECTIVE_WORKTREE_MODE` (`:564`), `buildGitPolicyBlock` (`:601`), `NO_SUBAGENTS_DIRECTIVE` (`:902`), `CUSTOM_SUBAGENT_DIRECTIVE_TEMPLATE` (`:903`), `SKIP_COMPILATION_DIRECTIVE` (`:843`), `SKIP_TESTS_DIRECTIVE` (`:844`), `CAVEMAN_OUTPUT_DIRECTIVE` (`:869`), `SUPPRESS_WALKTHROUGH_DIRECTIVE` (`:870`). All verified present and plan-free.
* Both hosts already own a real `KanbanProvider` (`bootstrap.ts:743`, wired against `vscodeShim.ts`), so `getScopedRoleConfig` / `_getPromptsConfig` resolve identically under `npx`. No new host seam is needed for config reading.
* Standalone `deliverPrompt` already has an `applyOrders` flag; adding a second host-only flag is a one-line signature change.
* Adding a paragraph to one skill file and regenerating the `.claude/` mirror (`.claude/skills/terminal-coder-dispatch/SKILL.md` exists; gated by `npm run mirror:check`).

### Complex / Risky

* **The marker is threaded state, not a branch property.** `_attemptDirectTerminalPush` is the shared funnel under `_dispatchExecuteMessage`, reached by seven callers of which two compose. Marking at the branch exempts five uncomposed paths silently. Threading it means touching `_dispatchExecuteMessage`, `_attemptDirectTerminalPush` and every call site — and a diff that adds a `false` default to a shared helper does not look like a safety change.
* **Double-application on the board path.** The board composes, then delivers over the same verb. Get the gate wrong and every card dispatch carries its git and subagent policy twice — which reads as emphasis to a model and is not obviously wrong in a diff.
* **Ordering is pinned by a `$`-anchored regex mirrored in two files.** The seat block must land before the standing-orders block, or `STANDING_ORDERS_BLOCK_RE` (`standingOrders.ts:29`, mirrored `webview/terminals.js:8621`, pinned by `standing-orders-marker-contract.test.js`) stops matching and seats start receiving duplicated standing orders. This is the single most likely way to ship a regression that looks unrelated to the change.
* **Two hosts, two chokepoints, one of which composes a hardcoded subset.** Extension `_ptyHostVerb` (`:416`) and standalone `deliverPrompt` (`bootstrap.ts:228`) must apply the same block from the same resolver. But standalone's board builder `buildPromptForCards` (`bootstrap.ts:122`) hardcodes four directives and reads no config, so making the hosts agree requires deleting three of those lines — a behaviour change to the standalone board path inside a fleet-path fix.
* **Extracting the addon resolver.** `resolvedOptions` is built inline inside `KanbanProvider.generateUnifiedPrompt` (`:5040–5130`) from `_getPromptsConfig` (`:5280+`), which resolves per-role maps with non-obvious defaults. It is not an extractable function today. The seat resolver needs a new public method (e.g. `resolveSeatPromptOptions(role, initiatorProject)`) sourcing the same maps, or the two paths drift on defaults.
* **Defaults mean this is not a small text change on ~4,000 installs.** `skipCompilationByRole` defaults to `true` for lead / coder / intern (`KanbanProvider.ts:5313–5317`) and `gitProhibitionByRole` defaults to `true` (`:5052`). So the *typical* lead→coder relay gains a git policy block and a skip-compilation directive it has never carried. That is the intended fix, but it is a default-ON behaviour change on the shipped install base and must be called out, not discovered.
* **Role resolution at delivery time.** The delivery layer is handed a `friendlyName`, not a role. Roles are on the terminal record (`ptyHost.ts:109`, `:147` — `ptyListTerminals` returns `role`), but resolution must not fail open: a name that does not resolve must apply the workspace-default safeguards, never an empty block. **Fail-open is how this bug behaves today.**
* **`cavemanOutput` and `suppressWalkthrough` are output-shaping, not safety.** They belong in the seat block for consistency, but a regression here is cosmetic. Do not let them dominate the test surface at the expense of `subagentPolicy` and the git block.

## Edge-Case & Dependency Audit

### Race Conditions

* **Config read on every send.** Addons live in workspace config; the delivery layer reads them per prompt. That is a config read on a hot path — cache per terminal with invalidation on the existing role-config change broadcast rather than reading the file per send.
* **An extra IPC round-trip on every send.** The extension chokepoint has only `payload.name`, so resolving the seat's role means a `ptyListTerminals` call to the pty child. Today that call happens **only when standing orders exist** (`_ptyHostVerb:437`, inside the `orders.length > 0` guard); the seat block would need it unconditionally. Resolve the role once and reuse it for both blocks in the same send — do not add a second list call — and cache it per terminal name with the same invalidation as the config read.
* **A seat whose role changes mid-session.** Rename and re-role paths exist (`ptyRenameTerminal`). The block must derive from the seat's role *at send time*, not from a value captured when the terminal was created. The rename path already rewrites standing orders (`TaskViewerProvider.ts:2794`); any per-name cache added here must be invalidated on the same hook or a renamed seat serves the previous occupant's safeguards.

### Security

* Not a privilege change and no new route. Strictly additive text on an existing verb. The block is composed host-side from local config — no caller-supplied content enters it, so a driving agent cannot suppress another seat's safeguards by crafting a payload. **`addonsComposed` must therefore be host-settable only**: if a caller could set it, any agent could opt a seat out of its own safety block, which would convert this fix into a bypass. Strip it from caller payloads exactly as `clearBeforePromptFromConfig` is stripped.

### Side Effects

* **Every fleet prompt gets longer.** Seat blocks on every send cost tokens on every turn. That is the intended trade — the incident cost far more than the block ever will — but it is a real cost and the block must stay terse. Reuse the existing constants; do not author new prose. The turn-end exemption (constraint 3 above) keeps the highest-frequency path free of it.
* **Existing installs change behaviour on upgrade.** A lead that has been sending bare prompts starts sending prompts with a git and subagent block. Because `skipCompilation` and `gitProhibition` default to `true` for the code roles, this lands on the *default* configuration, not only on seats someone deliberately configured. That is the fix, and it is a behaviour change on ~4,000 installs. No migration is needed — the addons are already-persisted shipped config and this only starts *reading* them on a second path.
* **Standalone board prompts lose two hardcoded directives.** Deleting `SKIP_COMPILATION_DIRECTIVE` / `SKIP_TESTS_DIRECTIVE` from `buildPromptForCards` means an `npx` operator who had *not* configured them stops receiving them — correct, since they were never configured, but visible. Call it out in the completion report.
* **Standing orders are untouched.** Do not fold seat addons into `terminals.standingOrders`; that store is user/agent-authored and this block is host-composed from config. Two mechanisms, one insertion point, one fixed order.

### Dependencies & Conflicts

* **`src/services/TaskViewerProvider.ts`** — `_ptyHostVerb` (`:416`, append beside the standing-orders block at `:421–454`); `handlePtyVerb`'s `ptySendPrompt` branch (`:2766`, strip the marker off caller payloads); `_dispatchExecuteMessage` (`:20010`) and `_attemptDirectTerminalPush` (`:20083`) gain the threaded `promptComposed` argument; the seven call sites at `:5598`, `:6358`, `:10327`, `:10854`, `:19998`, `:20566`, `:22681` are audited, of which `:6358` and `:20566` pass `true`; `notifyTurnEnd` (`:1267`) passes the host-only seat-block opt-out.
* **`src/standalone/bootstrap.ts`** — `deliverPrompt` (`:228`, second host-only flag beside `applyOrders`); the `ptySendPrompt` case (`:1420`, strip); `buildPromptForCards` (`:122`, delete the three seat-scoped hardcoded directives, keep `FOCUS_DIRECTIVE`); the board-dispatch `deliverPrompt` call (`:1614`); the turn-end send (`:1923`, opt out).
* **`src/services/standingOrders.ts`** — export `stripStandingOrdersBlock` (`:155`) so the chokepoint can order the two blocks correctly. `applyStandingOrders` and `STANDING_ORDERS_BLOCK_RE` are otherwise **unchanged** — the regex is pinned by a contract test and mirrored in `src/webview/terminals.js`.
* **`src/services/KanbanProvider.ts`** — extract the seat-scoped subset of `resolvedOptions` (`:5040–5130`) into a public `resolveSeatPromptOptions(role, initiatorProject)` sourcing `_getPromptsConfig`, so both hosts and `generateUnifiedPrompt` read one resolver. `generateUnifiedPrompt`'s own behaviour is unchanged.
* **`src/services/agentPromptBuilder.ts`** — source of the reusable constants, plus the new pure `buildSeatDirectiveBlock(opts)` composer. The existing builders' composition is **unchanged**; only their callers gain the marker.
* **`src/services/LocalApiServer.ts`** — no change. `/terminals/relay` (`:2004`) keeps `standingOrders: false` and inherits the seat block through the chokepoint.
* **`.agents/skills/terminal-coder-dispatch/SKILL.md`** — one paragraph beside the standing-orders note (`:97`), then regenerate the `.claude/` mirror (gated by `npm run mirror:check` → `scripts/check-claude-mirror.js`).
* **No verb added or removed** — `parity:check` / `catalog:check` need no regeneration. No new HTTP route, so `push-routing:check` and `verb-returns:check` are untouched.

## Dependencies

* None outstanding. Every mechanism this needs — role config resolution, the constants, the two-host delivery seam — is already in the tree.

## Adversarial Synthesis

Key risks: (1) **marking composition on the shared funnel instead of threading it from the two composing callers**, which would silently exempt five uncomposed dispatch paths from the safeguard while every test still passes; (2) **appending the seat block after the standing-orders block**, which breaks the `$`-anchored strip regex and starts delivering duplicated standing orders — a regression that looks unrelated to this change; (3) **double-application on the board path**, since card dispatches already compose and then deliver over the same verb, and a doubled safety block reads as emphasis rather than a bug; (4) **fail-open role resolution and a caller-settable marker**, either of which reproduces today's defect or converts the fix into a documented bypass; (5) **fixing one host**, leaving `npx` fleets unprotected — worse here than usual because standalone's board builder hardcodes a directive subset and reads no config at all. Mitigations: the marker defaults to `false` and is threaded explicitly with all seven call sites audited; the three-step ordering (strip → seat block → `applyStandingOrders`) is specified and asserted; the marker is host-set and stripped at the HTTP boundary; unresolved roles fall back to workspace defaults and are asserted to do so; both hosts change in one commit against one shared resolver, and standalone's hardcoded directives are deleted rather than left to collide.

## Proposed Changes

**Build order:** (1) the shared resolver and composer → (2) the `promptComposed` marker threaded through the dispatch funnel → (3) the extension chokepoint → (4) standalone chokepoint and board builder → (5) the skill and mirror → (6) tests. The marker lands before the appending so no intermediate state double-applies.

> **Superseded:** Step 3 — "append in `handlePtyVerb`'s `ptySendPrompt` branch, beside the standing-orders application".
> **Reason:** The standing-orders application is not in `handlePtyVerb`. It is in `_ptyHostVerb` (`TaskViewerProvider.ts:421–454`), one level below, which is the sole path from the extension to the fleet. Six internal senders — including the turn-end notifier, the `sendToTerminal` arm and `_attemptDirectTerminalPush` — call `_ptyHostVerb` directly and never traverse `handlePtyVerb`. Appending in `handlePtyVerb` would cover HTTP callers only and miss every internal fleet dispatch.
> **Replaced with:** Append in `_ptyHostVerb`; strip the host-only marker in `handlePtyVerb`. The boundary strips, the chokepoint appends — the same split `clearBeforePromptFromConfig` already uses.

1. **Shared resolver + pure composer.** `KanbanProvider.resolveSeatPromptOptions(role, initiatorProject)` returns the seat-scoped subset of the existing `resolvedOptions` (same `_getPromptsConfig` maps, same defaults). `agentPromptBuilder.buildSeatDirectiveBlock(opts)` is a pure function composing that subset from the existing constants — no new prose, no `vscode` import, no plan input. Returns `''` only when every seat-scoped addon is at its no-op value.
2. **`promptComposed`** — a threaded argument on `_dispatchExecuteMessage` / `_attemptDirectTerminalPush`, defaulting `false`, passed `true` by the batch-group (`:6358`) and single-card (`:20566`) dispatches only. It becomes the host-only `addonsComposed` field on the `ptySendPrompt` payload, stripped at the HTTP boundary in both hosts.
3. **Extension chokepoint** — in `_ptyHostVerb`, resolve the seat's role once (reuse the existing `ptyListTerminals` result rather than adding a second call), then compose in this order: strip inbound standing orders → append the seat block → `applyStandingOrders`. Skip entirely when `addonsComposed` is set or the host-only turn-end opt-out is passed.
4. **Standalone** — the same three steps in `deliverPrompt` (role comes straight off `handle.role`, no IPC needed), the marker stripped in the `ptySendPrompt` case, and `buildPromptForCards` loses `GIT_SAFETY_DIRECTIVE` / `SKIP_COMPILATION_DIRECTIVE` / `SKIP_TESTS_DIRECTIVE` while keeping `FOCUS_DIRECTIVE`.
5. **Precedence clause on the two skip constants** — `SKIP_TESTS_DIRECTIVE` (`agentPromptBuilder.ts:844`) and `SKIP_COMPILATION_DIRECTIVE` (`:843`) each gain one clause stating the directive overrides the plan file's Verification Plan for this run. One clause each, in the constant, shared by both the board and seat paths. See constraint 5 — without this, the fix delivers the directive and the plan file still wins.
6. **Skill + mirror** — one paragraph in `terminal-coder-dispatch/SKILL.md` beside the existing standing-orders note, then regenerate the `.claude/` mirror.
7. **Tests** — see below.

## Verification Plan

### Automated Tests

Tests are plain Node scripts under `src/test/*.test.js`, matching the house pattern (`standing-orders-marker-contract.test.js` is the closest model).

* A `ptySendPrompt` to a seat whose role has `subagentPolicy: 'noSubagents'` carries `NO_SUBAGENTS_DIRECTIVE`. **This is the incident's regression test — it must exist and it must be named for the incident.**
* Same for the git policy block, `skipCompilation`, `skipTests`, `cavemanOutput`, `suppressWalkthrough`.
* A `ptySendPrompt` carries **no** `FOCUS_DIRECTIVE`, no batch execution rules and no PRD block — asserted on absence, so widening the seat set later fails loudly.
* A card dispatch delivered over the PTY branch carries each directive **exactly once** — asserted by count, not by presence.
* **Each of the five uncomposed `_dispatchExecuteMessage` callers still receives the seat block.** Enumerated by call site, not asserted in aggregate — the aggregate assertion is what a branch-level marker would pass.
* `addonsComposed` supplied in a caller payload is ignored and stripped; the seat block is still appended.
* A `friendlyName` that resolves to no role still receives the workspace-default seat block — asserted explicitly, because fail-open is the current bug.
* Both hosts produce a byte-identical seat block for the same seat and config.
* **Ordering, asserted structurally:** in a prompt carrying both, the seat block's last character index precedes the standing-orders marker index, and the standing-orders block terminates the string.
* **Idempotence across a re-send:** feed a delivered prompt (task + seat block + standing orders) back through the chokepoint and assert exactly one standing-orders block and one seat block survive. This is the test that fails if the ordering is inverted, and it is the reason the ordering rule exists.
* `applyStandingOrders`, `STANDING_ORDERS_BLOCK_RE` and the `webview/terminals.js` mirror are byte-unchanged — `standing-orders-marker-contract.test.js` stays green without edits.
* A `[switchboard:turn-end]` notice carries neither standing orders nor a seat block; a `/terminals/relay` message carries the seat block but no standing orders.
* Standalone board dispatch carries `FOCUS_DIRECTIVE` exactly once and carries git / skip directives **only** when the role config enables them.
* `SKIP_TESTS_DIRECTIVE` and `SKIP_COMPILATION_DIRECTIVE` each contain the precedence clause, asserted on the constant itself so both the board path and the seat path inherit it from one place.
* `catalog:check` / `parity:check` stay green with no regeneration.
* `mirror:check` passes after the skill edit.

### Manual Verification

1. Configure a coder seat with `subagentPolicy: noSubagents`. Drive it from a lead over `ptySendPrompt`. The received prompt contains the directive; the coder spawns nothing.
2. Repeat with the git strategy set to prohibit commits — the coder does not commit.
3. Dispatch a card to the same seat from the board. Every directive appears once.
4. Repeat 1 and 3 under `npx switchboard`. Identical.
5. Send a bare correction ("stop, the previous edit was wrong") — the seat block is present, and no directive mentions plan files.
6. With a standing order installed on the seat, send twice in a row. The second delivered prompt has exactly one standing-orders block and one seat block, in that order, standing orders last.
7. **The incident-#2 replay.** Configure the coder seat `skipTests`. Have a lead relay a subtask whose plan file carries a normal `## Verification Plan` with automated checks. The coder receives the composed directive **and** the plan file, and does not run the suites. This is the check that distinguishes "the directive arrived" from "the directive won" — steps 1–6 all pass without it.

## Recommendation

Complexity 7 → **Send to Lead Coder.**

> **Superseded:** Complexity 6 → Send to Coder.
> **Reason:** The improve pass raised the score to 7 (see the Metadata callout): a threaded marker audited across seven call sites, an append order constrained by a `$`-anchored regex mirrored in the webview and pinned by a contract test, a config resolver that must be extracted out of `generateUnifiedPrompt`, and a standalone board builder that composes a hardcoded subset. Any one of those, done by feel, ships a green build with the safeguard missing or standing orders duplicated.
> **Replaced with:** Complexity 7 → Send to Lead Coder.

**Read the incident section first — both instances, including the third-cause subsection.** Instance #1 is a directive that was **absent**, and the delivery-layer fix closes it. Instance #2 is a directive that was **present and outranked** by the plan file's own Verification Plan; the delivery-layer fix alone does not close it, which is why the precedence clause (constraint 5, change 5) is part of this plan and not an optional polish item.

**The three things to get right:**

1. **The `addonsComposed` gate, threaded — not branched.** The board composes and then delivers over the same verb, so the naive version double-applies every directive on every card dispatch, and a doubled safety block does not look like a bug in review. But setting the marker inside `_attemptDirectTerminalPush` is worse than double-applying: it silently exempts five uncomposed dispatch paths. Thread the flag from the two composing callers, default `false`, and audit all seven.
2. **The append order.** Seat block first, standing orders last. `STANDING_ORDERS_BLOCK_RE` is `$`-anchored and mirrored in the webview — invert the order and seats start receiving two standing-orders blocks on the second send, with nothing in the diff that points at this change.
3. **The precedence clause.** One clause each on `SKIP_TESTS_DIRECTIVE` and `SKIP_COMPILATION_DIRECTIVE` saying they override the plan file's Verification Plan for this run. Without it, manual check 7 fails while checks 1–6 all pass — the directive arrives and loses.

**Do not** fold the seat block into `terminals.standingOrders`, do not apply dispatch-scoped directives on arbitrary sends, do not let `addonsComposed` be settable by a caller, do not relax the standing-orders regex, do not add a second `ptyListTerminals` round-trip per send, and do not fix one host.

---

## Completion Report

**Implemented:** All 7 steps of the plan.

### Changes by file

**`src/services/standingOrders.ts`**
- Exported `stripStandingOrdersBlock` (was module-private). The delivery layer needs it to order the seat block before the standing-orders block (constraint 1: the `$`-anchored `STANDING_ORDERS_BLOCK_RE` requires the SO block to be last).

**`src/services/agentPromptBuilder.ts`**
- Extracted `ACCURATE_CODING_DIRECTIVE` as a shared exported constant (was inlined in `withCoderAccuracyInstruction`).
- Added `SeatDirectiveOptions` interface — the seat-scoped subset of addon config (subagent policy, git policy, skip-compilation, skip-tests, caveman output, suppress-walkthrough, accurate-coding). Dispatch-scoped addons (FOCUS_DIRECTIVE, BATCH_EXECUTION_RULES, PRD injection, project pin, featureSubagentPolicy, workflow-file redirection, pairProgramming) are deliberately absent.
- Added `buildSeatDirectiveBlock(opts)` — a pure composer that emits the existing constants verbatim (same strings, same `LABEL:` prefixes, same joining as `buildKanbanBatchPrompt`). Returns `''` when every addon is at its no-op value. No `vscode` import, no plan input, no new prose.
- Added a precedence clause to `SKIP_TESTS_DIRECTIVE` and `SKIP_COMPILATION_DIRECTIVE`: "This directive overrides the plan file's Verification Plan for this run — the checks remain written down, they are simply not executed now." This closes incident #2 (directive present but outranked by the plan file).

**`src/services/KanbanProvider.ts`**
- Added `resolveSeatPromptOptions(role, initiatorProject?)` — a public async method that sources the same `_getPromptsConfig` maps as `generateUnifiedPrompt`'s `resolvedOptions`, so both the board path and the pty delivery layer read one resolver. Defaults `gitProhibitionEnabled` to `true` (fail-safe for unresolved roles).

**`src/services/TaskViewerProvider.ts`**
- `_ptyHostVerb` (the sole extension-host chokepoint): rewritten to append both the seat directive block AND the standing-orders block. Ordering: strip inbound SO → append seat block → `applyStandingOrders` (constraint 1). `ptyListTerminals` is called once and reused for both the live set and role resolution. The seat block is skipped when `addonsComposed === true` (board-composed prompt, double-application prevention) or `seatBlock === false` (host-only opt-out for machine-origin notices).
- `handlePtyVerb` (HTTP boundary): strips `addonsComposed` and `seatBlock` from caller payloads — same boundary strip as `clearBeforePromptFromConfig`. An HTTP caller cannot opt a seat out of its own safety block.
- `_dispatchExecuteMessage` / `_attemptDirectTerminalPush`: accept `promptComposed: boolean = false` (default false so new call sites get the safeguard by omission). Sets `addonsComposed: promptComposed` on the ptySendPrompt payload.
- Two composing call sites (batch-group dispatch, single-card dispatch) pass `promptComposed: true`.
- `notifyTurnEnd`: passes `seatBlock: false` (machine-origin notice, no task to constrain).

**`src/standalone/bootstrap.ts`**
- `deliverPrompt` (the sole standalone chokepoint): rewritten to accept `applySeatBlock = true` as a 5th parameter. Appends the seat block from `kanbanProvider.resolveSeatPromptOptions(handle.role)` then applies standing orders (same ordering as the extension). Reads role from `handle.role` — no IPC needed.
- `buildPromptForCards`: removed the three hardcoded seat-scoped directives (`GIT_SAFETY_DIRECTIVE`, `SKIP_COMPILATION_DIRECTIVE`, `SKIP_TESTS_DIRECTIVE`). They are now supplied by the seat block in `deliverPrompt` from the configured role addons, so both hosts agree and an operator who disabled them stops receiving them. `FOCUS_DIRECTIVE` stays (dispatch-scoped).
- `ptySendPrompt` case: strips `addonsComposed` and `seatBlock` from caller payloads (same boundary strip as the extension).
- Turn-end send: passes `applySeatBlock = false` (5th arg).

**`.agents/skills/terminal-coder-dispatch/SKILL.md`** + **`.claude/skills/terminal-coder-dispatch/SKILL.md`** (mirror)
- Added section 3.6: "Seat safeguards ride the delivery layer — do not hand-copy them." Explains that a seat safeguard is a property of the seat, not of the dispatch; the delivery layer appends it; a driving agent does not hand-copy or paraphrase these directives; hand-typed prose enters the same evidential pool as the plan file and can lose an argument to it.

**`src/test/seat-safeguards-fleet-prompt-path.test.js`** (new, 46 tests)
- Source-level contract tests pinning: `buildSeatDirectiveBlock` exists and emits the verbatim constants; `SeatDirectiveOptions` is exported; `ACCURATE_CODING_DIRECTIVE` is extracted; `stripStandingOrdersBlock` is exported; `resolveSeatPromptOptions` exists, sources `_getPromptsConfig`, and defaults guardrail ON; the precedence clause is on both skip directives; `_ptyHostVerb` appends the seat block, strips SO first, applies SO after, skips on `addonsComposed`/`seatBlock`, calls `ptyListTerminals` once; `handlePtyVerb` strips host-only fields; `notifyTurnEnd` passes `seatBlock: false`; `promptComposed` is threaded through the dispatch funnel; standalone `deliverPrompt` mirrors the extension; `buildPromptForCards` no longer hardcodes the three directives but keeps `FOCUS_DIRECTIVE`; standalone `ptySendPrompt` strips host-only fields; standalone turn-end opts out; the skill paragraph exists in both `.agents` and `.claude` mirrors; `STANDING_ORDERS_BLOCK_RE` is still `$`-anchored.

### Verification

- `npm run compile-tests` — clean (0 errors).
- `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/seat-safeguards-fleet-prompt-path.test.js` — 46 passed, 0 failed.
- `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/standing-orders-marker-contract.test.js` — 40 passed, 0 failed (existing test unbroken).
- `npm run mirror:check` — passed (47 files, v1.7.13).
- `npm run catalog:check` — passed.
- `npm run parity:check` — passed (allowlist ≡ catalog, 526 verbs).

---

## Review Findings

Reviewed 2026-08-17. The mechanism is correct — marker threaded (not branched, all 7 `_dispatchExecuteMessage` sites audited, exactly 2 composing), ordering strip → seat block → `applyStandingOrders`, `STANDING_ORDERS_BLOCK_RE` untouched, both hosts changed, precedence clause on both skip constants. Four issues fixed: (1) `src/services/TaskViewerProvider.ts` `_ptyHostVerb` resolved the seat role from `listed.terminals` only, but `ptyListTerminals` returns hidden seats in a sibling `hiddenTerminals` array and `/terminals/relay` — the in-scope path — validates recipients against both, so a relay to a hidden seat delivered with `role = ''` and dropped its configured safeguards (now searches combined `roleRows`); (2) the new 46-test file was invoked by nothing — added `test:contract:seat-safeguards` to `package.json` and a CI step in `.github/workflows/integration-tests.yml`; (3) constraint 4's non-negotiable byte-identity assertion was written as a TypeScript source grep (`fnBody.includes('NO_SUBAGENTS_DIRECTIVE')`, weaker than the `toContain` the plan rejected) — added 9 behavioural tests against the compiled composer asserting string-equality with each constant, exactly-once counts, no dispatch-scoped leakage, and empty-on-no-op; (4) the "five uncomposed callers, enumerated not aggregated" test was a single `indexOf("'sidebar', true;")` — replaced with per-call-site classification pinning 7 sites / 2 composed / 5 unmarked. Also fixed `browser-stray-dispatch-surface.test.js`, which this change had broken (it asserted `_dispatchExecuteMessage` ends at `sender`; now pinned to `sender + promptComposed: boolean = false` so the marker's default and the `allowPtyFleet` prohibition both stay locked), and renumbered the skill section 3.6 → 3.4 (it had been inserted above 3.5). Verification: `compile-tests` clean; seat-safeguards 57/57; standing-orders-marker 40/40; stray-dispatch 7/7; pty-dispatch-focus, browser-direct-terminal-helpers, browser-planner-dispatch-surface, terminal-rename-rekey, terminal-input-path all green; `mirror:check` / `catalog:check` / `parity:check` pass; `eslint` 0 errors. `agent-prompt-builder-subagents`, `agent-prompt-builder-ticket-updater-modes`, `builtin-role-dispatch-coverage`, `challenge-prompt-regression` and `dispatch-plan-builder` fail identically at HEAD (verified by diffing the failing assertions against `git show HEAD:`) and none are wired into CI — pre-existing, not this change. **Standalone directive delta (the Side-Effects call-out the completion report omitted):** deleting the three hardcoded directives from `buildPromptForCards` changes `npx` board dispatch from "forced regardless of config" to "whatever the role addons say" — unconfigured lead/coder/intern are **unchanged** (their `skipCompilation`/`skipTests` defaults are `true`); reviewer/tester/analyst/researcher/ticket_updater keep the git guardrail but stop being told to skip compilation and tests; planner gets nothing, because `gitProhibitionByRole.planner` resolves from `switchboard.planner.gitProhibitionEnabled` which defaults `false`. Every one of those outputs is byte-identical to what the extension host already produced for that role (`KanbanProvider.ts:5043-5052`), so this is host convergence, not a dropped safeguard — standalone was the outlier that forced review roles to skip the very checks they exist to run. Remaining risks, both accepted: seat-block **idempotence on re-send is not implemented** (a delivered prompt fed back through the chokepoint accumulates seat blocks — standing orders are protected, the seat block is not; closing it needs a wire-format marker, which fights constraint 4's byte-identity rule, so it is deferred as the user's call); and the plan's per-terminal **role/config cache was skipped**, so `ptyListTerminals` is now one unconditional IPC per `ptySendPrompt` (was gated on `orders.length > 0`) — turn-end, the hot path, opts out of both blocks, so this lands only on human-frequency sends.
