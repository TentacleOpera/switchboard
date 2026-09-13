#!/usr/bin/env node
'use strict';
const fs = require('fs');

let src = fs.readFileSync('src/services/bundledProtocols.ts', 'utf8');

// The old Reports channel section starts with this escaped string
const oldSectionStart = '### Reports channel \\u2014 `.switchboard/mission-control/reports/`';
const idx = src.indexOf(oldSectionStart);
if (idx < 0) { console.log('NOT FOUND'); process.exit(1); }

// Find the end: the next \n## Notes
const nextSectionIdx = src.indexOf('\\n## Notes', idx + oldSectionStart.length);
if (nextSectionIdx < 0) { console.log('END NOT FOUND'); process.exit(1); }

const oldSection = src.slice(idx, nextSectionIdx);
console.log('Old section length:', oldSection.length);

// New section in escaped JSON form (matching the file's encoding)
const newSection = [
    '### Reports channel \\u2014 `switchboard reports`',
    '',
    'A **report is a host-recorded turn-end event** stored in the `plan_events` table (event_type `turn_end`), not a file. The host writes a row on every turn-end (finished, blocked, stalled), joined to the card\'s current kanban column. This is **not an HTTP surface** \\u2014 there is no `GET /mission-control/reports` endpoint. Read reports via the CLI:',
    '',
    '```bash',
    'switchboard reports [--kind blocked|finished] [--limit N] [--json]',
    '```',
    '',
    '- `--kind blocked` filters to blocked turn-ends (a seat went quiet or a feature stalled).',
    '- `--kind finished` filters to finished turn-ends (a seat completed its turn).',
    '- The output includes each card\'s **current kanban column**, so you can tell whether a formerly blocked card is still blocked.',
    '- A row whose card was deleted or archived still appears, with `[no card]` \\u2014 the record survives its card.',
    '- Rows are pruned by the retention service; the accumulation that 1900+ files became cannot recur.',
    '- `from: system` marks a host-written row. Agent-authored reports are a separate path (team reports via `GET /teams/<id>/reports`), not this channel.',
    '- The old file-based channel (`.switchboard/mission-control/reports/`) is retired. Existing files remain as archival evidence; no code reads or writes them.',
].join('\\n');

src = src.slice(0, idx) + newSection + src.slice(nextSectionIdx);
fs.writeFileSync('src/services/bundledProtocols.ts', src);
console.log('DONE - wrote', src.length, 'bytes');
