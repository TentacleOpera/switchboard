---
description: "Fix the Kanban project filter's cross-client coupling. The client-local view filter (boardProjectFilter) already exists; the remaining bugs are on the shared side: kanban.activeProjectFilter is last-writer-wins and decides where NEWLY AUTHORED plans/features get filed (PROJECT PIN at KanbanProvider:8944, feature stamping at :11876), and a project switch reloads project-scoped settings for every client. Also diagnoses the reported 'extension project switch didn't work' symptom, which is NOT yet root-caused. Piece 3 of 3; independent of pieces 1 and 2."
---

# Kanban Project Filter — Client-Local View, Per-Initiator Authoring Scope

## Goal

**Definition of done: (a) switching project in one client cannot change where another client's newly authored plans and features get filed, (b) switching project in one client cannot swap another client's effective project-scoped settings, and (c) the reported "extension project switch didn't work" symptom is root-caused and fixed.**

### Core problem (root-cause analysis)

Unlike the Design panel (pieces 1 and 2), the Kanban board's *view* filter is **already** client-local and working. `boardProjectFilter` (`kanban.html:4230`) is documented as *"the single source of truth for what the board renders"*, cards for all projects are cached in `allCards` and filtered client-side (`:4235-4239`), and the comment at `:7202-7215` states the intent plainly — the local filter is preserved on same-workspace refreshes *"so browser and webview never reset each other."* That part is sound and this plan does not disturb it.

The bugs are on the **shared** side, and there are two proven ones plus one unresolved symptom.

#### Proven bug 1 — the shared row decides where new plans get filed (data correctness)

`setProjectFilter` (`KanbanProvider.ts:6539-6552`) writes the shared singleton `_projectFilter` **and** persists `kanban.activeProjectFilter` to the DB on **every** dropdown switch, from **either** client. That row is last-writer-wins across clients.

That row is not merely cosmetic — it is the **authoring scope**:

- `:8944` reads it to build the **PROJECT PIN** directive injected into plan-authoring prompts (`agentPromptBuilder.ts:878`: *"The user had the project X active when they copied this prompt"* → the agent writes `**Project:** X` into every plan file it creates).
- `:11876` reads it to stamp a **new feature's** project when its subtasks carry none.
- `GlobalPlanWatcherService._handlePlanFile` stamps imported plans from it (per the comment at `:11870-11872`).

**Consequence:** leave the browser board on project X, then copy a plan prompt from the extension while looking at project Y — the generated plans are pinned to **X**. Silently misfiled, with no visible cause, and `CLAUDE.md`'s pinning protocol is explicit that this snapshot is meant to be *"a frozen, race-free snapshot"* of *"the board's active project"*. With two clients there is no single "the board", so the guarantee quietly fails.

Note this row is **legitimately shared state** — it is the authoring/dispatch scope, deliberately one source of truth, and remote/DB-less agents depend on reading it. So the fix is **not** to make it client-local. The fix is that the authoring scope for a *client-initiated* action must be resolved from **that client's** view filter, not from a last-writer-wins global.

#### Proven bug 2 — one client's switch swaps the other's effective settings

When project override is enabled, `setProjectFilter` (`:6560-6566`) calls `_reloadSettingsFromStore()`, `_markConfigDirty()`, `refreshPromptOverridesCache()` and `_postOverrideState()`. These act on the provider singleton and push to **all** clients. So a browser project switch re-scopes the extension's effective settings and prompt overrides mid-session.

#### Unresolved — the reported "project switch didn't work" symptom

**This is not yet root-caused, and the plan must not pretend otherwise.** The shared-state coupling above is verified, but the specific symptom (an extension project switch appearing to do nothing) has not been reproduced. Verified candidates to discriminate between:

1. **Re-seed on an unrelated push.** `updateWorkspaceSelection` re-seeds `boardProjectFilter` from the shared mirror when `workspaceChanged` (`kanban.html:7207-7210`), and on first hydration when `boardProjectFilter === null && allCards.length === 0` (`:7211-7215`). A push triggered by the *other* client could satisfy one of these and snap the filter back.
2. **Dropdown re-render snapping selection.** The combined workspace|project `<select>` is rebuilt with a priority ladder (`:4798-4830`); if the option list is rebuilt from a stale `allWorkspaceProjects` the selection can fail to match and fall back (`:4830`).
3. **Snapshot early-out suppressing the repaint.** `updateBoard` is skipped when the snapshot hash and the key `${workspaceId}|${_projectFilter}|${_repoScopeFilter}` are both unchanged (`KanbanProvider.ts:2003-2012`). Because the dropdown sends `noRefresh: true` (`kanban.html:8336`, handled at `:7592`), a switch is *intended* to need no re-push — but any code path that does await a re-push after a switch can be silently gated here.

Step 1 of implementation is therefore diagnostic, not corrective.

## Metadata
- **Tags:** bugfix, architecture, kanban, browser, cross-host, data-integrity
- **Complexity:** 5
- **Release phase:** Piece 3 of 3 in the browser/extension view-independence set. **Independent of pieces 1 and 2** (different provider, different mechanism) — can ship in any order.

