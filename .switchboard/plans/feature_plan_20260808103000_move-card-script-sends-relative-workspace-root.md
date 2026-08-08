# move-card.js Sends a Caller-Relative Workspace Root Across a Process Boundary, So Its Documented Two-Argument Form Silently Targets the Wrong Database

## Goal

Make `move-card.js` resolve its workspace root to an absolute path before sending it to the extension, so the documented invocation `move-card.js <plan> <column>` moves the card in the workspace the caller is standing in rather than in whichever workspace the extension host happens to consider primary.

### Problem

`move-card.js` is the sanctioned manual path for moving a card, and its own skill documentation shows the two-argument form:

```bash
node .agents/skills/kanban_operations/move-card.js .switchboard/plans/my-plan.md CODER_CODED
```

Run exactly that from a multi-root setup and it fails with `Column update failed` — an error that reads as a refused transition. It is not. The card is never found, because the move is executed against a different workspace's database.

Observed 2026-08-08 in this repo: moving a plan that demonstrably exists (`plan_id 65ef46d3-…`, 1 row in `GitHub/switchboard/.switchboard/kanban.db`, **0 rows** in `Gitlab/.switchboard/kanban.db`) failed from the repo root with the two-argument form.

### Root cause

`move-card.js:25` defaults the root to a **relative** path and sends it verbatim over HTTP:

```js
const workspaceRoot = process.argv[5] || '.';   // :25
...
body: { …, workspaceRoot, … }                    // :100
```

`'.'` is meaningful only in the process that produced it. The receiving extension host resolves it against **its own** cwd — the IDE's process directory, not the caller's shell. `_handleKanbanMove` treats the non-empty `'.'` as an explicit caller-supplied root (`LocalApiServer.ts:1335`, `body?.workspaceRoot || this._options.workspaceRoot`), so the `'.'` wins over the extension's own root and resolves to something that is nobody's workspace.

The script already resolves the *plan file* locally and successfully — it gets far enough to attempt the move — which is what makes the failure look like a server-side refusal rather than an addressing bug.

Confirmed by an A/B/C test against the live server, targeting a card's existing column so nothing changed:

| `workspaceRoot` sent | Result |
|---|---|
| omitted | `{"success":false,"error":"Column update failed"}` |
| `"."` (what the script sends) | `{"success":false,"error":"Column update failed"}` |
| `"/Users/…/GitHub/switchboard"` | `{"success":true}` |

### Why "make it absolute" is not sufficient (added by improve pass, 2026-08-08)

`path.resolve('.')` **is** `process.cwd()`. Making the sent path absolute resolves the *caller's current directory*, not the *workspace root*. Those coincide only when the caller happens to be standing exactly at the root.

The stated goal above is that the move lands "in the workspace the caller is standing in". An agent that runs the script from `src/services/` sends an absolute path that is nobody's workspace and fails identically — while satisfying the "paths crossing a process boundary are absolute" rule. The correct resolution is **root discovery**: walk up from the caller's directory to the nearest real workspace root, which is the same upward-walk mechanism `findApiPort` (`move-card.js:38-52`) already implements for the port file and simply does not apply to the root itself.

**The discriminator matters more than the walk.** Verified on this machine, 2026-08-08:

- `~/.switchboard` **exists** — the global config directory (`.master-key`, `secrets.enc`, `integration-config.json`). Not a workspace.
- `~/Documents/.switchboard` **exists** — legacy scaffold dated March 2026. Not a workspace.
- Neither contains `kanban.db` or `api-server-port.txt`.
- Nested roots are real: `GitHub/patrickwork/.switchboard` and `GitHub/patrickwork/get_kanban_state/.switchboard` both exist.

