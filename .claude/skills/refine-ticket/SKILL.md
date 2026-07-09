---
name: refine-ticket
description: Refine a ticket into a lean, agent-actionable spec — real files, testable acceptance criteria, no invented context
disable-model-invocation: true
---

# Skill: Refine Ticket

Turn a sparse ticket into a lean, actionable spec a developer can pick up. Lean is the goal — a thin, correct ticket beats a padded one. The reader will delete anything they don't need, so don't make them.

## When to Use
Triggered by clicking "Refine" on a ticket card in the Switchboard tickets tab.

## What it does
Fills the actionable core — what to build, where, and how to know it's done — and writes it back to the local markdown file. It does NOT pad the ticket with every section in a template.

## Include by default
- `## Summary` — one short paragraph: what we're building, plainly.
- `## Work Items` (or `## Tasks`) — the concrete pieces of work, each naming the real repo/file(s) it touches.
- `## Acceptance Criteria` — grouped by work item, checkboxed, testable ("given X, when Y, then Z").
- `## Flow Diagram` — Mermaid → inline PNG. Include whenever the ticket involves a flow (anything past a trivial one-step change); skip only for pure copy/config/no-flow tweaks.

## Optional sections — add ONLY when THIS ticket clearly needs it (default: omit)
- `## User Flow` — numbered steps, when behaviour isn't obvious from the summary and the diagram.
- `## Open Questions` — real unresolved blockers, each with an owner. Not a dumping ground.
- `## Dependencies`, `## Designs / References` — only if they change what a dev does.

Do NOT add `## Background / Why`, `## Assumptions`, or `## Scope` by default. Most tickets don't need them, and they're the first thing users cut.

## Hard rules
- **Never invent context.** Do not write Background, Why, business rationale, or motivation unless it's stated in the ticket or verifiable in code/spikes. Fabricated rationale gets caught and destroys trust — omit it instead.
- **Ground every claim in real code.** Before naming a file, surface, page, or handler, open it and confirm it's the one actually involved. Don't assume which repo/page/webhook applies — verify. A wrong file reference is worse than none.
- **No reader-facing meta.** A dev reads the ticket, not your reasoning about it. No "I assumed…", no self-narration, no challenged-assumptions commentary in the output.
- **Terse.** Bullets over prose. One-line acceptance criteria. Cut anything a dev wouldn't act on.

## Agent Instructions
- Read the existing ticket; keep well-written content — enhance, don't rewrite good work.
- Identify what's genuinely missing to make it actionable, and fill just that.
- Replace vague language with specific, testable criteria.
- Flow diagram: `npx @mermaid-js/mermaid-cli -i input.mmd -o output.png`, save alongside the ticket, embed as `![Flow](./{filename}.png)`.
- Preserve YAML frontmatter.
- Write the refined content back to the local file path provided in the prompt.
- Report back with a short summary of changes.
