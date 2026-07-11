# Fix Multi-Root Activation Refresh — Control-Plane Files Only Update the Focused Folder

## Goal

Make the extension's activation-time control-plane refresh (skill seeding + `AGENTS.md`/`CLAUDE.md`/`.claude/skills` scaffolding + per-folder version stamping) run for **every Switchboard-managed folder in a multi-root window**, not just the single "current" folder. Today a multi-root user's non-focused folders silently freeze at whatever extension version they last individually refreshed at, so control-plane fixes (skill changes, frontmatter strips, manifest category changes, the `AGENTS.md` marker fix) never reach them.

**User requirement (plain statement, 2026-07-11):** every **parent folder listed in the workspace mappings settings (Setup panel → workspace mappings, `parentFolder` field in `setup.html`)** must receive the latest agent skills on activation — whether or not that folder is open or focused in the current window. The mappings list is the user-maintained distribution list; the refresh must treat it as such. Open workspace folders that aren't in any mapping (the normal single-folder install) must keep refreshing too.

### Terminology (the three folder concepts, so they stop blurring together)

| Term | Meaning | Source |
| :--- | :--- | :--- |
| **Open folder** | A folder currently open in the VS Code window | `vscode.workspace.workspaceFolders` |
| **Mapping parent** | A `parentFolder` entry in the workspace mappings the user maintains in the Setup panel (e.g. `/Users/patrickvuleta/Documents/Gitlab`) | `getMappingsFromIndex().mappings[*].parentFolder` (`src/services/WorkspaceIdentityService.ts:95`) |
| **Managed folder** | Any folder with a `<root>/.switchboard/` directory — the marker that Switchboard owns files there | disk check |

The refresh target set = **all mapping parents** ∪ **all open folders that are managed**. The old code used none of these — it used only the kanban board's *focused* folder, which is the bug.

### Problem & root-cause analysis (verified in code + on disk, 2026-07-11)

**Symptom.** In a multi-root VS Code window containing the `switchboard` repo (focused/current) and `/Users/patrickvuleta/Documents/Gitlab/` (a second Switchboard-managed root), the GitLab root did **not** receive any of the recent control-plane changes:

- `Gitlab/.switchboard/.agent_version.json` → `"version": "1.7.6"` (last updated 2026-07-10), while the extension is now at 1.7.9 and the switchboard repo's stamp is current. *(Re-verified on disk 2026-07-11 during plan review.)*
- `Gitlab/.agents/skills/*/SKILL.md` → **31/31 still carry YAML frontmatter** (the frontmatter-strip from the "Stop Skill-Discovery Spam" feature never landed there). *(Re-verified 2026-07-11.)*
- `Gitlab/.claude/skills/switchboard-manage/SKILL.md` → still `disable-model-invocation: true` (the `no-model → no-user` demotion from the front-door consolidation never landed); `switchboard-chat` still ungated.
- `Gitlab/AGENTS.md` / `CLAUDE.md` → had accumulated duplicate protocol markers (the pre-1.7.9 `buildManagedInner` nesting bug), which the marker fix in 1.7.9 will never heal there either.

Meanwhile the focused `switchboard` repo received every one of those changes. So the changes themselves are correct and do propagate — **to exactly one folder.**

**Root cause.** The activation refresh block operates on a single root, not a loop over workspace folders:

- `src/extension.ts:425` — `const workspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot();`
- `src/extension.ts:476` — `if (workspaceRoot) { …seed skills… ; if (needsAgentRefresh || agentsChanged) scaffoldProtocolLayers(…) ; setLastCopiedAgentVersion(workspaceRoot,…) }`

`getCurrentWorkspaceRoot()` (`src/services/KanbanProvider.ts:1026`) simply returns `this._currentWorkspaceRoot` — the one folder the kanban board is focused on. The seed loop (`:489-524`) and the scaffold (`:534-549`) therefore only ever touch that one folder. Sibling roots in a multi-root window are never seeded, never scaffolded, and never re-stamped, so `shouldRefreshAgentWorkspaceFiles` (`:221`, version-equality gate) has no chance to fire for them — the code that would call it never runs for those folders.

**Why single-folder installs are unaffected (and why this hid for so long).** For the ~4,000 typical single-folder installs, the only open folder *is* the current root, so the single-root refresh covers it: fresh install → no version file → refresh; upgrade → version differs → refresh. The defect is specific to **multi-root windows**, where only the focused folder updates. It is pre-existing activation logic (not introduced by any recent feature); recent control-plane work simply made its consequences visible.