A walk keyed on the presence of a `.switchboard` **directory** therefore never terminates empty — it lands on `~/Documents` or `~` and treats the user's home directory as a workspace. `KanbanDatabase.isValidWorkspaceRoot` (`KanbanDatabase.ts:1274-1300`) will accept it: it checks only that the path exists and is a directory. The walk must key on `.switchboard/kanban.db` (or `.switchboard/api-server-port.txt`) and must hard-stop at `$HOME`.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, cli, reliability, backend

> **Superseded:** **Complexity:** 2 — "one line plus a consistency sweep".
> **Reason:** The corrected approach is not one line. It introduces a new shared module, edits eight scripts whose `workspaceRoot` sits at five different `argv` indices, adds a home-directory trap guard and a fail-loud path, and ships to an agent-facing surface on an extension with ~4,000 installs. The mechanics are individually routine, but the false-root hazard is a genuine correctness trap and the blast radius is every automation caller.
> **Replaced with:** **Complexity:** 5 (Mixed — majority routine mechanics, one well-scoped correctness risk).

> **Superseded:** **Tags:** backend, kanban, skills, bugfix
> **Reason:** `kanban` and `skills` are not in the allowed tag vocabulary; invented tags are dropped on import.
> **Replaced with:** **Tags:** bugfix, cli, reliability, backend

*(No `**Project:**` line: no project was named and no PROJECT PIN directive was supplied. Project pinning is creation-time only in any case — this plan is already imported, so a pin added here would not reassign it.)*

## User Review Required

None.

## Complexity Audit

### Routine

- Applying one shared resolver call at each script's own `workspaceRoot` definition.
- The `try/catch require` degradation shim — three lines, mechanical, identical in every script.

### Complex / Risky

- **The upward walk must not accept `$HOME` or a bare `.switchboard` directory.** `~/.switchboard` (global config, holds the master key and encrypted secrets) and `~/Documents/.switchboard` (legacy scaffold) both exist on real machines. Key the walk on `.switchboard/kanban.db` — never on directory presence — and stop the walk at `$HOME`. Getting this wrong converts an addressing bug into "the board is reading my secrets directory".
- **`findApiPort` already compensates for this and must not regress.** Line 86 reads `findApiPort(workspaceRoot) || findApiPort(process.cwd())` — the `|| process.cwd()` fallback exists precisely because `workspaceRoot` may be useless. Resolving the root properly makes the first call succeed more often; leave the fallback in place regardless, since a caller may legitimately pass a root whose port file is missing.
- **The direct-DB fallback path uses the same variable** (`KanbanDatabase.forWorkspace(workspaceRoot)`, line 125). It is currently fed the same broken `'.'`, so this fix corrects the recovery path at the same time — but it means the change must be made at the variable definition, not at the HTTP call site only.
- **Do not "fix" this server-side by ignoring `'.'`.** Special-casing a magic string in `_handleKanbanMove` would paper over a client bug and leave every other caller free to send relative paths. The boundary rule is that a path crossing a process boundary is absolute; enforce it at the sender.
  - *Clarification (improve pass):* this correctly rejects **magic-string special-casing**, but it does not rebut **server-side containment resolution** (mapping any incoming path to the registered root that contains it), which is a legitimate and complementary fix tracked separately as `kanban-move-silently-defaults-to-first-root`. The client-side fix is required regardless of whether that lands, because the offline direct-DB path has no server to ask.
- **Eight scripts, five different `argv` indices.** There is no single mechanical substitution; each edit is deliberate. See the index table in Proposed Changes.
- **Partial `.agents/` sync on shipped installs.** A new shared helper file that some installs receive later than the eight edited scripts would `MODULE_NOT_FOUND` all of them at once. The `try/catch require` shim is what makes that a graceful degradation instead of an outage.

## Edge-Case & Dependency Audit

### Race conditions

- None. This is argument normalisation before any I/O.
- The upward walk stats the filesystem, so a root created or deleted mid-walk yields a stale answer. Not a practical concern: the walk completes in microseconds and workspace roots are not created concurrently with a card move.

### Security

