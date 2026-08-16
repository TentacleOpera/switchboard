# Coding team: give the head a standing order to advance finished subtasks to CODE REVIEWED

## Goal

The shipped "Coding" team already ships a reviewer as its last member, but nothing ever
hands work to it. Members are told to report to the head; the head is told nothing at
all. So a subtask gets coded, the coder reports back, and the card sits in `CODER CODED`
forever unless a human drags it. The reviewer seat is live, idle, and unaddressed.

Close the loop: give the team's head its own standing order — advance each finished
subtask's card to `CODE REVIEWED` through the board's advance-and-dispatch endpoint,
which is the same action a human's drag performs and the action that fires the reviewer
role's prompt.

### Problem analysis

**The team already has the reviewer.** `src/webview/kanban.html:4445-4460` — the shipped
`Coding` team type:

```js
{
    name: 'Coding',
    headRole: 'lead',
    members: [
        { role: 'coder', count: 3, scope: 'per-team' },
        { role: 'reviewer', count: 1, scope: 'shared', relationship: 'reviewer' }
    ],
    purpose: 'Works a feature\'s subtasks one at a time.',
    prompt: '{child} is your head agent. When you finish a task, report to it — POST /terminals/verb/ptySendPrompt …'
        + 'Work your assigned subtask to completion. The shared reviewer reviews finished work before it ships.'
        + …GIT_SAFETY…
}
```

Reviewer is last in the array, so it is already "at the end" of the team. The claim in
the prompt — *"The shared reviewer reviews finished work before it ships"* — is currently
a promise nothing keeps.

**Why the head is silent.** `wireSpawnedTeam` (`src/services/teamWiring.ts:600-749`)
installs exactly one `team`-scoped standing order per team, carrying `team.prompt`. The
head name is stored in that order's `parent` field for the express purpose of *excluding*
it — `selectOrders` in `src/services/standingOrders.ts:104-112`:

```ts
        if (scope === 'team') {
            if (!o.teamId) { return false; }
            const group = groups.find(g => g && g.id === o.teamId);
            if (!group || !Array.isArray(group.members)) { return false; }
            // Exclude the head — the team prompt is for members only. The
            // head name is stored in `o.parent` by wireSpawnedTeam.
            if (o.parent && targetName === o.parent) { return false; }
            return group.members.includes(targetName);
        }
```

That exclusion is correct — the member prompt ("report to your head") is nonsense
delivered to the head — but it leaves **no channel at all for head-directed team
instructions**. There are only three scopes today: `global` (everyone, every team),
`team` (members, head excluded), `pair` (one terminal about one other). None of them is
"the head of this team".

`pair` is not a substitute: it renders as `- Regarding terminal "X": …`, is keyed to a
specific live child, and would have to be duplicated per child. The instruction here is
about the *board*, not about a sibling terminal.

**Root cause.** A missing scope. `team` was defined as "members-only" and the head-facing
half was never built, so a team definition has one prompt field and it can only reach
members.

**Why the endpoint matters.** The head must use `POST /kanban/dispatch`, not
`POST /kanban/move`. `_handleKanbanMove` (`LocalApiServer.ts:1355`) delegates to the
`moveCard` callback, which persists the column change and syncs trackers — **and
dispatches nothing**. `POST /kanban/dispatch` → `performKanbanDispatch`
(`LocalApiServer.ts:1225-1333`) resolves the target column's role (`CODE REVIEWED` →
`reviewer`, per `KanbanProvider._columnToRole`), persists the move, *and fires that
role's prompt* (`LocalApiServer.ts:1295`). The orchestration skill already names it the
preferred call. An instruction that says "move the card" instead of "dispatch the card"
produces a silently idle reviewer — the exact bug being fixed.

## Metadata

- **Complexity:** 6
- **Tags:** feature, backend, ux
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 5
> **Reason:** The improve pass found two additional mandatory surfaces the original scoring did not price in: the team editor form silently destroys `headPrompt` on the first save after adoption (see Proposed Change 3b — this is data loss on the shipped USE flow, not optional polish), and the head prompt must be threaded through **three** `wireSpawnedTeam` call sites, one of which reads a wire-supplied payload field and must be written defensively. Eight files, a widened persisted type on ~4,000 installs, and two hand-mirrored resolvers is the top of the "Mixed" band, not the middle.
> **Replaced with:** **Complexity:** 6 — routing is unchanged (Send to Coder), but the risk register is larger than a 5.

## User Review Required

None. Every open choice in this plan was decided during the improve pass and is recorded
inline:

- The new scope is `team-head`, not a mutation of `team` (old-build safety — see
  Edge-Case audit 1).
