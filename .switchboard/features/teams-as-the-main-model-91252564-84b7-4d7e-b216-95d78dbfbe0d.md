# Teams as the main model

**Complexity:** 7

## Goal

Make a team the unit people work with, and repair what the first live run of the dispatch pattern exposed.

Switchboard currently expresses one idea — agents working together — as five separate mechanisms: agent groups behind an instantiate button, pair programming as a toolbar mode, phone-a-friend as an addon plus an endpoint, the researcher hand-off as a conditional prompt directive, and link-up presets as the relationship vocabulary all four need. Under them sits a delegate dispatch-and-join protocol no code path calls. The result is a surface no operator can read: a Delegation section that configures spawn counts, a delegates control nobody can explain, and configuration that does nothing until a button is pressed in a settings tab.

This feature keeps one concept. A team is a named head role plus members, each with a scope and a relationship. It starts when its head role starts, wires its own standing orders, and registers itself as a terminal group. Four ready-made types ship so the tab shows ways of working rather than parts to assemble. Alongside that it fixes the concrete defects the first eight-subtask run surfaced: coder context accumulating across subtasks, a stale agent CLI label, and unwired terminals born through the spawn path the group wrapper does not cover.

## How the Subtasks Achieve This

- **Clear The Coder Between Subtasks, And Call The Block What It Is**: Splits the dispatch skill's single `clearBeforePrompt: false` rule into two — clear on the first prompt of a new subtask, preserve on a fix resend inside one — and drops the "passed review" send entirely, since a fresh subtask is the acknowledgement. Also renames the standing-orders marker to `STANDING ORDERS` in the writer and its client mirror together. Pure protocol and text; touches no team machinery, so it can land any time.
- **A Terminal Shows The Wrong Agent CLI Until The Panel Is Reloaded**: Fixes a cache invalidated on key presence rather than value freshness, so editing an existing role's CLI command finally updates the sidebar label and brand icon without a reload. Wholly independent of everything else here.
- **Retire The Delegate Join Contract**: Deletes `DelegateManager`, the three `/delegates/*` routes, the parent directive that teaches them and the skill that documents them — keeping `spawnDelegates`, parentage and the caps. Goes first among the team work, because it removes the protocol every later subtask would otherwise have to reason about, and it shortens the head's prompt to the one contract that actually runs.
- **The Spawn Primitive Must Wire The Team, Not The Wrapper**: Moves standing-order installation and terminal-group registration out of the agent-group wrapper and into the shared spawn path, so a head's children are wired whichever door created them. This is the subtask that makes a team a team rather than four unrelated terminals, and every later subtask depends on it holding.
- **A Team Starts With Its Head Role — Delete The Instantiate Button**: Turns a definition into a trigger. Starting a terminal whose role heads a team spawns that team, gated on parentage so members cannot recursively spawn teams of their own, and the manual instantiate path is deleted end to end.
- **Team Members Gain A Scope And A Relationship**: Adds `scope` (one set per team, or shared across teams) and `relationship` (a `LINK_PRESETS` id) to a member. Scope is what makes eight planners share one researcher expressible; relationship replaces a single hardcoded callback sentence with the vocabulary link-up already ships, so a researcher is told it is a researcher.
- **The Teams Tab And Four Shipped Team Types**: Gives teams their own tab and leads it with complete working arrangements — Feature team, Planning team, Solo coder, Review team — so the surface shows ways of working rather than parts to assemble. Moves Delegation and Agent Groups out of AGENTS, and answers the "I have no idea what delegates is" report by removing the thing that could not be explained.
- **Seed A Starter Team, And Migrate The Groups People Already Have**: Ships a member-less `Lead team` on installs that never configured one — inert, so it changes no behaviour while explaining the concept — and converts every existing Agent Group into a team, resolving two groups claiming one head role without deleting either.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Clear The Coder Between Subtasks, And Call The Block What It Is](../plans/feature_plan_20260812190000_clear-between-subtasks-and-standing-orders-title.md) — **CODE REVIEWED**
- [ ] [A Terminal Shows The Wrong Agent CLI Until The Panel Is Reloaded](../plans/feature_plan_20260812190001_stale-agent-cli-label-cache.md) — **CODE REVIEWED**
- [ ] [Retire The Delegate Join Contract](../plans/feature_plan_20260812190002_retire-the-delegate-join-contract.md) — **CODE REVIEWED**
- [ ] [The Spawn Primitive Must Wire The Team, Not The Wrapper](../plans/feature_plan_20260812190003_spawn-primitive-wires-the-team.md) — **CODE REVIEWED**
- [ ] [A Team Starts With Its Head Role — Delete The Instantiate Button](../plans/feature_plan_20260812190004_teams-auto-start-with-their-head-role.md) — **CODE REVIEWED**
- [ ] [Team Members Gain A Scope And A Relationship](../plans/feature_plan_20260812190005_team-member-scope-and-relationship.md) — **CODE REVIEWED**
- [ ] [The Teams Tab And Four Shipped Team Types](../plans/feature_plan_20260812190006_teams-tab-and-shipped-team-types.md) — **CODE REVIEWED**
- [ ] [Seed A Starter Team, And Migrate The Groups People Already Have](../plans/feature_plan_20260812190007_seed-a-starter-team-and-migrate-agent-groups.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Two subtasks are unconstrained. The other six form one chain, and the ordering matters more than usual because each one changes the ground the next stands on.

> **Reconciled 2026-08-12.** A cross-subtask audit against `src/` corrected three claims below and added one hard constraint. The corrections are marked inline. The constraint is this: **subtask 3 (auto-start) must not be *released* without subtask 6 (seed + migrate)**, whatever order they land in the repo. `KanbanProvider._loadAgentGroups` (`:4394-4401`) seeds a persisted `lead`-headed group with three coder members on any install that has opened the AGENTS tab, so auto-start alone turns that seed into three unrequested agent CLIs on the first lead start across the install base. Subtask 6 owns the resolution; subtask 3 carries the gate as a verification step.

### Start any time, in parallel with anything

- **Clear The Coder Between Subtasks** — a skill document plus a two-site string rename. No overlap with the team work.
- **A Terminal Shows The Wrong Agent CLI** — one guard in `terminals.js` and a refetch signal. No overlap.

### The team chain — six subtasks, strict order

1. **Retire The Delegate Join Contract** goes first. It deletes `delegation.ts`, three routes, their verb arms in both hosts, and `DELEGATE_PARENT_DIRECTIVE`. Anything written before it that reasons about the join protocol is written against code destined for deletion, and the head's prompt is rebuilt here rather than twice.
2. **The Spawn Primitive Must Wire The Team** next, and it is the keystone. Every later subtask assumes that a spawned member arrives with its standing order installed and its group registered. Landing it after auto-start would mean shipping an interval in which teams start automatically and arrive unwired — the exact defect the first live run reported, made worse by happening more often.
3. **A Team Starts With Its Head Role** after 2. It needs wiring to already be automatic, because it multiplies the number of occasions wiring happens. Its recursion guard (only an unparented spawn triggers a team) must be in place before any team can contain a role that heads another team, which subtask 6 makes reachable by shipping a type headed on `coder`.
4. **Team Members Gain A Scope And A Relationship** after 3. `shared` scope changes what auto-start does on each head start — reuse a live instance rather than spawn — so it extends behaviour introduced in 3 rather than existing alongside it.
5. **The Teams Tab And Four Shipped Team Types** after 4. The tab renders `scope` and `relationship` per member and its editor writes them; building it first means building an editor for fields that do not exist yet, then revisiting it.
6. **Seed A Starter Team, And Migrate** last *in the chain, but not last to ship* — see the release gate above. The converter has to write the final member shape, including the two fields from 4, and the head-role uniqueness rule it enforces is only meaningful once 3 makes head role a trigger. Migrating to an intermediate shape and re-migrating is the one outcome to avoid on shipped state.

### Shared surfaces

- **`agentGroupInstantiation.ts`** — subtask 2 *replaces* its standing-order block with a call to the shared wiring function (it does not simply remove it); 3 removes the **verb and button** that reach it, **keeping** both host adapters (`TaskViewerProvider.ts:11063`, `bootstrap.ts:1706`), which are what auto-start calls; 4 changes what a member definition contains. Sequential ownership; no concurrent edits.
  > *Corrected: the earlier reading — "3 removes its two manual call sites" — would have deleted the adapters auto-start depends on. Those two sites are host adapters, not manual entry points.*
- **The wiring layer (not `spawnDelegates`)** — subtask 2's wiring cannot live in `spawnDelegates`: in the extension host the fleet runs in a child process constructed **without a `KanbanDatabase`** (`ptyHost.ts:43`; the consequence is documented at `TaskViewerProvider.ts:625-632`), so a standing-order install placed there works under `npx` and silently no-ops on the shipped extension. Wiring goes in a shared host-agnostic function called from both hosts' `handlePtyVerb` post-create hook plus `instantiateAgentGroupCore`. Subtask 4 still adds its shared-member reuse branch inside `spawnDelegates`; 2 lands first.
- **`terminals.groups`** — subtask 2 adds a *second writer* to a key the terminals webview currently owns outright (`terminals.js:1479` saves the whole in-memory array). Serialise the write, push a refresh so an open panel reloads before it can clobber, and register with a `source` the shipped loader accepts — `loadLayoutSettings` (`:1393-1409`) silently discards any group whose `source` is not `manual` / `role` / `worktree`.
- **`terminals.agentGroups`** — subtask 4 adds two member fields and 6 migrates the store. Read defensively in both; an install that has neither field must behave exactly as today.
- **`LINK_PRESETS`** — subtask 4 adds a new entry and a `direction` field, and establishes a canonical TS copy the team-spawn path imports.
  > *Corrected: it cannot be "moved out of `terminals.js` into a shared module both sides import". `terminals.js` is served as a classic script (`headlessPanelHtml.ts:400-408`) with no `type="module"` anywhere in the webview and no bundling of webview JS. The shipped pattern for this exact problem is a TS source of truth plus a declared webview mirror with a keep-in-sync comment — see `standingOrders.ts` ↔ `terminals.js:7973-7975` — and subtask 4 adds a contract test so this mirror is enforced rather than merely requested.*
- **`kanban.html`** — subtask 3 deletes the instantiate button and its result arm; subtask 5 moves two whole subsections out of the AGENTS tab. Same file, different regions, but under the project's one-stream-per-file rule they serialise. Note for 5: `agentsTabCollectConfig` (`:4507`) and the load-time autosave bindings (`:4527-4534`) are both scoped to `#agents-tab-content`, so a moved control silently loses its collector entry *and* its listener — re-scope both in the same change, and verify by edit-then-reload rather than by render.

### One caveat carried from the design work

Phone-a-Friend's automatic batch-end trigger is deliberately **out of scope** for every subtask here. A team supplies the terminal; `addons.phoneAFriend` continues to decide when it fires. Pair programming is likewise untouched — it operates on plan dispatch and decides whether a coder also receives a prompt, which is a different layer from what terminals exist. Neither should be edited by this feature; if a subtask finds itself changing either, that is a signal the layer boundary has been crossed and the change belongs in a separate plan.

---

## Completion report — 2026-08-13

All eight subtasks implemented and reviewed, driven through coder terminals in the mandated order: the two unconstrained subtasks first, then the six-subtask chain (retire delegates → spawn wiring → auto-start → scope/relationship → Teams tab → seed/migrate). Every diff was reviewed against the plan's acceptance criteria rather than the coder's completion report; four subtasks required a fix round, each for a defect that all automated gates passed: the dispatch skill asserted an omitted `clearBeforePrompt` defaults to `true` when both hosts default it to `false`; the `startupCommandsChanged` broadcast reached only one of two provider-side write paths, leaving Setup and onboarding saves stale; `_isTeamMember` was written but never read, so the auto-start recursion guard was safe only by accident of call path; and the seed migration ran solely from the `getAgentGroups` verb arm while `findTeamForHeadRole` read raw config, leaving the release gate open for any install that started a `lead` before opening the TEAMS tab.

New shared modules: `src/services/teamWiring.ts` (host-agnostic wiring, team lookup, seed + migration converter) and `src/services/linkPresets.ts` (TS source of truth for `LINK_PRESETS`, mirrored in `terminals.js`). Two new contract tests enforce the two webview mirrors that were previously held in sync by comment alone. `npm run parity:check` green; per session directive no compile step and no test run beyond that gate.

**Release gate closed.** `SEEDED_AGENT_GROUP` is now a member-less `Lead team`, the old three-coder seed is neutralised by exact-value comparison, and the converter runs on the auto-start read path as well as the board load path — so no ordering assumption remains between opening a tab and starting a terminal.

**Defect found during the run, not fixed here:** `ptySendPrompt` pastes into a PTY fleet terminal without submitting — the confirm-CR gate at `ptyPromptDelivery.ts:49` regexes over terminal name/role and can never match a fleet terminal, and the clear branch waits a flat 2000 ms with no readiness check. Written up as `feature_plan_20260813103000_pty-prompt-delivery-never-submits.md`. Until it lands, driving agents must pass `clearBeforePrompt: false`, which forfeits what *Clear The Coder Between Subtasks* was written to buy.

---

## Review Findings — reviewer pass 2026-08-13

Independent review of all eight subtasks against their plan files, with verification executed rather than asserted (no skip directive was in effect for this pass). **Two CRITICALs made the branch unshippable, both fixed:** `teamWiring.ts` redeclared `members` inside `wireSpawnedTeam`, so `tsc` failed and neither `compile-tests` nor `compile` could pass; and CI still invoked `npm run test:contract:delegate` against the test the delegate retirement deleted. **Four MAJORs fixed:** `npm run catalog:check` (CI step 1) was red because `catalog:generate` had never been run — which had also left `getAgentGroups`/`saveAgentGroup`/`deleteAgentGroup` out of `KANBAN_VERBS`, making the flagship TEAMS tab dead over HTTP in the browser cockpit; `_sharedMemberChain` dropped a chain a later caller had extended, reopening the duplicate-shared-member race; the shared-member spawn had no `try/catch` and could fail a create after the head pty existed; and the migration converter's defensive branch was dead, so a members-less group was never repaired on disk. Two new contract tests (`standing-orders-marker`, `link-presets-mirror`) were defined but never invoked by CI and are now wired. Files changed: `src/services/teamWiring.ts`, `src/standalone/ptyFleetService.ts`, `protocol-catalog.json`, `src/generated/verbAllowlist.ts`, `package.json`, `.github/workflows/integration-tests.yml`; validation was `tsc -p tsconfig.test.json` clean, `eslint` 0 errors, all nine static gates exit 0, ten affected contract suites green, and functional exercise of both `migrateAgentGroups` and `wireSpawnedTeam` against their plans' discriminating cases. Residual risks: the `agentGroupInstantiation.ts` chain is now unreachable but kept per subtask 5's explicit instruction, and `sendPromptToPty`'s second confirm `\r` is gated on a CLI-product-name regex over `handle.name || handle.role` that a fleet terminal cannot match — verified, but whether it is a defect is the open question in `feature_plan_20260813103000`, not a finding of this pass.

> **Correction to this file's own completion report (`:81`).** That report states *"the clear branch waits a flat 2000 ms with no readiness check."* The delay is not flat — it is the shipped `switchboard.terminal.clearBeforePromptDelay` setting (`package.json:320`), threaded through both hosts (`TaskViewerProvider.ts:2205`, `bootstrap.ts:201`). And no prompt-delivery path in this codebase has ever had a readiness check, including the `_sendRobustTextBackground` reference implementation, so there is no baseline for it to be missing against. Only the regex half of that sentence survives checking.
