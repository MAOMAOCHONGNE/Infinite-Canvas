(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.CanvasAgentChatClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict';

    function createCanvasAgentContextRequester(options = {}){
        const windowRef = options.windowRef;
        const parentRef = options.parentRef;
        const origin = String(options.origin || '');
        const timeoutMs = Math.max(1, Number(options.timeoutMs) || 5000);
        const idFactory = options.idFactory || (() => {
            if(globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
            return `canvas-agent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        });
        const pending = new Map();
        const onMessage = event => {
            if(event?.origin !== origin || event?.source !== parentRef) return;
            if(event?.data?.type !== 'canvas-agent-context-response') return;
            const requestId = event.data.request_id;
            const item = pending.get(requestId);
            if(!item) return;
            pending.delete(requestId);
            clearTimeout(item.timer);
            if(event.data.error) item.reject(new Error(String(event.data.error)));
            else if(!event.data.context?.canvas?.id) item.reject(new Error('画布上下文无效，请重新发送。'));
            else item.resolve(event.data.context);
        };
        windowRef.addEventListener('message', onMessage);
        return {
            request(){
                const requestId = String(idFactory() || '');
                if(!requestId || requestId.length > 200) return Promise.reject(new Error('无法创建画布上下文请求。'));
                return new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                        pending.delete(requestId);
                        reject(new Error('读取画布上下文超时，请确认画布已加载后重新发送。'));
                    }, timeoutMs);
                    pending.set(requestId, {resolve, reject, timer});
                    parentRef.postMessage({type:'canvas-agent-context-request', request_id:requestId}, origin);
                });
            },
            dispose(){
                windowRef.removeEventListener('message', onMessage);
                for(const item of pending.values()){
                    clearTimeout(item.timer);
                    item.reject(new Error('画布上下文请求已取消。'));
                }
                pending.clear();
            },
        };
    }

    function createCanvasAgentWorkspaceState(){
        let current = 'normal';
        let busy = false;
        return {
            mode:() => current,
            isBusy:() => busy,
            setBusy(value){ busy = Boolean(value); },
            switchTo(next){
                const target = next === 'canvas-agent' ? 'canvas-agent' : 'normal';
                if(busy && target !== current) return false;
                current = target;
                return true;
            },
        };
    }

    function createCreativeAgentWorkspaceState(){
        let current = 'agent';
        let busy = false;
        const normalizeMode = value => ['agent', 'image', 'video'].includes(value) ? value : 'agent';
        return {
            mode:() => current,
            isBusy:() => busy,
            setBusy(value){ busy = Boolean(value); },
            finishRequest(){ busy = false; },
            switchTo(next){
                const target = normalizeMode(next);
                if(busy && target !== current) return false;
                current = target;
                return true;
            },
            newConversation(){
                if(busy) return false;
                current = 'agent';
                return true;
            },
        };
    }

    function creativeReferenceMarker(item, index){
        const marker = String(item?.marker || '').trim().replace(/^@/, '');
        return marker || `图片${index + 1}`;
    }

    function uniqueCreativeReferences(references, limit = 20){
        const result = [];
        const seen = new Set();
        for(const [index, item] of (Array.isArray(references) ? references : []).entries()){
            const url = String(item?.url || '').trim();
            if(!url || seen.has(url)) continue;
            seen.add(url);
            result.push({...item, marker:creativeReferenceMarker(item, index)});
            if(result.length >= limit) break;
        }
        return result;
    }

    function resolveCreativeAgentReferences(message, references, limit = 20){
        const clean = uniqueCreativeReferences(references, limit);
        const text = String(message || '');
        const mentioned = clean.filter(item => {
            const marker = String(item.marker || '').replace(/^@/, '');
            return marker && new RegExp(`@${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`).test(text);
        });
        return /@图片\d+/.test(text) ? mentioned : clean;
    }

    function shouldRequestCreativeCanvasContext(message){
        const text = String(message || '').trim().toLowerCase();
        if(!text) return false;
        return [
            '画布', '画板', '节点', '连线', '连接关系', '工作流', '流程', '上游', '下游',
            '循环节点', '选中提示词', '当前提示词', '这个提示词', '分析提示词', '检查提示词',
            'canvas', 'node', 'workflow', 'upstream', 'downstream',
        ].some(keyword => text.includes(keyword));
    }

    function isCreativeAgentInsertEvent(event, expectedOrigin, expectedSource, canvasId){
        const data = event?.data;
        return Boolean(
            event
            && event.origin === expectedOrigin
            && event.source === expectedSource
            && data?.type === 'canvas-creative-agent-insert-media'
            && data.canvas_id === canvasId
            && typeof data.request_id === 'string'
            && data.request_id.length > 0
            && data.request_id.length <= 200
            && /^[a-zA-Z0-9._:-]+$/.test(data.request_id)
        );
    }

    return {
        createCanvasAgentContextRequester,
        createCanvasAgentWorkspaceState,
        createCreativeAgentWorkspaceState,
        resolveCreativeAgentReferences,
        shouldRequestCreativeCanvasContext,
        isCreativeAgentInsertEvent,
        uniqueCreativeReferences,
    };
});