**Secondary propagation paths that exist but don't save multi-root users:**
- `performSetup` (`src/extension.ts:3572`) fully refreshes a specific `workspaceUri` (copies `.agents`, scaffolds, stamps version at `:3646-3648`) — but only when the user *explicitly* runs Setup for that folder. It is not invoked per-folder on activation.
- There is **no** board-switch hook that scaffolds a folder the first time it becomes the current root. So even switching the board to the GitLab folder does not currently refresh it. **Confirmed 2026-07-11:** `setCurrentWorkspaceRoot` (`src/services/KanbanProvider.ts:1053`) updates `_currentWorkspaceRoot`, the DB-eviction exemption, and the persisted selection, and fires `_onWorkspaceChangeEmitter` — no seed/scaffold call anywhere on that path.

## Non-Goals

- Changing *what* the scaffold writes (skill content, manifest categories, marker format). Those are correct; this plan is purely about *which folders* the refresh reaches.
- Auto-scaffolding folders that are **not** Switchboard-managed. Opening an unrelated repo alongside a Switchboard project must not litter it with `AGENTS.md`/`CLAUDE.md`/`.claude/` (see the opt-in predicate below).
- Reworking `shouldRefreshAgentWorkspaceFiles`'s version-equality logic. It is correct; it just needs to be *reached* per folder.
- The `buildManagedInner` marker fix (already shipped in 1.7.9) — this plan is what makes it *reach* stale multi-root folders, but does not re-implement it.

## Metadata

**Complexity:** 5
**Tags:** bugfix, reliability

## User Review Required

- None. The failure is reproduced, the root cause is a single-root loop bound, and the fix (per-folder loop + managed-folder guard) is determined. The only judgement call — whether to also add mid-session folder-add propagation — is scoped as an optional follow-up below.

## Complexity Audit

### Routine
- Step 1 is an extract-function refactor of an existing block with zero logic change; byte-equivalent behavior for a single folder is the acceptance bar.
- The per-folder loop is a straightforward `for…await` with per-folder `try/catch`, mirroring the per-file fault tolerance already inside the seed loop.
- Version-stamp helpers are already per-folder (`getAgentVersionFilePath(root)` → `<root>/.switchboard/.agent_version.json`, `src/extension.ts:100-127`); no changes needed.
- Per-folder config resolution already works: `switchboard.protocol.target` is declared `"scope": "resource"` in `package.json` and `getProtocolTargets(workspaceUri)` (`src/extension.ts:3320`) resolves against the folder URI (verified — see Step 4).

### Complex / Risky
- The managed-folder predicate (Step 3) is the load-bearing guard: a false positive writes `AGENTS.md`/`CLAUDE.md`/`.claude/` into a user's unrelated open repo, across ~4,000 installs. This is the primary acceptance test.
- The target set now includes mapping parents that are **not open in the current window** — deliberate (the mappings list is the distribution list), but it means the refresh writes outside the window's folders. Stale mapping rows pointing at deleted/moved parents must be filtered by the disk-existence guard, and `~`-prefixed paths must be expanded exactly as `buildMappingIndexFromDbs` does (`WorkspaceIdentityService.ts:70`).
- Ordering inside the extracted function: `needsAgentRefresh` must be captured **before** the seed loop per the existing `:477-479` contract; getting this wrong silently changes when the mirror regenerates.

## Edge-Case & Dependency Audit

**Race Conditions**
- Activation runs once; the loop is sequential (`for…await`). No concurrent writers to a given folder's `.switchboard/`. Cross-folder is independent. No new race.

**Security**
- No new network or exec surface. All writes are confined to folders that pass the opt-in predicate, and protocol-file edits go through the marker-managed `ensureProtocolFile` path (`src/extension.ts:3165`), which preserves user content outside the managed markers.

