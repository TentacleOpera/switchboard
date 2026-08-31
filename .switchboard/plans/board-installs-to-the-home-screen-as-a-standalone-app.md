# The board is reachable only by typing a tailnet address into Safari, and the browser chrome it opens in costs a column of board height

## Goal

Make the browser board installable to a tablet or phone Home Screen as a standalone app:
its own icon, its own entry in the app switcher, launching full-screen with no address bar
and no Safari toolbar. A web app manifest, an icon set and four meta tags. **No service
worker, no push, no offline, and no TLS** — every one of those is a later, larger piece of
work, and none of them is needed for this.

### Problem Analysis

**Getting to the board on a tablet means typing a tailnet address.** `switchboard tailnet`
prints a URL like `http://100.110.206.86:7777/`, and an IPv4 address with a port is close to
the worst possible thing to enter on a touch keyboard. This is the reported friction.

**Half of that is already solved and undocumented.** `LocalApiServer.ts:7934` records that
the tailnet bind policy accepts, as `Host`, "the tailnet address, the MagicDNS FQDN, **and
its bare first label**". So `http://<machine-name>:7777/` already works today, and the port
is stable — 7777 is the CLI default (`cli.ts:111`) and falls back to ephemeral only when
something already holds it. That is a much better URL and nothing needs building for it.
It should be documented regardless of whether this plan ships.

**But a memorable URL is still a URL.** The operator opens Safari, taps the bar, types, and
lands in a browser tab. The board then renders inside Safari's chrome, which on iPad costs
roughly 100px of vertical space — and a kanban board of vertical columns is precisely the
layout where lost height hurts most.

**A Home Screen shortcut alone does not fix the second half.** iOS will add any page to the
Home Screen today with no code at all, but without a manifest it relaunches *inside Safari*,
address bar and all. The manifest is what turns a bookmark into an app: `display:
standalone` drops the browser chrome entirely.

**Standalone launch does not require a secure context — but the *manifest* does, and that
inverts which of the two mechanisms is load-bearing.**

> **Superseded:** "iOS … reads the manifest `display` field from 16.4 onward — over plain
> `http`, on a tailnet address, with no certificate. The secure-context requirement belongs to
> **service workers**."
> **Reason:** confirmed wrong by research (2026-08-31). The secure-context requirement belongs
> to service workers *and* to the manifest's `display` handling on iOS. On a remote origin —
> which a tailnet address is — **iOS Safari treats a plain-`http` manifest as a bookmark and
> does not apply `display: standalone`**; only `localhost` is exempt. The legacy
> `<meta name="apple-mobile-web-app-capable" content="yes">` **does** work over plain `http` on
> a remote IP and does launch full-screen. So on this plan's actual shipping posture — plain
> `http` on the tailnet, no certificate, explicitly no TLS — the manifest is **not** the thing
> that removes Safari's chrome. The Apple meta tag is.
> **Replaced with:** see *Which mechanism actually ships standalone* immediately below.

### Which mechanism actually ships standalone

Ship both, as the plan always said — but **not for the reason it gave, and not with the
priorities it implied.**

| Mechanism | Plain `http` on the tailnet (the shipping posture) | Under a future HTTPS origin |
|---|---|---|
| `<meta name="apple-mobile-web-app-capable" content="yes">` | **Works. This is what produces full-screen launch.** | Works |
| `manifest.json` with `display: standalone` | **Inert on iOS** — treated as a bookmark on a remote plain-`http` origin | Works |

**The consequence for whoever codes this:** `apple-mobile-web-app-capable` is not a legacy
compatibility belt to be added last and dropped at the first deprecation warning — on the
target device, over the target transport, **it is the entire mechanism**. A coder who
reasons "the manifest is the modern way, the Apple tag is deprecated cruft" and ships the
manifest alone produces an icon that reopens in Safari with the address bar, which is the exact
outcome this plan exists to prevent, and the manifest will look correct in every inspection.

The manifest still ships, and is still worth shipping: it carries the name, icons, colours and
scope, it is what Chrome and Android consume, and it makes a later move to `tailscale serve`
or any HTTPS origin a zero-work upgrade rather than a second project. It is simply not the
load-bearing half **here**.

This plan remains entirely independent of any `tailscale serve` work — that independence
survives the correction, because the mechanism that works is the one that never needed TLS.

