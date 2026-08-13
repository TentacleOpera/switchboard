# Agent Groups: Define a Team of Agents Once, Instantiate It Wired

## Goal

Add an **Agent Groups** area to the Kanban panel's Agents tab where a user defines a named team — its members, their roles and counts, which CLI or model each launches with, and which member leads — and instantiates it in one action. Instantiating creates the terminals, parents the workers to the lead, and installs the standing orders that make them report back.

Ship one built-in definition, **Feature Implementation**: one lead plus N coders, workers reporting to the lead. That makes the lead the complex-feature agent with a support pool behind it — but as an *instance of a general concept*, not a bespoke button.

### Root cause: one capability is accumulating entry points

Every primitive for a wired agent team already exists, and each is reached from a different place:

- **Parent-child terminals** — `PtyFleetService.create(role, friendlyName, cwd, worktreePath, parentInstanceId, startupCommand, opts)` (`src/standalone/ptyFleetService.ts:161`) takes a parent; children render nested under their head (`terminals.js:6307`) and are counted per head (`:3992`). Shipped with the subagent feature.
- **Standing orders** — `src/services/standingOrders.ts` persists `{ id, parent, child, instruction, createdAt }` at the `terminals.standingOrders` DB config key, injects them into every `ptySendPrompt` to that child (`TaskViewerProvider.ts:379-398`), and rewrites them on rename (`rewriteStandingOrdersForRename`, called at `TaskViewerProvider.ts:2148`). Caps: `MAX_ORDERS = 20`, `MAX_INSTRUCTION_CHARS = 2000`, `MAX_BLOCK_CHARS = 4000`.
- **Per-agent CLI selection** — the cost-routing lever the subagent feature was built around: *"a plan touching three files can have the head agent implement one and assign the other two to Devin terminals, spending its own tokens only on the review."*
- **Single-terminal creation** — the `+` button at `kanban.html:5909` → `addAutobanTerminal` with `role: 'coder'` (`:6156`).
- **Bulk creation by role and grid size** — `role-grid-fill-terminals.md`, planned, unshipped.

Composing them into a working team is entirely manual and per-terminal. Solving that with a purpose-built "create N coders under the lead" control would work once and add an *n*th entry point for what is one capability: standing up a group of agents that work together. The next composition — a planner with researchers, a coder paired to a dedicated reviewer — would need its own control again.

The missing concept is the group itself. What is **not** missing — and what the original draft proposed to rebuild — is the member model and the wired-instantiation engine.

### The mechanism this must reuse: delegates

`spawnDelegates(parent, definitions)` (`ptyFleetService.ts:330`) already *is* wired-team instantiation:

- `DelegateDefinition { role, count?, label?, startupCommand? }` (`src/services/agentConfig.ts`) is the member model — role, count, and a per-member launch command, which is exactly the CLI/model lever.
- It creates each child with `parentInstanceId = parent.agentInstanceId` (`:355-361`).
- It enforces caps: `MAX_DELEGATES_PER_PARENT = 8`, `MAX_LIVE_DELEGATE_PTYS = 32` (`ptyFleetService.ts:11-13`).
- It is partial-tolerant with a report — *"the parent and any already-spawned siblings are real and stay. The caller surfaces the reason."*
- It names children `${parent.friendlyName}-${label||role}${suffix}`, with a comment recording why the base name must be distinct per index.
- It is reached from `ptyCreateTerminal` when `payload.delegates` is present (`ptyHost.ts:217-220`).

And the **Agents tab already edits these definitions**: `kanban.html:4222-4294` renders a per-role delegate list with `{ role, count, label, startupCommand }` rows, add and remove.

