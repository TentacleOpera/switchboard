# Multi-Agent Planning Head Plans Alone — Give the Team a Fan-Out Head Prompt

## Goal

Make the **Multi-agent planning** team actually fan work out. When the operator hands the head a memo (or a ticket, or a bug report), the head must split it into one investigation angle per member, dispatch each angle to a named member terminal, wait for the reports, and only then synthesise a single plan. Today the head reads the memo and writes the whole plan by itself while its members sit idle at their prompts.

### Problem analysis and root cause

The team spawns correctly — head plus members are real, live terminals — and then behaves exactly like one planner. That is not a spawn defect. It is that **nothing is ever said to the head**.

**1. The shipped team type declares no `headPrompt`.**

`SHIPPED_TEAM_TYPES` (`src/webview/kanban.html:4643-4711`) holds three entries. Only `Coding` (`:4660-4693`) carries a `headPrompt`. The `Multi-agent planning` entry (`:4694-4710`) declares `name`, `headRole`, `members`, `purpose` and `prompt` — and stops:

```js
{
    name: 'Multi-agent planning',
    headRole: 'planner',
    members: [
        { role: 'researcher', count: 2, scope: 'per-team', relationship: 'researcher' },
        { role: 'analyst', count: 1, scope: 'per-team' }
    ],
    purpose: 'Fan-in investigation: multiple agents research from different angles, then synthesize.',
    prompt: '{child} is your head agent. When you finish a task, report to it — POST …'
},
```

`wireSpawnedTeam` installs the head-facing standing order **only** when a non-empty `headPrompt` arrives (`src/services/teamWiring.ts:993-1006`):

```ts
const headPromptText = (opts.headPrompt || '').trim();
if (headPromptText) {
    const headExists = next.some(o => o.scope === 'team-head' && o.teamId === groupId);
    if (!headExists) { next.push(makeStandingOrder(headName, '', headPromptText.replace(/\{head\}/g, headName), 'team-head', groupId)); }
}
```

No `headPrompt` → no `team-head` row → `selectOrders` (`src/services/standingOrders.ts:120-131`) has nothing to deliver to the head. The head is a plain planner terminal with delegates attached.

This is deliberate at the wiring layer and correct there — the comment at `teamWiring.ts:854-859` says a head prompt is "never defaulted — a fabricated head instruction would be wrong for every team whose head is not a coding lead". The gap is that the *fan-in team*, whose entire purpose is a head that fans out, was shipped without the one field that makes a head do anything.

**2. The head's only head-facing instruction actively tells it to plan alone.**

The two researcher members declare `relationship: 'researcher'`. That is a `head-receives` preset (`src/services/linkPresets.ts:56-65`), so `wireSpawnedTeam` (`:942-959`) installs a pair order **on the head** about each researcher, carrying:

> `{child}` is your researcher. When you hit a question that needs external sources, documentation or API details you do not already have, hand it to `{child}` with enough context to work standalone — it cannot see your conversation. Keep working on what you can while it runs, and fold its answer in when it comes back. **Do not block on it.**

Read that as a planner with a repo it can read: it is conditional ("when you hit a question that needs external sources"), it is non-blocking ("do not block on it"), and it is scoped to *external* sources. A planner that can open files hits no such question. **The head planning alone is the shipped instruction being followed correctly.** There is no bug to find in the delivery path — the delivered text says what the head is doing.

**3. The analyst member is invisible to the head.**

The analyst carries no `relationship`, so it defaults to `reports-to-head` (`DEFAULT_MEMBER_RELATIONSHIP`, `linkPresets.ts:123`), which is `member-receives`. Per `wireSpawnedTeam:950-957`, member-receives installs **no pair row at all** — it is carried by the team-scoped order, which is delivered to *members*, with the head explicitly excluded (`standingOrders.ts:111-119`). So the head is never told the analyst exists, and never told its terminal name.

**4. The member-side prompt is real but unreachable.**

