# A tagged ApiTarget — one board resolution chain, both clients

## Goal

Give the Node CLI a single place that decides which board a command talks to,
shaped exactly like the Go client's shipped resolver, and extend both clients'
resolution with the tiers the feature needs. After this lands, `resolveApiTarget()`
answers `{ baseUrl, workspaceRoot, auth, source }` for any invocation — local,
env-injected seat, or operator-named remote — and every value carries where it
came from.

This subtask builds the resolver. It does **not** rewire the ~38 call sites that
currently take a port (*Every Node command dials the resolved target*), and it
does **not** add the `remote` subcommand or the printed source line (*Named
remotes and the source line*). It is the seam both of those build on, and it is
the seam the seat path needs — which is why the env tier lives here and not in
two places.

## Problem Analysis

There are two CLI clients at HEAD and they do not have the same reach, so "every
CLI command is hardcoded to loopback" is true of only one of them.

The shipped static binary (`cmd/switchboard` + `internal/client`, built to
`dist/<platform>/switchboard`) is a Go front controller. It owns 16 board verbs (`ownedVerbs`,
`cmd/switchboard/main.go:22-26`: `plans`, `ready`, `dispatch`, `done`, `next`, `reports`, `clear`,
`fleet`, `verb`, `api`, `status`, `logs`, `probe`, `help`, `about`/`version`) and delegates
everything else to the Node host. It already implements this plan's core mechanism:
`ResolveEndpoint` (`internal/client/resolve.go:87`) resolves `--server` / `--endpoint` /
`SWITCHBOARD_SERVER_URL` with source tagging (`flag`/`env`/`local-discovery`/`port-file`),
`parseServerURL` (`:118`) accepts `https`, and `ResolveServerRoot` (`:159`) refuses a remote
endpoint that names no root — `MissingRootError` prints the advertised roots and the recovery flag
(`main.go:124-135`). Measured: from a tailnet Dell, `SWITCHBOARD_SERVER_URL` +
`SWITCHBOARD_WORKSPACE_ROOT` drives `status`, `plans` and `ready` against the Pi board with no
tunnel.

The hardcodings below are the **Node** client (`cli.ts`) — what `npx switchboard` runs
(`bin/switchboard` execs `dist/standalone/cli.js`), and what an agent seat is handed only when no Go
client is installed (`formatCliInvocation`, `src/utils/cliPathToken.ts:133`, prefers the Go binary
and drops the `node` prefix with it).

So this subtask closes a parity gap, not a missing transport:

- **Parity.** The Node client cannot reach a remote board at all, so `npx switchboard` installs are
  loopback-locked while the packaged binary is not. Two clients answering the same command
  differently is the divergence shape this codebase exists to prevent.
- **Ergonomics.** The Go client knows `--server <url>` and nothing else — and it refuses a remote
  endpoint without an explicit `--workspace-root` even when the remote advertises exactly one root.

### 1. Port discovery reads the local filesystem

`findRunningInstance` (`cli.ts:435`) scans candidate ports, matching `/health`'s `roots` against a
locally resolved path, then falls back to reading `<workspaceRoot>/.switchboard/api-server-port.txt`
(`:452`). Both halves assume the board's state directory is on this disk. On a laptop there is no
such file, and the port scan probes the laptop's own ports. A seat on another machine dials *its
own* loopback and gets "No running Switchboard instance found" (verified).

### 2. `workspaceRoot` is a local path, and nothing decides a remote one

The value comes from the CLI's cwd (`cli.ts:3790`). A laptop path
(`/Users/p/work/labcom`) names nothing on the Pi.

**This is the dangerous one.** The docblock at `:528-531` already records why the param is not
optional:

> `workspaceRoot` is NOT optional on the read path. `_resolveDbFromQuery` falls back to the host's
> own selected root when the param is absent — on the extension host that is a DIFFERENT board from
> the one the CLI's cwd names.

Over the tailnet the same fallback is worse: sending a path the remote does not know, or omitting it,
silently resolves to whichever board the Pi happens to have selected. The operator reads a board,
acts on it, and never learns it was not the one they named. That is precisely the failure the
project's fallback rule exists to prevent, and no gate catches it — the response is a valid `200`.
Measured: `GET /kanban/columns?workspaceRoot=/nonexistent/elsewhere` returns 200, byte-identical to
the real root's answer.

### 3. Token discovery reads a local file

```ts
const tokenFile = path.join(workspaceRoot, '.switchboard', 'api-server-token.txt');
```

