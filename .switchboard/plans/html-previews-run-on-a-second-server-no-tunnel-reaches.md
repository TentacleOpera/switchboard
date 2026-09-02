# HTML previews run on a second ephemeral server that no tunnel and no Remote-SSH forward can reach

## Goal

Make Design and Planning HTML previews work when the panel is not on the same machine as the
browser — under an SSH tunnel, under VS Code Remote-SSH, and behind any proxy — by serving
previews from the board's own port on a distinct origin, instead of from a per-folder ephemeral
server whose port is unknowable in advance.

### Problem Analysis

**Previews are served by a second HTTP server, not by `LocalApiServer`.**
`DesignPanelProvider._createHtmlServer` (`src/services/DesignPanelProvider.ts:2208`) stands up
its own `http.createServer`. Nothing about it rides the port a tunnel forwards.

**Its port cannot be forwarded, even deliberately.** Line 2213 is
`server.listen(0, '127.0.0.1', …)` — port `0`, so the OS assigns a fresh ephemeral port at the
moment a preview opens. It is **one server per source folder** (`_htmlServers` is a map keyed by
`sourceFolder`), and each carries a reaper (`_createServerTimeout`) that tears it down after an
idle period. So there is no stable port to pre-forward, and even a port forwarded by hand dies
and the next preview lands somewhere else.

**And the URL handed to the iframe is absolute.** `_buildLocalhostUrl` returns:

```ts
return `http://127.0.0.1:${serverEntry.port}/${urlPath}`;
```

The browser resolves that against **its own machine**, where nothing is listening. The iframe
comes back blank.

**This is the same class of bug `standalone-remote-access-story.md` fixed, in a place that fix
could not reach.** That plan corrected three absolute-URL builders —
`TicketsPanelProvider._buildLocalAssetUrl`, `PlanningPanelProvider._buildLocalAssetUrl`, and
`DesignPanelProvider._absoluteApiUrl` — by making them host-aware: origin-relative for the
standalone browser board, absolute loopback for the VS Code webview. `_buildLocalhostUrl` has
the identical shape but was out of scope, because it does not point at the API server's port at
all. That plan's review findings recorded the gap explicitly: "the Design/Planning HTML-preview
iframes use a *second* ephemeral server (`_createHtmlServer`) that no tunnel reaches — out of
this plan's scope but undocumented."

**It is broken for VS Code Remote-SSH too, not just the standalone board.** Under Remote-SSH
the webview runs on the client while the extension host runs on the server, so the absolute
`127.0.0.1:<ephemeral>` resolves on the client. VS Code's automatic port forwarding cannot help:
it has no way to forward a port nothing announced. So this is not a standalone-host quirk — it
affects the in-IDE remote path that is the project's recommended laptop posture.

**The server is also unauthenticated.** `_handleHtmlServerRequest` (`:2230`) has exactly two
guards: a path-traversal containment check against `sourceFolder`, and a component deny-list
(`_SERVER_DENY_LIST`) applied to the path components *below* the served folder. There is no
token check, no cookie check, and no call to `_checkAuth` — it is a static file server on
loopback with no credential. That is defensible today because it is loopback-bound and
short-lived, but it is a second unauthenticated surface that no part of the remote-access
documentation mentions.

### Root Cause

The separate server exists for a real reason, recorded at `:2184`: "srcdoc iframes inherit the
webview's CSP and break relative asset paths; serving from 127.0.0.1 gives previews a real
origin (CSP frame-src allows http:)." Previews render Babel-compiled React and Stitch output —
untrusted, generated markup — and giving it its own origin is correct isolation, not an
accident.

What was never revisited is the assumption bundled in with it: that "a real origin" requires a
separate *server*. An origin is scheme + host + port, so a different **host** on the same port
is a different origin. The isolation requirement and the second server were conflated, and the
second server is the part that breaks remoting.

### Non-goals

- **Not making previews same-origin with the board.** That would let generated preview markup
  reach the board's DOM and session, and is a genuine security regression. Isolation is
  preserved, by a different mechanism.
- **Not removing the iframe or changing how previews are authored.** The Babel intercept and
  the diagnostic error-reporting script injected at `:2270+` stay as they are.
- **No change to the four loopback guards.** No bind change, no peer-check change, no new
  accepted Host name beyond what `isLoopbackHostname` already accepts.
- **Not a fix for the Stitch cache layout.** The `_SERVER_DENY_LIST` behaviour and the reason it
  checks components below `sourceFolder` rather than the absolute path (recorded at `:2250-2254` —
  checking the absolute path 403'd every server rooted under a dot-folder, including
  `.switchboard/stitch`) must be preserved exactly, not redesigned.

## Metadata

**Complexity:** 6
**Tags:** bugfix, backend, security, infrastructure, ui

## User Review Required

Yes — two decisions, both design.

**Decision 1 — Where do previews get their origin?**

1. **A distinct hostname on the board's existing port (recommended).**
   `isLoopbackHostname` (`src/utils/loopbackHostname.ts:62`) already accepts `*.localhost` via
   `DOT_LOCALHOST_RE`, and RFC 6761 §6.3 makes every name under `.localhost` unspoofably
   loopback — the module's own comment explains that accepting the subdomain "widens the *name*
   space, not the *network* space". So `http://preview.localhost:<board-port>/…` is a **different
   origin** from `http://switchboard.localhost:<board-port>/…` while being the **same port**: one
   tunnel carries both, the Host guard accepts both without modification, and the isolation the
   separate server provides is preserved by the browser's own origin rules.