- None from `path.resolve` — it adds no capability on a caller-supplied argument in a script the caller already controls, and the script runs with the caller's privileges either way.
- **The walk itself has a security-adjacent failure mode**, and it is the reason for the marker discriminator above: an undiscriminated walk resolves to `~`, whose `.switchboard` holds `.master-key` and `secrets.enc`. Nothing in this change reads those files, but pointing `KanbanDatabase.forWorkspace` at that directory is not a place to end up. Keyed on `kanban.db` and stopped at `$HOME`, the walk cannot reach it.

### Side effects

- **The failure mode was read-only.** The wrong-database lookup missed and returned false before attempting any write, so no stray `.switchboard/` directory or DB was created by the failures. Verified: no `/.switchboard`, and no new `kanban.db` anywhere under the user's home. Fixing this therefore has no cleanup burden.
  - *Confirmed against source (improve pass):* `KanbanDatabase._initialize` explicitly refuses to create a missing DB — `'Database file does not exist (not auto-creating)'`, returns `false` (`KanbanDatabase.ts:6545-6552`). The empirical observation is backed by the code path, not luck.
- **Two minor side effects the original audit missed** (neither changes the shape of the fix): a mis-addressed root makes `_getKanbanDb` fire `showWarningMessage('Kanban DB initialization failed: …')` at the user (`TaskViewerProvider.ts:7845-7855`), and caches a dead `KanbanDatabase` instance keyed on the junk path in both `this._kanbanDbs` and the static `KanbanDatabase._instances`. Correcting the addressing removes both.
- Callers who were already passing an absolute fifth argument see no change — an explicit argument is honoured verbatim, and `path.resolve` is idempotent on absolute paths.

### Dependencies & conflicts

- **Related:** `kanban-move-silently-defaults-to-first-root` — the server-side half of the same addressing problem, which bites when the root is *omitted* rather than relative. Independent; either can land first.
- **Related:** `column-update-failed-masks-plan-not-found` — the reason this took a code trace to diagnose. Landing that first would have made this a one-glance fix.
- The skill documentation (`.claude/skills/switchboard-kanban/SKILL.md` and `.agents/skills/kanban_operations/`) documents the two-argument form as valid. After this fix it genuinely is, so no doc change is required — but the mirrored copies must stay in sync if either is touched.
- **The bundle ledger is auto-generated, not hand-maintained.** `.agents/.switchboard-bundled.json` is written by `ControlPlaneMigrationService` from a recursive filesystem listing (`_listFilesRecursive`), so a new file under `.agents/skills/_lib/` is picked up automatically. `skills/_lib/sb_api_call.sh` is the existing precedent for a shared file in that location. Verify the regenerated ledger contains the new helper anyway — it is a one-line check.
- **The direct-DB fallback is already unreachable outside this repo.** `move-card.js:117` requires `../../../out/services/KanbanDatabase`, which resolves to `<workspace>/out/services/…` — present only in the extension's own source repo. Fixing the root corrects that path *here*; in any other workspace the fallback still dies on the require. Out of scope for this plan, noted so the "corrects the recovery path at the same time" claim is not over-read.

## Dependencies

- None — no blocking session dependencies. The two related plans named above are independent and may land in either order.

## Adversarial Synthesis

**Risk summary.** The dominant risk is not the bug but the proposed fix: `path.resolve('.')` is `process.cwd()`, so absolute-ising the argument only works when the caller stands exactly at the workspace root, and the original verification plan tested only that case — a green light aimed at the one spot without a hole. The second risk is the obvious correction: an upward walk keyed on a `.switchboard` *directory* resolves to `~/.switchboard` (global config, master key, secrets) or `~/Documents/.switchboard` (legacy scaffold), both of which exist and both of which `isValidWorkspaceRoot` accepts. Mitigations: key the walk on `.switchboard/kanban.db`, hard-stop at `$HOME`, return `null` and fail loudly with an actionable message rather than silently sending cwd, honour an explicit argument verbatim, and guard the new shared require with `try/catch` so a partial `.agents/` sync degrades instead of breaking all eight scripts on shipped installs.

