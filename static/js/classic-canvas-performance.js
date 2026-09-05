(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.ClassicCanvasPerformance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    const GRID_CELL_SIZE = 640;
    const LITE_ENTER_SCALE = 0.40;
    const LITE_EXIT_SCALE = 0.50;
    const FAR_ENTER_SCALE = 0.15;
    const FAR_EXIT_SCALE = 0.22;
    const STORAGE_KEY = 'classicCanvasPerformanceDisabled:v1';
    const NODE_GEOMETRY_STORAGE_PREFIX = 'classicCanvasNodeGeometry:v1:';

    function normalizedRect(rect){
        const x = Number(rect?.x) || 0;
        const y = Number(rect?.y) || 0;
        const w = Math.max(0, Number(rect?.w) || 0);
        const h = Math.max(0, Number(rect?.h) || 0);
        return {x, y, w, h};
    }

    function rectIntersects(a, b){
        const left = normalizedRect(a);
        const right = normalizedRect(b);
        return left.x < right.x + right.w
            && left.x + left.w > right.x
            && left.y < right.y + right.h
            && left.y + left.h > right.y;
    }

    function rectContains(outer, inner, epsilon=0){
        const a = normalizedRect(outer);
        const b = normalizedRect(inner);
        const gap = Math.max(0, Number(epsilon) || 0);
        return b.x >= a.x - gap
            && b.y >= a.y - gap
            && b.x + b.w <= a.x + a.w + gap
            && b.y + b.h <= a.y + a.h + gap;
    }

    function expandRect(rect, horizontalRatio=0.75, verticalRatio=0.75){
        const base = normalizedRect(rect);
        const dx = Math.max(320, base.w * Math.max(0, Number(horizontalRatio) || 0));
        const dy = Math.max(260, base.h * Math.max(0, Number(verticalRatio) || 0));
        return {x:base.x - dx, y:base.y - dy, w:base.w + dx * 2, h:base.h + dy * 2};
    }

    function cellRange(rect, cellSize=GRID_CELL_SIZE){
        const value = normalizedRect(rect);
        const size = Math.max(64, Number(cellSize) || GRID_CELL_SIZE);
        return {
            minX:Math.floor(value.x / size),
            minY:Math.floor(value.y / size),
            maxX:Math.floor((value.x + Math.max(0, value.w - 0.0001)) / size),
            maxY:Math.floor((value.y + Math.max(0, value.h - 0.0001)) / size),
        };
    }

    function createSpatialIndex(nodes, rectForNode, options={}){
        const cellSize = Math.max(64, Number(options.cellSize) || GRID_CELL_SIZE);
        const cells = new Map();
        const rects = new Map();
        const allIds = [];
        (nodes || []).forEach(node => {
            if(!node?.id) return;
            const rect = normalizedRect(rectForNode(node));
            rects.set(node.id, rect);
            allIds.push(node.id);
            const range = cellRange(rect, cellSize);
            for(let x = range.minX; x <= range.maxX; x++){
                for(let y = range.minY; y <= range.maxY; y++){
                    const key = `${x}:${y}`;
                    if(!cells.has(key)) cells.set(key, new Set());
                    cells.get(key).add(node.id);
                }
            }
        });
        return {cellSize, cells, rects, allIds};
    }

    function querySpatialIndex(index, rect){
        if(!index?.cells || !index?.rects) return [];
        const query = normalizedRect(rect);
        const range = cellRange(query, index.cellSize);
        const candidates = new Set();
        for(let x = range.minX; x <= range.maxX; x++){
            for(let y = range.minY; y <= range.maxY; y++){
                index.cells.get(`${x}:${y}`)?.forEach(id => candidates.add(id));
            }
        }
        return [...candidates].filter(id => rectIntersects(index.rects.get(id), query));
    }

    function nextLiteMode(previous, scale, force=false){
        return nextRenderMode(previous ? 'lite' : 'full', scale, force) !== 'full';
    }

    function normalizeRenderMode(mode){
        return mode === 'far' || mode === 'lite' ? mode : 'full';
    }

    function nextRenderMode(previous, scale, force=false){
        const value = Math.max(0.01, Number(scale) || 1);
        const mode = normalizeRenderMode(previous);
        if(force){
            if(value <= FAR_ENTER_SCALE) return 'far';
            if(value <= LITE_ENTER_SCALE) return 'lite';
            return 'full';
        }
        if(mode === 'far'){
            if(value < FAR_EXIT_SCALE) return 'far';
            if(value < LITE_EXIT_SCALE) return 'lite';
            return 'full';
        }
        if(mode === 'lite'){
            if(value <= FAR_ENTER_SCALE) return 'far';
            if(value < LITE_EXIT_SCALE) return 'lite';
            return 'full';
        }
        if(value <= FAR_ENTER_SCALE) return 'far';
        if(value <= LITE_ENTER_SCALE) return 'lite';
        return 'full';
    }

    function nextRenderModeDuringInteraction(previous, scale){
        const current = normalizeRenderMode(previous);
        const desired = nextRenderMode(current, scale, false);
        const rank = {far:0, lite:1, full:2};
        return rank[desired] < rank[current] ? desired : current;
    }

    function desiredNodeTiers(options={}){
        const tiers = new Map();
        const nodesById = options.nodesById instanceof Map ? options.nodesById : new Map();
        const pinned = options.pinnedIds instanceof Set ? options.pinnedIds : new Set(options.pinnedIds || []);
        const view = normalizedRect(options.viewRect);
        const buffered = options.bufferedRect ? normalizedRect(options.bufferedRect) : expandRect(view);
        const visibleIds = querySpatialIndex(options.index, buffered);
        const renderMode = normalizeRenderMode(options.renderMode || (options.liteMode ? 'lite' : 'full'));
        visibleIds.forEach(id => {
            const node = nodesById.get(id);
            if(!node || !options.isEligible(node)) return;
            tiers.set(id, pinned.has(id) ? 'full' : renderMode);
        });
        pinned.forEach(id => {
            const node = nodesById.get(id);
            if(node && options.isEligible(node)) tiers.set(id, 'full');
        });
        return tiers;
    }

    // Backward-compatible alias for the first image-only implementation.
    const desiredImageTiers = desiredNodeTiers;

    function connectionBounds(connection, nodeRects, padding=0){
        const from = nodeRects?.get?.(connection?.from);
        const to = nodeRects?.get?.(connection?.to);
        if(!from || !to) return null;
        const a = normalizedRect(from);
        const b = normalizedRect(to);
        const x1 = a.x + a.w;
        const y1 = a.y + a.h / 2;
        const x2 = b.x;
        const y2 = b.y + b.h / 2;
        const gap = Math.max(0, Number(padding) || 0);
        return {
            x:Math.min(x1, x2) - gap,
            y:Math.min(y1, y2) - gap,
            w:Math.max(1, Math.abs(x2 - x1) + gap * 2),
            h:Math.max(1, Math.abs(y2 - y1) + gap * 2),
        };
    }

    function desiredConnectionTiers(options={}){
        const tiers = new Map();
        const pinned = options.pinnedIds instanceof Set ? options.pinnedIds : new Set(options.pinnedIds || []);
        const buffered = normalizedRect(options.bufferedRect);
        const renderMode = normalizeRenderMode(options.renderMode || (options.liteMode ? 'lite' : 'full'));
        (options.connections || []).forEach(connection => {
            if(!connection?.id) return;
            const bounds = connectionBounds(connection, options.nodeRects, options.padding || 24);
            if(!bounds) return;
            const isPinned = pinned.has(connection.id);
            if(!isPinned && !rectIntersects(bounds, buffered)) return;
            tiers.set(connection.id, isPinned || renderMode === 'full'
                ? 'interactive'
                : (renderMode === 'far' ? 'cached' : 'batch'));
        });
        return tiers;
    }

    function farLinkRasterSize(cssWidth, cssHeight, scale=1, pixelRatio=1, maxTextureSize=2048){
        const width = Math.max(1, Number(cssWidth) || 0);
        const height = Math.max(1, Number(cssHeight) || 0);
        const zoom = Math.max(0.01, Number(scale) || 1);
        const density = Math.max(1, Math.min(2, Number(pixelRatio) || 1));
        const cap = Math.max(256, Number(maxTextureSize) || 2048);
        return {
            width:Math.max(1, Math.min(cap, Math.ceil(width * zoom * density))),
            height:Math.max(1, Math.min(cap, Math.ceil(height * zoom * density))),
        };
    }

    function farOutputRasterSize(cssWidth, cssHeight, scale=1, pixelRatio=1, maxTextureSize=512){
        const width = Math.max(1, Number(cssWidth) || 0);
        const height = Math.max(1, Number(cssHeight) || 0);
        const zoom = Math.max(0.01, Number(scale) || 1);
        const density = Math.max(1, Math.min(2, Number(pixelRatio) || 1));
        const cap = Math.max(128, Number(maxTextureSize) || 512);
        const targetWidth = Math.max(1, Math.ceil(width * zoom * density));
        const targetHeight = Math.max(1, Math.ceil(height * zoom * density));
        const fit = Math.min(1, cap / Math.max(targetWidth, targetHeight));
        return {
            width:Math.max(1, Math.round(targetWidth * fit)),
            height:Math.max(1, Math.round(targetHeight * fit)),
        };
    }

    function nodeGeometryStorageKey(canvasId){
        return `${NODE_GEOMETRY_STORAGE_PREFIX}${String(canvasId || '')}`;
    }

    function readNodeGeometryCache(storage, canvasId, signatureForId=()=> ''){
        const restored = new Map();
        if(!canvasId) return restored;
        try {
            const parsed = JSON.parse(storage?.getItem?.(nodeGeometryStorageKey(canvasId)) || '{}');
            const entries = parsed?.nodes && typeof parsed.nodes === 'object' ? Object.entries(parsed.nodes) : [];
            entries.forEach(([id, value]) => {
                const w = Number(value?.w);
                const h = Number(value?.h);
                const signature = String(value?.signature || '');
                if(!id || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
                if(signature !== String(signatureForId(id) || '')) return;
                restored.set(id, {w, h, signature, exact:true});
            });
        } catch(error) {}
        return restored;
    }

    function writeNodeGeometryCache(storage, canvasId, entries, maxEntries=1200){
        if(!canvasId) return;
        const nodes = {};
        const limit = Math.max(1, Number(maxEntries) || 1200);
        let count = 0;
        try {
            for(const [id, value] of entries || []){
                if(count >= limit) break;
                const w = Number(value?.w);
                const h = Number(value?.h);
                if(!id || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
                nodes[id] = {w, h, signature:String(value?.signature || '')};
                count += 1;
            }
            storage?.setItem?.(nodeGeometryStorageKey(canvasId), JSON.stringify({nodes}));
        } catch(error) {}
    }

    function farMediaUrl(item){
        if(typeof item === 'string') return item;
        if(!item || typeof item !== 'object') return '';
        return String(item.url || item.output_url || item.image_url || item.path || '');
    }

    function farNodeBlueprint(node={}){
        const type = String(node.type || '');
        const generatorTypes = new Set(['generator','midjourney','msgen','video','minimax','rh','comfy','ltxDirector']);
        const inputTypes = new Set([...generatorTypes, 'output','llm','loop']);
        const outputTypes = new Set(['image','prompt','loop','group','promptGroup', ...generatorTypes, 'llm','output']);
        let family = 'group';
        if(type === 'image') family = 'image';
        else if(type === 'output') family = 'output';
        else if(generatorTypes.has(type)) family = 'generator';
        else if(type === 'llm') family = 'llm';
        else if(type === 'loop') family = 'loop';
        else if(type === 'prompt') family = 'text';
        else if(type === 'note') family = 'note';
        const mediaSlots = type === 'image'
            ? (node.url ? [{url:String(node.url), pending:false}] : [])
            : (type === 'output'
                ? [
                    ...(node.images || []).map(item => ({url:farMediaUrl(item), pending:false})),
                    ...(node._pending || []).map(() => ({url:'', pending:true})),
                ]
                : []);
        const label = String(
            node.displayName || node.modelDisplayName || node.providerName || node.model || node.workflowName || ''
        ).trim();
        const summary = String(node.text || node.prompt || node.localPrompt || '').trim().split(/\r?\n/)[0].slice(0, 120);
        return {
            family,
            type,
            title:String(node.title || '').trim(),
            label,
            summary,
            ports:{input:inputTypes.has(type), output:outputTypes.has(type)},
            mediaSlots,
            showAction:generatorTypes.has(type) || type === 'llm' || type === 'loop',
        };
    }

    function selectionFromWorldRect(options={}){
        const selected = [];
        const query = normalizedRect(options.rect);
        querySpatialIndex(options.index, query).forEach(id => {
            const node = options.nodesById?.get(id);
            const rect = options.index.rects.get(id);
            if(!node || !rect) return;
            const match = options.isFrame?.(node) ? rectContains(query, rect, options.epsilon || 0) : rectIntersects(query, rect);
            if(match) selected.push(id);
        });
        return selected;
    }

    function readDisabledMap(storage){
        try {
            const raw = storage?.getItem?.(STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : {};
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch(error){
            return {};
        }
    }

    function canvasDisabled(storage, canvasId){
        if(!canvasId) return false;
        return readDisabledMap(storage)[canvasId] === true;
    }

    function setCanvasDisabled(storage, canvasId, disabled){
        if(!canvasId) return;
        const map = readDisabledMap(storage);
        if(disabled) map[canvasId] = true;
        else delete map[canvasId];
        try { storage?.setItem?.(STORAGE_KEY, JSON.stringify(map)); } catch(error) {}
    }

    return {
        GRID_CELL_SIZE,
        LITE_ENTER_SCALE,
        LITE_EXIT_SCALE,
        FAR_ENTER_SCALE,
        FAR_EXIT_SCALE,
        STORAGE_KEY,
        NODE_GEOMETRY_STORAGE_PREFIX,
        normalizedRect,
        rectIntersects,
        rectContains,
        expandRect,
        createSpatialIndex,
        querySpatialIndex,
        nextLiteMode,
        nextRenderMode,
        nextRenderModeDuringInteraction,
        desiredNodeTiers,
        desiredImageTiers,
        connectionBounds,
        desiredConnectionTiers,
        farLinkRasterSize,
        farOutputRasterSize,
        farNodeBlueprint,
        selectionFromWorldRect,
        canvasDisabled,
        setCanvasDisabled,
        readNodeGeometryCache,
        writeNodeGeometryCache,
    };
});