2. **Keep the second server but make its port stable and configurable.** Smaller change, but it
   still requires the operator to forward a second port, still cannot be auto-forwarded by
   Remote-SSH reliably, and leaves the unauthenticated surface in place.
3. **Serve previews through the board with a sandboxed iframe and no separate origin.** Rejected
   — `sandbox` is not a substitute for origin separation here, and this is the same-origin
   regression named in Non-goals.

Recommendation: **option 1.** It fixes the tunnel case, the Remote-SSH case and the proxy case
at once, retires an unauthenticated server, and needs no new accepted Host name.

**Decision 2 — The credential path on the new route.**

The current preview server has no auth. Serving through `LocalApiServer` means the route either
passes `_checkAuth` or is explicitly exempted. The iframe cannot send a `Bearer` header, and the
`sb_session` cookie is scoped to the board's host (`SameSite=Strict`) and is **not sent to
`preview.localhost`** — a different host — so a naive `_checkAuth` on the route 401s every
preview under a configured durable token, while a naive exemption publishes an unauthenticated
read through every tunnel.

Recommended resolution: **exempt the preview route from `_checkAuth`, scoped to registered roots
only.** The control is the server-side registry: only registered preview folders are served, the
traversal + deny-list guards run verbatim, and any unregistered id 404s. This preserves today's
unauthenticated-loopback posture (and on the extension host `_checkAuth` already returns true on
loopback with no token, so nothing changes there). Under a configured durable token on the
standalone host the exemption means previews render without a credential — but the board itself
is reachable through the same tunnel once the session cookie is obtained, and an unauthenticated
preview-file read of user-configured Design/HTML folders is strictly less powerful than the PTY
spawn and git writes the board already serves through that tunnel. The loopback/tunnel = trusted
threat model is the load-bearing assumption and is unchanged.

The alternative (a per-preview-id token embedded in the iframe URL) is more secure but adds
minting/validation machinery for a threat model the existing posture already accepts. It is a
valid choice if the operator wants defence-in-depth on the standalone host with a durable token.

## Complexity Audit

### Routine

- Routing preview paths on `LocalApiServer` and returning the same bytes
  `_handleHtmlServerRequest` returns today.
- Rewriting `_buildLocalhostUrl` to emit the new origin.
- Deleting `_createHtmlServer`, `_getOrCreateHtmlServer`, `_createServerTimeout`, the
  `_htmlServers` map and `_htmlServerCreationPromises` once nothing calls them — and the
  Planning equivalents (`_createPlanningHtmlServer`, `_planningHtmlServers`,
  `_planningHtmlServerCreationPromises`, `_createPlanningHtmlServerTimeout`).

