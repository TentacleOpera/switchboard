# Surface the seat-clear session-restart toll that silently re-triggers MCP OAuth

## Goal

Make Switchboard tell the operator, at the moment it happens, that clearing a seat
restarts that seat's CLI session — and that a restarted session re-initialises its
MCP servers, which makes any OAuth-backed MCP prompt for authorisation again.

Today Switchboard performs this action silently. The operator sees browser windows
opening for OAuth and has no way to connect them to Switchboard's dispatch
behaviour. This plan adds no gate, changes no clear decision, and suppresses
nothing. It makes an existing, correct, structural cost **legible**.

### Root cause analysis

The browser-spam symptom is **not** a bug in the clear logic, a broken token, or a
misconfigured MCP. It is an unpriced, invisible cost of correct behaviour:

1. **Switchboard clears a seat when its work context changes.**
   `src/services/TaskViewerProvider.ts:816-826` gates the clear on
   `lastWorkKey !== workContextKey` (`featureId ?? planId`). The comment at :819 is
   explicit that two subtasks of one feature are one work context and deliberately
   do *not* clear between them. **This gating is already correct and already
   minimal — it is not the defect and must not be changed by this plan.**

2. **For Devin, a clear is a full session restart, not a buffer wipe.**
   `src/standalone/clearReadiness.ts:146-180` documents the observed state machine:
   old-session bracketed-paste teardown (`\x1b[?2004l`), then re-enable
   (`\x1b[?2004h`), then cursor/sync re-establishment. That is a session
   transition, not a screen clear. `src/standalone/ptyHost.ts:182` corroborates —
   it reads "Devin is resetting context." from the CLI.

3. **A new session re-initialises MCP servers**, so every OAuth-backed MCP re-runs
   its auth flow and opens a browser.

4. **The toll is therefore linear in useful work**: roughly (context switches) ×
   (seats), i.e. N features × M seats over a batch. Devin's own one-auth-per-set
   guard collapses only the prompts that *collide in time*; it does nothing about
   prompts spread across a batch. This is why re-authenticating never "sticks" —
   the operator is not repairing a broken credential, they are paying a toll per
   context switch.

5. **Nothing in Switchboard says any of this.** No log line, no UI, no docs. The
   reported cost of that silence was several weeks of unattributed confusion.

The defect being fixed is **(5)**. Points 1-4 are working as designed.

### Non-goals (explicitly out of scope — do not implement these)

- **Do not suppress, defer, batch, or gate the clear.** The clear is semantically
  load-bearing: a seat moving from feature A to feature B must not carry A's
  context. Any change to the `:816-826` decision is out of scope.
- **Do not add a confirmation dialog.** See the repo-wide prohibition in
  `CLAUDE.md`. This notice is informational only. It must never block, delay, or
  offer to cancel a clear. `window.confirm()` is additionally a silent no-op in
  VS Code webviews.
- **Do not suppress the browser** (e.g. `BROWSER=/bin/true`). That trades visible
  noise for silently unauthenticated agents — strictly worse.
- **Do not strip MCP servers from seat profiles.** Considered and rejected by the
  operator; MCP access in seats is required.
- **Do not read or parse Devin's MCP configuration or token store.** Not needed:
  the notice is driven entirely by Switchboard's own knowledge of what it is about
  to do.

### Design constraints discovered during analysis (each one rules out an approach)

These are recorded because each is a trap that a plausible implementation falls
into, and two of them are invisible to the existing parity gates.

- **Terminal output cannot be read on the extension host.**
  `src/services/hostSeams.ts:299` — `onData: () => ({ dispose: () => {} })`. VS
  Code's terminal API exposes no output stream; only standalone's PTY has one.
  **Therefore: detecting an OAuth prompt by scraping terminal output is
  standalone-only and is forbidden as the mechanism.** The notice must be derived
  from Switchboard's own clear decision, which is host-agnostic.

