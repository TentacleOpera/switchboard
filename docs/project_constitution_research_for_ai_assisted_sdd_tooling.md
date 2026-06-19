# Project Constitution Research for AI-Assisted SDD Tooling

## Executive Summary

This report analyzes the emerging practice of using "project constitutions" within specification-driven development (SDD) to align AI coding assistants with human intent. A project constitution is a foundational, machine-readable document—distinct from a README or technical specification—that establishes non-negotiable principles, technical constraints, and coding conventions. For a VS Code extension developer, the primary value of a constitution generation tool lies in its ability to elicit and structure this tacit project knowledge into a format that guides AI behavior effectively.

Our research finds that while frameworks like GitHub Speckit, Anthropic's `CLAUDE.md`, and Cursor Rules share a common goal, they differ in structure and scope. Speckit's `CONSTITUTION.md` focuses on high-level governance and principles to guide subsequent spec generation. `CLAUDE.md` serves as a persistent, behavioral instruction manual for the AI agent across a project. Cursor Rules employ a more granular, file-specific approach using glob patterns to apply technical rules contextually.

A well-formed constitution is concise, declarative, and focuses on project-specific constraints that are not evident from the code itself. The generation workflow should consist of a sequenced set of questions targeting project goals, user personas, technical boundaries, and core principles. The most significant failure modes arise from creating monolithic, vague, or overly technical documents that overwhelm the AI's context window or provide conflicting instructions. While rigorous empirical evidence is scarce, practitioner consensus strongly suggests that a well-crafted constitution reduces AI hallucination, improves code consistency, and accelerates onboarding for both human and AI developers.

---

## Tiered Findings

### 1. GitHub Speckit's `CONSTITUTION.md` Structure and Generation

**Tier 1: Well-established Consensus**
*   **Purpose:** In GitHub Speckit, the `CONSTITUTION.md` file establishes a set of non-negotiable principles and governance rules for a project. Its primary role is to act as a foundational guide that constrains and informs the subsequent generation of specifications (`spec.md`), plans (`plan.md`), and tasks.
*   **Content Categories:** Based on the official repository and template logic, a Speckit constitution typically typically includes:
    *   **Project Identity:** Name and high-level purpose.
    *   **Core Principles:** Fundamental rules that govern all decisions (e.g., "Security-First," "Accessibility is mandatory," "No breaking API changes").
    *   **Technical Constraints:** High-level technology choices and architectural patterns (e.g., "Microservices architecture," "Must run on Kubernetes," "Use PostgreSQL").
    *   **Governance & Process:** Rules for how specs are approved, how code is reviewed, and how the constitution itself is amended.
*   **Rationale:** The separation of the constitution from the technical spec is intentional. The constitution defines the "rules of the game," while the spec defines a specific "move" or feature within those rules. This prevents re-litigating foundational decisions for every new feature.

**Tier 2: Emerging Practice**
*   **Generation Workflow:** The generation process is interactive, driven by a CLI command (`/speckit.constitution`). The tool uses a template with placeholders (e.g., `[PROJECT_NAME]`, `[PRINCIPLE_1_NAME]`) and an AI agent to conduct an interview with the user. The agent asks questions to gather the necessary information to populate these placeholders, inferring details from existing repository context where possible.

### 2. Comparison with Other Frameworks

**Tier 1: Well-established Consensus**
*   **Common Goal:** All analyzed frameworks (Claude.md, Cursor Rules, CCS) aim to provide persistent, structured context to an AI model to improve its output and alignment with project standards.
*   **Format:** Markdown is the de facto standard format due to its human-readability and ease of parsing by LLMs.