The team prompt does say "Investigate the problem from your angle … Report your findings to `{child}` for fan-in synthesis into a single plan." It is installed as one `team`-scoped standing order and rendered onto **prompts the member receives** (`applyStandingOrders`, `standingOrders.ts:166-217`). Nobody ever sends a member a prompt, so the text never renders and the member never acts. The fan-in half of the team is fully wired; the fan-out half does not exist.

**Net:** the team has fan-in wiring on its members and nothing on its head. The answer to "when is this meant to actually do what it's supposed to" is: never, as shipped.

### Design decision — the head prompt discovers its members at runtime

The head prompt must not hardcode member roles or counts. A team's roster is operator-editable in the TEAMS tab, and a prompt that names roles goes stale the moment someone edits the team. Member names are deterministic — `spawnDelegates` (`src/standalone/ptyFleetService.ts:518-526`) builds every per-team member as `` `${parent.friendlyName}-${d.label || d.role}${suffix}` `` — so the head can enumerate its own members from `ptyListTerminals` by the `<head>-` name prefix. `{head}` is substituted with the live head name at install time (`teamWiring.ts:1001`), so the prompt has the prefix it needs.

## Metadata

**Complexity:** 5
**Tags:** bugfix, backend, frontend
**Project:** Browser Switchboard

## User Review Required

No user review required — the design is self-contained (runtime member discovery via existing `ptyListTerminals` API), the migration is additive and idempotent, and no new wire surface or UI control is introduced. The one cross-subtask concern (migration step ordering relative to the roster-retopologise sibling) is handled at the feature-restructuring level, not here.

## Complexity Audit

### Routine

- Adding a `MULTI_AGENT_PLANNING_HEAD_PROMPT` constant to `teamWiring.ts` and a byte-identical `_CLIENT` mirror to `terminals.js` — the exact pattern already used for `NEW_CODING_HEAD_PROMPT` / `NEW_CODING_HEAD_PROMPT_CLIENT` (`terminals.js:8871-8895`).
- Adding the `headPrompt` field to one object literal in `SHIPPED_TEAM_TYPES`.
- Extending `standing-orders-marker-contract.test.js` with the new mirror pair.

### Complex / Risky

- **Three copies of the same string, enforced by a test, not by a comment.** The prompt text must exist in `teamWiring.ts` (host), `terminals.js` (client mirror, because the webview cannot import TS), and `kanban.html` (`SHIPPED_TEAM_TYPES`, byte-identical to the host constant — the same relationship `NEW_CODING_HEAD_PROMPT` documents at `teamWiring.ts:265-273`). Getting this wrong is silent: the team wires with one text and the panel renders another. The contract test is the guard, and it must assert all three.
- **Adopted forks already on disk get nothing from a `SHIPPED_TEAM_TYPES` edit.** `teamsTabAdoptAndStart` (`kanban.html:5070-5091`) forks the shipped type into `terminals.agentGroups` at USE time. Every install that already adopted this team has a persisted copy with no `headPrompt`, and editing the gallery constant does not touch it. A definition migration is required, and it must follow the existing exact-value recogniser discipline (`isUntouchedOldCodingTeam` → `migrateAgentGroups` step 1b, `teamWiring.ts:351-379`): match an untouched fork, leave an operator-edited one alone.
- **A team that is currently running does not pick this up until it is restarted.** The `team-head` standing order is written at wire time. There is nothing on disk to rewrite for a running team — the row is *absent*, not stale — so the read-site `migrateCodingTeamOrders` pattern does not apply. `wireSpawnedTeam` is idempotent on `(scope, teamId)` (`:977-1006`): the member `team` row is skipped as existing, and the missing `team-head` row is installed. So a restart is a complete fix, and it costs one click. This is the accepted answer; do NOT build a mint-the-missing-row read-site transform for it.
- **`startTeamById` refuses a second live head** (`teamWiring.ts:810-820`) — restarting the team means closing the existing head first. That is already the operator's workflow and needs no change, but the verification steps below must close the head or the restart is refused with a message that looks like a new bug.
- **Do not touch the roster.** This plan changes exactly one field on the shipped type (`headPrompt`) plus the migration. Member roles, counts, scopes and relationships stay as they are; the head prompt is written to be roster-agnostic precisely so it stays correct if they change.
- **No confirm gate, no new UI.** Nothing in this plan adds a control.

