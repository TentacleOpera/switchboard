const assert = require('assert');
const fs = require('fs');
const path = require('path');

describe('terminal-input-path-contract', () => {
    const gatewayPath = path.join(__dirname, '../standalone/terminalWsGateway.ts');
    const terminalsJsPath = path.join(__dirname, '../webview/terminals.js');

    const gatewayContent = fs.readFileSync(gatewayPath, 'utf8');
    const terminalsJsContent = fs.readFileSync(terminalsJsPath, 'utf8');

    it('client sends binary input frames via encodeInputFrame', () => {
        assert.ok(terminalsJsContent.includes('entry.ws.send(encodeInputFrame(data))'), 'term.onData must send encodeInputFrame result');
    });

    it('utf8ToBase64 is deleted and base64ToUtf8 remains', () => {
        assert.ok(!terminalsJsContent.includes('function utf8ToBase64('), 'utf8ToBase64 must be deleted');
        assert.ok(terminalsJsContent.includes('function base64ToUtf8('), 'base64ToUtf8 must remain for legacy output');
    });

    it('server accepts both binary opcode 0x01 and legacy base64 input', () => {
        assert.ok(gatewayContent.includes('opcode === 0x01'), 'gateway must check binary opcode 0x01');
        assert.ok(gatewayContent.includes("parsed.t === 'input'"), 'gateway must retain legacy parsed.t === input branch');
    });

    it('input frames are size capped by MAX_INPUT_FRAME_BYTES', () => {
        assert.ok(gatewayContent.includes('MAX_INPUT_FRAME_BYTES = 5 * 1024 * 1024'), 'MAX_INPUT_FRAME_BYTES must be defined as 5 MB');
        assert.ok(gatewayContent.includes('payload.length > MAX_INPUT_FRAME_BYTES'), 'gateway must check payload.length against MAX_INPUT_FRAME_BYTES');
    });

    it('chunking logic inspects continuation bytes and escape sequences', () => {
        assert.ok(gatewayContent.includes('(buf[pos] & 0xc0) === 0x80'), 'findSafeBoundary must check UTF-8 continuation bytes');
        assert.ok(gatewayContent.includes('buf[i] === 0x1b'), 'findSafeBoundary must scan for ESC (0x1b)');
    });

    it('input ordering is FIFO per terminal', () => {
        assert.ok(gatewayContent.includes('inputQueues = new Map'), 'inputQueues must be a Map on gateway');
        assert.ok(gatewayContent.includes('draining: boolean'), 'InputQueue must track draining state');
    });

    it('untrackTerminalData clears input queue', () => {
        const untrackIdx = gatewayContent.indexOf('untrackTerminalData(');
        const deleteIdx = gatewayContent.indexOf('this.inputQueues.delete(name)', untrackIdx);
        assert.ok(untrackIdx !== -1 && deleteIdx !== -1, 'untrackTerminalData must delete inputQueues entry');
    });

    it('client inputThrottled handler does not disable stdin', () => {
        const throttledIdx = terminalsJsContent.indexOf("frame.t === 'inputThrottled'");
        const block = terminalsJsContent.substring(throttledIdx, throttledIdx + 200);
        assert.ok(throttledIdx !== -1, 'inputThrottled branch must exist');
        assert.ok(!block.includes('disableStdin'), 'inputThrottled must not set disableStdin');
    });

    it('input queue operates independently of pausedTerminals', () => {
        const enqueueBlock = gatewayContent.substring(
            gatewayContent.indexOf('private enqueueInput('),
            gatewayContent.indexOf('private drainInputQueue(')
        );
        assert.ok(!enqueueBlock.includes('pausedTerminals'), 'enqueueInput must not check pausedTerminals');
    });
});