## Proposed Changes

### 0. Confirm the helper ships (do this first — it gates everything else)

Before editing eight scripts, confirm a file added at `.agents/skills/_lib/workspace-root.js` is carried by the control-plane bundle. Read the bundle-source → workspace copy path in `src/services/ControlPlaneMigrationService.ts` (`_listFilesRecursive`, the `BUNDLE_LEDGER_FILE` write, and the blocklist at ~line 1047) and confirm `_lib/` is not blocklisted. `skills/_lib/sb_api_call.sh` already ships from that directory, so the expected answer is yes — verify rather than assume, because a wrong answer here breaks all eight scripts at once rather than one.

If for any reason `_lib/` cannot carry a `.js` file, fall back to inlining the resolver into each of the eight scripts. That is the worse option (eight copies of a walk with a `$HOME` guard is exactly how drift starts) and should only be taken on evidence.

### 1. New: `.agents/skills/_lib/workspace-root.js` — root discovery

**Context.** Every script in `kanban_operations/` needs the same answer to "which workspace am I addressing?", and seven of them already carry a duplicated `findApiPort` upward walk. This centralises the root question; `findApiPort` stays where it is.

**Logic.** An explicit argument is the caller's stated intent and is honoured verbatim (resolved to absolute, idempotent when already absolute). A "here" token (absent, `.`, `./`) carries no information beyond "wherever I am", so it triggers discovery: walk up from cwd to the first directory holding a real workspace marker, refusing `$HOME` and terminating at the filesystem root. No root found returns `null` — the caller must fail loudly, never silently substitute cwd.

**Implementation.**

```js
// .agents/skills/_lib/workspace-root.js
//
// Resolve the workspace root a kanban_operations script should address.
//
// A path crossing a process boundary must denote the same directory on both
// sides. `path.resolve('.')` is process.cwd() — absolute, but only correct when
// the caller happens to stand at the workspace root. So: discover the root.
//
const fs = require('fs');
const os = require('os');
const path = require('path');

// Markers identifying a REAL workspace root. A bare `.switchboard` directory is
// NOT sufficient: ~/.switchboard (global config — master key, secrets) and
// ~/Documents/.switchboard (legacy scaffold) both exist on real machines and
// hold neither of these files.
const ROOT_MARKERS = [
  path.join('.switchboard', 'kanban.db'),
  path.join('.switchboard', 'api-server-port.txt')
];

function isWorkspaceRoot(dir) {
  return ROOT_MARKERS.some((marker) => {
    try { return fs.existsSync(path.join(dir, marker)); } catch { return false; }
  });
}

/**
 * @param {string|undefined} explicit  the script's optional workspace-root argv slot
 * @param {string|undefined} startDir  discovery origin (defaults to process.cwd())
 * @returns {string|null} absolute workspace root, or null when none can be identified
 */
function resolveWorkspaceRoot(explicit, startDir) {
  const raw = explicit === undefined || explicit === null ? '' : String(explicit).trim();
  const isHereToken = raw === '' || raw === '.' || raw === './';
  if (!isHereToken) {
    // The caller named a root. Honour it verbatim — do not second-guess it by
    // walking. Keeps the absolute-argument path byte-identical to today.
    return path.resolve(raw);
  }

  const home = path.resolve(os.homedir());
  let cur = path.resolve(startDir || process.cwd());
  while (true) {
    if (cur !== home && isWorkspaceRoot(cur)) { return cur; }
    const next = path.dirname(cur);
    if (next === cur) { return null; }   // hit the filesystem root
    cur = next;
  }
}

module.exports = { resolveWorkspaceRoot, isWorkspaceRoot };
```

