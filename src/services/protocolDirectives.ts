/**
 * Protocol directive builders + resolution helper.
 *
 * The nine protocol-carrying `*_DIRECTIVE` constants in `agentPromptBuilder.ts`
 * previously embedded dead `.agents/protocols/<name>/SKILL.md` filesystem paths —
 * paths that ceased to exist when the 30 protocols became `control_plane` rows
 * (commit 8258ce4b). This module replaces them with builders that consume
 * already-resolved protocol content (threaded from the async dispatch site) and
 * emit either:
 *   - the materialised absolute cache path (for `materialize` delivery),
 *   - the protocol body inlined into the prompt (for `inline` delivery), or
 *   - a live fetch instruction (`switchboard api GET /protocol/<name>`) when no
 *     resolution was threaded — never a dead path.
 *
 * The builders stay pure/synchronous: the caller resolves the set once via
 * `resolveProtocolSet` (async) and threads the result through. A builder with no
 * resolution falls back to the fetch instruction, which is live in both the
 * extension and the standalone host (the LocalApiServer runs in both).
 */

import { ProtocolService, ResolvedProtocol } from './ProtocolService';
import { KanbanDatabase } from './KanbanDatabase';

/** A map of protocol name → resolved protocol (or null when unresolved). */
export type ProtocolResolution = Record<string, ResolvedProtocol | null>;

/**
 * The protocol names the nine directive builders may consume. Dispatch sites
 * resolve exactly this set once per prompt and thread the result through
 * `PromptBuilderOptions.resolvedProtocols` / `SeatDirectiveOptions.resolvedProtocols`.
 */
export const DIRECTIVE_PROTOCOL_NAMES: readonly string[] = [
    'accuracy',
    'linear-api',
    'clickup-api',
    'complexity-scoring',
    'web-research',
    'deep-planning',
    'advise_research',
];

/**
 * Resolve a set of protocol names in parallel. Never throws — a failed
 * resolution records `null` so the directive builder falls back to the live
 * fetch instruction rather than crashing the prompt assembly.
 */
export async function resolveProtocolSet(
    names: readonly string[],
    workspaceRoot?: string,
    kanbanDb?: KanbanDatabase
): Promise<ProtocolResolution> {
    const out: ProtocolResolution = {};
    await Promise.all(names.map(async (name) => {
        try {
            out[name] = await ProtocolService.resolveProtocol(name, workspaceRoot, kanbanDb);
        } catch {
            out[name] = null;
        }
    }));
    return out;
}

interface ProtocolPhrase {
    /** Preposition-ready phrase to drop into a "read and follow ..." sentence. */
    phrase: string;
    /** When inline, the body to append after the sentence. */
    body?: string;
}

/**
 * Render the reference clause for a single protocol.
 *  - inline + resolved → "the workflow below" (body returned for appending).
 *  - materialize + resolved → "the workflow at <absolute path>".
 *  - unresolved → a live fetch instruction naming the protocol (never a path).
 */
function protocolPhrase(name: string, resolved?: ResolvedProtocol | null): ProtocolPhrase {
    if (resolved) {
        if (resolved.delivery === 'inline' && resolved.body) {
            return { phrase: 'the workflow below', body: resolved.body };
        }
        if (resolved.path) {
            return { phrase: `the workflow at ${resolved.path}` };
        }
    }
    return { phrase: `the \`${name}\` protocol (resolve via \`switchboard api GET /protocol/${name}\`)` };
}

/** Wrap an inlined body in a delimited block so the agent can find its bounds. */
function wrapBody(name: string, body: string): string {
    return `\n\n--- BEGIN PROTOCOL ${name} ---\n${body}\n--- END PROTOCOL ${name} ---`;
}

/** Append any inlined bodies collected from a set of phrases. */
function appendBodies(parts: Array<{ name: string; body?: string }>): string {
    const bodies = parts.filter(p => p.body && p.body.length > 0);
    if (bodies.length === 0) return '';
    return bodies.map(p => wrapBody(p.name, p.body!)).join('');
}

/**
 * Render a reference clause for a set of protocols (e.g. "X (ClickUp), Y (Linear),
 * or Z (Notion)") plus any inlined bodies. `labels` aligns with `names` by index.
 * Returns `{ clause, bodies }` so the caller can place the clause in a sentence and
 * append the bodies after the surrounding text.
 */
export function renderProtocolReferences(
    names: readonly string[],
    labels: readonly string[],
    resolved?: ProtocolResolution
): { clause: string; bodies: string } {
    const parts = names.map((name, i) => {
        const r = protocolPhrase(name, resolved?.[name]);
        return { name, label: labels[i] ?? name, phrase: r.phrase, body: r.body };
    });
    const clause = parts.length === 1
        ? parts[0].phrase
        : parts.slice(0, -1).map(p => `${p.phrase} (${p.label})`).join(', ') +
          `, or ${parts[parts.length - 1].phrase} (${parts[parts.length - 1].label})`;
    const bodies = appendBodies(parts);
    return { clause, bodies };
}

