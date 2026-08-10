# Standalone Doc-Parity Audit — Harness, Claim Register and Evidence Rules

## Metadata

**Complexity:** 4
**Tags:** audit, standalone, parity, infrastructure
**Project:** Browser Switchboard

## Goal

Stand up everything the section audits need: audited builds of current `src` for **both** browser hosts, a scratch workspace carrying representative state, and the claim register with its evidence rules. This subtask produces no verdicts — it produces the instrument the six section subtasks record into and the closeout subtask gates on, plus the rules that make those verdicts trustworthy.

### Problem analysis and root cause

The `switchboard-site` docs document the **extension's** feature set — the full product. Every user-facing feature they describe is a feature the standalone (browser) host is expected to have. The audit checks each one against what standalone actually delivers; every mismatch is a standalone defect.

Standalone parity has been declared complete several times and has not been. The failures share one method error, and this subtask exists to make repeating it impossible.

#### Why previous parity checks kept passing — three composing mechanisms, only the first ever checked

**1. Verb reachability cannot fail.** `bootstrap.ts`'s `kanbanVerb` `default:` arm (`src/standalone/bootstrap.ts:1140-1164`) delegates every unmatched verb to `kanbanProvider.handleServiceVerb` (`src/services/KanbanProvider.ts:7365`) → `_handleMessage`. In standalone **every verb is therefore reachable and every DB write lands.** Asking "is the verb wired?" or "did the write persist?" returns green for features that are entirely dead in the browser.

**2. The board payload is fabricated, not read.** Both standalone state builders — `pushFullState` (`src/standalone/bootstrap.ts:404-410`) and `getFullState` (`:433-439`) — emit the same five messages built from hardcoded literals rather than from live state:

| Message | Fabricated value | Lines (both builders) |
|---|---|---|
| `updateColumns` | `DEFAULT_KANBAN_COLUMNS` — ignores custom columns, visibility and ordering | `:405`, `:434` |
| `updateWorkspaceSelection` | `activeFilter: null`, `controlPlaneMode: 'none'`, `controlPlaneRoot: null`, `repoScopeFilter: null`, `projectContextEnabled: false`, plus a single synthesised workspace item | `:406`, `:435` |
| `cliTriggersState` | `enabled: false` — CLI triggers forced off | `:407`, `:436` |
| `switchboardThemeNameSetting` | `theme: 'afterburner'` — fixed | `:408`, `:437` |
| `updateBoard` | `routingConfig: {}` — empty routing map | `:409`, `:438` |

These builders publish straight to the WS hub via `server.broadcastWs` (`:411-413`) — a **separate producer** from the providers' own `postMessage` pushes. Both reach the browser; only this one carries fabricated values.

**3. The user's change is re-asserted over ~40 ms later.** The `default:` arm calls `schedulePushFullState()` for every non-read-only verb (`:1156`); `PUSH_COALESCE_MS = 40` (`:459`) trailing-edge coalesces it (`:463-471`). The write lands in the DB, the UI updates, and then the fabricated literal is pushed back over the top. **This is why a dead feature can look like it works for exactly one frame.**

#### Correction — the transport is NOT dead, and the earlier statement of this root cause was false

An earlier draft of this feature asserted that `KanbanProvider.postMessage` "has no sink in standalone — neither `_broadcaster` nor `_panel` is set." **That is false**, and was already corrected in the sibling `Standalone Push-Path Parity` feature on 2026-08-07. Verified against the current tree:

- `KanbanProvider.postMessage` (`src/services/KanbanProvider.ts:2161`) pushes to `this._broadcaster` when set.
- `bootstrap.ts:692` constructs a shared `BroadcastHub`; `:758` assigns it to `kanbanProvider` (and five sibling providers at `:704`, `:709`, `:720`, `:802`).
- `bootstrap.ts:1757` calls `kanbanProvider.setApiServer(server)`, which forwards the API server into that hub.
- `BroadcastHub.push` (`src/services/broadcastHub.ts:80-91`) fans out to the WS hub via `mirrorToWs` **regardless of whether a webview is bound**.

**Provider pushes do reach the browser.** The hub's real residual defect is *retention*, not delivery: with `webview: null` and no webview ever attached, every pushed message is also appended to `_pendingWebviewMessages` (`broadcastHub.ts:87`) and never drained — `flushPending` (`:142-146`) no-ops without a bound webview, so the queue grows without bound in a long-running `npx` process. That defect is owned by `restore-backlog-view-to-standalone-host.md`, not by this audit.

**Why this correction is load-bearing.** An auditor who believes pushes never arrive will attribute every stale-UI observation to a missing transport and send someone to fix the wrong thing. The signature of mechanisms 2+3 is specific and different: the value is **correct immediately after the click, reverts to a fixed value ~40 ms later, and survives reload as that fixed value**. Record the observed behaviour; do not infer the cause.

