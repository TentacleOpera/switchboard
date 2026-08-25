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

**Its port cannot be forwarded, even deliberately.** Line 2211 is
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

**The server is also unauthenticated.** `_handleHtmlServerRequest` (`:2228`) has exactly two
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
  checks components below `sourceFolder` rather than the absolute path (recorded at `:2253` —
  checking the absolute path 403'd every server rooted under a dot-folder, including
  `.switchboard/stitch`) must be preserved exactly, not redesigned.

## Metadata

**Complexity:** 6
**Tags:** bugfix, backend, security, infrastructure, ui

## User Review Required

Yes — one decision, and it is the design.

**Where do previews get their origin?**

1. **A distinct hostname on the board's existing port (recommended).**
   `isLoopbackHostname` (`src/utils/loopbackHostname.ts:64`) already accepts `*.localhost` via
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
at once, retires an unauthenticated server, and needs no new accepted Host name. The open
question it must answer during verification is whether the Design and Planning panel CSPs'
`frame-src` directives admit the new origin, and whether Windows' lack of `.localhost` resolution
matters — `isHostnameReachable` (`:96`) exists precisely because "the Windows resolver does not
implement the `.localhost` TLD (browsers do it internally, the OS does not)". Browsers resolving
it internally is what this design needs, and the iframe is a browser, so this is likely fine —
but it is the assumption most worth testing before committing.

## Complexity Audit

### Routine

- Routing preview paths on `LocalApiServer` and returning the same bytes
  `_handleHtmlServerRequest` returns today.
- Rewriting `_buildLocalhostUrl` to emit the new origin.
- Deleting `_createHtmlServer`, `_getOrCreateHtmlServer`, `_createServerTimeout`, the
  `_htmlServers` map and `_htmlServerCreationPromises` once nothing calls them.

### Complex / Risky

- **Two hosts, two correct answers.** As with the three providers the earlier plan fixed, the
  VS Code webview and the standalone browser board need different URLs — the webview's page
  origin is `vscode-webview://…`, where the browser's own resolution of `preview.localhost`
  still applies but the CSP is the webview's. The fix must be host-aware in the same way, using
  the same `_panel`-guard pattern that plan established, rather than a blanket replacement.
- **CSP `frame-src` on two panels.** `headlessPanelHtml.ts` sets the Planning and Design CSPs.
  The earlier plan *tightened* their `img-src` to `'self' data:` once absolute loopback image
  URLs were gone. `frame-src` must now admit the preview origin — which is a widening, in the
  opposite direction, and must be scoped to the preview host rather than `http://127.0.0.1:*`.
- **Path scoping is the security boundary, and it moves.** Today containment is guaranteed by
  the server being *rooted* at one `sourceFolder`. Served from the board, the folder becomes a
  parameter, and a parameter is attacker-influenced in a way a constructor argument is not. The
  traversal check, the deny-list, and the "only components below the served root" rule must all
  be reproduced with the root established server-side — never taken from the request.
- **Auth is a change in behaviour, not only in code.** The current server has none. Serving
  previews through `LocalApiServer` means they either pass `_checkAuth` (correct, but the iframe
  must then carry the credential — a cookie scoped to a *different* host will not be sent) or are
  explicitly exempted (preserving today's posture but on a route that is now reachable through
  every tunnel). This is the subtlest part of the change and the most likely to be got wrong
  quietly.
- **The reaper did real work.** The idle timeout bounded how long a folder stayed served. A
  board-hosted route has no natural lifetime, so "which folders are currently previewable" must
  become explicit state rather than an emergent property of a timeout.

## Edge-Case & Dependency Audit

**Race conditions**
- Today `_getOrCreateHtmlServer` single-flights concurrent creation for one folder via
  `_htmlServerCreationPromises`. A route needs the equivalent guard on whatever registry
  replaces it, or two previews opened at once can register conflicting roots.
- A preview open while its folder is unregistered (or reaped, under any retained timeout) must
  404 legibly rather than serve from a stale root.

**Security**
- **Traversal containment must be re-proved, not inherited.** `path.resolve` + the
  `startsWith(normalizedSource + path.sep)` check + the deny-list are the whole boundary. With
  the root as a parameter, the test suite has to cover encoded traversal, symlinks, and absolute
  paths in the request.
- **The `.switchboard/stitch` case is a regression trap.** `:2247-2253` records that checking
  the absolute path 403'd every legitimately dot-rooted server. Any reimplementation that
  "tidies" the deny-list to check the whole path reintroduces that bug.
- **Origin separation is the point.** If previews end up same-origin with the board, generated
  markup can reach the board's DOM and session. A test must assert the origins differ.
- **Retiring an unauthenticated server is a net improvement** and should be stated as one — but
  only if the replacement route does not become an unauthenticated read reachable through every
  tunnel instead.
- The four loopback guards are untouched; `loopback-hostname-contract` must stay green.

