/**
 * Regression test for the canonical plan-file dependency parser.
 *
 * Source of truth: src/services/planDependencyParser.ts
 *
 * Pattern mirrors sanitize-tags-regression.test.js: prefer the compiled
 * export from out/services/planDependencyParser.js (built by
 * `npm run compile-tests`); fall back to a literal copy that must be
 * kept in lock-step with the TS source.
 *
 * Runs standalone:
 *   node src/test/plan-dependency-parser.test.js
 */

'use strict';

const assert = require('assert');
const path = require('path');

function resolveParser() {
    try {
        // eslint-disable-next-line global-require
        const mod = require(path.resolve(__dirname, '..', '..', 'out', 'services', 'planDependencyParser.js'));
        if (mod && typeof mod.parsePlanDependencies === 'function') {
            return {
                parsePlanDependencies: mod.parsePlanDependencies,
                dependenciesToCsv: mod.dependenciesToCsv,
                source: 'compiled'
            };
        }
    } catch (_err) {
        // fall through
    }

    // Literal copy mirroring src/services/planDependencyParser.ts. Keep in sync.
    const SESS_TOKEN_RE = /sess_\d+/g;
    const HEADING_RE = /^#{1,4}\s+Dependencies\b[^\n]*$/im;
    const NEXT_HEADING_RE = /^\s*#{1,4}\s+/m;
    const BULLET_LABEL_RE = /^(\s*)[-*+]\s+\*\*\s*Dependencies\s*(?:&\s*Conflicts)?\s*[:\*]/im;

    function cleanDepLine(line) {
        return line
            .replace(/^[-*+]\s+/, '')
            .replace(/^\d+\.\s+/, '')
            .replace(/^\*\*/, '').replace(/\*\*$/, '')
            .trim();
    }
    function isEmptyMarker(line) {
        return /^(none|n\/a|na|unknown)\.?$/i.test(line);
    }
    function extractIdentifiersFromLine(line) {
        const sessTokens = line.match(SESS_TOKEN_RE);
        if (sessTokens && sessTokens.length > 0) {
            return Array.from(new Set(sessTokens));
        }
        const cleaned = cleanDepLine(line);
        if (!cleaned || isEmptyMarker(cleaned)) return [];
        const topicOnly = cleaned
            .split(/\s[—-]\s/)[0]
            .split(/\s*\(/)[0]
            .replace(/^"(.+)"$/, '$1')
            .replace(/^'(.+)'$/, '$1')
            .trim();
        return topicOnly.length > 0 && !isEmptyMarker(topicOnly) ? [topicOnly] : [];
    }
    function parseHeadingSection(content) {
        const match = content.match(HEADING_RE);
        if (!match || match.index === undefined) return null;
        const after = content.slice(match.index + match[0].length);
        const next = after.match(NEXT_HEADING_RE);
        const body = next ? after.slice(0, next.index) : after;
        const ids = [];
        for (const rawLine of body.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line) continue;
            ids.push(...extractIdentifiersFromLine(line));
        }
        return Array.from(new Set(ids));
    }
    function parseBulletSection(content) {
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
        const firstLineTail = lines[startIdx].replace(BULLET_LABEL_RE, '').trim();
        const firstTailSessTokens = firstLineTail ? (firstLineTail.match(SESS_TOKEN_RE) || []) : [];
        const firstTailFullIds = firstLineTail ? extractIdentifiersFromLine(firstLineTail) : [];
        const peerBulletRe = new RegExp('^' + labelIndent + '[-*+]\\s+');
        const subIds = [];
        for (let i = startIdx + 1; i < lines.length; i++) {
            const raw = lines[i];
            if (/^#{1,6}\s+/.test(raw)) break;
            if (peerBulletRe.test(raw)) break;
            const trimmed = raw.trim();
            if (!trimmed) continue;
            subIds.push(...extractIdentifiersFromLine(trimmed));
        }
        const combined = subIds.length > 0
            ? [...firstTailSessTokens, ...subIds]
            : firstTailFullIds;
        return Array.from(new Set(combined));
    }
    function parsePlanDependencies(content) {
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
    function dependenciesToCsv(identifiers) {
        return identifiers.join(', ');
    }
    return { parsePlanDependencies, dependenciesToCsv, source: 'literal-fallback' };
}

const { parsePlanDependencies, dependenciesToCsv, source } = resolveParser();

let pass = 0;
let fail = 0;
const failures = [];

function expect(label, actual, expected) {
    try {
        assert.deepStrictEqual(actual, expected);
        pass += 1;
    } catch (err) {
        fail += 1;
        failures.push({ label, actual: err.actual, expected: err.expected });
    }
}

// Case 1: heading form with sess lines in the plan's mandated format.
expect(
    'heading form: sess_XXX — topic lines',
    parsePlanDependencies('## Dependencies\nsess_1776554943477 — Refactor Research Modal\nsess_1776555843399 — Notion Page Hierarchy\n\n## Next\n'),
    { identifiers: ['sess_1776554943477', 'sess_1776555843399'], source: 'heading' }
);

// Case 2: heading form with None marker → empty array.
expect(
    'heading form: None marker returns empty',
    parsePlanDependencies('## Dependencies\nNone\n\n## Next\n'),
    { identifiers: [], source: 'heading' }
);

// Case 3: heading form with prose lines containing sess tokens → tokens extracted.
expect(
    'heading form: prose with inline sess tokens',
    parsePlanDependencies('## Dependencies\n- Depends on sess_111 and sess_222 for the frontend sort.\n'),
    { identifiers: ['sess_111', 'sess_222'], source: 'heading' }
);

// Case 4: heading form with topic-only lines (no sess tokens).
expect(
    'heading form: topic-only fallback',
    parsePlanDependencies('## Dependencies\n- Some Plan Title\n'),
    { identifiers: ['Some Plan Title'], source: 'heading' }
);

// Case 5: bullet form with nested sub-bullets containing sess tokens.
expect(
    'bullet form: nested sub-bullets with sess tokens',
    parsePlanDependencies(
        '## Edge-Case & Dependency Audit\n' +
        '- **Race Conditions:** foo\n' +
        '- **Dependencies & Conflicts:** See below.\n' +
        '  - sess_333 — PlanA\n' +
        '  - sess_444 — PlanB\n' +
        '- **Side Effects:** ignored\n' +
        '## Next\n'
    ),
    { identifiers: ['sess_333', 'sess_444'], source: 'bullet' }
);

// Case 6: bullet form with pure prose, no tokens → topic-form extraction.
expect(
    'bullet form: prose-only topic extraction',
    parsePlanDependencies(
        '- **Dependencies & Conflicts:** Notion Page Hierarchy Filtering — explanation\n' +
        '- **Next:** unrelated\n'
    ),
    { identifiers: ['Notion Page Hierarchy Filtering'], source: 'bullet' }
);

// Case 7: BOTH heading and bullet → heading wins (precedence).
expect(
    'precedence: heading wins over bullet',
    parsePlanDependencies(
        '## Dependencies\nsess_999\n\n' +
        '## Edge-Case\n- **Dependencies & Conflicts:** sess_000\n'
    ),
    { identifiers: ['sess_999'], source: 'heading' }
);

// Case 8: neither section present.
expect(
    'no deps section present',
    parsePlanDependencies('# Plan Title\nSome body text\n'),
    { identifiers: [], source: 'none' }
);

// Case 9: dedup sess tokens that appear multiple times.
expect(
    'dedup repeated sess tokens',
    parsePlanDependencies('## Dependencies\nsess_100 — A\nsess_100 — A (repeat)\n'),
    { identifiers: ['sess_100'], source: 'heading' }
);

// Case 10: heading with empty body → empty array, source='heading'.
expect(
    'heading form: empty body',
    parsePlanDependencies('## Dependencies\n\n## Next\n'),
    { identifiers: [], source: 'heading' }
);

// Case 11: Edge-Case & Dependency Audit (singular Dependency) must not be matched as heading.
expect(
    'singular Dependency heading not matched',
    parsePlanDependencies('## Edge-Case & Dependency Audit\n- **Dependencies & Conflicts:** sess_555\n'),
    { identifiers: ['sess_555'], source: 'bullet' }
);

// Case 12: dependenciesToCsv joins with ', '.
try {
    assert.strictEqual(dependenciesToCsv(['a', 'b', 'c']), 'a, b, c');
    assert.strictEqual(dependenciesToCsv([]), '');
    pass += 2;
} catch (err) {
    fail += 1;
    failures.push({ label: 'dependenciesToCsv', actual: err.actual, expected: err.expected });
}

console.log(`[plan-dependency-parser] source=${source} passed=${pass} failed=${fail}`);
if (fail > 0) {
    for (const f of failures) {
        console.error('  FAIL', f.label, '->', JSON.stringify(f.actual), 'expected', JSON.stringify(f.expected));
    }
    process.exit(1);
}
process.exit(0);