**Edge cases.**
- **Nested roots** (`patrickwork/` and `patrickwork/get_kanban_state/` both hold `.switchboard`): the walk starts at cwd and returns the *first* hit, i.e. the innermost enclosing root. That is the correct bias — the caller is standing in the inner workspace.
- **`.switchboard` without `kanban.db`** (e.g. `patrickwork/.switchboard` today): skipped, walk continues. A workspace whose DB has never been created is not addressable by these scripts anyway — the direct-DB path would find nothing and the server-side lookup would miss.
- **`$HOME` itself is skipped, not terminated on** — the walk continues above it so that a genuine root at `/Users/shared/repo` outside the home tree still resolves. Only `$HOME` as a *candidate* is refused.
- **Symlinked workspace roots:** `path.resolve` does not follow symlinks (`fs.realpath` would). Left as-is deliberately — the extension's own `isValidWorkspaceRoot` also uses `path.resolve`, so matching it keeps client and server agreeing on the same string.

### 2. `.agents/skills/kanban_operations/move-card.js` — resolve the root at definition

> **Superseded:** Line 25: `const workspaceRoot = path.resolve(process.argv[5] || process.cwd());` — plus "Add the `path` require if not already present."
> **Reason:** `path.resolve(process.argv[5] || process.cwd())` is `process.cwd()` whenever the argument is absent, which resolves the caller's *current directory*, not the *workspace root*. It fixes only the root-cwd case and leaves every subdirectory invocation failing exactly as before — while passing the original verification plan, which tested only from the repo root. Separately, `path` is already required at line 19, so that instruction was a no-op here.
> **Replaced with:** discovery via the shared helper, with a loud failure when no root can be identified.

- **Line 25** becomes:

```js
let resolveWorkspaceRoot;
try {
  ({ resolveWorkspaceRoot } = require('../_lib/workspace-root'));
} catch {
  // Partial .agents/ sync — degrade to the old behaviour rather than crash.
  resolveWorkspaceRoot = (explicit) =>
    path.resolve(explicit && explicit !== '.' ? explicit : process.cwd());
}

const workspaceRoot = resolveWorkspaceRoot(process.argv[5]);
if (!workspaceRoot) {
  console.error(
    `No Switchboard workspace found from ${process.cwd()} — no .switchboard/kanban.db ` +
    `in this directory or any parent below your home directory.\n` +
    `Pass the workspace root explicitly:\n` +
    `  node move-card.js <plan> <column> "" /absolute/path/to/workspace`
  );
  process.exit(1);
}
```

- `path` is **already** required at line 19 — no new require needed here.
- Leave line 86's `|| findApiPort(process.cwd())` fallback intact. Note its semantics after this change: if the discovered root has no port file (extension not running for that root) the fallback may find a *different* root's server, and the body still carries the discovered root — so the server queries the right DB via a neighbour's port. Acceptable, and strictly better than today; do not remove it.
- No change at the HTTP body (line 100) or the direct-DB fallback (line 125) — both read the corrected variable.

### 3. Apply the same change to the sibling scripts

`workspaceRoot` sits at a **different `argv` index in almost every script** — there is no single substitution. Exact targets:

| Script | Line | `argv` index |
|---|---|---|
| `move-card.js` | 25 | `argv[5]` |
| `reconcile-features.js` | 37 | `argv[2]` |
| `get-state.js` | 6 | `argv[2]` |
| `remove-from-feature.js` | 18 | `argv[3]` |
| `assign-to-feature.js` | 21 | `argv[4]` |
| `create-feature.js` | 29 | `argv[4]` |
| `delete-feature.js` | 20 | `argv[4]` |
| `split-feature.js` | 23 | `argv[6]` |

All eight currently read `process.argv[N] || '.'`. Apply the identical helper call and fail-loud guard at each. Do not leave a subset corrected — the inconsistency is worse than the uniform bug.