## Edge-Case & Dependency Audit

**Zero members.** A head started with no members must not sit waiting for reports that will never arrive. The prompt ends with an explicit instruction to say so and plan alone. `ptyListTerminals` returning only the head is the ordinary case for a member-less team, not an error.

**A member dies mid-run.** `ptyListTerminals` reports `status`; a dispatched member that exits never reports. The prompt instructs the head to say in the plan which angle went unanswered rather than silently dropping it — the "half-true completion report" failure mode this codebase has been bitten by before.

**Shared-scope members.** A member with `scope: 'shared'` is named `` `${teamName}-${label||role}` `` (`ptyFleetService.ts:474-477`), NOT `` `${headName}-…` ``. When the team name and the head name differ, the `<head>-` prefix walk misses shared members. Today's Multi-agent planning roster is all `per-team`, so this does not bite; the prompt therefore also instructs the head to treat the team's registered group membership as authoritative when the prefix walk finds fewer members than expected. Head name and team name coincide on the START-TEAM path (`instantiateAgentGroupCore` passes `group.name` as the head name, `agentGroupInstantiation.ts:96-101`), so in practice the prefix resolves both.

**Name collisions.** `create()`'s collision counter falls back to `${role}-${n}` rather than `${friendlyName}-${n}` (noted at `ptyFleetService.ts:519-521`), so a colliding member can end up outside the `<head>-` prefix. The head is told to fall back to reporting what it found rather than guessing.

**Standing-order delivery gap — raw pastes bypass it.** `applyStandingOrders` runs on prompts routed through `ptySendPrompt` / the panel's drop path / board dispatch (`TaskViewerProvider.ts:625-637`, `bootstrap.ts:311`, and the client mirror at `terminals.js:9054`). A memo typed or pasted **directly into the xterm pane** goes over the raw input socket and carries no standing-orders block at all. The head prompt therefore lands when the operator drops the memo on the pane, sends it from the panel, or dispatches from the board — and does not land on a bare keyboard paste. That is a pre-existing property of the standing-orders mechanism, shared by every team including Coding, and is deliberately **out of scope** here: changing it means injecting text into raw terminal input, which is a different and much larger decision. The verification steps below use the panel's drop path.

**Migration recogniser false-negatives are safe, false-positives are not.** The recogniser matches on `name === 'Multi-agent planning'` **and** `headRole === 'planner'` **and** `!headPrompt` **and** `prompt` byte-equal to the shipped member prompt. A renamed or re-prompted team is skipped and keeps working exactly as today. Nothing is deleted by this migration; it only adds a field.