#### Code reading is the weakest evidence, and this feature has already proved it

Every code citation in the first draft of this feature was stale or wrong — `bootstrap.ts:341-346` / `:370-375` (actually `:404-410` / `:433-439`), `:395` (actually `:459`), `:1062-1087` (actually `:1140`), `KanbanProvider.ts:2105-2120` (actually `:2161`, and asserting the opposite of the truth), `:7261-7291` (actually `:7365`). Three incorrect hand-written greps were also produced during the session that authored it. **Reading a code path is never sufficient on its own for a user-facing feature**, and any line citation a section subtask relies on must be re-confirmed against the tree at audit time before it is written into a register note.

### Scope decision: `headless-switchboard.md` is audited as claims but contributes no requirements

The first draft excluded `getting-started/headless-switchboard.md` from auditing entirely, on the grounds that it was "written when standalone was substantially less capable and describes limits that no longer hold." **That characterisation is wrong in both directions.** The page was last revised **2026-08-01** (`5a13705`, "correct headless parity claims") — it is a week old, not ancient. And its error runs the *other* way: it is **over-confident, not stale-restrictive**. It asserts that standalone columns "reflect *your configured* set, not the built-in default" — directly contradicted by `bootstrap.ts:405`/`:434` — and scopes the entire remaining gap to "Automation and the Orchestrator."

It is also the single most claim-dense page in the corpus **about standalone specifically**: launcher flags, the Node 22+ requirement, one-time-token sign-in, `Host`-header rejection, single-writer exclusivity, fail-closed PTY on macOS/Windows only, hash deep links, per-host secret-entry behaviour, the `secrets set/list/delete` CLI, and surface-routed dispatch. Excluding 106 lines of unverified standalone claims from a standalone audit is indefensible.

**Resolution — it is audited, under one special rule:**
- It **is** audited line by line, in the `getting-started` subtask, like every other file.
- It contributes **no requirements**: it may never be cited to justify, excuse or close a gap on any other page, and its own claims are checked against runtime rather than treated as specification.
- It remains the closeout subtask's rewrite target, now rewritten from its own verdicts as well as the register's.

## User Review Required

None.

## Complexity Audit

### Routine
- Creating the register file and its column schema.
- Provisioning a scratch workspace.

