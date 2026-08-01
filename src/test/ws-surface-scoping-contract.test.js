const assert = require('assert');
const fs = require('fs');
const path = require('path');

describe('ws-surface-scoping-contract', () => {
    const wsHubPath = path.join(__dirname, '../services/wsHub.ts');
    const transportJsPath = path.join(__dirname, '../webview/transport.js');
    const bootstrapPath = path.join(__dirname, '../standalone/bootstrap.ts');

    const wsHubContent = fs.readFileSync(wsHubPath, 'utf8');
    const transportJsContent = fs.readFileSync(transportJsPath, 'utf8');
    const bootstrapContent = fs.readFileSync(bootstrapPath, 'utf8');

    it('untagged surface is broadcast to everyone', () => {
        assert.ok(wsHubContent.includes('if (surface && meta.surfaces && !meta.surfaces.has(surface))'), 'wsHub filter must check if surface is defined');
    });

    it('undeclared surfaces client receives everything', () => {
        assert.ok(wsHubContent.includes('surfaces?: Set<string>'), 'surfaces on ConnectionMeta must be optional');
    });

    it('surfaces query parameter is parsed during upgrade before resync', () => {
        const handleUpgradeIdx = wsHubContent.indexOf('public async handleUpgrade(');
        const parseSurfacesIdx = wsHubContent.indexOf('reqUrl.searchParams.get(\'surfaces\')');
        const resyncIdx = wsHubContent.indexOf('type: \'__resync\'');
        assert.ok(handleUpgradeIdx !== -1 && parseSurfacesIdx !== -1 && resyncIdx !== -1, 'handleUpgrade, parseSurfaces, and resync must exist');
        assert.ok(parseSurfacesIdx > handleUpgradeIdx && parseSurfacesIdx < resyncIdx, 'surfaces parse must occur inside handleUpgrade before __resync');
    });

    it('unknown surfaces are filtered against VALID_SURFACES', () => {
        assert.ok(wsHubContent.includes('VALID_SURFACES.has(s)'), 'surfaces parse must filter against VALID_SURFACES');
    });

    it('updateBoard state item is tagged with surface', () => {
        assert.ok(bootstrapContent.includes("surface: SURFACES.kanban"), 'updateBoard state item in bootstrap must be tagged');
    });

    it('transport.js reads dataset.panel in wsUrl', () => {
        const wsUrlIdx = transportJsContent.indexOf('function wsUrl()');
        const datasetPanelIdx = transportJsContent.indexOf('document.body.dataset.panel');
        assert.ok(wsUrlIdx !== -1 && datasetPanelIdx !== -1, 'wsUrl and dataset.panel check must exist');
        assert.ok(datasetPanelIdx > wsUrlIdx, 'dataset.panel check must occur inside wsUrl()');
    });

    it('seq is not incremented when push is skipped', () => {
        const broadcastBlock = wsHubContent.substring(
            wsHubContent.indexOf('broadcast(verb: string'),
            wsHubContent.indexOf('send(ws: WebSocket')
        );
        const continueIdx = broadcastBlock.indexOf('continue;');
        const seqIncIdx = broadcastBlock.indexOf('meta.seq += 1;');
        assert.ok(continueIdx !== -1 && seqIncIdx !== -1, 'continue and seq increment must exist in broadcast');
        assert.ok(continueIdx < seqIncIdx, 'skip continue must precede meta.seq increment');
    });
});