**Side Effects**
- **Non-Switchboard folders in the window** — must be skipped (Step 3). This is the single most important correctness property; getting it wrong means writing protocol files into users' unrelated repos. Test explicitly (`fe`, `meetings`, `fe/src/api` in the current window all lack `.switchboard/` and must stay untouched).
- **Migration safety (published state)** — `AGENTS.md`/`CLAUDE.md` are shipped user state in ~4,000 installs. `ensureProtocolFile` already preserves content outside the managed markers and self-heals duplicate markers (first-start-marker to last-end-marker span collapse, `:3217-3226`); the loop must call that same path (via `scaffoldProtocolLayers`), never a blind overwrite. The opt-in guard (Step 3) is the backstop against clobbering a user's hand-authored `AGENTS.md` in a folder that merely happens to be open.
- **Performance** — the content-hash seed hashes ~32 tiny skill files per managed folder every activation (the seed currently runs unconditionally, before the version gate). With N managed folders that is N×32 small hashes. Acceptable, but consider gating the seed loop itself behind `needsAgentRefresh` per folder if activation latency regresses; note the tradeoff (the current unconditional seed is what lets a same-version skill-content fix self-heal — keep that property for at least the folders whose version matches). Clarification: hoist the bundle `crawlDirectory` call and optionally cache bundle-side file hashes across folders — the bundle is identical for every folder; only destination hashes differ (see implementer note 5).
- **Legacy flat skill files** — the seed loop only writes paths present in the bundle, so legacy flat files in a target folder (e.g. `Gitlab/.agents/skills/archive.md` alongside `archive/`) are untouched. Out of scope here; do not add deletion logic.

**Dependencies & Conflicts**
- **Mapping-index readiness (ordering dependency)** — the target set reads `getMappingsFromIndex()`, whose index is built by `initializeMappingIndex()` at `extension.ts:415`, inside a `try/catch` that logs and continues on failure. The control-plane block at `:476` runs after it, so the index is ready by construction **when the build succeeded**; if the build threw, `getMappingsFromIndex()` returns `{enabled: false, mappings: []}` and the loop degrades gracefully to open-managed-folders only (same coverage as the pre-mappings design — never a crash). Do not move the refresh block above `:415`.
- **Mapping parents not open in any window** — writing to a mapping parent that isn't an open folder is *intended*, per the user requirement: the mappings list is the distribution list. These are folders the user explicitly configured in Setup; they are not "unrelated repos." The Non-Goal about littering unrelated folders applies to folders in *neither* the mappings nor the managed set.
- **`getCurrentWorkspaceRoot()` null at activation** — the loop does not depend on the board having focused a folder yet, which is strictly better than today (today, if `_currentWorkspaceRoot` is null at activation, *no* folder refreshes).
- **Second call-site (`performSetup:3593`)** — unchanged by this plan; it already scopes to its `workspaceUri`. No fix needed there, but do not accidentally regress it during the refactor.
- **Setup vs activation loop** — both are idempotent (version-gated + content-hash); see Step 5.
- **Mid-session folder adds (optional hardening):**

  > **Superseded:** Board-switch propagation (optional hardening) — consider also calling `refreshWorkspaceControlPlane(root)` when the board switches its current root to a folder whose version stamp is stale, so mid-session folder adds get covered without waiting for the next activation. Flag as a follow-up if out of scope for the first fix.
  > **Reason:** Once the activation loop covers every folder present at startup, a board switch can only target a folder that was already refreshed this session — the hook would be redundant. The event that actually creates an unrefreshed folder mid-session is *adding a folder to the window*, which fires `vscode.workspace.onDidChangeWorkspaceFolders`. (Verified 2026-07-11: `setCurrentWorkspaceRoot` — `src/services/KanbanProvider.ts:1053` — has no scaffold path today, confirming the original suspicion, but hooking it is the wrong trigger.)
  > **Replaced with:** Optional follow-up: subscribe to `vscode.workspace.onDidChangeWorkspaceFolders` and run `refreshWorkspaceControlPlane` for each `added` folder that passes `isSwitchboardManagedFolder`, with the same per-folder `try/catch`. Still optional — folders added mid-session get covered on the next window reload regardless.

## Dependencies

- None.

## Adversarial Synthesis

Key risks: (1) a too-loose target set writing protocol files into unrelated repos — mitigated by drawing targets only from the explicit mappings list plus open folders, with the `.switchboard/`-exists guard as the final filter, and an explicit negative test; (2) ordering regressions in the extracted refresh (seeding pre-empting the `needsAgentRefresh` capture) — mitigated by preserving the capture-before-seed contract and the single-folder regression test; (3) silent version-stamp failures causing the scaffold to re-run every activation — eliminated by aligning the guard with the stamp's write path (`<root>/.switchboard/` must exist); (4) mapping-index unavailability at refresh time — degrades gracefully to open-managed-folders (the pre-mappings behavior), never a crash.