### Complex / Risky

- **Path scoping is the security boundary, and it moves.** Today containment is guaranteed by
  the server being *rooted* at one `sourceFolder` (a constructor argument, not request input).
  Served from the board, the folder becomes a registry lookup keyed by a preview id in the URL,
  and a parameter is attacker-influenced in a way a constructor argument is not. The traversal
  check, the deny-list, and the "only components below the served root" rule must all be
  reproduced with the root established server-side from the registry — never taken from the
  request.
- **Auth is a change in behaviour, not only in code.** The current server has none. Serving
  previews through `LocalApiServer` means they either pass `_checkAuth` (correct, but the iframe
  cannot carry the credential to a different host) or are explicitly exempted (preserving
  today's posture but on a route that is now reachable through every tunnel). This is the
  subtlest part of the change and the most likely to be got wrong quietly. The recommended
  resolution (exempt + scope to registered roots) is stated in User Review Required, Decision 2.
- **The reaper did real work.** The idle timeout bounded how long a folder stayed served. A
  board-hosted route has no natural lifetime, so "which folders are currently previewable" must
  become explicit registry state rather than an emergent property of a timeout. The registry
  entry's lifetime is bounded by the panel's (register on preview open, unregister on panel
  dispose); an idle reaper is optional, not required, since the route is a cheap map lookup, not
  a listening socket.
- **Two providers, two HTML injections.** `DesignPanelProvider._handleHtmlServerRequest`
  injects `babelPatch + diag + _INSPECTOR_SCRIPT` (`:2421`); `PlanningPanelProvider` injects
  only `_INSPECTOR_SCRIPT` (`:2012`). The new route must dispatch the correct injection set per
  provider — copying Design's Babel patch into Planning would not break anything (the patch is
  inert without `text/babel` scripts) but would add an unexpected diagnostic `postMessage` the
  Planning panel does not listen for. The registry must carry the provider kind.

