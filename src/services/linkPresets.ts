/**
 * Canonical relationship-preset vocabulary — the TS source of truth.
 *
 * The webview (`src/webview/terminals.js`) holds a mirror copy of `LINK_PRESETS`
 * because it is served as a classic script with no module loading. A contract
 * test (`src/test/link-presets-mirror-contract.test.js`) enforces that the two
 * copies have identical ids, labels, templates and directions — the comment
 * convention alone did not hold for the standing-orders marker, so this one
 * gets a test.
 *
 * `direction` is load-bearing:
 * - `'member-receives'` — the order is installed ON the member ABOUT the head
 *   (member is `parent`, head is `child` in standing-orders terms). Only
 *   `reports-to-head` uses this direction.
 * - `'head-receives'` — the order is installed ON the head ABOUT the member
 *   (head is `parent`, member is `child`). Every other preset uses this
 *   direction.
 *
 * Inferring direction is how the orientation gets flipped silently; storing it
 * on the preset is the guard.
 *
 * `custom` is a UI sentinel with an empty template, NOT a relationship. It is
 * excluded from the member relationship dropdown and rejected host-side — a
 * member carrying `relationship: 'custom'` falls back to `reports-to-head`
 * rather than installing an empty order.
 */

export type LinkPresetDirection = 'member-receives' | 'head-receives';

export interface LinkPreset {
    id: string;
    label: string;
    direction: LinkPresetDirection;
    template: string;
}

/**
 * The callback contract installed on every worker by default.
 *
 * Byte-identical to `AGENT_GROUP_CALLBACK_INSTRUCTION` in `teamWiring.ts`.
 * The contract test (`link-presets-mirror-contract.test.js`) enforces this —
 * two copies exist because `linkPresets.ts` cannot import from `teamWiring.ts`
 * without creating a circular dependency (`teamWiring.ts` imports the resolver
 * from here). The text names the delivery ROUTE, not just the obligation.
 */

/**
 * The canonical preset list. Order matters: `LINK_PRESETS[0]` is the default
 * `linkPreset` for the Link-up modal in the webview. Do not reorder — every
 * install's saved default silently changes meaning if you do.
 *
 * Single-quoted concatenation, NOT template literals: preset prose must never
 * be evaluated, and `{child}` / `{parent}` are substituted by `resolvePreset`.
 */
export const LINK_PRESETS: ReadonlyArray<LinkPreset> = [
    {
        id: 'researcher',
        label: 'Researcher — it researches for me',
        direction: 'head-receives',
        template:
            '{child} is your researcher. When you hit a question that needs external sources, '
            + 'documentation or API details you do not already have, hand it to {child} with enough '
            + 'context to work standalone — it cannot see your conversation. Keep working on what you '
            + 'can while it runs, and fold its answer in when it comes back. Do not block on it.'
    },
    {
        id: 'reviewer',
        label: 'Reviewer — it reviews my work',
        direction: 'head-receives',
        template:
            '{child} is your reviewer. When you finish a self-contained unit of work, hand {child} '
            + 'a summary of what changed and which files — it cannot see your conversation, so make '
            + 'the summary stand on its own — and ask it to review before you move on to the next '
            + 'unit. Address what it raises rather than deferring it.'
    },
    {
        id: 'tester',
        label: 'Tester — it verifies my work',
        direction: 'head-receives',
        template:
            '{child} is your tester. When a change is ready to verify, hand {child} what you changed '
            + 'and what the expected behaviour is — it cannot see your conversation, so state both '
            + 'explicitly — and let it run the checks. Treat a failure it reports as your work to fix, '
            + 'not its.'
    },
    {
        id: 'handoff',
        label: 'Hand off — give it my context',
        direction: 'head-receives',
        template:
            'Hand over the full context of what you are working on to {child}: the goal, what you have '
            + 'done so far, what is left, and any decisions or dead ends that matter. {child} has no '
            + 'visibility into your conversation, so write it to be picked up cold.'
    },
    {
        id: 'second-opinion',
        label: 'Second opinion — ask it before I decide',
        direction: 'head-receives',
        template:
            'Before you commit to an approach on anything non-trivial, put it to {child} as a second '
            + 'opinion: state the approach, the alternatives you rejected and why. Weigh what comes back '
            + 'on the merits — {child} is not the decision-maker, you are.'
    },
    {
        id: 'reports-to-head',
        label: 'Reports to me — it works what I hand it',
        direction: 'member-receives',
        // Byte-identical to AGENT_GROUP_CALLBACK_INSTRUCTION in teamWiring.ts.
        // The contract test enforces this — two copies exist to avoid a
        // circular dependency (teamWiring.ts imports the resolver from here).
        template:
            'it is your head agent. When you finish a task, report to it — POST /terminals/verb/ptySendPrompt with '
            + '{"name":"<that terminal>","data":"<your report>","clearBeforePrompt":false} against the port in '
            + '.switchboard/api-server-port.txt — naming what you changed and what to review. Do not wait to be asked.'
    },
    { id: 'custom', label: 'Custom…', direction: 'head-receives', template: '' }
];

/** The default relationship for a team member that does not specify one. */
export const DEFAULT_MEMBER_RELATIONSHIP = 'reports-to-head';

/**
 * Resolve a preset id to an instruction string with {child}/{parent}
 * substituted. Mirrors `resolvePreset` in `terminals.js`.
 *
 * Unknown id → `reports-to-head` (never empty). `custom` → `reports-to-head`
 * (never empty — `custom` is a UI sentinel, not a relationship).
 */
export function resolvePreset(id: string, parentName: string, childName: string): string {
    let preset = LINK_PRESETS.find(p => p.id === id);
    if (!preset || !preset.template || preset.id === 'custom') {
        preset = LINK_PRESETS.find(p => p.id === DEFAULT_MEMBER_RELATIONSHIP);
    }
    if (!preset || !preset.template) { return ''; }
    return preset.template
        .replace(/\{child\}/g, childName || 'the other terminal')
        .replace(/\{parent\}/g, parentName || 'this terminal');
}

/**
 * Look up a preset by id. Unknown id → `reports-to-head` preset.
 * `custom` → `reports-to-head` preset (never returns the custom sentinel).
 */
export function resolvePresetMeta(id: string): LinkPreset {
    let preset = LINK_PRESETS.find(p => p.id === id);
    if (!preset || !preset.template || preset.id === 'custom') {
        preset = LINK_PRESETS.find(p => p.id === DEFAULT_MEMBER_RELATIONSHIP);
    }
    return preset!;
}
