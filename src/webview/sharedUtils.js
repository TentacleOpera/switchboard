// ── Same-origin client marker ────────────────────────────────────────────
// The board's own pages are SUPPORTED clients and must say so on every request.
//
// `_isAllowedCrossSiteRequest` (LocalApiServer) decides on three signals, in
// order: `Sec-Fetch-Site`, then `Origin`, then the `X-Switchboard-Client`
// marker. `Sec-Fetch-*` is not universal — Safari only shipped it in 16.4, and
// several in-app/embedded webviews omit it — and a same-origin POST does not
// always carry an `Origin` either. A panel hitting that combination has none of
// the three signals and is rejected as a cross-site request.
//
// The failure is silent and total: `fetchTeamsState` catches the error, leaves
// `teamRoster` as `[]`, and the command view renders "No teams declared for
// this workspace" on a board with four live seats. Every other panel fetch
// fails the same way on the same browser, so the surface looks empty rather
// than broken. Observed 2026-09-13: the mobile command view had never once
// shown a team.
//
// Injected here rather than at each call site — there are dozens across the
// panels, and one that is added later without the header reintroduces the bug
// on exactly the devices nobody develops on. Only same-origin/relative requests
// are touched: a custom header on a genuinely cross-origin request would force
// a CORS preflight that the board does not answer.
(function installSwitchboardClientMarker() {
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') { return; }
    if (window.__sbClientMarkerInstalled) { return; }
    window.__sbClientMarkerInstalled = true;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function switchboardFetch(input, init) {
        try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const sameOrigin = url.startsWith('/')
                || url.startsWith(window.location.origin)
                || (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) && !url.startsWith('//'));
            if (sameOrigin) {
                const opts = init ? Object.assign({}, init) : {};
                const headers = new Headers(opts.headers || (typeof input === 'object' && input && input.headers) || {});
                if (!headers.has('X-Switchboard-Client')) {
                    headers.set('X-Switchboard-Client', 'switchboard-panel');
                }
                opts.headers = headers;
                return nativeFetch(input, opts);
            }
        } catch { /* fall through to the unmodified call */ }
        return nativeFetch(input, init);
    };
})();

// Shared utilities for Switchboard webviews (Planning and Design panels)
// Loaded globally within the webview environment

// Passthrough: returns the path as-is (no prefix).
// Kept as a function for call-site compatibility; the @ prefix was removed
// because users want clean absolute paths on clipboard copy.
function toAgentRef(absPath) {
    if (!absPath) return absPath;
    return absPath;
}

