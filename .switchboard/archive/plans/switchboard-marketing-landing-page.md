# Switchboard Public Marketing Landing Page (GitHub Pages, Dev-Dark, 0→1 Positioning)

## Goal

Ship a single, sleek, developer-dark **marketing landing page** for Switchboard, hosted on GitHub Pages from a **new dedicated public repo**, later pointed at a custom domain the owner will purchase once the site is live. The page's job is to convert an **individual builder** into someone who *watches the demo* (delivered as inline looping demo clips, one per core function) and then *installs the extension*.

### The core problem this page must solve

Switchboard is currently discoverable only through the VS Code Marketplace listing, which frames it (like everything in that category) as "another agent orchestrator." That framing badly undersells it and drops it into the most crowded, least differentiated bucket in the space. There is no public surface that tells the *real* story.

### The real positioning (the thesis the whole page hangs on)

**Switchboard is a 0→1 project tool — research → prototyping → team management → coding — that happens to orchestrate agents. It is not an agent orchestrator that happens to have project features.** Agent orchestration is table stakes now that models can write code; the defensible value is the *project management, first-class artifacts, and control-plane* wrapped around the agents. The tool was built by a working Product Lead (healthtech) who added exactly the capabilities needed to run the full 0→1 loop, and who uses it daily on the job. That authenticity is a conversion lever for the individual-builder audience and should be present but understated.

### Root-cause framing for the copy

The hard part of building shipped software has moved. Writing code is increasingly cheap; turning a fuzzy idea into research, into plans, into features spanning repos, into work a team can see as a single source of truth — that is the expensive part, and no coding-agent tool addresses it end to end. The page must make the visitor feel that shift and recognize Switchboard as built for the part that's now hard.

### Confirmed decisions (from scoping)

- **Audience:** individual devs / builders running their own 0→1 loop.
- **Primary intent:** watch the demo. Because the demo is inline clips (not one video), *the page is the demo* — the hero's primary button is **"See it in action ↓"** (smooth-scroll to the showcase); **Install** is the secondary button; a dedicated Install CTA closes the page.
- **Scope:** one long-scroll landing page. No docs/blog in this pass.
- **Aesthetic:** sleek developer-dark (near-black canvas, one accent, monospace accents, generous negative space).
- **Copy:** full production copy, written below, paste-ready.
- **Founder story:** present but understated — one tasteful line/pull-quote; name/role optional (owner drops it in).
- **Claims:** confident, not comparative — assert depth and capability; do not name or explicitly "beat" competitors.
- **Domain:** deferred. Build for the default `*.github.io` URL; buying + DNS + `CNAME` + HTTPS is a self-contained later phase.
- **Demo assets:** ~1 week out. Ship the page now with sized placeholder poster frames; slot clips in as recorded, no layout change.
- **Repo:** new dedicated **public** repo (keeps marketing assets/history/analytics out of the extension codebase; deploys independently).
- **Repo identity (RESOLVED 2026-07-13):** **project-site** — `https://<user>.github.io/switchboard-site/`. Served from a subpath, so the build MUST use **relative asset paths** (or a `<base>` tag), never absolute `/assets/...` (those 404 under a project-site subpath). Verify on the live `github.io` URL, not just the in-editor previewer.
- **Stitch handoff (RECEIVED 2026-07-13):** build from the two prototype files at `.switchboard/stitch/switchboard-landing-page-62484982/`:
  - `c4d62bf3c43b4a2e93ca295b2f6be805.html` (545 lines) — the main landing page.
  - `d9bf1d93c0bd43beba5eaab77ba0db94.html` (431 lines) — a secondary/doc variant.
  Both use Tailwind via CDN (`cdn.tailwindcss.com` with `forms` + `container-queries` plugins) and Google Fonts (Hanken Grotesk, JetBrains Mono, Material Symbols Outlined), with an "Afterburner" dev-dark theme: near-black `#101414` canvas, cyan `#00e5ff` accent, CRT scanlines (`.scanline`), tactical grid (`.bg-grid`), and glow text-shadow (`.glow-text`). The Complex task is extracting these CDN styles into **vendored plain CSS** (no build step, no external CDN) — self-host the fonts, inline or vendor the Tailwind-generated CSS.

### The five headliner pillars (owner's priority order — this is the section order)