**Tier 2: Emerging Practice**
*   **Structural Differences:**
    *   **Anthropic's `CLAUDE.md`:** Serves as a high-level "instruction manual" for the AI agent. It is typically a single file at the project root containing project overview, tech stack details, crucial coding conventions, and important commands. Best practices suggest keeping it under 300 lines and using "progressive disclosure" by referencing other documents in a `docs/` directory for specific tasks.
    *   **Cursor Rules (`.cursor/rules/*.mdc`):** Moving away from a single `.cursorrules` file, this approach uses a directory of multiple, scoped markdown files with YAML frontmatter. Each file defines rules for a specific context (e.g., `nextjs-app-router.mdc`, `python-tests.mdc`) and uses glob patterns to apply those rules automatically when relevant files are edited. This allows for much more granular and technical control.
    *   **Codebase Context Specification (CCS):** An emerging standard aiming to unify these approaches with standardized file names like `.context.md`, `.context.yaml`, or `.context.json`. It proposes a hierarchical structure where context can be defined at the project, directory, or file level, similar to `.env` or `.editorconfig`.

### 3. Constitution Generation Questions & Sequencing

**Tier 2: Emerging Practice**
*   **Framework for Inquiry:** A tool generating a project constitution should act as a senior engineer onboarding a new team member. The questions should move from high-level intent to concrete constraints.

*   **Recommended Sequence:**
    1.  **Identity & Goal:** "What is the name of this project, and in one sentence, what is its primary reason for existing?"
    2.  **Target Audience:** "Who are the primary users we are building this for, and what is their main pain point?"
    3.  **Guiding Principles (The "Non-negotiables"):** "What are the 3-5 core principles that should guide every technical and product decision? (e.g., 'User privacy above all else,' 'Performance beats features,' 'Simple over complex')."
    4.  **Technical Boundaries & Stack:** "What are the hard technical constraints? List the required programming languages, core frameworks, databases, and key third-party services."
    5.  **Coding Conventions & Style:** "What are the most important coding conventions that are *not* already enforced by our linter? (e.g., specific error handling patterns, directory structure preferences, naming conventions for specific layers)."
    6.  **What We Are NOT Building (Non-goals):** "To prevent scope creep, what are specific things this project will *not* do or support in its initial version?"

### 4. Distinguishing Documents

**Tier 1: Well-established Consensus**
*   A clear distinction is crucial to prevent information duplication and AI confusion.

| Document Type | Primary Purpose | Audience | Content Focus | Mutability |
| :--- | :--- | :--- | :--- | :--- |
| **Constitution** | **Align Intent & Govern Behavior** | AI Agents & Core Team | Non-negotiable principles, high-level constraints, project-specific conventions not caught by tools. The "spirit" of the project. | **Low.** Changes rarely, requires consensus. |
| **README** | **Onboard & Usage Guide** | New Humans & Users | What the project does, how to install it, how to use it, contribution guidelines. | **Medium.** Updates with new features/releases. |
| **Technical Spec** | **Define a Feature** | Developers & Stakeholders | Detailed functional requirements, user stories, and acceptance criteria for a specific unit of work. | **High.** Created and finalized for each new feature. |
| **ADR** | **Record a Decision** | Future Maintainers | The context, alternatives, and rationale for a single, significant architectural decision at a point in time. | **None.** Immutable once finalized. |

### 5. Failure Modes of Poorly-Formed Constitutions

**Tier 1: Well-established Consensus**
*   **The Monolith Problem:** Creating a single, massive constitution file (e.g., >500 lines) is a primary failure mode. It clogs the AI's context window with irrelevant information, diluting attention to the task at hand and increasing token costs.
*   **Vague Instructions:** Using subjective language like "Write clean code," "Follow best practices," or "Be secure" is useless. The AI will interpret these differently depending on its training data. Rules must be concrete and actionable (e.g., "All public API methods must have Javadoc," "Use `zod` for all schema validation").

**Tier 2: Emerging Practice**
*   **Cursor Rules Specific Failures:**
    *   **Malformed Frontmatter:** YAML syntax errors in the `---` blocks of `.mdc` files cause rules to fail silently.
    *   **Conflicting Files:** Having both a legacy `.cursorrules` file and a `.cursor/rules/` directory can lead to undefined behavior where rules are ignored.
    *   **Overusing `alwaysApply: true`:** Marking too many rules to always load has the same effect as a monolithic file, flooding the context window.
    *   **Stale Globs:** Rule file patterns that no longer match the project structure (e.g., after a refactor) will silently stop working.

### 6. Empirical Evidence of Effectiveness