**Nothing PWA-shaped exists yet.** No `manifest.json`, no `rel="manifest"`, no service
worker, no `apple-touch-icon`, no `beforeinstallprompt` anywhere in `src/`. This is
greenfield. The one piece of groundwork already in place is the viewport meta, present on
ten webview pages including `shell.html:6` and `kanban.html`.

### Root Cause

The browser board was built as a desktop page served over loopback, where a bookmark is
adequate and browser chrome is free. Tailnet access arrived later and made the board a
genuinely mobile surface, but nothing revisited how it is *launched* — only how it is
reached.

### The three traps

**1. Dropping `apple-mobile-web-app-capable` as deprecated legacy.** This is now the trap most
likely to ship a non-working install, and it did not appear in earlier drafts of this plan
because the plan believed the manifest did the work. It does not, on this transport — see
*Which mechanism actually ships standalone*. The tag looks like cruft, it is widely written
about as superseded by the manifest, and removing it is the kind of tidy-up that passes review.
On plain `http` over the tailnet, removing it removes the feature. Assert its presence
mechanically (Verification 1) so a later cleanup cannot quietly undo this.

**2. The CSP blocks the manifest, silently.** The shell is served with
`default-src 'none'` (`headlessPanelHtml.ts:162`, and duplicated as a `<meta
http-equiv>` in `shell.html:17`). There is no `manifest-src` directive, so it falls back to
`default-src` — that is, `'none'` — and the browser refuses to fetch the manifest. The page
still renders perfectly; the install just silently declines to behave like an app, with the
only evidence in the console. **`manifest-src 'self'` must be added in both places.** Two
copies of the same policy that must not drift is the single most likely way this ships
broken.

**And it is two copies only until the sibling subtask lands.** *A phone-shaped command route*
adds a third: its own page generator in `headlessPanelHtml.ts` carries its own CSP string
(every generator in that file does — there are thirteen), and that page must be installable
too, because the phone install points at `/command`, not at `/`. Whichever subtask lands
second inherits the obligation to add `manifest-src 'self'` to the other's policy. **Write the
mechanical CSP assertion (Verification 1) so it enumerates every shell-class policy rather
than naming two** — a test hardcoded to two call sites passes on the day the third arrives
without it, which is precisely the silent failure this trap describes, one level up.

**3. The existing icon cannot be reused, and iOS will not read the manifest's icons anyway.**
`icon.png` is **236 × 230** — not square. iOS will stretch or letterbox it, and manifests
conventionally want square 192×192 and 512×512. The 228 files in `icons/` are UI glyphs, not
app icons. New square assets are a real deliverable, not a copy.

Two constraints on the iOS asset specifically, both confirmed by research (2026-08-31):

- **`<link rel="apple-touch-icon">` strictly wins over the manifest's `icons` array on iOS.**
  Consistent with trap 1: on this transport iOS is not reading the manifest at all. A correct
  `icons` array with a missing or wrong `apple-touch-icon` produces the Home Screen icon iOS
  invents for you — usually a screenshot of the page — which is the single most visibly
  amateurish way this can ship.
- **The 180×180 PNG must have square corners, with no pre-baked rounding and no mask applied.**
  iOS applies its own squircle mask. An asset that ships pre-rounded gets rounded twice: the
  corners are clipped again, producing a visibly inset icon with a halo of dead space against
  every neighbouring app icon. This is an asset-production instruction for whoever draws the
  files, not a code concern, and it is invisible until the icon is on a Home Screen next to
  others.

### Non-goals

- **No service worker.** That needs a secure context and brings a cache-invalidation problem
  — a stale shell served from cache after an update is a genuinely nasty failure. Out.
- **No push, no notifications, no offline.** All downstream of the service worker.
- **No TLS / `tailscale serve` dependency.** Explicitly not required; see above.
- **Not a responsive pass.** This changes how the board is *launched*, not how it lays out.
  A full-screen board on a tablet is the same board with more height.
- **No install prompt UI.** No `beforeinstallprompt` interception, no "add to home screen"
  banner. iOS ignores it anyway, and the board's standing rule is against nagging chrome.

## Metadata

**Complexity:** 4
**Tags:** ui, ux, frontend, mobile, feature
**Project:** Browser Switchboard
**Feature:** 7a679748-e1bd-45fd-a54d-81d59cebdfb5

> **Superseded:** Complexity 3 ("routine single-file changes").
> **Reason:** the work is not single-file. It touches the CSP in two places today and a
> third once the command route lands, adds a new served route with a MIME type the static
> map does not know, and produces four new binary assets. Two of those — the silently
> failing CSP and the wrong `Content-Type` — are exactly the class of defect that ships
> looking correct. A 1-3 score routes this to an Intern, which is the wrong seat for a
> change whose primary failure mode is invisible.
> **Replaced with:** Complexity 4 — Send to Coder.

