# `switchboard api` — one escape hatch so agent skills can leave curl behind

## Goal

Add `switchboard api <METHOD> <path> [jsonBody] [--json]` to the CLI: a thin, authenticated
passthrough to any LocalApiServer route. This is the single missing primitive that lets all
eighteen agent-facing skill/protocol/workflow files stop shelling out to `curl`, and lets
`.agents/skills/_lib/sb_api_call.sh` be deleted rather than maintained.

### Problem Analysis

**Every agent-facing document in this repo talks to the API through `curl`, and none of them
send the auth token.**

`sb_api_call.sh` resolves the port by walking up for `.switchboard/api-server-port.txt`, health-checks
`GET /health`, and then issues `curl -X "$METHOD" "http://localhost:$PORT$PATH_NAME" "$@"`. There
is no `Authorization` header anywhere in the file. The CLI, by contrast, discovers a token from
`.switchboard/api-server-token.txt` and attaches `Authorization: Bearer <token>` on every request
(`cli.ts:475-520`, `:542-550`).

So the moment a user runs `switchboard token set`, every skill in `.agents/protocols/` and
`.agents/skills/` starts getting 401s, while the CLI keeps working. This is not a hypothetical:
`token set`/`rotate`/`clear` are shipped subcommands (`cli.ts:33-36`), and the two Mission Control
protocols already tell agents to *"pass `Authorization: Bearer <token>`"* by hand
(`switchboard-mission-control-http/SKILL.md:45`, `switchboard-orchestration/SKILL.md:45`) — an
instruction with no mechanism behind it, since `sb_api_call` accepts extra curl args but no skill
passes a token through them.

**The CLI cannot currently replace `sb_api_call`, because `verb` is not general.** `cmdVerb`
tries `POST /terminals/verb/<name>`, then falls back to `POST /kanban/verb/<name>` on a
not-implemented refusal. Those are the only two routes it can reach. The skills call eleven plain
REST paths that are not verbs at all:

```
GET  /metadata/clickup      GET  /metadata/linear
GET  /task/clickup/<id>     GET  /task/linear/<id>
POST /api/clickup           POST /api/linear
POST /comment               POST /diagram/generate
POST /doc/clickup           POST /task/clickup
POST /worktree/cleanup
```

Plus the eight `kanban_operations/*.js` scripts (`move-card.js`, `create-feature.js`,
`assign-to-feature.js`, `delete-feature.js`, `reconcile-features.js`, `remove-from-feature.js`,
`split-feature.js`, `get-state.js`), which each open their own HTTP socket with the same
port-file-then-request pattern and the same missing token.

**A count, so the scale is not guessed:** zero of `.agents/protocols/*/SKILL.md`,
`.agents/skills/*/SKILL.md`, `.agents/workflows/*.md` and `.claude/skills/*/SKILL.md` reference any
`switchboard` CLI subcommand today. Thirty-eight files reference the HTTP transport.

### Root Cause

The CLI's board commands were designed as *user-facing conveniences* — `plans`, `ready`,
`dispatch`, `clear`, `fleet` each wrap one workflow a human wants from a terminal. `verb` was added
for the verb rails specifically. Nobody designed for the other consumer: an agent that needs the
same authenticated transport as the CLI but against arbitrary routes. So the skills kept the only
general-purpose tool available to them, which is `curl`, and inherited its auth gap.

### Non-goals

- **Not adding named domain subcommands** (`switchboard tickets`, `switchboard comment`, …). Those
  are a later, optional polish; this plan is the primitive that unblocks the migration.
- **Not migrating any skill file.** That is the sibling plan
  (`migrate-agent-protocols-from-curl-to-the-cli.md`), which depends on this one.
- **Not changing `sb_api_call.sh`.** It is deleted by the sibling plan, not edited here.
- **Not touching auth policy.** `discoverAuthToken` is reused verbatim; this command is exactly as
  privileged as `switchboard plans` already is.

### Why an escape hatch rather than thirteen subcommands

The eleven REST paths belong to four unrelated domains (ClickUp, Linear, diagrams, worktrees) and
each would need its own argument surface, its own name resolution, and its own tests. That is a
large CLI diff that must land *completely* before a single skill can be migrated — and until it
does, every skill stays on the broken transport.

One general command inverts that: it lands in a day, and the migration can then proceed file by
file. Named subcommands remain available afterwards for whichever paths prove hot, and a skill
migrated to `switchboard api` can be retargeted to a named command later without returning to curl.

The trade is discoverability: `switchboard api POST /comment '{...}'` is less self-documenting than
`switchboard comment`. For an agent reading a SKILL.md that spells out the exact invocation, that
cost is close to zero.

## Metadata

**Complexity:** 3
**Tags:** cli, api, devops, security, refactor

## User Review Required

- **Confirm the command name.** `api` reads well and no subcommand claims it. `http` and `call`
  are the alternatives.
- **Confirm the body-passing shape.** This plan takes the JSON body as a positional argument, to
  match `switchboard verb <name> <jsonPayload>` which already works that way. A `--data @file`
  form is proposed as an addition for bodies too large or too quote-hostile for `argv`.

## Complexity Audit

### Routine

- The command body itself: parse `METHOD` and `path`, reuse `findRunningInstance`, `apiGet` /
  `apiPost`, and `emitJson`. Every piece already exists and is used by five sibling commands.
- Adding the usage lines to `usage()`.

### Complex / Risky

