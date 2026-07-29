# Add a remote-session locality gate to the `/switchboard` entry protocol

## Goal

Stop the `/switchboard` local management console from probing for — and nagging about —
a `LocalApiServer` that is **structurally unreachable** in a remote/cloud session, and
route those sessions to the paths actually built for them.

### Core problem

When `/switchboard` runs inside a remote/cloud execution environment (Claude Code on the
web, a CI runner, a Claude Code Remote container), its §1 "Entry Protocol" still tries to
read `.switchboard/api-server-port.txt` and curl `http://127.0.0.1:<port>/health`. That
API server runs on the **user's local machine** beside VS Code. In a remote session there
is no local machine in the loop, so the probe can never succeed. The single failure branch
in the current protocol is:

> "If the port file is missing, tell the user to open the workspace in VS Code with the
> Switchboard extension active."

In a VM session that advice is a dead end — the user may not even be at that machine, and
opening VS Code there would not expose a `127.0.0.1` port to this container. Every remote
`/switchboard` invocation therefore runs the full local-console motion (directory walk,
port read, health curl, board-state awk) only to terminate in unusable advice.

### Root cause

The entry protocol conflates two independent facts:

1. **Can I reach the API?** — answered by the port file + `/health`.
2. **Is a local machine even in play?** — answered by *execution locality* (local vs
   remote/cloud), which the protocol never checks.

Because locality is never established, the "port file missing" branch has exactly one
response tuned for the local case ("open VS Code") and applies it to the remote case where
it is wrong. The remote-appropriate skills (`/switchboard-remote`, `/switchboard-cloud`)
already exist but are never offered.

### Verified during the improve pass (measured facts — additive, nothing above removed)

These were measured against the repo at HEAD. They **sharpen** the root-cause analysis
above; they do not replace it.

1. **The port file is gitignored.** `.gitignore:52` is `.switchboard/*` with allow-list
   re-includes for `plans/`, `features/`, `reviews/`, `sessions/`, `CLIENT_CONFIG.md`,
   `README.md`, `SWITCHBOARD_PROTOCOL.md` only. `api-server-port.txt` is **not**
   re-included and is **not** tracked (`git ls-files .switchboard/` confirms). A remote
   session working from a fresh clone therefore has **no port file at all**.
2. **Consequence for the cost argument.** With no port file, the current protocol
   short-circuits at the very first `cat` — the `curl /health` and the board-state `awk`
   **never execute** in a remote session today. The measurable waste is one failed `cat`,
   not "the full local-console motion". The load-bearing defect is therefore the
   **advice**, not the probing.
3. **Consequence for detection.** "Port file absent" is already a near-perfect remote
   signal *for the remote direction* — but it is ambiguous, because it is equally the
   local-extension-not-running signal. Ambiguity is the reason the fallback branch, not
   the gate, must carry the fix.
4. **Zero cross-references exist today.** `grep -n "switchboard-remote\|switchboard-cloud"
   .agents/workflows/switchboard.md` returns **nothing**. The console never names its
   sibling front doors anywhere — so the remote branch is introducing those names for the
   first time, not re-pointing an existing mention.
5. **Second `api-server-port.txt` read found, and it correctly needs no gate.** The file
   has two reads: `.agents/workflows/switchboard.md:36` (§1 Entry Protocol — the one this
   plan fixes) and `:320` (§3 Feature Management — an illustrative `curl` snippet inside a
   worked example). §3 is only reachable after §1 has already established liveness, so it
   inherits the gate. This resolves the plan's own open question below; scope stays §1.
6. **The mirror generator is not version-gated.** `generateClaudeMirror` (`src/services/
   ClaudeCodeMirrorService.ts:428`) writes unconditionally on every call — there is no
   "same version → skip" branch. So invoking it against the repo root does regenerate the
   mirror. See the ledger caveat in Proposed Changes.

### Desired behaviour

- **Local session, extension running** → unchanged: probe succeeds, console proceeds.
- **Local session, extension not open** → unchanged: "open VS Code" advice is correct here.
- **Remote/cloud session** → do **not** tell the user to open VS Code; instead offer, in
  one short message: `/switchboard-remote` (Linear/Notion-driven), `/switchboard-cloud`
  (cloud planning mode), or read-only work on the on-disk `.switchboard/plans` and
  `.switchboard/features`. Then stop — never loop back to the probe.

