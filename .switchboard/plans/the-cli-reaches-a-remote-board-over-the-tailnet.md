# The CLI Reaches a Remote Board Over the Tailnet

## Goal

Make `switchboard <command>` on a laptop operate the board running on another machine — the Pi — over
the tailnet, with the same commands and the same output as against a local board. Today the tailnet
carries the *browser* to the board and nothing else: every CLI command is hardcoded to loopback, so
an appliance you can open in Safari from anywhere is one you can only drive from a terminal sitting
on the appliance itself.

The board already accepts these calls. This is a client-side gap, start to finish.

### Problem Analysis

Five hardcodings in `src/standalone/cli.ts` pin the CLI to the machine the board runs on. All five
were correct when loopback was the only transport.

#### 1. The request URL is loopback, literally

```ts
let url = `http://127.0.0.1:${port}${pathname}`;
```

`cli.ts:508`, inside `apiRequest`. There is no host parameter. The transport is `http.request`
(`:550`) with no `https` branch, so the `tailscale serve` route is unreachable even if the host were
configurable.

#### 2. Port discovery reads the local filesystem

`resolveRunningPort` scans candidate ports, matching `/health`'s `roots` against a locally resolved
path, then falls back to reading `<workspaceRoot>/.switchboard/api-server-port.txt` (`cli.ts:435`).
Both halves assume the board's state directory is on this disk. On a laptop there is no such file,
and the port scan probes the laptop's own ports.

#### 3. `workspaceRoot` is a local path sent to a remote host

`apiRequest` routes `workspaceRoot` by method family — query param for GET/DELETE, body field for
POST/PUT/PATCH (`cli.ts:513-526`) — and the value comes from the CLI's cwd. A laptop path
(`/Users/p/work/labcom`) names nothing on the Pi.

**This is the dangerous one.** The docblock at `:514-517` already records why the param is not
optional:

> `workspaceRoot` is NOT optional on the read path. `_resolveDbFromQuery` falls back to the host's
> own selected root when the param is absent — on the extension host that is a DIFFERENT board from
> the one the CLI's cwd names.

Over the tailnet the same fallback is worse: sending a path the remote does not know, or omitting it,
silently resolves to whichever board the Pi happens to have selected. The operator reads a board,
acts on it, and never learns it was not the one they named. That is precisely the failure the
project's fallback rule exists to prevent, and no gate catches it — the response is a valid `200`.

#### 4. Token discovery reads a local file

```ts
const tokenFile = path.join(workspaceRoot, '.switchboard', 'api-server-token.txt');
```

`cli.ts:472`. The remote's token is on the remote's disk. `discoverAuthToken` returns `null`, and the
docblock's justification — *"the server's `_checkAuth` returns true on loopback with no token
configured, so the CLI works unauthenticated locally"* — is a statement about loopback that does not
transfer.

#### 5. `waitForHealth` probes `127.0.0.1` (`cli.ts:447`)

Minor, but it makes any "start it and wait" path local-only.

### What already works, and needs no change

Verified against the server, not assumed:

- **The Host guard passes.** A CLI request to `labcom.taile9aab9.ts.net:7777` sends that name as
  `Host`, and `isAllowedHostFor` accepts both the MagicDNS FQDN and its bare first label
  (`loopbackHostname.ts:191-195`).
- **The CSRF guard passes.** A CLI sends no `Origin` and no `Sec-Fetch-Site`, so it must carry the
  positive client marker — and `apiRequest` already sets `X-Switchboard-Client: switchboard-cli`
  (`cli.ts:549`).
- **The tailnet listener needs no credential.** A request arriving on the tailnet listener is trusted
  exactly as loopback is (`wsUpgradeAuth.ts:100-105`), identified by the socket's `localAddress`, not
  by a peer allowlist (`LocalApiServer.ts:1659-1672`).
- **`/health` is the discovery endpoint.** It is CSRF-exempt (`LocalApiServer.ts:12899`) and returns
  `roots` and `selectedWorkspaceRoot` (`:13424-13427`) — the remote tells you its board roots before
  you have named one.
- **`probeHealth` and `getHealthJson` already take a hostname**, defaulting to `127.0.0.1`
  (`cli.ts:374`, `:388`). The discovery half is already remote-capable; only its callers are not.

**No server-side change is required by this plan.**

## Metadata

**Complexity:** 5
**Tags:** cli, api, feature, infrastructure

## Host Scope

**Standalone only.** Every change is in `src/standalone/cli.ts` and a new sibling module; the CLI is
a standalone-host surface and the extension host does not have one. Per the cutover rule the
extension is out of scope and its absence here is the intended state, not a divergence. No
`extension.ts` composition-root seam is touched, and none should be added.

`LocalApiServer` is shared code, but this plan does not modify it.

## User Review Required

- **No token handling in v1 — the project has already settled that a credential is the wrong control
  here.** `auth-belongs-at-a-boundary-and-a-local-cli-is-not-one.md` gives each surface one control
  matched to its threat: file permissions for a shell user on the host, `Sec-Fetch-Site`/`Origin`
  plus the Host allowlist for a browser tab, and tailnet membership for a remote device. A token adds
  nothing to any of the three. It was made non-mandatory and is no longer minted unless an operator
  asks for one, which is why `_checkAuth`'s local-trust branch (`LocalApiServer.ts:1740`) is the live
  path on a default host. The remaining case a shared secret answers is a second uid on the same
  machine, which that plan puts out of scope by choosing `0600`.
- **What this means for the two transports.** Direct at `http://labcom...ts.net:7777` lands on the
  tailnet listener and is trusted by the bind (`:1724`). Through `tailscale serve`, tailscaled
  terminates TLS and proxies to `127.0.0.1:7777`, so the request arrives looking like loopback and
  the tailnet bypass does not fire — but it then hits the same local-trust branch and is trusted
  anyway. **Both routes work credential-free on a default host.** A `--token` pass-through is needed
  only by an operator who has opted into a durable token, and that operator can be served by a later
  card rather than by scope here.