function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sanitizeUrl(rawUrl) {
    const trimmed = String(rawUrl).trim();
    if (/^(#|\/|\.{1,2}\/)/.test(trimmed)) { return trimmed; }
    const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (schemeMatch) {
        const scheme = schemeMatch[1].toLowerCase();
        if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel'
            || scheme === 'vscode-webview-resource' || scheme === 'vscode-resource' || scheme === 'vscode-webview') {
            return trimmed;
        }
        return '#';
    }
    return trimmed;
}

function renderInlineMarkdown(text) {
    if (!text) return '';
    return text
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, t, url) => {
            const safeUrl = escapeAttr(sanitizeUrl(url));
            return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${t}</a>`;
        })
        .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1');
}

/**
 * Post-process rendered HTML to add target="_blank" rel="noopener noreferrer" to
 * all <a> tags that don't already have a target. Needed for HTML from VS Code's
 * markdown.api.render (which emits bare <a href="…">) — in the browser host the
 * panel lives in an iframe, so a plain <a href> navigates the iframe itself
 * (same tab) instead of opening a new tab. In the VS Code webview the host
 * intercepts <a> clicks regardless of target, so adding target="_blank" is a
 * no-op there.
 */
function externalizeAnchors(html) {
    if (!html) return html;
    return html.replace(/<a\s+(?![^>]*\btarget=)/gi, '<a target="_blank" rel="noopener noreferrer" ');
}

const TABLE_SEPARATOR_REGEX = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function parseTableBlock(lines) {
    if (lines.length < 2) return '';
    let sepIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (TABLE_SEPARATOR_REGEX.test(lines[i])) {
            sepIdx = i;
            break;
        }
    }
    if (sepIdx === -1) return '';

    const splitRow = (row) => {
        const trimmed = row.trim();
        let rawCells = trimmed.split('|');
        if (trimmed.startsWith('|')) rawCells.shift();
        if (trimmed.endsWith('|') && rawCells.length > 0) rawCells.pop();
        return rawCells.map(c => c.trim());
    };

    const headerCells = splitRow(lines[0]);
    const sepCells = splitRow(lines[sepIdx]);
    const alignments = sepCells.map(cell => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return '';
    });

    let html = '<div class="table-wrapper"><table><thead><tr>';
    for (let i = 0; i < headerCells.length; i++) {
        const align = alignments[i] || '';
        const style = align ? ` style="text-align: ${align}"` : '';
        html += `<th${style}>${renderInlineMarkdown(headerCells[i])}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (let i = sepIdx + 1; i < lines.length; i++) {
        const cells = splitRow(lines[i]);
        html += '<tr>';
        for (let j = 0; j < headerCells.length; j++) {
            const align = alignments[j] || '';
            const style = align ? ` style="text-align: ${align}"` : '';
            const cellContent = j < cells.length ? cells[j] : '';
            html += `<td${style}>${renderInlineMarkdown(cellContent)}</td>`;
        }
        html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
}

function renderMarkdown(markdown) {
    if (!markdown) return '';

    let processed = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    processed = processed
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    processed = processed.replace(/\\`/g, '__ESCAPED_BACKTICK__');

    const lines = processed.split('\n');
    const resultLines = [];
    let lastHeaderText = null;

    for (const line of lines) {
        const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headerMatch) {
            const headerText = headerMatch[2].trim();
            if (headerText === lastHeaderText) {
                continue;
            }
            lastHeaderText = headerText;
        }
        resultLines.push(line);
    }

    const groupedLines = [];
    let inBlockquote = false;
    let blockquoteLines = [];
    for (const line of resultLines) {
        const bqMatch = line.match(/^&gt;\s?(.*)$/);
        if (bqMatch) {
            if (!inBlockquote) { inBlockquote = true; blockquoteLines = []; }
            blockquoteLines.push(bqMatch[1]);
        } else {
            if (inBlockquote) {
                groupedLines.push({ type: 'blockquote', lines: blockquoteLines });
                inBlockquote = false;
                blockquoteLines = [];
            }
            groupedLines.push(line);
        }
    }
    if (inBlockquote) { groupedLines.push({ type: 'blockquote', lines: blockquoteLines }); }

    const processedLines = [];
    let inCodeFence = false;
    let tableBlockLines = [];

    const flushTableBlock = () => {
        if (tableBlockLines.length >= 2) {
            let hasSep = false;
            for (const l of tableBlockLines) {
                if (TABLE_SEPARATOR_REGEX.test(l)) {
                    hasSep = true;
                    break;
                }
            }
            if (hasSep) {
                const tableHtml = parseTableBlock(tableBlockLines);
                processedLines.push(`HTML_TABLE_START${tableHtml}HTML_TABLE_END`);
            } else {
                for (const l of tableBlockLines) {
                    processedLines.push(l);
                }
            }
        } else {
            for (const l of tableBlockLines) {
                processedLines.push(l);
            }
        }
        tableBlockLines = [];
    };

    for (const item of groupedLines) {
        if (typeof item === 'string') {
            if (item.trim().startsWith('```')) {
                flushTableBlock();
                inCodeFence = !inCodeFence;
                processedLines.push(item);
            } else if (inCodeFence) {
                processedLines.push(item);
            } else {
                const isTableLine = item.trim().startsWith('|');
                if (isTableLine) {
                    tableBlockLines.push(item);
                } else {
                    flushTableBlock();
                    processedLines.push(item);
                }
            }
        } else if (item && item.type === 'blockquote') {
            flushTableBlock();
            const content = item.lines.join('\n');
            const alertMatch = content.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*([\s\S]*)$/i);
            if (alertMatch) {
                const type = alertMatch[1].toLowerCase();
                const title = alertMatch[1].charAt(0).toUpperCase() + alertMatch[1].slice(1).toLowerCase();
                const body = alertMatch[2].trim();
                processedLines.push(`HTML_ALERT_START_${type}_${title}HTML_ALERT_CONTENT${body}HTML_ALERT_END`);
            } else {
                processedLines.push(`HTML_BLOCKQUOTE_START${content}HTML_BLOCKQUOTE_END`);
            }
        }
    }
    flushTableBlock();

    // List-block grouping pass: collect consecutive list lines into fully-formed,
    // nested <ul>/<ol>/<li> HTML and emit each list block as a single
    // HTML_LIST_START...HTML_LIST_END sentinel line (mirrors the table sentinel
    // pattern at line 161). The sentinel is converted back to HTML late, outside
    // the <p> wrapping, so lists are not nested inside <p>. Item text stays raw
    // (already HTML-escaped) so the inline .replace chain below still applies
    // bold/italic/code/link/image formatting inside list items.
    const LIST_UNORDERED_RE = /^(\s*)([-*+])\s+(.+)$/;
    const LIST_ORDERED_RE = /^(\s*)(\d+[.)])\s+(.+)$/;

    const isSentinelLine = (s) => typeof s === 'string' && (
        s.startsWith('HTML_TABLE_START') ||
        s.startsWith('HTML_BLOCKQUOTE_START') ||
        s.startsWith('HTML_ALERT_START')
    );

    const matchListLine = (line) => {
        if (typeof line !== 'string') return null;
        const u = line.match(LIST_UNORDERED_RE);
        if (u) return { indent: u[1].length, ordered: false, text: u[3] };
        const o = line.match(LIST_ORDERED_RE);
        if (o) return { indent: o[1].length, ordered: true, text: o[3] };
        return null;
    };

    // Build nested <ul>/<ol> HTML from a flat run of {indent, ordered, text, looseBefore}.
    // Emits a single-line string with no internal \n so the \n-><br> mapping
    // below does not insert <br> between <li>s.
    // Per-ITEM looseness, deliberately not CommonMark's all-or-nothing list-level
    // rule: users type a blank line where they want THAT gap, and collapsing it to
    // "the whole list is loose" erases the sub-grouping they were expressing.
    // A <p>-wrapper shape is NOT used: `li p { margin-bottom: 0 }` already ships in
    // all panel stylesheets and would silently cancel a <p>-based gap, so a
    // per-item class is required. Output MUST stay a single line with no \n — the
    // HTML_LIST sentinel is emitted into a \n-joined buffer whose \n are later
    // mapped to <br>.
    const liOpen = (item) => item.looseBefore ? '<li class="md-li-loose">' : '<li>';
    const buildListHtml = (run) => {
        let html = '';
        const stack = []; // { indent, ordered }
        for (const item of run) {
            while (stack.length && item.indent < stack[stack.length - 1].indent) {
                const top = stack.pop();
                html += `</li></${top.ordered ? 'ol' : 'ul'}>`;
            }
            if (stack.length === 0) {
                html += `<${item.ordered ? 'ol' : 'ul'}>${liOpen(item)}${item.text}`;
                stack.push({ indent: item.indent, ordered: item.ordered });
            } else if (item.indent > stack[stack.length - 1].indent) {
                html += `<${item.ordered ? 'ol' : 'ul'}>${liOpen(item)}${item.text}`;
                stack.push({ indent: item.indent, ordered: item.ordered });
            } else {
                const top = stack[stack.length - 1];
                if (item.ordered === top.ordered) {
                    html += `</li>${liOpen(item)}${item.text}`;
                } else {
                    stack.pop();
                    html += `</li></${top.ordered ? 'ol' : 'ul'}>`;
                    html += `<${item.ordered ? 'ol' : 'ul'}>${liOpen(item)}${item.text}`;
                    stack.push({ indent: item.indent, ordered: item.ordered });
                }
            }
        }
        while (stack.length) {
            const top = stack.pop();
            html += `</li></${top.ordered ? 'ol' : 'ul'}>`;
        }
        return html;
    };

    const listProcessedLines = [];
    let listCodeFence = false;
    let k = 0;
    while (k < processedLines.length) {
        const line = processedLines[k];
        if (typeof line === 'string' && line.trim().startsWith('```')) {
            listCodeFence = !listCodeFence;
            listProcessedLines.push(line);
            k++;
            continue;
        }
        if (listCodeFence || isSentinelLine(line)) {
            listProcessedLines.push(line);
            k++;
            continue;
        }
        const firstMatch = matchListLine(line);
        if (!firstMatch) {
            listProcessedLines.push(line);
            k++;
            continue;
        }
        // Collect a run of list lines, allowing blank lines between items (loose lists).
        const run = [];
        run.push({ ...firstMatch, looseBefore: false }); // first item never gets a leading gap
        k++;
        let sawBlank = false;
        while (k < processedLines.length) {
            const cur = processedLines[k];
            if (typeof cur === 'string' && cur.trim().startsWith('```')) break;
            if (isSentinelLine(cur)) break;
            const m = matchListLine(cur);
            if (m) {
                run.push({ ...m, looseBefore: sawBlank });
                sawBlank = false;
                k++;
            } else if (typeof cur === 'string' && cur.trim() === '') {
                // Blank line: continue run only if a subsequent list line exists.
                let j = k + 1;
                while (j < processedLines.length &&
                       typeof processedLines[j] === 'string' &&
                       processedLines[j].trim() === '') {
                    j++;
                }
                if (j < processedLines.length &&
                    !isSentinelLine(processedLines[j]) &&
                    !(typeof processedLines[j] === 'string' && processedLines[j].trim().startsWith('```')) &&
                    matchListLine(processedLines[j])) {
                    sawBlank = true; // remember the gap instead of dropping it
                    k = j;
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        listProcessedLines.push(`HTML_LIST_START${buildListHtml(run)}HTML_LIST_END`);
    }

    processed = listProcessedLines.join('\n');

    let html = processed
        .replace(/```(\w*)([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        .replace(/^\s*###### (.+)$/gm, '<h6>$1</h6>')
        .replace(/^\s*##### (.+)$/gm, '<h5>$1</h5>')
        .replace(/^\s*#### (.+)$/gm, '<h4>$1</h4>')
        .replace(/^\s*### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^\s*## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^\s*# (.+)$/gm, '<h1>$1</h1>')
        .replace(/\*\*([^<\n]+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^<\n]+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, url) => {
            const safeUrl = escapeAttr(sanitizeUrl(url));
            return `<img src="${safeUrl}" alt="${escapeAttr(alt)}" style="max-width:100%;height:auto;display:block;margin:4px 0;">`;
        })
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
            const safeUrl = escapeAttr(sanitizeUrl(url));
            return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${text}</a>`;
        })
        .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1');

    const parts = html.split(/(<pre><code>[\s\S]*?<\/code><\/pre>)/);
    html = parts.map((part, i) => {
        if (i % 2 === 1) return part;
        return part.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>');
    }).join('');

    html = `<p>${html}</p>`;
    html = html.replace(/<p>\s*<\/p>/g, '');

    html = html.replace(/HTML_TABLE_START([\s\S]*?)HTML_TABLE_END/g, (_, tableHtml) => {
        return `</p>${tableHtml}<p>`;
    });
    html = html.replace(/HTML_ALERT_START_([a-z]+)_([A-Za-z]+)HTML_ALERT_CONTENT([\s\S]*?)HTML_ALERT_END/g, (_, type, title, body) => {
        return `</p><div class="markdown-alert alert-${type}"><div class="markdown-alert-title">${title}</div><div>${body}</div></div><p>`;
    });
    html = html.replace(/HTML_BLOCKQUOTE_START([\s\S]*?)HTML_BLOCKQUOTE_END/g, (_, body) => {
        return `</p><blockquote>${body}</blockquote><p>`;
    });
    html = html.replace(/HTML_LIST_START([\s\S]*?)HTML_LIST_END/g, (_, listHtml) => {
        return `</p>${listHtml}<p>`;
    });
    html = html.replace(/<p>\s*<\/p>/g, '');

    let inCode = false;
    html = html.replace(/(<code\b[^>]*>|<\/code>|<pre\b[^>]*>|<\/pre>|__ESCAPED_BACKTICK__)/g, (match) => {
        if (match.startsWith('<code') || match.startsWith('<pre')) {
            inCode = true;
            return match;
        } else if (match.startsWith('</code') || match.startsWith('</pre')) {
            inCode = false;
            return match;
        } else if (match === '__ESCAPED_BACKTICK__') {
            return inCode ? '\\`' : '`';
        }
        return match;
    });

    return html;
}

function renderJsonTree(data, depth, maxDepth, seen) {
    depth = depth || 0;
    maxDepth = maxDepth || 2;
    seen = seen || new WeakSet();

    if (data === null) {
        const span = document.createElement('span');
        span.className = 'json-null';
        span.textContent = 'null';
        return span;
    }
    if (typeof data !== 'object') {
        const span = document.createElement('span');
        span.className = 'json-' + typeof data;
        span.textContent = typeof data === 'string' ? '"' + data + '"' : String(data);
        return span;
    }

    if (seen.has(data)) {
        const span = document.createElement('span');
        span.className = 'json-null';
        span.textContent = '[Circular]';
        return span;
    }
    seen.add(data);

    const isArray = Array.isArray(data);
    const isOpen = depth < maxDepth;

    const details = document.createElement('details');
    details.className = 'json-node';
    if (isOpen) details.open = true;

    const summary = document.createElement('summary');
    summary.className = 'json-bracket';
    const countLabel = isArray
        ? `${data.length} items`
        : `${Object.keys(data).length} keys`;
    summary.textContent = isArray ? `[ ${countLabel} ]` : `{ ${countLabel} }`;
    details.appendChild(summary);

    const children = document.createElement('div');
    children.className = 'json-children';

    if (isArray) {
        data.forEach((item, i) => {
            const row = document.createElement('div');
            row.className = 'json-row';
            const idx = document.createElement('span');
            idx.className = 'json-number';
            idx.textContent = String(i) + ':';
            row.appendChild(idx);
            row.appendChild(renderJsonTree(item, depth + 1, maxDepth, seen));
            children.appendChild(row);
        });
    } else {
        for (const [key, val] of Object.entries(data)) {
            const row = document.createElement('div');
            row.className = 'json-row';
            const keySpan = document.createElement('span');
            keySpan.className = 'json-key';
            keySpan.textContent = '"' + key + '"';
            row.appendChild(keySpan);
            row.appendChild(document.createTextNode(': '));
            row.appendChild(renderJsonTree(val, depth + 1, maxDepth, seen));
            children.appendChild(row);
        }
    }

    details.appendChild(children);
    return details;
}

// ===== Reusable multi-instance overflow menu ("⋯ More" popover) =====
// Scoped by [data-overflow-menu] / [data-overflow-trigger] / [data-overflow-popover]
// data attributes — supports N independent instances on the page. The popover is
// position:fixed so it escapes any ancestor overflow:auto / overflow-x:auto.
// Initialized once at load.
function _positionOverflowPopover(popover, trigger) {
    const rect = trigger.getBoundingClientRect();
    popover.style.top = (rect.bottom + 2) + 'px';
    popover.style.left = rect.left + 'px';
    // Defer clamping to next frame so the popover's size is measurable.
    requestAnimationFrame(() => {
        const pRect = popover.getBoundingClientRect();
        if (pRect.right > window.innerWidth - 4) {
            popover.style.left = Math.max(4, window.innerWidth - pRect.width - 4) + 'px';
        }
        if (pRect.bottom > window.innerHeight - 4) {
            // Flip above the trigger if it would overflow the viewport bottom.
            popover.style.top = Math.max(4, rect.top - pRect.height - 2) + 'px';
        }
    });
}

function _closeOneOverflowPopover(p) {
    if (!p) return;
    p.removeAttribute('data-open');
    if (p._ownerMenu && p.parentElement !== p._ownerMenu) {
        p._ownerMenu.appendChild(p);
    }
}

function _closeAllOverflowPopovers(except) {
    document.querySelectorAll('[data-overflow-popover][data-open="true"]').forEach(p => {
        if (p !== except) _closeOneOverflowPopover(p);
    });
}

function _recomputeOverflowTriggerVisibility(menu) {
    if (!menu) return;
    const popover = menu.querySelector('[data-overflow-popover]');
    if (!popover) return;
    const items = Array.from(popover.querySelectorAll('.overflow-menu-item, .strip-btn'));
    const anyVisible = items.some(el => {
        if (el.disabled) return false;
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        return true;
    });
    menu.setAttribute('data-empty', anyVisible ? 'false' : 'true');
}

function _recomputeAllOverflowTriggers() {
    document.querySelectorAll('[data-overflow-menu]').forEach(_recomputeOverflowTriggerVisibility);
}

let _overflowMenusInitialized = false;
function initOverflowMenus() {
    if (_overflowMenusInitialized) return;
    _overflowMenusInitialized = true;

    document.addEventListener('click', (e) => {
        const trigger = e.target.closest('[data-overflow-trigger]');
        if (trigger) {
            e.stopPropagation();
            const menu = trigger.closest('[data-overflow-menu]');
            const popover = menu && menu.querySelector('[data-overflow-popover]');
            if (!popover) return;
            const willOpen = popover.getAttribute('data-open') !== 'true';
            _closeAllOverflowPopovers(willOpen ? popover : null);
            if (willOpen) {
                popover._ownerMenu = menu;
                if (popover.parentElement !== document.body) {
                    document.body.appendChild(popover);
                }
                _positionOverflowPopover(popover, trigger);
                popover.setAttribute('data-open', 'true');
            } else {
                _closeOneOverflowPopover(popover);
            }
            return;
        }
        if (!e.target.closest('[data-overflow-menu]') && !e.target.closest('[data-overflow-popover]')) {
            _closeAllOverflowPopovers(null);
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const openPopovers = document.querySelectorAll('[data-overflow-popover][data-open="true"]');
        if (openPopovers.length) {
            openPopovers.forEach(_closeOneOverflowPopover);
        }
    });

    const repositionOpen = () => {
        document.querySelectorAll('[data-overflow-popover][data-open="true"]').forEach(p => {
            const menu = p._ownerMenu || p.closest('[data-overflow-menu]');
            const trigger = menu && menu.querySelector('[data-overflow-trigger]');
            if (trigger) _positionOverflowPopover(p, trigger);
        });
    };
    window.addEventListener('scroll', repositionOpen, true);
    window.addEventListener('resize', repositionOpen);
}

// Shared click-flash feedback: gives every button a brief press pulse on click so actions
// don't fire silently. Self-contained (injects its own CSS); loaded in every panel via the
// shared scripts. Guarded so it only initialises once per webview.
(function initSbClickFlash() {
    if (typeof document === 'undefined' || window.__sbClickFlashInit) { return; }
    window.__sbClickFlashInit = true;

    const style = document.createElement('style');
    style.textContent =
        '@keyframes sbClickFlash{0%{transform:scale(1)}38%{transform:scale(0.94)}100%{transform:scale(1)}}' +
        '.sb-click-flash{animation:sbClickFlash 0.18s ease-out}';
    // Insert FIRST so any panel-specific click animation (e.g. kanban's richer flash)
    // wins the cascade on conflict, while this still applies everywhere else.
    const head = document.head || document.documentElement;
    head.insertBefore(style, head.firstChild);

    document.addEventListener('click', e => {
        const btn = e.target.closest && e.target.closest('button, [role="button"], [class*="btn"]');
        if (!btn || btn.disabled) { return; }
        btn.classList.remove('sb-click-flash');
        void btn.offsetWidth; // restart the animation if clicked again mid-play
        btn.classList.add('sb-click-flash');
        btn.addEventListener('animationend', () => btn.classList.remove('sb-click-flash'), { once: true });
    }, true);
})();

// ── Agent-control model providers ────────────────────────────────────────
// ONE definition of the provider table, read by BOTH agent-control surfaces
// (dock.js and command.js). They each render their own copy of the config row,
// so a table defined twice is a table that drifts — and nothing would catch a
// model list that gained an entry on the dock and not on the phone.
//
// `endpoint` is the URL the board POSTs to verbatim: a full chat-completions
// path, because _callModelForAction appends nothing. Providers whose URL is
// fixed are not editable; local/custom supply their own.
(function () {
    'use strict';

    /** Sentinel <option> value meaning "let me type a model name". */
    const CUSTOM_MODEL = '__custom__';

    const PROVIDERS = [
        {
            id: 'google',
            label: 'Google (free tier)',
            // Google's OpenAI-COMPATIBILITY path. The native Gemini endpoint
            // (…/models/<m>:generateContent) authenticates with x-goog-api-key,
            // takes a `contents` body and returns candidates[].content.parts[] —
            // three mismatches with what the board sends and reads.
            endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
            endpointEditable: false,
            needsKey: true,
            // BARE ids — Google's own API, no vendor prefix and no ':free'
            // suffix. The OpenRouter block below lists the same model families
            // under 'google/…:free'; each provider owns its own list, so these
            // two never meet at runtime.
            models: [
                { id: 'gemma-4-31b-it', label: 'Gemma 4 31B' },
                { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
            ],
        },
        {
            id: 'openrouter',
            label: 'OpenRouter (free tier)',
            endpoint: 'https://openrouter.ai/api/v1/chat/completions',
            endpointEditable: false,
            needsKey: true,
            // OpenRouter's own ids: vendor-prefixed, `:free` suffixed. The same
            // model families appear in the Google block above under bare ids,
            // and the two forms are not interchangeable — which is why each
            // provider carries its own list and its own saved row. Switching
            // provider rebuilds this select from THIS array and reloads THIS
            // provider's record, so an id from another list has no path in.
            // Verified against GET https://openrouter.ai/api/v1/models
            // (pricing.prompt === '0') on 2026-09-16.
            models: [
                { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B (free)' },
                { id: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B A4B (free)' },
                { id: 'nvidia/nemotron-3.5-lightning:free', label: 'Nemotron 3.5 Lightning (free)' },
                { id: 'thinkingmachines/inkling-small:free', label: 'Inkling Small (free)' },
            ],
        },
        {
            id: 'local',
            label: 'Local server',
            endpoint: '',
            endpointEditable: true,
            // No key field and no key SENT: a local server that ignores an
            // Authorization header is the lucky case; one that rejects it is a
            // failure nobody would connect to a key they never typed.
            needsKey: false,
            // [] means "no preset list, free-text only" — this provider has no
            // published catalogue, so the operator types the name their server
            // serves. It was `null` ("no model control at all — the local server
            // decides"), and that was wrong about consequences: the stored model
            // is what `/controller/judgement` puts in the Pilot's tier, so the
            // field was load-bearing while being unsettable. The only thing the
            // UI could do to it was clear it.
            models: [],
        },
        {
            id: 'custom',
            label: 'Custom endpoint',
            endpoint: '',
            endpointEditable: true,
            needsKey: true,
            // [] means "no preset list, free-text only".
            models: [],
        },
    ];

    const byId = id => PROVIDERS.find(p => p.id === id) || null;

    // There is deliberately NO inferFromEndpoint here. Guessing a provider from
    // a stored URL was the client twin of LocalApiServer's _providerIdForEndpoint,
    // and both existed only to place a flat pre-normalisation endpoint. An
    // endpoint now lives INSIDE a provider row and cannot exist without one, so
    // there is nothing left to infer from — and a guessed provider that renders
    // identically to a chosen one is the routing fallback CLAUDE.md forbids.

    window.SwitchboardAgentProviders = {
        list: () => PROVIDERS.slice(),
        byId,
        CUSTOM_MODEL,
    };
})();

// ── Agent-control provider row controller ────────────────────────────────
// The config row's BEHAVIOUR, shared by dock.js and command.js for the same
// reason the table above is: two copies of "which field is visible for which
// provider" is two chances to disagree, on the surface nobody tests from.
(function () {
    'use strict';
    const P = window.SwitchboardAgentProviders;
    if (!P) { return; }

    /**
     * @param els {{provider, endpoint, endpointLabel, modelSelect, modelInput,
     *              modelLabel, key, keyLabel}} — any may be null.
     */
    function create(els) {
        const show = (el, on) => { if (el) { el.style.display = on ? '' : 'none'; } };
        // Every provider's saved row, from GET /agent/control/config. Switching
        // the dropdown reads from here, so a fully-configured operator can move
        // between providers without retyping anything.
        let savedRows = {};

        function currentProvider() {
            return P.byId(els.provider && els.provider.value) || null;
        }

        function fillProviders() {
            if (!els.provider || els.provider.options.length) { return; }
            // The unset state gets its own option. Without it the select would
            // show whichever provider sorts first, making "nobody has chosen"
            // look exactly like "the operator chose Google".
            const none = document.createElement('option');
            none.value = '';
            none.textContent = 'Select a provider…';
            els.provider.appendChild(none);
            for (const p of P.list()) {
                const o = document.createElement('option');
                o.value = p.id;
                o.textContent = p.label;
                els.provider.appendChild(o);
            }
        }

        function fillModels(providerId, selected) {
            if (!els.modelSelect) { return; }
            const prov = P.byId(providerId);
            els.modelSelect.innerHTML = '';
            if (!prov || !Array.isArray(prov.models) || !prov.models.length) { return; }
            for (const m of prov.models) {
                const o = document.createElement('option');
                o.value = m.id;
                o.textContent = m.label;
                els.modelSelect.appendChild(o);
            }
            const custom = document.createElement('option');
            custom.value = P.CUSTOM_MODEL;
            custom.textContent = 'Custom model name…';
            els.modelSelect.appendChild(custom);
            // A stored model outside the preset list is not an error and must not
            // be silently swapped for a preset — it selects the custom arm and
            // keeps its own value in the text field.
            if (selected && prov.models.some(m => m.id === selected)) {
                els.modelSelect.value = selected;
            } else if (selected) {
                els.modelSelect.value = P.CUSTOM_MODEL;
            }
        }

        /** Apply the visibility rules for the selected provider. */
        function render() {
            const prov = currentProvider();
            if (!prov) {
                // Nothing chosen: show no provider-specific field at all. An
                // early return here would leave the previous provider's fields
                // on screen, which reads as a configured row.
                for (const el of [els.endpoint, els.endpointLabel, els.modelSelect,
                                  els.modelInput, els.modelLabel, els.key, els.keyLabel]) {
                    show(el, false);
                }
                return;
            }
            const hasList = Array.isArray(prov.models) && prov.models.length > 0;
            const noModelAtAll = prov.models === null;
            const customPicked = !hasList || (els.modelSelect && els.modelSelect.value === P.CUSTOM_MODEL);

            show(els.endpoint, prov.endpointEditable);
            show(els.endpointLabel, prov.endpointEditable);
            if (els.endpointLabel) {
                els.endpointLabel.textContent = prov.id === 'local' ? 'Server URL' : 'Endpoint URL';
            }
            if (els.endpoint) {
                els.endpoint.placeholder = prov.id === 'local'
                    ? 'http://localhost:…/v1/chat/completions'
                    : 'https://…/v1/chat/completions';
            }

            show(els.modelSelect, hasList);
            show(els.modelInput, !noModelAtAll && customPicked);
            show(els.modelLabel, !noModelAtAll);

            show(els.key, prov.needsKey);
            show(els.keyLabel, prov.needsKey);
        }

        /**
         * Put provider `id`'s SAVED values into the fields. Called on every
         * provider change: each provider owns its own endpoint, model and key,
         * so switching recalls that row rather than clearing or reusing fields.
         */
        function loadProviderRecord(id) {
            const prov = P.byId(id);
            const saved = savedRows[id] || {};
            if (els.endpoint && document.activeElement !== els.endpoint) {
                els.endpoint.value = prov && prov.endpointEditable ? (saved.endpoint || '') : '';
            }
            fillModels(id, saved.model || '');
            if (els.modelInput && document.activeElement !== els.modelInput) {
                els.modelInput.value = saved.model || '';
            }
            if (els.key) {
                els.key.value = '';
                els.key.placeholder = saved.keySet
                    ? 'API key is set for this provider (write-only — type to replace)'
                    : 'API key (unset for this provider)';
            }
        }

        /**
         * Seed the row from GET /agent/control/config.
         *
         * `pointer` is how a SECOND role row (the Navigator) reads its OWN
         * pointer while sharing the same rows map: pass `{ providerId, source }`
         * from `/controller/navigator` and the row seeds from that instead of
         * the config's active pointer, which is the Pilot's. Absent → the
         * config's own active pointer. The rows map itself is shared either way,
         * so switching provider still recalls that provider's saved endpoint,
         * model and key without retyping anything.
         */
        function applyConfig(cfg, pointer) {
            fillProviders();
            // `providerSource: 'unset'` is rendered AS unset. It is not inferred
            // from the endpoint and not defaulted to a provider the operator
            // never picked — the server keeps those two states distinct
            // precisely so this row can show which one it is. A role pointer is
            // read the same way: `source === 'unset'` means nobody chose one, and
            // it must not fall back to the other role's provider.
            const providerId = pointer
                ? (pointer.source === 'unset' ? '' : (pointer.providerId || ''))
                : (cfg.providerSource === 'unset' ? '' : (cfg.provider || ''));
            savedRows = (cfg && cfg.providers) || {};
            if (els.provider) { els.provider.value = providerId; }
            loadProviderRecord(providerId);
            render();
        }

        /** The {provider, endpoint, model} half of the POST body. */
        function payload() {
            const prov = currentProvider();
            if (!prov) { return {}; }
            const out = { provider: prov.id };
            out.endpoint = prov.endpointEditable
                ? (els.endpoint ? els.endpoint.value.trim() : '')
                : prov.endpoint;
            if (prov.models === null) {
                // OMITTED, NOT EMPTIED. This sent `model: ''` on every save, and
                // the server writes whatever string it is given — so any save
                // made while the local provider was selected silently wiped that
                // row's stored model. Reported live 2026-09-22: the operator
                // opened this drawer meaning to configure the Navigator, saved,
                // and the Pilot's `gemma4:e2b-it-qat` was destroyed; the panel
                // then read "not configured", which is indistinguishable from
                // never having been configured. The server's contract is that an
                // ABSENT model keeps the existing one, so the field is left out.
                // This provider has no model control in the UI, which is a
                // reason to not write the field — never a reason to clear it.
            } else if (Array.isArray(prov.models) && prov.models.length
                       && els.modelSelect && els.modelSelect.value !== P.CUSTOM_MODEL) {
                out.model = els.modelSelect.value;
            } else {
                out.model = els.modelInput ? els.modelInput.value.trim() : '';
            }
            return out;
        }

        /** True when this provider takes no key — the caller skips the key field. */
        function needsKey() {
            const prov = currentProvider();
            return !!(prov && prov.needsKey);
        }

        if (els.provider) {
            els.provider.addEventListener('change', () => {
                // Switching provider RECALLS that provider's saved config — its
                // own model, its own URL, its own key. Nothing is cleared and
                // nothing is carried across: each provider owns its own record,
                // so a fully-configured set can be switched between freely
                // without retyping anything.
                loadProviderRecord(els.provider.value);
                render();
            });
        }
        if (els.modelSelect) { els.modelSelect.addEventListener('change', render); }

        fillProviders();
        /** The chosen provider id, or '' when none is chosen. */
        function selectedProviderId() {
            const prov = currentProvider();
            return prov ? prov.id : '';
        }
        return { applyConfig, payload, render, needsKey, selectedProviderId };
    }

    window.SwitchboardAgentProviderRow = { create };
})();
