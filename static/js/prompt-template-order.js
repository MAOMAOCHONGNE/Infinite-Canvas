(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.PromptTemplateOrder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    const cleanIds = values => {
        const seen = new Set();
        return (Array.isArray(values) ? values : []).reduce((result, value) => {
            const id = String(value || '').trim();
            if(id && !seen.has(id)){
                seen.add(id);
                result.push(id);
            }
            return result;
        }, []);
    };

    function moveId(values, movedId, targetId, after=false){
        const ids = cleanIds(values);
        const moved = String(movedId || '').trim();
        const target = String(targetId || '').trim();
        if(!moved || !target || moved === target || !ids.includes(moved) || !ids.includes(target)) return ids;
        const next = ids.filter(id => id !== moved);
        const targetIndex = next.indexOf(target);
        next.splice(targetIndex + (after ? 1 : 0), 0, moved);
        return next;
    }

    function mergeSubsetOrder(records, subsetIds, movedId, targetId, after=false){
        const fullIds = cleanIds((Array.isArray(records) ? records : []).map(record => record?.id));
        const subset = cleanIds(subsetIds).filter(id => fullIds.includes(id));
        const orderedSubset = moveId(subset, movedId, targetId, after);
        const subsetSet = new Set(subset);
        let cursor = 0;
        return fullIds.map(id => subsetSet.has(id) ? orderedSubset[cursor++] : id);
    }

    function canSortItems({category='', query=''}={}){
        const value = String(category || '').trim();
        return Boolean(value && value !== 'all' && !String(query || '').trim());
    }

    function bindSortable(rootElement, options={}){
        if(!rootElement?.addEventListener) return () => {};
        const handleSelector = options.handleSelector || '[draggable="true"]';
        const targetSelector = options.targetSelector || handleSelector;
        const handleId = options.handleId || (element => element?.dataset?.orderId || '');
        const targetId = options.targetId || handleId;
        let moved = '';
        let lastTarget = '';
        let lastAfter = false;

        const clearMarks = () => {
            rootElement.querySelectorAll?.('.is-order-before,.is-order-after,.is-order-dragging').forEach(element => {
                element.classList.remove('is-order-before', 'is-order-after', 'is-order-dragging');
            });
        };
        const targetFromEvent = event => event.target?.closest?.(targetSelector);
        const handlers = {
            dragstart(event){
                const handle = event.target?.closest?.(handleSelector);
                if(!handle || !rootElement.contains(handle)) return;
                moved = String(handleId(handle) || '').trim();
                if(!moved){ event.preventDefault(); return; }
                lastTarget = '';
                lastAfter = false;
                handle.closest(targetSelector)?.classList.add('is-order-dragging');
                if(event.dataTransfer){
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('application/x-infinite-prompt-order', moved);
                    event.dataTransfer.setData('text/plain', moved);
                }
            },
            dragover(event){
                if(!moved) return;
                const target = targetFromEvent(event);
                const id = String(targetId(target) || '').trim();
                if(!target || !id || id === moved) return;
                event.preventDefault();
                rootElement.querySelectorAll?.('.is-order-before,.is-order-after').forEach(element => element.classList.remove('is-order-before', 'is-order-after'));
                const rect = target.getBoundingClientRect();
                const after = event.clientY > rect.top + rect.height / 2;
                lastTarget = id;
                lastAfter = after;
                target.classList.add(after ? 'is-order-after' : 'is-order-before');
                if(event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            },
            dragleave(event){
                const target = targetFromEvent(event);
                if(target && !target.contains(event.relatedTarget)) target.classList.remove('is-order-before', 'is-order-after');
            },
            drop(event){
                const target = targetFromEvent(event);
                const id = String(targetId(target) || '').trim();
                const before = Boolean(target?.classList.contains('is-order-before'));
                const after = Boolean(target?.classList.contains('is-order-after'));
                const direction = before ? false : (after ? true : (id && id === lastTarget ? lastAfter : null));
                event.preventDefault();
                event.stopPropagation();
                clearMarks();
                if(moved && id && moved !== id && direction !== null){
                    Promise.resolve(options.onDrop?.({movedId:moved, targetId:id, after:direction})).catch(() => {});
                }
                moved = '';
                lastTarget = '';
            },
            dragend(){ moved = ''; lastTarget = ''; clearMarks(); }
        };
        Object.entries(handlers).forEach(([name, handler]) => rootElement.addEventListener(name, handler));
        return () => Object.entries(handlers).forEach(([name, handler]) => rootElement.removeEventListener(name, handler));
    }

    return {moveId, mergeSubsetOrder, canSortItems, bindSortable};
});
