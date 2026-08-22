# Mission Control panel: UI specification

## Goal

Give automation one comprehensible home. Remove the kanban AUTOMATION tab, add a Mission Control panel to the shell rail, and put the two things a user actually configures — **missions** and **schedules** — behind one tab each, with a sidebar-list-plus-detail layout in both.

### Problem Analysis

The automation model settled in `the-automation-model-four-things-not-a-mode-axis.md` has no home. Today its parts are scattered: an exclusive mode axis in a kanban tab, a scheduler sharing that tab for no reason, a prompt generator disguised as a mode, and mission running with nowhere to live at all. Without a single surface the model is four ideas competing for one radio, and the UI stays incomprehensible however good the model is.

This plan is the UI half. It assumes the model and specifies where each part lives.

### Rail placement

The rail renders from `getPanelsManifest` in array order, with `placement: 'bottom'` the only override (`headlessPanelHtml.ts:520-529`, `shell.js:501`). Target order:

```
board
mission-control      ← new; fighter-jet icon
agent-control        ← moved beneath mission control
terminals            ← moved beneath mission control
… (project, memo, tickets, planning, design, connections)
setup                (placement: bottom)
```

So this is a manifest insert plus a reorder — no `shell.js` change, per its own comment that "adding a panel route later adds a strip icon with no shell code change".

The **fighter-jet icon** ties to the brand: the product's second homepage illustration is a radar scope with tagged interceptors (`agent-fleet-air-combat-detailed.svg`), and the persona rename settles on Mission Control (`rename-the-orchestrator-to-mission-control.md`).

### Layout

Both tabs use **sidebar list + detail**, the pattern `tickets.html` already implements — `#tree-pane` inside a `.content-row`, with a `.sidebar-toggle-row` and a `collapsed` state (`tickets.html:364-366`). Reuse it rather than inventing a third layout.

---

## Missions tab

**Sidebar:** selectable missions. **Content:** the selected mission.

| Field | Behaviour |
|---|---|
| **Goal** | user-entered free text |
| **Type** | `mission` (unsupervised) or `operation` (supervised) |
| **Status** | not started · in flight · aborted · completed |
| **Team** | assign one or more teams |
| **Max parallel worktrees** | default `0`. A **mission** may not exceed `1`; an **operation** may go higher |
| **Features and plans** | add and remove members |
| **Sequencing** | shows the order; **defaults to sequential when no stream map exists** |
| **Log** | events so far |

**Global controls:** workspace/project selector · Launch · New mission · switch view by status · Delete mission · Stop mission · **Ready mission**.

**Ready is a flag, not a status.** The status set is not-started/in-flight/aborted/completed, so readiness is orthogonal: it marks a mission as eligible for pickup, and **a scheduler or Mission Control must not take an unready mission**. That is the safety property that makes "build missions in advance" usable — a half-assembled mission sitting in the list cannot be grabbed.

**The worktree cap is a real constraint, not a default.** `mission ≤ 1` is what keeps unsupervised runs from fanning out into parallel trees with no one watching; `operation > 1` is allowed because a supervised run has someone to resolve conflicts. The cap must be enforced where the run starts, not only in the form — a mission whose type is changed after launch must not silently gain parallelism.

---

## Schedules tab

**Sidebar:** scheduled actions, each active or not. **Content:** the selected action. Multiple actions allowed; **no cap on active actions** — that is the user's problem to manage.

**Type:** internal or external.

### Internal

**Time:** dropdown from every 5 minutes to once a week, plus **custom (cron)**.

**Action** dropdown:

- advance plan
- phone a friend on a coded plan (skips features)
- advance feature (goes to a team if configured)
- batch advance to planning team
- review code vs intent on CODE REVIEWED plans in the last period, produce a doc
- process memo
- improve docs
- update readme
- send plans to Jules
- start rest mission
- research (requires a research terminal)
- git pull/push
- custom

**Conditional fields, by action class:**

| When the action… | Show |
|---|---|
| advances a plan or feature | **from** and **to** column fields |
| involves coding | **complexity filters** (e.g. filter what goes to Jules) |
| produces an artifact (research, intent reviews) | **artifacts folder** |
| is *not* a board action | **target terminal** (changeable) and the **prompt**, editable |

**Planner actions are unattended by construction**, so their prompt must carry three instructions: write any research questions into the plan; note on the plan if user questions blocked completion; and send that plan back to CREATED. A scheduled planner with no one to ask is otherwise a planner that either stalls or invents an answer.