## Proposed Changes

### `src/extension.ts` (activation block + new helper)

Convert the single-root activation refresh into a per-folder loop over the refresh target set — **all workspace-mapping parent folders plus all open managed folders** (see Step 2) — gated by an explicit "is this a Switchboard-managed folder" predicate, preserving all existing per-folder behavior (content-hash seed, version-gated scaffold, per-folder version stamp, per-folder `switchboard.protocol.target` config).

#### Step 1 — Extract the per-folder refresh into a function

Pull the body of the `if (workspaceRoot)` block (`src/extension.ts:476-550`) into a function, e.g. `async function refreshWorkspaceControlPlane(root: string, context: vscode.ExtensionContext): Promise<void>`, containing exactly today's logic in the same order:

1. `const needsAgentRefresh = shouldRefreshAgentWorkspaceFiles(context.extensionUri.fsPath, root);` (capture **before** seeding, per the existing `:477-479` comment — seeding must not pre-stamp the version).
2. Content-hash skill seed loop (`:489-524`) targeting `root`.
3. `if (needsAgentRefresh || agentsChanged) { await scaffoldProtocolLayers(vscode.Uri.file(root), context.extensionUri, 'Migration'); setLastCopiedAgentVersion(root, currentVersion); }`.

This is a pure refactor with no behavior change for a single folder — verify the extracted function is byte-equivalent in effect for the current root.

#### Step 2 — Loop over all refresh targets (mapping parents ∪ open managed folders)

> **Superseded:** Loop over `vscode.workspace.workspaceFolders ?? []` only, gated by `isSwitchboardManagedFolder`.
> **Reason:** User direction 2026-07-11 — the requirement is that **all parent folders in the workspace mappings settings (setup.html)** get the latest agent skills, whether or not they are open in the current window. Open-folders-only misses a mapping parent that isn't open (e.g. a window where only a child repo of the Gitlab parent is open: the child's DB pointer resolves to the parent's `kanban.db`, so the parent is known to the extension, but it is not an open folder). The mappings list is the explicit, user-maintained distribution list and must be first-class, not inferred.
> **Replaced with:** Build the target set as the union of **mapping parents** and **open managed folders**, dedupe by resolved path, then loop:

```ts
// 1. Mapping parents — the explicit distribution list the user maintains in Setup.
//    Index is already built: initializeMappingIndex() ran at extension.ts:415,
//    BEFORE this block (:476). Reuse the ~ expansion used in
//    buildMappingIndexFromDbs (WorkspaceIdentityService.ts:70).
const { getMappingsFromIndex } = require('./services/WorkspaceIdentityService');
const cfg = getMappingsFromIndex();
const targets = new Set<string>();
for (const m of (cfg.enabled ? cfg.mappings : [])) {
    if (!m.parentFolder) continue;
    const expanded = m.parentFolder.startsWith('~')
        ? path.join(os.homedir(), m.parentFolder.slice(1))
        : m.parentFolder;
    targets.add(path.resolve(expanded));
}

// 2. Open workspace folders — covers the normal no-mappings install.
for (const folder of vscode.workspace.workspaceFolders ?? []) {
    targets.add(path.resolve(folder.uri.fsPath));
}

// 3. Refresh each target that is actually managed on disk.
for (const root of targets) {
    if (!isSwitchboardManagedFolder(root)) continue;
    try {
        await refreshWorkspaceControlPlane(root, context);
    } catch (err) {
        console.error(`[Switchboard] Control-plane refresh failed for ${root}, continuing:`, err);
    }
}
```

Per-folder `try/catch` so one bad folder never aborts the others (mirrors the existing per-file fault tolerance in the seed loop).

Notes on the union:
- **Mapping parents pass the predicate by construction** — a mapping only enters the index if its `kanban.db` (at `parentFolder/.switchboard/kanban.db`, or via a child's pointer file) was readable, so `.switchboard/` exists for any live parent. The predicate still runs as the final safety check and correctly filters a *stale* mapping row whose parent folder was deleted or moved (its DB may have been read from another folder's store while the parent path itself no longer exists).
- **Mapping children are intentionally NOT targets.** Children resolve to the parent for DB and control-plane purposes; the requirement is parents only. Do not seed skills into child repos.
- Dedupe via the `Set` of resolved paths handles a parent that is also an open folder (the Gitlab window case).

