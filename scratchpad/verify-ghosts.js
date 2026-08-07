const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const { installVscodeTrap } = require('../src/test/helpers/verbEngineTestSeams');
installVscodeTrap();

const { TaskViewerProvider } = require('../out/services/TaskViewerProvider');

const DB = '/Users/patrickvuleta/Documents/Gitlab/.switchboard/kanban.db';
const RESOLVED_ROOT = '/Users/patrickvuleta/Documents/Gitlab';
const GHOST_DIR = '/Users/patrickvuleta/Documents/Gitlab/.switchboard/tickets/clickup/tech-team/q3-2026/sprint-4-108-238';
const GHOSTS = ['86d3y1w4e', '86d3y1y7z'];

function fetchRows() {
    const out = execSync(`sqlite3 "${DB}" "SELECT slug_prefix, file_path, remote_doc_id FROM imported_docs WHERE content_type='ticket' AND remote_doc_id IN ('${GHOSTS.join("','")}');"`, { encoding: 'utf8' });
    const rows = [];
    for (const line of out.trim().split('\n')) {
        const [slug, filePath, remoteId] = line.split('|');
        rows.push({ slugPrefix: slug, filePath: path.resolve(RESOLVED_ROOT, filePath).replace(/\\/g, '/'), remoteDocId: remoteId });
    }
    return rows;
}

function main() {
    const dbTickets = fetchRows();
    const remoteIds = new Set(); // empty so all locals get nominated
    const fakeThis = {};
    const candidates = TaskViewerProvider.prototype._collectDeletionCandidates.call(fakeThis, 'clickup', GHOST_DIR, dbTickets, remoteIds);

    const byId = new Map(candidates.map(c => [c.remoteId, c]));
    for (const id of GHOSTS) {
        const c = byId.get(id);
        console.log(`ghost ${id}:`, c ? JSON.stringify({ paths: c.paths, hasDbT: !!c.dbT }) : 'NOT NOMINATED');
    }
    const extra = candidates.filter(c => !GHOSTS.includes(c.remoteId)).map(c => c.remoteId);
    if (extra.length) { console.log('extra nominations:', extra); }
}

main().catch(e => { console.error(e); process.exit(1); });