// ─── Directive builders ──────────────────────────────────────────────────

/**
 * Render the planner-workflow "Read … and follow it" instruction.
 *  - A real path (contains `/` or ends in `.md`) → `Read <path> and follow it
 *    step-by-step.` (committed survivors and custom absolute paths).
 *  - A bare protocol name → resolved through `resolved`; inline body embedded,
 *    materialised absolute path emitted, or a live fetch instruction fallback.
 */
export function renderPlannerWorkflowRef(workflowPath: string, resolved?: ProtocolResolution): string {
    if (!workflowPath) return '';
    // A path-looking value (contains a separator or a .md suffix) is emitted as-is.
    if (workflowPath.includes('/') || /\.md$/i.test(workflowPath)) {
        return `Read ${workflowPath} and follow it step-by-step.`;
    }
    // Bare protocol name → resolve.
    const r = protocolPhrase(workflowPath, resolved?.[workflowPath]);
    const base = `Read and follow ${r.phrase} step-by-step.`;
    return r.body ? `${base}${wrapBody(workflowPath, r.body)}` : base;
}

/**
 * Accuracy Mode directive. `accuracy` is `inline` delivery, so a resolved
 * protocol embeds the full body into the prompt.
 */
export function buildAccuracyDirective(resolved?: ProtocolResolution): string {
    const r = protocolPhrase('accuracy', resolved?.['accuracy']);
    const base = `Accuracy Mode: Before coding, read and follow ${r.phrase} step-by-step while implementing this task.`;
    return r.body ? `${base}${wrapBody('accuracy', r.body)}` : base;
}

/**
 * Remote Mode directive. References `linear-api` and `clickup-api` (both
 * `inline`). When resolved, both bodies are appended so the agent has the
 * `switchboard api POST /comment` contract without an extra fetch.
 */
export function buildRemoteModeDirective(resolved?: ProtocolResolution): string {
    const lin = protocolPhrase('linear-api', resolved?.['linear-api']);
    const cu = protocolPhrase('clickup-api', resolved?.['clickup-api']);
    const base =
        `REMOTE MODE: You are running under remote control — the user is NOT at the terminal. ` +
        `If you need to ask the user anything or report a blocker, post it as a comment on the linked issue using ${lin.phrase} (or ${cu.phrase}). ` +
        `Do NOT wait on terminal input. Continue with any work you can do without the answer.`;
    const tail = appendBodies([
        { name: 'linear-api', body: lin.body },
        { name: 'clickup-api', body: cu.body },
    ]);
    return `${base}${tail}`;
}

/** Complexity Scoring directive. `complexity-scoring` is `materialize`. */
export function buildComplexityScoringDirective(resolved?: ProtocolResolution): string {
    const r = protocolPhrase('complexity-scoring', resolved?.['complexity-scoring']);
    return (
        `COMPLEXITY SCORING: Before proceeding, read and follow ${r.phrase} to add a ` +
        `## Complexity Audit section with ### Routine and ### Complex / Risky subsections. ` +
        `Classify each implementation step by complexity before splitting.`
    ) + (r.body ? wrapBody('complexity-scoring', r.body) : '');
}

/** Ticket Update directive (comment-only). References clickup-api + linear-api. */
export function buildTicketUpdateDirective(resolved?: ProtocolResolution): string {
    const cu = protocolPhrase('clickup-api', resolved?.['clickup-api']);
    const lin = protocolPhrase('linear-api', resolved?.['linear-api']);
    const base =
        `TICKET UPDATE MODE: You are authorized to update the associated ticket. ` +
        `Extract the ticket number from the plan metadata field "**Ticket:**" (format: CU-XXXXX or LIN-XXXXX). ` +
        `Analyze the plan, then read ${cu.phrase} or ${lin.phrase} and use it to add an "AI Analysis" comment to the ticket. ` +
        `Do not modify the ticket description. Only add a comment. ` +
        `If no ticket number is found, skip the ticket update and notify the user.`;
    const tail = appendBodies([
        { name: 'clickup-api', body: cu.body },
        { name: 'linear-api', body: lin.body },
    ]);
    return `${base}${tail}`;
}

/** Ticket Refine directive (description rewrite). References clickup-api + linear-api. */
export function buildTicketRefineDirective(resolved?: ProtocolResolution): string {
    const cu = protocolPhrase('clickup-api', resolved?.['clickup-api']);
    const lin = protocolPhrase('linear-api', resolved?.['linear-api']);
    const base =
        `TICKET UPDATE MODE: You are authorized to update the associated ticket. ` +
        `Extract the ticket number from the plan metadata field "**Ticket:**" (format: CU-XXXXX or LIN-XXXXX). ` +
        `Analyze the plan, then read ${cu.phrase} or ${lin.phrase} and use it to refine the ticket description. ` +
        `Update the description to reflect the plan's current state, implementation details, and any changes from the original request. ` +
        `If no ticket number is found, skip the ticket update and notify the user.`;
    const tail = appendBodies([
        { name: 'clickup-api', body: cu.body },
        { name: 'linear-api', body: lin.body },
    ]);
    return `${base}${tail}`;
}