**Side effects**
- `PlanningPanelProvider` has the ported ancestor of this server (`:2184` says "ported from the
  planning panel"). If it holds its own copy, both must move together or the bug persists in one
  panel — and a grep for `listen(0, '127.0.0.1'` across `src/` is the honest way to find every
  instance rather than trusting two.
- Killing the second server removes a port from the host's listening set, which is a small
  attack-surface reduction worth noting in `docs/REMOTE_ACCESS.md`, whose "what is not
  supported" section currently says nothing about previews.

**Migration**
- No stored state, no settings, no file formats. Preview URLs are generated per render and never
  persisted, so there is nothing to migrate — but the change is user-visible in both hosts, and
  the VS Code webview path is the regression most likely to be caused.

## Dependencies

- **Builds on** `standalone-remote-access-story.md`, whose host-aware `_panel`-guard pattern this
  change should follow rather than invent a second convention.
- **Independent of** the phone/mobile feature. This is a laptop-remote bug: it affects the SSH
  tunnel and Remote-SSH paths that are already the recommended posture.
- **Feeds** `docs/REMOTE_ACCESS.md`, which should state the outcome either way.

## Adversarial Synthesis

Key risks: (1) collapsing previews into the board's origin, which trades a remoting bug for a
real isolation regression; (2) reimplementing the path guards with the root taken from the
request instead of established server-side; (3) "tidying" the deny-list into an absolute-path
check and re-403'ing every dot-rooted folder, a bug this codebase has already fixed once; (4)
getting auth wrong quietly — a cookie scoped to the board host is not sent to the preview host,
so a naive `_checkAuth` on the route makes every preview 401 while a naive exemption publishes an
unauthenticated read through every tunnel; (5) fixing `DesignPanelProvider` and missing the
Planning ancestor. Mitigations: a distinct `*.localhost` origin on the same port, which the Host
guard already accepts by construction; root established server-side from a registry, never from
the request; the deny-list ported verbatim with its comment; an explicit decision on the
credential path with a test for each outcome; and a repo-wide grep for `listen(0, '127.0.0.1'`
as the scope-completeness check.

## Proposed Changes

1. **Serve previews from `LocalApiServer`** on a distinct `*.localhost` host, same port, with a
   server-side registry mapping a preview id to its `sourceFolder`. The request carries the id
   and a relative path; it never carries a root.
2. **Port the guards verbatim** — traversal containment, and the deny-list applied only to
   components below the registered root, with the `:2247-2253` comment carried across so the
   reason survives.
3. **Make `_buildLocalhostUrl` host-aware**, following the `_panel`-guard pattern the earlier
   plan established: the new preview origin for the browser board, and whatever the webview
   requires for the extension host.
4. **Decide and implement the credential path** — authenticated route or explicit exemption —
   and document which, since the current server's total absence of auth is undocumented either
   way.
5. **Widen `frame-src`** on the Planning and Design CSPs to the preview origin only, not
   `http://127.0.0.1:*`.
6. **Delete the second server** and its lifecycle machinery once nothing references it, and
   grep for `listen(0, '127.0.0.1'` to confirm no sibling copy survives in
   `PlanningPanelProvider` or elsewhere.
7. **Update `docs/REMOTE_ACCESS.md`** to state that previews work under a tunnel, replacing the
   silence that currently leaves the gap undocumented.

### Migration

Nothing stored changes. The behavioural surface is preview rendering in the Design and Planning
panels on both hosts, plus one fewer listening port on the host.

## Verification Plan

1. **Port-shifted tunnel.** Launch on an ephemeral port, `ssh -L 7777:127.0.0.1:<real>`, open an
   HTML preview and a Stitch preview. Both render. This fails today and is the fix's proof.
2. **VS Code Remote-SSH.** Open both previews with the extension host on the server and the
   webview on the client. Both render — the second half of the bug, and the path most likely to
   be forgotten.
3. **Local extension host unregressed.** Same previews in a local VS Code window. This is the
   regression the change most plausibly causes.
4. **Origins differ.** Assert programmatically that the preview iframe's origin is not the
   board's, and that script in the preview cannot reach the parent document.
5. **Traversal, with the root as a parameter.** Encoded `..`, absolute paths, symlinks out of the
   registered folder, and a request naming an unregistered id. All refused.
6. **The dot-folder case.** Preview content served from `.switchboard/stitch` renders — the exact
   regression `:2247-2253` records fixing once already.
7. **Babel intercept and error diagnostics intact.** A preview using `<script type="text/babel">`
   with `react/jsx-runtime` imports still compiles and runs, and a deliberately broken preview
   still reports its load error back to the parent panel.
8. **Concurrency.** Open several previews across several folders simultaneously and assert no
   cross-folder bleed and no registration race.
9. **Credential behaviour matches the decision.** Whichever path was chosen, assert it: an
   authenticated route serves the iframe (credential actually reaches a different host), or an
   exempt route is provably scoped to registered roots only.
10. **The old server is gone.** Assert no ephemeral listener appears when a preview opens
    (compare the host's listening sockets before and after), and that
    `grep -rn "listen(0, '127.0.0.1'" src/` returns nothing for preview servers.
11. **Guards unchanged.** `loopback-hostname-contract` green; `curl -H 'Host: evil.example'` →
    403; a LAN peer → 403.

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
plan already fixed once. Add it to the verification plan as a named regression rather than trusting
step 3's general "local extension host unregressed".
