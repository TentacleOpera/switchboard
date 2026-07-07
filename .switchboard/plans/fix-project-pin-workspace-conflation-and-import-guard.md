# Stop file `**Project:**` pins from minting phantom projects (workspace≠project)

## Goal

Two linked fixes so a plan file can never conjure a project that the user didn't create:
1. **Protocol** — teach agents (especially remote/DB-less ones) that the workspace is not a project, and to write **no** `**Project:**` pin unless the user named a real project.
2. **System** — make the import path *resolve-only*: an unknown pin (or one equal to a workspace name / a literal placeholder) leaves the plan unassigned instead of auto-creating a projects row.

## Goal — Problem, root cause, background

### What happened (2026-07-07)

A `git pull` brought in a teammate's orchestration plans. Every one pinned `**Project:** Switchboard` in its metadata (one pinned lowercase `switchboard`, and a separate file leaked the literal `**Project:** <project>`). On import, Switchboard **auto-created** projects `Switchboard` (id 3), `switchboard` (id 5), and `<project>` (id 4). Those cards were then stamped onto the phantom `Switchboard` project, and because the board is project-filtered, two features (`orchestration-automation-mode`, `remote-control-via-api-providers`) dropped out of the visible board. The user had never created any of these projects and deleted them manually to recover the view.

### Root cause — two independent holes

**Hole A — agents pin the workspace name as a project.** `**Switchboard** is a workspace, not a project.` The pinning protocol (`AGENTS.md:138` "Plan Project Pinning", mirrored to `.agents/workflows/switchboard-chat.md:17`) tells agents: step 2, *"resolve the active project (read `kanban.activeProjectFilter` from the workspace's `kanban.db` config)"*; step 4, *"if neither exists… omit the line."* A **remote** agent has no `kanban.db` to read, so step 2 is impossible for it — and instead of falling through to step 4 (omit), it reaches for the only label in front of it, the repo/workspace name "Switchboard", and pins that. Nothing in the protocol says *"the workspace is not a project; never pin the workspace/repo name,"* so there's no guardrail. `<project>` is the same failure with an unsubstituted template placeholder.

**Hole B — the importer trusts the pin and auto-creates.** `KanbanDatabase._resolveProjectForInsert` (`KanbanDatabase.ts:1482`), Precedence #1 (`:1487–1494`): a file-supplied `record.project` "always wins" and calls `_resolveOrCreateProjectId` (`:1441`), which runs `INSERT OR IGNORE INTO projects (name, workspace_id)` (`:1450`) — **no allowlist, no existence check, no workspace-name guard.** Any string in a `**Project:**` line becomes a projects row. This is the same disease as the rest of this class of bug: **incoming file content trusted as authority over the DB**, with no reconciliation.

The codebase already contains the correct pattern for a *different* import path: `resolveProjectId` (`:2088`) is **SELECT-only**, and `updatePlanProjectByPlanFile`'s comment (`:2104–2109`) states the intended rule — *"Unknown project → project_id null."* Hole B is that the file-watcher path resolves-**or-creates** where the manifest path correctly resolves-only.

## Metadata

**Complexity:** 4
**Tags:** bugfix, backend, protocol, data-integrity, projects

## User Review Required

None — the desired behavior is specified by the user and encoded here:
- Remote agents must **ask** whether there's a project to stamp; if the user doesn't name one, **write no pin**. Never substitute the workspace/repo name or a placeholder.
- The importer must **never create a project** from a file pin — only the user creates projects (on the board). Unknown pin ⇒ unassigned.

## Complexity Audit

### Routine
- Protocol edits in `AGENTS.md` + `.agents/workflows/*` (docs; source of truth — `.claude/` and `CLAUDE.md` are generated from these).
- Switching Precedence #1 from `_resolveOrCreateProjectId` to a resolve-only lookup — a one-call change reusing the existing `resolveProjectId`.

### Complex / Risky
- **Not regressing legitimate assignment.** A pin naming a project the user *did* create must still resolve and stamp correctly — resolve-only handles this (SELECT hits). Only genuinely-unknown pins fall to unassigned. Verify the board's own project-filter creation path (`KanbanProvider` `ensureProjectExists`, `KanbanProvider.ts:3061`) is untouched — that path is the user *explicitly* creating a project and must keep working.
- **Precedence #2 (activeProjectFilter).** Local fresh-insert reads the board's active project — a value that only exists because the user selected/created that project, so resolve-only would still find it. Leave #2's behavior intact (it's a trusted local signal, not a cross-machine file pin); the fix targets #1 (file pins) only.

## Edge-Case & Dependency Audit

### Correctness
- **Unknown pin ⇒ fully unassigned.** On a miss, set `project = ''` and `projectId = null` (do not retain the orphan denormalized string — an orphan `project` text with null id causes exactly the filter confusion seen here). This is stricter than the manifest path's "keep the string," deliberately.
- **Workspace-name guard (belt-and-suspenders).** Even resolve-only, if a user coincidentally has a real project named identically to the workspace, a workspace-name pin would resolve to it. Add an explicit check: a pin equal to a workspace display name is dropped to unassigned. Primary safety is resolve-only; this is the secondary guard.
- **Placeholder guard.** Drop pins matching `/^\s*<.*>\s*$/` (e.g. `<project>`) or empty-after-trim.

