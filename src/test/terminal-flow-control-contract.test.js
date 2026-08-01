const assert = require('assert');
const fs = require('fs');
const path = require('path');

describe('terminal-flow-control-contract', () => {
    const gatewayPath = path.join(__dirname, '../standalone/terminalWsGateway.ts');
    const terminalsJsPath = path.join(__dirname, '../webview/terminals.js');

    const gatewayContent = fs.readFileSync(gatewayPath, 'utf8');
    const terminalsJsContent = fs.readFileSync(terminalsJsPath, 'utf8');

    it('terminals.js acks from write callback', () => {
        assert.ok(terminalsJsContent.includes('term.write(combined, () => onWriteParsed(entry, combined.length))'), 'flushBatch must pass write callback');
        assert.ok(terminalsJsContent.includes("t: 'ack'"), 'onWriteParsed must send ack frame');
    });

    it('flushBatch is try/catch guarded', () => {
        assert.ok(/try\s*\{\s*entry\.term\.write/.test(terminalsJsContent), 'term.write must be wrapped in try block');
    });

    it('gateway handles ack frame with clamp', () => {
        assert.ok(gatewayContent.includes("parsed.t === 'ack'"), 'gateway message handler must handle ack frame');
        assert.ok(gatewayContent.includes('Math.max(0, Math.min(parsed.chars, client.unackedChars))'), 'gateway must clamp acked chars');
    });

    it('replay is not counted against unackedChars', () => {
        const setupClientBlock = gatewayContent.substring(
            gatewayContent.indexOf('private setupClient('),
            gatewayContent.indexOf('ws.on(\'pong\'')
        );
        assert.ok(!setupClientBlock.includes('unackedChars +='), 'setupClient replay section must not inflate unackedChars');
    });

    it('pause/resume gates on both byte and char watermarks', () => {
        assert.ok(gatewayContent.includes('HIGH_WATER_CHARS'), 'HIGH_WATER_CHARS constant must be defined');
        assert.ok(gatewayContent.includes('LOW_WATER_CHARS'), 'LOW_WATER_CHARS constant must be defined');
        assert.ok(gatewayContent.includes('maxBuffered > HIGH_WATER_MARK_BYTES || maxUnacked > HIGH_WATER_CHARS'), 'pause condition must check maxBuffered or maxUnacked');
        assert.ok(gatewayContent.includes('maxBuffered < LOW_WATER_MARK_BYTES && maxUnacked < LOW_WATER_CHARS'), 'resume condition must check maxBuffered and maxUnacked');
    });

    it('MAX_PAUSE_MS safety valve is present', () => {
        assert.ok(gatewayContent.includes('MAX_PAUSE_MS'), 'MAX_PAUSE_MS constant must be defined');
        assert.ok(gatewayContent.includes('now - pausedTime > MAX_PAUSE_MS'), 'safety valve check must be present');
    });

    it('no per-terminal animationFrameId in terminals.js entry shape', () => {
        assert.ok(!terminalsJsContent.includes('animationFrameId: null'), 'entry shape must not have animationFrameId');
    });

    it('credit resets on attach', () => {
        assert.ok(gatewayContent.includes('unackedChars: 0'), 'setupClient must initialize unackedChars to 0');
    });

    it('unassign arms disposal timer', () => {
        assert.ok(terminalsJsContent.includes('armDetachTimer(name)'), 'renderPaneGrid unassigned branch must call armDetachTimer');
    });

    it('assignment cancels disposal timer', () => {
        assert.ok(terminalsJsContent.includes('cancelDetachTimer(name)'), 'renderPaneGrid assigned branch must call cancelDetachTimer');
    });

    it('disposal clears detach timer', () => {
        const destroyBlock = terminalsJsContent.substring(
            terminalsJsContent.indexOf('function destroyTerminalView('),
            terminalsJsContent.indexOf('terminalsMap.delete(name);')
        );
        assert.ok(destroyBlock.includes('cancelDetachTimer(name)'), 'destroyTerminalView must call cancelDetachTimer');
    });

    it('context cap exists and is enforced', () => {
        assert.ok(terminalsJsContent.includes('MAX_WEBGL_CONTEXTS = 12'), 'MAX_WEBGL_CONTEXTS must be 12');
        assert.ok(terminalsJsContent.includes('liveWebglContexts < MAX_WEBGL_CONTEXTS'), 'attachRenderer must check liveWebglContexts cap');
    });

    it('exited and disposed flags are distinct', () => {
        assert.ok(terminalsJsContent.includes('disposed: false'), 'entry shape must contain disposed flag');
        const oncloseIdx = terminalsJsContent.indexOf('ws.onclose =');
        const oncloseBlock = terminalsJsContent.substring(oncloseIdx, oncloseIdx + 200);
        assert.ok(oncloseBlock.includes('entry.exited'), 'ws.onclose guard must use entry.exited');
    });

    it('scrollback is explicit', () => {
        assert.ok(terminalsJsContent.includes('scrollback: 1000'), 'Terminal constructor must set explicit scrollback');
    });
});