> **Superseded:** "Remote/cloud session → detect locality *before* probing; skip the port
> read and health curl entirely."
> **Reason:** Two problems. (a) The saving is illusory — per Verified Fact 2, the port file
> is gitignored, so a remote session already never reaches the curl or the awk; skipping
> "the probe" saves exactly one failed `cat`. (b) The cost is real and asymmetric: a
> detect-first gate puts an environment heuristic in front of the **local happy path**, so
> a false "remote" verdict makes the console refuse to work on the user's own machine —
> strictly worse than the bug being fixed. `HTTPS_PROXY` pointing at `127.0.0.1` is a
> normal local configuration (mitmproxy / Charles / Proxyman / corporate MDM proxies), and
> the plan's own marker expression treats it as evidence of remoteness.
> **Replaced with:** **Probe-first, locality-informed messaging.** Locality may only ever
> *shape the message on an already-failed probe* — it may never gate the happy path. One
> narrow exception: when the agent's own runtime context *explicitly states* it is a
> managed remote/cloud execution environment (a fact the agent holds with certainty, not a
> sniffed marker), it may skip straight to the Remote fallback. Everything else probes
> first. Because the failure branch is made remote-safe on its own, correctness never
> depends on detection firing.

*(The three outcome requirements above — never advise "open VS Code" to a remote session,
offer the three remote options, and stop without looping — are unchanged. Only the
ordering/gating mechanism was superseded.)*

## Metadata

- **Complexity:** 4
- **Tags:** docs, bugfix, reliability
- **Type:** Workflow / skill-prompt change (no runtime code path)
- (Project intentionally unpinned — no project named in the request and no PROJECT PIN
  directive supplied; leave unassigned for board reassignment.)

> **Superseded:** `**Complexity:** 3`
> **Reason:** 3 routes to "Send to Intern". The prose edit is genuinely a 2–3, but the
> change is not done until `.claude/skills/switchboard/SKILL.md` is regenerated **by the
> generator** and `mirror:check` is green. Hand-editing that mirror file is the exact
> documented failure mode (`scripts/check-claude-mirror.js` exists to catch it), and the
> correct regeneration procedure has a non-obvious ledger-churn trap (Proposed Changes,
> step 2). One well-scoped moderate risk on top of an otherwise routine edit = 4.
> **Replaced with:** `**Complexity:** 4` → Send to Coder.

## User Review Required

- **None.** Every open decision in the original draft is now resolved in-plan: detection
  strategy is decided (probe-first, dual-branch fallback, definitive-context-only skip);
  scope is decided (§1 only — Verified Fact 5); migration is decided (none needed).

## Complexity Audit

### Routine

- The substantive change is prose inside one markdown file,
  `.agents/workflows/switchboard.md`, §1 (lines 25–58; the branch to rewrite is line 45).
- The local happy path (Command A liveness → Command B awk → snapshot → menu) is untouched.
- No runtime code, no persisted state, no settings, no DB, no migration.
- Both landing targets (`switchboard-remote.md`, `switchboard-cloud.md`) already exist and
  need no edits.

### Complex / Risky

- **The mirror must be machine-regenerated, never hand-edited.** `.claude/skills/
  switchboard/SKILL.md` is generated output guarded by `npm run mirror:check` in CI.
- **Naive regeneration dirties tracked files the plan did not intend to touch.** Both
  `.claude/settings.json` and `.claude/.switchboard-generated.json` are git-tracked, and
  `generateClaudeMirror` rewrites both. The ledger embeds `generatedAt: new
  Date().toISOString()` (`ClaudeCodeMirrorService.ts:528`), so it produces a diff on
  **every** run, unconditionally.
- **Prompt-behaviour changes are not covered by any automated test.** `mirror:check` proves
  *parity*, never *behaviour* — see the goal-vs-appearance risk in Adversarial Synthesis.
- **Detection markers are unverified for the actual target hosts** — see Uncertain
  Assumptions.

## Edge-Case & Dependency Audit

**Race Conditions**
- None inherent to the edit. One benign ordering case: the extension regenerates the
  mirror on activation, so if VS Code activates against this repo between the source edit
  and the deliberate regeneration, the mirror is already correct and the explicit regen is
  a no-op on `skills/` (it still re-stamps the ledger timestamp).

**Security**
- The remote fallback must not leak a path that pretends to reach the local machine. Do not
  suggest SSH tunnels, port-forwards, or "try a different port" — the message names only
  the three sanctioned options and stops.
- Locality detection must remain read-only: no writes, no network calls, no attempt to
  enumerate the host environment beyond the cheap marker read.

