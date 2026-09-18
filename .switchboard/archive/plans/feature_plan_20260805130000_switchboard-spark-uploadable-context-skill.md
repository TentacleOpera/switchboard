# `switchboard-spark` — A Generated, Uploadable Context Skill for External AI Surfaces

## Goal

Generate a single self-contained `switchboard-spark.md` that the user uploads once into Gemini Spark (or any external AI surface with no filesystem-backed skill discovery), so the prompts Switchboard already copies to the clipboard resolve correctly without the user hand-pasting `AGENTS.md` alongside every one.

### Problem & background

**The hand-off already works — the context does not travel with it.** The existing copy-prompt paths produce prompts that are correct and complete *for a host that can read the repo*. They reference skills by path — `.agents/skills/improve-plan/SKILL.md`, `.agents/skills/accuracy/SKILL.md`, `.agents/skills/advise_research/SKILL.md` (`src/services/agentPromptBuilder.ts:373, 744, 970-983`) — and they assume the receiving agent has already absorbed the protocol in `AGENTS.md`: the workflow registry, the plan-authoring and plan-sizing rules, the project-pinning protocol, and the rule that plan writes go to `.switchboard/` and never invent board state.

A local agent gets that for free. Gemini Spark does not. Today the user has to paste `AGENTS.md` in as context alongside each copied prompt — which is the friction this plan removes.

**Root cause: skill discovery is host-split, and Spark is a third mode nobody has built for.** Claude Code discovers skills through `MIRROR_MANIFEST` in `ClaudeCodeMirrorService.ts:47`, which generates `.claude/skills/` and tracks what it wrote in `.claude/.switchboard-generated.json` (`:254`). Antigravity discovers them by reading the filesystem directly. Spark discovers nothing — it has no repo-relative resolution for `.agents/skills/<name>/SKILL.md` and no persistent project context unless the user uploads one. So the third mode is **manual upload of a single self-contained artifact**, and nothing in the codebase produces one.

**Why it must be generated, not hand-written.** `AGENTS.md`, the workflow registry and the skill set change. A hand-authored Spark context file is a fourth copy of the control plane that silently drifts from the other three the first time a skill is renamed or a workflow moves — the documented host-drift trap. `ClaudeCodeMirrorService` already solves exactly this shape for Claude Code: read from `.agents/` + `AGENTS.md` as the single source of truth, emit a host-specific artifact, track what was emitted. This plan adds a second emitter beside it, not a second source of truth.

**Scope boundary.** This is a context artifact and its generator. It does not add launchers (sibling plan), does not change any prompt the board already produces, and does not give Spark board access.

---

## Metadata
**Complexity:** 4
**Tags:** docs, backend, feature
**Project:** browser-switchboard

---

## User Review Required

**None.** Two decisions made here rather than deferred:

* **One file, not a skill tree.** Spark takes an upload, not a directory. The artifact is a single self-contained markdown file with the protocol inlined — not a manifest pointing at paths Spark cannot resolve.
* **Generated into `.switchboard/`, not committed to `.agents/`.** It is a build output derived from `.agents/` + `AGENTS.md`, so it belongs beside other generated state, and committing it would invite hand-edits that drift.

---

## Complexity Audit
* **Score:** 4 / 10

### Routine
* Reading `AGENTS.md` (165 lines) and a small set of skill files and concatenating them under headings.
* Writing one file to `.switchboard/`.
* A button in the Connections panel to regenerate and reveal it.

### Complex / Risky
* **Drift is the failure mode, and it is silent.** A stale uploaded file is indistinguishable from a fresh one from the user's side: Spark keeps following last month's protocol and produces plausible, wrong output. Whatever is emitted must carry a generation timestamp and the extension version, and the panel must make regeneration obvious after an upgrade.
* **Selection, not concatenation.** Dumping every skill produces something too large and mostly irrelevant. Choosing what an *external authoring/review* agent needs — and excluding everything that assumes shell, `LocalApiServer` or board mutation — is the actual design work.
* **Instructions that assume capabilities Spark lacks are worse than absent ones.** `AGENTS.md` is full of directives to run `.agents/skills/kanban_operations/*.js`, `curl` the API, and query `kanban.db`. Emitted verbatim into a Spark context, those become instructions the model will try to follow and cannot, producing invented results. They must be stripped or explicitly negated.
* **Source-of-truth discipline.** Edits go to `.agents/` + `AGENTS.md`. `CLAUDE.md` and `.claude/skills/` are generated mirrors; the Spark artifact becomes a third generated output and must never be edited by hand.

---

## Edge-Case & Dependency Audit

### Race Conditions
* None. One-shot generation, single writer, no polling.