### External

Same action dropdown **with the board actions removed**, plus a **Copy prompt** button. No clock, no ON/OFF, and — per the model plan — **no pausing of anything local**.

**Global controls:** New schedule · Delete · Start · Stop · **Logs** (switches the content view to the log markdown file, with a link to it).

---

## Metadata

**Complexity:** 8
**Tags:** ui, frontend, ux, feature, backend

## User Review Required

- **"start rest mission" is ambiguous** — "start *next* mission", or start the remaining/unstarted ones? These differ: one takes the next ready mission, the other could launch several. Not guessing.
- **What does `max parallel worktrees: 0` mean?** No worktree at all (work in the main checkout), or "unset, use the board default"? `0` reads as none, but the default for a mission that may go to `1` might sensibly be `1`.
- **"batch advance to planning team" depends on unwritten work** — noted as *"requires setup, dependent on an uncoded plan I haven't done yet"*. It should ship disabled with a reason rather than as a live option that fails, per the dead-control rule (`worktree-strategy-control-contract.test.js`: "a third radio ahead of its provisioning is a dead control").
- **Thirteen actions is the largest surface here.** Several map to existing features (process memo, research, send to Jules, phone a friend); others do not obviously exist yet (improve docs, update readme, review code vs intent). Worth marking which are wiring versus new work before this is built, because the dropdown will otherwise ship with options that do nothing.
- **Does the missions tab own mission *creation* from the board?** `staging-streams-parallel-dispatch-and-worktrees.md` has a mission auto-created by dropping a card into STAGING. This panel adds a New mission button. Both should be fine, but the panel must show a board-created mission identically to a panel-created one.

## Complexity Audit

### Routine

- Manifest insert plus reorder; no `shell.js` change.
- `mission-control.html` + `mission-control.js`, following the companion-`.js` convention seven panels already use.
- Reusing `tickets.html`'s sidebar/content/collapse pattern.
- Deleting `automation-tab-content` and `automation-panel-root` from `kanban.html`.

### Complex / Risky

- **The conditional-field matrix is where this gets fragile.** Four field groups keyed on action class, over thirteen actions, means a wrong classification silently shows the wrong form — a board action asking for a terminal, or an artifact producer with nowhere to write. The action list should carry its classes as **data** (`needsColumns`, `needsComplexity`, `needsArtifactsFolder`, `needsTerminal`), not as branching in the render function, and the test should assert the matrix rather than the rendering.
- **Two `enabled`/active concepts must not blur.** A *schedule* is active or not; a *mission* is ready or not, and separately has a status. Reusing one word across both is how the current tab became unreadable.
- **Removing the AUTOMATION tab strands its persisted state.** `autoban.state` in `workspaceState` holds mode selections that no longer have UI. Per the model plan they are forced off with one notice — but this plan deletes the surface, so the notice needs somewhere to appear. Mission Control on first open is the obvious place.
- **`kanban.html`'s tab strip loses a member.** Same flex-wrap check as the agent-control retirement.
- **The log view is a markdown file, not a live stream.** "Logs switches the content view to a MD file" — so it is a document render, and it needs to say how current it is. A log that looks live and is not is worse than a link to the file.
- **`status` and the run are two sources of truth.** A mission shows `in flight`, but the actual state lives in the queue and the board. The panel must derive status rather than store its own copy, or a killed run leaves a mission reading `in flight` forever.

## Edge-Case & Dependency Audit

**Migration.** No mission or schedule data exists yet, so the panel starts empty. The only migration is the retired mode state, owned by the model plan.

**Security.** Prompts are editable by the user and sent to terminals — the existing dispatch path, no new surface. Generated external prompts carry no credentials, same rule as every other generator. Artifact folders are user-supplied paths and need the same validation as other configured directories.

**Side effects.** The rail gains an icon and two icons move. Users who reach Agents or Terminals by position will find them one slot down.

**Ordering.** The panel shell, the missions tab and the schedules tab are separately shippable. The AUTOMATION tab should not be deleted until the schedules tab can hold what it replaced.

## Dependencies

- **Requires** `the-automation-model-four-things-not-a-mode-axis.md` — this is that model's UI.
- **Requires** `staging-streams-parallel-dispatch-and-worktrees.md` for missions, stream maps and the sequencing view.
- **Supersedes the `missions.html` panel** proposed inside the streams plan — same panel, specified here.
- **Interacts with** `extract-agent-control-into-its-own-panel-file.md`: both touch the rail and the manifest. Sequence them.
- **Precedent:** `tickets.html` for layout, the companion-`.js` convention for structure.