- The shipped `Coding` `headPrompt` carries `"from":"{head}"` from day one, so the
  companion routing plan never has to edit this string (see Edge-Case audit 12).
- The team editor gains a Head prompt field; it is mandatory, not optional
  (Proposed Change 3b).

## Complexity Audit

### Routine

- Adding a `headPrompt` string field to the shipped `Coding` team definition.
- Adding a second `makeStandingOrder(...)` call in `wireSpawnedTeam`.
- Extending the shipped-team-prompt contract test to cover the new field.

### Complex / Risky

- **Adding a scope value to a shipped, persisted type.** `StandingOrderScope` is written
  into the `terminals.standingOrders` DB config key on ~4,000 installs. A new value must
  degrade safely when read by an older extension build: see the compatibility analysis in
  the edge-case audit below. This is why the new scope must be `'team-head'` and must NOT
  be implemented by mutating the semantics of the existing `'team'` value.
- **Two mirrored resolvers.** `selectOrders` in `src/services/standingOrders.ts:93-116`
  has a hand-written client mirror in `src/webview/terminals.js:8588`
  (`applyStandingOrdersClient`). Updating one and not the other means the head's order
  renders on the backend dispatch path and silently vanishes on the terminals-panel paste
  path (or vice versa). Both must land together.
- **Silent loss of `headPrompt` in the team editor.** `teamsTabSaveAgentGroup`
  (`kanban.html:4773-4826`) **reconstructs** the group object from form fields
  (`{ id, name, headRole, members, ...(promptText ? { prompt } : {}) }`) and
  `_saveAgentGroup` (`KanbanProvider.ts:4555-4563`) replaces the stored row wholesale
  (`next[idx] = group`). Any top-level key the form does not read is destroyed on save.
  The USE button opens that editor immediately on adoption
  (`kanban.html:4564: teamsTabShowGroupForm(forked)`), so the first Save after adopting
  the Coding team wipes the head prompt. This is the reason Change 3b is mandatory.
- **Three `wireSpawnedTeam` call sites, not two**, and one of them threads the prompt
  through a **wire-supplied payload object** (`TaskViewerProvider.ts:2830` reads
  `payload.teamPrompt`). See Proposed Change 2b for the write-it-unconditionally rule
  that keeps that from becoming a standing-order injection vector.
- **Prompt-text single source of truth.** `src/test/standing-orders-marker-contract.test.js`
  pins the shipped team prompts against `GIT_SAFETY_DIRECTIVE` and
  `AGENT_GROUP_CALLBACK_INSTRUCTION`. The new head text is a *fourth* hand-copy site
  unless it is pinned too.
- **Idempotency of `wireSpawnedTeam`.** It is documented as safe to re-run; the existing
  team order is skipped on `(scope, teamId)`. The head order must use the same
  `(scope, teamId)` key so a re-run does not install a duplicate.

## Edge-Case & Dependency Audit

### Race Conditions

- **Concurrent team starts.** Both the team order and the head order are pushed inside
  the *same* `mutateStandingOrders` mutator, which runs on the module-level
  `_writeChain` (`standingOrders.ts:39-58`). Two heads starting at once therefore
  serialise; there is no read-modify-write window between the two pushes. Do not split
  them into two `mutateStandingOrders` calls — that would reintroduce one.
- **Head order installed after the head's first prompt.** `wireSpawnedTeam` is awaited by
  every caller before the create response returns (`TaskViewerProvider.ts:2825-2846`,
  `bootstrap.ts:1284-1294`), so the head cannot receive a prompt before its order exists.

### Security

- **`payload.teamPrompt` is wire-shaped.** On the extension host, the team prompt reaches
  `wireSpawnedTeam` through `payload`, which originates on the wire. Today it is safe by
  accident: `delegates` is overwritten unconditionally to `[]` (`TaskViewerProvider.ts:2625`)
  so the post-create wiring hook only fires when the auto-start block repopulated it, and
  that same block sets `teamPrompt: match.team.prompt` **unconditionally inside the spread**
  (`:2676`) — including to `undefined` — which overwrites any caller-supplied value. The
  head prompt MUST be added the same way (`teamHeadPrompt: match.team.headPrompt`, always
  written, never spread-conditionally). A conditional `...(x ? { teamHeadPrompt: x } : {})`
  would let a wire-supplied head prompt survive into a standing order that is delivered to
  a lead on every message. See Proposed Change 2b.

### Side Effects

- **The head gains a permanent prompt suffix.** Every message to a `Coding` head grows by
  the head order. This is the intended effect, but it is unconditional — it is not gated
  on the card state, and the head cannot turn it off short of editing the team.