`cli.ts:489` (`discoverAuthToken`, `:488`) reads only
`<workspaceRoot>/.switchboard/api-server-token.txt` on its own filesystem. The remote's token is on
the remote's disk. It adopts the Go client's shipped precedence — `SWITCHBOARD_API_TOKEN` env →
`--token-file` → workspace token file → tagged none — so the two clients answer identically.

Never a token value in argv, which is the Go client's rule (`resolve.go:196-198`) and holds here for
the same reason: argv is logged, stored and displayed.

### 4. `waitForHealth` and `probeHealth` probe `127.0.0.1`, and compare the wrong port

`waitForHealth` probes `127.0.0.1` (`cli.ts:462`), which makes any "start it and wait" path
local-only. `probeHealth`/`getHealthJson` already take a hostname defaulting to `127.0.0.1`
(`cli.ts:391`, `:405`) — the discovery half is already remote-capable; only its callers are not.
Both are `http`-only (`http.get` at `:416`), so the `https` branch is owed here.

And `probeHealth` compares `json.port === port` (`cli.ts:394`). Behind `tailscale serve` you connect
on 443 and the board reports 7777, so the probe fails on a perfectly healthy remote.

### What already works, and needs no change

Verified against the server, not assumed:

- **The Host guard passes.** A CLI request to `labcom.taile9aab9.ts.net:7777` sends that name as
  `Host`, and `isAllowedHostFor` accepts both the MagicDNS FQDN and its bare first label
  (`loopbackHostname.ts:191-195`).
- **The CSRF guard passes.** A CLI sends no `Origin` and no `Sec-Fetch-Site`, so it must carry the
  positive client marker — and `apiRequest` already sets `X-Switchboard-Client: switchboard-cli`
  (`cli.ts:566`; the Go client sends the identical header, `transport.go:160`).
- **The tailnet listener needs no credential.** A request arriving on the tailnet listener is trusted
  exactly as loopback is (`_checkAuth` tailnet bypass, `LocalApiServer.ts:1791`), identified by the
  socket's `localAddress` (`_isTailnetSocket`, `:1726-1741`).
- **`/health` is the discovery endpoint.** It is CSRF-exempt (`LocalApiServer.ts:12914`) and returns
  `roots` and `selectedWorkspaceRoot` (`:13440-13442`) — the remote tells you its board roots before
  you have named one.

## Metadata

**Complexity:** 5
**Tags:** cli, api, feature, infrastructure

## Host Scope

**Standalone only.** The Node-side change is a new module `src/standalone/apiTarget.ts` plus the
health-probe functions in `src/standalone/cli.ts`; the Go-side change is in `internal/client`. The
CLI is a standalone-host surface and the extension host does not have one. Per the cutover rule the
extension is out of scope and its absence here is the intended state, not a divergence. No
`extension.ts` composition-root seam is touched, and none should be added.

`LocalApiServer` is shared code, and this subtask does not modify it.

**Do not convert the board commands in this subtask.** `apiRequest`'s signature, the ~13
`findRunningInstance` sites and the ~25 `api*` sites belong to *Every Node command dials the
resolved target*. This subtask leaves them compiling against today's port-based path and exports the
resolver they will consume. The `remote` subcommand, `remotes.json` and the printed source line
belong to *Named remotes and the source line* — this subtask defines the precedence tiers that read
them and treats a missing config store as an absent tier, not an error.

**Client parity is this subtask's divergence rule.** There is no second *host*, but there are two
*clients*, and they answer the same commands. Every resolution behaviour here — flag names, env
names, precedence order, refusal semantics — lands identically in the Go client and the Node client,
or lands nowhere. "Go first, Node later" is the same failure the host-divergence rule exists to
prevent, wearing a different hat.

## User Review Required

- **No new credential mechanism in v1 — the project has already settled that a credential is the
  wrong control here.** `auth-belongs-at-a-boundary-and-a-local-cli-is-not-one.md` gives each surface
  one control matched to its threat: file permissions for a shell user on the host,
  `Sec-Fetch-Site`/`Origin` plus the Host allowlist for a browser tab, and tailnet membership for a
  remote device. That plan has LANDED — `bootstrap.ts:1020-1023` resolves `resolvedToken` to `''`
  when no durable `switchboard.apiToken` is stored, so `_checkAuth`'s local-trust branch
  (`LocalApiServer.ts:1807`) is the live path on a default host, exactly as this section claims.
