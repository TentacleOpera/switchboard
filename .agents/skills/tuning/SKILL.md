---
name: Tuning
description: Tune Switchboard agent behavior and workflow settings.
---

# Tuning Skill

## Purpose

Extract recurring problem patterns from adversarial review sections in completed/reviewed plans, store them as individual insight documents, and propose governance file updates.

## Modes

### Extract Mode

Receive a list of plan file paths and scan each for adversarial review sections ("Stage 1 — Grumpy Adversarial Findings" and "Stage 2 — Balanced Synthesis"). Cluster recurring problem patterns across plans and create individual insight `.md` files in `{workspaceRoot}/.switchboard/insights/`.

**Clustering criteria:**
- Same problem category (e.g., missing error handling, race conditions, prompt-design flaws, unvalidated assumptions)
- Same severity level (recurring vs critical vs minor)
- Same governance target (CONSTITUTION.md vs AGENTS.md vs CLAUDE.md)

**Deduplication:** Before creating a new insight, check existing insights in `.switchboard/insights/`. If an existing insight covers the same pattern (same category AND similar description), append new evidence to it instead of creating a duplicate. When appending, update the Source Plans list and add new evidence entries.

### Governance Mode

Read all insight files in `{workspaceRoot}/.switchboard/insights/` with status `open`. Review the insights and propose specific edits to governance files (CONSTITUTION.md, AGENTS.md, CLAUDE.md) to address the recurring patterns. Present proposed changes as diffs.

## Insight File Template

```markdown
# [Insight Title]

## Metadata
**Created:** [date]
**Source Plans:** [list of plan filenames that contributed this pattern]
**Severity:** [recurring | critical | minor]
**Status:** [open | applied | dismissed]

## Problem Pattern
[Description of the recurring issue observed across plans]

## Evidence
- **[plan-filename.md]**: [specific quote or paraphrase from the adversarial section]
- **[plan-filename.md]**: [specific quote or paraphrase]

## Recommendation
[Suggested rule or invariant to add to governance files]

## Suggested Governance Target
[CONSTITUTION.md | AGENTS.md | CLAUDE.md | .cursor/rules/]
```

**Naming convention**: `insight_[YYYYMMDD]_[short-slug].md`

## Edge Cases

- No review sections found in any plan → report zero insights created
- Existing insight covers same pattern → append evidence, don't duplicate
- Plan file missing on disk → skip gracefully
- Large number of plans → plan list may be provided via temp file path instead of inline
