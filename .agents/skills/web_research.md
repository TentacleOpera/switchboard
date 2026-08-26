# Comprehensive Web Research

## Purpose
Perform deep, multi-angle web research on any topic using iterative search strategies.

## When to Use
- User asks to "research X", "investigate Y", "find comprehensive information about Z"
- User needs authoritative sources, comparisons, or deep dives
- User asks for "latest information on", "state of the art in", "best practices for"

## Research Protocol

### Phase 0: Research Plan Proposal
Before conducting any searches, propose a research plan to the user for approval:

**Present the plan with:**
1. **Research objectives**: What specific questions will be answered
2. **Research depth options**: Present source count options for user to choose:
   - **Quick (5-10 sources)**: Rapid overview, 1-2 search phases, high-level summary
   - **Standard (15-30 sources)**: Balanced depth, 3-4 search phases, moderate detail
   - **Deep (50-100+ sources)**: Comprehensive analysis, 5+ search phases, exhaustive coverage
   - **Academic (100-200+ sources)**: Scholarly rigor, includes academic databases, systematic review
3. **Search strategy**: Initial search queries and domains to target
4. **Expected sources**: Types of sources (official docs, academic papers, industry reports, etc.)
5. **Scope**: What will and won't be covered
6. **Estimated phases**: Brief outline of research phases
7. **Estimated time**: Time estimate based on chosen depth level
8. **Clarifying questions**: If the research topic or context is thin, vague, or missing crucial details (e.g. tech stack, target regulations, country limits), formulate 2-3 specific clarifying questions and include them at the end of the proposal.

**Wait for user response:**
- If approved: Proceed with Phase 1
- If amendments requested: Revise plan and re-present
- If rejected: Clarify requirements and propose new plan
- If clarifying questions were posed: wait for answers before proceeding to Phase 1. Incorporate answers into the refined research plan.

### Phase 1: Initial Broad Search
**Before starting**: Check system date/time and use dynamic date ranges in queries (e.g., current year and previous 2 years).

Run 3-4 parallel searches with different query formulations:
1. **Core topic**: `search_web "topic"`
2. **Latest developments**: `search_web "topic [current_year] [current_year-1] [current_year-2] latest"` (use dynamic years)
3. **Best practices/guides**: `search_web "topic best practices guide"`
4. **Comparisons/alternatives**: `search_web "topic vs alternatives comparison"`

### Phase 2: Domain-Specific Deep Dive
Based on initial results, run targeted searches:
- **Academic/research**: `search_web "topic" domain="scholar.google.com"`
- **Documentation**: `search_web "topic documentation" domain="developer.mozilla.org OR docs.python.org"`
- **Community discussions**: `search_web "topic reddit stackoverflow"`

### Phase 3: Iterative Refinement
- Extract key terms, names, technologies from results
- Run follow-up searches on specific subtopics
- Verify claims across multiple sources

### Phase 4: Synthesis
- Cross-reference findings from different sources
- Identify consensus vs. controversy
- Note source credibility (official docs vs. blogs vs. forums)

## Output Format

Present research as:
1. **Executive Summary**: Key findings in 3-5 bullet points
2. **Detailed Findings**: Organized by subtopic with source attribution
3. **Source Credibility Assessment**: Note which sources are most authoritative
4. **Knowledge Gaps**: What couldn't be found or needs verification
5. **Recommended Next Searches**: If deeper research needed

## Example Usage

**User**: "Research the current state of Rust web frameworks"

**You**:
1. Run Phase 1 searches in parallel
2. Identify key frameworks (Actix, Axum, Rocket, Warp)
3. Run Phase 2 searches on each framework
4. Synthesize comparison with performance benchmarks, ecosystem maturity, adoption trends