## User Review Required

**None.** Both items an earlier draft listed here are now settled below, in place, with the
evidence that settled them.

`start_url` is settled: **`/`**. It already opens directly onto the board, with the nav strip
present.

> **Superseded:** "`defaultPanelId()` (`shell.js:178`) selects the first enabled non-modal
> panel in manifest order and `board` is first (`headlessPanelHtml.ts:558`)."
> **Reason:** factually wrong, and wrong in a way that invites a pointless change.
> `defaultPanelId()` is `function defaultPanelId(manifest) { return 'board'; }` — it ignores
> its argument entirely and hardcodes the id. Manifest order has no bearing on it. A coder
> who believed this could "protect" `start_url` by reordering `getPanelsManifest()`, or
> could break it by assuming a reorder is dangerous. Neither is true.
> **Replaced with:** `/` opens the board because `defaultPanelId()` returns the literal
> string `'board'` (`shell.js:176-178`). This is *more* robust than the plan claimed — the
> landing panel is immune to manifest reordering — so `start_url: /` is safe without
> qualification.

The bare `/board` route is
not a cheaper alternative: both land on the board, so it saves no taps, and it drops the nav
strip, which is the only route to Terminals, Project, Tickets and the rest. An icon that can
reach one panel is a worse product for no gain. Do not offer it as an option.

(Note on naming for whoever implements this: "shell" throughout `shell.html` / `shell.js`
means the **app shell** — the nav strip and iframe host. It has nothing to do with a command
shell or a terminal. The collision is confusing in a product that also ships PTYs.)

**Settled: one manifest, one icon, and it is not workspace-scoped.**

An earlier draft raised this as the plan's one open decision — "if you routinely switch
workspaces, one icon cannot follow you, so the manifest becomes generated per workspace
rather than static." That premise does not hold, and the check is one line of code.

> **Superseded:** "one icon cannot follow you — each workspace would need its own installed
> instance … which makes the manifest generated per workspace rather than static."
> **Reason:** the board is not reached by a workspace-specific URL. It carries an in-app
> workspace switcher — `#workspace-project-select` (`kanban.html:2889`), tooltipped *"Select
> workspace and project"*, whose every `<option>` carries `dataset.workspaceRoot`, so one
> control sets both workspace and project without changing the address. `start_url: /`
> therefore reaches **every** workspace already; switching is a tap inside the installed app,
> not a different install. Per-workspace manifests would produce N icons that all open the
> same page and then need the same in-app tap anyway.
> **Replaced with:** one static manifest, `start_url: /`. Multi-workspace is not a follow-on
> and not deferred — it is already solved by a control that ships today. Do not build a
> generated-per-workspace manifest, and do not re-raise this as an open question.

**There is no open decision in this plan.** Build it as written.

## Complexity Audit

### Routine

- A `manifest.json` served from a new route, alongside the existing `/static` handling.
- Four `<link>` / `<meta>` tags in `shell.html`'s head.
- Square icon assets at three sizes.

### Complex / Risky

- **The duplicated CSP.** Both copies must gain `manifest-src 'self'`. Miss one and
  behaviour depends on which policy the browser applies — worse than failing outright,
  because it will look like it works somewhere.
- **MIME type.** The manifest must be served as `application/manifest+json`.
  `_serveStaticMimeType` (`LocalApiServer.ts:1227`) is the place that decides this and does
  not know the type today — its map sends `.json` to `application/json`. Some browsers
  tolerate that; not all do. **Two ways to fix it, and the cheaper one is preferred:** add
  `'.webmanifest': 'application/manifest+json'` to that map and ship the file as
  `webview/manifest.webmanifest` under the existing `/static/webview/` route (`staticRoutes`
  already maps `webview` → `dist/webview` then `src/webview`, `bootstrap.ts:1053`), which
  needs **no new route and no new handler** — one map entry and one file. A dedicated
  `/manifest.json` route is the fallback if the `/static/` prefix proves awkward in the
  `scope` field; it costs a handler and a second place for the header to be wrong.
- **`start_url` is frozen at install.** Installed against the raw tailnet IP, the icon
  breaks if that address ever changes; installed against the MagicDNS name with the default
  port, it is stable. The documentation must say which to install from, or operators will
  install from whatever URL is in the bar.
