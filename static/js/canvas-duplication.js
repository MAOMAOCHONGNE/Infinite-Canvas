(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.CanvasDuplication = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    function isGroupNode(node){
        return node?.type === 'group' || node?.type === 'promptGroup';
    }

    function duplicateSelection(options={}){
        const sourceNodes = Array.isArray(options.nodes) ? options.nodes : [];
        const sourceConnections = Array.isArray(options.connections) ? options.connections : [];
        const anchorId = String(options.anchorId || '');
        const cloneNode = options.cloneNode;
        const createConnectionId = options.createConnectionId;
        if(typeof cloneNode !== 'function') throw new TypeError('cloneNode must be a function');
        if(typeof createConnectionId !== 'function') throw new TypeError('createConnectionId must be a function');

        const byId = new Map(sourceNodes.filter(node => node?.id).map(node => [node.id, node]));
        const requestedIds = Array.from(options.selectedIds || []).filter(id => byId.has(id));
        const rootIds = requestedIds.includes(anchorId) ? requestedIds : [anchorId];
        const sourceIds = new Set();
        const collect = id => {
            if(!id || sourceIds.has(id)) return;
            const node = byId.get(id);
            if(!node) return;
            sourceIds.add(id);
            if(isGroupNode(node)) (node.items || []).forEach(collect);
        };
        rootIds.forEach(collect);

        if(!sourceIds.has(anchorId)){
            return {copies:[], copiedConnections:[], selectedCopyIds:[], anchorCopy:null, idMap:new Map()};
        }

        // Keep group containers behind their member copies, matching the legacy single-group behavior.
        const orderedSources = [...sourceIds]
            .map(id => byId.get(id))
            .filter(Boolean)
            .sort((left, right) => Number(isGroupNode(left)) - Number(isGroupNode(right)));
        const idMap = new Map();
        const copies = orderedSources.map(source => {
            const copy = cloneNode(source);
            if(!copy?.id) throw new Error(`cloneNode did not create an id for ${source.id}`);
            idMap.set(source.id, copy.id);
            return copy;
        });

        copies.forEach(copy => {
            if(isGroupNode(copy) && Array.isArray(copy.items)){
                copy.items = copy.items.map(id => idMap.get(id) || id);
            }
        });

        const preserveExternalIncoming = Boolean(options.preserveExternalIncoming);
        const copiedConnections = [];
        const seenPairs = new Set();
        sourceConnections.forEach(connection => {
            const internal = sourceIds.has(connection?.from) && sourceIds.has(connection?.to);
            const externalIncoming = preserveExternalIncoming && sourceIds.has(connection?.to);
            if(!internal && !externalIncoming) return;
            const from = idMap.get(connection.from) || connection.from;
            const to = idMap.get(connection.to);
            if(!from || !to || from === to) return;
            const pair = `${from}\u0000${to}`;
            if(seenPairs.has(pair)) return;
            seenPairs.add(pair);
            copiedConnections.push({...connection, id:createConnectionId(connection), from, to});
        });

        return {
            copies,
            copiedConnections,
            selectedCopyIds:rootIds.map(id => idMap.get(id)).filter(Boolean),
            anchorCopy:copies.find(copy => copy.id === idMap.get(anchorId)) || null,
            idMap
        };
    }

    return {duplicateSelection};
});