### Security
* **The artifact is uploaded to a third-party AI service — treat everything in it as published.** No tokens, no secrets, no absolute paths outside the workspace, no machine identifiers. Assert this in the generator rather than trusting the source files: `AGENTS.md` is safe today, but a future edit could add something that is not.
* Workspace-relative paths are fine and necessary (the write-back convention needs them). Absolute host paths are not.

### Side Effects
* One new generated file in `.switchboard/`. Add it to `.gitignore` if generated artifacts there are ignored by convention; check before assuming.
* Users on older extension versions will have older artifacts. Harmless, but it is exactly why the version stamp matters.

### Dependencies & Conflicts
* **Precedent and pattern — `src/services/ClaudeCodeMirrorService.ts`**: `MIRROR_MANIFEST` (`:47`), `resolveSourceFile` (`:390`), `buildSkillMd` (`:404`), `generateClaudeMirror` (`:428`), generated-file tracking (`:254`), and the dynamic scan of `.agents/skills/` at `:462`. Mirror this structure; do not invent a parallel one.
* Source content — `AGENTS.md` (165 lines), `.agents/skills/`, `.agents/workflows/`.
* Skill paths referenced by existing prompts — `src/services/agentPromptBuilder.ts:373, 744, 970-983` (including the legacy-path remap table, which the generator should respect so an old path in a prompt still resolves to the right content).
* Connections panel — the regenerate/reveal button lands there (sibling plan). Buildable and shippable without it; the generator can run on activation.
* **Not a dependency:** the External-Agent Skill Launchers plan. That plan is already reviewed and is not modified by this one. The two compose — launchers produce prompts, this produces the context those prompts assume — but neither blocks the other.

---

## Dependencies
* None.

---

## Adversarial Synthesis

Key risks: (1) **silent staleness** — an uploaded artifact from three versions ago looks identical to a current one from the user's side, and Spark will confidently follow a protocol that no longer exists; (2) **emitting instructions Spark cannot perform** — `AGENTS.md` is dense with shell, `kanban.db` and `LocalApiServer` directives that a shell-less surface will attempt and fake, which is worse than omitting them; (3) **becoming a fourth source of truth** — a hand-maintained Spark context drifts from `.agents/` the first time a skill moves. Mitigations: stamp every artifact with extension version and generation time and surface a regenerate prompt after upgrade; curate the emitted set and add an explicit capabilities section stating what the receiving agent must not attempt; generate from `.agents/` + `AGENTS.md` using the `ClaudeCodeMirrorService` pattern so there is one source and two emitters.

---

## Proposed Changes

**Build order:** (1) generator → (2) content curation → (3) surfacing.

### 1. `src/services/SparkContextExporter.ts` (new) — the generator

**Context:** `ClaudeCodeMirrorService` already reads `.agents/` and emits a host-specific artifact with generated-file tracking. This is the same shape with a different output form: one concatenated file instead of a skill tree.

**Implementation:**
* `generateSparkContext(rootDir, extensionVersion): { path: string; bytes: number; sections: string[] }`.
* Resolve sources through the same helper shape as `resolveSourceFile` (`ClaudeCodeMirrorService.ts:390`) so the `.agents/` → `.agent/` legacy fallback behaves identically.
* Emit to `<workspaceRoot>/.switchboard/switchboard-spark.md`.
* Header block carrying: extension version, generation timestamp, the workspace name, and one line telling the user to re-upload after upgrading Switchboard.

**Logic:** a single file because that is what the receiving surface accepts. A manifest of paths would be correct for a filesystem host and useless here.

**Edge cases:** a missing source file is a skipped section with a logged warning, never a thrown error — a partially useful artifact beats no artifact. Report skipped sections in the return value so the panel can show them.

### 2. Content curation — what goes in

**Include:**
* The `AGENTS.md` protocol sections that govern authoring: the plan-authoring and problem-analysis protocol, plan sizing, workspace detection, and **project pinning** — specifically the rule that the agent must not guess a project and should omit the pin when none is given. An external agent has no way to resolve the active project and will otherwise invent one.
* Plan-file conventions: filename shape, required sections, and the fact that plan IDs are assigned by the importer and must never be hand-written.
* The authoring/review skills an external surface can actually execute — the `improve-plan` and `improve-feature` section schemas and the memo protocol.
* A **write-back convention** section: results are written to the named absolute path under `.switchboard/`; the local watcher imports them; the agent creates no board state itself.

**Exclude, and say so explicitly:**
* Everything requiring shell, `LocalApiServer`, `kanban.db` or `.agents/skills/kanban_operations/*.js`.
* Card movement, dispatch, feature linking — anything that mutates the board.