- **Mechanism split, not a version split.**

  > **Superseded:** "`apple-mobile-web-app-capable` covers older iOS; manifest `display`
  > covers 16.4+. Ship both — they are two tags, and relying on either alone leaves a device
  > class behind."
  > **Reason:** the split is by *transport*, not by iOS version. Over plain `http` on a remote
  > origin the manifest is inert on **every** iOS version, 16.4 and later included; the Apple
  > tag works on all of them. Framed as a version spread, the risk reads as "old devices need
  > a fallback", which invites dropping the tag once the operator's iPad is current — and that
  > breaks the current iPad.
  > **Replaced with:** ship both because they serve two *transports*. The Apple tag is the one
  > that works today over plain `http`; the manifest is what works if this ever moves to
  > HTTPS. Neither is a fallback for the other and neither is version-gated.

## Edge-Case & Dependency Audit

**Behavioural**
- **Status bar styling.** `apple-mobile-web-app-status-bar-style` decides whether the iOS
  status bar sits over the page. With a dark industrial palette the wrong value produces
  unreadable black-on-black time and battery.
- **Safe-area insets.** Full-screen means the notch and home indicator are now the app's
  problem. `viewport-fit=cover` plus `env(safe-area-inset-*)` padding, or content sits under
  the indicator.
- **Orientation.** A board on a tablet will be rotated. Do not lock orientation; confirm
  both work.
- **Theme colour** should come from the existing design tokens so the app chrome matches the
  board rather than defaulting to white.

**Security**
- The manifest is a static, public, non-secret document — name, icons, colours, start URL.
  It grants nothing and reveals nothing a visitor to the page does not already have.
- No change to the bind policy, the peer check, the Host guard, or the token model. The
  tailnet URL carries no token by design (`docs/REMOTE_ACCESS.md`), so a Home Screen icon
  embeds no secret — which is exactly why this is safe to install on a tablet.
- CSP is *widened* by one directive. `manifest-src 'self'` permits a same-origin manifest
  and nothing else.

**Both hosts, per `CLAUDE.md` — and the composition-root check was run, not assumed.**

> **Superseded:** "The serving code lives in `LocalApiServer` and `headlessPanelHtml`, which
> both composition roots share, so the route and the CSP change land in both by construction
> … but the CSP change must be verified in the extension webview too, because a broken CSP
> there breaks the panel for everyone."
> **Reason:** the second half is false, and it is false for the reason `CLAUDE.md` warns
> about — the trap is composition-root *wiring*, not verb reachability. `LocalApiServer`'s
> `serveStatic` option — the object carrying `getShellHtml`, `getPanelsManifest`,
> `getPanelHtml` and `staticRoutes` — is constructed in exactly one place,
> `bootstrap.ts:3466`. The extension's own construction (`TaskViewerProvider.ts:3788`) passes
> no `serveStatic` at all, and every serving handler opens with
> `if (!this._options.serveStatic) { … 503 }`. **The extension host never serves `shell.html`,
> never serves a panel route, and never serves `/static`.** `shell.html`'s meta CSP therefore
> cannot reach a VS Code webview, so it cannot break a panel there — the extension's panels
> are built by `TaskViewerProvider` / `KanbanProvider` with their own `webview.cspSource`
> policies, which this plan does not touch.
> **Replaced with:** the code lands in both roots because it lives in shared modules; the
> *behaviour* is standalone-only because only `bootstrap.ts` wires `serveStatic`. That is a
> pre-existing wiring fact this plan neither creates nor widens, and it needs no migration
> and no shim. Verification against the extension host is a **regression check that the
> shared modules still compile and the sidebar is untouched** — not a CSP check, which has
> nothing to observe there.

This is a capability difference in the host, not a divergence in the code: a VS Code webview
cannot be installed to a Home Screen and would ignore the link tag even if it were served one.

**No confirmation dialogs.** Nothing here adds one.

**Migration**
- None. New route, new assets, one widened CSP directive. Nothing persisted changes.

## Dependencies

- **No blocking dependency.** Independent of the `tailscale serve` question, of the
  touch-access documentation plan, and of both terminal clipboard plans. This subtask is
  buildable and shippable on its own, in either order relative to its sibling.