#### Step 3 — Define `isSwitchboardManagedFolder(root)` (the load-bearing guard)

> **Superseded:** A folder is managed (and therefore eligible for auto-scaffold) if **any** of: (a) `<root>/.switchboard/` exists, **or** (b) `<root>/.switchboard/.agent_version.json` exists (previously scaffolded), **or** (c) `<root>/AGENTS.md` or `<root>/CLAUDE.md` already exists **and** already contains the `switchboard:agents-protocol` managed markers (opted in previously, even if `.switchboard/` was cleaned).
> **Reason:** Arm (b) is dead weight — `.agent_version.json` lives *inside* `.switchboard/` (`getAgentVersionFilePath`, `src/extension.ts:100-102`), so (b) can never be true when (a) is false. Arm (c) is actively harmful: `setLastCopiedAgentVersion` (`src/extension.ts:119-127`) does a bare `fs.writeFileSync` into `<root>/.switchboard/` with errors swallowed and no `mkdir`, so a markers-but-no-`.switchboard/` folder would scaffold, silently fail to stamp, and re-run the full scaffold on **every** activation forever. It would also resurrect `.agents/` (~32 skill files) and `.claude/` in a folder whose owner deliberately deleted `.switchboard/` — re-littering a folder that opted out — and creating `.switchboard/` just to make the stamp work would contradict the Non-Goal of never creating it in folders that lack it.
> **Replaced with:** Single-arm predicate: a folder is managed **iff `<root>/.switchboard/` exists** (directory check, e.g. `fs.existsSync` + `statSync().isDirectory()` or a try/catch `statSync`). This is the definitive marker — it is what makes GitLab, viaapp-web, analytics-dashboard, `9013262024` eligible — and it aligns the predicate with the version stamp's write path, so every folder that scaffolds can also stamp. Markers-without-`.switchboard/` is treated as opted-out; such a folder re-opts-in via explicit Setup (`performSetup` creates the directories at `:3575-3583`).

If the predicate does not hold, skip the folder — do **not** create `.switchboard/`, `AGENTS.md`, `CLAUDE.md`, or `.claude/` in it. This is what prevents scaffolding unrelated repos (`fe`, `meetings`, `fe/src/api` in the current window all lack `.switchboard/` and must stay untouched).

#### Step 4 — Respect per-folder configuration

`scaffoldProtocolLayers` and the `switchboard.protocol.target` setting are `scope: resource` (per-folder). Ensure the scaffold reads config against the **folder's** URI, not the window default, so a folder set to `agents`-only doesn't get a `.claude/` mirror forced on it. Verify `scaffoldProtocolLayers` already resolves config per the URI it's passed; if it reads a global config, thread the folder URI through.

**Verified 2026-07-11 — no threading work needed:** `switchboard.protocol.target` is declared `"scope": "resource"` in `package.json`; `getProtocolTargets(workspaceUri)` (`src/extension.ts:3320`) calls `getConfiguration('switchboard', workspaceUri)`; `scaffoldProtocolLayers` (`:3338`) passes its `workspaceUri` through to it; and `generateClaudeMirror(rootDir, version)` (`src/services/ClaudeCodeMirrorService.ts:441`) operates purely on the passed root. The only requirement on the implementer is to pass each folder's own URI/path (which Step 2's loop does by construction).

#### Step 5 — Do NOT duplicate work already covered by Setup

`performSetup` (`:3572`) also refreshes a folder. The activation loop and Setup must not fight: both are idempotent (version-gated + content-hash), so a double-run is a no-op, but confirm the activation loop uses the same `setLastCopiedAgentVersion` stamp so a folder Setup just refreshed is correctly seen as up-to-date and skipped by the loop's version gate. (Both paths call the same helper — `:544` and `:3648` — so the stamp is shared; keep it that way through the refactor.)

## Verification Plan

Session note: build/tests may be skipped per the operator's directive; verification is primarily by reproduction on the real multi-root window.

**Reproduce (pre-fix baseline):**
- Confirm `Gitlab/.switchboard/.agent_version.json` = `1.7.6`, `Gitlab/.agents/skills/*/SKILL.md` = 31/31 with frontmatter, `Gitlab/.claude/skills/switchboard-manage` = `disable-model-invocation`. *(Baseline re-confirmed on disk 2026-07-11.)*