- **No behaviour change for any other team.** Only `Coding` gets a `headPrompt`; the head
  order is installed only when a non-empty `headPrompt` is present (audit item 4).

### Dependencies & Conflicts

1. **Old-build compatibility for `scope: 'team-head'`.** An older extension reading a
   `team-head` order falls through `selectOrders`'s `global` and `team` branches to the
   final `pair` return: `o.parent === targetName && o.child !== undefined && liveNames.has(o.child)`.
   Writing the head order with `child: ''` makes `liveNames.has('')` false, so an old
   build **silently ignores** it rather than mis-delivering it. Verified against the
   shipped source at `standingOrders.ts:114`. The same fall-through holds in the client
   mirror (`terminals.js:8615`). This is the reason the head order must carry `child: ''`,
   not the head name. **Verify this explicitly** — it is the whole migration story.
2. **No data migration required.** Existing installs simply have no `team-head` order.
   They gain one the next time a team is started (`wireSpawnedTeam` is idempotent and
   runs on every team start). Nothing is rewritten, nothing is deleted. Existing
   `team`-scoped orders keep their exact current meaning.
3. **Teams started before this change.** Their `terminals.standingOrders` has the member
   order but no head order. Because `wireSpawnedTeam` keys idempotency on
   `(scope, teamId)` and the head order is a *different* scope, restarting the team
   installs the head order without duplicating the member order. No special-case needed.
4. **A team with no `headPrompt`.** Custom teams and the two other shipped teams (Batch
   planners, Multi-agent planning) have no `headPrompt`. `wireSpawnedTeam` must install
   the head order **only** when a non-empty `headPrompt` is present — never fabricate a
   default. A planner head told to advance cards to CODE REVIEWED would be actively wrong.
5. **`SEEDED_AGENT_GROUP` is member-less** (`teamWiring.ts:121-126`). `wireSpawnedTeam`
   early-returns `{ ok: true }` when `children.length === 0` (`:606-608`), so a bare lead
   never gets the head order — correct, there is no team to hand off to.
6. **The head's own name in the order.** `renderOrder` (`standingOrders.ts:124-133`)
   emits every non-`pair` scope as a plain `- <instruction>` line with no "Regarding
   terminal" framing, so `team-head` needs no render change on either side. Do not reuse
   the pair framing.
7. **Cards not owned by this team.** The instruction is scoped to *the subtasks the head
   dispatched*, and must say so — a head that advances every card it can see would sweep
   another team's work into review.
8. **Relationship to the routing work.** Once the head calls `POST /kanban/dispatch` with
   `CODE REVIEWED`, the board resolves the `reviewer` role workspace-wide and may pick
   another team's reviewer. That is a separate, independently shippable correctness fix
   (the companion subtask in this feature). This plan is correct and useful on a
   single-team board.

   > **Superseded:** "…and is a strict prerequisite for the routing work; do not conflate them."
   > **Reason:** Backwards. The routing fix also corrects the human drag-and-drop path and
   > the oversight-pass dispatch path, neither of which involves a team head, so it is
   > useful with or without this plan. Calling this a strict prerequisite would serialise
   > two changes that only need to serialise on one shared file.
   > **Replaced with:** The two are **complementary, not ordered by function**. They do
   > share `src/services/teamWiring.ts`, so their merges must serialise (PRD: "one agent
   > stream per provider file"); land this plan first because it is the smaller edit to
   > that file. See the feature file's "Dependencies & sequencing".
9. **No confirm dialogs.** Nothing in this change touches a button; per project rule, do
   not add one. Change 3b adds a textarea, not a gate.
10. **Interpolation token asymmetry — deliberate.** The member `prompt` uses `{child}` to
    mean *the head's* name (a legacy of the pair-order render path, documented at
    `teamWiring.ts:46-51`). The head prompt uses `{head}` to mean *the head's own* name.
    They are different tokens for the same value in different prompts. Do not "unify"
    them — `{child}` in a head prompt would read as the head talking about itself as a
    child, and the member-prompt token is pinned by the contract test.
11. **Dependencies:** `src/services/standingOrders.ts`, `src/services/teamWiring.ts`,
    `src/services/agentGroupInstantiation.ts`, `src/standalone/bootstrap.ts`,
    `src/services/TaskViewerProvider.ts`, `src/webview/terminals.js`,
    `src/webview/kanban.html`, `src/test/standing-orders-marker-contract.test.js`.
    No new packages, no schema change.