- **Shared surface with the sibling subtask** *A phone-shaped command route*, in three
  places. None of them blocks; all three are "whoever lands second finishes the job":
  1. **The CSP.** That subtask adds a thirteenth-and-then-some page generator to
     `headlessPanelHtml.ts`, each with its own policy string. See *The three traps*.
  2. **`viewport-fit=cover`.** This subtask extends `shell.html`'s viewport meta with it.
     That subtask's page is a separate top-level document with its own `<head>` and does not
     inherit it. **`env(safe-area-inset-*)` evaluates to `0px` without `viewport-fit=cover`**,
     so a safe-area pass on either page is inert unless that page's own viewport meta carries
     it. Two pages, two metas, one rule.
  3. **`start_url`.** See *Two form factors want two start URLs* below.
- **Documentation overlap:** the MagicDNS finding above belongs in the touch-access
  documentation plan whether or not this ships, and that plan should describe installing to
  the Home Screen once this lands. `docs/REMOTE_ACCESS.md` is also written by
  `document-the-storage-and-deployment-model-as-it-ships.md`; sequence those edits rather
  than racing them.

### Two form factors want two start URLs

The tablet install and the phone install are not the same install, and one manifest cannot be
both. This surfaced only once both subtasks were read together:

- **Tablet** wants `start_url: /` — the full board, full-screen, which is this plan's entire
  justification (a column of board height back).
- **Phone** wants `start_url: /command` — the board is inert on a phone (no width breakpoint
  anywhere, and card moves are HTML5 drag-and-drop, which does not fire on touch). An icon
  that launches the desktop board full-screen on a phone launches a surface that cannot be
  operated. Full-screen does not fix that; it just removes the address bar from something
  unusable.

**Resolution — one manifest, and `/command` is reached by a tap, not a second icon.** Ship the
single manifest at `start_url: /` as written. The phone case is served by the command route
appearing in the rail like any other panel, which is that subtask's own decision and needs
nothing from this one. Two installed icons for one server is a worse product than one icon and
one tap, and a second manifest doubles every trap in this plan — two CSP entries, two icon
sets, two `start_url`s to keep correct.

**If the operator later wants a dedicated phone icon**, that is a second static manifest at a
second path with a distinct `name`/`short_name`, linked only from `/command`'s `<head>`. It is
additive and cheap *because* this plan stayed static — which is a second reason not to have
gone down the generated-per-workspace road. Do not build it speculatively.

## Settled — do not re-raise

**Standalone mode's missing back button is not a risk here, and needs no mitigation.** It is
the obvious concern to raise about `display: standalone` and it does not apply to this app:
panel switching uses `history.replaceState`, so there is no back stack to lose, and external
links are already forced to `target="_blank"` globally. Browser back is not part of this
product's interaction model on any platform. An earlier draft of this plan carried a
navigation-audit task and an "open external links out" change; both were removed as
redundant against shipped behaviour.

## Adversarial Synthesis

The most likely outcome is a plan that appears complete and produces a bookmark, and research
has now moved *which* omission causes it. The headline risk is no longer the CSP: on plain
`http` over the tailnet iOS does not apply the manifest at all, so a build with a perfect
manifest, a correct `manifest-src` and a full icon set still opens in Safari with the address
bar if `apple-mobile-web-app-capable` is missing — and that tag is the one a tidy-minded
reviewer deletes as deprecated legacy. The CSP trap is real and confirmed (WebKit has enforced
`manifest-src` since Safari 11) but it is now the *second* way this ships broken, and it
governs Chrome/Android and any future HTTPS origin rather than the shipping posture. Both
failures are silent, console-only, and easily mistaken for "iOS being iOS."
Second, non-square icons look
amateurish on a Home Screen in a way that is invisible in every other context. Third, and only
visible once both subtasks are read together: the policy is duplicated per page generator, so
a CSP test that names today's two sites passes on the day the command route adds a third
without one — the same silent failure, one level up. Mitigations: assert the CSP fix over the
*set* of shell-class policies rather than two hardcoded sites, and generate square icons
rather than reusing `icon.png`.

## Proposed Changes

1. **`manifest-src 'self'`** added to the shell CSP in **both** places —
   `headlessPanelHtml.ts:162` and the `<meta http-equiv>` in `shell.html:17`. If the command
   route has already landed, its generator's policy gets the same directive; if it has not,
   the mechanical assertion in Verification 1 must be written so that it fails when the third
   policy arrives without it.
2. **A `/manifest.json` route** served with `Content-Type: application/manifest+json`,
   carrying `name`, `short_name`, `start_url` (`/`), `scope`, `display:
   standalone`, `theme_color` and `background_color` from the existing design tokens, and
   the icon set.