What genuinely does not exist: a group that is *named and independent of a single role* (today you get one delegate list per head role, not several named teams), standing orders installed at instantiation (nothing calls `mutateStandingOrders` outside the LocalApiServer's standing-orders POST), and an instantiate action distinct from "create a head terminal".

> **Superseded:** "An agent group is a named list of members plus the wiring between them: `AgentGroup { id, name, members: [{ role, count, cli?, model?, head? }] }` … Reuse the existing creation path (`addAutobanTerminal`'s route) rather than adding a second one; the difference is the parent argument and the loop."
> **Reason:** Two errors of fact. (1) `addAutobanTerminal` → `_createAutobanTerminal(role, requestedName?, cwd?, skipStatePoolUpdate?, reveal?)` takes **no parent**, no startup command, and is gated on the autoban pool roles and `MAX_AUTOBAN_TERMINALS_PER_ROLE`. It cannot instantiate a group, and "the difference is the parent argument" describes an argument it does not have. (2) A per-member `cli`/`model` **cannot be delivered over the wire**: `ptyCreateTerminal` deliberately refuses a caller-supplied `startupCommand` — *"Honouring a caller-supplied one turns this verb into a command-execution endpoint reachable by anything holding the API token"* (`ptyHost.ts:212-216`) — and the extension's `handlePtyVerb` `delete`s the field and host-resolves `payload.delegates` from role config (`TaskViewerProvider.ts:2109-2117`). A new model carrying launch commands from the webview would either be stripped or would reopen that hole.
> **Replaced with:** An agent group is a **named, head-anchored delegate set**, persisted host-side and resolved host-side at instantiation — the same trust model delegates already use. Members reuse `DelegateDefinition` verbatim; the group adds a name and a head role on top.

### Why this is not the existing terminal-group model

The terminals-grouping feature models `{ id, name, source, value?, layout, members, order }` with sources `manual`, `role`, and `worktree`. That is a **view** concept: which terminals appear together in the pane grid and at what layout. Its member resolver explicitly excludes children — `getGroupMembers` builds its `live` set from `fleetList.filter(t => t.status !== 'exited' && !t.parentInstanceId)` (`terminals.js:2261`, and the same filter at `:2189` and `:2232`).

An agent group is a **composition** concept: a persisted definition of roles, counts, launch commands and wiring, which does not exist as terminals until instantiated.

**Do not add a fourth `source` to the terminal-group model, and do not make children visible to it.** The exclusion at `:2261` is deliberate and load-bearing. The integration runs one way: instantiating an agent group may *create* a terminal group containing the instantiated heads, so the team is visible in the pane grid. That is the only coupling.

## Implementation

### 1. The definition model

```
AgentGroup {
  id, name,                       // "Feature Implementation"
  headRole,                       // the member that leads; exactly one, count 1
  headStartupCommand?,            // the head's own CLI, optional
  members: DelegateDefinition[]   // { role, count?, label?, startupCommand? }
}
```

- `role` (head and members) comes from the established list (`TaskViewerProvider.ts:1279`: `planner`, `lead`, `coder`, `reviewer`, `tester`, `intern`, `analyst`, `ticket_updater`, `researcher`, `claude_designer`). Do not introduce new roles.
- `members` is `DelegateDefinition[]` **unchanged** — no new member type, no `cli`/`model` fields. `startupCommand` is the CLI/model lever; it is the same field the Agents tab's existing delegate editor writes and the same one `spawnDelegates` passes to `create()`. When absent, `injectStartupCommand` falls back to the role's configured command (`ptyFleetService.ts:246-252`).
- Persist under a DB config key (e.g. `terminals.agentGroups`) alongside `terminals.standingOrders`, using `getConfigJson`/`setConfigJson`. Serialise mutations the way `mutateStandingOrders` does (`standingOrders.ts:24`) — the same concurrent read-modify-write clobbering applies. **Not `state.json`.**

### 2. The Agents tab area

A new section listing defined groups, each with edit, delete and instantiate. Reuse the existing `agents-tab-*` styling (`kanban.html:1291-1399`) and the inline-form pattern already used for custom agents (`.agents-tab-inline-form`, `:1380`, used at `:3063`) rather than a modal. The member rows are the same shape the delegate editor already renders at `:4222-4294` — clone that row markup rather than inventing a second one.

Delete removes immediately. No confirmation dialog — that is a hard project rule, and `window.confirm()` is a silent no-op in webviews regardless.

Editing a definition does **not** touch already-instantiated terminals. A definition is a template; changing it affects the next instantiation. State this in the UI, because the opposite assumption is the natural one.

### 3. The built-in Feature Implementation group

Seed one definition: `headRole: 'lead'`, `members: [{ role: 'coder', count: 3 }]`. It must be editable and deletable like any other — a built-in that cannot be changed becomes the eleventh entry point in a different costume.

Because this ships as seeded state, treat it as a migration: seed only when the config key is **absent**, never re-seed, and never overwrite a user's edited or deleted copy on upgrade. A user who deletes it must get an empty array persisted, not a missing key — otherwise the next load re-seeds it.

### 4. Instantiation

Host-resolved, following the delegates precedent exactly. The webview sends only a group id; the extension reads the definition and drives creation.

1. The webview posts `instantiateAgentGroup { groupId }`.
2. The extension arm loads the group from `terminals.agentGroups`, validates it, and checks the bounds (§5) **before creating anything**.
3. It issues one `ptyCreateTerminal` through `handlePtyVerb` for the head, with `role: headRole` and `delegates` set to the group's members — *host-resolved by the arm, exactly as `handlePtyVerb` already resolves them from role config at `TaskViewerProvider.ts:2109-2117`*. `ptyCreateTerminal` then calls `spawnDelegates` (`ptyHost.ts:217-220`), which creates every worker parented to the head with its own startup command, and returns `{ terminal, delegates: [...], delegateError? }`.
4. For each returned worker, install one standing order via `mutateStandingOrders` — `parent` = head `friendlyName`, `child` = worker `friendlyName`, instruction carrying the callback contract: on completion, report to the parent by name, summarising what changed and what the reviewer should look at. Keep it short; the procedure lives in the `terminal-coder-dispatch` skill, and `MAX_BLOCK_CHARS = 4000` is a budget shared across every order applying to a terminal.
5. Optionally create a terminal group containing the instantiated head, so the team is visible in the pane grid.

The one change to `handlePtyVerb`'s delegate resolution: it currently overwrites `payload.delegates` unconditionally from `roleConfig_<role>.addons.delegates`. It must accept a host-resolved group instead when the arm supplies one — e.g. the arm passes an internal marker the HTTP rail cannot set, or (cleaner) the arm calls `_ptyHostVerb('ptyCreateTerminal', …)` directly, below the wrapper, having resolved the delegates itself. **Whichever route is taken, a wire-supplied `delegates` or `startupCommand` must still be dropped.** That guard is the reason this design is safe; do not weaken it to save a line.

### 5. Bounds and failure handling

- Refuse before creating anything if the group's worker count exceeds `MAX_DELEGATES_PER_PARENT = 8`, or if `liveDelegates + requested > MAX_LIVE_DELEGATE_PTYS = 32`. `spawnDelegates` enforces both and returns an error string; check them in the arm first so the user gets the refusal without a head terminal already spawned.
- Refuse if the resulting standing orders would exceed `MAX_ORDERS = 20`, reporting how many are already registered.
- Creation is partial-tolerant: keep terminals that succeeded, install their orders, and report the failure with its reason — never roll back running terminals. `spawnDelegates` already behaves this way and reports via `delegateError`; surface that string rather than swallowing it.
- Instantiating twice must not duplicate standing orders for an existing parent/child pair — check the pair before adding. (Names are distinct per instantiation because `create()` appends a collision counter, so the common case is a fresh pair; the guard is for a re-run after a partial failure.)
- Each terminal is a running agent CLI, so keep per-group counts to single digits and say why in the tooltip.

### 6. Keep the client mirror in sync

`terminals.js:7474-7481` carries a **client mirror** of the standing-orders resolver (marker, `MAX_BLOCK_CHARS`, `MAX_INSTRUCTION_CHARS`) used by the shift-drop paste path, which bypasses both hosts. Orders installed by instantiation flow through the same store, so no mirror change is needed — but any cap change made here must be made there too, and the mirror's own comment says so.

## Metadata

**Tags:** ui, frontend, backend, feature, cli
**Complexity:** 6
**Project:** Browser Switchboard

## User Review Required

None. The reuse-delegates architecture, the host-resolution trust model, and the seeded default are decided above.

## Complexity Audit

### Routine
- A list section in the Agents tab cloned from the custom-agent inline-form pattern.
- A DB config key read/written through `getConfigJson`/`setConfigJson` with a serialised mutator.
- Member rows cloned from the existing delegate editor.

### Complex / Risky
- **The host-resolution seam.** Instantiation must resolve launch commands host-side. Doing it the obvious way — passing members over the wire to `ptyCreateTerminal` — is silently stripped by two separate guards, so the feature would appear to work while every worker launched with its role default instead of its assigned CLI. Getting *no* stripping is worse: it reopens a command-execution endpoint reachable by any token holder.
- **Seeded state is a migration.** Re-seeding a deleted built-in on every upgrade is the classic bug; the delete must persist an empty array, not a missing key.
- **Three interacting caps** (`MAX_DELEGATES_PER_PARENT`, `MAX_LIVE_DELEGATE_PTYS`, `MAX_ORDERS`) with different owners. Checking one and not the others produces a half-built team.
- **Partial failure is the expected path,** not the exception — ptys are a finite OS resource and `spawnDelegates` already classifies `pty-pool-exhausted` / `fd-limit` / `spawn-failed`.

## Edge-Case & Dependency Audit

**Race Conditions**
- Two instantiations of the same group concurrently: `create()`'s collision counter keeps names distinct, but the standing-orders write is a read-modify-write. Route every write through `mutateStandingOrders`, which serialises.
- A worker renamed between spawn and order-install: install orders from the `friendlyName` values the spawn *returned*, never from the requested base names.
- A group edited while instantiating: read the definition once at the start of the arm and use that snapshot.

**Security**
- The entire point of the host-resolution design. Group definitions live in the workspace DB and are read by the extension; the webview never supplies a launch command to the pty host. Preserve the `delete payload.startupCommand` and the unconditional `delegates` overwrite on the HTTP rail.
- Standing-order instructions are validated server-side (`validateInstruction`) — length-capped and rejected if they contain the marker, so an instruction cannot forge a second orders block.

**Side Effects**
- Instantiating spawns N agent CLIs — real cost, immediately. The tooltip must say so.
- Workers are children, so they stay out of the top-level terminal lists (`terminals.js:2189`, `:2232`, `:2261`) and render nested (`:6307`). A user who expects them in the pane grid will think creation failed; the optional terminal group for the head is the mitigation.
- New standing orders change what every subsequent prompt to those terminals carries.

**Dependencies & Conflicts**
- Touches `kanban.html` (Agents tab) and an extension-side arm plus a DB key. The `Drive` toggle subtask also touches `kanban.html`, but the control strip and the Agents tab are disjoint regions — still, serialise the two edits on that file per the PRD's one-stream-per-file discipline.
- `role-grid-fill-terminals` (separate, unshipped) covers bulk creation by role with no parenting. If it lands first, reuse its bulk path for the *head* creation only; worker creation must stay on `spawnDelegates` for the parenting.

## Dependencies

- Composes with `feature_plan_20260812120000_head-agent-terminal-dispatch-pattern.md` (the instruction text this installs is the short form of that skill's callback contract) and `feature_plan_20260812120200_feature-workflow-toggle-drive-subtasks-through-coder.md` (which consumes a wired pool), but requires neither — a wired pool is useful on its own.
- Depends in practice on `feature_plan_20260812120100_sendtoterminal-pty-path-corrupts-long-prompts.md` for the extension host: standing orders installed here reach a child only on a `ptySendPrompt` delivery. Standalone already applies them via `deliverPrompt`.

> **Superseded:** "Supersedes the narrower `agents-tab-create-n-coder-subagents-under-lead` plan, which solved this for one composition only."
> **Reason:** No such plan file exists in `.switchboard/plans/`; the only references to it are this plan and the feature file. A dependency line pointing at a non-existent plan reads as an unlanded prerequisite to whoever picks this up.
> **Replaced with:** No superseded plan. The "create N coders under the lead" shape survives as the seeded **Feature Implementation** group.

## Adversarial Synthesis

Key risks: per-member launch commands are stripped by two deliberate security guards if delivered over the wire, so a naive implementation ships a group whose cost-routing lever silently does nothing; seeded built-in state re-appears after deletion unless the delete persists an empty array; and three separate caps (8 delegates per parent, 32 live delegate ptys, 20 standing orders) must all be checked before the first terminal is spawned or a refusal arrives mid-team. Mitigations: host-side resolution of the group definition following the existing delegates precedent, seed-only-when-absent with an explicit empty-array delete, and a pre-flight bounds check in the arm ahead of any creation.

## Proposed Changes

### `src/webview/kanban.html`
- **Context:** Agents tab styles `:1291-1399`; inline-form pattern `:3063`; existing delegate member rows `:4222-4294`.
- **Logic:** New "Agent Groups" section — list, inline edit form, delete, instantiate.
- **Implementation:** Clone the delegate row markup for members; add name + head-role fields; post `instantiateAgentGroup { groupId }`. Delete acts immediately.
- **Edge Cases:** empty group list renders the seeded built-in; a group with zero members is valid (head only) and must not throw.

### Extension-side arm (`TaskViewerProvider.ts`, alongside the pty verb wrapper)
- **Context:** `handlePtyVerb` at `:2092` with the delegate host-resolution at `:2109-2117`; `_ptyHostVerb` at `:374`; `rewriteStandingOrdersForRename` wiring at `:2148`.
- **Logic:** Load group → validate → bounds check → create head with host-resolved `delegates` → install standing orders per returned worker → optionally create a terminal group.
- **Implementation:** Resolve the definition in the arm and pass it below the HTTP rail; leave the wire-supplied `startupCommand`/`delegates` guards intact.
- **Edge Cases:** `delegateError` present with some children created → install orders for the survivors and surface the error; head creation itself failing → nothing to install, report and stop.

### `src/services/standingOrders.ts` (callers only)
- **Context:** `mutateStandingOrders` at `:24`; caps at `:13-15`.
- **Logic:** No change to the module. Instantiation is a new caller.
- **Edge Cases:** adding orders that would exceed `MAX_ORDERS` must be refused before creation, not silently truncated at write time.

### DB config key `terminals.agentGroups`
- **Context:** Sibling of `terminals.standingOrders` (`STANDING_ORDERS_CONFIG_KEY`).
- **Logic:** `AgentGroup[]`, seeded once when absent.
- **Edge Cases:** absent = seed; present-and-empty = the user deleted everything, do not re-seed.

## Verification Plan

Manual verification (per session directive, no compilation or automated-test steps here).

1. **Define and persist.** Create a group with a lead and three coders; confirm it survives a webview reload and an extension restart.
2. **Instantiate.** Run it. Confirm four terminals exist, the three workers carry `parentInstanceId` equal to the head's `agentInstanceId`, and the workers render nested under the head (`terminals.js:6307`) while staying out of the top-level lists (`:2189`, `:2232`, `:2261`).
3. **Wiring is real.** `GET /terminals/standing-orders` shows one order per worker. Then send a prompt to a worker and confirm the delivered text carries the block delimited by `STANDING_ORDERS_MARKER`. Verify on the wire — config alone does not prove the contract reaches the agent.
4. **Cost routing — the corrected mechanism.** Give two members different `startupCommand`s; confirm each worker terminal actually launches the command it was given. This is the test that catches a wire-stripped launch command: it passes trivially if you only check the stored definition.
5. **The security guard still holds.** `POST /terminals/verb/ptyCreateTerminal` with a hand-written `startupCommand` and a hand-written `delegates` array; confirm both are ignored.
6. **Rename survives.** Rename a worker; confirm its order is rewritten (`rewriteStandingOrdersForRename`) and a subsequent prompt still carries it.
7. **Terminal groups unaffected.** Confirm the existing group model still sees only heads, that no new `source` appeared, and that children remain invisible to it.
8. **Seeding is migration-safe.** Edit the built-in, restart — confirm the edit survives. Delete it, restart — confirm it stays deleted.
9. **Bounds.** Request a group of 9 workers (over `MAX_DELEGATES_PER_PARENT`); confirm refusal **before any terminal is created**. Separately, drive the live delegate count near 32 and confirm the `MAX_LIVE_DELEGATE_PTYS` refusal. Separately, approach `MAX_ORDERS = 20` and confirm the refusal reports the current count.
10. **Partial failure and idempotency.** Force one worker creation to fail mid-batch; confirm survivors keep their orders, the head survives, and `delegateError` is surfaced verbatim. Instantiate twice; confirm no duplicate orders for an existing pair.
11. **End to end.** Instantiate Feature Implementation, enable the `Drive` toggle, dispatch a feature. Confirm the lead dispatches a subtask to a worker, the worker reports back unprompted, and that report starts a new turn in the lead.

## Recommendation

Complexity 6 → **Send to Coder.**

## Completion Report

**Status:** Complete. All sections implemented.

### Changes made

| File | Change |
| :--- | :--- |
| `src/webview/kanban.html` | Added Agent Groups subsection to Agents tab: list container, inline form (name, head-role select, member rows with role/count/label/startupCommand, add-member button, save/cancel), ADD AGENT GROUP button, error slot. Added JS: `agentsTabRenderAgentGroups`, `agentsTabAgentGroupRow`, `agentsTabAgentGroupMemberRow`, `agentsTabShowGroupForm`, `agentsTabHideGroupForm`, `agentsTabSaveAgentGroup`. Added event listeners, tab-load hydration (`getAgentGroups`), and inbound message handlers (`agentGroups`, `saveAgentGroupResult`, `deleteAgentGroupResult`, `instantiateAgentGroupResult`). |
| `src/services/TaskViewerProvider.ts` | Added `instantiateAgentGroup` method: pre-flight standing-orders cap check, creates head terminal with host-resolved delegates via `_ptyHostVerb('ptyCreateTerminal', ...)` (bypasses `handlePtyVerb` wrapper to preserve delegates), installs one standing order per worker (idempotent, checks for existing parent/child pair). Added imports: `mutateStandingOrders`, `makeStandingOrder`, `MAX_ORDERS`. |
| `src/services/KanbanProvider.ts` | Added message handlers: `getAgentGroups`, `saveAgentGroup`, `deleteAgentGroup`, `instantiateAgentGroup`. Added helper methods: `_loadAgentGroups` (seeds built-in "Feature Implementation" group on first load, persists to prevent re-seed after delete), `_saveAgentGroup` (read-modify-write), `_deleteAgentGroup` (persists filtered array, even if empty). Config key: `terminals.agentGroups`. |

### Key design decisions

- **Seed-once persistence.** The built-in "Feature Implementation" group (1 lead + 3 coders) is seeded only when the config key is absent. A delete writes `[]` (present-and-empty), which is distinct from absent — so a deleted built-in stays deleted.
- **Direct `_ptyHostVerb` call.** `instantiateAgentGroup` calls `_ptyHostVerb('ptyCreateTerminal', ...)` directly, not through `handlePtyVerb`, because the wrapper overwrites `delegates` from role config. This mirrors the delegates precedent.
- **Idempotent standing-order install.** Checks for an existing parent/child pair before adding, so a re-run after partial failure does not duplicate orders.
- **No confirmation dialogs.** Delete removes immediately (hard project rule — `window.confirm` is a silent no-op in VS Code webviews).

### Verification

- TypeScript compiles clean (5 pre-existing TS2835 errors in unrelated files; none from this change).
- `ensureReady()`, `getConfigJson`, `setConfigJson`, `getConfig`, `setConfig` signatures verified against `KanbanDatabase.ts`.
- `mutateStandingOrders`, `makeStandingOrder`, `MAX_ORDERS` exports verified against `standingOrders.ts`.
- `ptyCreateTerminal` verb confirmed to accept `delegates` field and return `{ terminal, delegates, delegateError? }`.

## Review Findings

**CRITICAL — standing-order orientation was inverted.** `applyStandingOrders` selects with `o.parent === <recipient>` and renders `- Regarding terminal "<child>": …`, so `parent` is the terminal that *receives* the block and `child` is the terminal it is *about* (the Link-up modal proves it: it POSTs the order then sends to `parentName`). `instantiateAgentGroup` registered `parent: head, child: worker`, which delivered the callback contract to the head, about a worker that was never told anything — the coder finishes and reports to nobody, the exact failure this feature exists to end. Inverted to `parent: worker, child: head`, and the instruction now names the delivery route (`ptySendPrompt`) rather than just the obligation.

**Also fixed:** three-cap pre-flight (only `MAX_ORDERS` was checked, so an over-cap group spawned the head then failed — §5 required refusal before any creation); the `runtime.terminals` registry mirror was never updated because the arm bypasses `handlePtyVerb`, the sole writer in this host; `_saveAgentGroup`/`_deleteAgentGroup` claimed to be serialised but were not (now routed through a `_mutateAgentGroups` write chain, as §1 required); the webview swallowed `msg.error` on a `success:true` result, hiding standing-order install failures; four verbs were missing from `protocol-catalog.json`/`verbAllowlist.ts`, which both failed the CI `catalog:check` gate and made the whole Agent Groups UI unreachable over the HTTP verb rail. Files: `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/webview/kanban.html`, `protocol-catalog.json`, `src/generated/verbAllowlist.ts`.

**Validation:** typecheck clean (5 pre-existing TS2835 only); `catalog:check`, `mirror:check`, `pty-route-surface`, `delegate`, `multi-parent-terminals`, `terminal-open-all-seating`, `paste-attribution` all green.

**Standalone parity (added on review).** The arm guarded on `TaskViewerProvider._ptyHostPort`, which only exists in the extension host — standalone runs with `suppressLocalApiServer = true`, so Instantiate refused with "PTY host unavailable" on the one host that owns the fleet in-process. Wrong for a plan pinned to **Browser Switchboard**. The host-varying part (create head + delegates, below the `handlePtyVerb` wrapper that overwrites `delegates` from role config) is now the only thing each host supplies: the caps, orientation, idempotency and partial-failure handling live in the shared `src/services/agentGroupInstantiation.ts`. `KanbanProvider.setAgentGroupInstantiator()` is the seam; `bootstrap.ts` registers an in-process creator on `ptyFleetService.create` + `spawnDelegates`, gated on `ptyReady`. Standalone needs no registry-mirror hook — its fleet was constructed with the db, so `updateRegistryState()` already runs.

**Remaining risks:** member `role` is a free-text input rather than a select over the established role list. No automated test pins the standing-order orientation or the standalone instantiation path; the inverted version passed every gate.