**After fix (rebuild VSIX at a bumped version, reinstall, then reload the window — the fix is activation-time code, so an already-open window will not re-run it until reload):**
- `Gitlab/.switchboard/.agent_version.json` advances to the current version.
- `Gitlab/.agents/skills/*/SKILL.md` → 0 bundle-mirrored `SKILL.md` files with frontmatter (stripped). Count only `*/SKILL.md` under skill directories — legacy flat files not present in the bundle (e.g. `archive.md`) are not touched by the seed loop and may legitimately remain.
- `Gitlab/.claude/skills/switchboard-manage/SKILL.md` → `user-invokable: false`; `switchboard-chat` → `user-invokable: false`; a proxy like `clickup-api` → still `disable-model-invocation: true`, non-empty description.
- `Gitlab/AGENTS.md` and `CLAUDE.md` → exactly 1 start / 1 end marker, single protocol header.
- **Negative test:** a non-Switchboard folder in the same window (e.g. `fe`, `meetings`) gains **no** `.switchboard/`, `AGENTS.md`, `CLAUDE.md`, or `.claude/`.
- **Mapping-parent-not-open test (the user's core requirement):** open a window that does NOT contain the Gitlab parent folder (e.g. only a child repo of the mapping, or even just the switchboard repo if its DB store carries the mapping rows) → the Gitlab parent's `.agent_version.json` still advances and its skills still refresh, because the parent is in the workspace-mappings distribution list. Every `parentFolder` listed in the Setup panel's workspace mappings must end up current after one activation of any window whose mapping index includes it.
- **Idempotency:** re-activating again (second window reload) does not change any file and does not re-stamp (version gate holds); markers stay 1/1.
- **Single-folder regression:** open only the switchboard repo → behaves exactly as today.
- **No-mappings regression:** a workspace with no mappings configured (`getMappingsFromIndex()` → `enabled: false`) refreshes its open managed folders exactly as the pre-mappings design did.

### Automated Tests

Skipped this session per the operator's directive (SKIP COMPILATION / SKIP TESTS); verification is the live multi-root reproduction above. If tests are added later, the highest-value unit target is `isSwitchboardManagedFolder` — a pure predicate over the filesystem, trivially testable with a temp-dir fixture (with/without `.switchboard/`).

## Notes for the implementer (things easy to miss)

1. Capture `needsAgentRefresh` **before** the seed loop per folder (seeding writes the version stamp only inside the scaffold branch, but keep the ordering to match today's `:477-479` contract).
2. The version stamp path is already per-folder (`getAgentVersionFilePath(root)` → `<root>/.switchboard/.agent_version.json`), so looping stamps each folder correctly with no change to the stamp helpers.
3. Do not use `getCurrentWorkspaceRoot()` inside the loop — iterate `workspace.workspaceFolders` directly; the "current root" concept is exactly the bug.
4. The managed-folder guard (Step 3) is the difference between "fixes multi-root users" and "spams protocol files into every open repo." Treat it as the primary acceptance test, not an afterthought.
5. Clarification (perf, optional): hoist `crawlDirectory(bundledSkillsUri)` out of the per-folder function — the bundled skill list is identical for every folder — and consider caching bundle-side `hashFile` results in a `Map<string, string>` shared across folders. Destination-side hashes must still be computed per folder.

---

**Recommendation:** Complexity 5 → **Send to Coder**.

---

## Completion Summary

Implemented the multi-root activation refresh fix in `src/extension.ts`. Extracted the single-root control-plane refresh block (old lines 476-550) into a new `refreshWorkspaceControlPlane(root, context)` function (lines 264-326) preserving the exact ordering contract (capture `needsAgentRefresh` before seed, seed, then scaffold+stamp). Added `isSwitchboardManagedFolder(root)` predicate (lines 245-252) — single-arm guard: `<root>/.switchboard/` directory exists. Replaced the `if (workspaceRoot)` gate in `activate` with a loop (lines 558-583) over the union of mapping parents (`getMappingsFromIndex()` with `~` expansion matching `buildMappingIndexFromDbs`) and open workspace folders, deduped via `Set<string>`, each filtered by the managed-folder guard with per-folder `try/catch`. No other files changed. No issues encountered; `performSetup`'s independent call-site and the shared `setLastCopiedAgentVersion` stamp path are untouched, preserving Setup/activation idempotency.
