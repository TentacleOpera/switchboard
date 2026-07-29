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

### Desired behaviour

- **Local session, extension running** → unchanged: probe succeeds, console proceeds.
- **Local session, extension not open** → unchanged: "open VS Code" advice is correct here.
- **Remote/cloud session** → detect locality *before* probing; skip the port read and
  health curl entirely; do **not** tell the user to open VS Code; instead offer, in one
  short message: `/switchboard-remote` (Linear/Notion-driven), `/switchboard-cloud`
  (cloud planning mode), or read-only work on the on-disk `.switchboard/plans` and
  `.switchboard/features`. Then stop — never loop back to the probe.

## Metadata

- **Complexity:** 3
- **Type:** Workflow / skill-prompt change (no runtime code path)
- (Project intentionally unpinned — no project named in the request and no PROJECT PIN
  directive supplied; leave unassigned for board reassignment.)

## ⚠️ Source-of-truth & mirror constraints (read before editing)

`.claude/` is **NOT** the source of truth. It is a generated mirror. Editing
`.claude/skills/switchboard/SKILL.md` directly is the exact "skill fixes don't stick" bug
that `scripts/check-claude-mirror.js` was written to backstop — CI will fail on drift.

Authoritative topology (verified in this repo):

| Role | Path |
| :--- | :--- |
| **Source of truth (EDIT THIS)** | `.agents/workflows/switchboard.md` — §1 "Entry Protocol" |
| Manifest mapping source→skill | `src/services/ClaudeCodeMirrorService.ts` (~line 52: `source: 'workflows/switchboard.md'` → `name: 'switchboard'`) |
| **Generated mirror (DO NOT hand-edit)** | `.claude/skills/switchboard/SKILL.md` |
| Drift guard (CI) | `scripts/check-claude-mirror.js` → `npm run mirror:check` |
| Packaging origin | VSIX ships repo-root `.agents/` (`.vscodeignore` must keep `!.agents/**`) |

Mirror mechanics (from `ClaudeCodeMirrorService.ts` header): `.agents/` is the single
source of truth; only `SKILL.md` is copied into each `.claude/skills/<name>/`; the mirror
is regenerated on **extension activation** (or by calling `generateClaudeMirror(root,
version)` directly). There is **no standalone npm "regen" script** — `mirror:check` only
*diffs*, it does not write.

## Landing targets (reference only — no edit required)

The remote branch should point at existing workflows, not reinvent them:

- `.agents/workflows/switchboard-remote.md` — remote control via Linear/Notion.
- `.agents/workflows/switchboard-cloud.md` — cloud-VM planning brake.

## Implementation steps

1. **Edit the source only** — `.agents/workflows/switchboard.md`, §1 "Entry Protocol":
   - Prepend a **step 0 — Locality gate**: establish local vs remote *before* any probe.
     If remote, do not read `api-server-port.txt`, do not curl `/health`, do not advise
     "open VS Code"; jump to the Remote fallback and stop.
   - Rewrite the existing "If the port file is missing …" line into **two branches**:
     (a) remote → Remote fallback (offer `/switchboard-remote`, `/switchboard-cloud`, or
     read-only file work); (b) local → keep the current "open VS Code" advice.
   - Keep the change to prompt text only; do not alter the two-command board-state flow
     for the local happy path.

2. **Regenerate the mirror** from source — run extension activation against the repo, or
   invoke `generateClaudeMirror(<repoRoot>, <version>)` (from the compiled
   `out/services/ClaudeCodeMirrorService.js`). Confirm `.claude/skills/switchboard/SKILL.md`
   now reflects the new §1.

3. **Commit both** the edited `.agents/workflows/switchboard.md` and the regenerated
   `.claude/skills/switchboard/SKILL.md` together, so the tree stays parity-clean.

4. **No migration needed** — per CLAUDE.md's "Users & migrations" rule, this changes
   instruction/prompt text, not any persisted user state, file, or setting. No
   `*.migrated.bak`, no compat shim. (Noted explicitly so a reviewer doesn't flag it.)

## Detection design (for step 1's locality gate)

Layered, host-agnostic, most-reliable-first:

1. **Environment context** — the agent's own runtime context already states "managed
   remote execution environment" (repo cloned fresh, outbound via agent proxy). Trust it.
2. **Filesystem markers** — a cheap one-shot check, e.g.
   `[ -d /root/.ccr ] || [ -n "${CLAUDE_CODE_REMOTE:-}" ] || { [ -n "$HTTPS_PROXY" ] && echo "$HTTPS_PROXY" | grep -q 127.0.0.1; }`
   (all three fire in the current CCR container).
3. **Fallback** — if locality is genuinely undetectable, keep the port file authoritative:
   present succeeded → proceed; absent → lead with the Remote fallback but still mention
   the local "open VS Code" case, rather than assuming one.

## Verification plan

1. **Parity guard passes:** `npm run compile-tests && npm run mirror:check` →
   `✅ mirror:check — .claude/skills matches generateClaudeMirror(.agents)`. This is the
   objective proof the mirror was regenerated, not hand-edited.
2. **Remote path (this environment):** re-run `/switchboard`; confirm it does **not** read
   `api-server-port.txt`, does **not** curl `/health`, does **not** advise opening VS Code,
   and instead offers the three remote options and stops.
3. **Local happy path (regression):** in a local checkout with the extension running,
   confirm the two-command entry snapshot (liveness + board counts + menu) still renders
   unchanged.
4. **Local-but-closed path (regression):** local checkout, extension not open → confirm
   the "open VS Code" advice still appears (that branch must survive).
5. **No stray hand-edit:** `git diff` shows changes in `.agents/workflows/switchboard.md`
   and the regenerated `.claude/skills/switchboard/SKILL.md` only — no other `.claude`
   file touched.

## Risks & open questions

- **Detection canonicality:** `/root/.ccr` is reliable for Claude Code Remote, but Claude
  Code on the web or a third-party CI runner may expose different markers. Decide whether
  to (a) rely primarily on the agent's environment context with filesystem markers as a
  secondary hint, or (b) treat "port file absent" as the trigger and merely *reorder* the
  advice (remote-first). Option (a) is cleaner but host-specific; (b) is host-agnostic but
  keeps a probe. Recommend (a) with (b) as documented fallback (as above).
- **Scope check:** the port-probe dead-end appears to live only in §1 of the switchboard
  workflow. AGENTS.md's "MANDATORY PRE-FLIGHT CHECK" governs *workflow-command matching*,
  not the API probe, so it should not need the gate — confirm during implementation and
  widen scope only if a second copy of the probe is found.
- **Other console skills:** if the same local-only probe pattern is later found in another
  `.agents/workflows/*.md` or `.agents/skills/*`, apply the identical gate there; out of
  scope for this plan unless discovered.