## User Review Required
- **Where should the authoring scope come from?** Proven bug 1 needs the initiating client's project, not the global row. Two options: (a) client-initiated authoring verbs pass their `boardProjectFilter` in the message and the host prefers it over the DB row, falling back to the row when absent; or (b) keep reading the row but have each client write it immediately before an authoring action. **(a) is recommended** — (b) is a race by construction and still breaks with two clients. Option (a) does mean the pin becomes a client-supplied input, so the resolve-only import guard described in `CLAUDE.md` (unknown pin → unassigned, never auto-create a project row) remains the required backstop. Confirm (a).
- **Should `kanban.activeProjectFilter` keep tracking the last switch at all?** It must keep existing and stay populated — remote / DB-less agents and the plan watcher read it as the workspace's authoring default. Recommended: keep writing it (so single-client behavior and remote reads are unchanged), but stop treating it as authoritative for a *client-initiated* action once (a) lands. Confirm.

## Scope

### ✅ IN SCOPE
1. **Diagnose the "switch didn't work" symptom** against the three candidates above, with both clients connected. Fix what is found; if it proves to be candidate 1, the correction is to narrow the re-seed conditions at `kanban.html:7207-7215` so an unrelated client's push cannot re-seed a client that already owns a filter.
2. **Per-initiator authoring scope** (proven bug 1): thread the initiating client's project filter into the authoring/prompt-generation paths that currently read `kanban.activeProjectFilter` — `:8944` (PROJECT PIN) and `:11876` (feature stamping) — preferring the client value and falling back to the DB row when absent (per the resolved decision).
3. **Stop one client's switch re-scoping another's settings** (proven bug 2): make the `_reloadSettingsFromStore` / `_postOverrideState` consequences at `:6560-6566` apply to the initiating client rather than unconditionally to the singleton + all clients.
4. **Regression test for the misfiling bug** — the highest-value artifact here, because the failure is silent.

### ⚙️ OUT OF SCOPE
- Re-architecting `boardProjectFilter`. It already works; leave it as the client-local render filter.
- Removing or re-keying the `kanban.activeProjectFilter` DB row. It is **shipped state** read by remote agents, the plan watcher, and DB-less sessions; per the project's migration rule it must keep working unchanged for ~4,000 installs. This plan changes *what defers to it*, never its shape or presence.
- The `**Project:**` pin file format or the importer's resolve-only guard (`CLAUDE.md` backstop) — unchanged, and still the required safety net.
- Design panel work (pieces 1 and 2).

## Implementation Steps
1. **Diagnostic pass first.** Reproduce with extension + browser both open; instrument `updateWorkspaceSelection` re-seeds, the dropdown rebuild ladder, and the snapshot early-out to determine which candidate fires. Do not write corrective code before this resolves.
2. Fix the identified re-seed / rebuild / early-out defect.
3. Thread initiator project into the two authoring read sites (`:8944`, `:11876`); keep the DB-row fallback.
4. Scope the override-reload consequences (`:6560-6566`) to the initiating client.
5. Add the regression tests below.

## Complexity Audit
### Routine
- Threading one optional field into two authoring call sites.
- Narrowing a re-seed condition once diagnosed.
### Complex / Risky
- **The diagnostic step is genuinely unknown work** — the symptom is reported but not reproduced. Complexity 5 reflects that, not the size of the edits. If diagnosis shows a fourth cause, re-scope rather than forcing a fit.
- **Proven bug 1's fix touches plan project pinning**, which `CLAUDE.md` treats as a protocol with a non-negotiable import guard. Getting it wrong misfiles plans — the same class of bug, differently caused. The resolve-only importer backstop must remain intact and must be asserted by test.
- **Shipped-state sensitivity:** the DB row must keep being written and readable for older installs and remote agents.

## Edge-Case & Dependency Audit
- **Race conditions:** the current design *is* the race (last-writer-wins on a shared row, read at prompt-generation time). Option (a) removes it for client-initiated actions by making the scope travel with the request instead of being read from global state later.
- **Migration / shipped state:** `kanban.activeProjectFilter` keeps its key, shape, and population behavior — no migration needed, and no-op for single-client users. Confirm an install that never opens the browser board sees byte-identical behavior.
- **DB-less / remote sessions:** must keep working off the DB row alone (they have no client filter to send). The fallback is what preserves them — do not make the client value mandatory.
- **Single-client invariance:** with only the extension open, every path must behave exactly as today. This is the primary regression risk of the change.
- **Security:** a client-supplied project name becomes an input to plan authoring. It is a *name*, resolved by the existing resolve-only importer guard, which must continue to refuse unknown pins and never auto-create a `projects` row (`CLAUDE.md` backstop). Do not add a project-creation path here.
- **No confirmation dialogs** are added anywhere (project rule).

## Verification Plan
### Automated
- **Misfiling regression (highest value):** browser board on project X, extension on project Y; generate an authoring prompt from the extension → the PROJECT PIN resolves to **Y**, not X. Same for feature stamping at `:11876`.
- Project override ON: a switch in client A does not change client B's effective settings or prompt-override cache.
- **Single-client invariance:** with one client, PROJECT PIN and feature stamping resolve identically to today (guards the ~4,000-install path).
- A DB-less / remote caller with no client filter still resolves the pin from `kanban.activeProjectFilter`.
- The importer still leaves an unknown pin unassigned and creates no `projects` row.
### Manual
- Reproduce the original symptom (extension project switch appearing to do nothing) with both clients open, then confirm it no longer occurs after the fix — and record in Review Findings which candidate it actually was.
- Switch project in the browser, then in the extension; confirm each board renders its own filter and neither snaps back.
- Copy a plan prompt from the extension while the browser sits on a different project; confirm the created plan lands on the extension's project.

**Stage Complete:** CREATED