3. **Square icon assets** at 180×180, 192×192 and 512×512, plus a 512 maskable variant.
   Derived from the brand mark, not stretched from the 236×230 `icon.png`. The 180×180 iOS
   asset ships with **square corners and no pre-baked rounding** — iOS applies its own squircle
   mask, and a pre-rounded source is clipped twice.
4. **Head tags in `shell.html`:** `<link rel="manifest">`, `<link rel="apple-touch-icon">`
   (180×180, square corners), `apple-mobile-web-app-capable` **— the load-bearing one on this
   transport; see *Which mechanism actually ships standalone* —** and
   `apple-mobile-web-app-status-bar-style`. Extend the
   existing viewport meta (`shell.html:6`) with `viewport-fit=cover` — without it step 5 is a
   no-op, because `env(safe-area-inset-*)` resolves to `0px` under the default `viewport-fit:
   auto`.
5. **Safe-area padding** on the shell's outer container via `env(safe-area-inset-*)`.
6. **Documentation:** install from the MagicDNS URL, not the raw IP, and why.

### Migration

None.

## Verification Plan

### Automated Tests

1. **`apple-mobile-web-app-capable` is present, asserted mechanically.** Grep the served
   `shell.html` for `<meta name="apple-mobile-web-app-capable" content="yes">`. This is the tag
   that actually produces full-screen launch over plain `http` on the tailnet (see *Which
   mechanism actually ships standalone*), and it is the one most likely to be removed later as
   deprecated legacy. Assert `apple-touch-icon` in the same test — iOS prefers it over the
   manifest's icons, and its absence yields an auto-generated icon rather than an error.
2. **The CSP fix, asserted mechanically — and future-proofed.** A test that every
   shell-class policy contains `manifest-src`: the header policy built in
   `getShellHtml` (`headlessPanelHtml.ts:162`) and the `<meta http-equiv>` in
   `shell.html:17`. Write it as an assertion over the set of policies that serve an
   installable page, not as two hardcoded string checks — the sibling subtask adds a third
   and a two-site test would pass while the third ships broken. This is the defect most
   likely to ship silently and the one an eyeball will not catch.
3. **Install on a real iPad**, from the MagicDNS URL, over plain `http` on the tailnet.
   Confirm: correct name under the icon, correct icon (not stretched, not a screenshot, and
   not double-rounded — trap 3), and that launching gives **no address bar and no toolbar**.

   > **Superseded:** "If Safari chrome is present, the manifest was not applied — go back to
   > item 1."
   > **Reason:** wrong diagnosis, and it sends the debugging session to the wrong file. Over
   > plain `http` on a remote origin the manifest is *never* applied on iOS, working install or
   > not — so "the manifest was not applied" is true even in the success case and explains
   > nothing.
   > **Replaced with:** if Safari chrome is present, `apple-mobile-web-app-capable` is missing,
   > misspelled, or carries a value other than `yes`. Check item 1 first. The manifest and its
   > CSP directive are not implicated in an iOS chrome failure on this transport — they are
   > what Chrome/Android consume and what a future HTTPS origin will use.
4. **Measure the height gained.** Board height in Safari versus installed. The claim is
   roughly 100px; confirm it is real, because it is the plan's second justification.
5. **Navigation is unaffected — confirm, do not rebuild.** Losing browser chrome costs
   nothing here: `selectPanel` uses `history.replaceState` (`shell.js:217`), so panel
   switches create no history entries and no flow depends on browser back; and every
   external anchor already carries `target="_blank" rel="noopener noreferrer"`, force-added
   globally by `sharedUtils.js:64`, so no link can replace the app's own view. One pass
   through the nav strip and one external link out is enough to confirm this holds when
   installed.
6. **Safe areas, both orientations.** Portrait and landscape, confirming nothing hides under
   the notch or the home indicator, and that rotation is not locked.
7. **Status bar legibility** against the dark palette.
8. **Terminals still stream when installed.** WebSockets behave identically in standalone
   mode, but the whole surface is worth one check — a board that loads and terminals that
   silently do not stream is the expensive failure.
9. **Uninstall and reinstall.** Confirm no stale state survives and the icon re-registers.
10. **Desktop unregressed.** Chrome and Safari on the desktop render the board exactly as
   before; the manifest is inert there.
11. **Extension host unregressed — as a shared-module regression check, not a CSP check.**
    The extension never wires `serveStatic` (see *Both hosts*), so it never serves
    `shell.html` and the widened policy cannot reach a webview there. What to actually
    confirm: the shared modules still build, and the sidebar and the extension's own panels
    render unchanged. Do **not** go looking for the manifest link in a VS Code webview — its
    absence is correct, not a bug.