- **`HostUI.showInformationMessage` is a no-op on standalone.**
  `src/standalone/vscodeShim.ts:189` returns `undefined` without displaying
  anything, while `hostSeams.ts:369` is real on the extension host. **Therefore: a
  notification-only surface would ship to one host and silently vanish on the
  other** — precisely the composition-root divergence class described in
  `CLAUDE.md`. The primary surfaces must be the session log and the webview
  broadcast, both of which are genuinely shared.

- **The webview *is* shared.** Both hosts render the same panels
  (`src/services/headlessPanelHtml.ts`) and both drive the same broadcast path —
  `this.postMessage(msg, SURFACES.terminals)` plus `this._broadcaster?.push(msg,
  SURFACES.terminals)` (pattern in use at `TaskViewerProvider.ts:~790`). This is
  the parity-safe way to show the operator something.

- **`SessionActionLog` is shared and already HTTP-exposed.** Constructed in both
  `TaskViewerProvider.ts:9912-9917` and `KanbanProvider.ts:2603-2608`, written to
  `.switchboard/orchestrator/session-log.md`, and served at
  `GET /mission-control/session-log` (`LocalApiServer.ts:7561`). It is the correct
  durable backbone: greppable after the fact, and readable by fleet agents.

- **`ptyClearPolicy.ts` is the precedent to copy.** It resolves clear *timing* for
  both hosts as a shared core (`resolvePtyClearPolicyFromExplicit`) with two thin
  host adapters, and its header comment records that an earlier revision carried
  the ladder twice and drifted. The new cost model must follow that exact shape.

## Implementation

### 1. New shared module: `src/services/clearCostModel.ts`

Pure, dependency-free, no host imports — so both roots consume one copy.

```ts
export type ClearCost = 'session-restart' | 'buffer-only' | 'unknown';

export interface ClearCostNotice {
    cost: ClearCost;
    /** Operator-facing, plain English. No jargon, no remediation nagging. */
    message: string;
}

export function describeClearCost(family: CliFamily): ClearCost;
export function buildClearCostNotice(
    family: CliFamily,
    seatName: string,
    fromWorkKey: string | undefined,
    toWorkKey: string
): ClearCostNotice | null;   // null when there is nothing worth saying
```

Family mapping table — **the implementer must confirm each entry against the
running CLI before shipping, and record the evidence in the module's header
comment.** Do not ship an asserted value that was not observed:

| Family | Expected cost | Basis to confirm |
| :-- | :-- | :-- |
| `devin` | `session-restart` | Operator-observed re-auth after clear; `clearReadiness.ts:146-180`; `ptyHost.ts:182` |
| `claude` | `buffer-only` | `/clear` resets conversation within one process; MCP servers are process-scoped. **Verify — do not assume.** |
| `antigravity` | `unknown` | Not investigated |
| `unknown` | `unknown` | By definition |

Emit a notice for `session-restart` only. `unknown` stays silent: a false alarm on
every clear would be worse than the current silence and would train the operator to
ignore the surface.

### 2. Wire at the clear decision point — BOTH roots

The decision already exists at `TaskViewerProvider.ts:816-826`. Where
`clearBeforePrompt: true` is set, resolve the seat's family via
`deriveCliFamily` (`src/services/cliIdentity.ts:59`) from the seat's startup
command, call `buildClearCostNotice`, and if non-null emit it (§3).

There are **two** places that set `clearBeforePrompt: true` in this block — the
team-preparation arm (~:804) and the non-team arm (~:824). Cover both.

**Composition-root audit is mandatory and is the real work of this task.** Per
`CLAUDE.md`, verb-reachability is not evidence of parity — `bootstrap.ts`'s
`default:` arm delegates unmatched verbs to the provider, so a verb audit comes
back green regardless. Required:

- `src/extension.ts` — confirm the notice emitter is wired into the provider it
  constructs.
- `src/standalone/bootstrap.ts` — confirm the same, by reading the composition
  root directly and diffing the seams each root wires by hand.
