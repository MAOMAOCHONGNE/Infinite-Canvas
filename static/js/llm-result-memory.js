(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.CanvasLLMResultMemory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict';

    const MAX_ENTRIES = 20;
    const MAX_TOTAL_CHARS = 120000;

    function stableSerialize(value, seen){
        if(value == null) return String(value);
        const type = typeof value;
        if(type === 'string') return JSON.stringify(value);
        if(type === 'number' || type === 'boolean') return JSON.stringify(value);
        if(type !== 'object') return JSON.stringify(String(value));
        const visited = seen || new Set();
        if(visited.has(value)) return '"[Circular]"';
        visited.add(value);
        let serialized;
        if(Array.isArray(value)){
            serialized = `[${value.map(item => stableSerialize(item, visited)).join(',')}]`;
        } else {
            serialized = `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key], visited)}`).join(',')}}`;
        }
        visited.delete(value);
        return serialized;
    }

    function hash32(text, seed){
        let hash = seed >>> 0;
        for(let i = 0; i < text.length; i++){
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619) >>> 0;
        }
        return hash.toString(16).padStart(8, '0');
    }

    function compactHash(text){
        const value = String(text || '');
        return `${hash32(value, 2166136261)}${hash32(value, 2246822519)}`;
    }

    function keyFor(value){
        const serialized = stableSerialize(value);
        return `llm-v1-${serialized.length.toString(36)}-${compactHash(serialized)}`;
    }

    function mediaIdentity(value){
        const raw = typeof value === 'object' && value
            ? (value.url || value.path || value.id || value.name || '')
            : value;
        const text = String(raw || '');
        if(!text) return '';
        const sample = text.length <= 4096
            ? text
            : `${text.slice(0, 2048)}|${text.length}|${text.slice(-2048)}`;
        return `media-v1-${text.length.toString(36)}-${compactHash(sample)}`;
    }

    function limits(options){
        const maxEntries = Math.max(1, Number(options?.maxEntries) || MAX_ENTRIES);
        const maxChars = Math.max(1, Number(options?.maxChars) || MAX_TOTAL_CHARS);
        return {maxEntries, maxChars};
    }

    function normalizeEntries(raw, options){
        const {maxEntries, maxChars} = limits(options);
        const byKey = new Map();
        (Array.isArray(raw) ? raw : []).forEach((entry, index) => {
            const key = String(entry?.key || '').slice(0, 160);
            const text = String(entry?.text || '');
            if(!key || !text || text.length > maxChars) return;
            if(byKey.has(key)) byKey.delete(key);
            byKey.set(key, {
                key,
                text,
                updatedAt:Number(entry?.updatedAt || index || 0)
            });
        });
        const entries = [...byKey.values()].sort((a, b) => a.updatedAt - b.updatedAt);
        let total = entries.reduce((sum, entry) => sum + entry.text.length, 0);
        while(entries.length > maxEntries || total > maxChars){
            const removed = entries.shift();
            total -= removed?.text?.length || 0;
        }
        return entries;
    }

    function remember(node, key, text, updatedAt, options){
        if(!node || typeof node !== 'object') return '';
        const normalizedKey = String(key || '').slice(0, 160);
        const value = String(text || '');
        const config = limits(options);
        const entries = normalizeEntries(node.llmResultMemory, config).filter(entry => entry.key !== normalizedKey);
        if(normalizedKey && value && value.length <= config.maxChars){
            entries.push({key:normalizedKey, text:value, updatedAt:Number(updatedAt || Date.now())});
        }
        node.llmResultMemory = normalizeEntries(entries, config);
        return value;
    }

    function read(node, key){
        const normalizedKey = String(key || '');
        if(!node || !normalizedKey) return '';
        const entries = Array.isArray(node.llmResultMemory) ? node.llmResultMemory : [];
        for(let i = entries.length - 1; i >= 0; i--){
            if(String(entries[i]?.key || '') === normalizedKey) return String(entries[i]?.text || '');
        }
        return '';
    }

    return {
        MAX_ENTRIES,
        MAX_TOTAL_CHARS,
        stableSerialize,
        keyFor,
        mediaIdentity,
        normalizeEntries,
        remember,
        read
    };
});
