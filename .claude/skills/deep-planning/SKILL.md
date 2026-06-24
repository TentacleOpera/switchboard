---
name: deep-planning
description: Produce a deep implementation plan for a codebase change, with research and adversarial review.
allowed-tools: Read, Glob, Grep, WebSearch, WebFetch
user-invokable: false
---

# Deep Planning for Codebase Changes

## Purpose
Perform comprehensive planning for codebase edits by combining internal codebase analysis with external best practices research. This hybrid approach produces implementation plans that account for both codebase reality and industry standards.

## When to Use
- User requests complex code changes that require understanding existing architecture
- Planning refactoring, feature additions, or cross-cutting concerns
- User needs "super plans" that go beyond simple code analysis
- Assessing impact of changes across multiple files/modules
- Evaluating security, performance, or best practice implications

## Research Protocol

### Phase 0: Planning Proposal
Before conducting any analysis, propose a planning approach to the user for approval:

**Present the plan with:**
1. **Planning objectives**: What specific change will be planned and what questions will be answered
2. **Research depth options**: Present source count options for user to choose:
   - **Quick (5-10 sources)**: Rapid overview, codebase-only analysis, high-level plan
   - **Standard (15-30 sources)**: Balanced depth, codebase + targeted web research, moderate detail
   - **Deep (50-100+ sources)**: Comprehensive analysis, extensive web research, exhaustive coverage
   - **Academic (100-200+ sources)**: Scholarly rigor, includes academic papers, systematic review
3. **Analysis strategy**: Codebase search patterns and web research domains to target
4. **Expected sources**: Types of sources (code files, docs, Stack Overflow, official docs, etc.)
5. **Scope**: What will and won't be covered (files, modules, external research)
6. **Estimated phases**: Brief outline of analysis phases
7. **Estimated time**: Time estimate based on chosen depth level
8. **Clarifying questions**: If the codebase context or requirements are thin or missing crucial details, formulate 2-3 specific clarifying questions and include them at the end of the proposal.

**Wait for user response:**
- If approved: Proceed with Phase 1
- If amendments requested: Revise plan and re-present
- If rejected: Clarify requirements and propose new plan
- If clarifying questions were posed: wait for answers before proceeding to Phase 1. Incorporate answers into the refined planning approach.

### Phase 1: Codebase Exploration (Internal Analysis)
**Before starting**: Check system date/time for any time-sensitive web research later.

Run parallel codebase searches:
1. **Find relevant files**: `find_by_name` with patterns for file types, extensions, or names
2. **Search for patterns**: `Grep` for function names, class names, imports, or specific code patterns
3. **Identify dependencies**: Search for import statements, require calls, or dependency declarations
4. **Map structure**: List directory structures and identify module organization

**Read key files**: Use `read_file` to examine:
- Core implementation files
- Configuration files
- Test files related to the change area
- Documentation files (README, docs/, inline comments)

### Phase 2: External Best Practices Research (Web Research)
Based on codebase findings, run targeted web searches:

**Check system time** and use dynamic date ranges (current year and previous 2 years).

Search for:
1. **Best practices**: `search_web "problem domain best practices [current_year] [current_year-1]"`
2. **Stack Overflow**: `search_web "specific problem stackoverflow"` or `domain="stackoverflow.com"`
3. **Official documentation**: `search_web "framework/library documentation"` with relevant domains
4. **Security advisories**: `search_web "security vulnerability [technology]"`
5. **Similar implementations**: `search_web "github open source similar pattern"`

### Phase 3: Cross-Reference Analysis
Compare internal codebase findings with external research:

- **Gap analysis**: Identify where current implementation differs from best practices
- **Anti-patterns**: Note patterns flagged as problematic in external research
- **Security issues**: Check for vulnerabilities mentioned in advisories
- **Performance considerations**: Research performance implications of current vs. recommended approaches
- **Dependencies**: Verify if dependencies are up-to-date and secure

### Phase 4: Synthesis and Plan Generation
Combine codebase analysis and external research into a comprehensive plan:

**Plan structure:**
1. **Current state assessment**: What exists in the codebase now
2. **Proposed changes**: Specific files and modifications needed
3. **Rationale**: Why these changes are needed (backed by both code analysis and research)
4. **Dependencies and impact**: What other parts of the codebase are affected
5. **Risk assessment**: Security, performance, and compatibility risks
6. **Testing strategy**: What tests to add or modify
7. **Rollback plan**: How to revert if issues arise
8. **Implementation order**: Phased approach if changes are complex

## Output Format

Present the plan as:
1. **Executive Summary**: Key changes and rationale in 3-5 bullet points
2. **Current State Analysis**: Codebase findings with file references
3. **External Research Findings**: Best practices and advisories with source attribution
4. **Proposed Implementation Plan**: Detailed changes with file paths and code snippets
5. **Impact Analysis**: Dependencies, risks, and testing requirements
6. **Source Credibility Assessment**: Note which sources are most authoritative
7. **Knowledge Gaps**: What couldn't be determined and requires investigation
8. **Recommended Next Steps**: If deeper analysis or prototyping is needed

## Tools Reference

**Codebase analysis tools:**
- `find_by_name`: Search for files by name, pattern, or extension
- `Grep`: Search file contents with regex patterns
- `read_file`: Read file contents
- `list_dir`: Explore directory structures

**Web research tools:**
- `search_web`: Search the web with optional domain filters
- `read_url_content`: Read content from specific URLs

## Example Usage

**User**: "Plan how to add authentication to this REST API"

**You** (Phase 0 proposal):
- Objectives: Add JWT authentication to existing REST endpoints
- Depth: Standard (15-30 sources) - codebase analysis + web research on auth best practices
- Strategy: Analyze current API structure, research JWT implementation patterns, compare with security standards
- Scope: API routes, middleware, user models, token storage
- Phases: Codebase exploration → Auth pattern research → Security advisory check → Implementation plan

**After approval**:
1. Phase 1: Find API route files, middleware, user models
2. Phase 2: Research JWT best practices, security considerations, common pitfalls
3. Phase 3: Compare current API structure with recommended auth patterns
4. Phase 4: Generate detailed implementation plan with middleware, route changes, and testing strategy