**Side Effects**
- Regenerating the mirror re-stamps `.claude/.switchboard-generated.json` (`generatedAt`,
  `version`) and rewrites `.claude/settings.json` through
  `mergePermissionsAllowList` (`ClaudeCodeMirrorService.ts:555`), which normalises
  `$schema`, `permissions.allow`, and `permissions.deny`. Neither file is diffed by
  `mirror:check` (it compares `.claude/skills/` only), so this churn is cosmetic — but it
  will appear in `git status` unless the temp-root procedure in Proposed Changes is used.
- The mirror strips the source's frontmatter and rebuilds it from the manifest entry
  (`buildSkillMd`, `ClaudeCodeMirrorService.ts:404`). The `description:` line in
  `.agents/workflows/switchboard.md` therefore propagates; the body must not gain its own
  `---` frontmatter block.

**Dependencies & Conflicts**
- Manifest entry `ClaudeCodeMirrorService.ts:52` (`source: 'workflows/switchboard.md'` →
  `name: 'switchboard'`, `allowedTools: 'Bash'`) — must not change.
- Antigravity discovers `.agents/workflows/*.md` from the filesystem; Claude Code discovers
  only what `MIRROR_MANIFEST` lists. Editing the shared source keeps **both** hosts in step
  — this is precisely why the source, not the mirror, is the edit target.
- No conflict with any in-flight plan: `grep` finds no other plan touching
  `.agents/workflows/switchboard.md` §1.

## Dependencies

- None. No upstream session or plan must land first; no `sess_*` dependency.

## Adversarial Synthesis

**Risk summary.** The dominant risk is not the edit but the *shape* of the gate: an
environment-sniffing check placed in front of the probe can misfire and lock a local user
out of their own console, and a gate that never fires in the real remote hosts leaves the
bug intact while every success signal reads green. Mitigations: (1) locality may only
re-order advice on an already-failed probe, never gate the happy path; (2) the fallback
branch is made remote-safe on its own so correctness does not depend on detection firing;
(3) the mirror is regenerated via the generator into a temp root and only
`.claude/skills/switchboard/SKILL.md` is copied back, so `mirror:check` passes without
ledger/settings churn polluting the diff.

## Proposed Changes

### ⚠️ Source-of-truth & mirror constraints (read before editing)

`.claude/` is **NOT** the source of truth. It is a generated mirror. Editing
`.claude/skills/switchboard/SKILL.md` directly is the exact "skill fixes don't stick" bug
that `scripts/check-claude-mirror.js` was written to backstop — CI will fail on drift.

Authoritative topology (verified in this repo):

| Role | Path |
| :--- | :--- |
| **Source of truth (EDIT THIS)** | `.agents/workflows/switchboard.md` — §1 "Entry Protocol" (lines 25–58) |
| Manifest mapping source→skill | `src/services/ClaudeCodeMirrorService.ts:52` (`source: 'workflows/switchboard.md'` → `name: 'switchboard'`) |
| **Generated mirror (DO NOT hand-edit)** | `.claude/skills/switchboard/SKILL.md` |
| Drift guard (CI) | `scripts/check-claude-mirror.js` → `npm run mirror:check` |
| Packaging origin | VSIX ships repo-root `.agents/` (`.vscodeignore` must keep `!.agents/**`) |

Mirror mechanics (from `ClaudeCodeMirrorService.ts` header): `.agents/` is the single
source of truth; only `SKILL.md` is copied into each `.claude/skills/<name>/`; the mirror
is regenerated on **extension activation** (or by calling `generateClaudeMirror(root,
version)` directly). There is **no standalone npm "regen" script** — `mirror:check` only
*diffs*, it does not write.

### Landing targets (reference only — no edit required)

The remote branch should point at existing workflows, not reinvent them:

- `.agents/workflows/switchboard-remote.md` — remote control via Linear/Notion.
  Frontmatter description: *"Remote Switchboard control — drive plans via Linear or Notion
  when the local machine is off."*
- `.agents/workflows/switchboard-cloud.md` — cloud-VM planning brake. Frontmatter
  description: *"Cloud-VM planning mode — plan first, do not auto-code in a remote VM."*

### `.agents/workflows/switchboard.md` — §1 Entry Protocol (the only substantive edit)

**Context.** §1 spans lines 25–58. Command A (lines 34–44) resolves `$ROOT`, reads
`.switchboard/api-server-port.txt`, and curls `/health`. Line 45–46 is the single failure
branch: *"If the port file is missing, tell the user to open the workspace in VS Code with
the Switchboard extension active. Do not fall back to direct DB access."* Lines 47–56 are
the `health.roots` cross-check and the `terminals` liveness handling; lines 59–70 are
Command B. `/switchboard-remote` and `/switchboard-cloud` are named nowhere in the file
(Verified Fact 4).