- **Scope line: reads and verbs, not terminals.** Live terminal streaming rides the WS hub and the
  upgrade path has its own `Origin` check (`wsUpgradeAuth.ts:94-97`). A remote `switchboard fleet`
  showing seat *state* is in scope; attaching to a remote pty is a separate card.

## Settled Design

**A target is resolved once, explicitly, and carries its source.** Every command resolves an
`ApiTarget` before its first request. The target is `{ baseUrl, workspaceRoot, auth, source }`, and
`source` is printed on every remote command. "Which host and which board answered?" must be
answerable after the fact — the project's fallback rule, applied to a read that is now
routing-and-identity, not just configuration.

**A remote root is never guessed.** The remote's `/health` names its roots. One root: use it, tagged.
More than one: refuse and list them, requiring `--root`. Never fall back to the remote's
`selectedWorkspaceRoot`, which is exactly the quiet-wrong-answer shape.

**Local behaviour is untouched.** With no remote named, resolution returns today's local target by
today's path. A local invocation must not acquire a new failure mode, and must not print the new
source line.

## Complexity Audit

### Routine

- Threading a target object through `apiRequest` in place of `port`. **Only four call sites exist** —
  the definition (`cli.ts:496`), `apiGet` (`:574`), `apiPost` (`:581`), and the raw `api` verb
  (`:1910`). Every board command funnels through `apiGet`/`apiPost`, so this narrow seam reaches
  `plans`, `ready`, `dispatch`, `clear`, `fleet`, `next`, `reports`, `verb`, `api` and the bare menu
  at once.
- Adding an `https` branch to the request builder.
- `switchboard remote add|list|remove` as a new subcommand family.

### Complex / Risky

- **`probeHealth` compares `json.port === port` (`cli.ts:377`).** Behind `tailscale serve` you connect
  on 443 and the board reports 7777, so the probe fails on a perfectly healthy remote. The fix is the
  split already used by `isHttpsOriginReachable` (`tailnetOrigin.ts:66-75`): a *connect* port and an
  *expected* port, compared separately. Do not "fix" this by dropping the port comparison — it is
  what stops the CLI signalling a PID on a port some other process holds.
