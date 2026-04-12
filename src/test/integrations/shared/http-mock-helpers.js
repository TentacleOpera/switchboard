'use strict';

const https = require('https');
const { EventEmitter } = require('events');

function installHttpsMock() {
    const originalRequest = https.request;
    const queued = [];
    const requests = [];

    function dequeue(record) {
        const index = queued.findIndex((entry) => !entry.matcher || entry.matcher(record));
        if (index === -1) {
            return null;
        }
        return queued.splice(index, 1)[0].responder;
    }

    https.request = (options, callback) => {
        const req = new EventEmitter();
        const record = {
            hostname: options.hostname || '',
            path: options.path || '',
            method: options.method || 'GET',
            headers: { ...(options.headers || {}) },
            timeout: options.timeout,
            body: '',
            destroyed: false,
            get jsonBody() {
                if (!record.body) {
                    return undefined;
                }
                try {
                    return JSON.parse(record.body);
                } catch {
                    return undefined;
                }
            }
        };
        requests.push(record);

        req.write = (chunk) => {
            record.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
            return true;
        };
        req.destroy = () => {
            record.destroyed = true;
        };
        req.end = (chunk) => {
            if (chunk) {
                req.write(chunk);
            }

            setImmediate(async () => {
                const responder = dequeue(record);
                if (!responder) {
                    req.emit('error', new Error(`No mocked HTTPS response for ${record.method} ${record.path}`));
                    return;
                }

                try {
                    const result = typeof responder === 'function' ? await responder(record) : responder;
                    if (result?.type === 'timeout') {
                        req.emit('timeout');
                        return;
                    }
                    if (result?.type === 'error') {
                        req.emit('error', result.error || new Error(result.message || 'Mocked HTTPS failure'));
                        return;
                    }

                    const response = new EventEmitter();
                    response.statusCode = result?.statusCode ?? 200;
                    response.headers = result?.headers || {};
                    callback(response);

                    setImmediate(() => {
                        const raw = result?.raw !== undefined
                            ? String(result.raw)
                            : JSON.stringify(result?.json !== undefined ? result.json : {});
                        const chunks = Array.isArray(result?.chunks) ? result.chunks : [raw];
                        for (const chunkValue of chunks) {
                            if (chunkValue === undefined || chunkValue === null || chunkValue === '') {
                                continue;
                            }
                            response.emit('data', Buffer.from(String(chunkValue)));
                        }
                        response.emit('end');
                    });
                } catch (error) {
                    req.emit('error', error);
                }
            });
        };

        return req;
    };

    return {
        requests,
        queueJson(statusCode, json, matcher) {
            queued.push({ responder: { statusCode, json }, matcher });
        },
        queueRaw(statusCode, raw, matcher) {
            queued.push({ responder: { statusCode, raw }, matcher });
        },
        queueError(error, matcher) {
            queued.push({ responder: { type: 'error', error }, matcher });
        },
        queueTimeout(matcher) {
            queued.push({ responder: { type: 'timeout' }, matcher });
        },
        queueResponse(responder, matcher) {
            queued.push({ responder, matcher });
        },
        restore() {
            https.request = originalRequest;
        }
    };
}

module.exports = { installHttpsMock };