**Logic.** Three branches replace one:

| # | Condition | Behaviour |
| :- | :--- | :--- |
| 1 | Runtime context **explicitly states** a managed remote/cloud execution environment | Skip Command A entirely → **Remote fallback** → stop |
| 2 | Probe succeeds (port file present **and** `/health` returns ok) | Unchanged local console — Command B, snapshot, menu |
| 3 | Probe fails (port file absent, or curl fails) | **Dual-branch fallback** → stop, never retry |

Branch 3 is the correctness backstop: it is remote-safe *without* any detection. Marker
hints may only choose which half of branch 3's message leads.

**Implementation.**

1. **Insert a `0.` step immediately after the §1 heading (line 25), before the "Two
   commands, then report" paragraph (line 27).** Wording to the effect of:

   > **0. Locality check (one line, no network).** Before Command A, answer: *does my own
   > runtime context state that I am running in a managed remote/cloud execution
   > environment (Claude Code on the web, a Claude Code Remote container, a CI runner)?*
   > - **Yes, stated explicitly** → skip Command A and Command B; go to the **Remote
   >   fallback** below and stop. Do not read `api-server-port.txt`, do not curl
   >   `/health`, do not advise opening VS Code.
   > - **No, or unstated** → proceed to Command A as normal. Never guess "remote" from a
   >   sniffed marker alone — a wrong "remote" verdict locks a local user out of their own
   >   console. Marker hints are used only to order the message in the fallback below.

2. **Replace line 45–46** (`- If the port file is missing, tell the user to open the
   workspace in VS Code…`) with the dual-branch fallback. Both halves always appear; the
   marker hint only decides which leads:

   > - **If the port file is missing, or `/health` does not answer** — the API is not
   >   reachable from here. Present **both** possibilities in one short message, then
   >   **stop** (do not retry, do not fall back to direct DB access):
   >   - *On the machine running VS Code?* Open this workspace in VS Code with the
   >     Switchboard extension active, then re-run `/switchboard`.
   >   - *In a remote or cloud session?* The API server lives on the user's local machine
   >     and cannot be reached from here. Use **`/switchboard-remote`** to drive plans via
   >     Linear or Notion, **`/switchboard-cloud`** to plan without auto-coding in a VM, or
   >     work read-only against the on-disk `.switchboard/plans/` and
   >     `.switchboard/features/`.
   >   - **Ordering hint (optional, never a gate):** if the environment looks remote, lead
   >     with the remote options; otherwise lead with the VS Code line. A single cheap
   >     read is enough — e.g. `[ -d /root/.ccr ] || [ -n "${CLAUDE_CODE_REMOTE:-}" ]`.
   >     Getting the order wrong costs the user one line of reading; it must never remove
   >     either option.

3. **Do not touch** lines 47–56 (the `health.roots` cross-check and `terminals` handling),
   lines 59–70 (Command B), §1.2 (the snapshot format, lines 80–137), or the §3 snippet at
   line 320. Keep the change to prompt text only; do not alter the two-command board-state
   flow for the local happy path.

**Edge Cases.**
- Port file present but the extension has since died → curl fails → branch 3. The dual
  message covers it correctly (the "open VS Code" half is the right lead).
- Port file present but `$ROOT` is absent from `health.roots` → **unchanged** existing
  behaviour (warn and stop, lines 47–48). Do not route that into the new fallback.
- Marker read fails or is unavailable → treat as "no hint": present branch 3 with the VS
  Code half leading. Never error out on the hint.
- Branch 1 must not fire on a *local* session that merely happens to sit behind a proxy.
  The trigger is an explicit statement in the agent's own context, not a marker.

### `.claude/skills/switchboard/SKILL.md` — regenerate, never hand-edit

**Context.** Generated from the source above by `generateClaudeMirror`. `git`-tracked, and
diffed against a fresh regeneration by `npm run mirror:check`.