- **What this means for the two transports.** Direct at `http://labcom...ts.net:7777` lands on the
  tailnet listener and is trusted by the bind (`:1791`). Through `tailscale serve`, tailscaled
  terminates TLS and proxies to `127.0.0.1:7777`, so the request arrives looking like loopback and
  hits the same local-trust branch (`:1807`). **Both routes work credential-free on a default host.**
- **The token pass-through already exists on the binary install.** `SWITCHBOARD_API_TOKEN` and
  `--token-file <path>` are resolved by `ResolveToken` (`internal/client/resolve.go:199-220`), so a
  durable-token operator is already served by the Go client. What is missing is the same env and flag
  in the **Node** client — two lines of precedence in `discoverAuthToken`, not a separate card.
- **Env names are the shipped Go client's**: `SWITCHBOARD_SERVER_URL`, `SWITCHBOARD_WORKSPACE_ROOT`,
  `SWITCHBOARD_API_TOKEN` (`internal/client/usage.go:68-71`). `SWITCHBOARD_REMOTE` is added as a
  *higher* tier accepting a name or a URL — it does not replace or rename anything shipped, and
  there is no third vocabulary. The seat path uses only the `SWITCHBOARD_SERVER_URL` tier, which is
  exactly what the host injects.

## Settled Design

**A target is resolved once, explicitly, and carries its source.** Every command resolves an
`ApiTarget` before its first request. The target is `{ baseUrl, workspaceRoot, auth, source }`, and
`source` is available for printing on every remote command. "Which host and which board answered?"
must be answerable after the fact — the project's fallback rule, applied to a read that is now
routing-and-identity, not just configuration. The Go client already implements this shape
(`Resolved[T]{Value, Source}`, `internal/client/resolve.go:39-58`) — the Node implementation mirrors
it, it does not invent a second tagging scheme.

**A remote root is never guessed.** The remote's `/health` names its roots. One root: use it, tagged
`health-roots` (the Go `Source` constant already exists, `resolve.go:35`). More than one: refuse and
list them, requiring `--workspace-root`. Never fall back to the remote's `selectedWorkspaceRoot`,
which is exactly the quiet-wrong-answer shape.

**Endpoint precedence, highest first:** **`--remote <name|url>`** (a URL is equivalent to
`--server`; a bare name resolves through `remotes.json`) **→ `SWITCHBOARD_REMOTE`** (name or URL)
**→ `--server` / `--endpoint` / `SWITCHBOARD_SERVER_URL`** (URL only, existing behaviour unchanged)
**→ the configured default remote** (`remotes.json` `defaultRemote`) **→ local discovery**.

**Root precedence:** **`--workspace-root` / `SWITCHBOARD_WORKSPACE_ROOT`** → the stored remote's
root → single-root auto-pick tagged `health-roots` → refusal listing the advertised roots.

**Token precedence:** `SWITCHBOARD_API_TOKEN` → `--token-file` → workspace token file → tagged none.

This extends the vocabulary that already ships rather than inventing beside it. The Go client's
flags are `--server`/`--endpoint`/`SWITCHBOARD_SERVER_URL`/`--workspace-root`/
`SWITCHBOARD_WORKSPACE_ROOT`/`--token-file` (`cmd/switchboard/main.go:34-38`, `resolve.go:68-81`).
A `--root` spelling alongside `--workspace-root` would give one concept two names, and a remote
mechanism disjoint from `--server` would give one slot two resolvers; neither is introduced.

Passing both `--remote` and `--server`, or both env vars, with disagreeing values is a loud conflict
error, not a silent pick. There is no fallback between tiers: a named remote that fails to resolve
is an error, never a demotion to local.

**Local behaviour is untouched.** With no remote named, resolution returns today's local target by
today's path. A local invocation must not acquire a new failure mode.

**When an explicit or env endpoint resolves, local discovery is skipped entirely** — no loopback
dial, no port-file read. A seat carrying `SWITCHBOARD_SERVER_URL` never touches
`findRunningInstance`.

## Complexity Audit

### Routine

- Adding an `https` branch to `getHealthJson`/`probeHealth`.
- Node token precedence — mirrors the shipped Go precedence name-for-name; no design work, only
  parity.

### Complex / Risky

