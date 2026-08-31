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

**None of this requires a secure context.** iOS has honoured `apple-mobile-web-app-capable`
for standalone launch since long before manifests existed, and reads the manifest `display`
field from 16.4 onward — over plain `http`, on a tailnet address, with no certificate. The
secure-context requirement belongs to **service workers**, which is the tier that buys
offline caching and push notifications. This plan deliberately stops short of that line, so
it is entirely independent of any `tailscale serve` work.

**Nothing PWA-shaped exists yet.** No `manifest.json`, no `rel="manifest"`, no service
worker, no `apple-touch-icon`, no `beforeinstallprompt` anywhere in `src/`. This is
greenfield. The one piece of groundwork already in place is the viewport meta, present on
ten webview pages including `shell.html:6` and `kanban.html`.

### Root Cause

The browser board was built as a desktop page served over loopback, where a bookmark is
adequate and browser chrome is free. Tailnet access arrived later and made the board a
genuinely mobile surface, but nothing revisited how it is *launched* — only how it is
reached.

### The two traps

**1. The CSP blocks the manifest, silently.** The shell is served with
`default-src 'none'` (`headlessPanelHtml.ts:162`, and duplicated as a `<meta
http-equiv>` in `shell.html:16`). There is no `manifest-src` directive, so it falls back to
`default-src` — that is, `'none'` — and the browser refuses to fetch the manifest. The page
still renders perfectly; the install just silently declines to behave like an app, with the
only evidence in the console. **`manifest-src 'self'` must be added in both places.** Two
copies of the same policy that must not drift is the single most likely way this ships
broken.

**2. The existing icon cannot be reused.** `icon.png` is **236 × 230** — not square. iOS
will stretch or letterbox it, and manifests conventionally want square 192×192 and 512×512,
with a 180×180 `apple-touch-icon` for iOS. The 228 files in `icons/` are UI glyphs, not app
icons. New square assets are a real deliverable, not a copy.

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

**Complexity:** 3
**Tags:** ui, ux, frontend, mobile, feature
**Project:** Browser Switchboard

## User Review Required

**One decision, and it is not the start URL.**

`start_url` is settled: **`/`**. It already opens directly onto the board — `defaultPanelId()`
(`shell.js:178`) selects the first enabled non-modal panel in manifest order and `board` is
first (`headlessPanelHtml.ts:558`) — with the nav strip present. The bare `/board` route is
not a cheaper alternative: both land on the board, so it saves no taps, and it drops the nav
strip, which is the only route to Terminals, Project, Tickets and the rest. An icon that can
reach one panel is a worse product for no gain. Do not offer it as an option.

(Note on naming for whoever implements this: "shell" throughout `shell.html` / `shell.js`
means the **app shell** — the nav strip and iframe host. It has nothing to do with a command
shell or a terminal. The collision is confusing in a product that also ships PTYs.)

**The decision that does need an answer: one workspace or several?**

An installed icon carries exactly one `start_url`, and the board is workspace-scoped. If you
drive a single workspace from the tablet, the manifest is a static file and this plan is as
written. If you routinely switch workspaces, one icon cannot follow you — each workspace
would need its own installed instance with a distinct name and icon to be told apart in the
app switcher, which makes the manifest generated per workspace rather than static. That is a
different and larger piece of work, and it should be decided now rather than discovered after
the icon is on the Home Screen.

**Recommendation:** ship the static single-workspace manifest. Multi-workspace installs are
speculative until the single-workspace case has been lived with, and the generated variant is
a clean follow-on rather than a rewrite.

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
  not know the type today. Some browsers tolerate `application/json`; not all do.
- **`start_url` is frozen at install.** Installed against the raw tailnet IP, the icon
  breaks if that address ever changes; installed against the MagicDNS name with the default
  port, it is stable. The documentation must say which to install from, or operators will
  install from whatever URL is in the bar.
- **iOS version spread.** `apple-mobile-web-app-capable` covers older iOS; manifest
  `display` covers 16.4+. Ship both — they are two tags, and relying on either alone leaves
  a device class behind.

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

**Both hosts, per `CLAUDE.md`.** The serving code lives in `LocalApiServer` and
`headlessPanelHtml`, which both composition roots share, so the route and the CSP change
land in both by construction. The *behaviour* is browser-only: a VS Code webview cannot be
installed to a Home Screen and will simply ignore the link tag. This is a capability
difference in the host, not a divergence in the code — but the CSP change must be verified
in the extension webview too, because a broken CSP there breaks the panel for everyone.