12. **The `from` field is written here, read there.** The shipped `headPrompt` includes
    `"from":"{head}"` in its documented POST body from day one. `_handleKanbanDispatch`
    (`LocalApiServer.ts:1199-1217`) reads a fixed set of body keys and ignores unknown
    ones, so an extra `from` is inert until the companion routing plan lands — and the
    moment it lands, every already-started head is already sending it. Writing it later
    would mean re-editing a string this plan owns.

## Dependencies

- None. No prior planning session is a prerequisite for this work.

## Adversarial Synthesis

**Risk summary.** The three real risks are (1) widening a persisted union type read by
~4,000 older builds — mitigated by `child: ''`, which makes an old build's `pair`
fall-through drop the order instead of mis-delivering it, and which is asserted by a
dedicated test rather than assumed; (2) two hand-mirrored resolvers drifting — mitigated
by landing both branches in one change and extending the source-text parity contract test
to pin the new branch on both sides; (3) silent destruction of `headPrompt` by the team
editor's reconstruct-on-save, which is not theoretical — the USE button opens that editor
immediately — mitigated by making the editor field mandatory rather than optional.

## Proposed Changes

### 1. `src/services/standingOrders.ts` — add the `team-head` scope

**Context.** `StandingOrderScope` (`:3`) is a three-value union persisted into
`terminals.standingOrders`. `selectOrders` (`:93-116`) is the only consumer that branches
on it; `renderOrder` (`:124-133`) treats everything that is not `pair` identically.

**Implementation.**

```ts
export type StandingOrderScope = 'global' | 'team' | 'pair' | 'team-head';
```

In `selectOrders`, add a branch immediately after the `team` branch:

```ts
        if (scope === 'team-head') {
            // The mirror image of `team`: this order is FOR the head and nobody
            // else. `o.parent` holds the head name (same field `team` uses for
            // its exclusion check), and `o.child` is deliberately '' so that an
            // older build — which has no case for this scope and falls through
            // to the pair rule — evaluates `liveNames.has('')` and drops the
            // order instead of mis-delivering it.
            if (!o.teamId) { return false; }
            const group = groups.find(g => g && g.id === o.teamId);
            if (!group || !Array.isArray(group.members)) { return false; }
            return !!o.parent && targetName === o.parent && group.members.includes(targetName);
        }
```

Extend the `scopeRank` map (`:174`) so the sort stays total. It is typed
`Record<StandingOrderScope, number>`, so widening the union without touching this line is
a compile error — that is the intended guard, not an oversight:

```ts
    const scopeRank: Record<StandingOrderScope, number> = { global: 0, 'team-head': 1, team: 1, pair: 2 };
```

**Edge cases.** `team` and `team-head` share rank 1 deliberately: a given terminal can
never hold both (the `team` branch excludes the head, the `team-head` branch requires it),
so the tie is unreachable and the stable sort keeps creation order regardless.
`renderOrder` needs no change.

### 2a. `src/services/teamWiring.ts` — install the head order

**Context.** `wireSpawnedTeam` (`:600-749`) already builds the member order inside one
`mutateStandingOrders` mutator (`:674-702`) and derives `groupId` at `:618-619`.

Extend `WireSpawnedTeamOptions` (`:550-575`):

```ts
    /**
     * Prose delivered to the HEAD of the team on every message, as one
     * `team-head`-scoped standing order. Optional: a team with no head prompt
     * installs no head order. Never defaulted — a fabricated head instruction
     * would be wrong for every team whose head is not a coding lead.
     */
    headPrompt?: string;
```

Inside the existing `mutateStandingOrders` mutator, after the team-order push (`:691`)
and before the pair-order loop:

```ts
            // Head-facing order. Keyed on (scope, teamId) exactly like the member
            // order, so a re-run of wireSpawnedTeam skips it rather than duplicating.
            // Same mutator as the team order above — do not split this into a second
            // mutateStandingOrders call; that reopens a read-modify-write window.
            const headPromptText = (opts.headPrompt || '').trim();
            if (headPromptText) {
                const headExists = next.some((o: StandingOrder) =>
                    o.scope === 'team-head' && o.teamId === groupId);
                if (!headExists) {
                    next.push(makeStandingOrder(
                        headName,   // parent = head (the delivery target for this scope)
                        '',         // child = '' — old-build safety, see selectOrders
                        headPromptText.replace(/\{head\}/g, headName),
                        'team-head',
                        groupId,
                    ));
                }
            }
```

**Edge cases.** `headPrompt` absent, empty, or whitespace ⇒ no order (audit item 4).
`children.length === 0` ⇒ the function has already returned at `:606-608`, so no order.