> **Superseded:** "Two hosts, two correct answers. … The fix must be host-aware in the same way,
> using the same `_panel`-guard pattern that plan established, rather than a blanket replacement."
> **Reason:** The `_panel`-guard pattern returns `http://127.0.0.1:<port>` for the webview. The
> board's own API is at `http://127.0.0.1:<port>` (`_absoluteApiUrl`, `:247-253`). A preview
> iframe at `http://127.0.0.1:<port>/preview/…` would be **same-origin with the board API** on
> the webview host — exactly the isolation regression the Non-goals forbid. The separate server
> isolates previews today *by port* (`127.0.0.1:<ephemeral>` ≠ `127.0.0.1:<board>`); collapsing
> onto one port and one host loses that. Previews need origin isolation from the board on **both**
> hosts, so the `_panel`-guard (which switches between absolute-loopback and origin-relative) is
> the wrong pattern for previews.
> **Replaced with:** One origin on both hosts — `http://preview.localhost:<board-port>/preview/<id>/…`.
> The browser/Electron iframe renderer resolves `preview.localhost` to 127.0.0.1 internally
> (RFC 6761 §6.3; the OS resolver need not), the port is the board's single port (one tunnel, one
> forwarded port), and the origin differs from the board on both hosts (`switchboard.localhost`
> for the browser board; `127.0.0.1` for the webview's board-API origin). No host-aware branching
> is needed — simpler and correct.

> **Superseded:** "CSP `frame-src` on two panels. … `frame-src` must now admit the preview origin
> — which is a widening, in the opposite direction, and must be scoped to the preview host rather
> than `http://127.0.0.1:*`."
> **Reason:** The current CSPs do not use `http://127.0.0.1:*`. `headlessPanelHtml.ts:311`
> (Planning) and `:347` (Design) both read `frame-src 'self' http: https: about:srcdoc blob:
> data:` — the **entire `http:` scheme**, which already admits `http://preview.localhost:<port>`.
> The webview templates (`src/webview/design.html:6`, `planning.html:6`) likewise carry `http:` in
> `frame-src`. No widening is required for the fix to work.
> **Replaced with:** No `frame-src` change is needed for the fix. A *future* tightening that
> scopes `http:` down to the specific preview host is optional hardening, but must first confirm
> no other `http` iframe consumer exists (Stitch embeds, external preview references) — that is a
> separate task, not this fix.

## Edge-Case & Dependency Audit

**Race conditions**
- Today `_getOrCreateHtmlServer` single-flights concurrent creation for one folder via
  `_htmlServerCreationPromises`. A registry needs the equivalent guard on whatever map replaces
  it, or two previews opened at once can register conflicting ids for the same folder.
- A preview open while its folder is unregistered (or reaped, under any retained timeout) must
  404 legibly rather than serve from a stale root.

**Security**
- **Traversal containment must be re-proved, not inherited.** `path.resolve` + the
  `startsWith(normalizedSource + path.sep)` check + the deny-list are the whole boundary. With
  the root as a registry lookup, the test suite has to cover encoded traversal, symlinks, and
  absolute paths in the request.
- **The `.switchboard/stitch` case is a regression trap.** `:2250-2254` records that checking
  the absolute path 403'd every legitimately dot-rooted server. Any reimplementation that
  "tidies" the deny-list to check the whole path reintroduces that bug.
- **Origin separation is the point.** If previews end up same-origin with the board API,
  generated markup can reach the board's API endpoints. A test must assert the preview iframe's
  origin is not the board API's origin on both hosts.
- **Retiring an unauthenticated server is a net improvement** and should be stated as one — but
  only if the replacement route does not become an unauthenticated read reachable through every
  tunnel instead. The recommended exempt-and-scope posture preserves the existing threat model;
  the registry is the control.
- The four loopback guards are untouched; `loopback-hostname-contract` must stay green.

**Side effects**
- `PlanningPanelProvider` holds its own copy of the server (`_createPlanningHtmlServer`,
  `:1943`; `_buildLocalhostUrl`, `:1959`; `_handlePlanningHtmlServerRequest`, `:1965`). Both
  must move together or the bug persists in one panel — and a grep for `listen(0, '127.0.0.1'`
  across `src/` is the honest way to find every instance rather than trusting two.
- Killing the second server removes a port from the host's listening set, which is a small
  attack-surface reduction worth noting in `docs/REMOTE_ACCESS.md`, whose "what is not
  supported" section currently says nothing about previews.

**Migration**
- No stored state, no settings, no file formats. Preview URLs are generated per render and never
  persisted, so there is nothing to migrate — but the change is user-visible in both hosts, and
  the VS Code webview path is the regression most likely to be caused.

## Dependencies

- **Builds on** `standalone-remote-access-story.md`, whose host-aware `_panel`-guard pattern
  this change should follow for *asset* URLs — but **not** for preview URLs, which need a
  distinct origin on both hosts (see the superseded callout in Complexity Audit).
- **Independent of** the phone/mobile feature. This is a laptop-remote bug: it affects the SSH
  tunnel and Remote-SSH paths that are already the recommended posture.
- **Feeds** `docs/REMOTE_ACCESS.md`, which should state the outcome either way.

## Adversarial Synthesis

Key risks: (1) collapsing previews onto `127.0.0.1:<board-port>` on the webview host, making
them same-origin with the board API — the original plan's `_panel`-guard pattern would have done
this; (2) reimplementing the path guards with the root taken from the request instead of from a
server-side registry; (3) "tidying" the deny-list into an absolute-path check and re-403'ing
every dot-rooted folder, a bug this codebase has already fixed once; (4) getting auth wrong
quietly — a cookie scoped to the board host is not sent to `preview.localhost`, so a naive
`_checkAuth` 401s every preview while a naive exemption publishes an unauthenticated read
through every tunnel; (5) fixing `DesignPanelProvider` and missing the Planning ancestor, or
copying Design's Babel/diagnostic injection into Planning where it does not belong; (6) the new
origin must still bypass the VS Code Service Worker for HTML delivery, not merely satisfy the
CSP — a blank iframe in VS Code is the symptom a prior fix already addressed once.
Mitigations: a distinct `preview.localhost` origin on the same port on **both** hosts, which the
Host guard already accepts by construction; root established server-side from a registry keyed
by preview id, never from the request; the deny-list ported verbatim with its comment; an
explicit exempt-and-scope auth decision (User Review Required, Decision 2) with a test for each
outcome; the registry carries the provider kind so the route injects the correct script set; and
a repo-wide grep for `listen(0, '127.0.0.1'` as the scope-completeness check, plus a named
service-worker regression in the verification plan.

## Proposed Changes

1. **Serve previews from `LocalApiServer`** on a distinct `preview.localhost` host, same port,
   with a server-side registry mapping a preview id to its `sourceFolder` **and provider kind**
   (`design` | `planning`). The request path is `/preview/<previewId>/<relative-path>`; it never
   carries a root. The route is registered in the `_handleRequest` if/else chain
   (`LocalApiServer.ts:8355` region), alongside `/design/asset`.

2. **Wire the registry via the existing callback pattern.** Add
   `getPreviewRoot?: (previewId: string) => { sourceFolder: string; providerKind: 'design' | 'planning' } | null`
   to `LocalApiServerOptions` (`:526-547` region), mirroring `getDesignAssetRoots`. Each provider
   owns its id→folder map and exposes it through this callback; the route calls the callback,
   never trusts a request-supplied root. Register on preview open, unregister on panel dispose.
   A single-flight guard on id allocation replaces `_htmlServerCreationPromises`.

3. **Port the guards verbatim** — traversal containment (`path.resolve` + the
   `startsWith(normalizedSource + path.sep)` check) and the deny-list applied only to components
   below the registered root, with the `:2250-2254` comment carried across so the reason
   survives. The root comes from the registry lookup, not from the request.

4. **Make `_buildLocalhostUrl` emit `http://preview.localhost:<board-port>/preview/<id>/<path>`
   on BOTH hosts.**
   > **Superseded:** "Make `_buildLocalhostUrl` host-aware, following the `_panel`-guard pattern
   > the earlier plan established: the new preview origin for the browser board, and whatever the
   > webview requires for the extension host."
   > **Reason:** The `_panel`-guard returns `http://127.0.0.1:<port>` on the webview, which is
   > same-origin with the board API — the isolation regression. See the Complexity Audit
   > superseded callout for the full argument.
   > **Replaced with:** `http://preview.localhost:<board-port>/preview/<id>/<rel-path>` on both
   > the browser board and the VS Code webview. The board port is `this._apiServer?.getPort?.()`.
   > No `_panel` branching. The iframe renderer resolves `preview.localhost` to 127.0.0.1
   > internally on every host; under Remote-SSH the board port is the one forwarded port.

5. **Decide and implement the credential path — recommended: exempt, scoped to registered
   roots.** The preview route is exempted from `_checkAuth`, consistent with the loopback-trust
   posture (`_checkAuth` returns true on loopback with no token regardless). The control is the
   registry: only registered folders are served, the guards run verbatim, and any unregistered
   id 404s. Document the decision in `docs/REMOTE_ACCESS.md`. If the operator chooses the
   per-preview-id token alternative (User Review Required, Decision 2), the provider mints a
   random secret per id, embeds it in the iframe URL, and the route validates it before the
   registry lookup.
   > **Superseded:** "Decide and implement the credential path — authenticated route or explicit
   > exemption — and document which, since the current server's total absence of auth is
   > undocumented either way."
   > **Reason:** A plan is a decision document. Naming both failures and leaving the choice open
   > hands the coder an unbounded security decision. The exempt-and-scope path is consistent with
   > the existing threat model and is the least-surprise resolution.
   > **Replaced with:** Exempt the route from `_checkAuth`, scope to registered roots, document
   > in `docs/REMOTE_ACCESS.md`. The per-id-token alternative is recorded as a valid choice in
   > User Review Required, Decision 2.

6. **No `frame-src` change is required.** The Planning and Design CSPs
   (`headlessPanelHtml.ts:311`, `:347`) and the webview templates (`design.html:6`,
   `planning.html:6`) already admit `http:` origins, which covers
   `http://preview.localhost:<port>`. A future tightening to scope `http:` to the preview host
   is optional hardening for a separate task (must first confirm no other `http` iframe
   consumer exists).
   > **Superseded:** "Widen `frame-src` on the Planning and Design CSPs to the preview origin
   > only, not `http://127.0.0.1:*`."
   > **Reason:** The CSPs already use `http:` (the whole scheme), not `http://127.0.0.1:*`. The
   > preview origin is already admitted. See the Complexity Audit superseded callout.
   > **Replaced with:** No change. Optional future tightening noted.

7. **Dispatch the HTML injection per provider kind.** The route handler injects
   `babelPatch + diag + _INSPECTOR_SCRIPT` for `design` previews (`:2421`) and
   `_INSPECTOR_SCRIPT` only for `planning` previews (`:2012`). Non-HTML assets pass through
   byte-identical with `no-store`.

8. **Delete the second server and its lifecycle machinery** in both providers once nothing
   references it: `_createHtmlServer`, `_getOrCreateHtmlServer`, `_createServerTimeout`,
   `_htmlServers`, `_htmlServerCreationPromises` (Design); `_createPlanningHtmlServer`,
   `_getOrCreatePlanningHtmlServer`, `_createPlanningHtmlServerTimeout`,
   `_planningHtmlServers`, `_planningHtmlServerCreationPromises` (Planning). Grep for
   `listen(0, '127.0.0.1'` to confirm no sibling copy survives (the only remaining hits should be
   `ptyHost.ts` and test fixtures).

9. **Update `docs/REMOTE_ACCESS.md`** to state that previews work under a tunnel and Remote-SSH,
   replacing the silence that currently leaves the gap undocumented, and noting the removed
   listening port as an attack-surface reduction.

### Migration

Nothing stored changes. The behavioural surface is preview rendering in the Design and Planning
panels on both hosts, plus one fewer listening port on the host.

## Verification Plan

### Automated Tests

1. **Origins differ, both hosts.** Assert programmatically that the preview iframe's origin
   (`http://preview.localhost:<port>`) is not the board API's origin (`http://127.0.0.1:<port>`
   on the webview / `http://switchboard.localhost:<port>` on the browser board), and that script
   in the preview cannot reach the parent document.
