# Add a File-Based Agent→Orchestrator Request Channel and Session Log

## Goal

Add the one genuinely new mechanic in this feature: an asynchronous, file-based channel for coding/review agents to raise questions, warnings, and research requests to the orchestrator, plus an append-only **session log** the orchestrator writes its triage summaries to. This is what lets the orchestrator sleep between wakes and still coordinate a fleet — agents drop requests to files; the orchestrator drains them on wake.

### Problem / background / root cause

The orchestrator is system-woken and does not hold the fleet in-context, so it cannot receive synchronous messages from the agents it dispatched. Coding and (especially) review agents legitimately need to surface things mid-run — a warning, an ambiguous requirement, "I need to run research first." There is no inter-terminal messaging primitive in the local extension (the Antigravity `send_message` is not reachable here), and synchronous REPL scraping is fragile. A **file inbox** sidesteps all of that: writing a file is trivial for any agent, survives the orchestrator being asleep, and is inspectable by the human. A **session log** gives the run an auditable narrative and a place for the orchestrator to record what it did and what it escalated.

**The worktree trap (root-cause detail found during plan review).** Fleet agents run inside per-feature/per-subtask worktrees, which are **siblings of the repo, never inside it**: auto mode creates them at `path.dirname(workspaceRoot)/worktrees/<repoBasename>/<branch>`, explicit control-plane mode at `<controlPlaneRoot>/worktrees/<branch>` (`src/services/KanbanProvider.ts:10045-10047`, `git worktree add` at `:10058-10064`). Each worktree checkout contains its **own committed `.switchboard/` skeleton** (`plans/`, `features/` are git-whitelisted), so a naïve relative write to `.switchboard/orchestrator/inbox/` from a worktree cwd lands in the worktree's copy — invisible to the orchestrator, and (because `.switchboard/*` is gitignored) it would never reach main through a merge either. Worse, the standard skill discovery walk-up (`sb_api_call.sh:59-71` walks `$PWD` upward for `.switchboard/api-server-port.txt`) **fails from an auto-mode worktree**, because the walk from `~/…/worktrees/<repo>/<branch>` never passes through the main checkout. The codebase already acknowledges exactly this: the Phone-a-Friend directive interpolates the port at prompt-build time "so worktree CWDs don't need to read the port file (which lives only in the main workspace root's .switchboard/)" (`src/services/agentPromptBuilder.ts:478-484`). The request skill must therefore resolve the **primary workspace root** itself — via git, which every worktree can answer authoritatively — rather than trusting `$PWD`.

## Metadata
**Complexity:** 4
**Tags:** backend, feature, cli
**Project:** Switchboard

## User Review Required

None. Two calls that could have been escalated were decided instead:
- **Request-file format:** Markdown with YAML frontmatter (not JSON) — decided, rationale in Proposed Changes.
- **Gitignore posture:** both inbox and session log stay **local-only** (already covered by the existing `.switchboard/*` ignore rule; zero gitignore changes) — decided, rationale in Proposed Changes.

## Complexity Audit

### Routine
- Authoring `SKILL.md` for `.agents/skills/orchestrator_request/` — follows the existing directory-skill pattern (`kanban_operations/SKILL.md`, `group-into-features/SKILL.md`: YAML `description` frontmatter + usage doc).
- One-line `MIRROR_MANIFEST` entry in `src/services/ClaudeCodeMirrorService.ts` (array at `:46`; directory-source precedent `skills/kanban_operations` at `:86`, model-invocable precedent `skills/group-into-features` at `:92`).
- Skills-table rows in `AGENTS.md` (table at `:92` area) and the root `CLAUDE.md` copy of that table.
- Session-log format spec (documentation only — the writers are subtasks 2 and 5).
- Directory bootstrap (`mkdir -p`) and unique-filename generation in the script.

### Complex / Risky
- **Primary-workspace-root resolution from inside a worktree.** The `$PWD` walk-up used by every existing skill (`sb_api_call.sh:59-71`, `move-card.js findApiPort`) does not work from auto-mode worktrees. The script needs the git-based resolution chain specified below, and getting the fallback order wrong silently drops requests into the wrong `.switchboard`.
- **Atomic visibility of request files.** The orchestrator's drain (subtask 5) must never read a half-written file; the write must be tmp-file + `mv` (rename) into the inbox.
- **Cross-subtask contract stability.** Subtasks 2, 4, and 5 all reference the paths, field names, and processed/ rule fixed here; renaming anything later ripples across three plans.

## Edge-Case & Dependency Audit

**Race Conditions**
- **Concurrent writers:** multiple agents filing requests in the same second. Mitigated by filename scheme `req-<UTC>-<stage>-<pid>-<random>.md` — timestamp + `$$` + `$RANDOM` makes collision effectively impossible; never a single shared file the agents append to.
- **Writer vs. drainer:** the orchestrator wakes mid-write. Mitigated by writing to `inbox/.req-….tmp` (dotfile) then `mv` to the final name — rename is atomic on the same filesystem, and the drain ignores dotfiles/`*.tmp`.
- **Interrupted drain:** a wake killed mid-drain must be re-runnable. The processed move is per-file `mv` into `inbox/processed/`; re-running skips already-moved files. (The drain itself is subtask 5; this plan fixes the convention that makes it idempotent.)
- **Session-log interleaving:** only the orchestrator writes the session log (single writer by convention — fleet agents use the inbox, never the log), so no append lock is needed.

**Security**
- The script writes only under `<primaryRoot>/.switchboard/orchestrator/` — it must refuse any resolved root whose `.switchboard` marker is absent rather than `mkdir -p` at an arbitrary walk-up hit.
- Field values are flattened to single lines before being written into frontmatter (strip `\n`/`\r`), so a malicious/clumsy `--body` cannot forge extra frontmatter keys; the free-form body goes below the closing `---` where nothing is parsed.
- No network, no LocalApiServer, no secrets — pure local file write, dependency-free per the VSIX rule (packaged extension ships no node_modules; the script is plain bash + git, same class as `.agents/skills/_lib/sb_api_call.sh`).

**Side Effects**
- Creates `.switchboard/orchestrator/inbox/processed/` on first use in the primary workspace. Both are already gitignored by the existing `.switchboard/*` rule (`.gitignore:49`, managed block written by `src/services/WorkspaceExcludeService.ts:6-7`), so `git status` stays clean — no user-visible repo churn.
- The `.claude/skills/orchestrator-request/` mirror is regenerated by `ClaudeCodeMirrorService`; per its invariant #2 (file header `:17-21`), **only `SKILL.md` is copied** — `request.sh` is not, so the SKILL.md body must reference the script by its workspace-root-relative `.agents/skills/orchestrator_request/request.sh` path (the `.agents/` tree is always scaffolded alongside `.claude/`).
- A worktree checkout also contains the committed `.agents/skills/orchestrator_request/` copy — that is fine and intended: the worktree's copy of the script still resolves and targets the **primary** root.

**Dependencies & Conflicts**
- **Consumed by** subtask 5 (wake/triage drains `inbox/`, moves to `processed/`, appends session-log summaries) and subtask 2 (persona doc references both paths). Their plans already cite `.switchboard/orchestrator/inbox/`, `processed/`, and `.switchboard/orchestrator/session-log.md` — the paths chosen here match them exactly.
- **Advertised by** subtask 4: kickoff dispatch prompts must tell coder/reviewer agents the skill exists (mirroring the Phone-a-Friend build-time-interpolation pattern at `agentPromptBuilder.ts:483`, the prompt should also pass the primary root explicitly via `--root`).
- **Independent of** subtask 1 (mode foundation) — nothing here touches `autobanState.ts` or the UI.
- No conflict with `ClaudeCodeMirrorService` regeneration: manifest-tracked dirs are overwritten on version change, which is the desired behavior for a generated mirror.

## Dependencies

None (no `sess_` sessions apply).

Sibling ordering: independent of subtask 1; must land **before or alongside** subtasks 2 and 5, which consume the inbox/session-log convention fixed here; subtask 4's dispatch prompts advertise the skill and should pass `--root`.

## Adversarial Synthesis

The single real failure mode is silent misdelivery: a coder in a sibling worktree writing its request into the worktree's own committed `.switchboard/` skeleton, where the sleeping orchestrator will never look and git will never carry it (the path is ignored). The script's git-based root resolution plus a marker check (refuse roots without `.switchboard`) closes this, and tmp-file+rename closes the half-read race with the drain. Everything else is low-risk documentation and a one-line manifest entry — but the field/path contract must be treated as frozen once subtasks 2/4/5 build against it.

## Proposed Changes

### 1. `.switchboard/orchestrator/` — inbox + session-log convention (no code; normative spec lives in the SKILL.md below)

**Context.** One file per request, uniquely named so concurrent writers never collide. Fields: `from` (agent/terminal/worktree), `stage` (planner|coder|reviewer), `type` (question|warning|research|blocked), `planId`/`feature`, `body`, and optional `worktreePath`. Processed requests move to `inbox/processed/` so a wake never reprocesses them — mirrors the seen-set discipline used elsewhere for at-least-once handling. Sibling plans (subtasks 2 and 5) already reference these exact paths.

**Logic.**
- **Layout:**
  - `.switchboard/orchestrator/inbox/` — pending requests, one file each.
  - `.switchboard/orchestrator/inbox/processed/` — handled requests (moved, never deleted, so the human can audit).
  - `.switchboard/orchestrator/session-log.md` — append-only orchestrator narrative.
- **Request file format — DECIDED: Markdown with YAML frontmatter** (`.md`), not JSON. Rationale: the two readers are an LLM orchestrator and a human — both read markdown natively; the free-form `body` needs no escaping when it lives below the frontmatter (multi-line JSON strings from bash are an escaping minefield); and it matches every other artifact convention in this repo (plans, features, SKILL.md all use frontmatter + body).
- **Request schema:**

  ```markdown
  ---
  from: coder-terminal (merge-prompt-button)
  stage: coder            # planner | coder | reviewer
  type: question          # question | warning | research | blocked
  planId: a1b2c3d4-…      # optional — the plan the request concerns
  feature: Orchestration Automation Mode   # optional — feature topic
  worktreePath: /Users/me/Documents/GitHub/worktrees/switchboard/merge-prompt-button   # optional
  created: 2026-07-07T03:15:00Z
  ---

  The plan says the config key is `feature_worktree_mode` but the code reads
  `featureWorktreeMode` — which is authoritative? Blocked on subtask 2 until answered.
  ```

  All frontmatter values are single-line (the writer strips newlines); the body below `---` is free-form markdown and is never parsed for fields.
- **Filename scheme — DECIDED:** `req-<UTC compact timestamp>-<stage>-<pid>-<random>.md`, e.g. `req-20260707T031500Z-coder-8842-19073.md`. Sortable by arrival time, stage visible at a glance, `$$`+`$RANDOM` guarantees uniqueness across concurrent writers. `planId` stays in frontmatter (UUIDs are too long for filenames).
- **Gitignore posture — DECIDED: both inbox and session log are local-only.** Verified: `git check-ignore` shows `.switchboard/orchestrator/**` is already ignored by the managed `.switchboard/*` rule (`.gitignore:49`; block owned by `WorkspaceExcludeService.ts:6-7`), and `orchestrator/` is deliberately **not** added to the whitelist (`!.switchboard/plans/` etc.). Rationale: (a) this is machine-local runtime state, same class as `kanban.db` which the managed block explicitly never commits; (b) an unattended orchestrator committing session-log churn to main would pollute the auto-commit-before-review flow and invite merge conflicts with feature branches merging back; (c) delivery from worktrees is solved by writing to the primary root, not by committing. The original "do not gitignore blindly" concern is resolved: the decision is explicit, documented in the SKILL.md, and requires **zero** gitignore changes. (A future opt-in to whitelist `!.switchboard/orchestrator/session-log.md` via `WorkspaceExcludeService` is possible but out of scope.)

**Implementation.** No files are created in `.switchboard/` by this subtask at rest — directories are bootstrapped on first use: `request.sh` runs `mkdir -p …/inbox/processed` before writing (don't assume they exist); the orchestrator's first session-log append creates the log. The normative spec text lives in `SKILL.md` (below) and is referenced by subtask 2's persona doc.

**Edge Cases.** Directory bootstrap on first use; unique filenames per request (never a shared append file); idempotent drain via per-file `mv` to `processed/` (safe to re-run if a wake is interrupted mid-drain); drain ignores dotfiles, `*.tmp`, and the `processed/` subdirectory itself.

### 2. `.agents/skills/orchestrator_request/SKILL.md` (new)

**Context.** A `SKILL.md` + a small shell script that writes a well-formed request file into the inbox — pure file write, **no LocalApiServer dependency**, so it works even if the API port file isn't found (which is precisely the situation inside an auto-mode worktree). The API-call alternative was considered and rejected: the whole point of the channel is to work while the extension route is unavailable or irrelevant, and Phone-a-Friend already demonstrates that worktree CWDs can't do port-file discovery (`agentPromptBuilder.ts:478-484`).

**Logic.** Follow the directory-skill convention (`kanban_operations/SKILL.md`, `group-into-features/SKILL.md`): YAML frontmatter with a model-discoverable `description`, then usage. Content:
- Frontmatter: `name: Orchestrator Request`, `description: File a question, warning, research request, or blocker to the sleeping Switchboard orchestrator by writing a request file into the orchestration inbox — use when blocked or when something needs the orchestrator's attention mid-run; not for routine progress.`
- **When to use** — a real blocker/question/research need, **not routine progress**; the orchestrator judges progress from git/board ground truth, so status updates via inbox are noise. Document the field contract (table of the frontmatter fields above).
- **How to invoke:**

  ```bash
  bash .agents/skills/orchestrator_request/request.sh \
    --stage coder --type question \
    --from "coder-terminal (merge-prompt-button)" \
    --plan-id "a1b2c3d4-…" --feature "Orchestration Automation Mode" \
    --root "/Users/me/Documents/GitHub/switchboard" \
    "The plan says X but the code does Y — which is authoritative?"
  ```

  `--root` is optional but **recommended when the dispatch prompt supplies it** (subtask 4 interpolates the primary root at prompt-build time, mirroring Phone-a-Friend's Option A). Without `--root`, the script self-resolves (below).
- **Normative convention spec** — the inbox layout, request schema, filename scheme, `processed/` rule, single-writer session-log rule, and gitignore posture from section 1. This SKILL.md is the convention's home; subtask 2's persona doc points here rather than duplicating it.
- **Worktree note** (one line, per the established worktree-messaging discipline): "Works from inside any worktree — the script locates the primary workspace automatically; pass `--root` if your prompt provided it."

**Implementation.** New directory `.agents/skills/orchestrator_request/` with `SKILL.md` + `request.sh`. Remember mirror invariant #2 (`ClaudeCodeMirrorService.ts:17-21`): only `SKILL.md` is mirrored into `.claude/skills/orchestrator-request/`, so every script reference inside it uses the workspace-root-relative `.agents/skills/orchestrator_request/request.sh` path.

**Edge Cases.** The mirrored copy runs in hosts where `bash` invocation needs the Bash tool allowed — handled by `allowedTools: 'Bash'` in the manifest entry (section 4). Register in `CLAUDE.md`/`AGENTS.md` skills table and the mirror manifest so it surfaces in `.claude/` (sections 4-5).

### 3. `.agents/skills/orchestrator_request/request.sh` (new)

**Context.** The dependency-free writer. Plain bash + git + coreutils only — the packaged VSIX ships no node_modules, and this must run in any agent terminal, in any worktree, with the extension present or absent.

**Logic — primary-root resolution (the load-bearing part), in order:**
1. **`--root <path>`** if given: require `<path>/.switchboard` to exist, else exit 1 with a JSON error on stderr (never `mkdir` a `.switchboard` at an arbitrary path).
2. **`$PWD` walk-up for a runtime marker**: walk parents looking for a directory containing `.switchboard/workspace-id` **or** `.switchboard/api-server-port.txt` (same loop shape as `sb_api_call.sh:59-71`, but testing runtime markers instead of only the port file). These markers are gitignored and written only by the running extension into real workspace roots (`TaskViewerProvider.ts:1135-1143` writes the port file to all workspace-folder roots; `:1321` lists both as the safe files), so a worktree's **committed** `.switchboard/` skeleton can never satisfy this test. This branch succeeds when running in the main checkout, or in an explicit-control-plane worktree (`<controlPlaneRoot>/worktrees/<branch>` walks up into `<controlPlaneRoot>`).
3. **Git main-checkout resolution** (the auto-mode worktree case): `MAIN=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')` — git documents that the main working tree is always listed first, and this works from inside any linked worktree. Then repeat the marker walk-up starting **from `$MAIN`** (inclusive, walking up — covers explicit control-plane layouts where `.switchboard` lives above the repo). If no marker is found anywhere but `$MAIN/.switchboard` exists (extension never ran — committed skeleton only), use `$MAIN`.
4. **Fail loudly**: JSON error to stderr + exit 1 ("could not locate the primary Switchboard workspace; pass --root"). No silent fallback to `$PWD`.

**Implementation sketch:**

```bash
#!/bin/bash
# request.sh — file a request to the Switchboard orchestrator inbox.
# Pure file write: bash + git + coreutils only. No LocalApiServer dependency.
set -euo pipefail

FROM="" STAGE="" TYPE="" PLAN_ID="" FEATURE="" WORKTREE="" ROOT="" BODY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2;;
    --stage) STAGE="$2"; shift 2;;
    --type) TYPE="$2"; shift 2;;
    --plan-id) PLAN_ID="$2"; shift 2;;
    --feature) FEATURE="$2"; shift 2;;
    --worktree) WORKTREE="$2"; shift 2;;
    --root) ROOT="$2"; shift 2;;
    *) BODY="$1"; shift;;                       # last positional = body
  esac
done
case "$STAGE" in planner|coder|reviewer) ;; *) echo '{"error":"--stage must be planner|coder|reviewer"}' >&2; exit 1;; esac
case "$TYPE" in question|warning|research|blocked) ;; *) echo '{"error":"--type must be question|warning|research|blocked"}' >&2; exit 1;; esac
[ -n "$BODY" ] || { echo '{"error":"request body is required"}' >&2; exit 1; }

flat() { printf '%s' "$1" | tr '\n\r' '  '; }     # frontmatter values stay single-line

has_marker() { [ -f "$1/.switchboard/workspace-id" ] || [ -f "$1/.switchboard/api-server-port.txt" ]; }
walk_up() {  # echo first ancestor (inclusive) with a runtime marker
  local cur="$1"
  while [ "$cur" != "/" ] && [ -n "$cur" ]; do
    if has_marker "$cur"; then echo "$cur"; return 0; fi
    cur=$(dirname "$cur")
  done
  return 1
}

if [ -n "$ROOT" ]; then
  [ -d "$ROOT/.switchboard" ] || { echo '{"error":"--root has no .switchboard directory"}' >&2; exit 1; }
else
  ROOT=$(walk_up "$PWD" || true)
  if [ -z "$ROOT" ]; then
    MAIN=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}' || true)
    if [ -n "$MAIN" ]; then
      ROOT=$(walk_up "$MAIN" || true)
      [ -z "$ROOT" ] && [ -d "$MAIN/.switchboard" ] && ROOT="$MAIN"
    fi
  fi
  [ -n "$ROOT" ] || { echo '{"error":"could not locate the primary Switchboard workspace; pass --root <path>"}' >&2; exit 1; }
fi

# Auto-detect worktree path when not supplied and we are in a linked worktree.
if [ -z "$WORKTREE" ]; then
  TOP=$(git rev-parse --show-toplevel 2>/dev/null || true)
  [ -n "$TOP" ] && [ "$TOP" != "$ROOT" ] && WORKTREE="$TOP"
fi

INBOX="$ROOT/.switchboard/orchestrator/inbox"
mkdir -p "$INBOX/processed"

TS=$(date -u +%Y%m%dT%H%M%SZ)
NAME="req-${TS}-${STAGE}-$$-${RANDOM}.md"
TMP="$INBOX/.${NAME}.tmp"
{
  echo '---'
  echo "from: $(flat "${FROM:-unknown}")"
  echo "stage: $STAGE"
  echo "type: $TYPE"
  [ -n "$PLAN_ID" ]  && echo "planId: $(flat "$PLAN_ID")"
  [ -n "$FEATURE" ]  && echo "feature: $(flat "$FEATURE")"
  [ -n "$WORKTREE" ] && echo "worktreePath: $(flat "$WORKTREE")"
  echo "created: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo '---'
  echo
  printf '%s\n' "$BODY"
} > "$TMP"
mv "$TMP" "$INBOX/$NAME"                          # atomic rename: drain never sees a partial file
echo "{\"ok\":true,\"file\":\"$INBOX/$NAME\"}"
```

**Edge Cases.**
- Running outside any git repo with no `--root` and no marker in ancestry → clear JSON error, exit 1 (matches the `sb_api_call.sh:73-76` error style).
- A worktree that was itself opened as a VS Code workspace (so the extension wrote a port file into it) will be found by the `$PWD` walk-up as "the" root — acceptable: in that scenario the worktree genuinely is a workspace root with its own board, and the human opted into that topology.
- `--stage`/`--type` are validated against the enums; unknown values fail fast rather than producing an unroutable request.
- Body containing `---` or YAML-ish text is harmless — it lives below the frontmatter and is never parsed for fields.
- BSD (macOS) vs GNU `date`: only portable format strings are used.

### 4. `src/services/ClaudeCodeMirrorService.ts` — MIRROR_MANIFEST entry

**Context.** New skill must be added on the source side (`.agents/skills/`) **plus** a manifest entry, or it never mirrors into `.claude/skills/` for Claude Code hosts. Manifest array at `:46`; `MirrorEntry` shape at `:27-38` (`source`, `name` kebab-case, `invocation`, optional `allowedTools`).

**Logic.** The skill must be **model-invocable** — a blocked coder decides to file a request by itself; requiring an explicit `/slash` from an unattended agent would defeat the channel. Precedent: `group-into-features` is a directory-source, model-invocable procedure skill (`{ source: 'skills/group-into-features', name: 'group-into-features', invocation: 'default', allowedTools: 'Bash' }` at `:92`). The write is harmless (one file into a gitignored inbox), so `default` (slash + model-auto) is safe.

**Implementation.** Add under the "Model-invocable procedure skills" group:

```ts
{ source: 'skills/orchestrator_request', name: 'orchestrator-request', invocation: 'default', allowedTools: 'Bash' },
```

**Edge Cases.** Directory source ⇒ only its `SKILL.md` is copied (invariant #2, `:17-21`) — already handled by the SKILL.md referencing `request.sh` via the `.agents/…` workspace-root-relative path. Name is kebab-case per invariant #3.

### 5. `AGENTS.md` + root `CLAUDE.md` — skills-table rows

**Context.** `AGENTS.md` is the bundled control-plane source (`ControlPlaneMigrationService.ts:99` `BUNDLED_AGENTS_FILE = 'AGENTS.md'`); the skills table is at `AGENTS.md:~92`. The repo-root `CLAUDE.md` carries a synchronized copy of the same table. Per the control-plane rule: edit `.agents/` + `AGENTS.md` as source; never hand-edit generated `.claude/skills/`.

**Logic / Implementation.** Add one row to each table:

```markdown
| `orchestrator_request` | File a question, warning, research request, or blocker to the sleeping orchestrator by writing an inbox request file — for fleet agents mid-run, not routine progress |
```

**Edge Cases.** None — additive table row; no trigger-word or workflow-registry change (this is a skill, not a workflow).

### 6. Session log — `.switchboard/orchestrator/session-log.md` (format spec; writers are subtasks 2 & 5)

**Context.** Append-only markdown. The orchestrator writes a dated triage summary each wake: what it read, what it verified from git, what it advanced/dispatched/merged, and what it escalated to the human. Human-readable is the priority (this is the "what happened overnight" record).

**Logic — entry format (normative, documented in SKILL.md):**

```markdown
## Wake — 2026-07-07T03:15Z

**Inbox:** 2 drained (req-20260707T031002Z-coder-8842-19073.md, req-20260707T031440Z-reviewer-9911-2214.md)
**Verified:** feature "Merge Prompt" — 3/3 subtask branches ahead of integration; feature "Tickets Editor" — no commits yet
**Actions:** advanced a1b2c3 to CODE REVIEWED; dispatched research agent for req-…-coder-…
**Escalations:** planner-stage question in req-…-reviewer-… — needs human answer
```

Rules: one `## Wake — <UTC>` heading per wake; entries only ever appended (never rewritten); a one-time `# Orchestrator Session Log` H1 is written when the file is first created; **single writer** — only the orchestrator appends (fleet agents use the inbox); escalations must appear under the `**Escalations:**` field so a human can grep one token for everything needing attention.

**Implementation.** Documentation only in this subtask (in SKILL.md §convention); subtask 5 implements the append, subtask 2 encodes the discipline in the persona.

**Edge Cases.** File absent on first wake → `cat >>` semantics create it; log grows unboundedly → acceptable for now (append-only history is the point; rotation is a non-goal and can be a later follow-on).

## Verification Plan

Manual/behavioral verification only (per session directive — no compile runs, no automated test suites executed):

1. **Happy path from the main checkout:** in the repo root, run `bash .agents/skills/orchestrator_request/request.sh --stage coder --type question --from "manual-test" "Does this land?"` → expect `{"ok":true,"file":…}` and a `req-*-coder-*.md` file in `.switchboard/orchestrator/inbox/` with valid single-line frontmatter (all required fields) and the body below `---`; `inbox/processed/` exists.
2. **Worktree path (the critical case):** create a scratch worktree the way the extension does (`git worktree add -b sb-test ../worktrees/switchboard/sb-test` from the repo root), `cd` into it, run the script **without** `--root` → the request file must appear in the **main** checkout's `.switchboard/orchestrator/inbox/`, NOT in the worktree's `.switchboard/`. Confirm `worktreePath:` was auto-filled with the worktree path. Remove the worktree afterwards.
3. **Explicit `--root`:** run from an unrelated directory (e.g. `$HOME`) with `--root` pointing at the repo → file lands correctly; run with a bogus `--root /tmp/nowhere` → JSON error, exit 1, nothing written.
4. **Failure honesty:** run from a directory that is neither in a git repo nor under a workspace (e.g. `/tmp`) with no `--root` → clear JSON error advising `--root`, exit 1.
5. **Concurrency:** fire 10 invocations in parallel (`for i in $(seq 10); do … & done; wait`) → 10 distinct files, zero collisions, all parseable (concurrent invocations produce distinct files).
6. **Validation:** `--stage manager` and `--type status` are rejected; empty body is rejected.
7. **Git cleanliness:** after tests 1-5, `git status` in the main checkout shows no `.switchboard/orchestrator` entries (confirms the local-only gitignore posture) — then clean up the test request files.
8. **Simulated drain (convention check for subtask 5):** manually `mv` the pending files into `inbox/processed/` and confirm a "second drain" (listing non-dot, non-tmp `*.md` directly in `inbox/`) sees nothing — moving/marking processed is safe to re-run.
9. **Session-log convention:** append two `## Wake — …` entries by hand following the spec and confirm they render as ordered, well-formed markdown (session-log appends are well-formed and ordered).
10. **Mirror + registry:** after the `MIRROR_MANIFEST` entry lands, trigger the mirror regeneration (extension activation on version change) and confirm `.claude/skills/orchestrator-request/SKILL.md` appears with `allowed-tools: Bash` and that its script reference resolves via `.agents/…`; confirm the new rows render in the `AGENTS.md`/`CLAUDE.md` skills tables.

### Automated Tests (deferred per session directive)

Would cover: root-resolution matrix (main checkout / auto-mode worktree / explicit-control-plane worktree / no-repo failure), filename uniqueness under parallel invocation, frontmatter single-line flattening, enum validation, and tmp-then-rename atomicity (no `.tmp` visible post-exit). Not run as part of this plan.

## Out of scope

- The orchestrator's *consumption* of the inbox and its triage decisions (subtask 5) — this subtask provides the channel and log; subtask 5 acts on them.
- Dispatch-prompt wiring that advertises the skill to fleet agents (subtask 4) and the persona doc that encodes the read side (subtask 2).
- Session-log rotation/pruning and any opt-in committing of the session log (would be a `WorkspaceExcludeService` whitelist follow-on).

## Research Findings Applied (2026-07-07)

External-mechanism research (run per the review's advisory) confirmed the load-bearing externals; these findings are now binding on the implementation:

- **Tier-3 root resolution confirmed.** `git worktree list --porcelain` guarantees the main working tree is the first entry (documented behavior since git 2.7.0). Two refinements the script must honor: a **bare** main entry is annotated `bare` (no `.switchboard/` there — treat as resolution failure and fall through to the marker walk-up), and entries can be marked `prunable` when a volume is missing — parse the first entry only, ignore the rest.
- **Atomicity confirmed, one addition.** `rename`/`mv` is atomic on APFS **same-volume only** — the tmp file must be created inside `.switchboard/orchestrator/` itself (not `$TMPDIR`, which can be another volume), and the script should `sync`/flush before the rename so a crash can't publish an empty file.
- **Filename scheme validated.** The unique-name + rename-to-inbox + move-to-`processed/` design is the Maildir `tmp/new/cur` pattern under other names (research confirms it as the standard lockless at-least-once file-queue). Adopt one Maildir hygiene rule: periodically sweep stale `*.tmp` files (a crashed writer's leftovers) — the orchestrator can do this during drain.
- **Do not build anything on sub-millisecond mtime.** APFS stores nanoseconds but the common APIs truncate to ms; ordering within the inbox comes from the sortable timestamp in the *filename*, never from stat times.

## Uncertain Assumptions

- **Explicit control-plane mode marker location:** it is inferred (from `TaskViewerProvider._getWorkspaceRoots` returning VS Code workspace folders and `KanbanProvider.ts:10045-10047`'s worktree placement) that in explicit mode the runtime markers (`workspace-id`, `api-server-port.txt`) live at the control-plane root above the repo, not inside each repo. The resolution chain covers **both** placements (walk-up is inclusive from the repo root upward), so the design does not depend on which is true — but the exact layout was not traced end-to-end. This is an internal code-trace item (web research does not answer it); confirm during implementation.

Recommendation: **Send to Coder** (complexity 4).

**Stage Complete:** PLAN REVIEWED
