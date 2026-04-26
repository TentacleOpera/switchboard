// Canonical parser for plan-file dependencies. Used by KanbanProvider and
// TaskViewerProvider. Returns an array of dependency identifiers preferring
// sess_* sessionIds; falls back to cleaned topic strings when no sess_*
// token is present on a dep line. Callers join with ', ' for DB storage.

const SESS_TOKEN_RE = /sess_\d+/g;
const HEADING_RE = /^#{1,4}\s+Dependencies\b[^\n]*$/im;
const NEXT_HEADING_RE = /^\s*#{1,4}\s+/m;
const BULLET_LABEL_RE = /^(\s*)[-*+]\s+\*\*\s*Dependencies\s*(?:&\s*Conflicts)?\s*[:\*]/im;

function cleanDepLine(line: string): string {
    return line
        .replace(/^[-*+]\s+/, '')
        .replace(/^\d+\.\s+/, '')
        .replace(/^\*\*/, '').replace(/\*\*$/, '')
        .trim();
}

function isEmptyMarker(line: string): boolean {
    return /^(none|n\/a|na|unknown)\.?$/i.test(line);
}

function extractIdentifiersFromLine(line: string): string[] {
    const sessTokens = line.match(SESS_TOKEN_RE);
    if (sessTokens && sessTokens.length > 0) {
        return Array.from(new Set(sessTokens));
    }
    const cleaned = cleanDepLine(line);
    if (!cleaned || isEmptyMarker(cleaned)) return [];
    // Strip trailing parenthetical metadata and em-dash descriptions to
    // leave just the topic-form candidate.
    const topicOnly = cleaned
        .split(/\s[—-]\s/)[0]
        .split(/\s*\(/)[0]
        .replace(/^"(.+)"$/, '$1')
        .replace(/^'(.+)'$/, '$1')
        .trim();
    return topicOnly.length > 0 && !isEmptyMarker(topicOnly) ? [topicOnly] : [];
}

function parseHeadingSection(content: string): string[] | null {
    const match = content.match(HEADING_RE);
    if (!match || match.index === undefined) return null;
    const after = content.slice(match.index + match[0].length);
    const next = after.match(NEXT_HEADING_RE);
    const body = next ? after.slice(0, next.index) : after;
    const ids: string[] = [];
    for (const rawLine of body.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        ids.push(...extractIdentifiersFromLine(line));
    }
    return Array.from(new Set(ids));
}

function parseBulletSection(content: string): string[] {
    const lines = content.split(/\r?\n/);
    let startIdx = -1;
    let labelIndent = '';
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(BULLET_LABEL_RE);
        if (m) {
            startIdx = i;
            labelIndent = m[1] || '';
            break;
        }
    }
    if (startIdx < 0) return [];

    // Label line tail (same-line content after the ':'). We split its
    // contribution into sess-token-only vs full (which includes topic-form
    // fallback) so we can discard the topic-form if real sub-bullet deps
    // follow — prose like "See below." or the unfilled template placeholder
    // "[Identify if this plan relies on ...]" must not be extracted as deps.
    const firstLineTail = lines[startIdx].replace(BULLET_LABEL_RE, '').trim();
    const firstTailSessTokens = firstLineTail ? (firstLineTail.match(SESS_TOKEN_RE) || []) : [];
    const firstTailFullIds = firstLineTail ? extractIdentifiersFromLine(firstLineTail) : [];

    // Consume subsequent lines that are either (a) indented deeper than
    // labelIndent, or (b) continuation prose. Stop at the next peer bullet
    // at labelIndent depth or at any heading.
    const peerBulletRe = new RegExp(`^${labelIndent}[-*+]\\s+`);
    const subIds: string[] = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
        const raw = lines[i];
        if (/^#{1,6}\s+/.test(raw)) break;
        if (peerBulletRe.test(raw)) break;
        const trimmed = raw.trim();
        if (!trimmed) continue;
        subIds.push(...extractIdentifiersFromLine(trimmed));
    }

    // Precedence: if sub-bullets produced any identifiers, prefer them plus
    // only the label line's sess tokens (drop its topic-form fallback to
    // avoid picking up connective prose). Otherwise use the label tail as-is.
    const combined = subIds.length > 0
        ? [...firstTailSessTokens, ...subIds]
        : firstTailFullIds;
    return Array.from(new Set(combined));
}

export interface ParsedDependencies {
    identifiers: string[];      // canonical: sess_* preferred, topics as fallback
    source: 'heading' | 'bullet' | 'none';
}

export function parsePlanDependencies(content: string): ParsedDependencies {
    const headingResult = parseHeadingSection(content);
    if (headingResult !== null) {
        return { identifiers: headingResult, source: 'heading' };
    }
    const bulletResult = parseBulletSection(content);
    if (bulletResult.length > 0) {
        return { identifiers: bulletResult, source: 'bullet' };
    }
    return { identifiers: [], source: 'none' };
}

export function dependenciesToCsv(identifiers: string[]): string {
    return identifiers.join(', ');
}