### 2b. Thread `headPrompt` from all three `wireSpawnedTeam` call sites

There are three, not two. All three must forward it or the feature works on one host and
one entry path only.

**(i) `src/services/agentGroupInstantiation.ts:122`** — the explicit-start path
(TEAMS tab → Start). It already has the resolved team definition in hand:

```ts
    const wired = await wireSpawnedTeam({
        db,
        headName,
        children: workers,
        members: Array.isArray(group?.members) ? group.members : undefined,
        prompt: group?.prompt,
        headPrompt: group?.headPrompt,
    });
```

**(ii) `src/standalone/bootstrap.ts:1246-1286`** — the standalone auto-start path. It
already carries the team prompt in a **local**, deliberately not on `payload`
(`:1243-1245` explains why). Mirror that exactly:

```ts
                    let teamPrompt: string | undefined;
                    let teamHeadPrompt: string | undefined;
                    …
                        if (team && memberCount > 0) {
                            payload = { ...payload, delegates: team.members, teamName: team.name };
                            teamPrompt = team.prompt;
                            teamHeadPrompt = team.headPrompt;
                        }
                    …
                        const wired = await wireSpawnedTeam({ db, headName: terminal.friendlyName, children: spawned.children, members: rawDelegates, prompt: teamPrompt, headPrompt: teamHeadPrompt });
```

**(iii) `src/services/TaskViewerProvider.ts:2676` and `:2830`** — the extension-host
auto-start path. This one threads through `payload`, which is wire-shaped. Write the new
field **unconditionally inside the existing spread**, exactly as `teamPrompt` is written,
so a caller-supplied value is always overwritten (see the Security audit):

```ts
                        if (match && memberCount > 0) {
                            // teamHeadPrompt is written UNCONDITIONALLY (undefined included)
                            // — payload is wire-supplied, and this spread is the only thing
                            // that stops a caller from injecting a standing order delivered
                            // to a lead on every message. Never make it conditional.
                            payload = { ...payload, delegates: match.team.members, teamName: match.team.name, teamPrompt: match.team.prompt, teamHeadPrompt: match.team.headPrompt };
                        }
```

```ts
                            const wired = await wireSpawnedTeam({ db, headName, children: result.delegates, members: Array.isArray(payload.delegates) ? payload.delegates : undefined, prompt: payload.teamPrompt, headPrompt: payload.teamHeadPrompt });
```

### 3a. `src/webview/kanban.html` — the Coding team's head prompt

Add a `headPrompt` field to the `Coding` entry in `SHIPPED_TEAM_TYPES` (`:4445-4460`).
Keep `prompt` byte-identical — the contract test pins it:

```js
            {
                name: 'Coding',
                headRole: 'lead',
                members: [
                    { role: 'coder', count: 3, scope: 'per-team' },
                    { role: 'reviewer', count: 1, scope: 'shared', relationship: 'reviewer' }
                ],
                purpose: 'Works a feature\'s subtasks one at a time, then hands each to the team reviewer.',
                prompt: /* unchanged — pinned by standing-orders-marker-contract.test.js */,
                headPrompt: 'You lead this team. When a coder reports a subtask finished and you are '
                    + 'satisfied with it, hand it to review yourself: read the port from '
                    + '.switchboard/api-server-port.txt and POST /kanban/dispatch with '
                    + '{"plan":"<planId>","targetColumn":"CODE REVIEWED","from":"{head}"} — that one '
                    + 'call advances the card and dispatches the reviewer. Do NOT use /kanban/move: it '
                    + 'moves the card and dispatches nobody, so the work stalls unreviewed. Only advance '
                    + 'subtasks this team worked; leave other cards alone. Do not wait to be asked.'
            },
```

`{head}` is substituted with the head's own terminal name by `wireSpawnedTeam`
(Change 2a), so the delivered text names the terminal rather than asking the agent to
work out what it is called. `"from"` is inert until the companion routing plan reads it
(Edge-Case audit 12).

`purpose` is display-only prose (rendered at `:4533`) and is not pinned by any test —
updating it to describe the now-real handoff is safe. The member `prompt` is left
byte-identical; its existing sentence *"The shared reviewer reviews finished work before
it ships"* becomes true once this change lands.

Carry the field through the USE-fork in `teamsTabGalleryCard` (`:4552-4558`):

```js
                const forked = {
                    id: 'group-' + type.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now().toString(36),
                    name: type.name,
                    headRole: type.headRole,
                    members: (type.members || []).map(m => ({ ...m })),
                    ...(type.prompt ? { prompt: type.prompt } : {}),
                    ...(type.headPrompt ? { headPrompt: type.headPrompt } : {})
                };
```

