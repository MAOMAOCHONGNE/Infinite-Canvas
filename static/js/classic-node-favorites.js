(function(root, factory){
    const api = factory();
    if(typeof module !== 'undefined' && module.exports) module.exports = api;
    if(root) root.ClassicNodeFavorites = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    const STORAGE_KEY = 'infinite_canvas_classic_node_favorites_v1';
    const CATALOG = Object.freeze([
        {type:'image', label:'上传节点', icon:'image-plus', category:'基础', blank:true},
        {type:'prompt', label:'提示词', icon:'text-cursor-input', category:'基础', blank:true},
        {type:'note', label:'便签', icon:'sticky-note', category:'基础', blank:true},
        {type:'loop', label:'循环节点', icon:'repeat-2', category:'流程', blank:true},
        {type:'llm', label:'LLM 节点', icon:'message-square-text', category:'流程', blank:true},
        {type:'generator', label:'API生成', icon:'wand-sparkles', category:'生成', blank:true},
        {type:'output', label:'Output', icon:'circle-dot', category:'基础', blank:true},
        {type:'group', label:'组', icon:'group', category:'流程', blank:false},
        {type:'midjourney', label:'Midjourney', icon:'panel-top', category:'图像生成', blank:true},
        {type:'msgen', label:'ModelScope生成', icon:'cloud-lightning', category:'图像生成', blank:true},
        {type:'rh', label:'RunningHub生成', icon:'workflow', category:'工作流', blank:true},
        {type:'comfy', label:'ComfyUI生成', icon:'workflow', category:'工作流', blank:true},
        {type:'video', label:'视频生成', icon:'clapperboard', category:'视频生成', blank:true},
        {type:'minimax', label:'MiniMax H3', icon:'sparkles', category:'视频生成', blank:true},
        {type:'ltxDirector', label:'LTX Director', icon:'film', category:'视频生成', blank:true},
    ]);
    const TYPE_SET = new Set(CATALOG.map(item => item.type));
    const DEFAULT_FAVORITE_TYPES = Object.freeze([
        'image', 'prompt', 'note', 'loop', 'llm', 'generator', 'output', 'group',
    ]);

    function uniqueKnown(values){
        const seen = new Set();
        return (Array.isArray(values) ? values : []).filter(type => {
            if(!TYPE_SET.has(type) || seen.has(type)) return false;
            seen.add(type);
            return true;
        });
    }

    function normalizePreference(value){
        const source = value && typeof value === 'object' ? value : {};
        const requestedOrder = uniqueKnown(source.order);
        const order = requestedOrder.concat(CATALOG.map(item => item.type).filter(type => !requestedOrder.includes(type)));
        const hasFavorites = Array.isArray(source.favoriteTypes);
        const requestedFavorites = uniqueKnown(hasFavorites ? source.favoriteTypes : DEFAULT_FAVORITE_TYPES);
        const favoriteSet = new Set(requestedFavorites);
        return {
            favoriteTypes:order.filter(type => favoriteSet.has(type)),
            order,
        };
    }

    function catalog(){
        return CATALOG.map(item => ({...item}));
    }

    function blankCanvasTypes(){
        return CATALOG.filter(item => item.blank).map(item => item.type);
    }

    function menuTypes(preference, allowedTypes, options={}){
        const normalized = normalizePreference(preference);
        const allowed = new Set(Array.isArray(allowedTypes) ? allowedTypes.filter(type => TYPE_SET.has(type)) : CATALOG.map(item => item.type));
        const source = options.showAll ? normalized.order : normalized.favoriteTypes;
        return source.filter(type => allowed.has(type));
    }

    function setFavorite(preference, type, enabled){
        const normalized = normalizePreference(preference);
        if(!TYPE_SET.has(type)) return normalized;
        const selected = new Set(normalized.favoriteTypes);
        if(enabled) selected.add(type);
        else selected.delete(type);
        return normalizePreference({
            favoriteTypes:normalized.order.filter(item => selected.has(item)),
            order:normalized.order,
        });
    }

    function moveType(preference, draggedType, targetType, position='before'){
        const normalized = normalizePreference(preference);
        if(draggedType === targetType || !TYPE_SET.has(draggedType) || !TYPE_SET.has(targetType)) return normalized;
        const order = normalized.order.filter(type => type !== draggedType);
        let index = order.indexOf(targetType);
        if(index < 0) return normalized;
        if(position === 'after') index += 1;
        order.splice(index, 0, draggedType);
        return normalizePreference({favoriteTypes:normalized.favoriteTypes, order});
    }

    function bindReorderDrag(row, grip, options={}){
        const type = String(options.type || '');
        if(!row || !grip || !type) return;
        const getDraggedType = typeof options.getDraggedType === 'function' ? options.getDraggedType : () => '';
        const setDraggedType = typeof options.setDraggedType === 'function' ? options.setDraggedType : () => {};
        const getDropTarget = typeof options.getDropTarget === 'function' ? options.getDropTarget : () => null;
        const setDropTarget = typeof options.setDropTarget === 'function' ? options.setDropTarget : () => {};
        const clearIndicators = typeof options.clearIndicators === 'function' ? options.clearIndicators : () => {};
        const onMove = typeof options.onMove === 'function' ? options.onMove : () => {};
        const insertionPosition = event => {
            const rect = row.getBoundingClientRect();
            return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        };

        grip.draggable = true;
        grip.ondragstart = event => {
            setDraggedType(type);
            setDropTarget(null);
            row.classList.add('dragging');
            if(event.dataTransfer){
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData?.('text/plain', type);
            }
        };
        row.ondragover = event => {
            const draggedType = getDraggedType();
            if(!draggedType || draggedType === type) return;
            event.preventDefault();
            const position = insertionPosition(event);
            setDropTarget({type, position});
            row.classList.toggle('drop-before', position === 'before');
            row.classList.toggle('drop-after', position === 'after');
        };
        row.ondragleave = () => row.classList.remove('drop-before', 'drop-after');
        row.ondrop = event => {
            const draggedType = getDraggedType();
            if(!draggedType || draggedType === type) return;
            event.preventDefault();
            const position = insertionPosition(event);
            setDraggedType('');
            setDropTarget(null);
            clearIndicators();
            onMove(draggedType, type, position);
        };
        grip.ondragend = () => {
            const draggedType = getDraggedType();
            const dropTarget = getDropTarget();
            setDraggedType('');
            setDropTarget(null);
            clearIndicators();
            if(draggedType && dropTarget?.type && draggedType !== dropTarget.type){
                onMove(draggedType, dropTarget.type, dropTarget.position);
            }
        };
    }

    function handleModalWheel(event, list){
        event?.stopPropagation?.();
        if(!list || event?.target?.closest?.('.favorite-nodes-list')) return;
        event?.preventDefault?.();
        list.scrollTop += Number(event?.deltaY) || 0;
    }

    function loadPreference(storage){
        if(!storage || typeof storage.getItem !== 'function') return normalizePreference();
        try {
            const raw = storage.getItem(STORAGE_KEY);
            return normalizePreference(raw ? JSON.parse(raw) : undefined);
        } catch(_error) {
            return normalizePreference();
        }
    }

    function savePreference(storage, preference){
        const normalized = normalizePreference(preference);
        if(storage && typeof storage.setItem === 'function'){
            try { storage.setItem(STORAGE_KEY, JSON.stringify(normalized)); } catch(_error) {}
        }
        return normalized;
    }

    function entry(type){
        const found = CATALOG.find(item => item.type === type);
        return found ? {...found} : null;
    }

    return {
        STORAGE_KEY,
        DEFAULT_FAVORITE_TYPES,
        catalog,
        entry,
        blankCanvasTypes,
        normalizePreference,
        menuTypes,
        setFavorite,
        moveType,
        bindReorderDrag,
        handleModalWheel,
        loadPreference,
        savePreference,
    };
});
