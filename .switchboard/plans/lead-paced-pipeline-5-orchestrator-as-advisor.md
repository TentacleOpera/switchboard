# The Orchestrator Becomes an Advisor — Silent Ready Checks, Bounded Answers, Advice on Request

## Goal

The orchestrator's job is judgement, not narration: help a user who does not know what to do, verify that teams are set up correctly, decide what is in scope, and say what it recommends. Checks that pass are silent. Every answer has a stated shape and a ceiling. It never writes an essay about a board the user is looking at.

### Problem & background

**The reported failure is that everything gets overcomplicated: a plan in CREATED produces an essay where a one-line entry and a silent ready check were wanted.**

Two causes, both diagnosed.

**Cause 1 — the pre-flight reports everything it checks, including what passed.** `## The six checks` in the persona (`.agents/skills/switchboard-orchestrator/SKILL.md:74-88`) instructs the agent to "report what you find in plain terms" across six checks. Nothing distinguishes a finding from a non-finding, so an agent doing exactly as told narrates six passes as six paragraphs. Check 1 alone asks it to "say so plainly and **strongly recommend** starting a coding team… naming the features you are worried about so the recommendation is concrete rather than generic" — correct guidance for the failure case, and a licence to write at length when nothing is wrong.

**Cause 2 — "ready to go" is never defined as a query, so the agent reads the whole board.** This is fully root-caused in a sibling plan (`feature_plan_20260817193500_orchestrator-cannot-answer-what-plans-are-ready.md`) and the measurement is decisive: `CODE REVIEWED` holds 1732 of the ~1943 active rows on this workspace's board — **89% of everything active**. The persona names CREATED and PLAN REVIEWED as the lanes but never states what to *exclude*, what source to read, or what shape the answer takes. `GET /kanban/board` returns every active row including subtasks (`LocalApiServer._handleGetPlans` → `_resolveBoard`), and the file read path the agent is steered toward (`switchboard-contracts` #7, "reads prefer local `kanban-state-*.md` files") points at a 735 KB / 3,471-line export that contains **zero** `featureId` markers — so subtask exclusion is not merely unstated, it is impossible from the data the agent was told to prefer. An agent that reads all of that and summarises produces a board tour. That is the reported behaviour, and it is a specification defect rather than a stylistic lapse.

**Cause 3 — the injected project filter is dead context.** The kickoff prompt injects `ACTIVE_PROJECT_FILTER` and the word "project" appears zero times in the persona. The board the user is looking at is project-filtered and exclusive; `GET /kanban/plans?column=` is not filtered at all. So the agent answers about a different board than the one on screen.

### Root cause — the persona was written for the resident-manager role it no longer has

Every instruction above makes sense for an agent that owns the board all night and must justify its autonomous decisions. Once pacing belongs to the lead (plans 1–3), the orchestrator's remaining work is advisory and episodic: setup verification, scope, decomposition, and multi-team coordination. Advice is short by nature. The persona is verbose because it was specified for a job it is being relieved of.

### What the orchestrator is actually for

Three entry intents, all advisory:

1. **"I don't know what to do."** The user runs `/switchboard` with no plan. The orchestrator advises: how to set up a team, how to organise a project, what to work on first.
2. **Driving Switchboard from a non-IDE coding app.** The user activates the orchestrator and it brings the board up. The launcher already does this — `.agents/workflows/switchboard.md` step 1 health-checks `.switchboard/api-server-port.txt` and runs `npx switchboard` on a non-200 (`bin.switchboard` → `dist/standalone/cli.js`). This needs documenting in the persona, not building.
3. **Genuine coordination** — multiple teams across worktrees or separate repos, and decomposing work that is not yet shaped into plans.

What it is *not* for: pacing a one-at-a-time pipeline. That is a manager watching a manager.

---

## Metadata

- **Complexity:** 3
- **Tags:** docs, refactor, reliability

---

## User Review Required

**None.** Five decisions made here:

* **Silence is the default for a passing check.** Only failures and recommendations are spoken.
* **"Ready to go" gets one deterministic definition** — the query, its exclusions, its source and its answer shape — and the existing consumers point at that one definition so it cannot drift.
* **HTTP, not the markdown exports, for readiness questions.** The exports cannot express subtask exclusion, so preferring them is wrong for this specific question and the persona must say so.
* **Answers have stated ceilings.** A cap the agent can read is the only thing that reliably prevents a board tour.
* **The project filter is honoured.** An answer about an unfiltered board when the user is looking at a filtered one is wrong, not merely verbose.

---

## Implementation

1. **Rewrite `## The six checks` as silent checks.** Each check states its pass condition and that a pass produces **no output**. The report becomes: findings only, or the single line `Pre-flight clear.` Check 1's team recommendation stays — it is genuinely valuable — but fires only when features are in scope and no coding team is seated.

2. **Add `## The ready set` — one deterministic definition:**
   - source: `GET /kanban/plans?column=CREATED` and `?column=PLAN REVIEWED` over HTTP, never the markdown exports;
   - exclude rows with a non-empty `featureId` (subtasks — `switchboard-contracts` #6, which the persona must now cite by name);
   - exclude every other column: `LEAD/CODER/INTERN CODED` is in progress, `CODE REVIEWED` / `ACCEPTANCE TESTED` / `COMPLETED` is finished, `BACKLOG` is deliberately parked, `DISPATCH` is the staged queue;
   - filter by `ACTIVE_PROJECT_FILTER` when injected;
   - a copy-pasteable command that produces exactly this.

3. **Point the existing consumers at it.** Pre-flight check 5 and `## The Tick` both restate the lanes in prose today; replace both with a reference to `## The ready set`. One definition, two references.

4. **Answer shapes with ceilings.** A readiness answer is a list of at most N cards, one line each: id, title, complexity. More than N reports the count and the first N. No commentary on finished work, ever.

5. **Document the two advisory entries** the persona currently omits: the no-idea-what-to-do case (what to advise, in what order) and the non-IDE case (the launcher brings the board up; the orchestrator does not reimplement it).

6. **Explain `ACTIVE_PROJECT_FILTER`** where it is used, so the injected value stops being dead context.

7. **Gate it.** The persona gate that pins load-bearing sections must cover `## The ready set`, so a future rewrite cannot silently drop it. A rewritten persona reported as done but never written is otherwise invisible to CI — the sibling `retire-orchestrator-machinery` plan flagged this exact hazard for exactly this file.

---

## Verification Plan

- **Contract test:** `## The ready set` exists, names the subtask exclusion, names HTTP as the source, and states an answer ceiling. Pre-flight check 5 and `## The Tick` reference it rather than restating lanes.
- **Contract test:** the persona contains no instruction to report a passing check.
- **Manual UAT — the reported failure:** with one plan in CREATED, ask "what plans are ready to go?" The answer must be one line for that plan and nothing else. No subtasks, no CODE REVIEWED, no commentary on finished work.
- **Manual UAT:** pre-flight on a correctly-configured workspace emits `Pre-flight clear.` and nothing more.
- **Manual UAT:** pre-flight with features in scope and no coding team still produces the team recommendation, naming the features.
- **Manual UAT:** with a project filter active, the ready set matches the filtered board on screen.
- **Consistency:** no surviving reference in the persona to mechanisms plan 4 deletes.