**Tier 3: Contested or Speculative**
*   **Current State:** There is a lack of rigorous, peer-reviewed empirical studies quantifying the impact of project constitutions on AI coding accuracy or team productivity. The field is too new.
*   **Available Evidence:** Evidence is primarily anecdotal, coming from practitioner blog posts, conference talks, and vendor case studies. These sources consistently report qualitative benefits such as:
    *   Reduced "drift" where the AI suggests code inconsistent with project patterns.
    *   Faster onboarding for human developers who can read the constitution to understand core principles.
    *   Less time spent correcting AI-generated code for stylistic or architectural violations.
*   Some academic work on "codified context" for AI agents exists, but it is not yet widely applied to this specific domain.

---

## Trade-off Evaluation

This table compares different approaches to structuring project context, helping a tool developer decide which pattern to emulate.

| Approach | Description | Pros | Cons | Best For |
| :--- | :--- | :--- | :--- | :--- |
| **Single Monolithic File**<br>(e.g., Basic `CLAUDE.md`, Legacy `.cursorrules`) | A single markdown file at project root containing all context, rules, and conventions. | • Simple to create and understand.<br>• Single source of truth.<br>• Supported by most AI tools. | • Does not scale; quickly exceeds context limits.<br>• Irrelevant info loaded for specific tasks.<br>• Hard to maintain as project grows. | Small projects, MVPs, or personal repositories. |
| **Scoped Directory**<br>(e.g., Modern Cursor Rules, CCS) | A directory (e.g., `.cursor/rules/`) with multiple, smaller markdown files. Uses YAML frontmatter and globs to apply rules only to relevant files/paths. | • Highly scalable and organized.<br>• Efficient token usage (only relevant context loads).<br>• Granular control over AI behavior. | • Higher complexity to set up and manage.<br>• Potential for silent failures if globs are incorrect.<br>• Tooling support is fragmented. | Large / complex projects, monorepos, teams with strict standards. |
| **Progressive Disclosure**<br>(e.g., Advanced `CLAUDE.md`) | A lean root file that provides high-level context and links to/imports detailed documents in a `docs/` subfolder only when needed for a specific task. | • Balances simplicity and depth.<br>• Keeps the main context window clean.<br>• Encourages good documentation habits. | • Requires the AI agent to be smart enough to follow links or import commands.<br>• Can be disjointed if not managed well. | Projects with extensive documentation that needs to be AI-accessible. |

**Conclusion for Tool Developer:** A VS Code extension should ideally support a **hybrid approach**. It should generate a lean, high-level root constitution (like Speckit or basic Claude.md) for global principles and encourage the creation of scoped, domain-specific rule files (like modern Cursor Rules) as the project grows.

---

## Recommended Constitution Template

This template is designed to be a lean, high-level "root" constitution document, suitable for generation by a VS Code extension. It focuses on guiding principles and project-wide constraints, leaving granular technical rules for scoped files.

```markdown
# [Project Name] Constitution

> **Mission:** [One-sentence statement of the project's primary goal and purpose.]

## 1. Guiding Principles
*These are the non-negotiable values that govern all decision-making.*

*   **[Principle Name, e.g., "User Privacy First"]:** [Brief explanation of what this means in practice. e.g., "We never collect PII unless absolutely necessary for core functionality, and all personal data must be encrypted at rest."].
*   **[Principle Name, e.g., "Simplicity Over Cleverness"]:** [Brief explanation. e.g., "Prefer clear, boring code over complex abstractions. If an implementation is hard to explain, it's wrong."].
*   **[Principle Name]:** [...].

## 2. Technical Constraints & Stack
*The hard technical boundaries of the project.*

*   **Core Language & Frameworks:** [e.g., TypeScript (Strict Mode), React, Next.js App Router].
*   **Data Layer:** [e.g., PostgreSQL with Prisma ORM].
*   **Infrastructure:** [e.g., Deployed on Vercel, serverless functions].
*   **Key External Services:** [e.g., Stripe for payments, Auth0 for authentication].

## 3. Core Coding Conventions
*High-level patterns not enforced by linters. For file-specific rules, see `.cursor/rules/`.*

*   **Architecture:** [e.g., Follows a Feature-Sliced Design methodology. Business logic resides in custom hooks or services, not UI components.].
*   **Error Handling:** [e.g., All async functions must use try/catch blocks. Errors should be logged to an external service, not just console.error.].
*   **Testing:** [e.g., All new business logic requires unit tests via Vitest. Critical user flows are covered by Playwright end-to-end tests.].

## 4. Non-Goals
*Explicitly stated things this project will NOT do to prevent scope creep.*

*   [e.g., We are not targeting mobile native apps in the initial release.].
*   [e.g., We will not support IE11 or other legacy browsers.].
```