**Override, do not merely exclude — the research directive.** Switchboard's `advise_research` directive has exactly two branches today (`src/services/agentPromptBuilder.ts:744, 747`): POST the prompt to `/research/dispatch` if a Researcher agent is registered, otherwise **"supply the ready-to-run research prompt at the very end of your chat summary"** so the user can run it themselves. Both branches are wrong for this audience. The HTTP branch is unreachable, and the chat-summary fallback hands the user homework on a surface that **can dispatch its own research sub-agents**.

So the artifact must carry a third branch, stated as an override of the directive the copied prompt will also contain:

> When the prompt tells you to emit a research prompt for the user, or to POST to a research endpoint, do neither. **Dispatch your own research agent**, wait for it, and fold the findings into the artifact you are producing. Record what was researched and what it concluded in the `## Uncertain Assumptions` section, marking each item resolved or still open — do not leave a prompt for the user to run.

**Logic:** this is the difference between an external surface being a slower terminal and being better than one at a specific job. Leaving the fallback in place would make Spark produce plans that end with "here is a research prompt, please run it" — strictly worse than what it is capable of, and the user then does the work manually.

**Implementation:** end with a short `## What you cannot do here` section listing the exclusions in the imperative, and a `## Where these instructions override the prompt` section carrying the research override above. Stripping an instruction leaves a gap the model fills by guessing; negating it explicitly does not. An *override* needs to be louder still, because the contradicting instruction arrives in the same context window via the pasted prompt — state plainly that the uploaded context wins.

**Edge cases:** keep the artifact small enough to sit comfortably in a persistent-context slot. If curation pushes it large, cut skill *examples* before cutting protocol rules — the rules are what the copied prompts depend on.

### 3. Surfacing

* Generate on activation when absent or when the stamped extension version differs from the running one, following the `ClaudeCodeMirrorService` regeneration trigger.
* In the Connections panel (sibling plan): a **Regenerate Spark context** button plus a reveal-in-folder action, with the current stamp displayed so staleness is visible at a glance.
* Panel copy states the one-time setup: upload this file into Spark as persistent context, then paste board prompts without re-attaching `AGENTS.md`.

**Edge cases:** if the Connections panel has not landed yet, activation-time generation alone is sufficient to ship this plan — the file simply lives in `.switchboard/` for the user to find.

---

## Verification Plan

### Automated Tests
Tests are skipped per session directive, and compilation is skipped per session directive. Target coverage for the coding pass:
* Generator unit tests: every expected section present; a missing source file yields a skipped section and a warning rather than a throw; the header carries version and timestamp.
* A **secret-leak assertion** over the generated output — no token-shaped strings, no absolute paths outside the workspace root.
* A staleness test: a stamp from a different extension version triggers regeneration.

### Manual Verification
1. **Generate:** the file appears at `.switchboard/switchboard-spark.md` with a correct version and timestamp.
2. **Read it as the audience would:** it must stand alone. A reader with no repo access should be able to follow it — no dangling references to paths Spark cannot open.
3. **End-to-end, the only test that matters:** upload it into Spark as persistent context, then copy a real board prompt and paste it **without** attaching `AGENTS.md`. Spark should produce a correctly structured plan or review, write it back to the named path, and the watcher should import it.
4. **Negative control:** the same prompt in a Spark session **without** the uploaded context should visibly do worse — wrong sections, invented project pin, or an attempt to run shell commands. If there is no observable difference, the artifact is not carrying its weight and the curation needs revisiting.
5. **No invented pin:** confirm the plans Spark produces omit `**Project:**` rather than guessing one, or carry a pin that actually resolves.
6. **No impossible actions:** confirm Spark does not claim to have moved a card, dispatched a *coding* agent or queried the database.
7. **Research override fires:** give it a plan with a genuine external unknown. It must dispatch its own research agent and fold the findings into `## Uncertain Assumptions` — **not** end the artifact with a ready-to-run research prompt for the user. A trailing research prompt means the pasted directive beat the uploaded context and the override needs to be stated more forcefully.
8. **Staleness path:** bump the version, confirm the regeneration trigger fires and the panel shows the new stamp.
9. **Plan import:** confirm the importer registers this plan on the board.

---

## Recommendation

Complexity 4 → **Send to Coder.**

---

## Review Findings

**Not complete — the generator exists and never runs.** `src/services/SparkContextExporter.ts` was created, but it has **zero callers**: the activation-time generation this plan named as its one shipping requirement ("generate on activation when absent or when the stamped version differs") does not exist, so `.switchboard/switchboard-spark.md` is never produced. MAJOR findings: it *concatenates* rather than curates — `AGENTS.md` is emitted verbatim including every `kanban_operations/*.js`, `sqlite3 kanban.db` and `curl` directive the plan said must be "stripped or explicitly negated", and the two-line "What You Cannot Do" section does not negate them item by item; there is no `.agent/` legacy fallback (the plan asked for the `resolveSourceFile` shape); there is no staleness comparison, only a stamp; and no secret-leak assertion over the output. CRITICAL cross-plan gap: §6 of the scheduled-jobs plan — the `instructions/` tree, claim-marker protocol, run-log line format, `kanban-state-<column>.md` format with its frozen-between-sessions caveat, the moves grammar and the standing-job frontmatter — is entirely absent, and this artifact is the *only* channel by which a 3am cron agent learns any of it. No fixes applied: curating the emitted set is the plan's stated design work, not a review repair. Validation: `tsc --noEmit` and `npm run lint` pass; the plan's generator, secret-leak and staleness tests do not exist and are wired into no CI job.