/**
 * Ticket Research-Refine directive. References `web-research` (materialize) plus
 * clickup-api + linear-api (inline).
 */
export function buildTicketResearchRefineDirective(resolved?: ProtocolResolution): string {
    const wr = protocolPhrase('web-research', resolved?.['web-research']);
    const cu = protocolPhrase('clickup-api', resolved?.['clickup-api']);
    const lin = protocolPhrase('linear-api', resolved?.['linear-api']);
    const base =
        `RESEARCH MODE: Before updating the ticket, read and follow ${wr.phrase} to gather additional context. ` +
        `Research the technical approach, dependencies, best practices, and any relevant recent developments. ` +
        `If the web-research protocol is unavailable, proceed with codebase-only analysis and note the gap.\n\n` +
        `TICKET UPDATE MODE: You are authorized to update the associated ticket. ` +
        `Extract the ticket number from the plan metadata field "**Ticket:**" (format: CU-XXXXX or LIN-XXXXX). ` +
        `After completing research, read ${cu.phrase} or ${lin.phrase} and use it to refine the ticket description. ` +
        `Update the description to reflect the plan's current state, implementation details, research findings, and any changes from the original request. ` +
        `If no ticket number is found, skip the ticket update and notify the user.`;
    const tail = appendBodies([
        { name: 'web-research', body: wr.body },
        { name: 'clickup-api', body: cu.body },
        { name: 'linear-api', body: lin.body },
    ]);
    return `${base}${tail}`;
}

/** Deep Research directive. `deep-planning` is `materialize`. */
export function buildDeepResearchDirective(resolved?: ProtocolResolution): string {
    const r = protocolPhrase('deep-planning', resolved?.['deep-planning']);
    return (
        `DEEP RESEARCH MODE: You are authorized to perform comprehensive deep research ` +
        `on the provided plan using the deep planning protocol at ${r.phrase} with depth set to "deep" (50-100 sources). ` +
        `\n\nSKIP PHASE 0 (Planning Proposal): Research depth is pre-configured. Proceed directly to Phase 1.` +
        `\n\nEXECUTE FULL DEEP PLANNING PROTOCOL:\n` +
        `PHASE 1: Codebase Exploration — run parallel searches (find_by_name, grep, list_dir); read key implementation, config, test, and doc files.\n` +
        `PHASE 2: External Research — use search_web with dynamic date ranges. ` +
        `IF search_web is unavailable: complete with codebase-only analysis, note gap in "Knowledge Gaps" section, continue to Phase 3.\n` +
        `PHASE 3: Cross-Reference — compare internal and external findings; identify gaps, anti-patterns, security issues.\n` +
        `PHASE 4: Synthesis — produce output following this structure:\n` +
        `1) Executive summary (≤ 1 page)\n` +
        `2) Tiered findings: required vs recommended vs optional — clearly distinguish compliance levels\n` +
        `3) Focused trade-off evaluation (e.g. searchability vs confidentiality, cost vs coverage)\n` +
        `4) Defence-in-Depth controls checklist\n` +
        `5) Plain-English glossary of domain-specific terms\n` +
        `6) Full source list with direct links and retrieval dates\n` +
        `7) Current State Analysis\n` +
        `8) External Research Findings\n` +
        `9) Proposed Implementation Plan\n` +
        `10) Impact Analysis\n` +
        `11) Source Credibility Assessment\n` +
        `12) Knowledge Gaps\n` +
        `13) Recommended Next Steps\n` +
        `SOURCE GUIDANCE: Prefer official documentation, standards bodies, and peer-reviewed sources; distrust vendor marketing claims. Date-check all sources — flag anything older than 2 years. Separate "required" from "recommended" from "opinion" in every finding. Where law or standards are silent or ambiguous, say so rather than assuming applicability.\n` +
        `DECISION THIS FEEDS: End with a recommended default for a platform of typical scale — do not just survey the field.\n` +
        `TARGET SOURCE COUNT: 50-100 sources (soft target — prioritize quality over quantity).`
    ) + (r.body ? wrapBody('deep-planning', r.body) : '');
}

/**
 * Advise Research directive base (without the researcher hand-off tail).
 * `advise_research` is `inline` delivery.
 */
export function buildAdviseResearchDirectiveBase(resolved?: ProtocolResolution): string {
    const r = protocolPhrase('advise_research', resolved?.['advise_research']);
    const base =
        `RESEARCH WHEN UNSURE: As you plan, track every assumption, factual claim, API/behavior, or library detail you are NOT 100% certain about. ` +
        `If any exist, read ${r.phrase} and follow it. ` +
        `In the plan file, add a brief "## Uncertain Assumptions" section that lists ONLY those uncertainties and notes that the user was advised to run web research to confirm them before implementation — do NOT put the research prompt itself in the plan. ` +
        `Then build the ready-to-run research prompt.`;
    return r.body ? `${base}${wrapBody('advise_research', r.body)}` : base;
}
