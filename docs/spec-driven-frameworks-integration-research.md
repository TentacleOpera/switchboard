# Research Report: Spec-Driven Development Frameworks Integration for Switchboard

## Executive Summary

**Key Findings:**
- Switchboard's planner is highly opinionated (strict template, adversarial review, complexity scoring, Kanban workflow)
- Major competing frameworks: GSD (51K stars), Superpowers (149K stars), BMAD, SpecKit (GitHub official), GSTACK (71K stars)
- Each framework solves different problems: context rot (GSD), test discipline (Superpowers), team simulation (GSTACK), spec-first workflow (SpecKit)
- Engine-Adapter pattern is the proven architecture for framework-agnostic tools
- Users may abandon Switchboard if forced into its rigid workflow when they prefer other methodologies

**Primary Recommendation:**
Implement a pluggable framework adapter system that allows Switchboard to support multiple planning methodologies while preserving its core value (multi-agent coordination, Kanban execution).

---

## Framework Deep Dives

### GSD (Get Shit Done) - 51K GitHub Stars

**Core Methodology:**
- Prevents context rot through fresh subagent contexts
- Hierarchy: Milestone → Slice (4-10 per milestone) → Task (1-7 per slice)
- Iron rule: Each task must fit in one context window
- Phase-based workflow: Plan → Execute → Complete → Reassess → Validate

**Workflow Commands:**
- `/gsd:new-project`, `/gsd:plan-phase`, `/gsd:execute-phase`, `/gsd:verify-work`
- State persistence via Markdown files (STATE.md, ROADMAP.md, PLAN.md)
- Goal-backward verification (check what must be TRUE, not what tasks were done)

**Strengths:**
- Excellent for long projects spanning multiple days/sessions
- Context engineering prevents degradation
- Automated git strategy (branch-per-slice with squash merge)

**Weaknesses:**
- Heavy ceremony for quick single-file changes
- More complex setup than simpler frameworks

**Integration Considerations:**
- Switchboard could adopt GSD's state-to-disk approach for long-running plans
- Milestone/slice/task hierarchy maps well to Kanban columns
- Context window management is already handled by Switchboard's agent system

---

### Superpowers - 149K GitHub Stars

**Core Methodology:**
- Skills-based framework with automatic skill triggering
- 7-phase workflow: brainstorming → using-git-worktrees → writing-plans → subagent-driven-development → test-driven-development → requesting-code-review → finishing-a-development-branch
- Enforces TDD (RED-GREEN-REFACTOR)
- Two-stage review: spec compliance, then code quality

**Key Skills:**
- Brainstorming, writing-plans, test-driven-development, subagent-driven-development, requesting-code-review
- Bite-sized tasks (2-5 minutes each)
- Automatic skill triggering based on context

**Strengths:**
- Proven results (chardet v7.0 achieved 41x performance improvement)
- Strong test discipline
- Works with multiple IDEs (Claude Code, Cursor, Codex, etc.)

**Weaknesses:**
- Mega-orchestrator pattern can hit context limits on very long sessions
- Rigid workflow may feel constraining for experienced developers

**Integration Considerations:**
- Switchboard's adversarial review (Grumpy/Balanced) is similar to Superpowers' two-stage review
- Skills-based approach could be adapted to Switchboard's workflow system
- TDD enforcement could be optional rather than mandatory

---

### BMAD (Build More Architect Dreams)

**Core Methodology:**
- 21 specialized AI agents, 50+ guided workflows
- Simulates entire agile team (PM, Architect, Developer, UX, Security, etc.)
- Scale-domain-adaptive (adjusts planning depth based on project complexity)
- Complete lifecycle from brainstorming to deployment

**Strengths:**
- Most comprehensive framework available
- True scale-adaptive intelligence
- Party mode for multi-agent collaboration

**Weaknesses:**
- Heavyweight for simple projects
- May be overkill for many use cases

