(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.ClassicCanvasAgentContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict';

    const MAX_DETAILS = 40;
    const MAX_SUMMARY_NAMES = 20;
    const MAX_SELECTED_IMAGES = 6;
    const MAX_SELECTED_TEXT = 12000;
    const MAX_RELATED_TEXT = 4000;
    const MAX_CONTEXT_CHARS = 60000;
    const SAFE_STRING_FIELDS = [
        'name', 'title', 'label', 'status', 'model', 'apiProvider', 'provider',
        'mode', 'quality', 'ratio', 'resolution', 'size', 'mediaKind',
        'workflowId', 'webappId', 'comfyWorkflow', 'instanceType', 'rhMode', 'rhPayment',
    ];
    const SAFE_NUMBER_FIELDS = [
        'x', 'y', 'w', 'h', 'width', 'height', 'natural_w', 'natural_h',
        'count', 'imageBatchSize', 'videoBatchSize',
    ];
    const SAFE_BOOLEAN_FIELDS = ['promptSplitEnabled', 'showPrompt'];
    const TEXT_FIELDS = [
        'text', 'prompt', 'localPrompt', 'systemPrompt', 'fixedPrompt',
        'variablePrompt', 'result', 'outputText', 'content', 'negativePrompt',
    ];

    function sanitizeContextText(value){
        return String(value || '')
            .replace(/(?:file|wss?):\/\/[^\s"'<>]+/gi, '[本机或临时鉴权地址已隐藏]')
            .replace(/\b[a-zA-Z]:[\\/][^\s"'<>|]+/g, '[本机路径已隐藏]')
            .replace(/\\\\[^\s"'<>|]+/g, '[本机路径已隐藏]')
            .replace(/([?&](?:token|api[_-]?key|auth(?:orization)?|signature|sig|secret)=)[^&\s"'<>]+/gi, '$1[已隐藏]');
    }

    function stringValue(value, max = 240){
        if(typeof value !== 'string') return '';
        const clean = sanitizeContextText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
        return clean.length > max ? `${clean.slice(0, max)}\n[已截断 ${clean.length - max} 字符]` : clean;
    }

    function isAllowedCanvasAgentImageUrl(value){
        const url = String(value || '').trim();
        if(!url || /^(?:file|javascript|wss?):/i.test(url) || /^[a-zA-Z]:[\\/]/.test(url)) return false;
        if(/^\/(?:assets|output|static)\//.test(url)) return true;
        if(/^https?:\/\//i.test(url)) return true;
        return /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+$/i.test(url);
    }

    function isCanvasAgentContextRequestEvent(event, expectedOrigin, expectedSource){
        const requestId = event?.data?.request_id;
        return Boolean(
            event
            && event.origin === expectedOrigin
            && event.source === expectedSource
            && event.data?.type === 'canvas-agent-context-request'
            && typeof requestId === 'string'
            && requestId.length > 0
            && requestId.length <= 200
            && /^[a-zA-Z0-9._:-]+$/.test(requestId)
        );
    }

    function nodeDisplayName(node){
        return stringValue(node?.name || node?.title || node?.label || `${node?.type || 'node'} ${node?.id || ''}`, 160);
    }

    function collectNodeText(node){
        const parts = [];
        for(const field of TEXT_FIELDS){
            if(typeof node?.[field] === 'string' && node[field].trim()) parts.push(`${field}: ${sanitizeContextText(node[field].trim())}`);
        }
        if(Array.isArray(node?.variablePrompts)){
            const values = node.variablePrompts.filter(item => typeof item === 'string' && item.trim()).slice(0, 100).map(sanitizeContextText);
            if(values.length) parts.push(`variablePrompts:\n${values.join('\n---\n')}`);
        }
        if(Array.isArray(node?.segments)){
            const values = node.segments.slice(0, 100).map((item, index) => {
                if(typeof item === 'string') return sanitizeContextText(item);
                if(!item || typeof item !== 'object') return '';
                return sanitizeContextText(item.prompt || item.text || item.content || item.result || item.title || `分段 ${index + 1}`);
            }).filter(Boolean);
            if(values.length) parts.push(`segments:\n${values.join('\n---\n')}`);
        }
        return parts.join('\n\n');
    }

    function truncateText(text, max){
        const clean = String(text || '');
        if(clean.length <= max) return {text:clean, truncated:false};
        const omitted = clean.length - max;
        const marker = `\n[已截断 ${omitted} 字符]`;
        return {text:`${clean.slice(0, Math.max(0, max - marker.length))}${marker}`, truncated:true};
    }

    function selectedImageCandidates(node){
        const candidates = [];
        if(typeof node?.url === 'string') candidates.push({url:node.url, name:nodeDisplayName(node)});
        for(const field of ['images', 'generatedOutputs']){
            if(!Array.isArray(node?.[field])) continue;
            node[field].forEach((item, index) => {
                if(typeof item === 'string') candidates.push({url:item, name:`${nodeDisplayName(node)} ${index + 1}`});
                else if(item && typeof item === 'object') candidates.push({
                    url:item.url || item.image_url || item.src || '',
                    name:item.name || item.filename || `${nodeDisplayName(node)} ${index + 1}`,
                    width:item.width || item.w,
                    height:item.height || item.h,
                });
            });
        }
        return candidates;
    }

    function sanitizeNode(node, selectedNode, textBudget){
        const safe = {id:String(node?.id || '').slice(0, 180), type:String(node?.type || 'unknown').slice(0, 80)};
        for(const field of SAFE_STRING_FIELDS){
            const value = stringValue(node?.[field], 300);
            if(value) safe[field] = value;
        }
        for(const field of SAFE_NUMBER_FIELDS){
            const value = Number(node?.[field]);
            if(Number.isFinite(value)) safe[field] = value;
        }
        for(const field of SAFE_BOOLEAN_FIELDS){
            if(typeof node?.[field] === 'boolean') safe[field] = node[field];
        }
        if(Array.isArray(node?.items)) safe.member_ids = node.items.map(String).slice(0, MAX_DETAILS);
        const rawText = collectNodeText(node);
        const limit = Math.max(0, Math.min(selectedNode ? MAX_SELECTED_TEXT : MAX_RELATED_TEXT, textBudget));
        const clipped = truncateText(rawText, limit);
        if(clipped.text) safe.text = clipped.text;
        return {node:safe, used:clipped.text.length, truncated:clipped.truncated || rawText.length > limit};
    }

    function buildCanvasAgentContext(input = {}){
        const canvas = input.canvas || {};
        const nodes = Array.isArray(input.nodes) ? input.nodes : [];
        const connections = Array.isArray(input.connections) ? input.connections : [];
        const nodeById = new Map(nodes.filter(node => node?.id).map(node => [String(node.id), node]));
        const selectedIds = [...new Set((input.selectedIds || []).map(String).filter(id => nodeById.has(id)))];
        const selectedSet = new Set(selectedIds);
        const upstream = [];
        const downstream = [];
        for(const edge of connections){
            const from = String(edge?.from || '');
            const to = String(edge?.to || '');
            if(selectedSet.has(to) && nodeById.has(from)) upstream.push(from);
            if(selectedSet.has(from) && nodeById.has(to)) downstream.push(to);
        }
        const member = [];
        const parent = [];
        for(const node of nodes){
            const items = Array.isArray(node?.items) ? node.items.map(String) : [];
            if(selectedSet.has(String(node?.id || ''))) items.forEach(id => { if(nodeById.has(id)) member.push(id); });
            if(items.some(id => selectedSet.has(id))) parent.push(String(node.id));
        }
        for(const id of [...selectedIds]){
            const selectedNode = nodeById.get(id);
            const parentNode = nodes.find(node => Array.isArray(node?.items) && node.items.map(String).includes(id));
            if(parentNode){
                for(const memberId of parentNode.items.map(String)){
                    if(memberId !== id && nodeById.has(memberId)) member.push(memberId);
                }
            }
            if(Array.isArray(selectedNode?.items)) selectedNode.items.map(String).forEach(memberId => member.push(memberId));
        }
        const orderedIds = [...new Set([...selectedIds, ...upstream, ...downstream, ...member, ...parent])];
        const detailIds = selectedIds.length ? orderedIds.slice(0, MAX_DETAILS) : [];
        let truncated = selectedIds.length ? orderedIds.length > MAX_DETAILS : false;
        let textBudget = 48000;
        const details = [];
        for(const id of detailIds){
            const result = sanitizeNode(nodeById.get(id), selectedSet.has(id), textBudget);
            details.push(result.node);
            textBudget = Math.max(0, textBudget - result.used);
            truncated ||= result.truncated;
        }
        const detailSet = new Set(detailIds);
        const safeConnections = connections.filter(edge => {
            const from = String(edge?.from || '');
            const to = String(edge?.to || '');
            return detailSet.has(from) && detailSet.has(to);
        }).map(edge => ({
            id:String(edge?.id || '').slice(0, 180),
            from:String(edge?.from || '').slice(0, 180),
            to:String(edge?.to || '').slice(0, 180),
        }));
        const selectedImages = [];
        const seenImageUrls = new Set();
        for(const id of selectedIds){
            const node = nodeById.get(id);
            for(const image of selectedImageCandidates(node)){
                const url = String(image.url || '').trim();
                if(!isAllowedCanvasAgentImageUrl(url) || seenImageUrls.has(url)) continue;
                seenImageUrls.add(url);
                if(selectedImages.length < MAX_SELECTED_IMAGES){
                    selectedImages.push({
                        node_id:id,
                        url,
                        name:stringValue(image.name || nodeDisplayName(node), 180),
                        width:Number(image.width || node?.natural_w || node?.width || 0) || 0,
                        height:Number(image.height || node?.natural_h || node?.height || 0) || 0,
                    });
                }
            }
        }
        const typeCounts = {};
        for(const node of nodes){
            const type = String(node?.type || 'unknown').slice(0, 80);
            typeCounts[type] = (typeCounts[type] || 0) + 1;
        }
        const context = {
            schema_version:1,
            canvas:{
                id:String(canvas.id || '').slice(0, 120),
                name:stringValue(canvas.title || canvas.name || '未命名画布', 180),
                updated_at:Number(canvas.updated_at || 0) || 0,
            },
            selection:{
                node_ids:selectedIds,
                requires_selection_for_details:selectedIds.length === 0,
                selected_image_count:seenImageUrls.size,
                sent_image_count:selectedImages.length,
            },
            summary:{
                node_count:nodes.length,
                connection_count:connections.length,
                node_types:typeCounts,
                node_names:nodes.slice(0, MAX_SUMMARY_NAMES).map(node => ({
                    id:String(node?.id || '').slice(0, 180),
                    type:String(node?.type || 'unknown').slice(0, 80),
                    name:nodeDisplayName(node),
                })),
            },
            details,
            connections:safeConnections,
            selected_images:selectedImages,
            truncated,
            context_char_count:0,
        };
        let serialized = JSON.stringify(context);
        if(serialized.length > MAX_CONTEXT_CHARS){
            truncated = true;
            for(let index = details.length - 1; index >= 0 && serialized.length > MAX_CONTEXT_CHARS; index--){
                if(!details[index].text) continue;
                const excess = serialized.length - MAX_CONTEXT_CHARS;
                const target = Math.max(0, details[index].text.length - excess - 40);
                details[index].text = truncateText(details[index].text, target).text || '[文本因总上下文上限已省略]';
                serialized = JSON.stringify(context);
            }
            context.truncated = true;
        }
        context.context_char_count = JSON.stringify(context).length;
        context.context_char_count = JSON.stringify(context).length;
        return context;
    }

    return {
        MAX_DETAILS,
        MAX_CONTEXT_CHARS,
        buildCanvasAgentContext,
        isAllowedCanvasAgentImageUrl,
        isCanvasAgentContextRequestEvent,
    };
});
