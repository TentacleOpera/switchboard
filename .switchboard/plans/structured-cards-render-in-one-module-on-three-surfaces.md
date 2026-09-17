# Structured Cards Render in One Module on Three Surfaces

## Goal

Lead instructions and member reports already reach the board through the CLI. Render them as
**structured cards** from a single shared webview module consumed by the dock Agent panel, the mobile
command panel, and the seat status pane — styled to the product's own brand rather than looking like
a debug dump.

This is the presentation layer the rest of the *Agent Panel Becomes a Standing Controller* feature
consumes. It is deliberately **first**, because it has no dependency on the controller at all, and
because building it first de-risks the three-surface wiring trap before anything else relies on it.

### Problem analysis

**The data is already there; the pane shows plumbing instead.** `getTurnEndReports`
(`KanbanDatabase.ts:13590`) returns `turn_end` events by kind (`finished` / `blocked`), LEFT JOINed
to `plans` so a record survives its card, and `switchboard reports [--kind blocked|finished] [--json]`
already reads it. What `renderStatusPane` (`terminals.js:8187`) shows today is identity, a thin
declared block, then host-derived signals — "last output 4m ago", "receiving output", "output off".
Those are honest and stay, but they are the *subordinate* tier by the pane's own documented contract,
and the tier above them is nearly empty.

**Why it looks unstyled: it is.** `.status-pane-card` (`terminals.css:1530`) is a flat
`var(--term-surface)` with no border, no radius and no elevation; everything is 11px; and the only
typographic differentiation in the whole card is `opacity: 0.85` on signal lines and an 8px uppercase
label.

### 0. Which files "the Agent panel" means (read this before grepping)

There are two unrelated things in this repo called *Agent Control*, and the larger one is **not**
what this plan touches. A coder who greps for the name will land on the wrong file first.

| file | what it is | this plan |
| --- | --- | --- |
| `src/webview/dock.js:140-560` (markup in `dock.html`) | the **dock's Agent tab** — log, quick actions, card/column pickers, provider config | **in scope** |
| `src/webview/command.js:2625-2900` (markup in `command.html:1113-1145`) | the **mobile command surface's `agent` view** — a near-verbatim copy of the above | **in scope** |
| `src/webview/agent-control.js` (4001 lines) + `agent-control.html` | the **Agent Control panel** — Agents, Teams, Prompts, Standing Orders tabs, extracted from `kanban.html` | **out of scope; do not edit** |
| `src/webview/terminals.js:8187` `renderStatusPane` (CSS `terminals.css:1530`) | the **seat status pane** | in scope for change 12 only |

The two in-scope copies are genuinely duplicated: the same element ids
(`agent-control-log`, `agent-control-quickactions`, `agent-control-card-select`,
`agent-control-provider`, …) are queried independently in each file, and each has its own render and
fetch path. That duplication is the divergence risk change 2 names, and it is why change 12's shared
renderer is not optional polish.


Of the four files above, this subtask touches **`terminals.js` / `terminals.css` (the status pane)**
and adds the shared module the dock and mobile panes will consume. It does **not** rebuild the Agent
panel itself — that is the *Agent Panel Becomes a Controller Console* subtask.

## Metadata

- **Complexity:** 4
- **Tags:** ui, frontend, mobile, refactor

## Host Scope

**Standalone only.** `src/extension.ts` is the legacy host and is being removed; wiring this there
is throwaway work, and "the extension does not have it" is the intended state, not a divergence.
No `extension.ts` composition-root seam is touched, and none should be added.


## Dependencies

None. This subtask ships alone and is independently useful. Everything it needs —
`getTurnEndReports`, the CLI report path, `sharedUtils.js` as a shared-module precedent — already
exists.

Two later subtasks of this feature **consume** it: *The Agent Panel Becomes a Controller Console*
(the supervisor chat pane) and *Judgement Tiers, the Supervisor Seat and Reroute* (the supervisor's
structured output). Neither is a dependency in the other direction.