### Complex / Risky
- **The two hosts consume two different build artefacts.** `package.json` declares `bin.switchboard` → `./dist/standalone/cli.js`, so `npx switchboard` runs the **built `dist/`**, while "Switchboard: Open in Browser" runs from the **installed VSIX**. Rebuilding one and not the other silently audits half the verdicts against a stale build. Both artefacts must come from the same audited commit, and the register header must record that commit and both artefact identities, or every downstream verdict is unattributable. (Note: this is the one context in which build freshness legitimately matters — the repo's standing "do not audit `dist/` staleness" rule is about code review, not about a runtime audit whose instrument *is* the build.)
- **Representative workspace state.** A scratch workspace with an empty board cannot exercise most claims. It must carry: several plans across multiple columns, at least one feature with subtasks, a custom column, a hidden role, a configured project, a worktree, and integration keys present. A thin workspace silently converts real gaps into untestable rows. Note that mechanism 2 above means a **custom column and a hidden role are mandatory, not optional** — with only default columns the single highest-yield defect in the corpus is invisible.
- **Two browser hosts, genuinely different capabilities.** `npx switchboard` (standalone process, own encrypted secret store, secret fields live) and "Open in Browser" (a second client of the running editor's server, secret entry disabled by design) diverge on more than secrets. The register must record which host each verdict was observed in, and both must be provisioned.
- **Capability gating.** PTY terminals are fail-closed on the optional `node-pty` module, and the docs claim the Terminals entry appears only on macOS and Windows. "Absent because node-pty did not load" is a different finding from "never ported." The harness must run on a host where the capability is present, or every terminal claim is `GATED` and the audit learns nothing.
- **The 40 ms re-assert makes naive observation unreliable.** Any procedure that reads the UI immediately after a click will record fabricated state as real. The settle-and-reload rule belongs in the register header, not only in the `board` subtask, because it applies wherever board-derived state is displayed.

## Edge-Case & Dependency Audit

**Race Conditions** — the coalesced push (`PUSH_COALESCE_MS = 40`) is itself the audit's central race. The register header must bind every section to the settle-and-reload rule so it is not re-derived per subtask.

**Security** — the scratch workspace holds real integration credentials. Record key *presence* only; never paste values into the register. The register is an input to a public doc rewrite in the closeout subtask.

**Side Effects**
- The section audits drive a live host and will create, move and complete plans. The workspace provisioned here must be a scratch workspace, never one with work in progress. This is the single most destructive aspect of the audit and it is this subtask's responsibility to prevent it.
- `npx switchboard` is an exclusive single writer. It refuses to start if the extension already serves the workspace. The two hosts therefore **cannot** be pointed at the same workspace simultaneously — provision either two scratch workspaces, or a documented hand-off procedure, and record which in the header.

**Dependencies & Conflicts**
- Findings will overlap the **Standalone Push-Path Parity** feature (**three** subtasks, not seven — five were merged into the delegation plan on 2026-08-07). The register schema includes a linked-plan column so overlaps are cross-referenced rather than re-planned.

## Dependencies

- **`.switchboard/audits/` does not exist yet** — this subtask creates it. Nothing else in the repo writes there.
- Sequencing: this audit is most efficient after `standalone-state-builders-delegate-to-getfullstatemessages.md` lands, since that plan removes mechanism 2 outright. See the feature file's sequencing section.

## Implementation

### 1. Build and provision both hosts

- Build from current `src` and install **both** artefacts from the same commit:
  - the npm/`dist` build backing `npx switchboard` (`dist/standalone/cli.js`), and
  - the VSIX backing "Switchboard: Open in Browser".
- Record the commit SHA and **both** artefact identities in the register header.
- Provision a **scratch** workspace with the representative state listed above — custom column and hidden role are mandatory.
- Launch both hosts, respecting the single-writer constraint (separate workspaces or a documented hand-off).
- Confirm the PTY layer loaded, so terminal claims are testable rather than `GATED`.

### 2. Create the register

**File:** `.switchboard/audits/standalone-extension-parity.md` (new — create the `audits/` directory)

Header records: commit SHA, both build artefacts, audit date, workspace state summary (with each representative item checked off), both host URLs, and the single-writer arrangement used.

One row per claim:

`ID | Section | File:line | Feature/claim | Host observed | Verdict | Evidence class | Note / linked plan`

Verdicts: `LIVE`, `GAP`, `PARTIAL`, `GATED` (capability-dependent), `BLOCKED` (could not be exercised — not a verdict, must be resolved or escalated), `N/A` (not a testable feature claim).

### 3. Write the evidence rules into the register header

Verbatim, so every section subtask is bound by them. **The register header is the authoritative copy** — where a section plan's restatement differs from the header, the header wins.

- **A — Runtime observed** in a running browser host. **Required** for any `LIVE` verdict on a user-facing feature.
- **B — Passing contract test** naming the behaviour.
- **C — Code path traced end-to-end** including the push path and the UI render. Never sufficient alone for a user-facing feature.
- **Not evidence:** verb reachability, a `{success:true}` response, a landed DB write, or the presence of a handler. All four are structurally false-green in standalone (mechanism 1). Any verdict resting on them is invalid and must be re-done.
- **Settle-and-reload rule:** any claim about state the board displays must be re-observed **after ~1 s and after a page reload** before `LIVE` is recorded. A value that is correct on click and fixed thereafter is mechanism 2+3, not a pass.
- **Attribute observations, not causes.** Record what was seen. Do not write a root cause into a row unless it was independently confirmed against the tree at audit time.
- Every file audited records a **line-coverage figure**; under 100% means the file is not finished.
- **No requirement may be sourced from `getting-started/headless-switchboard.md`** — its own claims are audited in the `getting-started` section, but it may not justify, excuse or close a gap on any other page.
- `BLOCKED` is not a verdict. A section reported as audited with a material share of `BLOCKED` rows is escalated, not accepted.

## Proposed Changes

### `.switchboard/audits/standalone-extension-parity.md` (new)
- **Context:** The shared instrument for the six section subtasks and the closeout gate; `audits/` is a new directory.
- **Logic:** Header with build attribution (both artefacts), workspace-state checklist, single-writer arrangement, and the full evidence-rules block; row schema for claims.
- **Edge Cases:** Build attribution missing → downstream verdicts unattributable. Only one artefact rebuilt → half the verdicts stale. No custom column / hidden role in the workspace → the highest-yield defect class is invisible.

## Verification Plan

1. The register exists at `.switchboard/audits/standalone-extension-parity.md` with the row schema and the full evidence-rules block in its header.
2. The header names one commit SHA and **both** build artefacts, and both were produced from that commit.
3. Both hosts are reachable, their URLs recorded, and the single-writer arrangement is stated.
4. The PTY layer is confirmed loaded.
5. The scratch workspace demonstrably contains each item of representative state — check each off explicitly, including the custom column and the hidden role.
6. Confirm the workspace is scratch, not live work.
7. The header carries the settle-and-reload rule and the `BLOCKED` disposition rule, not only the A/B/C classes.

## Recommendation

Complexity 4 → **Send to Coder.** Mechanically simple, but it sets the conditions every other subtask depends on; a stale build, a single rebuilt artefact, or a thin workspace invalidates the whole feature.
