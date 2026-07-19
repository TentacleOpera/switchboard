# Create Plans — docs-only planning intake for external agents

## Goal

Give Switchboard a single, obvious place to **hand an external AI agent the project's intent — docs, PRDs, constitution — and get back a plan describing desired behavior**, then bring that plan onto the board. Deliver the project's docs two ways (a public link, or a private zip), ship the agent a clear instruction to plan at the level of *behavior and flows, not code*, and accept the pasted-back plan as a card. Because the dev docs are the *source* for this, also help the user improve and lay them out logically for planning before packaging. Remove the existing NotebookLM export, which bundles the whole repo (including code) and pulls agents in the wrong direction.

### Problem & background

Today there is no clean path for "let an outside agent help me decide what to build." The pieces that exist point the wrong way:

- **The NotebookLM export bundles the entire git repo — code and all.** Handing an agent the codebase makes it reason about *implementation*: files, functions, how things are wired. That is the opposite of what you want from an external planning partner, whose value is thinking about *what the product should do* unencumbered by how it's currently built.
- **The planning intake (paste a plan onto the board) is buried and uninstructed.** Nothing tells the outside agent what a Switchboard plan should contain or that it should stay at the behavior level, so pasted plans are inconsistent and often drift into premature implementation detail.
- **There is no "front door" for this at all** — least of all for a brand-new workspace with no plans yet, which is exactly when "help me draft my first plans" is most useful.

### Root cause / the principle this fixes

Switchboard has been treating "context for agents" as "give them everything, including code." The correct division of labour is:

> **External agents receive docs, not code, and plan at the level of behavior. Code-level planning is Switchboard's internal job.**

An outside agent (any web chat, or one you upload a zip to) should read your *intent* and produce a plan describing **how the system should behave** — the flows, the expected outcomes, the edge cases in user terms. Turning that behavior plan into code is what Switchboard's own deep-planning and coding fleet already do, *after* the plan is on the board. This feature draws that line explicitly and builds the intake around it.

## Metadata

**Complexity:** 5
**Tags:** frontend, backend, ux, feature, docs

_(No project named and no PROJECT PIN directive present — this plan lands unassigned and can be reassigned on the board.)_

## User Review Required

Yes — this deletes a shipped export and introduces a new tab. Confirm before dispatch:
1. **Remove the NotebookLM export** entirely (it bundles code; it conflicts with the docs-only principle).
2. **Docs-only scope** is correct — the bundle contains constitution + PRDs + README + dev docs, and **never** source code, even as an option. Dev docs are the current-behaviour source, not the code.
3. **Dev-docs toggle defaults ON when present** — including current-behaviour docs (change mode) is the default; the user can switch to intent-only (vision mode). Confirm default-on is right.
4. **Public link is bring-your-own-URL** — Switchboard does not host. You publish your docs (GitHub Pages or anywhere); the tab holds the URL and the planning instructions to hand an agent. (If you'd rather Switchboard help set up hosting, that's a separate, larger piece.)
5. **Workspace-first, project-optional** — the tab works with zero projects; a project only *narrows* the bundle and *pins* the result when one is active.

## The core principle (spine of the feature)

Everything below serves one rule: **the agent sees docs and returns behavior.** Concretely:

- The bundle contains **only docs** — never source files, ever. Two kinds:
  - **Intent docs** — constitution, PRDs, README: what the product *should* do and the principles it follows.
  - **Current-behaviour docs (dev docs)** — the developer documentation that describes how the system *actually works today*, in prose. These are the source: they are the docs-level stand-in for the code, and the reason "docs not code" works at all — the agent can understand current behaviour without ever seeing an implementation file.
- **Dev docs are toggleable, for a behavioural reason, not a size one.** Including them anchors the agent to the existing system (it plans a *change*); excluding them frees the agent to plan *from intent* (greenfield or a deliberate rethink). The toggle is "plan against current behaviour" vs "plan from vision."
- **Because dev docs are the source, Switchboard helps improve them — and this is the only place code is read.** An internal, code-aware agent lays the dev docs out logically for planning (documenting how the system actually behaves); the external agent then plans from the resulting docs. Code-knowledge is distilled into docs once, internally, so the external side stays code-free without being uninformed. This reuses the existing "Draft/Improve with agent" doc handoff, pointed at dev docs with purpose-specific wording.
- The instructions handed to the agent say, in plain terms: *describe what the product should do; do not write code, do not design implementation* — and adapt to whether current-behaviour docs were included.
- What comes back is a **behavior plan** — goals, flows, expected outcomes, edge cases in user language — which lands on the board and is later turned into code by Switchboard's existing internal planning.