- **`probeHealth` compares `json.port === port` (`cli.ts:394`).** Behind `tailscale serve` you
  connect on 443 and the board reports 7777, so the probe fails on a perfectly healthy remote. The
  fix is the split already used by `isHttpsOriginReachable` (`tailnetOrigin.ts:70-75`): a *connect*
  port and an *expected* port, compared separately. Do not "fix" this by dropping the port
  comparison — it is what stops the CLI signalling a PID on a port some other process holds. (The Go
  client has no equivalent bug — `GetHealth` validates `service`/`status` only, and `ProbeSpan`
  gates on `roots` membership instead of port equality, `transport.go:272-286`.)
- **Two clients, one semantics.** The Go client already refuses a remote endpoint with no explicit
  root even when exactly one root is advertised (`resolve.go:177-182`); this subtask's single-root
  auto-pick changes that behaviour and must change it in both clients together, tagged
  `health-roots`. Same for the refusal messages — a behaviour that differs by which binary the
  operator happened to install is a divergence.

## Edge-Case & Dependency Audit

1. **Remote down / Tailscale down.** Fail with the target's name and resolved URL, non-zero. Never
   fall back to the local board — that is the same class of bug as the root fallback, and the
   operator would act on the wrong board's output.
2. **`SWITCHBOARD_SERVER_URL` set but unreachable** → fail naming the URL and source; never demote to
   loopback discovery. Malformed URL → error naming the env var.
3. **Remote renamed.** The MagicDNS name changes when the machine or tailnet is renamed. A stored
   remote whose name no longer resolves must say "this remote's name does not resolve — the machine
   may have been renamed", not "connection refused". (Distinguish `ENOTFOUND`/NXDOMAIN from
   `ECONNREFUSED`: the former is the rename case, the latter is a reachable host with a stopped
   board.)
4. **Ambiguous root.** Remote has two roots, no `--workspace-root`: refuse, list both, exit
   non-zero.
5. **Stale stored root.** Stored root is absent from the remote's current `/health.roots`: refuse
   and re-list. Do not silently switch to the surviving one.
6. **Version skew.** A remote on an older build may omit `/health` fields. Absence is absence —
   never read a missing field as a default (the `host`/`capabilities` precedent at `cli.ts:409-413`).
7. **Overlapping seams.** The seat path (*The host inlines seat identity and the board URL*) injects
   the env this resolver reads; the env names are the contract between them. The `remotes.json`
   tiers are read here and written by *Named remotes and the source line* — absent config is an
   absent tier, never an error.

## Dependencies

- `go-cli-client-verbs.md` — **shipped**; it is the reason half of this subtask already exists. The
  Go front controller, `internal/client`'s tagged `Resolved[T]`, `MissingRootError`, and the
  `--server`/`--workspace-root`/`--token-file` vocabulary are its output, and this subtask extends
  them rather than inventing alongside them.
- *The host inlines seat identity and the board URL into a remote spawn* — produces the env this
  resolver consumes.
- *Every Node command dials the resolved target, not loopback* — consumes `resolveApiTarget`.
- *Named remotes and the source line, in both clients* — writes the `remotes.json` this resolver's
  name and default tiers read.
- `remote-switchboard-is-tailscale-and-nothing-else.md` — owns the bind policy; this subtask changes
  who dials, never what is bound.
- `auth-belongs-at-a-boundary-and-a-local-cli-is-not-one.md` — **landed**; its "no credential on a
  default host" premise is verified at HEAD (`bootstrap.ts:1020-1023`, `LocalApiServer.ts:1807`).

## Adversarial Synthesis

Key risk: the two clients silently diverging on precedence, refusals or flag spellings. A behaviour
that differs by which binary the operator installed is the divergence shape this codebase exists to
prevent, and no gate catches it — both clients return valid answers, just different ones. Mitigated
by one precedence table applied to both clients in this subtask, with table tests on each side
covering the same cases.

Secondary risk: a tier that fails quietly. A named-but-unreachable remote demoting to local, or an
untagged value, both produce a plausible 200 from the wrong board. Mitigated by making every
resolved value carry a non-empty `source` (asserted), and by making every inter-tier fallback an
error rather than a demotion.

## Proposed Changes

### Change A — an `ApiTarget`, resolved once and tagged (both clients)

**Node:** new module `src/standalone/apiTarget.ts`:

```ts
export interface ApiTarget {
    baseUrl: string;          // 'http://labcom.taile9aab9.ts.net:7777' | 'https://labcom...ts.net'
    workspaceRoot: string;    // the REMOTE's root, from its /health (or local cwd, local case)
    auth: { token: string; source: string } | { token: null; source: 'tailnet-listener-trusted' | 'none' };
    source: string;           // 'flag:--remote labcom' | 'env:SWITCHBOARD_REMOTE' | 'env:SWITCHBOARD_SERVER_URL' | 'config:remotes.labcom' | 'local:port-file' | 'local:probe'
    isRemote: boolean;
}

export async function resolveApiTarget(opts: {...}): Promise<ApiTarget>;
```

**Go:** the shape already exists (`client.Routes`, `client.Resolved[T]`). What changes is
resolution *content*: `ResolveEndpoint` gains the `--remote`/name-or-URL tier and the
`remotes.json` default tier; `ResolveServerRoot` gains the stored-root tier and the single-root
`health-roots` auto-pick.

Precedence (both clients, identical order — see Settled Design):
endpoint: `--remote`/`--server` flag → `SWITCHBOARD_REMOTE`/`SWITCHBOARD_SERVER_URL` env →
`remotes.json` `defaultRemote` → local discovery. Root: `--workspace-root`/`SWITCHBOARD_WORKSPACE_ROOT`
→ stored remote root → single-root `health-roots` → refuse-and-list. Token: `SWITCHBOARD_API_TOKEN`
→ `--token-file` → workspace token file → tagged none. A named remote that fails to resolve is an
error, not a demotion.

### Change B — split connect port from expected port in the Node health probe

Give `probeHealth`/`getHealthJson` an explicit expected-port parameter, defaulting to the connect
port so every existing caller is unchanged, plus a scheme (the `http.get` at `cli.ts:416` becomes a
scheme-picked `http`/`https` call). Mirrors `isHttpsOriginReachable`
(`tailnetOrigin.ts:70-75`), which solved this exact problem for the browser URL. The Go client needs
no equivalent — its `GetHealth` never compared ports.

## Verification Plan

### Goal Invariants

1. A remote with two roots and no `--workspace-root` resolves to a refusal listing both, and reads
   nothing; a one-root remote resolves tagged `health-roots`, in both clients.
2. A remote that is unreachable resolves to an error naming it, and never resolves to the local
   board.
3. Every `ApiTarget`/`Routes` carries a non-empty `source`.
4. With no remote named, resolution returns today's local target by today's path, in both clients.
5. **Client parity:** for every resolution and refusal case above, the Go client and the Node client
   produce the same outcome and the same message shape. Divergence is a failure, not a porting
   detail.

### Automated Tests

New contract suite `src/test/cli-api-target-contract.test.js`, plus Go-side coverage in
`internal/client/resolve_test.go`:

- Every `ApiTarget`/`Routes` carries a non-empty `source`; a resolver returning an untagged target
  fails.
- Resolution precedence, including: a named-but-unreachable remote **errors** rather than resolving
  local (assert on the error, since the bug would look like success); `--remote` + `--server`
  disagreeing is a loud conflict.
- Two-root remote without `--workspace-root` → refusal. One-root → resolved, tagged `health-roots`.
- `SWITCHBOARD_SERVER_URL` set → the resolved target is that base URL and `findRunningInstance` is
  never consulted (assert no `127.0.0.1` dial).
- `SWITCHBOARD_WORKSPACE_ROOT` beats cwd; `--workspace-root` beats env; source tags recorded.
- `SWITCHBOARD_API_TOKEN` env beats the token file in `discoverAuthToken`.
- `probeHealth` with connect port ≠ expected port succeeds when the body reports the expected port,
  and fails when it reports a third value.
- Go side: `ResolveEndpoint`/`ResolveServerRoot` table tests covering the name-or-URL flag, both env
  vars, `defaultRemote`, single-root auto-pick, and multi-root `MissingRootError`.

`npm run compile-tests` before running, per the build rule.

### Manual Verification

1. `SWITCHBOARD_SERVER_URL=http://labcom:7777 SWITCHBOARD_WORKSPACE_ROOT=/home/patrick/switchboard`
   resolves a target naming that URL and root with `env:` sources, from both the packaged binary and
   `node dist/standalone/cli.js`.
2. An unreachable `SWITCHBOARD_SERVER_URL` produces an error naming the URL and the env var — and
   never a local board's answer.
3. Against the `tailscale serve` HTTPS URL, the health probe succeeds connecting on 443 while the
   board reports 7777.

## Recommendation

**Send to Coder.** Complexity 5: one new module plus the mirrored Go resolution tiers, with a
parity rule that a table test must pin on both sides. No call-site conversion — that is the sibling
subtask.