> **Superseded:** "`assign-to-feature.js`, `create-feature.js`, … and `get-state.js` all accept an optional workspace-root argument. Any that default it to `'.'` or pass it unresolved carry the **identical** bug."
> **Reason:** Six of the seven siblings do carry the identical bug — they send `'.'` over HTTP. `get-state.js` does **not**: it has no process boundary at all (`KanbanDatabase.forWorkspace(workspaceRoot)` at line 8, no HTTP path), so `'.'` is resolved in-process by `isValidWorkspaceRoot`'s own `path.resolve` against the caller's own cwd. It is correct today when run from the root and shares only the *subdirectory* weakness. Calling it identical would send a reviewer looking for a boundary defect that isn't there.
> **Replaced with:** treat six siblings as the same boundary defect; treat `get-state.js` as the subdirectory-only variant — same fix, different justification. `get-state.js` also has **no `path` require**, so the degradation shim there needs `const path = require('path');` added (this is where the original plan's "add the path require" instruction actually applies).

## Verification Plan

Compilation and automated tests are out of scope for this session; the steps below are manual/observational.

1. **Reproduce first, from the root.** With the extension running and multiple roots registered, run the two-argument form from this repo's root against a plan known to live in this repo's DB. Confirm `Column update failed` before the fix.
2. **Reproduce from a subdirectory — the discriminating case.** `cd src/services` and run the same two-argument form (with a path to the plan file that resolves from there). Confirm it also fails. **This is the test the original plan lacked**: at the repo root, a naive `path.resolve(cwd)` and correct root discovery produce the same string, so a root-only verification cannot tell a working fix from a broken one.
3. **Fix, then repeat both.** Steps 1 and 2 both succeed and the card moves. Confirm in the DB, not just from the script's exit code.
4. **Absolute-arg regression.** Pass an explicit absolute workspace-root argument; behaviour unchanged (the helper returns it verbatim without walking).
5. **Non-primary root.** From a *different* registered root, move a card belonging to that root. Confirm it moves there and that no card in any other root is touched.
6. **Backwards move.** Move a card from `CODE REVIEWED` to `PLAN REVIEWED`. It must succeed — there is no transition guard, and this test exists to prove the original symptom was addressing and not policy.
7. **Home-directory trap.** Run the two-argument form from a directory with no workspace ancestor (e.g. `~/Downloads`). It must print the actionable "no Switchboard workspace found" message and exit 1 — it must **not** resolve to `~` or `~/Documents`, both of which contain a `.switchboard` directory. Confirm afterwards that `~/.switchboard` is untouched (`ls -la ~/.switchboard`; `.master-key` and `secrets.enc` unchanged).
8. **Nested-root bias.** From `GitHub/patrickwork/get_kanban_state/`, confirm the resolver picks the innermost root holding `kanban.db`, not an outer one.
9. **Degradation shim.** Temporarily rename `.agents/skills/_lib/workspace-root.js` and run any of the eight scripts. It must fall back to the old `path.resolve` behaviour and still run — not `MODULE_NOT_FOUND`. Restore the file afterwards.
10. **Sibling scripts.** For each script corrected in change 3, run its documented minimal form from a **non-primary root and from a subdirectory of it**, and confirm it targets the caller's workspace.
11. **Bundle ledger.** Confirm the regenerated `.agents/.switchboard-bundled.json` lists `skills/_lib/workspace-root.js`.
12. **No scaffold.** After all of the above, confirm no new `.switchboard/` directory or `kanban.db` was created anywhere outside the registered roots.

## Recommendation

**Send to Coder.** Complexity 5. The diagnosis was correct and well-evidenced; the originally proposed remedy was not sufficient — `path.resolve('.')` is `process.cwd()`, so it fixes only the case the original verification plan happened to test. The corrected change is root *discovery* with a marker discriminator and a `$HOME` guard, applied uniformly across eight scripts. This is still the defect that most directly bites agents and automation, because the skill's own documented example omits the root and therefore cannot work outside the extension's primary workspace — but it wants a coder who will run verification step 2, not step 1.