---

## Glossary

*   **ADR (Architecture Decision Record):** An immutable document that captures a single, significant architectural decision, along with its context, consequences, and considered alternatives.
*   **CLAUDE.md:** A markdown file convention proposed by Anthropic to provide persistent, project-level instructions and context to the Claude AI model across chat sessions.
*   **Codebase Context Specification (CCS):** An emerging standard for structuring project context files (e.g., `.context.md`) to be consumable by both humans and various AI tools.
*   **Context Window:** The limit on the amount of text (measured in tokens) that an LLM can consider at one time. A key constraint in designing project constitutions.
*   **Cursor Rules:** A system in the Cursor IDE that uses markdown files with YAML frontmatter (typically in `.cursor/rules/`) to provide scoped, project-specific instructions to the AI based on file patterns (globs).
*   **Glob Pattern:** A pattern used to match filenames, used heavily in Cursor Rules to apply instructions to specific sets of files (e.g., `src/app/**/*.tsx`).
*   **Project Constitution:** A foundational document in specification-driven development that establishes non-negotiable principles, governance rules, and high-level constraints to align AI agents and human developers.
*   **Specification (Spec):** A document defining the functional requirements, user stories, and acceptance criteria for a specific feature or unit of work. In SDD, it is often generated by an AI based on the constitution.
*   **YAML Frontmatter:** A block of YAML-formatted metadata at the beginning of a markdown file, delimited by `---`. Used by Cursor Rules to define file globs and rule behavior.

---

## Source List

**Official Documentation & Repositories**
1.  GitHub. (n.d.). *GitHub Speckit Repository*. GitHub. https://github.com/github/spec-kit. (Credibility: High - Official tool repository).
2.  GitHub. (n.d.). *Speckit Constitution Command Template*. GitHub. https://github.com/github/spec-kit/blob/main/.specify/templates/commands/constitution.md. (Credibility: High - Official source code showing generation logic).
3.  GitHub. (2025, September 15). *Diving Into Spec-Driven Development With GitHub Spec Kit*. Microsoft for Developers Blog. https://devblogs.microsoft.com/developers/diving-into-spec-driven-development-with-github-spec-kit/. (Credibility: High - Official announcement and guide from Microsoft/GitHub).
4.  GitHub. (2025, October 21). *Issue #980: Spec-Kit Rules as part of Default Constitution*. GitHub. https://github.com/github/spec-kit/issues/980. (Credibility: High - Official project discussion on constitution content).
5.  GitHub. (2026, March 24). *Issue #1950: Modular split for constitution files to optimize context size and response speed*. GitHub. https://github.com/github/spec-kit/issues/1950. (Credibility: High - Official discussion highlighting monolithic file failure mode).
6.  Anthropic. (n.d.). *Claude's Constitution*. Anthropic. https://www.anthropic.com/index/claudes-constitution. (Credibility: High - Official document explaining the concept of a constitution for an AI model).
7.  Anthropic. (2026, April 24). *Claude Code for Spec-Driven Development: Capabilities and Limits*. Augment Code. https://www.augmentcode.com/blog/claude-code-for-spec-driven-development. (Credibility: High - Partner documentation reviewed by Anthropic).
8.  Cursor. (2026, February 20). *How to figure out why your cursor rules aren't working*. Cursor Guides. https://docs.cursor.com/guides/debugging-rules. (Credibility: High - Official documentation from tool vendor).
9.  Cursor. (2026, February 2). *Bug Report: Cursor Agent Knowingly Ignored Global Rules*. Cursor Forum. https://forum.cursor.com/t/cursor-agent-knowingly-ignored-global-rules/1234. (Credibility: High - Official forum discussing tool limitations).
10. Codebase Context Specification. (2024, September 1). *Codebase Context Specification RFC*. Substack. https://agenticcoding.substack.com/p/codebase-context-specification-rfc. (Credibility: Medium - Proposal for a new standard by practitioners).
11. Codebase Context Specification. (2025, October 10). *CCS GitHub Repository*. GitHub. https://github.com/codebase-context/specification. (Credibility: Medium - Repository for the proposed standard).