## Completion Note (Coding-coder-1)

Implemented the tagged resolver in both clients. Node: new `src/standalone/apiTarget.ts` exporting `resolveApiTarget()` → `{ baseUrl, workspaceRoot, rootSource, auth, source, isRemote, remoteName }`, plus `MissingRootError`, `StaleRemoteRootError`, `loadRemotesConfig`, `fetchHealthJson` (http+https), `discoverLocalBoard` (probe/port-file tagged); `cli.ts` gained the expected-port/scheme split in `probeHealth`/`getHealthJson` and the env → token-file → workspace-file precedence in `discoverAuthToken`. Go: `ResolveEndpoint` gained the `--remote`/name-or-URL and `SWITCHBOARD_REMOTE` tiers plus the `remotes.json` `defaultRemote` tier and the disagreeing-pair conflicts; `ResolveServerRoot` gained the stored-remote root (with stale-root refusal) and the single-root `health-roots` auto-pick; `parseServerURL` defaults portless https to 443; `main.go` parses `--remote` and names unreachable remotes (ENOTFOUND vs ECONNREFUSED) via `DescribeUnreachable`; usage updated. No call sites were rewired and no `remote` subcommand was added — those are the sibling cards. Contract suite `src/test/cli-api-target-contract.test.js` (incl. a transpile-and-probe behavioural pin for the port split) and 14 new table tests in `resolve_test.go` were written, not run, per the SKIP directives.

## Review Fix (Coding-coder-1)

An explicitly passed `--token-file` that is missing, unreadable, or empty now throws in all three credential resolvers — `resolveApiTarget`, `discoverAuthToken`, and Go `ResolveToken` (signature gained an error return; `main.go` surfaces it) — instead of silently demoting to unauthenticated and mislabelling the target `tailnet-listener-trusted`. Two test defects were also fixed: missing `http`/`https` requires in the contract suite, and a token-precedence assertion that keyed on the signature param position rather than the read call. Go and Node table tests updated to pin the loud failure.

## Review Findings

Reviewed `src/standalone/apiTarget.ts`, the `probeHealth`/`getHealthJson`/`discoverAuthToken` split in `src/standalone/cli.ts`, and `internal/client/resolve.go` + `resolve_test.go`; the precedence chain, the tagged sources, the no-inter-tier-fallback rule and the connect/expected port split all land as specified in both clients. Two MAJORs were fixed: `fetchHealthJson` had no wall-clock guard, so a MagicDNS lookup that neither resolves nor NXDOMAINs left `resolveApiTarget` pending forever with no output and no error — the exact failure this repo documents at `tailnetOrigin.ts:86-90` and that `apiRequest` already arms for; and the Go client funnelled a *named-tier* resolution failure (an unconfigured `--remote`, a corrupt `remotes.json`, an unparseable URL) into `EmitOfflineGuidance`, dropping the real message and telling the operator to run `switchboard local` — advice for the wrong machine, and a divergence from the Node client which names the cause and exits 1. Fixes: a wall-clock + sync-throw guard in `fetchHealthJson`, and an exported `client.ErrNoLocalBoard` sentinel that `cmd/switchboard/main.go` now gates the offline shapes on via `errors.Is`. Verification: `tsc -p tsconfig.test.json` clean, `test:contract:api-target` ALL PASSED, `go build ./... && go vet && go test -count=1 ./internal/... ./cmd/...` all ok. Remaining risk: the two-machine hop itself (laptop → Pi over the tailnet) was not exercised in this pass — the suites pin resolution and message shape, not a real remote board answering.

## Deferred Findings

- NIT `src/standalone/cli.ts:894` — `localTarget` hardcodes `source: 'local:port-file'` regardless of whether the probe or the port file answered; inert today because local targets never print the source line, but it is a mis-tag in the one feature whose premise is tagging.
- NIT `src/standalone/apiTarget.ts:397` — `SWITCHBOARD_REMOTE` outranks an explicitly typed `--server`, and the conflict check only fires within the winning tier, so the flag is silently ignored. Plan-specified precedence, and visible via the source line, so not changed.
- NIT `src/standalone/apiTarget.ts:222` — `parseServerUrl` returns a portless `baseUrl` for a bracketed IPv6 https host (`https://[::1]`); correct because 443 is the scheme default, but it is the one shape where `ParsedEndpoint.port` and `baseUrl` disagree.
