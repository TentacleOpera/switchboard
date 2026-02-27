'use strict';

const assert = require('assert');

function dedupeEvents(events) {
    const unique = new Map();
    for (const event of events) {
        if (!event || typeof event !== 'object') continue;
        const workflow = typeof event.workflow === 'string' ? event.workflow : 'unknown';
        const action = typeof event.action === 'string' ? event.action : 'unknown';
        const timestamp = typeof event.timestamp === 'string' ? event.timestamp : new Date(0).toISOString();
        const key = `${workflow}|${timestamp}|${action}`;
        if (!unique.has(key)) {
            unique.set(key, { ...event, workflow, timestamp, action });
        }
    }

    return [...unique.values()].sort((a, b) => {
        const aTs = Date.parse(a.timestamp || '');
        const bTs = Date.parse(b.timestamp || '');
        const aValue = Number.isFinite(aTs) ? aTs : Number.MAX_SAFE_INTEGER;
        const bValue = Number.isFinite(bTs) ? bTs : Number.MAX_SAFE_INTEGER;
        return aValue - bValue;
    });
}

function chooseCanonical(duplicates, canonicalId) {
    const scored = duplicates.map((dup) => {
        const content = dup.content || {};
        const metadataScore =
            (typeof content.topic === 'string' && content.topic.trim() ? 1 : 0) +
            (typeof content.brainSourcePath === 'string' && content.brainSourcePath.trim() ? 1 : 0) +
            (typeof content.planFile === 'string' && content.planFile.trim() ? 1 : 0) +
            (Array.isArray(content.events) && content.events.length > 0 ? 1 : 0);

        const events = Array.isArray(content.events) ? content.events : [];
        const latestEventTs = events.reduce((max, ev) => {
            const ts = Date.parse((ev && ev.timestamp) || '');
            if (!Number.isFinite(ts)) return max;
            return Math.max(max, ts);
        }, Number.NEGATIVE_INFINITY);

        return {
            dup,
            isCanonicalId: dup.sessionId === canonicalId ? 1 : 0,
            metadataScore,
            latestEventTs,
            runSheetPath: dup.runSheetPath
        };
    });

    scored.sort((a, b) => {
        if (b.isCanonicalId !== a.isCanonicalId) return b.isCanonicalId - a.isCanonicalId;
        if (b.metadataScore !== a.metadataScore) return b.metadataScore - a.metadataScore;
        if (b.latestEventTs !== a.latestEventTs) return b.latestEventTs - a.latestEventTs;
        return a.runSheetPath.localeCompare(b.runSheetPath);
    });

    return scored[0].dup;
}

describe('brain session dedupe rules', () => {
    it('dedupes equivalent events and sorts by timestamp', () => {
        const merged = dedupeEvents([
            { workflow: 'Implementation', action: 'start', timestamp: '2026-02-23T02:00:00.000Z' },
            { action: 'start', workflow: 'Implementation', timestamp: '2026-02-23T02:00:00.000Z' },
            { workflow: 'challenge', action: 'start', timestamp: '2026-02-23T03:00:00.000Z' },
            { workflow: 'jules', action: 'start', timestamp: 'invalid' }
        ]);

        assert.strictEqual(merged.length, 3);
        assert.strictEqual(merged[0].workflow, 'Implementation');
        assert.strictEqual(merged[1].workflow, 'challenge');
        assert.strictEqual(merged[2].workflow, 'jules');
    });

    it('selects deterministic canonical duplicate using canonical id preference', () => {
        const canonicalId = 'antigravity_abc';
        const duplicates = [
            {
                sessionId: 'antigravity_def',
                runSheetPath: 'b.json',
                content: {
                    topic: 'Topic',
                    brainSourcePath: 'C:/x.md',
                    planFile: 'x.md',
                    events: [{ workflow: 'Implementation', action: 'start', timestamp: '2026-02-23T01:00:00.000Z' }]
                }
            },
            {
                sessionId: canonicalId,
                runSheetPath: 'a.json',
                content: {
                    topic: '',
                    brainSourcePath: 'C:/x.md',
                    planFile: '',
                    events: []
                }
            }
        ];

        const selected = chooseCanonical(duplicates, canonicalId);
        assert.strictEqual(selected.sessionId, canonicalId);
    });

    it('uses stable tie-breaker by path when scores are equal', () => {
        const canonicalId = 'antigravity_missing';
        const duplicates = [
            {
                sessionId: 'antigravity_2',
                runSheetPath: 'z.json',
                content: { topic: 'A', brainSourcePath: 'C:/x.md', planFile: 'x.md', events: [] }
            },
            {
                sessionId: 'antigravity_1',
                runSheetPath: 'a.json',
                content: { topic: 'A', brainSourcePath: 'C:/x.md', planFile: 'x.md', events: [] }
            }
        ];

        const selected = chooseCanonical(duplicates, canonicalId);
        assert.strictEqual(selected.runSheetPath, 'a.json');
    });
});
