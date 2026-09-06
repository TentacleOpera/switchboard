export const LOG_FENCE_OPEN = '```console';
export const LOG_FENCE_CLOSE = '```';

export function normalizeLogSlice(slice: string, fromOffset: boolean): string {
    let text = slice;
    if (fromOffset) {
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    if (!text) return '';
    const lines = text.split('\n');
    let firstFence: string | undefined;
    for (const line of lines) {
        if (line === LOG_FENCE_OPEN || line === LOG_FENCE_CLOSE) { firstFence = line; break; }
    }
    if (fromOffset && firstFence !== LOG_FENCE_OPEN) {
        text = `${LOG_FENCE_OPEN}\n${text}`;
        lines.unshift(LOG_FENCE_OPEN);
    }
    let open = false;
    for (const line of lines) {
        if (line === LOG_FENCE_OPEN) open = true;
        else if (line === LOG_FENCE_CLOSE) open = false;
    }
    if (open) text = text.endsWith('\n') ? `${text}${LOG_FENCE_CLOSE}\n` : `${text}\n${LOG_FENCE_CLOSE}\n`;
    return text;
}