- **The write path merges `workspaceRoot` into the payload (`cli.ts:525-528`).** A remote target must
  merge the *remote* root. Getting this half-right — remote root on reads, local cwd on writes — is a
  silent cross-board write, the worst outcome this plan can produce.
- **Timeouts.** 15 s default (`cli.ts:503`) is a loopback budget. A tailnet hop to a sleeping Pi
  wants a connect-phase timeout distinct from the request timeout, and an error naming which expired.

## Edge-Case & Dependency Audit

1. **Remote down / Tailscale down.** Fail with the target's name and resolved URL, non-zero. Never
   fall back to the local board — that is the same class of bug as the root fallback, and the
   operator would act on the wrong board's output.
2. **Remote renamed.** The MagicDNS name changes when the machine or tailnet is renamed, and the
   board caches its own names at startup (`cli.ts:4692`, `:4865`). A stored remote whose name no
   longer resolves must say "this remote's name does not resolve — the machine may have been
   renamed", not "connection refused".
3. **Ambiguous root.** Remote has two roots, no `--root`: refuse, list both, exit non-zero.
4. **Stale stored root.** Stored root is absent from the remote's current `/health.roots`: refuse and
   re-list. Do not silently switch to the surviving one.
5. **Version skew.** A remote on an older build may omit `/health` fields. Absence is absence — never
   read a missing field as a default (the `hostCapability` precedent at `cli.ts:393-395`).
6. **`--remote` plus a local-only subcommand** (`stop`, `logs`, `service`, `init`): refuse with a
   clear message. `stop` over a tailnet is a separate decision, not an accident.
7. **Config file is new, unreleased state.** No migration is owed. It must not be written inside a
   workspace's `.switchboard/` — it is per-operator, not per-board.

## Proposed Changes

### Change A — an `ApiTarget`, resolved once and tagged

New module `src/standalone/apiTarget.ts`:

```ts
export interface ApiTarget {
    baseUrl: string;          // 'http://labcom.taile9aab9.ts.net:7777' | 'https://labcom...ts.net'
    workspaceRoot: string;    // the REMOTE's root, from its /health
    auth: { token: string; source: string } | { token: null; source: 'tailnet-listener-trusted' };
    source: string;           // 'flag:--remote labcom' | 'env:SWITCHBOARD_REMOTE' | 'config:remotes.labcom' | 'local:port-file'
    isRemote: boolean;
}

export async function resolveApiTarget(opts: {...}): Promise<ApiTarget>;
```

Precedence, highest first: `--remote <name|url>`, `SWITCHBOARD_REMOTE`, a configured default remote,
local discovery. No silent fallback between tiers — a named remote that fails to resolve is an error,
not a demotion to local.

### Change B — `apiRequest` takes a target, not a port

```ts
function apiRequest(target: ApiTarget, method: string, pathname: string, payload?, query?, timeoutMs?)
```

`workspaceRoot` comes from `target`, not from a separate argument, which structurally prevents the
half-right read/write split named in the Complexity Audit. Pick `http` or `https` from `baseUrl`.
Keep the `X-Switchboard-Client` marker unconditionally. Four call sites to update.

### Change C — `switchboard remote add|list|remove`

`add <name> <url> [--root <path>]` probes `/health` first and refuses to store a target
it cannot reach. It records the name, base URL, the roots the remote reported, and the chosen root.
`list` prints each remote with its URL, root, and last successful contact. Config lives in the
per-operator config directory, `0600`.

`add` probes `/health` and then makes one real read, so the target is stored only if it actually
answers. No credential is sent and none is stored — see *User Review Required*. If that read returns
`401`, the remote has a durable token configured; `add` refuses and names the cause rather than
storing a target that cannot be used. Supporting that case is a follow-up card, not v1.

### Change D — split connect port from expected port in the health probe

Give `probeHealth`/`getHealthJson` an explicit expected-port parameter, defaulting to the connect
port so every existing caller is unchanged. Mirrors `isHttpsOriginReachable`
(`tailnetOrigin.ts:66-75`), which solved this exact problem for the browser URL.