## Complexity Audit

### Routine

- Reading `getTurnEndReports` — an existing DB read with an existing CLI reader. No new write path.
- Restyling `.status-pane-card` against tokens the app's `:root` already defines.
- Writing one renderer module and calling it from three places.

### Complex / Risky

- **Three-surface script wiring across two different mechanisms.** `{{...URI}}` placeholder
  substitution in `headlessPanelHtml.ts` for the dock and terminals views, versus a literal
  `/static/webview/...` path in `command.html`. Wiring one and not the other produces a surface where
  the renderer is simply `undefined` — "never wired" and "working" look identical until the pane
  renders empty.
- **Theme correctness under two themes** with no hardcoded hex anywhere.

## Edge-Case & Dependency Audit

### Race Conditions

- None material. This is a read-and-render path with no shared mutable state.

### Security

- None introduced. The cards render content the board already holds and already serves; no new
  endpoint, no new credential, no log-tail access.

### Side Effects

- `terminals.css` is shared by the terminals view; a careless selector change affects panes outside
  this subtask's scope. Scope new rules under the card's own class names.

### Dependencies & Conflicts

- **Reads, does not change:** `getTurnEndReports` (`KanbanDatabase.ts:13590`), `switchboard reports`.
- **Shares a stylesheet with:** the existing status pane, whose host-derived block keeps its place and
  its visual subordination.
- **Must not touch:** `src/webview/agent-control.*` — a different panel with a confusingly similar
  name (see the file map above).

## Adversarial Synthesis

Key risks: the renderer silently fails to load on one of the three surfaces because only one of the
two script-URI mechanisms was wired; the card's CSS hardcodes a colour and breaks under
`body.theme-claudify`; or a coder edits `agent-control.js` — a 4001-line unrelated panel — because it
matched the grep. Mitigations: a runtime assertion per surface as a named verification item, a
no-hardcoded-hex assertion over the card CSS, and the explicit file map in the Goal.

## Proposed Changes

### 12. The structured card renderer is shared, and the seat status pane is its second consumer

The supervisor's structured output (changes 2 and 8) is not an Agent-panel feature. It is a
presentation layer, and the seat status pane wants it more than the Agent panel does.

**The data is already there.** Lead instructions and member reports already travel through the CLI,
so the board holds them: `getTurnEndReports` (`KanbanDatabase.ts:13590`) returns `turn_end` events
by kind (`finished` / `blocked`), LEFT JOINed to `plans` so a record survives its card, and
`switchboard reports [--kind blocked|finished] [--json]` already reads it. The status pane needs a
read, not a new write path.

**What the pane shows today is plumbing, not content.** `renderStatusPane` (`terminals.js:8187`)
renders identity, then a thin declared block, then host-derived signals — "last output 4m ago",
"receiving output", "output off". Those are honest and stay, but they are the *subordinate* tier by
the pane's own documented contract, and the tier above them is nearly empty.

**This fills that tier rather than overriding it.** The pane's ordering is already a contract, not a
layout preference: identity, then what the agent DECLARED, then — visually subordinate — what the
host inferred, because *"a `blocked` the agent wrote is a fact; 'no output for 90 seconds' is a
guess, and this codebase has shipped false `blocked` notices derived from exactly that kind of
guess."* A post made through the CLI is declared. Cards go in the declared tier; the host-derived
block keeps its place and its subordination.

**One renderer, three surfaces.** The card component lives in one module, consumed by the dock Agent
panel, the mobile command panel, and the seat status pane in `terminals.js`. Change 2 already
requires `dock.js` and `command.js` not to drift; a third copy in `terminals.js` would be worse. One
module, three call sites, diffed by hand.

**The precedent exists and so does the trap.** `sharedUtils.js` is already loaded by all three
surfaces, so a shared webview module is a solved problem — but it is loaded through **two different
mechanisms**, and wiring only one produces a surface where the renderer is simply `undefined`:

| surface | how the script tag is resolved |
| --- | --- |
| `dock.html:550`, `terminals.html:502` | `{{SHARED_UTILS_URI}}` placeholder, substituted per panel in `headlessPanelHtml.ts` (`:334`, `:368`, `:404`, `:485`, `:517`, `:551`) |
| `command.html:1236` | a **literal** `/static/webview/sharedUtils.js` path |

So a new `statusCards.js` needs: its own `{{…_URI}}` replace added at **each** relevant
`headlessPanelHtml.ts` call site, a literal path in `command.html`, and a `<script>` tag in
`dock.html`, `terminals.html` and `command.html`. This is composition-root wiring in the sense
CLAUDE.md means — "never wired" and "working" look identical until the pane renders empty — so it is
a named verification item, not an implementation detail.

Only `headlessPanelHtml.ts` matters. The `*PanelProvider.ts` substitutions
(`PlanningPanelProvider.ts:827`, `DesignPanelProvider.ts:958`, `TicketsPanelProvider.ts:1481`) are
extension-host paths and are out of scope per Host Scope.

**The schema is closed and validated on arrival**, exactly as the supervisor's output is: an
unrecognised card type, or a payload that fails validation, renders as plain text rather than
vanishing.

**Branded means labcom.dev, and that is Afterburner — not the terracotta theme.** The live site
(`../switchboard-site/src/styles/global.css`) is the reference: `--background: #101414`, neon cyan
`--primary-container: #00e5ff` with `--glow-cyan: rgba(0, 229, 255, 0.4)`, `"Hanken Grotesk"` body
and `"JetBrains Mono"` mono, a tight `--radius: 2px` / `--radius-lg: 4px`, semantic `--error:
#ff4747` / `--warning: #ffb800` / `--success: #3ef06d`, and the `.scanline` overlay. The app's
default `:root` in `terminals.css` already speaks it (`#0d0d0d`, `#00e5ff`, Hanken Grotesk).
`design_system/switchboard_design_claudify.md` — Refined Terracotta, `#d97757`, Poppins/Lora — is
the **alternate** theme behind `body.theme-claudify`, not the brand. Cards render correctly under
both, and neither may hardcode a hex: they consume the theme's tokens.

**Why it looks unstyled today: it is.** `.status-pane-card` (`terminals.css:1530`) is a flat
`var(--term-surface)` with no border, no radius and no elevation; everything is 11px; and the only
typographic differentiation in the whole card is `opacity: 0.85` on signal lines and an 8px
uppercase label. Against a brand with a defined type scale, a mono uppercase eyebrow, semantic state
colours and a glow treatment, that reads as a debug dump.

**The site's type roles map onto the card directly**, and reusing them is what makes it look like
the product rather than like a pane someone styled once:

| role | site class | card use |
| --- | --- | --- |
| eyebrow / chip | `.kicker` — JetBrains Mono 12px, 0.2em tracking, uppercase, cyan | state chips, the `host-derived` label, card-type tags |
| body | `.body-sm` — 14px / 1.5 | the posted content of a card |
| identifier | `.mono` | seat names, plan ids, commands |
| emphasis | `.glow-text` | as sparingly as the site uses it |

**State colour is semantic and reserved.** `blocked` takes `--error`, `finished` takes `--success`,
waiting-on-a-human takes `--warning`. Cyan stays the brand accent and never becomes a status colour
— the same discipline the site keeps, and the same reason the terracotta theme reserves its accent
for critical items.

**Surface treatment.** The card is a surface, not a bare region: one step of tonal elevation above
the pane behind it, a 1px outline token, `--radius-lg`, and the compact density the pane already
has. Depth comes from tone, never from a drop shadow.

**One stylesheet, like one renderer.** The three call sites share the card's CSS as well as its
markup; `terminals.css`, the dock and the mobile surface must not each grow their own copy.

