# Switchboard — agent rules

## NEVER add confirmation dialogs. NO EXCEPTIONS.

Delete buttons delete immediately. No `confirm()`, no `window.confirm()`, no modal `showWarningMessage`, no two-click patterns, no "Are you sure?". The user has demanded this repeatedly. Buttons are deliberately hard to misclick.

Also a hard technical reason: `window.confirm()` is a **silent no-op in VS Code webviews** (sandboxed iframe without `allow-modals` — it always returns `false`). Any confirm gate added to `src/webview/planning.js`, `src/webview/kanban.html`, etc. makes the button do *literally nothing*. This exact bug broke the kanban delete-plan button (fixed 2026-06-11).

If you find a confirm gate in this codebase, it is a bug — remove it. Multi-choice decision dialogs (e.g. 3-way conflict resolution) are allowed; plain confirm gates are not.

## What this product is

**A Raspberry Pi product.** Switchboard is being rebuilt as an appliance: a board
host running on a small box, with agent seats running on other machines. That is
the shape every decision should serve.

- **The standalone host is primary.** `src/standalone/bootstrap.ts` — the
  `switchboard`/npx CLI — is what actually runs on the Pi, on :7777, and is what
  a board deployment means. Measured: 182 MB RSS on a Pi 400 with no seats, so
  **board-only fits 1 GB**; board plus local agents wants 2 GB minimum, 4 GB
  comfortable.
- **One store, one host.** One better-sqlite3 database owned by that host. Not
  libSQL (rejected), not a git-carried board (rejected). Other machines never
  open the database — they reach it over HTTP.
- **Multi-machine means seats, not stores.** A seat's startup command carries an
  `ssh`/`mosh` transport prefix; the pty stays local and the agent process runs
  on the other box.
- **The VS Code extension (`src/extension.ts`) is the legacy host.** It still
  ships and still has to work, but it is no longer the thing being designed for.
  Do not describe this product as a VS Code extension.

## Standalone and the extension MUST NOT diverge. NO EXCEPTIONS.

Both composition roots exist, so every feature must land in **both**. If you are planning a feature, the plan names both composition
roots and its verification covers both. If you are implementing one, the diff
touches both. "Extension first, standalone later" is not a plan — it is a
divergence, and no gate catches it.

**The trap is not verbs.** `bootstrap.ts`'s `default:` arm delegates every
unmatched verb to the provider, so verb-reachability audits always come back
green. The trap is **composition-root wiring**: service seams
(`engine.setX(...)`), options objects handed to shared services, and
`Promise<void>` callbacks where "never wired" and "working" are the same value.
Diff the two roots by hand. The seams each host *wires* are the audit — not the
verbs each host answers.

**Precedent (2026-08).** All four `PlanIngestionEngine` queue seams —
`setQueueHeadResolver`, `setQueuePacingResolver`, `setQueueTeamMembersResolver`,
`setQueueEscalationRecorder` — were wired in `extension.ts` only, a month after
standalone shipped. Consequently **no queue watch was ever armed in the
standalone host**: seat pacing was unreachable, dead seats were never re-staged,
and the queue stall backstop did not exist. Every gate stayed green, because
`npm run standalone-parity:check` is scoped to the browser read-back path, not
the composition root. The two roots had also drifted the *other* way — standalone
wires two seams the extension does not.

## A fallback must never be indistinguishable from a real value.

On any read of **configuration, identity, routing, or membership**, a default that behaves exactly
like a configured value turns a loud failure into a quiet wrong answer. No gate catches this: a
fallback is a *positive* line of code that passes lint, compile and review while looking like care.
It is the single largest source of reported bugs in this codebase.

Shipped examples, every one of which became a bug report: `'unknown'` CLI family silently borrowing
Claude's 8000ms readiness ceiling instead of Devin's 20000ms, so every fix to the Devin timing was
invisible to the seat that needed it; `|| '/static/icons/nav-jet.svg'`, which made "no team has an
icon" look identical to "every team picked the same one"; `catch { return {} }` on a config load,
which reads a *corrupt* file as an *unconfigured* one; and a four-level startup-command lookup where
a stale value from a retired store wins and nothing records which store answered.

**This is not a ban on defaults.** On those four kinds of read, either:

1. **Tag it** — return the source alongside the value (`{ value, source }`), and log the source where
   it is used. "Which store answered?" must be answerable after the fact.
2. **Fail loudly** — surface the missing or corrupt config instead of substituting a plausible one.

Where a default is truly unavoidable, choose the value whose failure is **visible or safe**, never the
one that is merely quiet — an unrecognised CLI waits on the *longest* boot ceiling, because guessing
short breaks delivery and guessing long costs seconds.

Fallbacks on **presentation** paths (a label, a placeholder, an avatar) are fine. The test is whether
a wrong value silently changes *behaviour*.

## Build

- **Treat `src/` as the source of truth for review.** Do NOT audit, check, or flag `dist/` staleness during reviews or verification — a stale `dist/` is never the finding.
- **`dist/` is not inert, though.** The standalone host runs from it (`node dist/standalone/cli.js`, and the `switchboard` CLI binary under `dist/<platform>/`), and `test:contract:pty-host-blackbox` spawns the Go pty host from it. So "nothing is served from `dist/`" is false — it is simply not what you review.
- Contract suites run against `out/`, not `dist/`: run `npm run compile-tests` before any `test:contract:*` script or you are testing the previous build.

## Users & migrations

- The dividing line is whether the state **shipped in a released version**:
  - State/files/settings that exist in any released version MUST be migrated on change: import before deleting, archive legacy files as `*.migrated.bak` rather than unlinking, preserve unknown/legacy keys instead of dropping them, and never assume a prior migration "already ran" for the install base.
  - Features that have only ever existed in unreleased dev work can take clean breaks — no migrations, no compat shims.
- When unsure whether something shipped, assume it did and migrate — a no-op migration costs nothing; a missing one destroys user data.
- **The install base is not recorded here, deliberately.** This section used to open with "Published extension, ~4,000 installs", which is a marketplace fact about the legacy host and was being cited to justify migration work on a product that is being rebuilt as a Pi appliance. The rule above does not need a number: it turns on *shipped versus unreleased*, which is checkable from git. If you need the real install base for a sizing decision, ask — do not infer it from this file.

<!-- switchboard:claude-protocol:start -->
- Plans reach the board on their own: a `.md` file written to a designated
  plans directory is imported automatically by a watcher. Committing is
  irrelevant — untracked files import too. Never import a plan yourself.
- Memo capture mode: while active, append each user message verbatim — do not
  analyse, plan, or write code. Begin every reply with `[MEMO CAPTURE ACTIVE]`.
- Kanban questions: use the `query-kanban` skill. Displayed column labels differ
  from the stored IDs, so hand-written SQL silently returns nothing.
<!-- switchboard:claude-protocol:end -->