1. **Project management that's genuinely ahead** — multi-repo → project → feature → plan hierarchy. Lead pillar, largest clip.
2. **One board, every CLI** — drive coding agents across accounts/subscriptions (Claude Code, Antigravity, Cowork…) from a single board.
3. **Cross-app & remote control** — embed into apps like Cowork/Antigravity; drive remotely from Notion and beyond.
4. **Artifacts as first-class** — readable designed markdown previews, auto-refreshing HTML previews, document importers, Stitch integrations. The pillar that *proves* it's a 0→1 tool, not an orchestrator.
5. **A real control plane** — decoupled from any single repo, team-ready, pushes source-of-truth to Linear / ClickUp / Notion so everyone is aligned.

---

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, feature, infrastructure

## User Review Required

Both calls are now **RESOLVED (2026-07-13)** — recorded here for provenance; no further owner action is needed before build.

1. **Capability-claim accuracy gate — RESOLVED.** Owner confirmed every integration named in the copy (Cowork/Antigravity embed, Notion remote control, ClickUp/Linear sync, multi-account CLI dispatch) is shipped and demoable. The copy stays as-written; no claims need cutting or softening. Each pillar's clip can be produced against the real feature.
2. **Repo identity — RESOLVED.** **Project-site** (`https://<user>.github.io/switchboard-site/`). Asset-path strategy locked: relative paths / `<base>` tag, never absolute `/assets/...`. See Confirmed decisions above.

## Complexity Audit

### Routine
- Single static page — no framework, no build step, standard HTML/CSS/JS.
- Copy, information architecture, and five-pillar order are all pre-decided in this plan.
- GitHub Pages deploy from `main`/root — a standard, well-trodden path.
- Placeholder poster → real-clip swap is a mechanical `src`/`poster` change per pillar.