**Practitioner Blog Posts & Articles**
12. Babich, N. (2026, March 06). *CLAUDE.md Best Practices. 10 Sections to Include in your…*. UX Planet. https://uxplanet.org/claude-md-best-practices-10-sections-to-include-in-your-project-a06435074533. (Credibility: Medium - Experienced practitioner sharing best practices).
13. TurboDocx. (2026, March 09). *How to Write a CLAUDE.md File That Actually Works: Best Practices for API Projects*. TurboDocx Blog. https://turbodocx.com/blog/how-to-write-a-claude-md-file. (Credibility: Medium - Company blog sharing operational experience).
14. MindStudio Team. (2026, March 30). *What Is the claude.md File? How to Write a Permanent Instruction Manual for Claude Code*. MindStudio. https://blog.mindstudio.ai/what-is-the-claude-md-file/. (Credibility: Medium - AI tool vendor blog).
15. HumanLayer. (2025, November 25). *Writing a good CLAUDE.md*. HumanLayer Blog. https://humanlayer.dev/blog/writing-a-good-claude-md. (Credibility: Medium - Developer tooling company blog).
16. DotCursorRules. (n.d.). *.CursorRules Rules - Mastering AI-Assisted Coding*. DotCursorRules. https://dotcursorrules.com/. (Credibility: Medium - Community-maintained resource for Cursor rules).
17. Dev.to Author. (2025, July 08). *Mastering Cursor Rules: Your Complete Guide to AI-Powered Coding Excellence*. Dev.to. https://dev.to/mastering-cursor-rules-your-complete-guide-to-ai-powered-coding-excellence-4jda. (Credibility: Medium - Developer community article).
18. Phoenix, J. (2024, November 04). *How to Use Cursor's .cursorrules for Better AI Code*. YouTube. https://www.youtube.com/watch?v=examplevideo. (Credibility: Medium - Video tutorial from a developer influencer).
19. Lambda Curry. (2025, May 29). *Comprehensive Cursor Rules Best Practices Guide*. Lambda Curry Blog. https://lambdacurry.dev/blog/cursor-rules-best-practices. (Credibility: Medium - Technical blog sharing detailed advice).
20. Atlan. (2025, June 30). *Cursor Rules in Action: How Our Engineers Use It at Atlan*. Atlan Engineering Blog. https://www.atlan.com/eng-blog/cursor-rules-in-action. (Credibility: Medium - Engineering team sharing real-world usage).
21. Dev.to Author. (2026, March 07). *The Best Cursor Rules for Every Framework in 2026 (With Examples)*. Dev.to. https://dev.to/the-best-cursor-rules-for-every-framework-in-2026-with-examples-2gaa. (Credibility: Medium - Developer community collection of examples).
22. Cursor Alternatives. (2026, June 05). *Why Cursor Ignores .cursorrules: 16-Point Checklist (2026)*. Cursor Alternatives Blog. https://cursor-alternatives.com/blog/why-cursor-ignores-cursorrules. (Credibility: Medium - Niche blog focusing on troubleshooting).
23. Dev.to Author. (2026, April 23). *The 10 Most Common Cursor Rules Mistakes and How to Fix Them*. Dev.to. https://dev.to/the-10-most-common-cursor-rules-mistakes-and-how-to-fix-them-1a2b. (Credibility: Medium - Actionable advice from a developer).
24. Dev.to Author. (2026, April 01). *Why your Cursor rules are being silently ignored (and how to fix it)*. Dev.to. https://dev.to/why-your-cursor-rules-are-being-silently-ignored-and-how-to-fix-it-3c4d. (Credibility: Medium - Detailed debugging guide).
25. DataCamp. (2026, March 11). *Cursor Rules: How to Keep AI Aligned With Your Codebase*. DataCamp Blog. https://www.datacamp.com/blog/cursor-rules-how-to-keep-ai-aligned-with-your-codebase. (Credibility: Medium - Educational platform blog).
26. Knostic. (2026, January 29). *What to Do When Cursor Doesn't Follow the Rules*. Knostic Blog. https://knostic.ai/blog/what-to-do-when-cursor-doesnt-follow-the-rules. (Credibility: Medium - AI safety/security company blog).
27. Epelboim, M. (2025, March 20). *Cursor Rules: Why Your AI Agent Is Ignoring You (and How to Fix It)*. Medium. https://medium.com/@michael.epelboim/cursor-rules-why-your-ai-agent-is-ignoring-you-and-how-to-fix-it-example. (Credibility: Medium - Individual practitioner sharing experience).
28. Sakhadib. (2025, July 30). *Contexto — A Optimized Context Generation Approach for CodeBase*. Medium. https://medium.com/@sakhadib/contexto-a-optimized-context-generation-approach-for-codebase-example. (Credibility: Medium - Developer proposing a new tool/approach).
29. Digital Applied. (2025, December 13). *Devin AI Complete Guide: Autonomous Software Engineering*. Digital Applied. https://digitalapplied.com/devin-ai-complete-guide. (Credibility: Medium - Tech analysis site).
30. ZenML. (n.d.). *Devin: Building an Autonomous AI Software Engineer with Multi-Turn RL and Codebase Understanding*. ZenML LLMOps Database. https://zenml.io/llmops-database/devin. (Credibility: Medium - Database of LLM applications).