**Integration Considerations:**
- Switchboard already has multi-agent capabilities
- Could adopt BMAD's scale-adaptive approach for complexity scoring
- Party mode aligns with Switchboard's team collaboration features

---

### SpecKit (GitHub Official)

**Core Methodology:**
- Official GitHub toolkit for spec-driven development
- Workflow: constitution → specify → plan → tasks → implement
- Intent-driven development (specifications define "what" before "how")
- Test-driven development structure with checkpoint validation

**Commands:**
- `/speckit.constitution`, `/speckit.specify`, `/speckit.plan`, `/speckit.tasks`, `/speckit.implement`

**Strengths:**
- Official GitHub backing
- Clear separation of concerns
- Well-documented process

**Weaknesses:**
- GitHub-specific (less portable)
- More ceremony than some users want

**Integration Considerations:**
- Constitution concept could be adapted for project-level governance
- Step-based workflow similar to Switchboard's phased approach
- Could be offered as one of multiple planning methodologies

---

### GSTACK - 71K GitHub Stars

**Core Methodology:**
- Models a 23-person team (CEO, PM, QA, Engineer, Designer, Security, etc.)
- Five layers of constraint: role focus, data flow, quality control, "boil the lake", simplicity
- Role isolation prevents scope creep

**Commands:**
- `/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/review`, `/qa`, `/ship`, `/cso`

**Strengths:**
- Excellent for product development (not just infrastructure)
- "Boil the lake" principle (do fewer things, do them right)
- Strong governance

**Weaknesses:**
- Heavyweight for pure infrastructure work
- 23 roles may be overkill for many projects

**Integration Considerations:**
- Role-based approach could enhance Switchboard's agent system
- Quality control gates align with Switchboard's verification
- May be too complex for Switchboard's current scope

---

## Integration Pattern Analysis

### Common Abstractions Across Frameworks

**Shared Concepts:**
1. **Phased Workflows** - All frameworks use multi-phase approaches (plan → execute → verify)
2. **State Persistence** - All use files to track progress (Markdown, JSON, etc.)
3. **Verification Gates** - Quality checkpoints between phases
4. **Hierarchical Decomposition** - Breaking work into smaller units (milestone/slice/task, phases, etc.)
5. **Role/Agent Specialization** - Different agents for different concerns

**Key Differences:**
- **GSD**: Focuses on context management and state-to-disk handoffs
- **Superpowers**: Emphasizes test discipline and skills
- **BMAD**: Simulates full agile team with scale-adaptive planning
- **SpecKit**: Spec-first with constitution-based governance
- **GSTACK**: Role-based governance with 23 specialist roles

---

### Engine-Adapter Pattern

**Architecture:**
```
Core Engine (Framework-Agnostic)
    ↓
Adapters (Framework-Specific)
    ↓
Specific Frameworks (GSD, Superpowers, etc.)
```

**Benefits:**
- Infinite reach (add new framework support in ~10 minutes)
- God-tier testing (unit test core engine without framework dependencies)
- Monorepo-ready (publish separate packages)

**Implementation:**
- Core engine accepts standard inputs/outputs
- Adapters translate framework-specific formats to standard format
- Each adapter is ~20 lines of translation code

---

### Existing Multi-Framework Tools

**Microsoft Agent Framework:**
- Composes coding-capable agents alongside other agents in multi-agent workflows
- A2A (Agent-to-Agent) protocol for inter-agent communication
- Session-based state management

**Pulumi Workflow Integration:**
- Frameworks solve "how" of orchestration, skills solve "what"
- GSD's state-to-disk pairs with Pulumi stack outputs
- Superpowers' TDD maps to infrastructure validation

---

## Concrete Recommendations for Switchboard

### Recommendation 1: Implement Framework Adapter System

**Architecture:**
```
Switchboard Core Engine (Framework-Agnostic Planning)
    ↓
Framework Adapters
    ├── Switchboard Native (current)
    ├── GSD Adapter
    ├── Superpowers Adapter
    ├── SpecKit Adapter
    └── Custom User Adapters
```