### Complex / Risky
- **Stitch prototype → self-contained production adaptation.** Extracting the prototype's realized Tailwind/CDN styles into plain vendored CSS is the one genuinely fiddly task. The handoff is now in (two self-contained HTML files — see Confirmed decisions), so the scope is known: each file inlines its own Tailwind config + custom CSS; the coder must reconcile the two, vendor the generated CSS, and self-host the three font families. This is where the real work hides behind a low overall score.
- **Zero-layout-shift video slots** + IntersectionObserver lazy-load + `prefers-reduced-motion` fallback, done correctly — autoplay must only fire *after* the source is attached while in view; `autoplay` on a source-less `<video>` does nothing.
- **GitHub Pages project-site subpath** asset resolution — absolute (`/assets/...`) paths 404 when the site is served from `/switchboard-site/`.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Static site, no server, no concurrent mutable state. N/A.
- **Security:** No user input, no forms, no cookies, no auth. Privacy posture = zero external CDN (self-hosted fonts, vendored CSS/JS), no third-party trackers beyond the optional privacy-first analytics snippet (deferred). Because everything is same-origin, a restrictive CSP `<meta>` is cheap and worth adding. Note: a **public** repo means all copy and positioning are public the instant they're pushed — deploy is owner-triggered so the timing stays controlled.
- **Side Effects:** Creating a new public repo exposes positioning and (eventually) the install funnel publicly. OG/social tags mean link-unfurl caches (Slack, Twitter/X, iMessage, etc.) snapshot whatever state is live when a link is first shared — re-scrape/refresh after clips and the domain land, or early shares immortalize the placeholder state.
- **Dependencies & Conflicts:**
  - **Stitch prototype handoff — RECEIVED (2026-07-13).** Two files delivered; see Confirmed decisions above for paths and theme details. No longer a blocker; the Visual Design spec below is no longer the fallback.
  - **Five demo clips (~1 week)** — the page's actual conversion mechanism. Placeholders ship, but the page is not doing its job until real clips land (see Adversarial Synthesis). Not blocking for build.
  - **Domain purchase** (deferred) — not blocking; the page is reviewable on `github.io`.
  - **Capability-claim accuracy — CONFIRMED (2026-07-13).** Owner verified all named integrations are shipped and demoable; copy stands as-written. No longer a blocker (see User Review Required #1, resolved).

## Dependencies

- None. Self-contained build in a new standalone repo; no cross-session `sess_` dependencies.

## Adversarial Synthesis

**Risk Summary.** Key risks: (1) the page's entire pitch is "see it in action," but the demo clips are ~1 week out, so a public/traffic-driving launch on placeholders sells a demo that isn't there; (2) the Stitch → vendored-CSS adaptation is the real, under-scored work and its size is unknown until the export arrives; (3) GitHub Pages project-site subpaths silently 404 absolute asset paths. Mitigations: gate any public launch on at least the hero (Pillar-1) clip being real — placeholders are for private review only; treat Stitch extraction as the one Complex task and confirm file-vs-folder on receipt; use relative asset paths (or a `<base>` tag) and verify on the live `github.io` URL, not just the in-editor previewer.

---

## Positioning & Messaging Guardrails

- **One-line thesis:** *The 0→1 project tool that runs your whole build — research to shipped — around the agents that write the code.*
- **Voice:** confident, concrete, dev-native. Short sentences. No marketing fluff, no exclamation points, no "revolutionary/game-changing." Show mechanics, not adjectives.
- **Claim discipline:** capability claims are fine ("a project model deep enough for real work"); comparative claims are not ("better than [competitor]"). Where the instinct is "ahead of commercial products," let the *hierarchy clip* carry it instead of the words.
- **Every pillar answers:** what it is → why it matters for 0→1 → shown by the clip.

---

## Information Architecture + Full Copy (top to bottom)

> Copy below is paste-ready. Tokens in `{{DOUBLE_BRACES}}` are links/values to wire at build time: `{{INSTALL_URL}}` (VS Code Marketplace), `{{GITHUB_URL}}` (new repo), `{{INSTALL_COUNT}}` (verify live number, ~4,000).

### 0. Nav (sticky, minimal, transparent→solid on scroll)
- Left: `Switchboard` wordmark (+ small logo mark once available).
- Right: `Demo` · `Features` · `GitHub` (→ `{{GITHUB_URL}}`) · **`Install`** (accent button → `{{INSTALL_URL}}`).

### 1. Hero
- **Eyebrow:** `THE 0→1 PROJECT TOOL`
- **Headline (locked):** **Run the whole build — research to shipped — from one control plane.**
  - *Alt A:* From idea to shipped, without leaving the board.
  - *Alt B:* The 0→1 project tool. Not another agent orchestrator.
- **Subhead:** Switchboard is the control plane for your entire 0→1 build — research, prototypes, plans, and the coding agents that execute them. Not another agent orchestrator. The tool that runs the project around them.
- **Primary button:** `See it in action ↓` (smooth-scroll to §3).
- **Secondary button:** `Install for VS Code` (→ `{{INSTALL_URL}}`).
- **Microcopy under buttons:** Free · Open source · Works with Claude Code, Antigravity, Cowork & more.
- **Hero visual:** the Pillar-1 board clip (poster frame until the clip lands).

### 2. The shift (short "why it exists" band — one tight paragraph)
- **Kicker:** `THE HARD PART MOVED`
- **Copy:** AI can write the code now. The expensive part is everything around it — turning a fuzzy idea into research, into plans, into features that span repos, into work your whole team can see. Coding agents don't touch that. Switchboard was built for exactly that part, by someone doing it every day.

### 3. Demo showcase — the five pillars (each = kicker + headline + 2–3 line body + looping clip; alternate media left/right)

**Pillar 1 — Project management**
- **Kicker:** `PROJECT MANAGEMENT`
- **Headline:** A project model deep enough for real work.
- **Body:** Multi-repo → project → feature → plan. A hierarchy that mirrors how you actually build, so a hundred moving pieces stay legible. Group loose plans into features, watch everything move across one board, and never lose the thread from idea to merge.
- **Clip caption:** One board. Multiple repos. Projects, features, and plans in a hierarchy that holds.

**Pillar 2 — One board, every CLI**
- **Kicker:** `ANY AGENT, ONE BOARD`
- **Headline:** Drive every coding CLI from one place.
- **Body:** Claude Code, Antigravity, Cowork — across different accounts and subscriptions. Switchboard dispatches work to whichever agent you choose and brings the results back to the same board. No lock-in, no tab-juggling.
- **Clip caption:** Fan work out to any agent; watch it all land in one place.

**Pillar 3 — Cross-app & remote control**
- **Kicker:** `WHEREVER YOU WORK`
- **Headline:** Runs inside your tools. Drivable from anywhere.
- **Body:** Embed Switchboard into apps like Cowork and Antigravity, or steer the board remotely from Notion and beyond. Kick off work from your phone; watch it land in your editor.
- **Clip caption:** Start a plan from Notion. Come back to shipped code.

**Pillar 4 — Artifacts, first-class**
- **Kicker:** `ARTIFACTS, FIRST-CLASS`
- **Headline:** Where a 0→1 tool separates from an orchestrator.
- **Body:** Designed markdown previews you'll actually read. HTML previews that auto-refresh as agents work. Document importers and Stitch integrations that pull the real material of a project in. Research and prototyping live here — not just code.
- **Clip caption:** Readable docs, live previews, imported context — the whole 0→1, not just the diff.

**Pillar 5 — A real control plane**
- **Kicker:** `BUILT TO BE A CONTROL PLANE`
- **Headline:** Decoupled from your repo. Ready for your team.
- **Body:** Switchboard doesn't have to run from inside a repo. Push the source of truth to Linear, ClickUp, or Notion so everyone — not just the person with the editor open — sees where things stand.
- **Clip caption:** One source of truth, mirrored to the tools your team already lives in.

### 4. Founder pull-quote (understated trust band)
- **Copy:** "I built Switchboard by adding the things I actually needed to take real work from 0 to 1 — research, plans, team, code. I use it every day."
- **Attribution:** `— built by a product lead, used daily in production` *(owner may replace with name + role, or leave anonymous).*

### 5. Social proof / trust strip
- Row of quiet stats/badges: `{{INSTALL_COUNT}}+ installs` · `Open source` · `Works with Claude Code · Antigravity · Cowork` · `Syncs to Linear · ClickUp · Notion`.
- Optional: live GitHub star count badge.

### 6. Final CTA
- **Headline:** Start your next 0→1 on Switchboard.
- **Subhead:** Free and open source. Install once; run your whole build from the board.
- **Primary button:** `Install for VS Code` (→ `{{INSTALL_URL}}`).
- **Secondary button:** `Star on GitHub` (→ `{{GITHUB_URL}}`).

### 7. Footer
- Left: `Switchboard` + one-line tagline (*The 0→1 project tool.*).
- Links: GitHub · VS Code Marketplace · License (MIT/whatever applies) · (Docs — placeholder for later).
- Small print: `© {{YEAR}} · Built for builders.`

---

## Visual Design (dev-dark spec)

> **The Stitch prototype is the visual source of truth** (see Starting Point & Handoff). The values below are the guardrail/fallback for anything the prototype leaves unspecified — and the target if building without a prototype.

- **Canvas:** near-black `#0B0D10`; raised surfaces `#14171C`; hairline borders `#232830`.
- **Text:** primary `#E6E9EF`, muted `#8B93A1`.
- **Accent:** a single electric accent (proposed `#5B8CFF` blue, or switch to a signal green/amber to match logo once it exists) — used for buttons, kickers, links, focus rings. One accent only.
- **Type:** UI/body in `Inter` (self-hosted, woff2); kickers, captions, wordmark, and stat numbers in a monospace (`JetBrains Mono` / `IBM Plex Mono`) for the terminal-native feel. System-font fallback stack so nothing blocks first paint.
- **Layout:** max content width ~1100px; generous vertical rhythm (pillars ~120px apart); clips in rounded (`12px`) cards with subtle border + soft shadow, sitting on the dark canvas.
- **Motion:** clips loop silently; subtle fade/translate-in on scroll (IntersectionObserver). All motion gated behind `prefers-reduced-motion` (then clips show poster + a play control, no autoplay).
- **Texture:** optional faint dot-grid or radial glow behind the hero; keep it restrained.

---

## Demo Asset Plan (the "GIFs")

- **Ship as muted, autoplaying, looping `<video>` (MP4 + WebM), not `.gif`.** Same seamless-loop effect at ~10–20× smaller file size, sharper, and standard for product demos. Recording workflow on the owner's side is unchanged (screen-capture each function).
  - Markup pattern: `<video autoplay muted loop playsinline preload="none" poster="…">` with WebM + MP4 sources; poster shown until in-view; lazy-loaded below the fold.
- **Five clips to record** (one per pillar, in section order): board hierarchy (multi-repo/project/feature/plan) · dispatch across CLIs · remote/cross-app control · artifacts (markdown + live HTML preview + import) · control-plane sync to Linear/ClickUp/Notion.
- **Placeholder strategy (ship-now):** each slot gets a fixed-aspect-ratio (16:9 or 16:10) poster frame — a static screenshot or a styled "clip coming" panel — with explicit `width`/`height`/`aspect-ratio` so there is **zero layout shift** when real clips arrive. Clips drop in one file at a time; no code/layout change beyond swapping `src`/`poster`.
- **Encoding targets:** ≤2–3 MB per clip, 1280–1600px wide, ~15fps is fine for UI, H.264 MP4 + VP9/AV1 WebM.

---

## Starting Point & Handoff (Stitch prototype)

The coder does **not** start from a blank file. The owner produces a visual prototype using **Switchboard's Stitch integration** and hands it over. The build is therefore **design-to-code adaptation**, not greenfield.

> **Clarification (workflow):** the Stitch prototype and the HTML-previewer dev loop are **manual, owner-driven** steps, not an automated pipeline. The owner designs in the tools, then hands over the file(s) and drops the file location into this plan by hand. No part of this build auto-generates or auto-imports the prototype.

**Source-of-truth precedence (resolve any conflict this way):**
- **Visual design & layout** → the **Stitch prototype wins** (palette, type, spacing, component look, hero treatment). The Visual Design spec above is the fallback for anything the prototype leaves undefined.
- **Information architecture** (section order, five pillars, nav, CTAs) → **this plan wins**.
- **Copy** (every headline, caption, button label) → **this plan wins**; ignore any placeholder/lorem copy in the prototype.
- **Engineering & delivery** (below) → **this plan wins**; a raw Stitch export won't include these.

**Prototype → production checklist (what the coder adds on top of the Stitch output):**
- **Vendor/inline external deps** so the site stays self-contained and build-free for Pages. Stitch typically emits Tailwind (often CDN) + Google-Fonts links: either extract the realized styles into plain vendored CSS (**preferred** — keeps the zero-build promise) or, if extraction is impractical, add a one-time Tailwind CLI purge build that still outputs static files. Self-host fonts as woff2; **no external font/script CDN**.
- **Replace prototype copy** with the production copy from this plan; enforce the five-pillar order and nav/CTA structure.
- **Wire the demo-clip slots** as muted looping `<video>` with fixed aspect-ratio poster placeholders (zero layout shift), lazy-loaded below the fold.
- **Add what a prototype omits:** semantic landmarks + single `h1`, `prefers-reduced-motion` handling, focus states, SEO/OG/favicon tags, smooth-scroll + sticky-nav + IntersectionObserver reveals.
- **Confirm on receipt:** does the Stitch export arrive as a single self-contained HTML file or a folder? That decides single-file vs split-file development (see Phase 0).

## Technical Approach

- **Stack:** static site **adapted from the Stitch prototype** into one `index.html` + `styles.css` + small `main.js` (sticky-nav state, smooth-scroll, IntersectionObserver reveals + lazy video load). **No framework, no build step** (see dependency handling in Handoff) — trivial to maintain, deploys as-is on GitHub Pages.
- **Structure:**
  ```
  /                     (repo root = Pages source)
  ├── index.html
  ├── styles.css
  ├── main.js
  ├── assets/
  │   ├── clips/        (mp4 + webm, added over the week)
  │   ├── posters/      (placeholder + real poster frames)
  │   ├── fonts/        (self-hosted Inter + mono woff2)
  │   ├── og-image.png  (1200×630 social card)
  │   └── favicon.svg
  ├── CNAME             (added in the domain phase, not before)
  └── README.md
  ```
- **Self-host fonts** (no external font CDN) for privacy + no render-blocking third-party request.
- **No cookies, no trackers** beyond the privacy-friendly analytics choice below.

## Proposed Changes

> The site lives in a **new standalone public repo**, not the Switchboard extension repo. These are the files the coder authors/adapts from the Stitch export. All work happens locally in Switchboard's HTML previewer first (Phase 0) — nothing is published until the owner triggers Phase 1.

### `index.html`
- **Context:** the whole page — nav, hero, the shift band, the five pillar sections, founder quote, trust strip, final CTA, footer. Adapted from the Stitch export's markup; copy replaced wholesale with the production copy above.
- **Logic:** semantic landmarks (`header`/`nav`/`main`/`section`/`footer`), exactly one `<h1>` (the hero headline), logical heading order down the pillars. Each pillar's demo slot is a `<video autoplay muted loop playsinline preload="none" poster="assets/posters/pillar-N.png" width=… height=…>` with `<source type="video/webm">` + `<source type="video/mp4">` and a fixed `aspect-ratio` so the poster reserves the clip's exact box (zero layout shift on swap).
- **Implementation:** `<head>` carries `<title>`, meta description, canonical, OG + Twitter card tags (absolute URLs — see Edge Cases), `favicon.svg`, and an optional JSON-LD `SoftwareApplication` block. A restrictive CSP `<meta http-equiv>` is worth adding since every asset is same-origin. Fonts loaded via `@font-face` in `styles.css` (self-hosted woff2), never a CDN link.
- **Edge Cases:**
  - **Pages subpath:** if this is a project-site repo (`/switchboard-site/`), all asset references MUST be relative (`assets/…`, not `/assets/…`) or the page must declare `<base href="/switchboard-site/">`. Absolute paths 404 on a project site. A user/org-site served from root is immune — this is why the repo-identity call (User Review #2) matters.
  - **OG/canonical URLs must be absolute.** Before the domain exists, point them at the `github.io` URL; update them (and re-scrape social caches) when the domain lands.

### `styles.css`
- **Context:** the vendored, self-contained stylesheet — the dev-dark spec realized. This is where the **one genuinely fiddly task** lives: extracting the Stitch export's realized Tailwind/CDN styles into plain CSS.
- **Logic:** design tokens as CSS custom properties (`--bg:#0B0D10`, `--surface:#14171C`, `--border:#232830`, `--text:#E6E9EF`, `--muted:#8B93A1`, `--accent:#5B8CFF`); `@font-face` for self-hosted Inter + mono; layout rules (max-width ~1100px, ~120px pillar rhythm, `12px` rounded clip cards). One accent only.
- **Implementation:** prefer hand-vendored CSS over a Tailwind build to keep the zero-build promise. If the Stitch export's Tailwind is too dense to extract by hand, fall back to a one-time Tailwind CLI purge that emits a static `styles.css` — still no runtime build on Pages. Reveal-on-scroll and reduced-motion handled here (initial hidden/translated state; `.is-visible` class toggled by `main.js`).
- **Edge Cases:** `@media (prefers-reduced-motion: reduce)` disables the reveal transitions and hides autoplay affordances; contrast must clear WCAG AA on the dark palette; visible focus rings on the accent for every interactive element.

### `main.js`
- **Context:** the only script — small, dependency-free, deferred.
- **Logic:** (1) sticky-nav transparent→solid on scroll; (2) smooth-scroll for the hero's "See it in action ↓" and any in-page anchors; (3) IntersectionObserver that both reveals sections (`.is-visible`) and **lazy-loads clips** — attach `<source>`/set `src` and call `.load()`/`.play()` only when the slot enters the viewport.
- **Implementation:** `preload="none"` + `autoplay` alone will NOT fetch or play a below-the-fold clip reliably — a source-less/unloaded `<video autoplay>` renders nothing. The observer must attach the real source on intersection, then trigger play. Poster shows until that moment.
- **Edge Cases:** under `prefers-reduced-motion: reduce`, do NOT autoplay — leave the poster visible with a manual play control. On iOS Safari, inline autoplay requires `muted` + `playsinline` (both present in the markup). No JS should block first paint (`defer`).

### Deploy/meta files
- **`.nojekyll`** (empty) — skip the Pages Jekyll build and avoid `_`-prefix surprises.
- **`README.md`** — short: what the repo is, how Pages serves it, how to swap a clip.
- **`assets/`** — posters/fonts/og-image/favicon as per the structure tree; `clips/` fills in over the week; `CNAME` added only in the domain phase.

## Repository & Deployment

- Create a **new public repo** (proposed name `switchboard-site` or `switchboard-landing`).
- **GitHub Pages:** Settings → Pages → deploy from `main` branch, root (`/`). You still author no Actions workflow — but note (confirmed via research) that branch-based deploys now run through a *system-managed* `pages-build-deployment` Actions run under the hood. Practical consequence: if GitHub Actions is disabled at the repo or org level, branch deploys silently fail to publish. For a personal public repo this is on by default; just don't disable it. Add an empty `.nojekyll` file at the repo root to skip the Jekyll step and avoid any `_`-prefix asset surprises (also trims the deploy run time).
- Site goes live at `https://{{USER_OR_ORG}}.github.io/{{REPO}}/` immediately — usable for review before any domain exists.
- If a repo-name subpath is undesirable even pre-domain, a `{{USER}}.github.io` user-site repo serves from root instead; decide when creating the repo.

## Domain & DNS (deferred phase — run when ready to buy)

> **Superseded:** original step order — register domain → add public DNS records → add `CNAME` file → set custom domain in Pages settings.
> **Reason:** setting public DNS *before* claiming the domain in the repo's Pages settings opens a **subdomain-takeover window** — during it, someone else's repo can bind your exposed DNS record (confirmed by GitHub Docs via web research). The Pages claim must come first.
> **Replaced with:** the corrected sequence below (Pages settings first, then DNS).

1. Register the domain (Cloudflare Registrar or Namecheap — cheapest, cleanest DNS).
2. **Claim the domain in the repo first:** Repo → Settings → Pages → set the custom domain. This auto-commits the `CNAME` file for you (no need to hand-add it). Do this **before** pointing any public DNS at GitHub — it closes the subdomain-takeover window.
3. Add DNS records for the apex + `www`:
   - `A` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` *(confirmed current)*
   - `AAAA` (recommended, IPv6 — set alongside the A records, not instead of them) → `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153` *(confirmed current)*
   - `CNAME` `www` → `{{USER_OR_ORG}}.github.io`
   - **Cleaner apex option:** if the registrar supports `ALIAS`/`ANAME` (Cloudflare does, via CNAME flattening), point the apex at `{{USER_OR_ORG}}.github.io` instead of hardcoding the four A records — survives any future GitHub IP migration.
4. Back in Pages settings, tick **Enforce HTTPS**. The Let's Encrypt cert can take **up to 24h** to provision after DNS propagates; the toggle stays greyed out until it's ready — this is normal, not an error.
- Domain *name* still TBD; page ships and is reviewable long before this phase.

## Analytics (optional, privacy-first)

- **Default recommendation: Cloudflare Web Analytics** — genuinely free, cookieless, no event-volume cap, one `<head>` snippet, and it does **not** require routing the domain's DNS through Cloudflare's proxy (standalone snippet mode works on plain GitHub Pages). Its only limits are minimal reporting (no custom events / UTM funnels, and it samples high-volume history) — fine for a landing page.

  > **Superseded:** "**GoatCounter** (free, open source)" listed as an equal free alternative.
  > **Reason:** research clarified the hosted `goatcounter.com` tier is free only for **non-commercial** use (soft cap ~100k pageviews/mo); a product marketing site plausibly reads as commercial and would need a paid plan (~€15/mo). Only the **self-hosted** binary is unconditionally free.
  > **Replaced with:** GoatCounter is still a fine pick, but choose it deliberately — **self-host** the (EUPL-licensed, single Go binary, SQLite/Postgres) build if you want zero cost + full data ownership + UTM/referrer tracking; use its hosted tier only if you're comfortable it qualifies as non-commercial or you pay.

- Avoid Google Analytics — cookie banners and dev-audience distaste aren't worth it. Fully optional; page works without any.

## SEO & Social

- `<title>`, meta description, canonical URL.
- Open Graph + Twitter card tags with a dark `og-image.png` (1200×630) carrying the wordmark + thesis line.
- `favicon.svg` (+ png fallback). JSON-LD `SoftwareApplication` block for richer search results (nice-to-have).

## Accessibility & Performance

- Semantic landmarks (`header`/`nav`/`main`/`section`/`footer`), one `h1`, logical heading order.
- Contrast ≥ WCAG AA on the dark palette; visible focus rings on the accent.
- `prefers-reduced-motion`: disable autoplay + reveal animations, show posters with a manual play control.
- Alt text / captions on every clip poster.
- Perf: lazy-load below-the-fold clips, `preload="none"`, self-hosted subset fonts, no blocking JS. Target Lighthouse ≥95 on the placeholder build.

---

## Build Sequence (phases)

**Nothing is published until the owner explicitly says so.** GitHub Pages only serves once enabled; the public repo need not even exist during design. Development and review happen locally in **Switchboard's own auto-refreshing HTML previewer** first (on-brand dogfooding of pillar 4).

0. **Prototype in Stitch, then adapt in the previewer (now, local, unpublished):** owner generates the visual prototype via Switchboard's Stitch integration and hands it over. The coder adapts it into the production static site — applying this plan's copy, five-pillar IA, and the prototype→production checklist (see Starting Point & Handoff) — iterating in Switchboard's HTML previewer. Develop as a self-contained `index.html` unless the previewer serves a whole folder. No repo, no URL yet.
1. **Publish the shell (owner-triggered):** create the new public repo, push the files (split into `index.html`/`styles.css`/`main.js` + assets if developed inline), enable GitHub Pages from `main` → live on `github.io`. This is a deliberate step, not automatic.
2. **Drop in demo clips (~1 week):** replace poster placeholders with real MP4/WebM one pillar at a time. Verify clips/fonts on the live URL if they didn't resolve in the previewer. No layout change.
3. **Domain (when owner buys):** register → DNS → `CNAME` file → enforce HTTPS.
4. **Polish (optional):** analytics snippet, refined OG image/logo, live GitHub star badge, docs link.

> **Launch-readiness gate (from adversarial review):** treat "shell published on github.io with placeholder posters" as **private-review-only**. Do not drive real traffic, share unfurlable links, or announce until at least the hero (Pillar-1) clip is a real recording — the page's whole pitch is "see it in action," and five "clip coming" panels convert nobody.

## Verification Plan

### Automated Tests
- **None applicable.** This is a static marketing page in a standalone repo with no test harness, and per session directive automated tests/compilation are skipped. There is no unit/integration surface to assert. All verification is manual/browser-based (below).

### Manual Verification
- **Local (Phase 0, in the HTML previewer):** page renders top-to-bottom; five pillars in order; all production copy present (no lorem); one `<h1>`; nav sticky transparent→solid; "See it in action ↓" smooth-scrolls to §3; reveal-on-scroll fires; posters reserve exact clip boxes (no layout shift when a test clip is swapped in).
- **Self-contained check:** open DevTools → Network, hard-reload — confirm **zero external requests** (no font/script/style CDN, no tracker). Everything same-origin.
- **Reduced motion:** with `prefers-reduced-motion: reduce`, autoplay and reveals are disabled and posters show a manual play control.
- **Accessibility:** keyboard-tab through all interactive elements with visible focus rings; heading order logical; contrast ≥ WCAG AA on the dark palette; every clip poster has alt/caption.
- **Live URL (Phase 1):** on the actual `github.io` URL, confirm no asset 404s (the subpath trap — relative paths / `<base>` resolved); fonts load; OG unfurl preview looks right in a link-preview tester.
- **Perf:** Lighthouse ≥95 on the placeholder build.
- **Mobile:** inline autoplay works on iOS Safari (muted + playsinline); layout holds at narrow widths.

## Uncertain Assumptions

**Resolved — web research completed 2026-07-11.** All items below were confirmed against GitHub / Cloudflare / GoatCounter official docs; findings folded into the Domain & DNS, Repository & Deployment, and Analytics sections above. No open uncertainties remain.

- **GitHub Pages apex `A` records** (`185.199.108–111.153`) and **`AAAA`/IPv6** (`2606:50c0:8000::153 … 8003::153`) — ✅ confirmed current.
- **Deploy behavior** — ✅ confirmed: branch deploys run a system-managed `pages-build-deployment` Actions run; `.nojekyll` still bypasses Jekyll. Two new caveats folded in: (a) don't disable Actions at repo/org level; (b) claim the domain in Pages settings **before** public DNS (subdomain-takeover window).
- **Analytics terms** — ✅ Cloudflare Web Analytics is free + cookieless (standalone snippet, no DNS-proxy required). ⚠️ Correction folded in: hosted GoatCounter is free only for non-commercial use; self-host for unconditional free.

## Out of Scope (this pass)

- Docs site / blog / changelog (single landing page only).
- Logo/brand-mark design (page uses a text wordmark; swap in a mark when it exists).
- Newsletter/waitlist capture (primary intent is demo→install, not email).
- Pricing page (product is free/open source).

## Open Decisions

- None. Hero headline locked to *"Run the whole build — research to shipped — from one control plane."* All copy, structure, design, and phasing decided — the plan is build-ready. (Two owner-owned calls are tracked under **User Review Required**, not as open design questions.)

---

**Recommendation: Send to Coder.** (Complexity 4 — routine static build with one genuinely fiddly spot: the Stitch → vendored-CSS extraction.)

---

## Completion Summary

Built the Switchboard marketing landing page as a self-contained static site in a new dedicated repo at `/Users/patrickvuleta/Documents/GitHub/switchboard-site/` (local only — Phase 0; no remote, no push, owner triggers Phase 1 publish). Adapted the Stitch prototype (`c4d62bf3…html`) into hand-vendored plain CSS with the Afterburner dev-dark theme realized as CSS custom properties; extracted the CDN Tailwind/Google-Fonts dependencies into self-hosted woff2 fonts (Hanken Grotesk + JetBrains Mono, latin subsets) and inline SVG icons replacing Material Symbols, so the page makes zero external requests (enforced by a restrictive CSP `<meta>`). Files: `index.html` (semantic landmarks, one `<h1>`, production copy, five pillars in owner order, OG/Twitter/canonical/JSON-LD), `styles.css` (design tokens, `@font-face`, layout, reveal, reduced-motion, focus rings), `main.js` (sticky nav, smooth-scroll, IntersectionObserver reveals + lazy clip load with `prefers-reduced-motion` native-controls fallback), plus `assets/` (fonts, favicon.svg, og-image.png, ld.json), `.nojekyll`, `LICENSE`, `README.md`. All asset paths are relative for the project-site subpath; verified all assets serve 200 from both root and `/switchboard-site/` subpath, exactly one `<h1>`, no inline styles. Demo clips are wired via `data-webm`/`data-mp4` attributes with fixed `aspect-ratio` placeholders (zero layout shift) — drop files into `assets/clips/` with no code change. No issues encountered; build-ready for owner-triggered Phase 1.

## Review Findings
Implemented the public marketing landing page in `index.astro` and `landing.js` based on the Stitch prototype and production copy layout. Inlined the JSON-LD schema metadata to guarantee search engine ingestion and resolve CSP loading issues. Added missing null safety checks for the sticky navigation scroll listener in `landing.js`. Verified visual layout responsiveness, video autoplay lazy loading, and the zero-layout-shift asset wrappers.
