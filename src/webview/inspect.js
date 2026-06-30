(function() {
    const vscode = acquireVsCodeApi();

    let state = {
        activeTab: null,          // 'images' or 'design'
        activeImg: null,          // DOM Img element reference
        activeContainer: null,    // DOM zoomable-container element reference
        inspectMode: 'eyedrop',   // 'eyedrop', 'measure', 'autodetect'
        overlayActive: false,
        imgScale: 1,              // ratio of naturalWidth / clientWidth
        probeImg: null,           // separate CORS/untainted Image
        canvas: null,             // offscreen canvas
        ctx: null,                // offscreen context
        requestId: 0,
        isScreenshot: false,
        
        // Measure state
        isMeasuring: false,
        measureStart: null,       // { x, y } in client coordinates
    };

    const overlay = document.getElementById('inspect-overlay');
    const readout = document.getElementById('inspect-readout');
    const guardrailBanner = document.getElementById('inspect-guardrail-banner');
    const forceScreenshotCheckbox = document.getElementById('inspect-force-screenshot');
    const dismissGuardrailBtn = document.getElementById('btn-dismiss-guardrail');
    const selectionBox = document.getElementById('inspect-selection-box');
    const autoDetectBounds = document.getElementById('inspect-auto-detect-bounds');
    const interactionLayer = document.getElementById('inspect-interaction-layer');
    const closeBtn = document.getElementById('btn-inspect-close');

    // Setup tab buttons listeners
    const btnInspectImages = document.getElementById('btn-inspect-images');
    const btnInspectDesign = document.getElementById('btn-inspect-design');

    btnInspectImages?.addEventListener('click', () => toggleInspector('images', 'image-preview-img-images', 'image-preview-container-images'));
    btnInspectDesign?.addEventListener('click', () => toggleInspector('design', 'image-preview-img-design', 'image-preview-container-design'));

    // Mode switchers
    const btnModeEyedrop = document.getElementById('btn-inspect-mode-eyedrop');
    const btnModeMeasure = document.getElementById('btn-inspect-mode-measure');
    const btnModeAutodetect = document.getElementById('btn-inspect-mode-autodetect');

    btnModeEyedrop?.addEventListener('click', () => setMode('eyedrop'));
    btnModeMeasure?.addEventListener('click', () => setMode('measure'));
    btnModeAutodetect?.addEventListener('click', () => setMode('autodetect'));

    closeBtn?.addEventListener('click', closeInspector);
    dismissGuardrailBtn?.addEventListener('click', () => guardrailBanner.style.display = 'none');
    forceScreenshotCheckbox?.addEventListener('change', (e) => {
        state.isScreenshot = e.target.checked;
        updateGuardrailVisibility();
    });

    window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.type === 'inspectDataUrl') {
            if (msg.requestId === state.requestId) {
                loadCanvasFromUrl(msg.dataUrl);
            }
        } else if (msg.type === 'inspectDataUrlError') {
            if (msg.requestId === state.requestId) {
                readout.innerHTML = `<span style="color: var(--accent-orange, #ff5f00);">Fallback Error: ${msg.error}</span>`;
            }
        }
    });

    function setMode(mode) {
        state.inspectMode = mode;
        [btnModeEyedrop, btnModeMeasure, btnModeAutodetect].forEach(btn => btn?.classList.remove('active'));
        if (mode === 'eyedrop') btnModeEyedrop?.classList.add('active');
        if (mode === 'measure') btnModeMeasure?.classList.add('active');
        if (mode === 'autodetect') btnModeAutodetect?.classList.add('active');

        selectionBox.style.display = 'none';
        autoDetectBounds.style.display = 'none';
        readout.innerHTML = '';
        
        if (mode === 'autodetect') {
            runAutoDetect();
        }
    }

    function toggleInspector(tab, imgId, containerId) {
        if (state.overlayActive && state.activeTab === tab) {
            closeInspector();
            return;
        }

        const img = document.getElementById(imgId);
        const container = document.getElementById(containerId);
        if (!img || !img.src) return;

        state.activeTab = tab;
        state.activeImg = img;
        state.activeContainer = container;
        state.overlayActive = true;
        state.requestId++;

        // Align overlay positioned over the correct container
        const rect = container.getBoundingClientRect();
        overlay.style.top = `${rect.top}px`;
        overlay.style.left = `${rect.left}px`;
        overlay.style.width = `${rect.width}px`;
        overlay.style.height = `${rect.height}px`;
        overlay.style.display = 'flex';

        // Check if filename suggests screenshot
        const fileName = img.dataset.filePath || img.src || '';
        state.isScreenshot = /screenshot|screen shot/i.test(fileName) || fileName.endsWith('.png');
        forceScreenshotCheckbox.checked = state.isScreenshot;
        updateGuardrailVisibility();

        readout.innerHTML = 'Loading pixel context...';
        setMode('eyedrop');

        // Build dedicated CORS image
        const probe = new Image();
        probe.crossOrigin = "anonymous";
        state.probeImg = probe;

        const currentRequestId = state.requestId;

        probe.onload = () => {
            if (currentRequestId !== state.requestId) return;
            setupCanvas(probe);
        };

        probe.onerror = () => {
            if (currentRequestId !== state.requestId) return;
            // CORS or fetch error: fallback to base64 relay
            requestDataUrlFallback(img.dataset.filePath);
        };

        // Trigger load
        probe.src = img.src;
    }

    function requestDataUrlFallback(filePath) {
        if (!filePath) {
            readout.innerHTML = '<span style="color: var(--accent-orange, #ff5f00);">CORS blocked. Remote image inspection not supported.</span>';
            return;
        }
        readout.innerHTML = 'CORS blocked. Fetching local data URL...';
        vscode.postMessage({
            type: 'inspectRequestDataUrl',
            filePath,
            requestId: state.requestId
        });
    }

    function loadCanvasFromUrl(dataUrl) {
        const probe = new Image();
        probe.onload = () => {
            setupCanvas(probe);
        };
        probe.onerror = () => {
            readout.innerHTML = '<span style="color: var(--accent-orange, #ff5f00);">Failed to load fallback data URL.</span>';
        };
        probe.src = dataUrl;
    }

    function setupCanvas(probe) {
        const canvas = document.createElement('canvas');
        canvas.width = probe.naturalWidth;
        canvas.height = probe.naturalHeight;

        const useP3 = window.matchMedia('(color-gamut: p3)').matches;
        let ctx;
        try {
            ctx = canvas.getContext('2d', {
                colorSpace: useP3 ? 'display-p3' : 'srgb',
                willReadFrequently: true
            });
        } catch (e) {
            ctx = canvas.getContext('2d', { willReadFrequently: true });
        }

        ctx.drawImage(probe, 0, 0);

        state.canvas = canvas;
        state.ctx = ctx;

        readout.innerHTML = `Loaded (${probe.naturalWidth}x${probe.naturalHeight}). Ready to inspect.`;
    }

    function closeInspector() {
        state.overlayActive = false;
        overlay.style.display = 'none';
        selectionBox.style.display = 'none';
        autoDetectBounds.style.display = 'none';
        state.probeImg = null;
        state.canvas = null;
        state.ctx = null;
        state.activeImg = null;
        state.activeContainer = null;
    }

    function updateGuardrailVisibility() {
        if (state.isScreenshot) {
            guardrailBanner.style.display = 'flex';
        } else {
            guardrailBanner.style.display = 'none';
        }
    }

    // Coordinate mapping client-space -> image-space
    function getImgCoordinates(clientX, clientY) {
        if (!state.activeImg) return null;
        const r = state.activeImg.getBoundingClientRect();
        
        // Ensure within bounds
        const xPercent = (clientX - r.left) / r.width;
        const yPercent = (clientY - r.top) / r.height;

        const ix = Math.floor(xPercent * state.activeImg.naturalWidth);
        const iy = Math.floor(yPercent * state.activeImg.naturalHeight);

        return { ix, iy, inBounds: (xPercent >= 0 && xPercent <= 1 && yPercent >= 0 && yPercent <= 1) };
    }

    // Interaction Layer Events
    interactionLayer.addEventListener('mousedown', (e) => {
        if (!state.overlayActive || !state.ctx || e.button !== 0) return;
        
        // If zooming/panning container is active, don't interfere
        if (state.activeContainer?.classList.contains('panning')) return;

        const rect = interactionLayer.getBoundingClientRect();
        const clientX = e.clientX;
        const clientY = e.clientY;

        if (state.inspectMode === 'eyedrop') {
            performEyedrop(clientX, clientY);
        } else if (state.inspectMode === 'measure') {
            state.isMeasuring = true;
            state.measureStart = { x: clientX - rect.left, y: clientY - rect.top, clientX, clientY };
            selectionBox.style.left = `${state.measureStart.x}px`;
            selectionBox.style.top = `${state.measureStart.y}px`;
            selectionBox.style.width = '0px';
            selectionBox.style.height = '0px';
            selectionBox.style.display = 'block';
        }
        e.stopPropagation();
    });

    interactionLayer.addEventListener('mousemove', (e) => {
        if (!state.overlayActive || !state.ctx) return;

        const rect = interactionLayer.getBoundingClientRect();
        const clientX = e.clientX;
        const clientY = e.clientY;

        if (state.inspectMode === 'measure' && state.isMeasuring) {
            const currentX = clientX - rect.left;
            const currentY = clientY - rect.top;

            const x = Math.min(state.measureStart.x, currentX);
            const y = Math.min(state.measureStart.y, currentY);
            const w = Math.abs(state.measureStart.x - currentX);
            const h = Math.abs(state.measureStart.y - currentY);

            selectionBox.style.left = `${x}px`;
            selectionBox.style.top = `${y}px`;
            selectionBox.style.width = `${w}px`;
            selectionBox.style.height = `${h}px`;

            // Read live sizing
            const pStart = getImgCoordinates(state.measureStart.clientX, state.measureStart.clientY);
            const pEnd = getImgCoordinates(clientX, clientY);
            if (pStart && pEnd) {
                const imgW = Math.abs(pEnd.ix - pStart.ix);
                const imgH = Math.abs(pEnd.iy - pStart.iy);
                readout.innerHTML = `Measuring: ${imgW} × ${imgH} px`;
            }
        }
    });

    interactionLayer.addEventListener('mouseup', (e) => {
        if (!state.overlayActive || !state.ctx) return;

        if (state.inspectMode === 'measure' && state.isMeasuring) {
            state.isMeasuring = false;
            const clientX = e.clientX;
            const clientY = e.clientY;

            const pStart = getImgCoordinates(state.measureStart.clientX, state.measureStart.clientY);
            const pEnd = getImgCoordinates(clientX, clientY);

            if (pStart && pEnd) {
                const x = Math.min(pStart.ix, pEnd.ix);
                const y = Math.min(pStart.iy, pEnd.iy);
                const w = Math.abs(pEnd.ix - pStart.ix);
                const h = Math.abs(pEnd.iy - pStart.iy);

                if (w > 0 && h > 0) {
                    performMeasure(x, y, w, h);
                }
            }
        }
        e.stopPropagation();
    });

    function performEyedrop(clientX, clientY) {
        const coords = getImgCoordinates(clientX, clientY);
        if (!coords || !coords.inBounds) return;

        const N = 5; // Sample window N x N
        const half = Math.floor(N / 2);
        const sx = Math.max(0, coords.ix - half);
        const sy = Math.max(0, coords.iy - half);
        
        let imgData;
        try {
            imgData = state.ctx.getImageData(sx, sy, N, N, { colorSpace: 'srgb' });
        } catch (e) {
            imgData = state.ctx.getImageData(sx, sy, N, N);
        }

        const dominant = getDominantColor(imgData);
        displayColorResult(dominant, `Pixel: ${coords.ix}, ${coords.iy}`);
    }

    function performMeasure(x, y, w, h) {
        let imgData;
        try {
            imgData = state.ctx.getImageData(x, y, w, h, { colorSpace: 'srgb' });
        } catch (e) {
            imgData = state.ctx.getImageData(x, y, w, h);
        }
        const dominant = getDominantColor(imgData);
        displayColorResult(dominant, `Box: ${w} × ${h} px`);
    }

    function getDominantColor(imgData) {
        const data = imgData.data;
        const colorBuckets = {};

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i+1];
            const b = data[i+2];
            const a = data[i+3];

            if (a < 50) continue; // ignore high transparency

            // Bucket quantization: 5 bits per channel (32 buckets per channel)
            const qr = Math.floor(r / 8) * 8;
            const qg = Math.floor(g / 8) * 8;
            const qb = Math.floor(b / 8) * 8;
            const bucketKey = `${qr},${qg},${qb}`;

            if (!colorBuckets[bucketKey]) {
                colorBuckets[bucketKey] = { count: 0, rSum: 0, gSum: 0, bSum: 0 };
            }
            colorBuckets[bucketKey].count++;
            colorBuckets[bucketKey].rSum += r;
            colorBuckets[bucketKey].gSum += g;
            colorBuckets[bucketKey].bSum += b;
        }

        let maxCount = 0;
        let dominantKey = null;
        for (const key in colorBuckets) {
            if (colorBuckets[key].count > maxCount) {
                maxCount = colorBuckets[key].count;
                dominantKey = key;
            }
        }

        if (!dominantKey) {
            return { r: 0, g: 0, b: 0, hex: '#000000', colorSpace: imgData.colorSpace || 'srgb' };
        }

        const bData = colorBuckets[dominantKey];
        const r = Math.round(bData.rSum / bData.count);
        const g = Math.round(bData.gSum / bData.count);
        const b = Math.round(bData.bSum / bData.count);
        
        const hex = rgbToHex(r, g, b);
        return { r, g, b, hex, colorSpace: imgData.colorSpace || 'srgb' };
    }

    function rgbToHex(r, g, b) {
        const toHex = (c) => c.toString(16).padStart(2, '0').toUpperCase();
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }

    function displayColorResult(color, labelText) {
        readout.innerHTML = `
            <span style="font-size: 11px; color: var(--text-secondary);">${labelText}</span>
            <div style="width: 14px; height: 14px; border: 1px solid var(--border-color); background: ${color.hex}; display: inline-block; vertical-align: middle; border-radius: 2px;"></div>
            <span style="color: var(--text-primary); font-weight: bold;">${color.hex}</span>
            <span style="font-size: 10px; color: var(--text-secondary);">(rgb: ${color.r},${color.g},${color.b})</span>
            <span style="font-size: 9px; padding: 1px 4px; border-radius: 2px; background: var(--panel-bg, #000); color: var(--accent-teal); border: 0.5px solid var(--border-color); text-transform: uppercase;">${color.colorSpace}</span>
            <button id="btn-copy-inspect-hex" class="strip-btn" style="padding: 2px 6px; font-size: 9px;">Copy</button>
        `;

        document.getElementById('btn-copy-inspect-hex')?.addEventListener('click', () => {
            navigator.clipboard.writeText(color.hex);
            const btn = document.getElementById('btn-copy-inspect-hex');
            if (btn) btn.textContent = 'Copied!';
        });
    }

    // Auto detect artwork proportions
    function runAutoDetect() {
        if (!state.ctx || !state.canvas) return;
        const w = state.canvas.width;
        const h = state.canvas.height;
        
        const imgData = state.ctx.getImageData(0, 0, w, h);
        const data = imgData.data;

        // Sampling corners to detect background color
        const cornerColors = [
            getPixelColor(data, 0, 0, w),
            getPixelColor(data, w - 1, 0, w),
            getPixelColor(data, 0, h - 1, w),
            getPixelColor(data, w - 1, h - 1, w)
        ];

        // Find majority corner color
        const bg = getMajorityColor(cornerColors);

        // Find bounding box of foreground (pixels that differ significantly from bg)
        let minX = w, maxX = 0, minY = h, maxY = 0;
        const threshold = 30; // diff threshold

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const idx = (y * w + x) * 4;
                const r = data[idx];
                const g = data[idx+1];
                const b = data[idx+2];
                const a = data[idx+3];

                if (a < 30) continue; // transparent is foreground/bg ignored

                const diff = Math.abs(r - bg.r) + Math.abs(g - bg.g) + Math.abs(b - bg.b);
                if (diff > threshold) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }

        if (maxX >= minX && maxY >= minY) {
            const bboxW = (maxX - minX) + 1;
            const bboxH = (maxY - minY) + 1;
            const ratio = (bboxW / bboxH).toFixed(3);

            // Display bounds in UI
            const clientImgRect = state.activeImg.getBoundingClientRect();
            const containerRect = state.activeContainer.getBoundingClientRect();

            // Coordinate conversion back to viewport client space relative to overlay
            const scaleX = clientImgRect.width / w;
            const scaleY = clientImgRect.height / h;

            const boxLeft = clientImgRect.left - containerRect.left + minX * scaleX;
            const boxTop = clientImgRect.top - containerRect.top + minY * scaleY;
            const boxW = bboxW * scaleX;
            const boxH = bboxH * scaleY;

            autoDetectBounds.style.left = `${boxLeft}px`;
            autoDetectBounds.style.top = `${boxTop}px`;
            autoDetectBounds.style.width = `${boxW}px`;
            autoDetectBounds.style.height = `${boxH}px`;
            autoDetectBounds.style.display = 'block';

            readout.innerHTML = `
                <span style="font-weight: bold; color: var(--accent-green, #00ff66);">Artwork Box:</span> 
                <span>${bboxW} × ${bboxH} px</span> 
                <span style="color: var(--text-secondary);">(Ratio: ${ratio})</span>
            `;
        } else {
            readout.innerHTML = 'Auto-detect: No distinct foreground detected.';
        }
    }

    function getPixelColor(data, x, y, width) {
        const idx = (y * width + x) * 4;
        return { r: data[idx], g: data[idx+1], b: data[idx+2] };
    }

    function getMajorityColor(colors) {
        // Average them for simple bg matching
        let r = 0, g = 0, b = 0;
        colors.forEach(c => {
            r += c.r;
            g += c.g;
            b += c.b;
        });
        return { r: Math.round(r/4), g: Math.round(g/4), b: Math.round(b/4) };
    }

})();
