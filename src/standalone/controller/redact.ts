/**
 * Redaction of log slices before they leave the board
 * (plan: the-controller-wakes-on-a-clock-diagnoses-and-reports, change 5).
 *
 * `GET /terminals/<name>/log`'s own docblock is explicit: the log files may
 * contain secrets (agent terminals echo tokens, env and paths). Every slice
 * that reaches a report entry — and, when the judgement tier exists, every
 * slice that reaches a model call — is redacted first, and the SMALLEST window
 * that answers the rule is the window used.
 *
 * The failure this prevents is invisible until someone reads the report, so the
 * redactor is paired with a negative/positive invariant: the entry must contain
 * no unredacted token, env value or absolute path, AND must still carry an
 * evidence window sufficient to identify the rule's trigger.
 */

const REDACTED = '[REDACTED]';
const PATH_MARK = '[PATH]';

/** Ordered, most-specific-first. Each pattern is global. */
const RULES: ReadonlyArray<{ re: RegExp; replace: (m: RegExpMatchArray) => string }> = [
    // Authorization headers and bearer tokens.
    { re: /(authorization\s*[:=]\s*)([^\s,;]+)/gi, replace: m => `${m[1]}${REDACTED}` },
    { re: /(bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi, replace: m => `${m[1]}${REDACTED}` },
    // key=value / key: value secrets, preserving the key so the shape survives.
    {
        re: /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|passphrase|private[_-]?key|client[_-]?secret|pat)\b(\s*[:=]\s*)("([^"]*)"|'([^']*)'|\S+)/gi,
        replace: m => `${m[1]}${m[2]}${REDACTED}`,
    },
    // env-style assignments: KEEP the variable name, drop the value.
    { re: /\b([A-Z][A-Z0-9_]{2,})\s*=\s*("([^"]*)"|'([^']*)'|\S+)/g, replace: m => `${m[1]}=${REDACTED}` },
    // Absolute paths (POSIX and Windows). The shape is what leaks usernames and
    // directory layouts; the basename is not needed to identify a rule trigger.
    { re: /(?:\/Users\/|\/home\/|\/root\/|\/private\/|\/var\/folders\/)(?:[^\s'"`)\]},;]+)/g, replace: () => PATH_MARK },
    { re: /\/(?:opt|etc|usr|tmp|var|srv|mnt|media|proc|sys|dev|run|bin|sbin|lib|lib64|boot)\/[^\s'"`)\]},;]+/g, replace: () => PATH_MARK },
    { re: /\b[A-Za-z]:\\(?:[^\s'"`)\]},;\\]+\\)*/g, replace: () => PATH_MARK },
    // Long opaque blobs: hex, base64, JWTs. Below the threshold a value is
    // almost certainly a hash or an id the report can keep.
    { re: /\b[A-Fa-f0-9]{32,}\b/g, replace: () => REDACTED },
    { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, replace: () => REDACTED },
    { re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, replace: () => REDACTED },
];

export function redact(text: string): string {
    if (!text) { return ''; }
    let out = text;
    for (const rule of RULES) {
        out = out.replace(rule.re, (...args) => {
            const m = args.slice(0, -2) as unknown as RegExpMatchArray;
            return rule.replace(m);
        });
    }
    return out;
}

/**
 * Redact, then clip to the last `maxChars` characters — the smallest window
 * that answers the rule is the window used, and a tail is where a stall's cause
 * lives. Clipping happens AFTER redaction so a secret straddling the clip
 * boundary cannot survive as a fragment.
 */
export function redactAndTail(text: string, maxChars = 4000): string {
    const cleaned = redact(text);
    if (cleaned.length <= maxChars) { return cleaned; }
    return `…[clipped]\n${cleaned.slice(cleaned.length - maxChars)}`;
}

/**
 * Evidence sanity check used by the report composer: true when the redacted
 * slice still carries something a reader can act on (a non-whitespace,
 * non-placeholder line). Guards the paired invariant — redaction must not blank
 * the whole window.
 */
export function hasUsableEvidence(text: string): boolean {
    return text
        .split('\n')
        .some(line => {
            const t = line.replace(new RegExp(REDACTED.replace(/[[\]]/g, '\\$&'), 'g'), '').replace(new RegExp(PATH_MARK.replace(/[[\]]/g, '\\$&'), 'g'), '').trim();
            return t.length >= 8;
        });
}
