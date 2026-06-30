/**
 * Shared utility module for 1-10 complexity scoring scale.
 * This is the single source-of-truth for mapping scores to categories and routing roles.
 */

export type ComplexityScore = number; // 1-10 integer
export type ComplexityCategory = 'Very Low' | 'Low' | 'Medium' | 'High' | 'Very High' | 'Unknown';

/**
 * Validates if a string is a valid complexity value (numeric "1"-"10" or "Unknown").
 */
export function isValidComplexityValue(value: string): boolean {
    if (value === 'Unknown') return true;
    const score = parseInt(value, 10);
    return !isNaN(score) && score >= 1 && score <= 10;
}

/**
 * Map a 1-10 score to its qualitative category.
 */
export function scoreToCategory(score: number): ComplexityCategory {
    if (score <= 0) return 'Unknown';
    if (score <= 2) return 'Very Low';
    if (score <= 4) return 'Low';
    if (score <= 6) return 'Medium';
    if (score <= 8) return 'High';
    if (score <= 10) return 'Very High';
    return 'Unknown';
}

/**
 * Map a qualitative category back to a representative score.
 */
export function categoryToScore(category: string): number {
    switch (category) {
        case 'Very Low': return 1;
        case 'Low': return 3;
        case 'Medium': return 5;
        case 'High': return 8;
        case 'Very High': return 10;
        default: return 0;
    }
}

/**
 * Map legacy 'Low'|'High' strings to a representative score.
 */
export function legacyToScore(value: string): number {
    const normalized = value.toLowerCase();
    if (normalized === 'low') return 3;
    if (normalized === 'high') return 8;
    const numeric = parseInt(value, 10);
    if (!isNaN(numeric)) return numeric;
    return 0;
}

/**
 * Determine the routing role for a given score.
 * 1-4 → 'intern', 5-6 → 'coder', 7-10 → 'lead'
 */
export function scoreToRoutingRole(score: number): 'lead' | 'coder' | 'intern' {
    if (score >= 1 && score <= 4) return 'intern';
    if (score >= 5 && score <= 6) return 'coder';
    return 'lead'; // 7-10 or Unknown defaults to lead
}

/**
 * Return the next-higher fallback role when the preferred role has no terminal.
 * intern → coder → lead → lead (terminal stop)
 */
export function getFallbackRole(role: 'intern' | 'coder' | 'lead'): 'coder' | 'lead' {
    if (role === 'intern') return 'coder';
    return 'lead';
}

/**
 * Get CSS class for UI badge coloring.
 */
export function categoryToCssClass(category: ComplexityCategory): string {
    switch (category) {
        case 'Very Low': return 'very-low';
        case 'Low': return 'low';
        case 'Medium': return 'medium';
        case 'High': return 'high';
        case 'Very High': return 'very-high';
        default: return 'unknown';
    }
}

/**
 * Parse a complexity string to its numeric score. Returns 0 for invalid/unknown.
 * Handles both numeric strings ("7") and legacy strings ("Low", "High").
 */
export function parseComplexityScore(value: string): number {
    if (!value || value === 'Unknown') return 0;
    const num = parseInt(value, 10);
    if (!isNaN(num) && num >= 1 && num <= 10) return num;
    return legacyToScore(value);
}

/**
 * Pure, content-only complexity extractor. Implements the full file-only fallback
 * chain used by `KanbanProvider.getComplexityFromPlan`'s tail (minus the DB lookup,
 * which is the caller's responsibility). Shared by:
 *   - `parsePlanMetadata` (writes the `complexity` DB column via the plan watcher)
 *   - `PlanFileImporter.extractComplexity` (writes the column on batch import)
 *   - `KanbanProvider.getComplexityFromPlan` (file fallback after the DB short-circuit)
 *
 * Precedence (file-only): Manual Override → `**Complexity:**` line →
 * Agent Recommendation → Complexity Audit / Band B section → `'Unknown'`.
 *
 * The Manual Override check is intentionally included even though
 * `getComplexityFromPlan` short-circuits on its own override check first —
 * `parsePlanMetadata`/`extractComplexity` call this helper directly and need
 * the override branch. The redundancy is a harmless no-op for the provider.
 *
 * Returns a `'1'`–`'10'` string or `'Unknown'`.
 */