### Change E — surface the target

Every remote command prints one line before its output:

```
[switchboard] labcom · https://labcom.taile9aab9.ts.net · /home/patrick/labcom · via config:remotes.labcom
```

Suppressed under `--json` (where the same facts go into the payload) and absent for local
invocations. This is the tagging half of the fallback rule: the source is not merely returned, it is
shown where it is used.

## Verification Plan

### Goal Invariants

1. `switchboard --remote labcom plans` on a laptop prints the Pi's board, not the laptop's.
2. With no remote named, every command behaves exactly as today, with no extra output.
3. A remote with two roots and no `--root` exits non-zero listing both, and reads nothing.
4. A remote that is unreachable exits non-zero naming it, and never reads the local board.
5. A write against a remote target carries the remote root in its payload. There is no path where a
   read uses the remote root and a write uses the local cwd.
6. **No refusal in this feature can lock the operator out silently.** Every auth-shaped or
   target-shaped refusal names the cause *and* the recovery step — a remote whose board has a durable
   token configured must say so and name `switchboard token clear` (run on the remote), not return a
   bare `401`. This invariant exists because credential lockouts are this product's documented
   failure history: the skill layer 401'ing wholesale, agents 401'ing under `switchboard tailnet`
   against help text promising no token, and the 2026-09-13 CSRF lockout where the operator could not
   reach their own board from any machine. A remote CLI is a fourth place for that to happen, and it
   must not be.

### Automated Tests

New contract suite `src/test/cli-remote-target-contract.test.js`:

- `apiRequest` contains no literal `127.0.0.1` in its URL construction; the base comes from the target.
- Every `ApiTarget` carries a non-empty `source`; a resolver returning an untagged target fails.
- Resolution precedence, including: a named-but-unreachable remote **errors** rather than resolving
  local. Assert on the error, since the bug would look like success.
- Two-root remote without `--root` → refusal. One-root → resolved and tagged.
- Write payload merges `target.workspaceRoot`, asserted against a mock host that records what it
  received. This is invariant 5 and it needs a behavioural test, not a source-shape one.
- `probeHealth` with connect port ≠ expected port succeeds when the body reports the expected port,
  and fails when it reports a third value.
- Every refusal path (unreachable remote, ambiguous root, stale root, `401` from a token-configured
  remote) produces a message containing a recovery step. Assert on the message, not just the exit
  code — invariant 6 is about what the operator is told, and an exit code tells them nothing.

`npm run compile-tests` before running, per the build rule.

### Manual Verification

1. From a second machine on the tailnet: `switchboard remote add labcom http://labcom:7777` — succeeds
   and lists the Pi's roots.
2. `switchboard --remote labcom plans`, `ready`, `fleet` — all show the Pi's board.
3. A verb POST against the remote; confirm on the Pi's own board that it landed on the named root.
4. Stop Tailscale on the laptop; every remote command fails naming the remote, and the local board is
   never read.
5. Repeat 2 against the `tailscale serve` HTTPS URL with a token; then without one, and confirm the
   error explains the proxy/token posture rather than printing a bare 401.

## Outstanding Questions

- **Should `--remote` become sticky per shell** (a `switchboard remote use <name>` that sets a default
  for the session), or stay explicit on every invocation? Explicit is safer — a sticky remote is a
  cross-board write waiting to happen — but it is more typing for the appliance workflow this plan
  exists to serve.
- **Live follow.** `switchboard fleet --watch` over a tailnet needs the WS hub, whose upgrade path
  validates `Origin` against the bind policy (`wsUpgradeAuth.ts:94-97`). A CLI sends no `Origin` at
  all, so it passes today — but that should be confirmed deliberately rather than relied on, and it is
  a separate card.

## Recommendation

Land A, B, C, D and E as one piece — with Change C carrying no token handling. On a default host
that is the complete feature for **both** transports, because neither requires a credential. The
durable-token case is a separate card, and per
`auth-belongs-at-a-boundary-and-a-local-cli-is-not-one.md` it serves a threat model this product has
explicitly declined to adopt.