### 3b. `src/webview/kanban.html` — the team editor must read and write `headPrompt` (MANDATORY)

> **Superseded:** "The editor form (`teamsTabShowGroupForm`) reads and writes `prompt`; add the same read/write for `headPrompt` so an operator can edit it" — presented as optional polish alongside the USE-fork change.
> **Reason:** It is not polish; without it the feature is destroyed by its own adoption flow. `teamsTabSaveAgentGroup` (`:4773-4826`) does not merge into the stored group — it **reconstructs** it from form fields (`const group = { id, name, headRole, members, ...(promptText ? { prompt: promptText } : {}) }`, `:4817`), and `_saveAgentGroup` (`KanbanProvider.ts:4555-4563`) writes that object over the stored row (`next[idx] = group`). Any top-level key the form does not read is dropped. The USE handler calls `teamsTabShowGroupForm(forked)` immediately (`:4564`), so the operator lands in that editor the instant they adopt the team; one Save and the head prompt is gone with no error, no warning, and a team that looks correctly configured. The member editor already carries a preservation workaround for exactly this hazard (`label`/`startupCommand`, `:4801-4807`).
> **Replaced with:** Mandatory. Add a Head prompt textarea next to the existing team-prompt textarea, and read/write it on the same two paths.

Markup: add `<textarea id="agent-groups-head-prompt">` immediately after the existing
`agent-groups-prompt` control, labelled "Head prompt (delivered to the team's head only)".

Read path — in `teamsTabShowGroupForm`, beside `:4760-4761`:

```js
            const headPromptEl = document.getElementById('agent-groups-head-prompt');
            if (headPromptEl) { headPromptEl.value = group?.headPrompt || ''; }
```

Write path — in `teamsTabSaveAgentGroup`, at `:4816-4817`:

```js
            const promptText = (document.getElementById('agent-groups-prompt')?.value || '').trim();
            const headPromptText = (document.getElementById('agent-groups-head-prompt')?.value || '').trim();
            const group = {
                id, name, headRole, members,
                ...(promptText ? { prompt: promptText } : {}),
                ...(headPromptText ? { headPrompt: headPromptText } : {}),
            };
```

**Edge case.** A team the operator deliberately clears the head prompt on saves with no
`headPrompt` key, and `wireSpawnedTeam` then installs no head order on the next start.
That is the correct read of the operator's intent — it is the off switch. Existing head
orders from a previous start are not retro-deleted (nothing prunes standing orders); the
operator removes them from the terminals panel if they want them gone. Do not add a
pruning pass for this.

### 4. `src/webview/terminals.js` — mirror the resolver

**Context.** `applyStandingOrdersClient` (`:8588-8637`) is a hand-written mirror of
`selectOrders` + `applyStandingOrders`, living inside the panel IIFE with
`terminalGroups` as a closure variable.

Add the matching branch inside the filter, immediately after the `team` branch (`:8615`):

```js
            if (scope === 'team-head') {
                if (!o.teamId) { return false; }
                var hGroup = terminalGroups.find(function (g) { return g && g.id === o.teamId; });
                if (!hGroup || !Array.isArray(hGroup.members)) { return false; }
                return !!o.parent && targetName === o.parent && hGroup.members.indexOf(targetName) !== -1;
            }
```

and extend `scopeRank` (`:8620`):

```js
        var scopeRank = { global: 0, 'team-head': 1, team: 1, pair: 2 };
```

The render loop's `else` branch (`:8629-8631`) already emits the plain `- <instruction>`
form for any non-`pair` scope, so no render change is needed. Unlike the TypeScript side,
nothing here is type-checked — the `scopeRank` omission would silently produce `NaN` in
the comparator rather than a build error, so this line is the one to double-check.

### 5. `src/test/standing-orders-marker-contract.test.js` — pin the new field

The existing `prompts.length === 3` assertion (`:317-321`) scans with `/prompt:\s*/g`,
which is case-sensitive and therefore does **not** match `headPrompt:` (capital `P`), so
it keeps passing unchanged. Verified against the current test source.

Add a sibling assertion over the same `SHIPPED_TEAM_TYPES` block slice:

- exactly ONE `headPrompt:` exists (only `Coding` has one);
- read it with `readQuotedChain` and assert it contains the literals `/kanban/dispatch`,
  `CODE REVIEWED`, `"from":"{head}"`, and the warning substring `Do NOT use /kanban/move`
  (assert on the presence of the warning, never on the absence of `/kanban/move` — the
  warning necessarily contains it).

