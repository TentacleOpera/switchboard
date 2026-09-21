/**
 * Daily request budgets for a judgement model.
 *
 * A budget is a FACT ABOUT THE OPERATOR'S PLAN, not about the model, so it can
 * never be derived with certainty from a model id. What this table holds is the
 * published free-tier allowance for the combinations we know, and every answer
 * carries the source that produced it:
 *
 *   - `operator`   — set explicitly. Always wins.
 *   - `default:*`  — a published allowance for this provider/model.
 *   - `unmetered`  — self-hosted; there is no request ceiling to count against.
 *   - `unknown`    — we do not know, and NOTHING is substituted.
 *
 * `unknown` returns a null limit on purpose. A plausible number here would be
 * the worst kind of default: the panel would draw a budget bar, the operator
 * would plan against it, and the real ceiling would be somewhere else entirely.
 * "We do not know this model's allowance" is the honest answer and the panel
 * says it in those words.
 */

export type BudgetSource = 'operator' | 'unmetered' | 'unknown' | string;

export interface BudgetView {
    /** Requests per day, or null when unknown / unmetered. */
    perDay: number | null;
    source: BudgetSource;
    /** One line the panel can show verbatim when asked why. */
    note: string;
}

interface DefaultRule {
    providerId: string;
    /** Matched case-insensitively against the model id as a substring. */
    modelMatch: string;
    perDay: number;
    source: string;
    note: string;
}

/**
 * Published free-tier allowances. Keep this list short and sourced: a rule that
 * nobody can check is a guess with a citation-shaped comment next to it.
 */
const DEFAULTS: DefaultRule[] = [
    {
        providerId: 'google',
        modelMatch: 'gemma',
        perDay: 1500,
        source: 'default:google-free-tier',
        note: 'Google AI free tier allows 1500 Gemma requests a day.',
    },
];

/** Localities where the operator owns the hardware, so requests are not rationed. */
const SELF_HOSTED = new Set(['loopback', 'lan', 'tailnet', 'local']);

/**
 * Resolve the budget for one station.
 *
 * `operatorPerDay` is whatever the operator set for this station, and it is
 * taken at face value including when it differs from the published default —
 * a paid plan is exactly the case the default gets wrong.
 */
export function resolveBudget(args: {
    providerId?: string | null;
    model?: string | null;
    locality?: string | null;
    operatorPerDay?: number | null;
}): BudgetView {
    const operator = args.operatorPerDay;
    if (typeof operator === 'number' && Number.isFinite(operator) && operator > 0) {
        return { perDay: Math.round(operator), source: 'operator', note: 'Set by you.' };
    }

    const locality = String(args.locality || '').toLowerCase();
    if (SELF_HOSTED.has(locality)) {
        return {
            perDay: null,
            source: 'unmetered',
            note: 'Self-hosted — no request ceiling to count against.',
        };
    }

    const provider = String(args.providerId || '').toLowerCase();
    const model = String(args.model || '').toLowerCase();
    for (const rule of DEFAULTS) {
        if (rule.providerId === provider && model.includes(rule.modelMatch)) {
            return { perDay: rule.perDay, source: rule.source, note: rule.note };
        }
    }

    return {
        perDay: null,
        source: 'unknown',
        note: 'No published allowance is known for this model. Set one to see usage against it.',
    };
}

/** The key a day's per-model counter is stored under. */
export function usageKey(providerId?: string | null, model?: string | null): string {
    return `${String(providerId || 'unknown')}/${String(model || 'unknown')}`;
}
