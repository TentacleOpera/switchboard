---
description: Refine a ticket into a complete, agent-actionable specification with acceptance criteria, flow diagrams, and challenged assumptions
---

# Skill: Refine Ticket

This skill transforms any ticket (sparse or partial) into a complete, unambiguous, agent-actionable ticket.

## When to Use
Triggered by clicking "Refine" on a ticket card in the Switchboard tickets tab.

## What it does
Produces a complete best-practice ticket (acceptance criteria, user flow, flow diagrams, assumptions challenged, ambiguity eliminated), and writes the result back to the local markdown file.

## Template Sections (Flexible - Agent decides which apply)
- `## Summary` — one-paragraph plain-English description
- `## Background / Why` — context, motivation, business reason
- `## User Flow` — numbered steps (for features)
- `## Acceptance Criteria` — grouped, checkboxed, testable ("given X, when Y, then Z")
- `## Assumptions` — each assumption explicitly challenged or validated
- `## Open Questions` — unresolved ambiguities
- `## Dependencies` — upstream/downstream, blocking issues
- `## Designs / References` — mockups, screenshots, related tickets
- `## Flow Diagram` — Mermaid flowchart rendered to inline PNG (for non-trivial flows)

## Agent Instructions
- Read the existing ticket content; determine ticket type (feature, bugfix, epic, refactor).
- Identify what's missing or incomplete.
- Fill gaps intelligently — don't blindly apply all sections.
- Challenge assumptions: for each, ask "is this actually true?" and document.
- Eliminate ambiguity: replace vague language with specific, testable criteria.
- For non-trivial flows: generate Mermaid, render to PNG via `npx @mermaid-js/mermaid-cli -i input.mmd -o output.png`, save alongside ticket file, embed as `![Flow Diagram](./{filename}.png)`.
- Preserve YAML frontmatter.
- Preserve existing well-written content — enhance, don't rewrite.
- Write refined content back to the local file path provided in the prompt.
- Report back with summary of changes.

## Gold Standard Reference
- **Summary**: Plain-English description.
- **Background/Why**: Business rationale.
- **User Flow**: Steps.
- **Acceptance Criteria**: Grouped, checkboxed, testable.
- **Open Questions**: Unresolved ambiguities.
- **Designs**: With screenshots/mockups.