export function deriveComplexityFromContent(content: string): string {
    if (!content) return 'Unknown';

    // Highest priority: explicit manual complexity override (user-set via dropdown).
    // Permissive form matches both `**…**:` and `**…:**` colon placements.
    const overrideMatch = content.match(
        /^[\s\-\*\>]*(?:\d+\.\s*)?\*\*Manual Complexity Override(?:\*\*:\s*|:\*\*)\s*(\d{1,2}|Low|High|Unknown)/im
    );
    if (overrideMatch) {
        const val = overrideMatch[1];
        if (val.toLowerCase() !== 'unknown') {
            const num = parseInt(val, 10);
            if (!isNaN(num) && num >= 1 && num <= 10) return String(num);
            const legacy = legacyToScore(val);
            if (legacy > 0) return String(legacy);
        }
    }

    // `**Complexity:**` metadata line. Same permissive colon form.
    const metadataComplexity = content.match(
        /^[\s\-\*\>]*(?:\d+\.\s*)?\*\*Complexity(?:\*\*:\s*|:\*\*)\s*(\d{1,2}|Low|High)/im
    );
    if (metadataComplexity) {
        const val = metadataComplexity[1];
        const num = parseInt(val, 10);
        if (!isNaN(num) && num >= 1 && num <= 10) return String(num);
        const legacy = legacyToScore(val);
        if (legacy > 0) return String(legacy);
    }

    // Agent Recommendation section.
    const leadCoderRec = /send\s+(it\s+)?to\s+(the\s+)?\*{0,2}lead\s+coder\*{0,2}/i;
    const coderAgentRec = /send\s+(it\s+)?to\s+(the\s+)?\*{0,2}coder(\s+agent)?\*{0,2}/i;
    if (leadCoderRec.test(content)) return '8';
    if (coderAgentRec.test(content)) return '3';

    // Fallback: parse the Complexity Audit / Complex (Band B) section.
    const auditMatch = content.match(/^#{1,4}\s+Complexity\s+Audit\b/im);
    if (!auditMatch) {
        return 'Unknown';
    }

    const auditStart = auditMatch.index! + auditMatch[0].length;
    const afterAudit = content.slice(auditStart);
    const bandBMatch = afterAudit.match(
        /^\s*(?:#{1,4}\s+|\*\*)?(?:Classification[\s:]*)?(?:\*\*)?\s*(?:Band\s+B|Complex\s*(?:\/\s*Risky)?|Complex)\b/im
    );
    if (!bandBMatch) return '3';

    const bandBStart = bandBMatch.index! + bandBMatch[0].length;
    const afterBandB = afterAudit.slice(bandBStart);
    const nextSection = afterBandB.match(
        /^\s*(?:#{1,4}\s+|Band\s+[C-Z]\b|\*\*Recommendation\*\*\s*:|Recommendation\s*:|---+\s*$)/im
    );
    const bandBContent = nextSection
        ? afterBandB.slice(0, nextSection.index).trim()
        : afterBandB.trim();

    const normalizeBandBLine = (line: string): string => (
        line
            .replace(/^[\s>*\-+\u2013\u2014:]+/, '')
            .replace(/[*_`~]/g, '')
            .trim()
            .replace(/\((?:complex(?:\s*[\/&]\s*|\s+)risky|complex|risky|high complexity)\)/gi, '')
            .replace(/^\((.*)\)$/, '$1')
            .replace(/[\s:\u2013\u2014-]+$/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
    );

    const isBandBLabel = (line: string): boolean => (
        /^(complex(?:\s*(?:\/|and)\s*|\s+)risky|complex|risky|high complexity|routine)\.?$/.test(line)
    );

    const isEmptyMarker = (line: string): boolean => {
        if (!line) return true;
        if (/^(?:\u2014|-)+$/.test(line)) return true;
        return /^(none|n\/?a|unknown)\.?$/.test(line);
    };

    const meaningful = bandBContent
        .split(/\r?\n/)
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0)
        .map(normalizeBandBLine)
        .filter((line: string) => line.length > 0)
        .filter((line: string) => !isEmptyMarker(line) && !isBandBLabel(line) && !/^recommendation\b/.test(line));

    return meaningful.length === 0 ? '3' : '8';
}
