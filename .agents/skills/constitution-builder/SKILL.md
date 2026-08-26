# Skill: Constitution Builder

## Overview
Interview-style skill to build or improve a lean, high-level `CONSTITUTION.md` focusing on the soul of the project (mission, target users, guiding principles, stack constraints, and non-goals) rather than detailed coding standards or formatting guidelines.

## Usage
When invoked to build or improve a constitution, lead the user through a structured interview process or gather context from the existing codebase to assemble and refine the constitution file.

## Process

### 1. Context Collection & Interview
Prompt the user with target questions or propose answers based on repository analysis:
1. **Mission**: What is the name of this project, and in one sentence, what is its primary reason for existing?
2. **Target Users**: Who are the primary users, and what is their main pain point?
3. **Guiding Principles**: What are the 3–5 non-negotiable values that should govern every technical and product decision? Give each a short name and one concrete sentence explaining what it means in practice.
4. **Technical Constraints**: What are the hard technical boundaries? List required languages, core frameworks, data stores, and key third-party services.
5. **Non-Goals**: What are specific things this project will NOT do in its current scope? (Prevents scope creep.)

### 2. Document Construction
Write the draft or updated sections strictly adhering to this template:

```markdown
# [Project Name] Constitution

> **Mission:** [one sentence]

## Guiding Principles
- **[Name]:** [concrete explanation]

## Target Users
[Who they are and their main pain point]

## Technical Constraints & Stack
- Core Language & Frameworks: ...
- Data Layer: ...
- Key External Services: ...

## Non-Goals
- [Explicit exclusion 1]
- [Explicit exclusion 2]
```

Keep the document short (under 150 lines total). Do not include coding conventions, formatting standards, or test suites, as these belong in `CLAUDE.md` or `.cursor/rules/`.
