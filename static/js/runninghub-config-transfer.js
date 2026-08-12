(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.RunningHubConfigTransfer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict';

    const FORMAT = 'infinite-canvas-runninghub-config';
    const VERSION = 1;
    const SENSITIVE_KEY_RE = /^(?:api[_-]?key|wallet[_-]?api[_-]?key|access[_-]?token|authorization|secret|password)$/i;
    const SENSITIVE_QUERY_RE = /([?&])(?:Rh-Comfy-Auth|Rh-Identify|apiKey|api_key|access_token|token|authorization|secret)=[^&#\s"']*/gi;

    function cleanId(value){
        return String(value || '').trim().replace(/[^0-9A-Za-z_-]/g, '').slice(0, 80);
    }

    function finiteOrder(value, fallback){
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
    }

    function sanitizeString(value){
        const text = String(value == null ? '' : value);
        if(/^data:image\//i.test(text)) return '';
        return text
            .replace(SENSITIVE_QUERY_RE, '$1')
            .replace(/\?&/g, '?')
            .replace(/[?&]$/g, '');
    }

    function sanitizeValue(value, depth=0){
        if(depth > 40) return null;
        if(value == null || typeof value === 'boolean' || typeof value === 'number') return value;
        if(typeof value === 'string') return sanitizeString(value);
        if(Array.isArray(value)) return value.map(item => sanitizeValue(item, depth + 1));
        if(typeof value !== 'object') return null;
        const result = {};
        Object.entries(value).forEach(([key, item]) => {
            if(SENSITIVE_KEY_RE.test(key)) return;
            result[key] = sanitizeValue(item, depth + 1);
        });
        return result;
    }

    function sanitizeField(field){
        if(!field || typeof field !== 'object') return null;
        const nodeId = String(field.nodeId || '').trim();
        const fieldName = String(field.fieldName || '').trim();
        if(!nodeId || !fieldName || SENSITIVE_KEY_RE.test(fieldName)) return null;
        return {
            id:String(field.id || `${nodeId}::${fieldName}`),
            nodeId,
            fieldName,
            fieldValue:sanitizeValue(field.fieldValue),
            fieldType:String(field.fieldType || 'TEXT'),
            label:String(field.label || fieldName),
            enabled:field.enabled === true,
            sourceFromUpstream:field.sourceFromUpstream === true,
            group:String(field.group || ''),
            note:String(field.note || ''),
            options:Array.isArray(field.options) ? field.options.map(option => String(option)) : [],
            random_enabled:field.random_enabled === true,
            min:field.min ?? '',
            max:field.max ?? '',
            step:field.step ?? '',
            imageOrder:Number(field.imageOrder || field.image_order || 0) || 0,
            required:field.required === true
        };
    }

    function sanitizeEntry(raw, kind, fallbackOrder=0){
        if(!raw || typeof raw !== 'object') return null;
        const id = cleanId(kind === 'workflow' ? (raw.workflowId || raw.id) : (raw.appId || raw.id));
        if(!id) return null;
        const entry = {
            id,
            title:String(raw.title || raw.name || (kind === 'workflow' ? `工作流 ${id.slice(-6)}` : `AI 应用 ${id.slice(-6)}`)).trim().slice(0, 80),
            note:String(raw.note || raw.description || '').trim().slice(0, 500),
            enabled:raw.enabled !== false,
            sortOrder:finiteOrder(raw.sortOrder ?? raw.sort_order, fallbackOrder),
            fields:(Array.isArray(raw.fields) ? raw.fields : []).map(sanitizeField).filter(Boolean)
        };
        if(kind === 'workflow'){
            entry.workflowId = id;
            entry.workflowJson = sanitizeValue(raw.workflowJson && typeof raw.workflowJson === 'object' ? raw.workflowJson : {}) || {};
            entry.optionalImageMode = String(raw.optionalImageMode || raw.optional_image_mode || 'prune-workflow');
        } else {
            entry.appId = id;
        }
        return entry;
    }

    function buildExport({apps=[], workflows=[], scope='all'}={}){
        const cleanApps = apps.map((entry, index) => sanitizeEntry(entry, 'app', index)).filter(Boolean);
        const cleanWorkflows = workflows.map((entry, index) => sanitizeEntry(entry, 'workflow', index)).filter(Boolean);
        return {
            format:FORMAT,
            version:VERSION,
            scope:scope === 'single' ? 'single' : 'all',
            exportedAt:new Date().toISOString(),
            apps:cleanApps,
            workflows:cleanWorkflows
        };
    }

    function parseImport(value){
        const raw = typeof value === 'string' ? JSON.parse(value) : value;
        if(!raw || typeof raw !== 'object' || raw.format !== FORMAT) throw new Error('不是 Infinite Canvas RunningHub 配置文件');
        if(Number(raw.version) !== VERSION) throw new Error(`暂不支持配置版本 ${raw.version}`);
        const apps = (Array.isArray(raw.apps) ? raw.apps : []).map((entry, index) => sanitizeEntry(entry, 'app', index)).filter(Boolean);
        const workflows = (Array.isArray(raw.workflows) ? raw.workflows : []).map((entry, index) => sanitizeEntry(entry, 'workflow', index)).filter(Boolean);
        if(!apps.length && !workflows.length) throw new Error('配置文件里没有可导入的 AI 应用或工作流');
        return {
            format:FORMAT,
            version:VERSION,
            scope:raw.scope === 'single' ? 'single' : 'all',
            apps,
            workflows
        };
    }

    function entryId(entry, kind){
        return cleanId(kind === 'workflow' ? (entry?.workflowId || entry?.id) : (entry?.appId || entry?.id));
    }

    function assignOrders(entries){
        return entries.map((entry, index) => ({...entry, sortOrder:index}));
    }

    function mergeEntries(existing, incoming, kind, {overwrite=false, applyImportedOrder=false}={}){
        const result = (Array.isArray(existing) ? existing : []).map(entry => ({...entry}));
        const indexById = new Map(result.map((entry, index) => [entryId(entry, kind), index]));
        const changedIds = [];
        const skippedIds = [];
        incoming.forEach((raw, incomingIndex) => {
            const entry = sanitizeEntry(raw, kind, incomingIndex);
            if(!entry) return;
            const currentIndex = indexById.get(entry.id);
            if(currentIndex !== undefined){
                if(!overwrite){
                    skippedIds.push(entry.id);
                    return;
                }
                const current = result[currentIndex] || {};
                result[currentIndex] = {
                    ...current,
                    ...entry,
                    thumbnail:String(current.thumbnail || '')
                };
                delete result[currentIndex].hidden;
                changedIds.push(entry.id);
                return;
            }
            result.push({...entry, thumbnail:''});
            indexById.set(entry.id, result.length - 1);
            changedIds.push(entry.id);
        });
        let ordered = result;
        if(applyImportedOrder){
            const wanted = incoming.map(entry => entryId(entry, kind)).filter(Boolean);
            const wantedSet = new Set(wanted);
            const byId = new Map(result.map(entry => [entryId(entry, kind), entry]));
            ordered = [
                ...wanted.map(id => byId.get(id)).filter(Boolean),
                ...result.filter(entry => !wantedSet.has(entryId(entry, kind)))
            ];
        }
        return {entries:assignOrders(ordered), changedIds, skippedIds};
    }

    function mergeConfig(existing, imported, {overwrite=false}={}){
        const applyImportedOrder = imported.scope === 'all' && overwrite;
        const apps = mergeEntries(existing?.apps, imported.apps, 'app', {overwrite, applyImportedOrder});
        const workflows = mergeEntries(existing?.workflows, imported.workflows, 'workflow', {overwrite, applyImportedOrder});
        return {apps, workflows};
    }

    function reorderEntries(entries, sourceIndex, targetIndex, placeAfter=false){
        const list = (Array.isArray(entries) ? entries : []).map(entry => ({...entry}));
        if(sourceIndex < 0 || sourceIndex >= list.length || targetIndex < 0 || targetIndex >= list.length) return assignOrders(list);
        let insertion = targetIndex + (placeAfter ? 1 : 0);
        const [moved] = list.splice(sourceIndex, 1);
        if(sourceIndex < insertion) insertion -= 1;
        insertion = Math.max(0, Math.min(list.length, insertion));
        list.splice(insertion, 0, moved);
        return assignOrders(list);
    }

    return {
        FORMAT,
        VERSION,
        sanitizeEntry,
        buildExport,
        parseImport,
        mergeConfig,
        reorderEntries,
        assignOrders
    };
});