## Verification Plan

1. **Unit — `team-head` selection matrix.** Add cases to the existing resolver-behaviour
   block in `standing-orders-marker-contract.test.js`, which transpiles
   `standingOrders.ts` and executes it (`:473-479`). Note that `selectOrders` is
   module-private — drive it through the exported `applyStandingOrders`, as every
   existing case does:
   - A `team-head` order with `parent = 'lead-1'`, `teamId = 'team_lead_1'`, and a group
     whose members are `['lead-1','lead-1-coder-1','Coding-reviewer']`:
     applies to `lead-1`; does **not** apply to `lead-1-coder-1` or `Coding-reviewer`.
   - The existing `team` order for the same team still applies to both members and still
     does **not** apply to `lead-1`. (Proves the two scopes are complements, not overlaps.)
   - A `team-head` order whose `teamId` matches no registered group renders for nobody.
   - Render check: the head order emits `- <instruction>` with **no**
     `Regarding terminal` prefix.
2. **Unit — old-build safety.** Feed a `team-head` order through a copy of the *pre-change*
   `selectOrders` logic (the three-branch version) and assert it selects for nobody. This
   is the compatibility claim for the ~4,000-install base; assert it, do not assume it.
3. **Contract — client mirror parity (source-text).**

   > **Superseded:** "Extend the existing mirror-parity contract test so `applyStandingOrdersClient` and `applyStandingOrders` return byte-identical output for the same inputs across all four scopes."
   > **Reason:** Not achievable as written, and a plan step that cannot be executed is worse than none. `applyStandingOrdersClient` is declared inside the terminals-panel IIFE and closes over `terminalGroups`; it is not exported and there is no harness that evaluates it. The existing "mirror parity" tests are **source-text** assertions (`TERMINALS_JS_SRC.includes(...)`, `:340-348`) precisely because of this. Only the TypeScript module is transpiled and executed (`:473-479`).
   > **Replaced with:** Extend the source-text parity assertions: both files must contain a `team-head` branch, both must gate it on `o.teamId` + group membership + `parent === targetName`, and both `scopeRank` literals must list all four scopes with `'team-head'` and `team` at the same rank. Follow the shape of the existing `'Regarding terminal'` parity test. If executable mirror parity is wanted, that is a separate refactor (extract the mirror into a plain script both the panel and the test can load) — do not attempt it inside this plan.
4. **Unit — `wireSpawnedTeam`.** With an in-memory DB stub:
   - `headPrompt` supplied ⇒ exactly two orders written, one `team` and one `team-head`,
     both with the same `teamId`; the head order has `child === ''` and its instruction
     has `{head}` substituted with the head name.
   - `headPrompt` absent or whitespace ⇒ exactly one order written (`team`). No fabricated default.
   - Re-run with identical args ⇒ still exactly two orders (idempotent on both keys).
   - `children: []` ⇒ zero orders written, `{ ok: true }` returned.
5. **Contract test.** Run `standing-orders-marker-contract.test.js` — the existing
   3-prompt assertion must still pass unchanged, and the new `headPrompt` assertions pass.
6. **Manual — the editor round-trip (the data-loss guard).** Adopt the `Coding` team
   (TEAMS tab → USE). The editor opens on the fork: confirm the Head prompt textarea is
   populated. Press Save without editing anything. Re-open the editor and confirm the head
   prompt is **still there**. This is the exact flow that silently destroys the field
   without Change 3b — run it before believing the feature works.
7. **Manual — end to end.** Start the adopted team and confirm three coders + one
   `Coding-reviewer` come up. Send any prompt to the head and inspect the delivered text:
   it must carry a `=== STANDING ORDERS ===` block containing the `/kanban/dispatch`
   instruction with the head's real name in `"from"`. Send a prompt to a coder: its block
   must contain the member callback text and **not** the head instruction.
8. **Manual — the loop closes.** Dispatch a subtask to the team, let a coder finish and
   report, and confirm the head issues `POST /kanban/dispatch` with
   `targetColumn: "CODE REVIEWED"`, the card lands in CODE REVIEWED, and a reviewer
   terminal receives a review prompt. (On a single-team board this reaches the right
   reviewer; multi-team routing is the companion plan.)
9. **Manual — the other two shipped teams are unchanged.** Adopt "Batch planners" and
   "Multi-agent planning"; confirm their heads receive **no** standing-orders block from
   this feature.
10. **Manual — standalone host.** Repeat step 7 under `npx switchboard` to prove the
    `bootstrap.ts` call site was threaded too. A head order that appears only in the
    extension host is the signature of a missed call site.