### Second review pass (post-coder)

**Partly closed.** A `regenerateSparkContext` verb now calls the generator, so it is no longer unreachable — though like its sibling it was added without `npm run catalog:generate`, leaving it out of `SETUP_VERBS` and therefore a guaranteed dead click; catalog regenerated in this pass. It also failed to compile: `this._context?.extension?.packageJSON?.version` at `SetupPanelProvider.ts:337` referenced a field this class does not have (it is constructed with an extension URI only), breaking `tsc` for the whole repo — replaced with a `getExtensionVersion(extensionUri)` helper that reads the packaged `package.json` and returns `'unknown'` rather than a plausible-looking constant, since a wrong version stamp would read as fresh forever. A `## Scheduled Jobs & Instruction Inbox Protocol` section was added covering the inbox, claim markers, standing jobs, the moves grammar and the run-log — real progress, but it omits the staleness window, the `kanban-state-<column>.md` line format with its frozen-between-sessions caveat, the mtime supplement and the standing-job frontmatter shape, and it instructs the agent to read `.switchboard/instructions/`, which nothing creates (see the jobs plan). **Still outstanding:** no activation-time generation and no version-staleness trigger — the plan's stated shipping requirement — plus verbatim `AGENTS.md` concatenation, no `.agent/` legacy fallback, and no secret-leak assertion.

### Third review pass (post-coder)

**Activation-time generation landed; one CRITICAL fixed.** `extension.ts:432` now calls `generateSparkContext` per workspace root during `refreshWorkspaceControlPlane`, closing the plan's shipping requirement. But the generator ended with an unconditional `mkdirSync(dirname(outputPath))`, so running on activation for *every* root scaffolded `.switchboard/` — and a `switchboard-spark.md` inside it — into folders that had never opted into Switchboard. That is the documented scaffold-litter failure, and the same rule `bootstrapInstructionsDirectory` had just been fixed to respect. Generation now returns early with `bytes: 0` and a skipped-section note when `.switchboard/` is absent, and the trailing mkdir is gone; a contract test pins both the skip and the version stamp. Still outstanding: generation runs unconditionally rather than on absence-or-version-change (harmless but it rewrites the file every activation), `AGENTS.md` is still emitted verbatim rather than curated, and there is no `.agent/` legacy fallback or secret-leak assertion.

### Fourth review pass — curation landed; one CRITICAL parser bug fixed

**All six curation asks are implemented.** Real section selection via `curateAgentsMd` + a `WANTED_AGENTS_SECTIONS` allowlist; omitted sections enumerated **by name** with an imperative "do not act on its instructions" rather than stripped silently; the §6 jobs contract completed; `.agent/` legacy fallback through `resolveSourceFile`; activation-time generation gated on absence-or-version-mismatch (`extension.ts:440-450`); and the anti-confabulation rule carried in the artifact. A contract suite exists and is wired into `package.json` and CI.

**CRITICAL (fixed): the curator selected nothing from the real `AGENTS.md`.** `parseH2Sections` split on `## ` only, but every wanted section in the actual file is an `###` nested under the single `##`. Against the real input the parser found one section, matched none of the four wanted titles, and emitted an artifact with an **empty** "Included" list and no protocol body at all — emptier than the verbatim dump it replaced, and the exact friction this plan exists to remove. Fixed to split on heading level 2 **or 3** (`/^#{2,3}\s+\S/`, with a matching strip); verified against the repo's own `AGENTS.md`, which now yields all four sections and a 14.7 KB artifact carrying the pinning rules in the body.

**Why the suite was green over it — worth noting for future tests.** The curation test asserted against a hand-written `sampleAgentsMd` fixture that used `##` for the wanted sections, so the fake matched the parser's assumption while the real file did not. Same failure class as the earlier `db.all`/`db.run` fakes: a stand-in modelled on the expected interface rather than the real one. Added a test that runs the generator against the **repo's real `AGENTS.md`** and asserts the Included list is non-empty, contains all four titles, that the pinning rules appear in the body, and that the artifact exceeds 4 KB — assertions no convenient fixture can satisfy.

**Remaining risk:** none blocking. Validation: tsc, lint, all six gates, `test:contract:spark-context-exporter` 9/9.
