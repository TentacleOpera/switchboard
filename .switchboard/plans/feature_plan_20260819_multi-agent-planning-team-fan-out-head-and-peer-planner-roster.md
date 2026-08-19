# Multi-Agent Planning Team — Fan-Out Head Prompt and Peer-Planner Roster

## Goal

Make the **Multi-agent planning** team actually plan as a team: give the head a fan-out `headPrompt` so it dispatches one investigation angle per member before writing anything, AND replace the researcher+analyst roster with three peer planner seats so the topology is "several planners draft the same problem in parallel and the head reconciles" — not "one planner with a research pool." Both changes target the same shipped `SHIPPED_TEAM_TYPES` entry and the same adopted-fork migration path, so they ship as one plan.

### Problem analysis and root cause

**1. The shipped team type declares no `headPrompt`.**

`SHIPPED_TEAM_TYPES` (`src/webview/kanban.html:4643-4711`) holds three entries. Only `Coding` (`:4660-4693`) carries a `headPrompt`. The `Multi-agent planning` entry (`:4694-4710`) declares `name`, `headRole`, `members`, `purpose` and `prompt` — and stops. `wireSpawnedTeam` installs the head-facing standing order **only** when a non-empty `headPrompt` arrives (`src/services/teamWiring.ts:1172-1186`). No `headPrompt` → no `team-head` row → `selectOrders` (`src/services/standingOrders.ts:182-219`) has nothing to deliver to the head. The head is a plain planner terminal with delegates attached.

**2. The head's only head-facing instruction actively tells it to plan alone.**

The two researcher members declare `relationship: 'researcher'` — a `head-receives` preset (`src/services/linkPresets.ts:56-65`), so `wireSpawnedTeam` installs a pair order **on the head** about each researcher, carrying: *"When you hit a question that needs external sources… Do not block on it."* A planner that can open files hits no such question. **The head planning alone is the shipped instruction being followed correctly.**

**3. The roster is the wrong shape for parallel planning.**

`Multi-agent planning` is `Batch planners` (planner head + 1 researcher) with one more researcher and an analyst. Both are "a planner that can ask other agents for information." The `researcher` relationship is conditional and non-blocking — the wrong contract for a peer who produces a draft plan you must wait for and reconcile. The team was authored by picking a *bigger roster* rather than a *different topology*.

**4. The member-side prompt is real but unreachable.**