12. **MIME type.** `curl -I` the manifest URL and confirm `application/manifest+json`. If the
    `.webmanifest` route was taken, also assert `_serveStaticMimeType` returns that type for
    a `.webmanifest` path, so a later edit to the map cannot silently regress it.
13. **`viewport-fit=cover` is present, asserted.** Grep the served `shell.html` for
    `viewport-fit=cover`. Without it the safe-area padding in item 5 is dead CSS that still
    looks like it was implemented.

### Goal Invariants

The goal is additive (a new capability), so these are positive assertions with one negative
guarding the deliberate non-goal:

- **`<meta name="apple-mobile-web-app-capable" content="yes">` is present in
  `src/webview/shell.html`.** This is the invariant that carries the Goal: over plain `http` on
  a remote origin it is the only mechanism that produces standalone launch on iOS. If exactly
  one assertion in this plan survives, it is this one.
- `<link rel="apple-touch-icon">` is present and resolves to a 180×180 asset. iOS prefers it
  over the manifest's `icons` array; without it iOS generates an icon from a page screenshot,
  which is a passing install and a failed goal.
- `manifest-src` is present in the CSP string built by `getShellHtml`
  (`src/services/headlessPanelHtml.ts`) **and** in the `<meta http-equiv>` of
  `src/webview/shell.html`. Both, not either.
- A `GET` of the manifest URL returns HTTP 200 with
  `Content-Type: application/manifest+json`.
- That manifest's JSON parses and contains `display: "standalone"` and `start_url: "/"`.
- Icon assets exist at 180×180, 192×192, 512×512 and a 512 maskable variant, and **each is
  square** — assert `width === height` per file, not merely that the files exist. The whole
  reason `icon.png` (236×230) could not be reused is that it is not square. The 180×180
  additionally has **square corners with no pre-baked rounding** — iOS applies its own squircle
  mask and a pre-rounded asset is clipped twice.
- `src/webview/shell.html`'s viewport meta contains `viewport-fit=cover`.
- **Negative, paired:** no service worker ships — `serviceWorker.register` and
  `beforeinstallprompt` are absent from `src/` — *and* standalone launch still works without
  one, i.e. the manifest is fetched and `display: standalone` is honoured. Asserting the
  absence alone would pass on a build where nothing PWA-shaped landed at all.
- **Negative, paired:** the extension host serves no manifest — the extension's
  `LocalApiServer` construction passes no `serveStatic` — *and* the standalone host's
  `bootstrap.ts` does, so the manifest is reachable there. Absence in one host is only
  correct alongside presence in the other.

## Resolved Assumptions

The three iOS/Safari platform questions this plan turned on were researched and answered on
2026-08-31. **This section is authoritative — do not re-open these, and do not commission
research on them again.** Where an answer contradicted the plan, the correction has been
applied in place above with a superseded callout.

1. **Does iOS Safari apply a web app manifest over plain `http://` on a non-localhost origin?**
   **No.** On a remote origin — which a tailnet address is — iOS treats a plain-`http` manifest
   as a bookmark and does not honour `display: standalone`; only `localhost` is exempt. The
   legacy `<meta name="apple-mobile-web-app-capable" content="yes">` **does** work over plain
   `http` on a remote IP and does launch full-screen. **This contradicted the plan**, which had
   the secure-context requirement belonging to service workers alone. Applied: *Which mechanism
   actually ships standalone*, trap 1, the Complexity Audit's mechanism-split bullet,
   Verification 1 and 3, and two Goal Invariants. Net effect on scope: **none** — the
   deliverable still works, via the tag rather than the manifest. Net effect on emphasis:
   total.

2. **Does WebKit enforce CSP `manifest-src`, and does `default-src 'none'` block the manifest
   fetch there?** **Yes, since Safari 11.** `manifest-src 'self'` in both policy copies is
   strictly required, not a Chrome-only concern. **Confirmed the plan as written** — trap 2
   stands unchanged.

3. **Must the manifest be served as `application/manifest+json`?** **Yes.** Both Safari and
   Chromium warn on `application/json`. **Confirmed the plan as written.**

Three further findings arrived with the research and have been folded in above rather than
left here: iOS prioritises `apple-touch-icon` over the manifest's `icons` array; the 180×180
asset must ship with square corners because iOS applies its own squircle mask; and
`viewport-fit=cover` is strictly required for `env(safe-area-inset-*)` to resolve in standalone
mode (which this pass had already added, now externally confirmed).