- If the emitter is introduced as a settable seam (`engine.setX(...)` style), it
  **must** be wired in both roots in this same diff. An unwired
  `Promise<void>` callback is indistinguishable from a working one at runtime —
  this is the exact failure mode of the four `PlanIngestionEngine` queue seams
  recorded in `CLAUDE.md`.

### 3. Surfaces

**3a. Session log (primary, both hosts, always on).** One line per cost-bearing
clear via `SessionActionLog`: seat name, CLI family, and the work-context
transition. This is the durable record that ends the attribution problem, and it
is reachable by fleet agents over `GET /mission-control/session-log`.

**3b. Webview notice (both hosts).** Broadcast to `SURFACES.terminals` using the
existing `postMessage` + `_broadcaster.push` pair so the standalone webview gets it
too. Render as a passive, auto-dismissing inline banner in the terminals panel.

Rate-limit: **at most one banner per seat per batch.** A banner per clear
reproduces the original spam in a new medium. Log lines (3a) are not rate-limited.

**3c. First-run explainer (both hosts).** The first time a `session-restart` clear
occurs, show a fuller one-time explanation: what just happened, why it is expected,
and that it recurs per context switch. Persist a "seen" flag so it never repeats.

The flag is **new state that has never shipped**, so per `CLAUDE.md` it takes a
clean break — no migration, no compat shim. Do not add one.

Implement 3c through the same webview broadcast as 3b, **not** through
`HostUI.showInformationMessage` — that is the standalone no-op documented above.
The extension host may *additionally* raise a native notification, but only as an
enhancement layered on top of a surface that already works in both hosts.

### 4. Documentation

Add a short section to the docs explaining the toll: why re-authentication recurs,
that it is proportional to context switches rather than a broken credential, and
that reducing feature-switching per seat reduces it. Keep it factual — this plan
does not promise a reduction, only visibility.

## Verification Plan

**Both hosts, every check.** A result from one host is not evidence for the other.

1. **Unit — cost model.** `describeClearCost` returns `session-restart` for
   `devin`; `buildClearCostNotice` returns `null` for `unknown` and for
   `buffer-only`. Table-driven over every `CliFamily` member so a newly added
   family fails the test rather than silently defaulting to a notice.

2. **Unit — no behaviour change to clearing.** Assert that the `:816-826` decision
   produces identical `clearBeforePrompt` values with the notice path enabled and
   disabled. The notice must be provably side-effect-free on dispatch.

3. **Composition-root diff (manual, mandatory).** Read `src/extension.ts` and
   `src/standalone/bootstrap.ts` side by side and confirm every seam this change
   introduces is wired in both. Record the seam names checked in the PR
   description. Do **not** substitute `npm run standalone-parity:check` — per
   `CLAUDE.md` it is scoped to the browser read-back path, not composition roots,
   and will pass regardless.

4. **Extension host, live.** Dispatch two cards from different features to one
   Devin seat. Confirm: the clear still happens; a session-log line is written; one
   banner appears; the first-run explainer appears exactly once and never again.

5. **Standalone host, live.** Repeat step 4 under the standalone/npx host. The
   session log and the banner must both appear. **This step is the one that
   catches the `vscodeShim.ts:189` no-op** — if the banner is missing here, the
   implementation went through `HostUI` and must be reworked.

6. **Rate limit.** Dispatch five cards across five features to one seat. Confirm
   five log lines and at most one banner.

7. **Anti-regression — no confirm gate.** Grep the diff for `confirm(`,
   `window.confirm`, and modal `showWarningMessage`. Any hit is a defect per
   `CLAUDE.md`. Manually confirm the clear proceeds without any operator input.

8. **Silence for unknown families.** A seat with a non-Devin, non-Claude startup
   command produces no banner and no explainer.

## Metadata

**Complexity:** 5
**Tags:** reliability, ux, authentication, cli