The team prompt says "Investigate the problem from your angle… Report your findings to `{child}` for fan-in synthesis into a single plan." It is installed as one `team`-scoped standing order and rendered onto prompts the member receives. Nobody ever sends a member a prompt (the head doesn't fan out), so the text never renders and the member never acts. The fan-in half is wired; the fan-out half does not exist.

**Net:** the team has fan-in wiring on its members and nothing on its head. The answer to "when is this meant to actually do what it's supposed to" is: never, as shipped.

### Design decisions

**The head prompt discovers its members at runtime.** The head prompt must not hardcode member roles or counts — the roster is operator-editable in the TEAMS tab. Member names are deterministic (`spawnDelegates` builds every per-team member as `` `${parent.friendlyName}-${d.label || d.role}${suffix}` ``, `src/standalone/ptyFleetService.ts:518-526`), so the head enumerates its own members from `ptyListTerminals` by the `<head>-` name prefix. `{head}` is substituted with the live head name at install time (`teamWiring.ts:1181`).

**Three `planner` seats, `scope: 'per-team'`, `relationship: 'reports-to-head'`.** Each seat plans the same problem from its own angle and reports its draft; the head reconciles the drafts into one plan. A `planner` member does not recursively spawn a planner team — the auto-start recursion guard is `!payload.parentInstanceId && !payload._isTeamMember` (`TaskViewerProvider.ts:2867`); per-team members are parented by construction. `planner` already exists in every role array, has a prompt, a kanban column order, a visibility toggle and a startup-command slot — no new role is needed.

**Known limitation.** A member seat runs the role's configured startup command unless its definition carries its own. `DelegateDefinition.startupCommand` exists on the stored member shape and is honoured end to end, but the TEAMS-tab member editor does not expose it (a separate sibling plan addresses that). So after this change the three seats run whatever CLI the `planner` role is configured with.

**One migration step, not two.** Both changes (headPrompt addition + roster replacement) target the same adopted-fork migration path. Running them as separate steps creates a hard ordering dependency (the headPrompt recogniser checks the old `prompt`, which the roster migration changes). One step that sets `headPrompt` AND replaces `members`/`purpose`/`prompt` eliminates the ordering problem entirely.

## Metadata

**Complexity:** 5
**Tags:** bugfix, feature, backend, frontend
**Project:** Browser Switchboard
**Feature:** 581e210f-5a92-44e4-ab6e-7c46b12d17f7

## User Review Required

No user review required — the design is self-contained (runtime member discovery via existing `ptyListTerminals` API, roster reuse of existing `planner` role), the migration is additive-and-replace following the existing exact-value recogniser discipline, and no new wire surface or UI control is introduced.

## Complexity Audit

### Routine

- Replacing the `members`, `purpose`, `prompt` fields AND adding the `headPrompt` field on one object literal in `SHIPPED_TEAM_TYPES` — one edit, not two.
- Adding constants to `teamWiring.ts`: `MULTI_AGENT_PLANNING_HEAD_PROMPT`, `MULTI_AGENT_PLANNING_HEAD_PROMPT_CLIENT` mirror in `terminals.js`, `OLD_MULTI_AGENT_PLANNING` (old state), `MULTI_AGENT_PLANNING_MEMBERS`/`PURPOSE`/`PROMPT` (new state) — the exact pattern already used for `NEW_CODING_HEAD_PROMPT` / `OLD_SEEDED_AGENT_GROUP`.
- Rendering: the flow diagram derives nodes from `headRole` + `members[]` with no per-role special-casing (`teamsTabRenderFlow`, `kanban.html:4912-5061`), and `teamsTabPortraitId` (`:4735-4742`) already maps `planner` to `#portrait-planner`. Three planner nodes draw with no change.
- Extending `standing-orders-marker-contract.test.js` with the new mirror pairs and shipped/host equality assertions.

### Complex / Risky

- **Three copies of the head-prompt string, enforced by a test, not by a comment.** The head-prompt text must exist in `teamWiring.ts` (host), `terminals.js` (client mirror, because the webview cannot import TS), and `kanban.html` (`SHIPPED_TEAM_TYPES`, byte-identical to the host constant). Getting this wrong is silent: the team wires with one text and the panel renders another. The contract test must assert all three.
- **Adopted forks already on disk get nothing from a `SHIPPED_TEAM_TYPES` edit.** `teamsTabAdoptAndStart` (`kanban.html:5070-5091`) forks the shipped type into `terminals.agentGroups` at USE time. Every install that already adopted this team has a persisted copy with the old roster and no `headPrompt`. A definition migration is required, following the existing exact-value recogniser discipline (`isUntouchedOldCodingTeam` → `migrateAgentGroups` step 1b, `teamWiring.ts:468-496`): match an untouched fork, leave an operator-edited one alone.
- **A roster replacement + headPrompt addition in one step.** The recogniser matches on exact equality of every field the shipped type set (`name`, `headRole`, `members`, `purpose`, `prompt`) AND `!headPrompt`. If any one differs, do nothing. An operator who changed a count, a scope, a relationship, the prompt, or who authored their own `headPrompt` keeps their team unchanged.
- **Stale `team`-scoped standing order.** A team started with the old roster has a `team`-scoped standing order carrying the old researcher member prompt, keyed on `(scope: 'team', teamId)`. `wireSpawnedTeam` (`:1155-1165`) checks `if (!teamExists)` and skips installing the new team prompt when the old row already exists. `selectOrders` (`:197-206`) delivers the `team`-scoped order to any member of the group regardless of instruction content. So after a restart, the new planner members would receive the OLD researcher prompt instead of the new peer-planner prompt. A read-site order migration (following the `migrateCodingTeamOrders` pattern, `:1425-1469`) is required to rewrite the stale `team`-scoped instruction at read time.
- **A team that is currently running does not pick this up until it is restarted.** The `team-head` standing order is written at wire time. `wireSpawnedTeam` is idempotent on `(scope, teamId)`: the member `team` row is skipped as existing, and the missing `team-head` row is installed. So a restart is a complete fix, and it costs one click. `startTeamById` refuses a second live head (`:810-820`) — restarting means closing the existing head first.
- **Head-role collision is unchanged and must stay unchanged.** Both planner teams still claim `planner`; `migrateAgentGroups` step 3 still resolves it. Do not "fix" the collision here.
- **Do not invent a new agent role.** `planner` already exists in every role array.
- **No confirm gate, no new UI.** Nothing in this plan adds a control.

## Edge-Case & Dependency Audit

**Zero members.** A head started with no members must not sit waiting for reports that will never arrive. The prompt ends with an explicit instruction to say so and plan alone. `ptyListTerminals` returning only the head is the ordinary case for a member-less team, not an error.

**A member dies mid-run.** `ptyListTerminals` reports `status`; a dispatched member that exits never reports. The prompt instructs the head to say in the plan which angle went unanswered rather than silently dropping it.

**Shared-scope members.** A member with `scope: 'shared'` is named `` `${teamName}-${label||role}` `` (`ptyFleetService.ts:474-477`), NOT `` `${headName}-…` ``. When the team name and the head name differ, the `<head>-` prefix walk misses shared members. Today's Multi-agent planning roster is all `per-team`, so this does not bite; the prompt instructs the head to treat the team's registered group membership as authoritative when the prefix walk finds fewer members than expected.

**Name collisions.** `create()`'s collision counter falls back to `${role}-${n}` rather than `${friendlyName}-${n}` (`ptyFleetService.ts:519-521`), so a colliding member can end up outside the `<head>-` prefix. The head is told to fall back to reporting what it found rather than guessing.

**Standing-order delivery gap — raw pastes bypass it.** `applyStandingOrders` runs on prompts routed through `ptySendPrompt` / the panel's drop path / board dispatch. A memo typed or pasted directly into the xterm pane goes over the raw input socket and carries no standing-orders block. The head prompt lands when the operator drops the memo on the pane, sends it from the panel, or dispatches from the board — and does not land on a bare keyboard paste. This is a pre-existing property of the standing-orders mechanism, shared by every team including Coding, and is out of scope here.

**Migration recogniser false-negatives are safe, false-positives are not.** The recogniser matches on `name === 'Multi-agent planning'` AND `headRole === 'planner'` AND `!headPrompt` AND exact equality of `members`, `purpose`, and `prompt`. A renamed, re-rostered, or re-prompted team is skipped and keeps working exactly as today. Nothing is deleted by this migration; it replaces the roster and adds a field.

**Shipped-state rule.** `terminals.agentGroups` is released state with adopted rows on real installs, so the change to it is a migration, not a clean break. The migration is idempotent: after the rewrite the fork no longer matches the old-value recogniser.

**Layout.** `layoutForTeamSize` (`teamWiring.ts:110-115`) picks the smallest rung with `slots >= members.length`. Head + 3 members = 4 names → `2x2`, the same rung the old roster (head + 3 members) produced. No layout change.

**Member naming.** `spawnDelegates` names per-team members `` `${parent.friendlyName}-${d.label || d.role}${suffix}` `` (`ptyFleetService.ts:518-526`), and with `count > 1` the suffix is `-1..-3`. So seats are `<head>-planner-1`, `-2`, `-3`. Distinct, deterministic, and prefixed by the head name — which is what the head-side member discovery depends on.

**`plannerTerminalCount` is unrelated.** `agents.plannerTerminalCount` (`terminals.js:6891`) controls how many plain planner terminals `OPEN AGENT TERMINALS` creates. It is not read by the team path and is not changed.

**Flow-diagram edges.** Edges are typed by `relationship` (`teamsTabRenderFlow`). Dropping the two `researcher` members removes their distinct-labelled edges; three `reports-to-head` seats draw three member→head edges. The `Coding` team's 3 × coder already exercises this case.

**Security.** No new wire surface. The head prompt instructs the head to call `ptyListTerminals` and `ptySendPrompt`, both already reachable by every fleet terminal. No team definition crosses the wire.

## Dependencies

- No session dependencies. The plan builds on existing wiring (`wireSpawnedTeam` headPrompt installation path), existing migration patterns (`migrateAgentGroups` exact-value recogniser discipline), existing read-site order migration patterns (`migrateCodingTeamOrders`), and existing test patterns (`standing-orders-marker-contract.test.js` byte-identity assertions).
- **Sibling dependency:** The "Team Member Seats Can Run Their Own Agent CLI" plan exposes `startupCommand` in the TEAMS-tab member editor. This plan's three planner seats run the `planner` role's configured CLI until that sibling plan lands. The two plans are independent (different files, different surfaces) and can land in either order.

## Adversarial Synthesis

Key risks: the three-copy byte-identity contract for the head prompt is enforced only by a test (silent drift if skipped); the stale `team`-scoped standing order carries the old researcher prompt and is NOT replaced on restart because `wireSpawnedTeam` skips existing team rows (mitigated by a read-site order migration following the `migrateCodingTeamOrders` pattern); the head prompt assumes the head's agent CLI can make HTTP POST calls (a pre-existing platform constraint shared with the Coding team); and the roster change alone does not make the team fan out — the head prompt is what activates the roster. Mitigations: the contract test asserts all three copies; the read-site migration rewrites the stale instruction at read time; the HTTP-call assumption is documented in the prompt text; and both changes ship in one plan so the roster and head prompt activate together.

## Proposed Changes

### `src/webview/kanban.html` — the shipped type (both changes in one edit)

Replace the `Multi-agent planning` entry (`:4694-4710`):

```js
            {
                name: 'Multi-agent planning',
                headRole: 'planner',
                // Peer planners, not a research pool. Three planner seats draft the
                // SAME problem independently; the head reconciles the drafts. A
                // planner member cannot recursively spawn a planner team — the
                // auto-start guard is `!parentInstanceId && !_isTeamMember`
                // (TaskViewerProvider.ts:2867) and members are parented by
                // construction.
                members: [
                    { role: 'planner', count: 3, scope: 'per-team', relationship: 'reports-to-head' }
                ],
                purpose: 'Three planners draft the same problem independently; the head reconciles the drafts into one plan.',
                prompt: '{child} is your head agent. When you finish a task, report to it — POST /terminals/verb/ptySendPrompt with '
                    + '{"name":"{child}","data":"<your report>","clearBeforePrompt":false} against the port in '
                    + '.switchboard/api-server-port.txt — naming what you changed and what to review. Do not wait to be asked.\n'
                    + 'You are one of several planners working the same problem from different angles. Draft your own '
                    + 'plan for the angle you were given — read the code, trace the dependencies, name the root cause '
                    + 'and the risks — and report it to {child}, which reconciles every draft into one plan. Do not '
                    + 'coordinate with the other planners and do not write the final plan yourself.\n'
                    + 'Never run work-discarding or history-rewriting commands: git reset (--hard/--mixed), git checkout `<path>` / git restore, '
                    + 'git clean, git stash drop/clear, force pushes, or branch/worktree deletion. If you make a mistake, do not discard — '
                    + 'commit first, then correct forward.',
                // Fan-out head prompt: the head discovers its members at runtime
                // via ptyListTerminals (roster-agnostic), dispatches one angle per
                // member, waits for reports, then synthesises ONE plan. Byte-identical
                // to MULTI_AGENT_PLANNING_HEAD_PROMPT in teamWiring.ts and to
                // MULTI_AGENT_PLANNING_HEAD_PROMPT_CLIENT in terminals.js — pinned
                // by standing-orders-marker-contract.test.js.
                headPrompt: 'You lead this team and you do not write the plan alone. When you are given something to '
                    + 'plan — a memo, a ticket, a bug report, a request — split it into one investigation angle '
                    + 'per member and hand each member its own angle BEFORE you write anything. '
                    + 'Find your members first: read the port from .switchboard/api-server-port.txt, POST '
                    + '/terminals/verb/ptyListTerminals with {} and take the active terminals whose '
                    + 'friendlyName starts with "{head}-". Dispatch to each by name with POST '
                    + '/terminals/verb/ptySendPrompt with {"name":"<member>","data":"<that member\'s angle>",'
                    + '"clearBeforePrompt":false}. Each member is a separate agent that cannot see this '
                    + 'conversation, so every dispatch must state the problem, that member\'s angle, and what '
                    + 'to report back, standing on its own. Give different members different angles — never '
                    + 'the same question twice. Then wait for their reports and synthesise them into ONE plan, '
                    + 'naming which findings came from which member. If a member never reports, say so in the '
                    + 'plan rather than dropping its angle quietly. If you have no members, say so and plan alone.'
            }
```

`teamsTabAdoptAndStart` already forwards `headPrompt` (`:5077`: `...(type.headPrompt ? { headPrompt: type.headPrompt } : {})`) and the editor form already round-trips it (`:5278-5279`, `:5335`, `:5347`) — no other change is needed in this file beyond the shipped-type entry.

### `src/services/teamWiring.ts` — constants (old state + new state + head prompt)

Beside `OLD_SEEDED_AGENT_GROUP` (`:240-245`) and `NEW_CODING_HEAD_PROMPT` (`:275-293`):

```ts
/**
 * The PRE-change `Multi-agent planning` shipped state, preserved verbatim for
 * the migration comparison. Every install that adopted the team before this
 * change has this exact roster/purpose/prompt persisted in
 * `terminals.agentGroups` with no `headPrompt`. Stored, never reconstructed by
 * string-building at match time. The `analyst` member carries
 * `relationship: 'reports-to-head'` even though the shipped literal omitted it
 * — migrateAgentGroups step 2 stamps that default on every member on first
 * read, so what is actually on disk has it.
 */
const OLD_MULTI_AGENT_PLANNING: { members: any[]; purpose: string; prompt: string } = {
    members: [
        { role: 'researcher', count: 2, scope: 'per-team', relationship: 'researcher' },
        { role: 'analyst', count: 1, scope: 'per-team', relationship: 'reports-to-head' },
    ],
    purpose: 'Fan-in investigation: multiple agents research from different angles, then synthesize.',
    prompt: /* the shipped pre-change member prompt, verbatim */,
};

/** The post-change roster/purpose/prompt — byte-identical to the kanban.html entry. */
export const MULTI_AGENT_PLANNING_MEMBERS: ReadonlyArray<any> = [
    { role: 'planner', count: 3, scope: 'per-team', relationship: 'reports-to-head' },
];
export const MULTI_AGENT_PLANNING_PURPOSE = 'Three planners draft the same problem independently; the head reconciles the drafts into one plan.';
export const MULTI_AGENT_PLANNING_PROMPT = /* byte-identical to the kanban.html entry */;

/**
 * The Multi-agent planning team's `headPrompt` — fan-out-then-synthesise.
 *
 * Roster-agnostic by construction: the head enumerates its own members from
 * `ptyListTerminals` by the `<head>-` name prefix that `spawnDelegates`
 * guarantees (ptyFleetService.ts:518-526). `{head}` is substituted with the
 * live head name by `wireSpawnedTeam` (:1181).
 *
 * Byte-identical to the shipped `headPrompt` in kanban.html's Multi-agent
 * planning entry and to MULTI_AGENT_PLANNING_HEAD_PROMPT_CLIENT in
 * terminals.js — pinned by standing-orders-marker-contract.test.js.
 */
export const MULTI_AGENT_PLANNING_HEAD_PROMPT =
    'You lead this team and you do not write the plan alone. When you are given something to '
    + 'plan — a memo, a ticket, a bug report, a request — split it into one investigation angle '
    + 'per member and hand each member its own angle BEFORE you write anything. '
    + 'Find your members first: read the port from .switchboard/api-server-port.txt, POST '
    + '/terminals/verb/ptyListTerminals with {} and take the active terminals whose '
    + 'friendlyName starts with "{head}-". Dispatch to each by name with POST '
    + '/terminals/verb/ptySendPrompt with {"name":"<member>","data":"<that member\'s angle>",'
    + '"clearBeforePrompt":false}. Each member is a separate agent that cannot see this '
    + 'conversation, so every dispatch must state the problem, that member\'s angle, and what '
    + 'to report back, standing on its own. Give different members different angles — never '
    + 'the same question twice. Then wait for their reports and synthesise them into ONE plan, '
    + 'naming which findings came from which member. If a member never reports, say so in the '
    + 'plan rather than dropping its angle quietly. If you have no members, say so and plan alone.';

/**
 * A substitution-independent fragment unique to the OLD `Multi-agent planning`
 * member prompt (the researcher/analyst text). The new peer-planner prompt does
 * not contain it, so a rewritten row is never re-matched. Used by the read-site
 * order migration — {child} was already substituted with the head name at
 * install time, so match on a fragment that does not contain it.
 */
export const OLD_MULTI_AGENT_PLANNING_PROMPT_FRAGMENT = 'Investigate the problem from your angle';
```

### `src/services/teamWiring.ts` — migration step 1d (headPrompt + roster in one transform)

Add a step 1d to `migrateAgentGroups`, after the Coding-team step 1c (`:514`):

```ts
        // Step 1d: retopologise an untouched adopted `Multi-agent planning`
        // fork — add the fan-out headPrompt AND replace the research-pool
        // roster with three peer planner seats, in one transform. Doing both
        // in one step eliminates the ordering dependency that two separate
        // steps would create (the headPrompt recogniser checks the old
        // `prompt`, which the roster replacement changes). Exact-value match
        // on name + headRole + roster + purpose + prompt + absent headPrompt;
        // any operator edit fails the match and the team is left exactly as
        // authored. Same discipline as step 1b's Coding-team conversion.
        if (isUntouchedMultiAgentPlanningTeam(g)) {
            g = {
                ...g,
                headPrompt: MULTI_AGENT_PLANNING_HEAD_PROMPT,
                members: MULTI_AGENT_PLANNING_MEMBERS.map(m => ({ ...m })),
                purpose: MULTI_AGENT_PLANNING_PURPOSE,
                prompt: MULTI_AGENT_PLANNING_PROMPT,
            };
            changed = true;
            console.log(
                `[teamWiring] Migration: retopologised untouched Multi-agent planning team `
                + `'${g.id || g.name}' — 2× researcher + analyst → 3× planner + fan-out headPrompt.`
            );
        }
```

with the recogniser beside `isUntouchedOldCodingTeam` (`:726`):

```ts
/**
 * Recognise an adopted `Multi-agent planning` fork the operator has not
 * touched. Every field the shipped type set must match exactly — a changed
 * count, scope, relationship, purpose, prompt, or an operator-authored
 * headPrompt means the operator owns this team and it is left alone.
 * Deep-compares members by JSON so a re-ordered or extended member object
 * fails the match rather than being silently replaced.
 */
function isUntouchedMultiAgentPlanningTeam(g: any): boolean {
    if (!g || typeof g !== 'object') { return false; }
    if (g.name !== 'Multi-agent planning' || g.headRole !== 'planner') { return false; }
    if (typeof g.headPrompt === 'string' && g.headPrompt.trim()) { return false; }
    if (g.purpose !== OLD_MULTI_AGENT_PLANNING.purpose) { return false; }
    if (g.prompt !== OLD_MULTI_AGENT_PLANNING.prompt) { return false; }
    return JSON.stringify(g.members) === JSON.stringify(OLD_MULTI_AGENT_PLANNING.members);
}
```

### `src/services/teamWiring.ts` — read-site order migration for the stale `team`-scoped row

Beside `migrateCodingTeamOrders` (`:1425-1469`), add:

```ts
/**
 * Migrate stale Multi-agent planning team-scoped standing orders on read.
 *
 * The `team`-scoped order carries the member prompt and is keyed on
 * (scope: 'team', teamId). wireSpawnedTeam skips installing a new team row
 * when one already exists for the teamId (:1155-1165), so after a roster
 * change + restart the old researcher prompt persists and is delivered to the
 * new planner members by selectOrders (:197-206). This migration rewrites the
 * instruction to the new peer-planner prompt at read time, before
 * applyStandingOrders renders.
 *
 * Pure: no DB writes. Idempotent: the rewritten instruction no longer contains
 * the old fragment. Applied at the same read sites as migrateCodingTeamOrders.
 */
export function migrateMultiAgentPlanningOrders(orders: StandingOrder[]): StandingOrder[] {
    if (!Array.isArray(orders) || orders.length === 0) { return orders; }
    const rewritten: StandingOrder[] = [];
    const drop = new Set<string>();
    let touched = false;
    for (const o of orders) {
        if (!o || typeof o !== 'object') { continue; }
        if (o.scope === 'team' && typeof o.instruction === 'string'
            && o.instruction.indexOf(OLD_MULTI_AGENT_PLANNING_PROMPT_FRAGMENT) !== -1) {
            const newInstruction = MULTI_AGENT_PLANNING_PROMPT
                .replace(/\{child\}/g, o.parent || '');
            rewritten.push({ ...o, instruction: newInstruction });
            drop.add(o.id);
            touched = true;
            continue;
        }
    }
    if (!touched) { return orders; }
    return [
        ...orders.filter(o => o && !drop.has(o.id)),
        ...rewritten,
    ];
}
```

Wire it into the same read sites that call `migrateCodingTeamOrders` — search for `migrateCodingTeamOrders(` call sites and add `migrateMultiAgentPlanningOrders(` in the same pipeline.

### `src/webview/terminals.js` — client mirror

Beside `NEW_CODING_HEAD_PROMPT_CLIENT` (`:8871-8895`):

```js
    /**
     * Mirror of MULTI_AGENT_PLANNING_HEAD_PROMPT in teamWiring.ts. Exists
     * because the webview cannot import TypeScript modules; byte-identity is
     * pinned by standing-orders-marker-contract.test.js.
     */
    var MULTI_AGENT_PLANNING_HEAD_PROMPT_CLIENT = /* byte-identical text */;
```

No client-side order-migration function is added for the `team-head` row: there is no stale row to rewrite (the `team-head` row is absent, not wrong). The `migrateMultiAgentPlanningOrders` read-site migration handles the stale `team`-scoped row on the host side; the client mirror's `applyStandingOrdersClient` needs no new branch for it (the host-side migration runs before the client sees the orders).

### `src/test/standing-orders-marker-contract.test.js` — pin all copies

Add assertions that:

1. `MULTI_AGENT_PLANNING_HEAD_PROMPT` (teamWiring.ts) and `MULTI_AGENT_PLANNING_HEAD_PROMPT_CLIENT` (terminals.js) are byte-identical.
2. The `Multi-agent planning` entry in `SHIPPED_TEAM_TYPES` (kanban.html) declares a `headPrompt` and it equals the host constant.
3. `MULTI_AGENT_PLANNING_PROMPT` and `MULTI_AGENT_PLANNING_PURPOSE` in `teamWiring.ts` are byte-identical to the `prompt` and `purpose` of the `Multi-agent planning` entry in `kanban.html`.
4. The entry's `members` array deep-equals `MULTI_AGENT_PLANNING_MEMBERS`.
5. `OLD_MULTI_AGENT_PLANNING.prompt` equals the shipped entry's pre-change `prompt` — otherwise the migration recogniser silently stops matching.

### `src/test/team-autostart-workspace-scope.test.js` — migration coverage

Add to the `migrateAgentGroups` block:

- an untouched `Multi-agent planning` fork is retopologised to `[{ role: 'planner', count: 3, scope: 'per-team', relationship: 'reports-to-head' }]` AND gains `headPrompt`, and keeps its `id`, `startOnLoad` and any unknown keys;
- the same fork with `count: 3` on the researchers, or a changed `prompt`, or a changed `name`, or an operator-authored `headPrompt`, is returned **byte-identical**;
- running the converter twice is a no-op on the second pass (idempotency).

## Verification Plan

**Automated**

1. `node src/test/standing-orders-marker-contract.test.js` — all byte-identity and shipped/host equality assertions pass.
2. `node src/test/team-autostart-workspace-scope.test.js` — the new migration cases pass and every existing case still passes (seed neutralisation, Coding steps 1b/1c, member-shape defaults, head-role collisions).
3. `npx tsc --noEmit -p tsconfig.json` — no type errors from the new exports.

**Manual (installed VSIX)**

4. **Fresh install / never adopted.** Board → TEAMS. The `Multi-agent planning` card's roster strip reads `PLANNER · 3 PLANNER`. Click it: the flow diagram draws one head planner and three member planners with three member→head edges, no researcher or analyst node.
5. **Adopt and start.** `USE` the card, then start the team from the terminals panel. Four terminals: `Multi-agent planning`, `Multi-agent planning-planner-1`, `-2`, `-3`. Grid is `2x2`.
6. **No recursion.** Confirm exactly four terminals exist — no member spawned a team of its own.
7. **Member prompt lands.** Send a prompt to `-planner-1` from the panel. Its `=== STANDING ORDERS ===` block carries the peer-planner text ("You are one of several planners working the same problem…"), not the researcher preset.
8. **Head prompt lands.** In the terminals panel, drop a memo/plan prompt on the head's pane (the drop path, not a raw keyboard paste). Read the delivered text: it ends with a `=== STANDING ORDERS ===` block containing the fan-out instruction.
9. **The team actually fans out.** Give the head a real memo. Expected: the head calls `ptyListTerminals`, then posts a distinct angle to each member terminal by name; each member's pane shows its own dispatch; each member reports back to the head; the head's plan names which member found what. This is the acceptance test — a plan written with no member dispatches is a failure.
10. **Existing install migrates.** On a build with the old roster, adopt the team so an untouched fork is on disk. Upgrade, reload, open the TEAMS tab. The adopted card's roster strip now reads `PLANNER · 3 PLANNER`; its `id` and any `START ON LOAD` setting are preserved. Start the team and confirm the `team-head` row appears in `GET /terminals/standing-orders`.
11. **Stale team-scoped order is rewritten.** After step 10, send a prompt to `-planner-1` from the panel and read its `=== STANDING ORDERS ===` block — it must carry the NEW peer-planner text ("You are one of several planners…"), NOT the old researcher text ("Investigate the problem from your angle…"). This proves the read-site `team`-scoped order migration fired.
12. **Operator edit is respected.** On the old build, adopt the team and change the researcher count to 3. Upgrade and reload: the team must still read `PLANNER · 3 RESEARCHER · 1 ANALYST`, untouched.
13. **Member-less team.** Edit the adopted team to have zero members, start it, and hand it a memo. It must say it has no members and plan alone — not hang waiting for reports.

## Recommendation

**Complexity: 5 → Send to Coder.** The change is one shipped-type edit (roster + headPrompt) plus one migration step (both transforms in one recogniser-gated step) plus one read-site order migration. All three follow exact existing patterns (`NEW_CODING_HEAD_PROMPT`, `isUntouchedOldCodingTeam`, `migrateCodingTeamOrders`). The three-copy contract and the stale-order migration are the only non-trivial parts, and both have direct precedents. Merging the two original subtasks into one plan eliminated the step-numbering collision, the recogniser name collision, the duplicated old-prompt constant, and the hard ordering dependency.
