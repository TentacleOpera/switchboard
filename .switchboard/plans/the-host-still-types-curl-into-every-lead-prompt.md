# The Host Still Types curl Into Every Lead Prompt

## Goal

No prompt the host generates tells an agent to run `curl` or to discover a port. Team leads and
coders reach the API only through the CLI, which already knows the port and can carry whatever
header the transport requires.

### Problem analysis

`migrate-agent-protocols-from-curl-to-the-cli.md` (complexity 6, **COMPLETED** 2026-09-03, under
the feature *Agent skills reach the API through the CLI*) did what it scoped: the 38 agent-facing
**files**. Those trees are clean — `grep -rl "curl\|sb_api_call\|api-server-port.txt" .agents
.claude CLAUDE.md` returns nothing, and `_lib` holds only `cli-call.js` and `workspace-root.js`.

Two surfaces survived it, because neither is a file an agent reads.

**Surface A — curl the host generates at runtime and types into an agent's terminal.** These are
string literals in TypeScript, so a file-by-file migration could not see them:

```
agentPromptBuilder.ts:960   PHONE-A-FRIEND:    curl -s -X POST .../phone-a-friend
agentPromptBuilder.ts:977   COMPLETION SIGNAL: curl -s -X POST .../phone-a-friend/done
KanbanProvider.ts:5876      STAGING (batch):   curl -s -X POST "$BASE/terminals/verb/ptySendPrompt"
KanbanProvider.ts:5881      MESSAGE (batch):   curl -s -X POST "$BASE/terminals/verb/ptySendPrompt"
KanbanProvider.ts:5950      STAGING (feature): curl -s -X POST "$BASE/terminals/verb/ptySendPrompt"
KanbanProvider.ts:5955      MESSAGE (feature): curl -s -X POST "$BASE/terminals/verb/ptySendPrompt"
terminals.js:11815          relay:             curl -s -X POST "${api}/terminals/relay"
```

The four in `KanbanProvider.ts` are the lead's staging and message path — the operator's question
was about team leads specifically, and this is it.

**They also carry the port-discovery prose the completed plan said it had killed.**
`KanbanProvider.ts:5818`:

```js
let portLine = 'read .switchboard/api-server-port.txt';
```

with `:5826` / `:5833` substituting `Port is ${apiPort}. BASE="http://127.0.0.1:${apiPort}"` when
the port is known. So every lead prompt reintroduces both things the migration removed: a `$BASE`
the agent must construct, and a port file it may have to read.

**The replacement already exists and is documented** (`cli.ts:34-35`, `:72-73`):

```
switchboard verb <verbName> [jsonPayload] [--json]
switchboard api <METHOD> <path> [jsonBody] [--json] [--data @<file>] [--timeout <ms>]
```

So the whole staging block collapses from a `$BASE` export, a curl, a `Content-Type` header and a
`--max-time` to `switchboard verb ptySendPrompt '{…}'`. Fewer tokens in every lead prompt and fewer
ways to get the shape wrong — which is the cost the completed plan's own analysis was about.

**Surface B — the standing-order rows already stored in the board DB.** Here the templates in code
are *already* correct: `AGENT_GROUP_CALLBACK_INSTRUCTION` (`teamWiring.ts:74`) reads
`node "<cliPath>" verb ptySendPrompt … (or switchboard verb ptySendPrompt)`. The rows on disk were
never migrated to match.

All four live orders on this board, read from `GET /terminals/standing-orders`:

| scope | parent | transport in the stored text | port-file prose | flagged stale |
| :--- | :--- | :--- | :--- | :--- |
| team | Coding | bare `POST /terminals/verb/…` | yes | **no** |
| team-head | Coding | other | yes | **no** |
| team | Feature Implementation | bare `POST /terminals/verb/…` | yes | **no** |
| team-head | Coding | bare `POST /terminals/verb/…` | yes | yes |

**Only one of the four is recognised as stale.** `describeStandingOrderMigrations`
(`teamWiring.ts:2257`) derives staleness from `migrateCodingTeamOrders(migrateTeamPairOrders(raw))`
and reports a note only when a transform rewrites or drops the row. Three of these four survive both
transforms unchanged, so the recogniser reports nothing and the Standing Orders tab renders them as
current. The `stale` badge the tab already has (`kanban.html`) is therefore telling the truth about
one row and staying silent about three.

Note the likely reason the recogniser misses them: `PRE_REWRITE_CALLBACK_INSTRUCTION`
(`teamWiring.ts:115`) is kept deliberately so the matcher can recognise what is on disk, and it
opens with `it is your head agent`. The stored rows open with `<headName> is your head agent` —
the `{child}` naming change shipped between the two, so the text it matches against is not the text
that exists. Confirm that before changing the matcher; it is the most probable cause, not a
measured one.