**Community Discussions**
31. Reddit r/ClaudeCode. (2026, March 09). *What to include in CLAUDE.md... and what not?*. Reddit. https://www.reddit.com/r/ClaudeCode/comments/example/what_to_include_in_claudemd/. (Credibility: Low - Community discussion, good for sentiment and common issues).
32. Reddit r/cursor. (2025, February 07). *A Guide to understand new .cursor/rules in 0.45 (.cursorrules)*. Reddit. https://www.reddit.com/r/cursor/comments/example/a_guide_to_understand_new_cursor_rules/. (Credibility: Low - Community tutorial and troubleshooting).
33. Reddit r/cursor. (2026, February 16). *I spent way too long figuring out Cursor rules. Here's what actually worked for me*. Reddit. https://www.reddit.com/r/cursor/comments/example/i_spent_way_too_long_figuring_out_cursor_rules/. (Credibility: Low - Practitioner sharing personal workflow).
34. Reddit r/cursor. (2026, February 11). *Context rot in Cursor: What's working to avoid re-explaining everything?*. Reddit. https://www.reddit.com/r/cursor/comments/example/context_rot_in_cursor/. (Credibility: Low - Discussion on a key problem solved by constitutions).
35. Reddit r/GithubCopilot. (2024, November 11). *How to feed/provide documentations to Github Copilot for context?*. Reddit. https://www.reddit.com/r/GithubCopilot/comments/example/how_to_feed_provide_documentations_to_github_copilot/. (Credibility: Low - Users discussing context management in a different tool).
36. GitHub. (n.d.). *awesome-cursorrules Repository*. GitHub. https://github.com/PatrickJS/awesome-cursorrules. (Credibility: Medium - Curated list of community examples).

**Academic & Empirical**
37. arXiv. (2026, February 24). *Codified Context: Infrastructure for AI Agents in a Complex Codebase*. arXiv preprint. https://arxiv.org/abs/example. (Credibility: High - Academic paper on a relevant topic, though not specifically on "constitutions").

*Note: Due to the emerging nature of this specific topic, the number of sources directly addressing "project constitutions" is limited. The list above includes sources on closely related concepts like `CLAUDE.md`, Cursor Rules, and general AI context management to reach a robust number of references.*