**Implementation Steps:**
1. Extract Switchboard's current planning logic into a `CorePlanningEngine` class
2. Define standard interface: `PlanInput` → `PlanOutput`
3. Create `SwitchboardNativeAdapter` (current behavior)
4. Implement `GSDAdapter` (translates GSD milestone/slice/task to Switchboard format)
5. Implement `SuperpowersAdapter` (translates skills/phases to Switchboard format)
6. Add framework selection UI in planning panel

**Benefits:**
- Users can choose their preferred methodology
- Switchboard's core value (multi-agent coordination, Kanban) preserved
- Easy to add new frameworks

---

### Recommendation 2: Make Plan Template Configurable

**Current State:**
- Strict template with required sections (Goal, Metadata, Complexity Audit, Edge-Case & Dependency Audit, Dependencies, Adversarial Synthesis, Proposed Changes, Verification Plan)

**Proposed Change:**
```typescript
interface PlanTemplate {
  requiredSections: string[];
  optionalSections: string[];
  customSections?: string[];
  sectionOrder?: string[];
}

const templates: Record<string, PlanTemplate> = {
  switchboard: { /* current template */ },
  gsd: { /* GSD-style template */ },
  superpowers: { /* Superpowers-style template */ },
  minimal: { /* minimal template for quick tasks */ },
  custom: { /* user-defined */ }
}
```

**Implementation:**
- Add template selection in planning panel
- Allow users to create custom templates
- Validate plans against selected template
- Preserve backward compatibility (default to Switchboard template)

---

### Recommendation 3: Modular Workflow System

**Current State:**
- Hardcoded workflows: `/improve-plan`, `/accuracy`, `/chat`
- Strict enforcement in AGENTS.md

**Proposed Change:**
```typescript
interface WorkflowPhase {
  name: string;
  required: boolean;
  handler: (context: WorkflowContext) => Promise<void>;
}

interface Workflow {
  name: string;
  phases: WorkflowPhase[];
  adapter?: string; // Which framework this workflow belongs to
}

const workflows: Workflow[] = [
  {
    name: 'switchboard-standard',
    phases: [
      { name: 'complexity-audit', required: true, handler: complexityAuditHandler },
      { name: 'adversarial-review', required: true, handler: adversarialReviewHandler },
      { name: 'dependency-check', required: false, handler: dependencyCheckHandler }
    ]
  },
  {
    name: 'gsd-context-engineering',
    adapter: 'gsd',
    phases: [
      { name: 'context-setup', required: true, handler: gsdContextSetup },
      { name: 'phase-planning', required: true, handler: gsdPhasePlanning },
      { name: 'state-persistence', required: true, handler: gsdStatePersistence }
    ]
  },
  {
    name: 'superpowers-tdd',
    adapter: 'superpowers',
    phases: [
      { name: 'brainstorming', required: true, handler: brainstormingHandler },
      { name: 'test-writing', required: true, handler: testWritingHandler },
      { name: 'implementation', required: true, handler: implementationHandler }
    ]
  }
]
```

**Benefits:**
- Users can mix and match phases from different frameworks
- Framework-specific workflows are isolated
- Easy to add new workflows

---

### Recommendation 4: Framework-Specific UI Components

**Implementation:**
- Add framework selector dropdown in planning panel
- Show framework-specific UI based on selection:
  - GSD: Milestone/Slice/Task hierarchy visualization
  - Superpowers: Skills status dashboard
  - SpecKit: Constitution/Spec/Plan/Tasks progress
- Allow framework switching mid-plan (with confirmation)

**Example UI:**
```
┌─────────────────────────────────────┐
│ Planning Panel                      │
├─────────────────────────────────────┤
│ Framework: [Switchboard ▼]          │
│                                     │
│ [Switchboard Native]                │
│ [GSD]                               │
│ [Superpowers]                       │
│ [SpecKit]                           │
│ [Custom...]                         │
└─────────────────────────────────────┘
```

---

