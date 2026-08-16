(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.ModelConfigTools = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    const RESOLUTIONS = ['1k', '2k', '4k'];
    const IMAGE_PARAMETER_STRATEGIES = ['auto', 'gpt-image', 'banana', 'legacy'];

    function normalizedModelId(model){
        return String(model || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }

    function compactModelId(model){
        return String(model || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    }

    function isGptImageModel(model){
        const normalized = normalizedModelId(model);
        const compact = compactModelId(model);
        return normalized === 'gpt-image-2'
            || normalized.startsWith('gpt-image-2-')
            || normalized.endsWith('-gpt-image-2')
            || normalized.includes('-gpt-image-2-')
            || compact === 'gptimage2'
            || compact.startsWith('gptimage2')
            || compact.endsWith('gptimage2');
    }

    function isBananaImageModel(model){
        const normalized = normalizedModelId(model);
        const compact = compactModelId(model);
        return normalized.startsWith('nano-banana')
            || compact.startsWith('nanobanana')
            || normalized.startsWith('gemini-3-1-flash-image-preview')
            || compact.startsWith('gemini31flashimagepreview');
    }

    function imageParameterStrategy(provider, model, effectiveModel=''){
        const logical = String(model || '').trim();
        const effective = String(effectiveModel || '').trim();
        const overrides = provider?.model_image_strategies;
        if(overrides && typeof overrides === 'object'){
            for(const name of [logical, effective]){
                const selected = String(overrides[name] || '').trim().toLowerCase();
                if(['gpt-image', 'banana', 'legacy'].includes(selected)) return selected;
            }
        }
        const candidate = effective || logical;
        if(isGptImageModel(candidate)) return 'gpt-image';
        if(isBananaImageModel(candidate)) return 'banana';
        return 'legacy';
    }

    function imageModelSupportsAutoSize(provider, model, effectiveModel=''){
        return imageParameterStrategy(provider, model, effectiveModel) === 'gpt-image';
    }

    function displayName(provider, model){
        const id = String(model || '').trim();
        const names = provider?.model_names;
        const alias = names && typeof names === 'object' ? String(names[id] || '').trim() : '';
        return alias || id;
    }

    function resolutionConfig(provider, model){
        const id = String(model || '').trim();
        const maps = provider?.image_model_resolution_maps;
        const raw = maps && typeof maps === 'object' ? maps[id] : null;
        const source = raw?.models && typeof raw.models === 'object' ? raw.models : {};
        const models = {};
        RESOLUTIONS.forEach(resolution => {
            const target = String(source[resolution] || source[resolution.toUpperCase()] || '').trim();
            if(target) models[resolution] = target;
        });
        return {enabled:raw?.enabled === true, models};
    }

    function resolutionRoutingEnabled(provider, model){
        return resolutionConfig(provider, model).enabled;
    }

    function availableResolutions(provider, model){
        const config = resolutionConfig(provider, model);
        return config.enabled ? RESOLUTIONS.filter(resolution => Boolean(config.models[resolution])) : [...RESOLUTIONS];
    }

    function effectiveModel(provider, model, resolution){
        const id = String(model || '').trim();
        const config = resolutionConfig(provider, id);
        if(!config.enabled) return id;
        const key = String(resolution || '').trim().toLowerCase();
        return RESOLUTIONS.includes(key) ? (config.models[key] || '') : '';
    }

    return {
        RESOLUTIONS,
        IMAGE_PARAMETER_STRATEGIES,
        displayName,
        resolutionConfig,
        resolutionRoutingEnabled,
        availableResolutions,
        effectiveModel,
        isGptImageModel,
        isBananaImageModel,
        imageParameterStrategy,
        imageModelSupportsAutoSize,
    };
});