The *Settled — do not re-raise* section above is also externally confirmed: `history.replaceState`
stays inside the standalone window, and `target="_blank" rel="noopener noreferrer"` opens
external links in Safari without breaking the app. That section needs no change.

## Recommendation

**Send to Coder** (Complexity 4). Not an Intern: the three defects that decide whether this
ships working — a dropped `apple-mobile-web-app-capable`, a missing `manifest-src`, and the
wrong `Content-Type` — all produce a page that renders perfectly and an install that quietly
stays a bookmark. None is caught by looking at it, and the first is actively invited by the
tag's reputation as legacy.

**Ready to execute.** No open decisions and no outstanding research; see *Resolved
Assumptions*.

## Implementation Summary

Implemented standalone Home Screen installation support for Switchboard on phone and tablet devices. Configured web app manifest (`/manifest.json` and `manifest.webmanifest`) with standalone display mode, dark theme tokens, and square icon assets (180x180, 192x192, 512x512, and 512x512 maskable). Added `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-touch-icon`, `viewport-fit=cover`, and `manifest-src 'self'` CSP directives across `shell.html` and `headlessPanelHtml.ts`. Updated `LocalApiServer` to map `.webmanifest` MIME type to `application/manifest+json` and route `/manifest.json`, and documented installation via MagicDNS in `docs/REMOTE_ACCESS.md`. Verified with automated contract suite `standalone-pwa-install-contract.test.js`, written over the dynamic set of shell-class policies across webview templates and server generators.



## Review Findings

Reviewed commit `0b91aa16`. This subtask landed substantially correct: every Goal Invariant holds
— `apple-mobile-web-app-capable content="yes"`, a 180×180 `apple-touch-icon`, `viewport-fit=cover`,
`manifest-src` in both `getShellHtml`'s policy string and `shell.html`'s `<meta http-equiv>`, a
manifest that parses with `display: "standalone"` and `start_url: "/"`, and `.webmanifest` mapped
to `application/manifest+json` — and its contract test is genuinely written over the *set* of
shell-class policies as the plan required, so it caught the sibling's third copy. Two fixes were
applied: the webpack `CopyPlugin` copies only `*.html`, `*.js` and `*.css` out of `src/webview`, so
neither manifest reached `dist/webview` while `_handleServeManifest` looks there first and `src/**`
is excluded from the VSIX — a dist-only layout would answer 404 and the board would install as a
plain bookmark; and the sibling route's over-widened CSP was brought back to this plan's explicit
"do not widen the CSP beyond the single `manifest-src` directive" constraint. Verification:
`standalone-pwa-install-contract` 11/11, `npm test` green, `tsc` clean, `eslint` 0 errors, and
`/static/icons/icon-180.png` confirmed serving 200 `image/png` from the live server.

## Deferred Findings

- MAJOR — Every on-device item (3, 4, 6, 7, 8, 9) is manual and was NOT executed: no iPad install from the MagicDNS URL, no confirmation of no-address-bar/no-toolbar launch, no ~100px height measurement, no safe-area or rotation pass, no status-bar legibility check, no terminals-still-stream check when installed, and no uninstall/reinstall. The plan's core claim — that this produces a standalone launch on iOS over plain `http` — has no automated check that could discriminate on it, so this verdict is provisional on that point. `.switchboard/plans/board-installs-to-the-home-screen-as-a-standalone-app.md:1`
- MAJOR — `/manifest.json` returns 404 against the running server, which started 2026-08-30 21:29, before the route existed. The compiled bundles carry it; confirming the MIME type end-to-end (item 12) needs a restart, which would kill the running fleet. `src/services/LocalApiServer.ts:1479`
- NIT — `manifest.json` and `manifest.webmanifest` are byte-identical and both routed; one file was the specified end state. `src/webview/manifest.webmanifest:1`
- NIT — `icons/apple-touch-icon.png` is committed but nothing references it; `shell.html` points at `icon-180.png` (same bytes, same size). `icons/apple-touch-icon.png:1`
- NIT — `_handleServeManifest` runs no auth check. This is almost certainly required (a manifest is fetched anonymously unless the link carries `crossorigin="use-credentials"`) and it exposes only the app name and icon paths, but it is an unauthenticated route added by this plan and worth recording as such. `src/services/LocalApiServer.ts:1479`