---

**Recommendation:** Complexity 6 → **Send to Coder**.

---

## Completion Summary

Implemented the `team-head` standing-orders scope and the Coding team's head prompt across all eight files specified in the plan. The new `'team-head'` scope was added to `StandingOrderScope` in `standingOrders.ts` with a `selectOrders` branch that delivers the order only to the head (`parent === targetName && group.members.includes(targetName)`) and a `scopeRank` entry at rank 1 alongside `team`; the client mirror in `terminals.js` received the identical branch and `scopeRank` literal. `wireSpawnedTeam` in `teamWiring.ts` now accepts an optional `headPrompt` and installs a `team-head`-scoped order (keyed on `(scope, teamId)` for idempotency, `child: ''` for old-build safety, `{head}` interpolated) inside the same `mutateStandingOrders` mutator as the member order. All three call sites — `agentGroupInstantiation.ts`, `bootstrap.ts` (local `teamHeadPrompt`), and `TaskViewerProvider.ts` (unconditional `teamHeadPrompt` write in the wire-supplied payload spread) — now forward `headPrompt`. The shipped Coding team in `kanban.html` carries a `headPrompt` instructing the head to `POST /kanban/dispatch` with `CODE REVIEWED` and `"from":"{head}"`, the USE-fork carries it through, and the team editor form gained a mandatory Head prompt textarea with read/write paths that prevent the reconstruct-on-save data-loss hazard. The contract test pins exactly one `headPrompt` with the required literals, adds source-text parity for the `team-head` branch across both files, and adds executable resolver tests covering the selection matrix, complement-overlap with `team`, unknown-teamId, render framing, and old-build fall-through safety. LocalApiServer.ts was not touched, per the subtask boundary.

## Review Findings

Reviewed 2026-08-16 with tests executed (no skip directive in this dispatch, contrary to the note below). All eight planned source surfaces are present and correct — `team-head` scope + `selectOrders` branch + `scopeRank` (`standingOrders.ts:3,120,193`), the byte-faithful client mirror (`terminals.js:8615,8628`), the head-order install keyed on `(scope, teamId)` with `child: ''` (`teamWiring.ts:704-717`), all three call sites (`agentGroupInstantiation.ts:122`, `bootstrap.ts:1270,1289`, `TaskViewerProvider.ts:2708,2862` written unconditionally in the spread), and the `headPrompt` + mandatory editor textarea in `kanban.html:4462,3136,4772,4829`. Two defects were found and fixed, both in `src/test/standing-orders-marker-contract.test.js` — a duplicate `const TEAM_WIRING_SRC` that made the file a SyntaxError (CRITICAL: this suite is CI-wired at `integration-tests.yml:142`, so CI was hard red), and a `team-head` parity assertion anchored on the bare literal, which matches the `StandingOrderScope` union at line 3 and measured its window over type declarations instead of the branch (MAJOR: failed on correct source). Validation: `tsc -p tsconfig.test.json --noEmit` exit 0; `test:contract:standing-orders-marker` 40 passed / 0 failed; adjacent `team-autostart-scope` 8/8; `parity:check`, `catalog:check`, `verb-returns:check`, `push-routing:check` all green; eslint 0 errors. Remaining risks: manual steps 6-10 (editor round-trip, end-to-end delivery, other shipped teams, standalone host) need a live extension and were not run; `POST /terminals/standing-orders` still rejects a `team-head` scope on `add` (`LocalApiServer.ts:2413`) — left as-is deliberately, since no UI offers that scope and widening it would open the wire-injection vector this plan's Security audit guards against.

**Review pass 2.** Two gaps identified by the reviewer are now closed. (1) The `selectOrders` doc comment in `standingOrders.ts` now enumerates all four scopes — the `team-head` bullet describes it as the complement of `team` (applies only when `targetName === o.parent` and that name is in the group's `members` array) and notes the `child: ''` old-build fall-through reason. (2) Verification Plan step 4 is now implemented: `wireSpawnedTeam` is transpiled and executed in `standing-orders-marker-contract.test.js` with an in-memory db stub (`getConfigJson`/`setConfigJson` over a plain object), covering all four cases — (a) headPrompt supplied produces exactly two orders (one `team`, one `team-head`, same `teamId`, head order has `child === ''` and `{head}` substituted); (b) headPrompt absent/empty/whitespace produces exactly one `team` order with no fabricated default; (c) idempotent re-run still produces exactly two orders with no duplicate; (d) `children: []` produces zero orders and returns `{ ok: true }`. The test runner was made async-aware to handle the async `wireSpawnedTeam` calls.
