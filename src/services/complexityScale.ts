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