**No confirmation dialogs.** Nothing here adds one.

**Migration**
- None. New route, new assets, one widened CSP directive. Nothing persisted changes.

## Dependencies

- **None.** Independent of the `tailscale serve` question, of the touch-access documentation
  plan, and of both terminal clipboard plans.
- **Documentation overlap:** the MagicDNS finding above belongs in the touch-access
  documentation plan whether or not this ships, and that plan should describe installing to
  the Home Screen once this lands.

## Settled — do not re-raise

**Standalone mode's missing back button is not a risk here, and needs no mitigation.** It is
the obvious concern to raise about `display: standalone` and it does not apply to this app:
panel switching uses `history.replaceState`, so there is no back stack to lose, and external
links are already forced to `target="_blank"` globally. Browser back is not part of this
product's interaction model on any platform. An earlier draft of this plan carried a
navigation-audit task and an "open external links out" change; both were removed as
redundant against shipped behaviour.

## Adversarial Synthesis

The most likely outcome is a plan that appears complete and produces a bookmark. Every
individual piece — manifest served, tags present, icons drawn — can be correct while
`default-src 'none'` quietly refuses the manifest and the app opens in Safari exactly as it
did before. The failure is silent, console-only, and easily mistaken for "iOS being iOS."
Second, non-square icons look
amateurish on a Home Screen in a way that is invisible in every other context. Mitigations:
assert the CSP fix with a test rather than an eyeball, and generate square icons rather
than reusing `icon.png`.

## Proposed Changes

1. **`manifest-src 'self'`** added to the shell CSP in **both** places —
   `headlessPanelHtml.ts:162` and the `<meta http-equiv>` in `shell.html:16`.
2. **A `/manifest.json` route** served with `Content-Type: application/manifest+json`,
   carrying `name`, `short_name`, `start_url` (`/`), `scope`, `display:
   standalone`, `theme_color` and `background_color` from the existing design tokens, and
   the icon set.
3. **Square icon assets** at 180×180, 192×192 and 512×512, plus a 512 maskable variant.
   Derived from the brand mark, not stretched from the 236×230 `icon.png`.
4. **Head tags in `shell.html`:** `<link rel="manifest">`, `<link rel="apple-touch-icon">`,
   `apple-mobile-web-app-capable`, and `apple-mobile-web-app-status-bar-style`. Extend the
   existing viewport meta with `viewport-fit=cover`.
5. **Safe-area padding** on the shell's outer container via `env(safe-area-inset-*)`.
6. **Documentation:** install from the MagicDNS URL, not the raw IP, and why.

### Migration

None.

## Verification Plan

1. **The CSP fix, asserted mechanically.** A test that both the header policy and the
   `shell.html` meta contain `manifest-src`. This is the defect most likely to ship silently
   and the one an eyeball will not catch.
2. **Install on a real iPad**, from the MagicDNS URL, over plain `http` on the tailnet.
   Confirm: correct name under the icon, correct icon (not stretched, not a screenshot), and
   that launching gives **no address bar and no toolbar**. If Safari chrome is present, the
   manifest was not applied — go back to item 1.
3. **Measure the height gained.** Board height in Safari versus installed. The claim is
   roughly 100px; confirm it is real, because it is the plan's second justification.
4. **Navigation is unaffected — confirm, do not rebuild.** Losing browser chrome costs
   nothing here: `selectPanel` uses `history.replaceState` (`shell.js:217`), so panel
   switches create no history entries and no flow depends on browser back; and every
   external anchor already carries `target="_blank" rel="noopener noreferrer"`, force-added
   globally by `sharedUtils.js:64`, so no link can replace the app's own view. One pass
   through the nav strip and one external link out is enough to confirm this holds when
   installed.
5. **Safe areas, both orientations.** Portrait and landscape, confirming nothing hides under
   the notch or the home indicator, and that rotation is not locked.
6. **Status bar legibility** against the dark palette.
7. **Terminals still stream when installed.** WebSockets behave identically in standalone
   mode, but the whole surface is worth one check — a board that loads and terminals that
   silently do not stream is the expensive failure.
8. **Uninstall and reinstall.** Confirm no stale state survives and the icon re-registers.
9. **Desktop unregressed.** Chrome and Safari on the desktop render the board exactly as
   before; the manifest is inert there.
10. **Extension host unregressed.** Open the VS Code webview and confirm the widened CSP
    broke nothing and the ignored link tag is harmless.
11. **MIME type.** `curl -I` the manifest route and confirm
    `application/manifest+json`.