2. **Traversal, with the root as a registry lookup.** Encoded `..`, absolute paths, symlinks out
   of the registered folder, and a request naming an unregistered id. All refused.
3. **The dot-folder case.** Preview content served from `.switchboard/stitch` renders — the
   exact regression `:2250-2254` records fixing once already.
4. **Babel intercept and error diagnostics intact.** A preview using
   `<script type="text/babel">` with `react/jsx-runtime` imports still compiles and runs, and a
   deliberately broken preview still reports its load error back to the parent panel.
5. **Planning injection parity.** A Planning HTML preview renders with the inspector script and
   without a stray diagnostic `postMessage` the Planning panel does not handle.
6. **Concurrency.** Open several previews across several folders simultaneously and assert no
   cross-folder bleed and no registration race.
7. **Credential behaviour matches the decision.** Whichever path was chosen, assert it: an
   exempt route is provably scoped to registered roots only (unregistered id → 404); or a
   per-id-token route rejects a request lacking the token.
8. **The old server is gone.** Assert no ephemeral listener appears when a preview opens
   (compare the host's listening sockets before and after), and that
   `grep -rn "listen(0, '127.0.0.1'" src/services/DesignPanelProvider.ts src/services/PlanningPanelProvider.ts`
   returns nothing.
9. **Guards unchanged.** `loopback-hostname-contract` green; `curl -H 'Host: evil.example'` →
   403; a LAN peer → 403; `Host: preview.localhost:<port>` → accepted.

### Goal Invariants

- The preview iframe URL emitted by `_buildLocalhostUrl` in both `DesignPanelProvider` and
  `PlanningPanelProvider` starts with `http://preview.localhost:`.
- `grep -rn "listen(0, '127.0.0.1'" src/services/DesignPanelProvider.ts` returns no matches
  (the ephemeral preview server is gone).
- `grep -rn "listen(0, '127.0.0.1'" src/services/PlanningPanelProvider.ts` returns no matches.
- The symbols `_createHtmlServer`, `_getOrCreateHtmlServer`, `_htmlServers` are absent from
  `src/services/DesignPanelProvider.ts`.
- The symbols `_createPlanningHtmlServer`, `_planningHtmlServers` are absent from
  `src/services/PlanningPanelProvider.ts`.
- A route matching `/preview/` exists in `LocalApiServer._handleRequest`
  (`src/services/LocalApiServer.ts`).
- `getPreviewRoot` is a key on `LocalApiServerOptions` in `src/services/LocalApiServer.ts`.
- The preview iframe origin (`http://preview.localhost:<port>`) is not equal to the board API
  origin on either host (negative: previews are not same-origin with the board API; positive:
  previews are resolvable at the `preview.localhost` origin).

### Manual Verification

1. **Port-shifted tunnel.** Launch on an ephemeral port, `ssh -L 7777:127.0.0.1:<real>`, open an
   HTML preview and a Stitch preview. Both render. This fails today and is the fix's proof.
2. **VS Code Remote-SSH.** Open both previews with the extension host on the server and the
   webview on the client. Both render — the second half of the bug, and the path most likely to
   be forgotten. Confirm the forwarded port preserves `Host: preview.localhost:<port>` (the
   server's `isLoopbackHostname` check must accept it).
3. **Local extension host unregressed.** Same previews in a local VS Code window. This is the
   regression the change most plausibly causes.
4. **Service-worker bypass regression (named).** A prior fix (`brain_21e1909a…md`,
   "Webview HTML Preview Rendering Security and Service Worker Fix") solved a blank-white-screen
   failure by bypassing the VS Code Service Worker for HTML content delivery — part of why
   previews use a real `http://` origin rather than `asWebviewUri` or `srcdoc`. The new
   `preview.localhost` origin is still a real `http://` origin, so the bypass should hold — but
   verify explicitly: a blank iframe in VS Code is the symptom that plan already fixed once. Do
   not trust step 3's general "local extension host unregressed" to catch it.
5. **Windows `.localhost` resolution.** Confirm the iframe (rendered by Chromium/Electron, which
   resolves `.localhost` internally per RFC 6761) renders on Windows, where the OS resolver does
   not implement the `.localhost` TLD. The iframe is a browser context, so this is expected to
   pass — but it is the assumption most worth testing before committing.

## Sweep findings: siblings and a prior service-worker fix

*Appended after a sweep of existing plans.*

**The Planning ancestor is real, and there are more callers than two.** This plan's scope-completeness
check (grep `listen(0, '127.0.0.1'` across `src/`) is confirmed necessary: `_createHtmlServer` or the
preview-server pattern is referenced by `design-panel-extraction-and-stitch-integration.md`,
`planning-panel-cleanup.md`, and `feature_plan_20260626140002_planning_html_tab_with_independent_folders.md`
as well as `standalone-remote-access-story.md`. Read those before moving the server — the Planning
panel's copy is the one `DesignPanelProvider.ts:2184` describes itself as "ported from".

**A prior fix in this exact subsystem constrains the design.**
`brain_21e1909a…md` ("Webview HTML Preview Rendering Security and Service Worker Fix") solved a
blank-white-screen failure by **bypassing the VS Code Service Worker for HTML content delivery**,
which is part of why previews are served from a real `http://127.0.0.1` origin rather than through
`asWebviewUri` or `srcdoc`. That is a second reason for the separate origin, additional to the CSP
and relative-path reason recorded at `DesignPanelProvider.ts:2184`.

**Consequence for the proposed `preview.localhost` design:** the new origin must still bypass the
webview service worker on the extension host, not merely satisfy the CSP. Verify against that
failure mode explicitly — a blank iframe in VS Code is the symptom, and it is the same symptom that
plan already fixed once. It is a named regression in the verification plan (Manual Verification,
step 4).