**Shipped-state rule.** `terminals.agentGroups` is released state with adopted rows on real installs, so the change to it is a migration, not a clean break (per the repo's migration rule). The migration is additive — it sets one absent key — and re-running it is a no-op because `!headPrompt` no longer matches.

**Security.** No new wire surface. The head prompt instructs the head to call `ptyListTerminals` and `ptySendPrompt`, both already reachable by every fleet terminal (each is handed the port file and `SWITCHBOARD_API_TOKEN`, `teamWiring.ts:43-45`). No team definition crosses the wire.

## Dependencies

- No session dependencies. The plan builds entirely on existing wiring (`wireSpawnedTeam` headPrompt installation path), existing migration patterns (`migrateAgentGroups` exact-value recogniser discipline), and existing test patterns (`standing-orders-marker-contract.test.js` byte-identity assertions).
- **Cross-subtask ordering dependency (feature-level):** The migration recogniser matches `prompt === MULTI_AGENT_PLANNING_MEMBER_PROMPT` (the OLD shipped member prompt). If the roster-retopologise sibling plan's migration changes `prompt` BEFORE this migration runs, this recogniser stops matching and `headPrompt` is never added to already-adopted forks. This migration MUST run before the roster migration within `migrateAgentGroups`. This is resolved at the feature restructuring level (merge or explicit sequencing).

## Adversarial Synthesis

Key risks: the three-copy byte-identity contract is enforced only by a test (silent drift if the test is skipped); the migration recogniser depends on the OLD `prompt` string, creating a hard ordering dependency with the roster-retopologise sibling; and the head prompt assumes the head's agent CLI can make HTTP POST calls (a pre-existing platform constraint shared with the Coding team, not a new defect). Mitigations: the contract test is the guard and must assert all three copies; the ordering dependency is resolved by merging the two migrations or sequencing them; and the HTTP-call assumption is documented in the prompt text itself (the instructions name the port file and the POST endpoints).

## Proposed Changes

### `src/services/teamWiring.ts` — add the head-prompt constant

Beside `NEW_CODING_HEAD_PROMPT` (`:275-293`):

```ts
/**
 * The Multi-agent planning team's `headPrompt` — fan-out-then-synthesise.
 *
 * Roster-agnostic by construction: the head enumerates its own members from
 * `ptyListTerminals` by the `<head>-` name prefix that `spawnDelegates`
 * guarantees (ptyFleetService.ts:518-526), rather than naming roles that an
 * operator can edit in the TEAMS tab. `{head}` is substituted with the live
 * head name by `wireSpawnedTeam` (:1001).
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
```

Then extend `migrateAgentGroups` with a step 1c, immediately after the Coding-team step (`:379`):

```ts
        // Step 1c: an untouched adopted `Multi-agent planning` fork carries no
        // headPrompt, so its head is never told to fan out. Add it. Exact-value
        // match on name + headRole + member prompt + absent headPrompt; an
        // operator-edited or renamed team does not match and is left alone.
        // Additive only — nothing is removed, and a second pass no longer
        // matches (headPrompt is now set).
        if (isUntouchedMultiAgentPlanningTeam(g)) {
            g = { ...g, headPrompt: MULTI_AGENT_PLANNING_HEAD_PROMPT };
            changed = true;
            console.log(
                `[teamWiring] Migration: added fan-out headPrompt to untouched `
                + `Multi-agent planning team '${g.id || g.name}'.`
            );
        }
```

with the recogniser beside `isUntouchedOldCodingTeam` (`:581-595`):

```ts
/**
 * Recognise an adopted `Multi-agent planning` fork that the operator has not
 * edited: shipped name, shipped head role, the shipped member prompt verbatim,
 * and no headPrompt of its own. Any edit to name, head role or prompt — or an
 * operator-authored headPrompt — fails the match and the team is left alone.
 */
function isUntouchedMultiAgentPlanningTeam(g: any): boolean {
    if (!g || typeof g !== 'object') { return false; }
    if (g.name !== 'Multi-agent planning') { return false; }
    if (g.headRole !== 'planner') { return false; }
    if (typeof g.headPrompt === 'string' && g.headPrompt.trim()) { return false; }
    return g.prompt === MULTI_AGENT_PLANNING_MEMBER_PROMPT;
}
```

`MULTI_AGENT_PLANNING_MEMBER_PROMPT` is the shipped `prompt` string from `kanban.html:4702-4709`, stored verbatim as an exported constant next to the head prompt (same convention as `OLD_CODING_HEAD_PROMPT` — stored, never reconstructed by string-building at match time).

### `src/webview/kanban.html` — declare the head prompt on the shipped type

Add one field to the `Multi-agent planning` entry (`:4694-4710`), after `prompt`:

```js
                headPrompt: 'You lead this team and you do not write the plan alone. When you are given something to '
                    + 'plan — a memo, a ticket, a bug report, a request — split it into one investigation angle '
                    + …  // byte-identical to MULTI_AGENT_PLANNING_HEAD_PROMPT
```

`teamsTabAdoptAndStart` already forwards it (`:5077`: `...(type.headPrompt ? { headPrompt: type.headPrompt } : {})`) and the editor form already round-trips it (`:5278-5279`, `:5335`, `:5347`) — no other change is needed in this file.

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

No client-side order-migration function is added: there is no stale row to rewrite (the `team-head` row is absent, not wrong), so `applyStandingOrdersClient` needs no new branch. The mirror exists for the contract test and for parity with the Coding pair.

### `src/test/standing-orders-marker-contract.test.js` — pin the three copies

Add assertions that:

1. `MULTI_AGENT_PLANNING_HEAD_PROMPT` (teamWiring.ts) and `MULTI_AGENT_PLANNING_HEAD_PROMPT_CLIENT` (terminals.js) are byte-identical.
2. The `Multi-agent planning` entry in `SHIPPED_TEAM_TYPES` (kanban.html) declares a `headPrompt` and it equals the host constant.
3. `MULTI_AGENT_PLANNING_MEMBER_PROMPT` equals the shipped entry's `prompt` — otherwise the migration recogniser silently stops matching.

### `src/test/team-autostart-workspace-scope.test.js` — migration behaviour

Add three cases to the `migrateAgentGroups` block:

- an untouched adopted `Multi-agent planning` fork gains `headPrompt` and nothing else changes;
- the same fork with an operator-authored `headPrompt` is returned unchanged;
- the same fork with an edited `prompt` or a changed `name` is returned unchanged.

## Verification Plan

**Automated**

1. `node src/test/standing-orders-marker-contract.test.js` — the three-copy byte-identity assertions pass.
2. `node src/test/team-autostart-workspace-scope.test.js` — the new migration cases pass and every existing case still passes (in particular the Coding-team step 1b cases, which run in the same loop).
3. `npx tsc --noEmit -p tsconfig.json` — no type errors from the new exports.

**Manual (installed VSIX)**

4. **Fresh adoption.** Open the TEAMS tab, pick the `Multi-agent planning` card, adopt it. Open `terminals.agentGroups` (SETUP → DB, or the TEAMS tab's EDIT form) and confirm the persisted team now carries a `headPrompt`.
5. **Order installed.** Start the team. `GET /terminals/standing-orders` returns a row with `scope: "team-head"`, `teamId: "team_<head>"`, `parent` = the head terminal name, and an `instruction` whose `{head}` has been replaced with that name.
6. **The head is told.** In the terminals panel, drop a memo/plan prompt on the head's pane (the drop path, not a raw keyboard paste). Read the delivered text in the pane: it ends with a `=== STANDING ORDERS ===` block containing the fan-out instruction.
7. **The team actually fans out.** Give the head a real memo. Expected: the head calls `ptyListTerminals`, then posts a distinct angle to each member terminal by name; each member's pane shows its own dispatch; each member reports back to the head; the head's plan names which member found what. This is the acceptance test — a plan written with no member dispatches is a failure.
8. **Existing install.** Before upgrading, adopt the team on the old build (so an untouched fork with no `headPrompt` is on disk). Upgrade, reload the window, open the TEAMS tab (which triggers the group read path). Confirm the persisted team now carries the head prompt. Close the running head, start the team again, and confirm the `team-head` row appears in `GET /terminals/standing-orders` without a duplicate `team` row.
9. **Operator edit is respected.** Edit the adopted team's head prompt to any text, reload, and confirm the migration leaves it alone.
10. **Member-less team.** Edit the adopted team to have zero members, start it, and hand it a memo. It must say it has no members and plan alone — not hang waiting for reports.

## Recommendation

**Complexity: 5 → Send to Coder.** The change is a single-field addition plus an additive migration, following an exact existing pattern (`NEW_CODING_HEAD_PROMPT`). The three-copy contract and the migration recogniser are the only non-trivial parts, and both have direct precedents.