**This collides with the CSRF guard.** `browser-board-csrf-cross-site-rejection.md` (amended
2026-09-10) requires supported callers to send `X-Switchboard-Client`. All seven generated curls
would break under it, and the wrong fix is to add `-H 'X-Switchboard-Client: …'` to each — that
keeps curl and spreads a transport detail back into prompt text an agent can garble. The CLI sets
the header itself, which is the whole reason it should be the only client.

**A genuine exception, not to be swept in.** `EXTERNAL_AGENT_PULL_INSTRUCTION`
(`teamWiring.ts:99-106`) instructs raw HTTP for register / heartbeat / poll / done. That is for an
agent in a terminal Switchboard cannot push into, which may have no `switchboard` binary on PATH at
all. It needs a decision, not a rewrite.

## Metadata

**Complexity:** 3
**Tags:** agents, prompts, cli, standing-orders, bugfix
**Dependencies:** none to start. Should land **before** the marker-header change in
`browser-board-csrf-cross-site-rejection.md`, or that guard breaks every lead prompt.

## User Review Required

None. The operator has stated the rule: curl is not a supported client.

## Proposed Changes

### 1. Replace the seven generated curl strings with CLI calls

- `switchboard verb ptySendPrompt '{…}'` for the four staging/message sites; `switchboard api POST`
  for `/phone-a-friend`, `/phone-a-friend/done` and `/terminals/relay` if no verb covers them.
- Prefer the `node "<cliPath>" …` form already used by `AGENT_GROUP_CALLBACK_INSTRUCTION`, since
  `<cliPath>` is resolved at the composition root (`setBundledCliPath`) and does not assume the
  binary is on PATH. Keep the `(or switchboard verb …)` parenthetical that template carries.

### 2. Delete the port prose from the lead prompts

- Remove `portLine` / `$BASE` / `skipPortDirective` (`KanbanProvider.ts:5818-5833` and the prompt
  lines that consume them). The CLI resolves the port and its liveness itself — that is
  `findRunningInstance()`, which the completed plan's analysis named as the thing being
  reimplemented in markdown 38 times.

### 3. Migrate the stored standing-order rows, and fix the recogniser first

- Establish why three of four rows are not flagged. If it is the `{child}` rename, match on a
  stable substring (the bare `POST /terminals/verb/` shape, or the port-file path) rather than on a
  byte-identical legacy constant that a later reword invalidates again.
- Then migrate the rows to the current template. `STANDING_ORDERS_PREMIGRATION_BAK_KEY` and
  `backupOnce` already exist for exactly this, so the old text is recoverable.
- The recogniser is the load-bearing half: a matcher keyed to exact historical text will silently
  stop working on the next reword, which is what happened here.

### 4. Ratchet it

- A contract test that fails when prompt-building code emits `curl`, `$BASE`, or
  `api-server-port.txt`. Cover `agentPromptBuilder.ts`, `KanbanProvider.ts`, `teamWiring.ts`,
  `standingOrders.ts`, `standingOrderFragments.ts`, `linkPresets.ts` and `webview/terminals.js`.
- Assert the property over generated prompt text, not a file list — the completed plan's
  verification swept `.agents` and `.claude` and passed while seven curls sat in `src/`. That is the
  regression this test exists to prevent.

### 5. Decide the external-agent case

- Either ship a tiny pull helper the agent can run, or keep raw HTTP and document it as the one
  exempt surface with the reason. Do not leave it as an unmarked inconsistency.

## Verification Plan

- Generate a lead prompt for a batch and for a feature; neither contains `curl`, `$BASE` or
  `api-server-port.txt`.
- A lead actually stages a subtask and messages a coder using only what its prompt tells it, on a
  host where `curl` is not on PATH.
- `GET /terminals/standing-orders` returns four rows carrying the CLI form, and the Standing Orders
  tab flags nothing as stale afterwards.
- Before the fix, the recogniser flags 3 additional rows as stale (proving the matcher was blind);
  after the migration, zero.
- The new ratchet test fails when a `curl` string is reintroduced into any listed file.
- Phone-a-Friend and the completion signal still fire end to end.

## Outstanding Questions

- Do `/phone-a-friend`, `/phone-a-friend/done` and `/terminals/relay` have verb equivalents, or does
  each need `switchboard api POST`? If the latter, consider whether they should be verbs, so agent
  instructions never name a raw path.