## Flows (the heart of the plan)

### Flow 0 — Create or improve the source (required when there are no docs; otherwise optional)

The feature cannot produce a useful plan without a source, so this is the entry point whenever docs are thin or absent. Packaging is **gated** until a source exists.

1. User opens **Create Plans**. If there is no usable source, *Create the source* is the only enabled action.
2. Switchboard hands off (existing Draft/Improve pattern) to a **code-aware local agent**:
   - **Code exists, docs don't →** *generate* initial dev docs from the code: document how the system currently behaves and lay it out logically as a planning source. This is the real cold-start bootstrap for an existing project.
   - **Docs already exist →** *improve* them: fill gaps, structure by capability/flow, so the source is clean for planning.
3. The agent writes the dev docs back to the **same Docs-tab-managed folder they already live in** (the repo's docs folder) — Create Plans has no store of its own. This is the only step that reads code.
4. With a source in place, packaging (Flow B/C) unlocks. When good docs already exist, this whole step is optional.

### Flow A — Cold start (no projects, no plans) — the primary case

Two sub-cases, because the source has to come from somewhere — the tab never hands over an empty pack:

- **Existing codebase, no docs (the common one):** the tab's first action is *Create the source* (Flow 0) — a code-aware agent generates initial dev docs from the code. Now there is a real source → package → hand to an external agent → paste the behaviour plan back (unassigned).
- **Greenfield, no code and no docs:** there is genuinely nothing to plan from yet. The tab says so and points the user to write a first intent doc (a PRD or constitution — Switchboard's existing builders help). Once even a short intent doc exists, packaging unlocks.

The headline scenario is the first: bootstrapping a project's first plans by turning its code into docs, then having an external agent plan behaviour from those docs.

### Flow B — Public docs link

1. User has published their docs (e.g. GitHub Pages). They paste that URL into the tab once; Switchboard remembers it.
2. User clicks **Copy planning prompt** — the clipboard now holds a ready-to-paste instruction that (a) points the agent at the docs URL and (b) tells it to produce a behavior plan, not code, in Switchboard's expected shape.
3. User pastes into any web agent that can read a URL. The agent returns a behavior plan.
4. User pastes it back (Flow D).

### Flow C — Private docs zip

1. User clicks **Download docs zip**.
2. Switchboard produces a zip containing the intent docs **plus a `HOW-TO-PLAN.md`** carrying the same behavior-plan instructions — so the pack is self-describing.
3. User uploads the zip to a private agent (Claude Project, ChatGPT, Gemini, NotebookLM). The agent reads it and returns a behavior plan.
4. User pastes it back (Flow D).

### Flow D — Paste the plan back

1. User pastes the agent's plan into the tab and confirms.
2. A plan card is created on the board from the pasted markdown.
3. **Pinning:** if a project is currently active, the card is pinned to it; if not, it lands **unassigned** (never pin the workspace name, never invent a project).
4. The user can then run Switchboard's normal internal flow (improve/deep-plan → code) on that card.

### Flow E — Project active (narrowing)

When a project is selected, the bundle additionally includes that project's PRD and linked docs, and paste-back pins to that project. Everything else is identical. Projects are a refinement, never a requirement.

## Expected behavior of the Create Plans tab

- Lives in the Project panel (`project.html`) alongside the artifacts it draws on (PRDS, CONSTITUTION) and the board it feeds (KANBAN PLANS).
- Renders and fully functions **with no projects and no plans**.
- Presents the loop's actions in order: **(optional) Improve dev docs → Package → Take to an agent → Paste back.**
  - Improve dev docs: **Improve the source with an agent** — offered when dev docs exist (or to seed them when they don't). Reuses the existing Draft/Improve-with-agent handoff, with wording tailored to "lay these out as a clear behavioural source for planning." This is the code-aware, internal step; it is optional and can be skipped.
  - Package: **Copy public link + prompt** (if a URL is set) and **Download docs zip**.
  - A single **"Include current behaviour (dev docs)"** toggle, default **on**, shown only when the workspace has dev docs. It changes both what goes in the pack and which prompt variant is copied. No other toggles — one meaningful choice, kept clear.
  - The planning prompt is one click to clipboard; the zip is one click to download.
  - Paste back: a paste field that turns pasted markdown into a card.
- **Packaging requires a source.** With no usable docs, the package actions (link/zip) are disabled and the tab's active call-to-action is *Create the source* — generate dev docs from code, or (greenfield) seed a first intent doc. The tab is never a dead end because there is always a next step, but that step is *creating the source*, not downloading an empty pack.
- Never offers an "include code" option. The docs-only boundary is not user-configurable — the only scope toggle is intent-only vs intent-plus-current-behaviour, and both are docs.

## What goes in the bundle

**Always included (intent):**
- Constitution (workspace-level).
- PRDs (all, or the active project's when a project is selected).
- README.
- Any other curated docs the Docs tab manages.
- `HOW-TO-PLAN.md` — the agent instructions (zip only; the public path carries these via the copied prompt).

**Included by default when present, toggleable (current behaviour):**
- **Dev docs** — the repo's developer documentation (post-merge, this is the developer-docs folder among the Docs-tab managed folders). These describe how the system behaves today and are the primary source for planning a *change*. Default **on** when dev docs exist; the toggle only appears when there are dev docs to include. Turning it off gives the agent intent-only (vision mode).

**Explicitly excluded (never, not even as an option):**
- All source code, build output, config, binaries. The bundle is docs, not implementation. Dev docs *describe* the code's behaviour; they are not the code.

## The agent instruction (product copy — behavior, not code)

Shipped as `HOW-TO-PLAN.md` in the zip and as the copyable prompt for the public link. The wording adapts to the dev-docs toggle (final copy to be reviewed).

**Shared core:**
```
You are helping plan a change to a product. You have been given its docs —
not its code, and that is deliberate.

Write a plan that describes DESIRED BEHAVIOUR:
- What should the product do? What is the user flow, start to finish?
- What are the expected outcomes and the edge cases, in user terms?
- What is explicitly out of scope?

Do NOT write code, choose libraries, or design implementation. Stay at the
level of behaviour and flows — how it should work, not how it is built.

Return the plan as markdown with a short title, a Goal, the flows/expected
behaviour, and edge cases. It will be pasted directly onto a planning board.
```

**When dev docs ARE included (change mode) — add:**
```
Some of these docs describe how the product currently behaves. Use them to
ground your plan in the existing behaviour, and describe the CHANGE in
behaviour — what becomes different, and what stays the same.
```

**When dev docs are NOT included (vision mode) — add:**
```
You have the product's intent and principles but not a description of how it
currently works. Plan the desired behaviour from first principles; do not
speculate about the current implementation.
```

## Removing the NotebookLM export

- Remove the whole-repo NotebookLM bundling feature and its entry points from the UI.
- **Rationale:** it bundles code, which is exactly what this feature establishes agents should not receive.
- **Existing users / on-disk output:** the export only ever wrote generated files under `.switchboard/NotebookLM/`. Stop generating; leave any existing folder in place (it's disposable output, not user data) and mention the removal in release notes. No migration of user data is required because none is stored there.
- Update the published docs site to drop the NotebookLM page and repoint its prev/next neighbours.

## Edge cases (behavioural)

- **No usable source (no docs, no README):** packaging is unavailable — there is nothing meaningful to hand an agent. The tab surfaces *Create the source* instead: generate dev docs from code if a codebase exists, otherwise prompt for a first intent doc. No empty or README-only pack is ever produced.
- **No projects:** default and expected; bundle is workspace-level, paste-back is unassigned.
- **Public URL not set:** the "Copy public link + prompt" action is unavailable/greyed with a hint to paste a docs URL; the zip path still works.
- **Very large docs:** keep the zip sensible; if the doc set is large, that is acceptable for a private upload (unlike code, docs are bounded). No code means the pack stays small in normal cases.
- **Pasted content isn't a real plan:** create the card from whatever was pasted (matching existing paste-to-board behaviour); the user edits or reruns. Do not silently reject.
- **Stale docs:** out of scope to detect; the plan's quality tracks the docs' freshness, which the Docs tab's authoring tools keep current.
- **Privacy framing:** "private" means not published to the public web; the zip still goes to whatever AI vendor the user uploads it to. The tab's wording should not overclaim privacy.

## Implementation notes (intentionally light)

- A docs-scoped packaging capability is the only genuinely new backend piece: gather the intent-doc set and emit (a) a markdown zip and (b) the `HOW-TO-PLAN.md`. Reuse the existing bundling/traversal machinery where it helps, but constrain the source set to docs — do **not** reuse the whole-repo file listing.
- **Single source of truth — no second home for docs.** Create Plans neither stores nor copies docs; it reads, improves, and packages the *same* doc set the Docs tab manages (repo docs folder + PRDs + constitution). The generate/improve step writes back into that managed folder. The zip is a transient export regenerated on demand — not a canonical location, and not user-edited. So no doc ever lives in two places, consistent with the merge plan's whole-point of one docs model.
- Paste-back reuses the existing "create a plan card from markdown" path; the only addition is the pin-if-project-active rule.
- The public-link store is a single remembered URL per workspace.
- Keep the tab's logic thin — its job is to make the three-step loop obvious, not to add cleverness.

## Verification plan (flow-based)

Verify by walking the flows, not by inspecting internals:

1. **Cold start (existing code, no docs):** fresh board, repo present, no docs → open Create Plans → packaging is gated; *Create the source* is the only action → run it → dev docs generated from code land on disk → packaging unlocks → Download docs zip → confirm it contains the generated dev docs + `HOW-TO-PLAN.md` and **no code** → paste a sample plan back → card appears unassigned.
2. **Dev-docs toggle:** with dev docs present, toggle defaults on → zip includes them and the copied prompt is the change-mode variant. Toggle off → dev docs omitted and the prompt is the vision-mode variant. With no dev docs, the toggle is absent.
3. **Improve the source:** invoke "Improve the source with an agent" → the handoff prompt instructs a code-aware agent to document current behaviour and lay the dev docs out logically → improved docs land on disk → the next package picks them up. Confirm this is the only step that reads code, and that the external pack still contains no code afterwards.
2. **Public link:** set a docs URL → Copy planning prompt → confirm the clipboard references the URL and instructs behaviour-only planning.
3. **Private zip → real agent:** upload the zip to an agent, confirm it can produce a behaviour plan from docs alone.
4. **Paste back with project active:** select a project → paste a plan → card is pinned to that project.
5. **NotebookLM gone:** the export action is absent from the UI; the docs site no longer references it; no broken links.
6. **No dead ends:** with no docs, no URL, no projects, the tab offers a clear path to *create the source* (generate from code, or seed an intent doc) — not an empty zip. Greenfield with no code → it asks for a first intent doc rather than producing a pack.

## Relationship to other plans

- **`merge-dev-docs-into-docs-tab.md` (docs-tab consolidation) — complement; sequence this AFTER it.** Not superseded. This plan builds on the consolidated Docs tab (single docs model, managed folders, the Draft/Improve handoff) and reuses that handoff for the "improve the source" step. It also *completes* the merge plan: the merge plan deletes the project-context auto-bundle and names GitHub Pages as the replacement, but the auto-bundle's real purpose was context for remote agents — which the public link + private zip here actually deliver. The two plans delete **different** things (merge → auto-bundle; this → NotebookLM export), so there is no conflict. Ship the merge first, then this.
- **`cross-platform-agent-collaboration.md` (collaboration) — supersedes its near-term rationale, not its full scope.** If the goal is "external agents help produce plans," this plan delivers it with none of the collaboration plan's coordination machinery (turn-tokens, bidirectional content-pull, attribution, per-column ownership). It does **not** provide concurrent, multi-agent, cross-platform co-authoring of a *live* plan — that is the collaboration plan's actual target. This is the simple, shippable version of the same intent; the collaboration plan should be shelved unless live co-authoring is a genuine, wanted capability.

## Recommendation

Complexity 5 → send to Coder once the four review points are confirmed. The work is mostly a new, thin UI flow plus one docs-scoped packaging step and the removal of the NotebookLM export; the behavioural boundary (docs-only, behaviour-not-code) is the thing to hold firm on.