**Implementation — use the temp-root procedure** (mirrors what
`scripts/check-claude-mirror.js` does, and is the reason the plan's original "run
generateClaudeMirror on the repo root" step needed correcting):

```bash
npm run compile-tests   # produces out/services/ClaudeCodeMirrorService.js
node -e '
  const fs=require("fs"), os=require("os"), path=require("path");
  const {generateClaudeMirror}=require("./out/services/ClaudeCodeMirrorService.js");
  const v=require("./package.json").version;
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"sb-mirror-"));
  fs.cpSync(".agents", path.join(tmp,".agents"), {recursive:true});
  const r=generateClaudeMirror(tmp, v);
  if(r.status==="failed") throw new Error(r.reason);
  fs.copyFileSync(
    path.join(tmp,".claude","skills","switchboard","SKILL.md"),
    ".claude/skills/switchboard/SKILL.md");
  console.log("regenerated:", r.status, r.skillsWritten);
'
npm run mirror:check    # must print ✅
```

> **Superseded:** "Regenerate the mirror from source — run extension activation against the
> repo, or invoke `generateClaudeMirror(<repoRoot>, <version>)`."
> **Reason:** Calling it on the repo root also rewrites two other **git-tracked** files:
> `.claude/settings.json` (via `mergePermissionsAllowList`, `ClaudeCodeMirrorService.ts:555`
> — it normalises `$schema`/`allow`/`deny` and rewrites the whole file) and
> `.claude/.switchboard-generated.json`, whose `generatedAt: new Date().toISOString()`
> stamp (`:528`) guarantees a diff on **every** invocation. That directly contradicts this
> plan's own verification step ("no other `.claude` file touched"), which would fail as
> written through no fault of the implementer.
> **Replaced with:** Regenerate into a temp root and copy back only
> `.claude/skills/switchboard/SKILL.md` (script above). `mirror:check` compares
> `.claude/skills/` only, so this satisfies the guard with a clean two-file diff.

**Edge Cases.**
- If `mirror:check` reports drift in a *different* skill, that drift predates this change —
  regenerate that file separately and say so in the commit message. Do not silently absorb
  unrelated mirror drift into this change.

### Commit

Commit `.agents/workflows/switchboard.md` and `.claude/skills/switchboard/SKILL.md`
together so the tree stays parity-clean. Per this repo's convention, work on `main`; do not
create a branch unless asked.

### No migration needed

Per CLAUDE.md's "Users & migrations" rule, this changes instruction/prompt text, not any
persisted user state, file, or setting. No `*.migrated.bak`, no compat shim. (Noted
explicitly so a reviewer doesn't flag it.) Confirmed in code: nothing reads or persists the
§1 text — the mirror is regenerated wholesale from source on every activation.

## Verification Plan

### Automated Tests

- **No new automated test.** There is no harness that executes skill prose, and inventing
  one for a three-branch prompt edit is not warranted. The behavioural checks below are
  manual by necessity — recorded honestly rather than papered over with a green parity
  metric (see Adversarial Synthesis).
- **Existing guard the implementer runs:** `npm run compile-tests && npm run mirror:check`
  → expect `✅ mirror:check — .claude/skills matches generateClaudeMirror(.agents)`. This
  is the objective proof the mirror was regenerated, not hand-edited.
- *Not executed during this improve pass* — this session was directed to skip compilation
  and automated tests. Both are implementer steps.

### Manual verification

1. **Parity guard** — as above; must be green before commit.
2. **Remote path:** in a remote/cloud session, run `/switchboard`. Confirm it does **not**
   advise opening VS Code, does **not** retry, and offers exactly the three remote options
   (`/switchboard-remote`, `/switchboard-cloud`, read-only plans/features). This is the
   one check that proves the change works; a green `mirror:check` does not.
3. **Local happy path (regression):** local checkout, extension running → the two-command
   entry snapshot (liveness + terminals line + board counts + menu) renders unchanged.
   **This is the check that catches a mis-scoped gate** — if branch 1 or the marker hint
   ever intercepts this path, it fails here.
4. **Local-but-closed path (regression):** local checkout, extension not open → the "open
   VS Code" advice still appears **and leads**, with the remote options present below it.
5. **Diff hygiene:** `git status` shows exactly two modified files —
   `.agents/workflows/switchboard.md` and `.claude/skills/switchboard/SKILL.md`. No
   `.claude/settings.json`, no `.claude/.switchboard-generated.json`.

> **Superseded:** Verification step 5's original form, *"`git diff` shows changes in
> `.agents/workflows/switchboard.md` and the regenerated `.claude/skills/switchboard/
> SKILL.md` only — no other `.claude` file touched."*
> **Reason:** Correct as an *intent*, but unachievable via the regeneration procedure the
> plan originally specified (see the mirror section above) — the ledger timestamp changes
> on every run. The intent is kept; the procedure that makes it achievable was added.
> **Replaced with:** Same assertion, now backed by the temp-root regeneration script.

6. **Both hosts still resolve the skill:** confirm `/switchboard` is offered in Claude Code
   (via `MIRROR_MANIFEST`) and that Antigravity still sees
   `.agents/workflows/switchboard.md` by filename. The frontmatter `description:` line must
   survive the edit — the mirror rebuilds frontmatter from it.

## Uncertain Assumptions

The user was advised to run web research to confirm these **before implementation**; the
ready-to-run research prompt was supplied in chat.

1. **Whether `/root/.ccr`, `$CLAUDE_CODE_REMOTE`, and an `HTTPS_PROXY` pointing at
   `127.0.0.1` actually exist in the target remote hosts.** Measured directly in this local
   macOS session: all three are **absent** (`/root` does not exist; `CLAUDE_CODE_REMOTE`,
   `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` all unset) — so the plan's marker expression at
   least does not false-positive here. Their *presence* inside a Claude Code Remote
   container, Claude Code on the web, or a third-party CI runner is **unverified**. This is
   why the design demotes markers to an ordering hint.
2. **Whether Claude Code on the web / Claude Code Remote expose a documented, stable
   environment marker at all** — and if so, its name. If one exists, it should replace the
   `/root/.ccr` guess in the ordering hint.
3. **How commonly a local developer environment sets `HTTPS_PROXY` to a `127.0.0.1`
   address** (mitmproxy, Charles, Proxyman, corporate MDM proxies). This is the stated
   false-positive risk that justified superseding the detect-first gate. The design is
   already safe if the risk is low, so this only affects how emphatically the plan should
   warn against promoting the hint to a gate later.

## Risks & open questions

- **Detection canonicality (still open, now de-risked).** `/root/.ccr` is reported reliable
  for Claude Code Remote, but Claude Code on the web or a third-party CI runner may expose
  different markers. The original draft framed this as a choice between (a) trusting
  environment context with markers as a secondary hint, and (b) treating "port file absent"
  as the trigger and merely reordering the advice.
  > **Superseded:** "Recommend (a) with (b) as documented fallback."
  > **Reason:** (a)-as-primary puts an unverified heuristic in front of the local happy
  > path, and Verified Fact 1 shows (b) has no meaningful cost — the port file is
  > gitignored, so a remote session never reaches the curl anyway.
  > **Replaced with:** **(b) is the primary mechanism; (a) is narrowed to two roles** — an
  > explicit runtime-context statement may skip the probe (branch 1), and marker reads may
  > only order the branch-3 message. Whatever research answers about markers, the fix
  > still works.
- **Scope check — RESOLVED.** The port-probe dead-end lives only in §1. `grep` finds a
  second `api-server-port.txt` read at line 320, but it is an illustrative snippet inside
  §3 Feature Management, reachable only after §1 established liveness — it inherits the
  gate and needs no edit. AGENTS.md's "MANDATORY PRE-FLIGHT CHECK" governs *workflow-command
  matching*, not the API probe, and needs no gate. Scope stays §1.
- **Other console skills.** `grep -rl api-server-port.txt .agents/` shows the probe pattern
  in `.agents/skills/_lib/sb_api_call.sh` and in the feature/kanban skills
  (`create-feature`, `improve-feature`, `kanban_operations/*.js`, `rearrange-feature`,
  `switchboard-orchestration`). Those are **API clients invoked after** a console session
  is established, not entry points, so they are correctly out of scope. If a *second entry
  point* with the same dead-end is later found, apply the identical dual-branch fallback
  there.

---

**Recommendation: Send to Coder** (complexity 4).

## Completion Report

Implemented remote-session locality check and dual-branch fallback messaging for `/switchboard` entry protocol. Added Step 0 locality check and updated port/health failure branch in `.agents/workflows/switchboard.md`. Regenerated generated mirror `.claude/skills/switchboard/SKILL.md` via temp-root script and validated parity using `node scripts/check-claude-mirror.js` (`mirror:check`). Files changed: `.agents/workflows/switchboard.md` and `.claude/skills/switchboard/SKILL.md`. No issues encountered.

---

## Code Review Pass — 2026-07-30

Verification was **executed**, not static-only: no `SKIP TESTS:` / `SKIP COMPILATION:` line
was present in the review dispatch. (The plan's own "*Not executed during this improve
pass*" note under Automated Tests was a record of the improve session, not a directive to
this pass — it was correctly overridden.)

### Findings

| Sev | Location | Finding |
| :-- | :--- | :--- |
| **CRITICAL** | `.agents/workflows/switchboard.md:33` (pre-fix) | Step 0's branch-1 target, "**Remote fallback** below", was a **dangling reference** — `grep -n "Remote fallback"` returned exactly one hit: the reference itself. No block in the file carried that label. The only fallback-shaped block below was the dual-branch bullet whose *first* line is "*On the machine running VS Code?* Open this workspace in VS Code…". A branch-1 (remote) agent resolving the nearest match would therefore **lead with the "open VS Code" advice** — the precise sentence this plan exists to eliminate (Desired behaviour, plan line 76). The plan's logic table (lines 251–253) specifies two distinct message shapes — "Remote fallback" (branch 1) and "Dual-branch fallback" (branch 3); only the latter was implemented. |
| **MAJOR** | `.agents/workflows/switchboard.md:32` (pre-fix) vs `:8` | Branch 1's trigger list named **"a CI runner"**, contradicting the skill's own unchanged persona paragraph 25 lines above: *"You are a Switchboard project manager operating from another UI (a terminal agent, a browser board, **a CI runner**)."* One document asserted both "a CI runner is a supported console host" and "a CI runner must skip the console entirely". This is the *same* false-remote-verdict failure the plan guarded against for sniffed markers (superseded block, plan lines 81–97: "*a false 'remote' verdict makes the console refuse to work on the user's own machine — strictly worse than the bug being fixed*"), arriving instead through branch 1's example list. |
| **MAJOR** | `.agents/workflows/switchboard.md:52` (pre-fix) | The ordering-hint example `[ -d /root/.ccr ] \|\| [ -n "${CLAUDE_CODE_REMOTE:-}" ]` emits **zero stdout and exits 1** on the common local path (verified: `/root` absent, var unset on this host). It surfaces to the agent as a failed command carrying no information, with no way to distinguish "local" from "the read broke" — violating the plan's own edge case at line 303: "*Marker read fails or is unavailable → treat as 'no hint' … **Never error out on the hint**.*" Reached most often on the local-but-closed path (Manual verification step 4). |
| NIT | `.agents/workflows/switchboard.md:32–34, 49–52` (pre-fix) | Four inserted lines ran 397/241/262/340 chars in a file that wraps prose at ~90. Cosmetic; markdown renders identically. |
| NIT | commit `4d335c3` | **Report-only, not fixable.** This plan's two-file change was swept into the auto-commit for a *different* plan ("Headless Feature Management — Hardening") alongside 19 unrelated files, contrary to the plan's Commit section (line 355). The contribution is not independently revertable. Correcting this would require history rewriting, which the review's git policy forbids. Parity is nonetheless clean, so there is no functional consequence. |

### Verified correct (no action)

- **Temp-root regeneration procedure was followed exactly.** `4d335c3` modified
  `.claude/skills/switchboard/SKILL.md` and **not** `.claude/settings.json`, **not**
  `.claude/.switchboard-generated.json` — the ledger/settings churn trap the improve pass
  flagged was avoided. Verification step 5's hygiene assertion holds.
- **Scope discipline exact.** Two hunks only. Lines 53–59 (`health.roots` cross-check,
  `terminals` handling), Command B, §1.2 snapshot format, and the §3 snippet are untouched,
  as required by Implementation step 3.
- **Frontmatter `description:` survived and propagated** — present at `SKILL.md:3`; mirror
  rebuilt `name`/`description`/`allowed-tools` from `MIRROR_MANIFEST` as designed.
- **Branch 1 skipping Command B is correct** (checked, not assumed): `.gitignore`'s
  `.switchboard/*` allow-list does **not** re-include `kanban-state-*.md`, so those files
  are absent from a remote clone. Conversely `plans/` and `features/` **are** tracked — the
  read-only offer in the Remote fallback is real.
- **Both landing targets exist** in source and mirror: `switchboard-remote.md`,
  `switchboard-cloud.md` (+ their `.claude/skills/*/SKILL.md`).

### Gate-wiring audit

The plan's `### Automated Tests` subsection names one check: `npm run compile-tests &&
npm run mirror:check`.

- `mirror:check` — defined `package.json` (`node scripts/check-claude-mirror.js`);
  **invoked by CI** at `.github/workflows/integration-tests.yml:43–44` ("Claude mirror
  drift check"). ✅ Genuinely gated, not merely defined.
- `compile-tests` — defined `package.json` (`tsc -p tsconfig.test.json`); **invoked by CI**
  at `integration-tests.yml:28–29`. ✅ Gated.
- No "green while incomplete" hole for this plan's named checks. (Unrelated pre-existing
  note: `test:contract:verb-engine` and `test:contract:verb-engine-planning` remain
  deliberately unwired at `integration-tests.yml:67–76`, documented as red-for-predating
  causes; out of scope here.)

### Fixes applied

1. **CRITICAL fix** — `.agents/workflows/switchboard.md:63,65`: labelled the two halves
   `**Local fallback**` and `**Remote fallback**`, giving Step 0's reference a real anchor.
   `:36–39` now states branch 1 presents the Remote fallback bullet "**on its own**, without
   the Local fallback line". `:69` cross-links back. `grep` now returns a reference *and* an
   anchor.
2. **MAJOR fix** — `:40–42`: removed "a CI runner" from branch 1's trigger list (now
   "Claude Code on the web, a Claude Code Remote container" + "with no local machine in the
   loop") and stated explicitly that a CI runner or browser board answers "no", probes
   first, and lands on the remote-safe fallback if the probe fails. Coverage is not lost —
   the plan's stated design is that "correctness never depends on detection firing".
3. **MAJOR fix** — `:73–78`: ordering-hint example is now
   `{ [ -d /root/.ccr ] || [ -n "${CLAUDE_CODE_REMOTE:-}" ]; } && echo remote-hint || echo local-hint`,
   which prints a verdict and exits 0 either way, plus an explicit "no output, or anything
   other than `remote-hint`, means no hint" rule.
4. **NIT fix** — all edited lines rewrapped to the file's ~90-column convention.

### Validation results

| Check | Result |
| :--- | :--- |
| `npm run compile-tests` | ✅ clean (tsc, no output) |
| `npm run mirror:check` | ✅ `.claude/skills matches generateClaudeMirror(.agents)` — 46 files, v1.7.13 |
| Mirror regeneration (temp-root script, plan lines 317–333) | ✅ `regenerated: generated 46`; only `.claude/skills/switchboard/SKILL.md` copied back |
| Diff hygiene (Manual verification 5) | ✅ `git status` = exactly 2 modified files — `.agents/workflows/switchboard.md`, `.claude/skills/switchboard/SKILL.md`. No `.claude/settings.json`, no `.claude/.switchboard-generated.json` |
| Ordering-hint snippet, local host | ✅ prints `local-hint`, exit 0 |
| Ordering-hint snippet, `CLAUDE_CODE_REMOTE=1` | ✅ prints `remote-hint`, exit 0 |
| Cross-reference resolution | ✅ `Remote fallback` = 1 reference + 1 anchor; mirror carries both |
| Marker absence on this host (plan Uncertain Assumption 1) | ✅ re-confirmed: `/root` absent, `CLAUDE_CODE_REMOTE` unset — no local false-positive |

### Remaining risks

1. **Manual verification steps 2, 3, 4, 6 are unrun and unrunnable here** — they require a
   real remote/cloud session, a live extension, and an Antigravity host. This is inherent to
   the change (plan: "*There is no harness that executes skill prose*"), not a review gap.
   Step 3 (local happy-path regression) is the one that would catch a mis-scoped gate; the
   diff shows the happy path untouched, but that is static evidence, not execution.
2. **Prompt-behaviour is still unverified by any automated gate.** `mirror:check` proves
   parity, never behaviour — the goal-vs-appearance risk the plan's Adversarial Synthesis
   names. Green CI on this change means "the mirror is not stale", nothing more.
3. **Uncertain Assumptions 1–3 remain open** (whether `/root/.ccr` or
   `$CLAUDE_CODE_REMOTE` exist in the real target hosts). Unchanged by this pass, and by
   design non-load-bearing: they now feed only an ordering hint whose failure mode is one
   line of reading. Do **not** promote the hint to a gate without answering them.
4. **`4d335c3` commit-hygiene damage is permanent** (NIT above) — history rewriting is
   forbidden. Future passes should expect this plan's source change to appear under an
   unrelated commit subject.

### Review completion

Reviewed the implementation against the plan, found one CRITICAL dangling cross-reference
that would have re-emitted the exact "open VS Code" advice to remote sessions the plan set
out to remove, plus two MAJOR issues (a CI-runner self-contradiction against the skill's own
persona paragraph, and an ordering-hint command that exits non-zero with no output on the
common local path). All three were fixed in `.agents/workflows/switchboard.md`, the mirror
was regenerated with the plan's temp-root procedure, and `compile-tests` + `mirror:check`
are green with a clean two-file diff. Files changed by this pass:
`.agents/workflows/switchboard.md` and `.claude/skills/switchboard/SKILL.md`. The
implementer's temp-root regeneration, scope discipline, and frontmatter handling were all
correct and needed no changes; the only unfixable item is that the original change landed
inside another plan's auto-commit.

