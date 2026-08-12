(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.CanvasSpatialFrames = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    const FRAME_TYPE = 'canvas-frame';
    const DEFAULT_TITLE_SIZE = 32;
    const DEFAULT_COLOR = '#94a3b8';
    const DEFAULT_PADDING = 36;
    const DEFAULT_HEADER_HEIGHT = 56;
    const DEFAULT_WIDTH = 520;
    const DEFAULT_HEIGHT = 340;
    const DEFAULT_GROUP_TYPES = ['group', 'promptGroup', 'smart-group'];
    const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv', 'flv']);
    const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']);

    function isFrameNode(node){
        return Boolean(node && node.type === FRAME_TYPE);
    }

    function normalizedGroupTypes(options={}){
        return new Set(Array.isArray(options.groupTypes) ? options.groupTypes : DEFAULT_GROUP_TYPES);
    }

    function byId(nodes){
        return new Map((nodes || []).filter(node => node?.id).map(node => [node.id, node]));
    }

    function normalizeFrame(node, options={}){
        const input = node && typeof node === 'object' ? node : {};
        return {
            ...input,
            type:FRAME_TYPE,
            title:String(input.title || options.title || '区域'),
            titleSize:Math.max(18, Math.min(72, Number(input.titleSize || options.titleSize || DEFAULT_TITLE_SIZE) || DEFAULT_TITLE_SIZE)),
            color:/^#[0-9a-f]{6}$/i.test(String(input.color || '')) ? String(input.color) : (options.color || DEFAULT_COLOR),
            fillOpacity:Math.max(0.04, Math.min(0.32, Number(input.fillOpacity || options.fillOpacity || 0.12) || 0.12)),
            items:Array.from(new Set((input.items || []).filter(Boolean))),
            x:Number(input.x) || 0,
            y:Number(input.y) || 0,
            w:Math.max(240, Number(input.w || options.w || DEFAULT_WIDTH) || DEFAULT_WIDTH),
            h:Math.max(160, Number(input.h || options.h || DEFAULT_HEIGHT) || DEFAULT_HEIGHT),
        };
    }

    function topLevelSelection(nodes, selectedIds, options={}){
        const lookup = byId(nodes);
        const groupTypes = normalizedGroupTypes(options);
        const requested = Array.from(new Set(selectedIds || [])).filter(id => lookup.has(id));
        if(requested.some(id => isFrameNode(lookup.get(id)))) return [];
        const selected = new Set(requested);
        const owned = new Set();
        requested.forEach(id => {
            const node = lookup.get(id);
            if(!groupTypes.has(node?.type)) return;
            (node.items || []).forEach(itemId => {
                if(selected.has(itemId)) owned.add(itemId);
            });
        });
        return requested.filter(id => !owned.has(id));
    }

    function createFrameAroundSelection(nodes, selectedIds, rectForNode, options={}){
        if(typeof rectForNode !== 'function') throw new TypeError('rectForNode must be a function');
        const items = topLevelSelection(nodes, selectedIds, options);
        if(!items.length) return null;
        const lookup = byId(nodes);
        const rects = items.map(id => rectForNode(lookup.get(id))).filter(rect => rect && Number(rect.w) > 0 && Number(rect.h) > 0);
        if(!rects.length) return null;
        const padding = Math.max(0, Number(options.padding ?? DEFAULT_PADDING) || 0);
        const headerHeight = Math.max(0, Number(options.headerHeight ?? DEFAULT_HEADER_HEIGHT) || 0);
        const minX = Math.min(...rects.map(rect => Number(rect.x) || 0));
        const minY = Math.min(...rects.map(rect => Number(rect.y) || 0));
        const maxX = Math.max(...rects.map(rect => (Number(rect.x) || 0) + Number(rect.w)));
        const maxY = Math.max(...rects.map(rect => (Number(rect.y) || 0) + Number(rect.h)));
        return normalizeFrame({
            id:options.id || '',
            x:minX - padding,
            y:minY - headerHeight - padding,
            w:(maxX - minX) + padding * 2,
            h:(maxY - minY) + headerHeight + padding * 2,
            title:options.title,
            titleSize:options.titleSize,
            color:options.color,
            fillOpacity:options.fillOpacity,
            items,
            created_at:options.created_at || Date.now(),
        }, options);
    }

    function collectMoveIds(nodes, rootIds, options={}){
        const lookup = byId(nodes);
        const groupTypes = normalizedGroupTypes(options);
        const seen = new Set();
        const collect = id => {
            if(!id || seen.has(id)) return;
            const node = lookup.get(id);
            if(!node) return;
            seen.add(id);
            if(isFrameNode(node) || groupTypes.has(node.type)) (node.items || []).forEach(collect);
        };
        Array.from(rootIds || []).forEach(collect);
        return [...seen];
    }

    function copyClosureIds(nodes, selectedIds, options={}){
        return collectMoveIds(nodes, selectedIds, options);
    }

    function remapFrameItems(items, idMap){
        const read = id => idMap instanceof Map ? idMap.get(id) : idMap?.[id];
        return Array.from(new Set((items || []).map(id => read(id)).filter(Boolean)));
    }

    function rectContainsCenter(frame, itemRect){
        const cx = Number(itemRect.x) + Number(itemRect.w) / 2;
        const cy = Number(itemRect.y) + Number(itemRect.h) / 2;
        return cx >= Number(frame.x) && cx <= Number(frame.x) + Number(frame.w)
            && cy >= Number(frame.y) && cy <= Number(frame.y) + Number(frame.h);
    }

    function updateMembershipAfterDrop(nodes, movedIds, rectForNode, options={}){
        if(typeof rectForNode !== 'function') throw new TypeError('rectForNode must be a function');
        const lookup = byId(nodes);
        const frames = (nodes || []).filter(isFrameNode);
        const movableIds = Array.from(movedIds || []).filter(id => !isFrameNode(lookup.get(id)));
        const roots = topLevelSelection(nodes, movableIds, options);
        if(!frames.length || !roots.length) return false;
        const before = frames.map(frame => JSON.stringify(frame.items || []));
        const moved = new Set(roots);
        frames.forEach(frame => {
            frame.items = Array.from(new Set((frame.items || []).filter(id => lookup.has(id) && !moved.has(id) && !isFrameNode(lookup.get(id)))));
        });
        roots.forEach(id => {
            const node = lookup.get(id);
            if(!node || isFrameNode(node)) return;
            const itemRect = rectForNode(node);
            if(!itemRect) return;
            const containing = frames
                .filter(frame => frame.id !== id && rectContainsCenter(frame, itemRect))
                .sort((left, right) => Number(left.w) * Number(left.h) - Number(right.w) * Number(right.h));
            if(containing[0]) containing[0].items.push(id);
        });
        return frames.some((frame, index) => before[index] !== JSON.stringify(frame.items || []));
    }

    function mediaExtension(url){
        const clean = String(url || '').split(/[?#]/)[0];
        const match = clean.match(/\.([a-z0-9]{2,5})$/i);
        return match ? match[1].toLowerCase() : '';
    }

    function mediaKind(url, explicit=''){
        if(['image', 'video', 'audio'].includes(String(explicit || '').toLowerCase())) return String(explicit).toLowerCase();
        const ext = mediaExtension(url);
        if(VIDEO_EXTENSIONS.has(ext)) return 'video';
        if(AUDIO_EXTENSIONS.has(ext)) return 'audio';
        return 'image';
    }

    function mediaName(url, requestedName, index){
        const ext = mediaExtension(url) || (mediaKind(url) === 'video' ? 'mp4' : mediaKind(url) === 'audio' ? 'mp3' : 'png');
        const raw = String(requestedName || '').trim();
        if(raw && /\.[a-z0-9]{2,5}$/i.test(raw)) return raw;
        if(raw) return `${raw}.${ext}`;
        const pathName = String(url || '').split(/[?#]/)[0].split('/').pop();
        return pathName && pathName.includes('.') ? pathName : `canvas-media-${index + 1}.${ext}`;
    }

    function collectMediaItems(nodes, selectedIds, options={}){
        const lookup = byId(nodes);
        const groupTypes = normalizedGroupTypes(options);
        const seenNodes = new Set();
        const seenUrls = new Set();
        const output = [];
        const add = (value, fallbackName='') => {
            const item = typeof value === 'string' ? {url:value} : (value || {});
            const url = String(item.url || item.src || '').trim();
            if(!url) return;
            const key = url.split('#')[0];
            if(seenUrls.has(key)) return;
            seenUrls.add(key);
            const kind = mediaKind(url, item.kind || item.mediaKind);
            output.push({url, name:mediaName(url, item.name || fallbackName, output.length), kind});
        };
        const visit = id => {
            if(!id || seenNodes.has(id)) return;
            const node = lookup.get(id);
            if(!node || isFrameNode(node)) return;
            seenNodes.add(id);
            if(groupTypes.has(node.type)) (node.items || []).forEach(visit);
            if(node.url) add({url:node.url, name:node.name, kind:node.mediaKind});
            (node.images || []).forEach((item, index) => add(item, `${node.title || node.name || node.type || 'media'}-${index + 1}`));
        };
        Array.from(selectedIds || []).forEach(visit);
        return output;
    }

    return {
        FRAME_TYPE,
        DEFAULT_TITLE_SIZE,
        DEFAULT_COLOR,
        isFrameNode,
        normalizeFrame,
        topLevelSelection,
        createFrameAroundSelection,
        collectMoveIds,
        copyClosureIds,
        remapFrameItems,
        updateMembershipAfterDrop,
        collectMediaItems,
    };
});