- **`apiGet` and `apiPost` are the only two helpers that exist.** `PUT` and `DELETE` have no
  helper. `sb_api_call` is documented as taking any method and at least one skill's snippets use
  `PUT`. Either a generic `apiRequest(method, …)` is extracted and the two existing helpers become
  callers of it, or `PUT`/`DELETE` silently fall through to the wrong verb. The extraction is the
  correct move and must not change `apiGet`/`apiPost` behaviour for their existing five callers.
- **`KNOWN_SUBCOMMANDS` is a hard gate.** `cli.ts:1884-1905` rejects any leading token not in that
  set before dispatch is reached. Adding the handler without adding `'api'` to the set produces
  `Unknown subcommand 'api'` — the command would be unreachable and every test that ran it would
  fail confusingly.
- **`subcommandTargetsCwd` is a second, independent list.** `cli.ts:1946-1953` enumerates
  subcommands that do *not* require `.switchboard/` to exist in cwd. `api` must be added there too,
  or it errors out in any directory that is not a Switchboard workspace root — including the
  worktrees where orchestration agents actually run.
- **Path validation.** The `path` argument is interpolated into a URL. It must be required to start
  with `/`, and must be rejected if it contains a scheme or authority (`http://`, `//host`), so the
  command cannot be turned into a request to an arbitrary host by a malformed skill snippet or a
  crafted argument.

## Edge-Case & Dependency Audit

- **No running server.** Must use the same `emitOfflineGuidance(jsonFlag)` path the other board
  commands use, so the offline message is one voice across the CLI.
- **401.** Must exit 4 with the same message shape `cmdPlans` uses, so a skill can branch on the
  exit code rather than parse prose.
- **Non-JSON response bodies.** `/diagram/generate` may return non-JSON. The command must print the
  raw body rather than throwing on a parse failure, and under `--json` must wrap it as a string
  rather than emitting invalid JSON.
- **Empty body on GET.** `apiGet` takes a query object, not a body. A `GET` with a positional JSON
  argument should be a usage error (exit 5), not a silently-dropped payload.
- **Exit codes must match the family already documented in `usage()`**: `0` ok, `1` offline or
  non-2xx, `4` auth failed, `5` bad input.
- **`routeLogsToStderr()` under `--json`.** Every other `--json` command calls it first. Without it,
  a log line corrupts the stdout JSON an agent is parsing.

## Proposed Changes

### 1. `src/standalone/cli.ts` — extract a generic request helper

Introduce `apiRequest(port, method, path, workspaceRoot, body?, query?)` carrying the existing
token discovery and header assembly. Re-express `apiGet` and `apiPost` as callers so their five
existing call sites are untouched in behaviour.

### 2. `src/standalone/cli.ts` — `cmdApi`

```
switchboard api <METHOD> <path> [jsonBody] [--json] [--data @<file>]
```

- Validate `METHOD` against `GET|POST|PUT|PATCH|DELETE` (case-insensitive), else exit 5.
- Validate `path` starts with `/` and contains no scheme or `//` authority prefix, else exit 5.
- Parse the positional body as JSON, else exit 5. Reject a body on `GET`.
- Resolve the port; offline → `emitOfflineGuidance`.
- Issue the request; map status to the documented exit codes.
- Under `--json`, emit `{ success, status, result }` matching `cmdVerb`'s envelope exactly, so
  agents parse one shape across both commands.

### 3. `src/standalone/cli.ts` — registration

- Add `'api'` to `KNOWN_SUBCOMMANDS` (`:1884`).
- Add `'api'` to the `subcommandTargetsCwd` exclusion chain (`:1946-1953`).
- Add the dispatch arm beside `verb` (`:2631`).
- Add the usage line and a Board-commands entry in `usage()`.

## Verification Plan

### Automated Tests

Extend `src/test/cli-board-commands-contract.test.js`, which already gates this command family:

1. **Reachability.** `'api'` is a member of `KNOWN_SUBCOMMANDS` and of the `subcommandTargetsCwd`
   exclusion list. Both asserted by reading the source — this is the failure mode where the
   handler exists and is unreachable, and no runtime test in a workspace-rooted cwd would catch
   the second one.
2. **Token attachment.** Against a stub server, with a token file present, assert the received
   request carried `Authorization: Bearer <token>`. This is the defect the whole plan exists to
   fix; it must be pinned directly rather than inferred from a 200.
3. **Method coverage.** `PUT` and `DELETE` reach the stub with the correct method — the regression
   guard for the `apiGet`/`apiPost`-only extraction.
4. **`apiGet`/`apiPost` unchanged.** The existing `plans` / `fleet` / `verb` assertions in this
   file must still pass untouched after the extraction.
5. **Path rejection.** `switchboard api GET http://evil.example/x` and
   `switchboard api GET //evil.example/x` both exit 5 and issue no request.
6. **Exit codes.** offline → 1; 401 → 4; malformed JSON body → 5; body on GET → 5; 500 → 1.
7. **`--json` envelope.** Shape-identical to `cmdVerb`'s `{ success, status, result }`, and stdout
   parses as JSON with a log line forced onto the tick (guards the `routeLogsToStderr` omission).
8. **Non-JSON body.** A `text/plain` 200 prints the raw body on the human path and a string
   `result` under `--json`.

### Goal Invariants

- Every path in the eleven-route list above is reachable via `switchboard api` against a stub
  server. Asserted as a table test, so the sibling migration plan has a proven target surface
  before it edits a single skill file.
- `switchboard api` sends the auth token on every one of those routes.

### Manual

- With the board running and no token: `switchboard api GET /kanban/plans` returns cards.
- `switchboard token set X`, then the same command still returns cards — the case that fails today
  through `sb_api_call.sh`.
- Run from a worktree subdirectory with no `.switchboard/` of its own; the command still resolves.