## Adversarial Synthesis

**"This is a big panel — start with one tab."** Reasonable, and the plan is written so either tab can ship first. But the AUTOMATION tab cannot be deleted until schedules exists, so that half is on the critical path.

**"Thirteen actions is the same complexity, moved."** No — the current complexity is that five modes are *mutually exclusive*, so a user must understand all of them to pick one. A list of thirteen independent actions, each with its own fields, is a menu. Menus scale; exclusive axes do not.

**"Ready should just be a status."** It cannot be: a mission can be ready-and-not-started or unready-and-not-started, and after launch readiness is meaningless while status keeps changing. Folding them loses the distinction that makes advance preparation safe.

**"Derive status, or store it?"** Derive. A stored status is a second source of truth that drifts the first time a run dies unexpectedly, and "in flight forever" is the failure users would report as the panel being broken.

## Proposed Changes

1. **Remove** `automation-tab-content` / `automation-panel-root` and the tab button from `kanban.html`.
2. **Manifest**: insert `mission-control` after `board`; move `agent-control` and `terminals` beneath it. Fighter-jet icon.
3. **`mission-control.html` + `mission-control.js`**, two tabs, sidebar-plus-detail from `tickets.html`.
4. **Missions tab** per the table above; **ready as a flag**, status **derived**.
5. **Enforce the worktree cap at launch**, not only in the form.
6. **Schedules tab** per the spec; action classes carried as data.
7. **Planner prompts carry the unattended instructions** (research questions into the plan; note blockers; return to CREATED).
8. **External type** drops board actions and offers Copy prompt; no local side effects.
9. **Logs** renders the markdown log with a link and a clear as-of.
10. **Actions with unbuilt dependencies ship disabled with a reason**, never as live options that fail.

### Migration

None of its own; the retired-mode notice surfaces on first open of this panel.

## Verification Plan

### Goal Invariants

- The AUTOMATION tab is gone and nothing references it.
- The rail order is board → mission-control → agents → terminals.
- A mission of type `mission` can never run more than one worktree.
- An unready mission is never picked up by a scheduler or Mission Control.
- Every action's form shows exactly the fields its class declares.

### Automated Tests

- **Unready missions are not picked up:** with a ready and an unready mission staged, assert only the ready one is taken. This is the property that makes advance preparation safe, and its absence is invisible until a half-built mission launches itself.
- **Worktree cap enforced at launch:** set a mission to `3`, launch, assert refusal; change type to `operation`, assert it proceeds. Then set `3` on an operation, launch, and *change type to mission mid-run* — assert no silent gain of parallelism.
- **Field matrix from data:** for each action, assert the rendered fields equal the classes it declares. A matrix test, not a render test — the failure is a mis-declared class, not bad markup.
- **Status is derived:** kill a run mid-flight; assert the mission does not remain `in flight`.
- **Disabled actions state a reason:** assert any action with an unmet dependency renders disabled *with* an explanation, never enabled.
- **Rail order and no shell edit:** assert the manifest yields the target order and `shell.js` is unchanged.
- **AUTOMATION tab gone:** assert `kanban.html` has no `automation` tab button, no `automation-tab-content`, and no `automation-panel-root`, and that no code references them.
- **Retired-mode notice appears once:** open the panel with a stored legacy mode; assert one notice, and none on reopen.
- **External has no local effect:** select external, copy the prompt; assert no config write and no scheduler change.
- **Log is honest about currency:** assert the log view states its as-of time rather than implying live updates.

### Manual Verification

- Build a mission without readying it, arm a schedule, confirm nothing runs. Ready it, confirm it does.
- Walk every action in the dropdown and confirm its form matches its class.

## Outstanding Questions

- **[user]** "start rest mission" — next, or remaining?
- **[user]** `max parallel worktrees: 0` — none, or unset?
- **[user]** Which of the thirteen actions exist today and which are new work?
- **[user]** Is there an existing plan for the unattended-planner instructions (research questions into the plan, blocked-completion note, return to CREATED)? Searched and did not find one — it may be under wording I did not match, and duplicating it would be worse than reusing it.
- Does the missions sidebar group by status, or is the status view switch a filter over one flat list? The controls imply a filter; a grouped list would make the switch redundant.