### Shipped-state / migration
- **No schema migration.** Behavior-only change to resolution. Existing correctly-assigned cards are unaffected (their pins still resolve).
- **Existing pulled files still contain `**Project:** Switchboard`.** Once the guard lands, re-importing them no longer recreates the phantom projects (the SELECT misses → unassigned), so the user's manual deletion stays clean. **Interim risk (pre-fix):** until this ships, any re-import/restart will re-mint the phantom projects from those on-disk pins. Optional interim mitigation: scrub the `**Project:**` lines from the already-pulled orchestration files. Not required once the code fix lands.
- ~4,000 installs: additive/behavioral; older versions unaffected (file format unchanged).

### Security / side effects
- No new surface. Fewer writes (no auto-INSERT into projects). No confirmation dialogs.

## Dependencies

None. Complements the other watcher-hardening plans (`guard-watcher-against-git-churn-board-clobber.md`, `fix-feature-md-subtask-block-accretion.md`) — same root theme (files must not be authoritative over DB), different table.

## Adversarial Synthesis

Risks: (1) breaking legitimate project assignment — mitigated by resolve-only still resolving real projects, and by leaving the board's explicit `ensureProjectExists` creation path alone; (2) the workspace-name guard needing the workspace display name(s) — source it from the existing workspace/`workspace_name` data the DB already tracks; if unavailable, resolve-only alone still prevents phantom creation, so the guard degrades safely; (3) agents ignoring the protocol text — which is exactly why Hole B (the import guard) is the non-negotiable backstop and Hole A (protocol) is the first line, not the only line.

## Proposed Changes

### Part 1 — Protocol (agent-facing). Edit the source of truth, not generated files.

In **`AGENTS.md`** "Plan Project Pinning" (`:138`) and the mirror in **`.agents/workflows/switchboard-chat.md:17`** (and any other `.agents/` workflow/skill that restates it — grep `activeProjectFilter`), add/annotate:
- A hard statement: **"The workspace/repo name is NOT a project. Never pin it. Never emit a placeholder like `<project>`."**
- Rewrite the remote-session case: **a remote/DB-less agent cannot read `kanban.activeProjectFilter`.** So: if the user named a project, pin it; otherwise **ask** whether there's a project to stamp; if the user doesn't specify one (or the session can't ask), **write no `**Project:**` line.** Never guess, never use the workspace name.
- Apply the same rule to the remote plan-authoring skills that write `.md` files: `create-feature` (remote), `improve-remote-plan`, remote memo processing.

Regenerate `.claude/` / `CLAUDE.md` from the sources per the project's control-plane generation step.

### Part 2 — System (import guard). `src/services/KanbanDatabase.ts`.

In `_resolveProjectForInsert` Precedence #1 (`:1487–1494`), replace the `_resolveOrCreateProjectId` call with resolve-only:
```ts
if (record.project && record.project.trim() !== '') {
    const pin = record.project.trim();
    // Never mint a project from a file pin. Drop placeholders, workspace names,
    // and unknown names to unassigned — only the user creates projects (on the board).
    if (/^<.*>$/.test(pin) || (await this._isWorkspaceName(pin, record.workspaceId))) {
        return { project: '', projectId: null };
    }
    const projectId = record.projectId ?? await this.resolveProjectId(pin, record.workspaceId); // SELECT-only
    return projectId === null ? { project: '', projectId: null } : { project: pin, projectId };
}
```
- Add `_isWorkspaceName(name, workspaceId)` comparing against the workspace display name(s) the DB already tracks (`plans.workspace_name` / the workspaces source). If that data isn't readily available, ship resolve-only first (it alone prevents phantom creation) and add the workspace-name check as a follow-up.
- Leave `_resolveOrCreateProjectId` in place for the **board's explicit** project-creation path (`ensureProjectExists`, used by `KanbanProvider.ts:3061` when the user selects/creates a project filter) — that is the user creating a project and must keep working.
- Leave Precedence #2 (activeProjectFilter) unchanged.

## Files touched

- `AGENTS.md` — "Plan Project Pinning" hardening (workspace≠project, remote = ask-or-omit).
- `.agents/workflows/switchboard-chat.md` (+ any other `.agents/` source restating the pin rule; remote skills `create-feature`, `improve-remote-plan`).
- Generated `CLAUDE.md` / `.claude/skills/*` via the regeneration step.
- `src/services/KanbanDatabase.ts` — `_resolveProjectForInsert` Precedence #1 → resolve-only + placeholder/workspace-name guard; add `_isWorkspaceName`.

## Verification Plan

No automated tests / no compile this pass (project convention: test via installed VSIX; `src/` is source of truth). Suggested later test: seed a workspace, import a plan record with `project:'Switchboard'` (a name with no projects row) and assert **no** projects row is created and the plan lands `project=''`, `project_id=null`; then create project "Foo" on the board, import a record pinning "Foo", assert it resolves to Foo's id.

Manual (installed VSIX):
1. **The exact bug** — with the phantom projects gone, drop a plan `.md` containing `**Project:** Switchboard` into `.switchboard/plans/`; confirm **no** "Switchboard" project appears and the card lands unassigned/visible.
2. **Placeholder** — a plan pinning `**Project:** <project>`; confirm it's ignored (unassigned), no project created.
3. **Legitimate pin** — create project "Foo" on the board, then import a plan pinning `**Project:** Foo`; confirm it resolves to Foo (no regression).
4. **Board project creation** — create a project via the board's project dropdown; confirm that still works (explicit user creation path untouched).
5. **Re-import safety** — re-import the existing orchestration files (with their `**Project:** Switchboard` pins); confirm the deleted phantom projects do **not** come back.
6. **Protocol** — run a remote plan-authoring flow with no user-named project; confirm the produced `.md` has **no** `**Project:**` line (not the workspace name).

---

**Recommendation:** Complexity 4 (mostly routine; one careful spot preserving legitimate resolution + the board's explicit-create path). **Send to Coder.**