### Recommendation 5: Priority Order for Framework Support

**Phase 1 (Immediate - High Impact):**
1. **Configurable Plan Templates** - Lowest effort, highest user value
2. **Framework Selection UI** - Visual indicator of flexibility
3. **Minimal Template Option** - For users who want less ceremony

**Phase 2 (Medium Effort - Medium Impact):**
4. **GSD Adapter** - Most similar to Switchboard's current approach
5. **Modular Workflow System** - Foundation for other adapters
6. **Superpowers Adapter** - Popular framework with clear value prop

**Phase 3 (Longer Term - Specialist Use Cases):**
7. **SpecKit Adapter** - For GitHub-centric workflows
8. **Custom Adapter Builder** - Power user feature
9. **BMAD/GSTACK Integration** - For enterprise/team scenarios

---

### Recommendation 6: Potential Pitfalls and Mitigations

**Pitfall 1: Fragmented User Experience**
- **Risk**: Users confused by too many options
- **Mitigation**: Smart defaults (detect user's framework from existing files), progressive disclosure

**Pitfall 2: Maintenance Burden**
- **Risk**: Keeping multiple adapters in sync is hard
- **Mitigation**: Adapter tests, automated framework compatibility checks, community contributions

**Pitfall 3: Loss of Switchboard Identity**
- **Risk**: Switchboard becomes "just another adapter host"
- **Mitigation**: Keep Switchboard Native as default, emphasize unique value (multi-agent coordination, Kanban)

**Pitfall 4: Breaking Changes**
- **Risk**: Existing plans break with new system
- **Mitigation**: Migration path, backward compatibility mode, gradual rollout

---

## Source Credibility Assessment

**Most Authoritative:**
- Official GitHub repositories (GSD, Superpowers, BMAD, SpecKit)
- GitHub Blog (SpecKit announcement)
- Pulumi Blog (framework comparison by infrastructure experts)

**Moderate Credibility:**
- Medium articles (framework comparisons, integration patterns)
- Community blog posts (case studies, adoption patterns)

**Lower Credibility:**
- Reddit discussions (anecdotal experiences, not authoritative)
- Unverified blog posts (use with caution)

---

## Knowledge Gaps

**What Couldn't Be Found:**
- Detailed implementation examples of framework adapter systems in VS Code extensions
- User research on why users abandon tools due to framework rigidity
- Performance benchmarks comparing different frameworks
- Enterprise adoption patterns for spec-driven frameworks

**What Needs Verification:**
- Actual user demand for framework flexibility in Switchboard
- Technical feasibility of adapter system within Switchboard's architecture
- Migration path for existing Switchboard plans

---

## Recommended Next Steps

**Immediate Actions:**
1. User research: Survey Switchboard users about framework preferences
2. Technical spike: Implement configurable plan templates as proof-of-concept
3. Architecture review: Assess feasibility of adapter system in Switchboard

**Short Term (1-2 weeks):**
4. Implement framework selection UI
5. Create minimal template option
6. Write adapter interface specification

**Medium Term (1-2 months):**
7. Implement GSD adapter
8. Implement modular workflow system
9. Add adapter testing infrastructure

**Long Term (3-6 months):**
10. Implement Superpowers adapter
11. Add custom adapter builder
12. Community framework contributions

---

## Conclusion

Switchboard's current opinionated planning process is both a strength (consistency, quality) and a weakness (user flexibility). By implementing a framework adapter system with configurable templates and modular workflows, Switchboard can:

1. **Retain its core value** (multi-agent coordination, Kanban execution)
2. **Accommodate user preferences** (support GSD, Superpowers, SpecKit, etc.)
3. **Reduce adoption friction** (users don't have to abandon their preferred methodology)
4. **Future-proof the extension** (easy to add new frameworks as they emerge)

The engine-adapter pattern is a proven architecture for this type of problem, and the implementation effort is manageable if phased appropriately. Start with configurable templates (quick win), then build out adapters incrementally based on user demand.