This cuts against a local convention and the plan chooses deliberately: the mobile Agent markup in
`command.html:1113-1145` is written as **inline `style="…"` attributes**, and the dock's is not.
Inline styles cannot be themed by a `body.theme-claudify` selector without `!important`, which is
exactly the hardcoding this section forbids. The card's styles therefore go in a shared stylesheet
consumed by all three surfaces, and the renderer emits class names only — **no `style` attribute on
any card element**. The surrounding inline-styled scaffolding in `command.html` is left alone; this
plan does not convert it.

**Fallbacks are fine here.** This is a presentation path — a label, a placeholder, a relative
timestamp, an avatar. CLAUDE.md's fallback rule governs configuration, identity, routing and
membership, and none of those are being read to draw a card. Do not build source-tagging into a
subtitle.

It remains a status pane, not a log viewer: cards are posts, not output, and the existing non-goal
holds — the panel renders no emulator.


## Verification Plan

### Automated Tests

- The seat status pane renders lead instructions and member reports as cards, read from the existing
  turn-end reports, with no new write path added.
- Host-derived signals stay visually subordinate to declared posts in the status pane, and no card is
  synthesised from an inferred signal.
- An unrecognised card type renders as plain text on all three surfaces rather than disappearing.
- The card renderer exists in exactly one module; its three call sites are diffed by hand.
- The shared card module is loaded by all three surfaces from a running standalone host: assert the
  renderer symbol is defined in the dock, the mobile command surface, and the terminals view — the
  two script-URI mechanisms are both wired.
- Cards render correctly under the default Afterburner theme and under `body.theme-claudify`, and the
  card CSS contains no hardcoded hex.
- State colour uses the semantic tokens; the brand accent is not used as a status colour.
- No card element carries a `style` attribute; the card's CSS lives in one shared stylesheet.
- No file under `src/webview/agent-control.*` is modified by this change.

### Goal Invariants

1. A card-renderer symbol is defined in **exactly one** module under `src/webview/` — **paired
   with:** it is referenced from `dock.js`, `command.js` and `terminals.js`, and resolves at runtime
   in all three. (Absent alone passes if someone deletes the pane.)
2. No hardcoded hex literal appears in the card CSS — **paired with:** the card renders with resolved
   non-transparent colours under both the default theme and `body.theme-claudify`.
3. No `confirm(`, `window.confirm(` or `showWarningMessage` appears on any path added by this
   subtask.
4. The declared tier renders **above** the host-derived block in `renderStatusPane`, and the
   host-derived block still renders — the restyle does not delete the honest signals it subordinates.

---

**Recommendation: Send to Coder.** Complexity 4 — multi-surface but routine, reusing an existing read
path, with one genuine wiring trap that the verification names explicitly.

---

## Implementation summary (Coding-coder-1)

Shipped the shared structured-card renderer as one module, `src/webview/statusCards.js`, with a
matching single stylesheet `src/webview/statusCards.css`; both are loaded by all three surfaces —
`dock.html`, `terminals.html` (via `{{STATUS_CARDS_URI}}` / `{{STATUS_CARDS_CSS_URI}}`, substituted
in `headlessPanelHtml.ts` `getDockHtml`/`getTerminalsHtml`) and `command.html` (literal
`/static/webview/statusCards.js` / `.css`), so both script-URI mechanisms are wired. The seat status
pane now draws its declared tier as cards from the board's existing turn-end reports
(`GET /kanban/reports`, matched to the seat's dispatched plan id, with the seat-report inbox as the
fallback) rendered above the host-derived block, which keeps its place and subordination. The dock
and mobile Agent panels render the same reports feed through the same module into a new
`#agent-control-reports` container. Card CSS is token-only (no hex; semantic `--error`/`--warning`/
`--success` added to each surface's theme block) and the renderer emits class names only, so cards
re-theme under `body.theme-claudify` and no card element carries a `style` attribute; an
unrecognised card type or bad payload renders as plain text on all three surfaces. No file under
`src/webview/agent-control.*` was touched, and no confirmation dialog was added. Compilation and the
automated suites were skipped this run per the dispatch directive, so runtime verification against a
rebuilt standalone host remains outstanding.
