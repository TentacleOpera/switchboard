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
- **The VS Code extension (`src/extension.ts`) is the legacy host, and it is
  being removed.** The release is a **hard cutover**: the extension ships once,
  alongside everything else, and there is no version in which the old host and
  the new one must interoperate. So it does **not** have to keep working across
  the change, and a feature is never blocked, narrowed, or deferred to preserve
  extension-host behaviour. Do not write new code in the legacy host to keep it
  compatible — that is throwaway work protecting a host that is going away. Do
  not describe this product as a VS Code extension.

  The staged removal is on the board as the feature *"VS Code Becomes a Sidebar,
  and Stops Being a Second Host"* (Stage 1 — The Panels Leave the Editor;
  Stage 2 — The Extension Stops Being a Host; Stage 2b — vscodeShim Removal).
  Check the board for their current column before reasoning about what the
  extension host still does.

## Standalone and the extension MUST NOT diverge. NO EXCEPTIONS.

**Scope, since the cutover.** This rule governs the code the cutover *keeps* —
anything shared, and anything the standalone host wires. It is about a change
landing in one root and silently not the other.

It is **not** a requirement to wire new seams into the legacy host. A seam built
after the cutover decision lands in **standalone only**; wiring it into
`extension.ts` is throwaway work in a host that is being removed, and "the
extension does not have it" is then the intended state, not a divergence. A plan
for new work names the standalone root and says the extension is out of scope;
it does not carry a second, doomed implementation to satisfy this heading.

Where both roots *do* still wire the same seam, the rest of this section applies
in full:

Every such change must land in **both**. If you are planning one, the plan names
both composition roots and its verification covers both. If you are implementing
one, the diff touches both. "Extension first, standalone later" is not a plan —
it is a divergence, and no gate catches it.

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

## All work lands on `main`. NO EXCEPTIONS.

Commit to `main`. Do not create a branch, do not switch to one, and do not
commit onto a branch you happen to find checked out — **check `git rev-parse
--abbrev-ref HEAD` before your first commit** and stop if it is not `main`.

This is a single-operator repo with agents committing into one tree. A branch
does not isolate anything here: the working tree is shared, so a branch only
splits the *history* while every agent keeps editing the same files. The result
is commits stranded off `main` that nobody notices until someone reads the log.
That has already happened — `archive-in-board-database` collected three commits
this way.

If you find yourself on a branch with commits that belong on `main`, do not
discard anything. When `main` is an ancestor, it is a fast-forward:
`git branch -f main <branch> && git checkout main`, in that order — moving the
pointer first means the checkout never reverts files under a dirty tree. If the
two have genuinely diverged, stop and ask.

## Build

- **Treat `src/` as the source of truth for review.** Do NOT audit, check, or flag `dist/` staleness during reviews or verification — a stale `dist/` is never the finding.
- **`dist/` is not inert, though.** The standalone host runs from it (`node dist/standalone/cli.js`, and the `switchboard` CLI binary under `dist/<platform>/`), and `test:contract:pty-host-blackbox` spawns the Go pty host from it. So "nothing is served from `dist/`" is false — it is simply not what you review.
- Contract suites run against `out/`, not `dist/`: run `npm run compile-tests` before any `test:contract:*` script or you are testing the previous build.

## A green review is not a working board. ASK THE RUNNING HOST.

Reviewing `src/` tells you the diff matches the plan. It does not tell you the
product works, and the two come apart constantly. Before reporting any verdict on
behaviour, **query the live board** — it is at `http://127.0.0.1:7777` whenever
Switchboard is up, and it answers in one curl.

Precedent (2026-09-19). The five-defaults change was reviewed against the plan,
landed eight green contract suites, and was reported as goal-achieved while the
operator was looking at the *old* teams. Three separate reasons, none of them
visible in a diff:

- **The host was running stale bytes.** `dist/standalone/cli.js` had been rebuilt
  44 minutes *after* the node process started. Node reads the bundle once; writing
  it under a live process changes nothing. `ps -eo lstart` on the host versus the
  bundle's mtime is the check, and a restart is the fix.
- **A webview surface lost its only host-free fallback.** The TEAMS gallery used to
  draw five hard-coded shipped types, so a missed `agentGroups` response was
  invisible. Deleting that second catalogue turned "always populated" into
  "silently blank whenever the one fire-and-forget request is missed" — and the
  request is posted once, on tab activation, with no retry.
- **Two surfaces drew different art for the same team.** The rail used
  `team-<headRole>.svg`; the TEAMS tab reached for `agent-<role>.png` and an inline
  `<use>` portrait and never for the jet. Both "passed review" because neither
  plan nor test ever said they had to agree.

So: **when a change has a UI, open the UI.** `curl` the verbs the surface calls,
check the served bundle is the one you built, and confirm the process predates
nothing. "The suites are green" is evidence about the code, never about the board.

Corollary — **an empty list is a claim, and it needs a source.** "The host has not
answered yet" and "there is genuinely nothing" must never render the same string.
That is the fallback rule above applied to a read that returns a collection, and
it is the failure mode a passing test suite is least likely to catch.

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
- Writing a plan? Read plan-authoring-protocol.md.
<!-- switchboard:claude-protocol:end -->
