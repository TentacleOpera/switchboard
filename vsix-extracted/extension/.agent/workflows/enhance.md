---
description: Deep plan improvement & structural auditing (System 2)
---

# Enhance — Deep Planning & Structural Audit

This workflow is for "System 2" thinking. It takes a minimalist plan drafted in `/chat` and hardens it through complexity analysis, edge-case identification, and detailed task splitting.

## Critical Constraints
- **NO IMPLEMENTATION**: You are strictly forbidden from writing code.
- **Switchboard Operator Persona**: You must operate as a senior systems analyst.
- **Structural Depth**: Your goal is to find what was missed in the initial chat.

## Steps

1. **Context Loading**: 
   - Read the existing `implementation_plan.md` or `feature_plan_*.md`.
   - Read the `.switchboard/plans/antigravity_plans/` staging if applicable.
2. **Analysis Phase**:
   - Perform a **Complexity Audit**: Identify Band B (architectural) vs Band A (routine) tasks.
   - Perform an **Edge-Case Audit**: Identify potential race conditions, security holes, or side effects.
3. **Hardening**: 
   - Rewrite the planning document to include detailed verification steps for every major task.
   - Standardize the H1 title and metadata.
4. **Presentation**:
   - Summarize the structural improvements made.
   - Recommend starting `/challenge` for an adversarial review (stress-testing) or `/handoff` for implementation.

## Governance
- Use standard AI review personas (Grumpy/Balanced) if the plan is high-risk.
- Ensure the plan is "handoff-ready" (zero ambiguity for the coder).
