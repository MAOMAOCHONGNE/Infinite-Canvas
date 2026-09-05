function detailUniqueStrings(values){
    const seen = new Set();
    return (values || []).map(value => String(value || '').trim()).filter(value => {
        if(!value || seen.has(value)) return false;
        seen.add(value);
        return true;
    });
}

function detailModelGroups(providers, kind){
    const key = kind === 'chat' ? 'chat_models' : 'image_models';
    return (providers || []).filter(provider => provider?.enabled !== false && (provider?.[key] || []).length).map(provider => ({
        id:String(provider.id || ''),
        name:String(provider.name || provider.id || ''),
        models:detailUniqueStrings(provider[key]).map(model => ({
            id:model,
            name:String(provider?.model_names?.[model] || model),
        })),
    })).filter(group => group.id && group.models.length);
}

function detailEncodeChoice(providerId, model){
    return `${encodeURIComponent(String(providerId || ''))}|${encodeURIComponent(String(model || ''))}`;
}

function detailDecodeChoice(value){
    const [providerId='', model=''] = String(value || '').split('|', 2);
    try { return {providerId:decodeURIComponent(providerId), model:decodeURIComponent(model)}; }
    catch(_) { return {providerId:'', model:''}; }
}

function detailFixedResolution(model){
    const normalized = String(model || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const banana = normalized.startsWith('nano-banana') || normalized.startsWith('gemini-3-1-flash-image-preview');
    const match = banana ? normalized.match(/(?:^|-)(1k|2k|4k)$/) : null;
    return match?.[1] || '';
}

function detailResolutionOptions(provider, model, tools=globalThis.ModelConfigTools){
    if(!model) return [];
    if(tools?.resolutionRoutingEnabled?.(provider, model)) return tools.availableResolutions(provider, model);
    const fixed = detailFixedResolution(model);
    if(fixed) return [fixed];
    const options = tools?.imageModelSupportsAutoSize?.(provider, model, model) ? ['auto'] : [];
    return [...options, '1k', '2k', '4k', 'custom'];
}

const DETAIL_PRESET_KEY = 'main_image_preset_v1';
const DETAIL_MAX_IMAGES = 6;
const DETAIL_ACTIVE_STATUSES = new Set(['uploading', 'planning', 'repairing', 'generating', 'analyzing', 'compiling']);
const DETAIL_SCREEN_ACTIVE_STATUSES = new Set(['queued', 'submitting', 'generating', 'recovering']);
const DETAIL_TERMINAL_STATUSES = new Set(['succeeded', 'partial', 'failed', 'cancelled', 'interrupted', 'unknown']);
const detailState = {
    providers:[],
    imageChoice:'',
    llmChoice:'',
    mainImageMode:'continuous',
    ratio:'1:1',
    resolution:'2k',
    screenCount:'4',
    copywriting:'required',
    richness:'concise',
    fontStyle:'auto',
    outputLanguage:'自动识别',
    modelSetting:'none',
    modelPose:'normal',
    modelUsage:'4',
    productName:'',
    productFacts:'',
    userInstruction:'',
    customRatioWidth:'1',
    customRatioHeight:'1',
    customSizeWidth:'2048',
    customSizeHeight:'2048',
    images:{product:[], reference:[]},
};
const detailRuntime = {
    viewTaskId:'',
    task:null,
    pollTimer:null,
    pollInFlight:false,
    abortController:null,
    isUploading:false,
    promptDrafts:new Map(),
    history:[],
    taskCache:new Map(),
    activeTaskIds:new Set(),
    draftBaseline:'',
    pendingSubmission:null,
    renamingTaskId:'',
    deletingTaskId:'',
    deletingScreenNo:0,
    deleteDialogTaskId:'',
    cleanupJobs:new Map(),
    promptEditorScreenNo:0,
    screenDragNo:0,
    isSmartAnalyzing:false,
    viewer:{items:[], screenIndex:0, candidateIndex:0, scale:1, x:0, y:0, dragging:false, startX:0, startY:0, startOffsetX:0, startOffsetY:0, pointers:new Map(), pinchDistance:0},
};

let detailDrag = null;
let detailToastTimer = null;

function detailEscapeHtml(value){
    return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

function detailProvider(providerId){
    return detailState.providers.find(provider => String(provider.id) === String(providerId)) || null;
}

function detailCurrentImageSelection(){
    const choice = detailDecodeChoice(detailState.imageChoice);
    return {...choice, provider:detailProvider(choice.providerId)};
}

function detailModelOptionsHtml(groups, selected){
    if(!groups.length) return '<option value="">请先在 API 设置中添加模型</option>';
    return groups.map(group => `<optgroup label="${detailEscapeHtml(group.name)}">${group.models.map(model => {
        const value = detailEncodeChoice(group.id, model.id);
        const suffix = model.name !== model.id ? ` · ${model.id}` : '';
        return `<option value="${detailEscapeHtml(value)}" ${value === selected ? 'selected' : ''}>${detailEscapeHtml(model.name + suffix)}</option>`;
    }).join('')}</optgroup>`).join('');
}

function detailFirstChoice(groups){
    const group = groups[0];
    return group?.models?.[0] ? detailEncodeChoice(group.id, group.models[0].id) : '';
}

function detailChoiceExists(groups, choice){
    const decoded = detailDecodeChoice(choice);
    return groups.some(group => group.id === decoded.providerId && group.models.some(model => model.id === decoded.model));
}

function detailRenderModels(){
    const imageGroups = detailModelGroups(detailState.providers, 'image');
    const chatGroups = detailModelGroups(detailState.providers, 'chat');
    if(!detailChoiceExists(imageGroups, detailState.imageChoice)) detailState.imageChoice = detailFirstChoice(imageGroups);
    if(!detailChoiceExists(chatGroups, detailState.llmChoice)) detailState.llmChoice = detailFirstChoice(chatGroups);
    const imageSelect = document.getElementById('imageModelSelect');
    const llmSelect = document.getElementById('llmModelSelect');
    imageSelect.innerHTML = detailModelOptionsHtml(imageGroups, detailState.imageChoice);
    llmSelect.innerHTML = detailModelOptionsHtml(chatGroups, detailState.llmChoice);
    imageSelect.value = detailState.imageChoice;
    llmSelect.value = detailState.llmChoice;
    imageSelect.disabled = !imageGroups.length;
    llmSelect.disabled = !chatGroups.length;
    detailSyncResolutionOptions();
}

async function detailRefreshConfig(){
    try {
        const response = await fetch('/api/config', {cache:'no-store'});
        if(!response.ok) throw new Error(`HTTP ${response.status}`);
        const config = await response.json();
        detailState.providers = Array.isArray(config.api_providers) ? config.api_providers : [];
        detailRenderModels();
        detailSetConfigState('配置就绪');
    } catch(error) {
        detailState.providers = [];
        detailRenderModels();
        detailSetConfigState('模型加载失败', true);
        detailShowToast('无法读取 API 模型配置', 'error');
    }
}

function detailSetConfigState(message, error=false){
    const state = document.getElementById('configState');
    state.textContent = message;
    state.style.color = error ? 'var(--detail-danger)' : '';
}

function detailResolutionLabel(value){
    if(value === 'auto') return '自动';
    if(value === 'custom') return '自定义';
    return value.toUpperCase();
}

function detailDefaultResolution(options){
    if(options.includes(detailState.resolution)) return detailState.resolution;
    if(options.includes('2k')) return '2k';
    return options[0] || '';
}

function detailSyncResolutionOptions(){
    const selection = detailCurrentImageSelection();
    const options = detailResolutionOptions(selection.provider, selection.model);
    detailState.resolution = detailDefaultResolution(options);
    const select = document.getElementById('resolutionSelect');
    select.innerHTML = options.length
        ? options.map(value => `<option value="${value}" ${value === detailState.resolution ? 'selected' : ''}>${detailResolutionLabel(value)}</option>`).join('')
        : '<option value="">未配置</option>';
    select.value = detailState.resolution;
    select.disabled = options.length <= 1;
    select.title = ModelConfigTools?.resolutionRoutingEnabled?.(selection.provider, selection.model)
        ? '分辨率将使用 API 设置中映射的真实模型'
        : detailFixedResolution(selection.model) ? `该模型固定输出 ${detailState.resolution.toUpperCase()}` : '';
    detailSyncSizeFields();
}

function detailEffectiveRatio(){
    if(detailState.ratio === 'custom') return `${Math.max(1, Number(detailState.customRatioWidth) || 1)}:${Math.max(1, Number(detailState.customRatioHeight) || 1)}`;
    if(detailState.ratio === 'source') {
        const first = detailState.images.product[0];
        return first?.width && first?.height ? AdaptiveImageRatio.closestSupportedRatio(first.width, first.height) : '';
    }
    if(detailState.ratio === 'adaptive') return '';
    return detailState.ratio;
}

function detailSyncSizeFields(){
    const ratioSelect = document.getElementById('ratioSelect');
    const customRatioFields = document.getElementById('customRatioFields');
    const customSizeFields = document.getElementById('customSizeFields');
    const resolution = detailState.resolution;
    ratioSelect.value = detailState.ratio;
    ratioSelect.disabled = resolution === 'auto' || resolution === 'custom' || !resolution;
    customRatioFields.hidden = detailState.ratio !== 'custom';
    customSizeFields.hidden = resolution !== 'custom';
    const output = document.getElementById('outputSize');
    if(resolution === 'auto' || detailState.ratio === 'adaptive') output.textContent = '由模型决定';
    else if(resolution === 'custom') output.textContent = `${Math.max(64, Number(detailState.customSizeWidth) || 64)} × ${Math.max(64, Number(detailState.customSizeHeight) || 64)}`;
    else {
        const ratio = detailEffectiveRatio();
        output.textContent = ratio ? (AdaptiveImageRatio.pixelSizeForRatio(ratio, resolution) || '未计算') .replace('x', ' × ') : '待上传产品图';
    }
}

function detailTotalImages(){
    return detailState.images.product.length + detailState.images.reference.length;
}

function detailImageId(){
    return `detail_image_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function detailImageNameFromUrl(url, fallback='图片'){
    try {
        const pathname = new URL(String(url || ''), globalThis.location?.href || 'http://localhost/').pathname;
        const name = decodeURIComponent(pathname.split('/').pop() || '').trim();
        return name || fallback;
    } catch(_) { return fallback; }
}

function detailRestoredImageRecords(urls, metadata, kind){
    const items = Array.isArray(urls) ? urls : [];
    const metaItems = Array.isArray(metadata) ? metadata : [];
    return items.map((value, index) => {
        const url = String(value || '').trim();
        const meta = metaItems.find(item => String(item?.url || '') === url) || metaItems[index] || {};
        return {
            id:detailImageId(), file:null, persisted:true, missing:false, url,
            name:String(meta.name || detailImageNameFromUrl(url, `${kind === 'product' ? '产品图' : '参考图'}${index + 1}`)),
            width:Math.max(0, Number(meta.width) || 0), height:Math.max(0, Number(meta.height) || 0),
        };
    }).filter(item => item.url);
}

function detailRestoredState(settings={}){
    const size = String(settings.size || '').match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    const ratio = String(settings.ratio_mode || settings.aspect_ratio || '1:1');
    const ratioParts = String(settings.aspect_ratio || '').match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
    return {
        imageChoice:detailEncodeChoice(settings.image_provider_id, settings.image_model),
        llmChoice:detailEncodeChoice(settings.llm_provider_id, settings.llm_model),
        mainImageMode:String(settings.main_image_mode || 'continuous'),
        ratio,
        resolution:String(settings.resolution || '2k'),
        screenCount:String(settings.image_count ?? 4),
        copywriting:String(settings.copywriting || 'required'),
        richness:String(settings.richness || 'concise'),
        fontStyle:String(settings.font_style || 'auto'),
        outputLanguage:String(settings.output_language || '自动识别'),
        modelSetting:String(settings.model_setting || 'none'),
        modelPose:String(settings.model_pose || 'normal'),
        modelUsage:String(settings.model_usage ?? 4),
        productName:String(settings.product_name || ''),
        productFacts:detailMergeFeatureText(settings.product_facts, settings.selling_points),
        userInstruction:String(settings.user_instruction || ''),
        customRatioWidth:String(settings.custom_ratio_width ?? ratioParts?.[1] ?? 1),
        customRatioHeight:String(settings.custom_ratio_height ?? ratioParts?.[2] ?? 1),
        customSizeWidth:String(settings.custom_size_width ?? size?.[1] ?? 2048),
        customSizeHeight:String(settings.custom_size_height ?? size?.[2] ?? 2048),
        images:{
            product:detailRestoredImageRecords(settings.product_images, settings.product_image_meta, 'product'),
            reference:detailRestoredImageRecords(settings.reference_images, settings.reference_image_meta, 'reference'),
        },
    };
}

async function detailReadImage(file){
    const url = URL.createObjectURL(file);
    const size = await new Promise(resolve => {
        const image = new Image();
        image.onload = () => resolve({width:image.naturalWidth, height:image.naturalHeight});
        image.onerror = () => resolve({width:0, height:0});
        image.src = url;
    });
    return {id:detailImageId(), file, url, name:file.name || 'image', ...size};
}

async function detailAddFiles(kind, files){
    const candidates = [...(files || [])].filter(file => file?.type?.startsWith('image/'));
    if(!candidates.length){ detailShowToast('请选择图片文件', 'error'); return; }
    const available = Math.max(0, DETAIL_MAX_IMAGES - detailTotalImages());
    if(!available){ detailShowToast('产品图和参考图合计最多 6 张', 'error'); return; }
    const accepted = candidates.slice(0, available);
    const images = await Promise.all(accepted.map(detailReadImage));
    detailState.images[kind].push(...images);
    detailRenderUploads();
    if(candidates.length > accepted.length) detailShowToast(`已达到 6 张上限，添加了前 ${accepted.length} 张`);
}

function detailUploadThumb(image, kind, index){
    const displayIndex = kind === 'reference' ? detailState.images.product.length + index + 1 : index + 1;
    return `<article class="upload-thumb ${image.missing ? 'is-missing' : ''}" draggable="true" data-image-id="${detailEscapeHtml(image.id)}" data-image-kind="${kind}" data-image-index="${index}" title="${detailEscapeHtml(image.name)}">
        <img src="${detailEscapeHtml(image.url)}" alt="">
        <span class="thumb-index">图${displayIndex}</span>
        ${image.missing ? '<span class="thumb-error">原图失效</span>' : ''}
        <span class="thumb-actions">
            <button type="button" data-preview-image="${detailEscapeHtml(image.id)}" data-preview-kind="${kind}" title="查看图片" aria-label="查看图片"><i data-lucide="zoom-in"></i></button>
            <button type="button" data-remove-image="${detailEscapeHtml(image.id)}" data-remove-kind="${kind}" title="删除图片" aria-label="删除图片"><i data-lucide="x"></i></button>
        </span>
    </article>`;
}

function detailRenderUpload(kind){
    const zone = document.querySelector(`[data-upload-kind="${kind}"]`);
    const list = zone.querySelector(`[data-upload-list="${kind}"]`);
    const images = detailState.images[kind];
    zone.classList.toggle('has-files', images.length > 0);
    list.innerHTML = images.map((image, index) => detailUploadThumb(image, kind, index)).join('')
        + (detailTotalImages() < DETAIL_MAX_IMAGES && images.length ? '<button class="upload-add" type="button" data-add-image title="继续添加" aria-label="继续添加"><i data-lucide="plus"></i></button>' : '');
    list.querySelector('[data-add-image]')?.addEventListener('click', event => {
        event.stopPropagation();
        document.getElementById(kind === 'product' ? 'productFileInput' : 'referenceFileInput').click();
    });
    list.querySelectorAll('[data-preview-image]').forEach(button => button.addEventListener('click', event => {
        event.stopPropagation();
        detailOpenPreview(button.dataset.previewKind, button.dataset.previewImage);
    }));
    list.querySelectorAll('[data-remove-image]').forEach(button => button.addEventListener('click', event => {
        event.stopPropagation();
        detailRemoveImage(button.dataset.removeKind, button.dataset.removeImage);
    }));
    list.querySelectorAll('.upload-thumb img').forEach(imageElement => imageElement.addEventListener('error', () => {
        const thumb = imageElement.closest('.upload-thumb');
        const image = images.find(item => item.id === thumb?.dataset.imageId);
        if(image){ image.missing = true; thumb.classList.add('is-missing'); }
    }, {once:true}));
    list.querySelectorAll('.upload-thumb').forEach(thumb => {
        thumb.addEventListener('dragstart', event => {
            detailDrag = {kind, id:thumb.dataset.imageId};
            thumb.classList.add('dragging');
            event.dataTransfer.effectAllowed = 'move';
        });
        thumb.addEventListener('dragend', () => { detailDrag = null; thumb.classList.remove('dragging'); });
        thumb.addEventListener('dragover', event => { if(detailDrag?.kind === kind) event.preventDefault(); });
        thumb.addEventListener('drop', event => {
            event.preventDefault();
            event.stopPropagation();
            if(detailDrag?.kind !== kind || detailDrag.id === thumb.dataset.imageId) return;
            const source = images.findIndex(item => item.id === detailDrag.id);
            const target = images.findIndex(item => item.id === thumb.dataset.imageId);
            if(source < 0 || target < 0) return;
            const [moved] = images.splice(source, 1);
            images.splice(target, 0, moved);
            detailRenderUploads();
        });
    });
}

function detailRenderUploads(){
    detailRenderUpload('product');
    detailRenderUpload('reference');
    detailSyncSizeFields();
    detailRenderGenerateAction();
    lucide.createIcons();
}

function detailRemoveImage(kind, id){
    const images = detailState.images[kind] || [];
    const index = images.findIndex(image => image.id === id);
    if(index < 0) return;
    const [removed] = images.splice(index, 1);
    if(String(removed?.url || '').startsWith('blob:')) URL.revokeObjectURL(removed.url);
    detailRenderUploads();
}

function detailOpenPreview(kind, id){
    const ordered = [...detailState.images.product, ...detailState.images.reference];
    const items = ordered.map((image, index) => ({screenNo:index + 1, name:image.name || `图${index + 1}`, candidates:[{url:image.url, name:image.name || `图${index + 1}`}], selected:0}));
    const index = Math.max(0, ordered.findIndex(image => image.id === id));
    detailOpenViewer(items, index, 0);
}

function detailClosePreview(){
    document.getElementById('imagePreview').hidden = true;
    document.getElementById('previewImage').src = '';
    detailRuntime.viewer.items = [];
    detailViewerReset();
}

function detailViewerReset(){
    Object.assign(detailRuntime.viewer, {scale:1, x:0, y:0, dragging:false, pinchDistance:0});
    detailViewerTransform();
}

function detailViewerTransform(){
    const viewer = detailRuntime.viewer;
    const image = document.getElementById('previewImage');
    if(image) image.style.transform = `translate(calc(-50% + ${viewer.x}px), calc(-50% + ${viewer.y}px)) scale(${viewer.scale})`;
}

function detailViewerCurrent(){
    const viewer = detailRuntime.viewer;
    const item = viewer.items[viewer.screenIndex];
    const candidate = item?.candidates?.[viewer.candidateIndex];
    return {item, candidate};
}

function detailRenderViewer(){
    const viewer = detailRuntime.viewer;
    const {item, candidate} = detailViewerCurrent();
    if(!candidate?.url){ detailClosePreview(); return; }
    document.getElementById('previewImage').src = candidate.url;
    document.getElementById('previewName').textContent = `${item.name} · ${candidate.name || `候选 ${viewer.candidateIndex + 1}`}`;
    document.getElementById('previewCounter').textContent = `${viewer.screenIndex + 1}/${viewer.items.length} · ${viewer.candidateIndex + 1}/${item.candidates.length}`;
    document.getElementById('previewPrevScreen').disabled = viewer.items.length < 2;
    document.getElementById('previewNextScreen').disabled = viewer.items.length < 2;
    document.getElementById('previewPrevCandidate').disabled = item.candidates.length < 2;
    document.getElementById('previewNextCandidate').disabled = item.candidates.length < 2;
    detailViewerReset();
}

function detailOpenViewer(items, screenIndex=0, candidateIndex=0){
    if(!Array.isArray(items) || !items.length) return;
    const viewer = detailRuntime.viewer;
    viewer.items = items;
    viewer.screenIndex = Math.max(0, Math.min(items.length - 1, screenIndex));
    viewer.candidateIndex = Math.max(0, Math.min((items[viewer.screenIndex]?.candidates?.length || 1) - 1, candidateIndex));
    document.getElementById('imagePreview').hidden = false;
    detailRenderViewer();
}

function detailViewerStepScreen(delta){
    const viewer = detailRuntime.viewer;
    if(viewer.items.length < 2) return;
    viewer.screenIndex = (viewer.screenIndex + delta + viewer.items.length) % viewer.items.length;
    viewer.candidateIndex = Math.max(0, Math.min((viewer.items[viewer.screenIndex]?.candidates?.length || 1) - 1, viewer.items[viewer.screenIndex]?.selected || 0));
    detailRenderViewer();
}

function detailViewerStepCandidate(delta){
    const viewer = detailRuntime.viewer;
    const length = viewer.items[viewer.screenIndex]?.candidates?.length || 0;
    if(length < 2) return;
    viewer.candidateIndex = (viewer.candidateIndex + delta + length) % length;
    detailRenderViewer();
}

function detailViewerZoom(factor, clientX, clientY){
    const viewer = detailRuntime.viewer;
    const next = Math.max(1, Math.min(8, viewer.scale * factor));
    if(next === viewer.scale) return;
    const stage = document.getElementById('previewStage').getBoundingClientRect();
    const px = clientX == null ? stage.width / 2 : clientX - stage.left - stage.width / 2;
    const py = clientY == null ? stage.height / 2 : clientY - stage.top - stage.height / 2;
    const ratio = next / viewer.scale;
    viewer.x = px - (px - viewer.x) * ratio;
    viewer.y = py - (py - viewer.y) * ratio;
    viewer.scale = next;
    if(next === 1){ viewer.x = 0; viewer.y = 0; }
    detailViewerTransform();
}

async function detailViewerDownload(){
    const {candidate, item} = detailViewerCurrent();
    if(!candidate?.url) return;
    const link = document.createElement('a');
    link.href = candidate.url;
    link.download = `${String(item.name || 'detail').replace(/[\\/:*?"<>|]/g, '-')}.png`;
    link.click();
}

async function detailViewerCopy(){
    const {candidate} = detailViewerCurrent();
    if(!candidate?.url || !navigator.clipboard?.write || !globalThis.ClipboardItem){ detailShowToast('当前浏览器不支持复制图片', 'error'); return; }
    try {
        const response = await fetch(candidate.url);
        const source = await response.blob();
        const canvas = document.createElement('canvas');
        const bitmap = await createImageBitmap(source);
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({'image/png':png})]);
        detailShowToast('图片已复制');
    } catch(error) { detailShowToast(error.message || '复制图片失败', 'error'); }
}

function detailBindUpload(kind){
    const zone = document.querySelector(`[data-upload-kind="${kind}"]`);
    const input = document.getElementById(kind === 'product' ? 'productFileInput' : 'referenceFileInput');
    zone.addEventListener('click', event => { if(!event.target.closest('.upload-thumb, .upload-add')) input.click(); });
    zone.addEventListener('keydown', event => { if(event.key === 'Enter' || event.key === ' '){ event.preventDefault(); input.click(); } });
    zone.addEventListener('dragover', event => { event.preventDefault(); if(!detailDrag) zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', event => { if(!zone.contains(event.relatedTarget)) zone.classList.remove('drag-over'); });
    zone.addEventListener('drop', event => {
        zone.classList.remove('drag-over');
        if(detailDrag) return;
        event.preventDefault();
        detailAddFiles(kind, event.dataTransfer.files);
    });
    input.addEventListener('change', () => { detailAddFiles(kind, input.files); input.value = ''; });
}

function detailMergeFeatureText(...values){
    const seen = new Set();
    return values.flatMap(value => String(value || '').split(/\r?\n/)).map(value => value.trim()).filter(value => {
        if(!value || seen.has(value)) return false;
        seen.add(value);
        return true;
    }).join('\n');
}

function detailPresetData(source=detailState){
    const keys = ['imageChoice','llmChoice','mainImageMode','ratio','resolution','screenCount','copywriting','richness','fontStyle','outputLanguage','modelSetting','modelPose','modelUsage','productName','productFacts','userInstruction','customRatioWidth','customRatioHeight','customSizeWidth','customSizeHeight'];
    return Object.fromEntries(keys.map(key => [key, source[key]]));
}

function detailDraftSnapshotFromState(source){
    return {
        ...detailPresetData(source),
        images:Object.fromEntries(['product', 'reference'].map(kind => [kind, (source.images?.[kind] || []).map(image => ({
            url:String(image.url || ''), name:String(image.name || ''), width:Number(image.width) || 0, height:Number(image.height) || 0,
        }))])),
    };
}

function detailDraftSnapshot(){
    return detailDraftSnapshotFromState(detailState);
}

function detailDraftSignature(){
    return JSON.stringify(detailDraftSnapshot());
}

function detailGenerationSnapshotFromState(source){
    return {
        ...detailPresetData(source),
        images:Object.fromEntries(['product', 'reference'].map(kind => [kind, (source.images?.[kind] || []).map(image => String(image?.url || ''))])),
    };
}

function detailGenerationSignature(){
    return JSON.stringify(detailGenerationSnapshotFromState(detailState));
}

function detailTaskGenerationSignature(task){
    return JSON.stringify(detailGenerationSnapshotFromState(detailRestoredState(task?.settings || {})));
}

function detailMarkDraftBaseline(){
    detailRuntime.draftBaseline = detailDraftSignature();
}

function detailHasUnsavedDraft(){
    return Boolean(detailRuntime.draftBaseline) && detailRuntime.draftBaseline !== detailDraftSignature();
}

function detailReleaseDraftImages(){
    [...detailState.images.product, ...detailState.images.reference].forEach(image => {
        if(String(image?.url || '').startsWith('blob:')) URL.revokeObjectURL(image.url);
    });
}

function detailApplyRestoredSettings(settings){
    detailReleaseDraftImages();
    Object.assign(detailState, detailRestoredState(settings));
    if(detailState.providers.length) detailRenderModels();
    detailApplyStateToControls();
    detailRenderUploads();
    detailMarkDraftBaseline();
}

function detailSavePreset(){
    localStorage.setItem(DETAIL_PRESET_KEY, JSON.stringify(detailPresetData()));
    detailShowToast('主图预设已保存');
}

function detailLoadPreset(){
    try {
        const preset = JSON.parse(localStorage.getItem(DETAIL_PRESET_KEY) || 'null');
        if(!preset || typeof preset !== 'object') throw new Error('empty');
        Object.keys(detailPresetData()).forEach(key => { if(preset[key] !== undefined) detailState[key] = String(preset[key]); });
        detailState.productFacts = detailMergeFeatureText(detailState.productFacts, preset.sellingPoints);
        detailApplyStateToControls();
        detailRenderModels();
        detailShowToast('主图预设已加载');
    } catch(_) { detailShowToast('还没有保存的主图预设', 'error'); }
}

function detailApplyStateToControls(){
    document.querySelectorAll('[data-state]').forEach(control => {
        const key = control.dataset.state;
        if(detailState[key] !== undefined) control.value = detailState[key];
    });
    ['customRatioWidth','customRatioHeight','customSizeWidth','customSizeHeight'].forEach(key => {
        document.getElementById(key).value = detailState[key];
    });
    detailSyncModelControls();
    detailClampCountSettings();
    detailSyncSizeFields();
}

function detailSyncModelControls(){
    const enabled = detailState.modelSetting === 'use';
    document.getElementById('modelPose').disabled = !enabled;
    document.getElementById('modelUsage').disabled = !enabled;
}

function detailClampCountSettings(){
    const screenCount = Math.max(1, Math.min(12, Number(detailState.screenCount) || 1));
    const requested = detailState.modelSetting === 'use' ? Math.max(1, Number(detailState.modelUsage) || 1) : 0;
    detailState.modelUsage = String(Math.max(0, Math.min(12, screenCount, requested)));
    document.getElementById('modelUsage').value = detailState.modelUsage;
}

function detailValidateDraft(){
    if(!detailState.images.product.length) return '请至少添加一张产品图';
    if(!detailDecodeChoice(detailState.imageChoice).model) return '请先配置图片模型';
    if(!detailDecodeChoice(detailState.llmChoice).model) return '请先配置视觉 LLM 模型';
    if(detailState.ratio === 'source' && !detailEffectiveRatio()) return '拉伸适配需要一张可识别尺寸的产品图';
    return '';
}

function detailEffectiveSize(){
    if(detailState.resolution === 'custom'){
        return `${Math.max(64, Number(detailState.customSizeWidth) || 64)}x${Math.max(64, Number(detailState.customSizeHeight) || 64)}`;
    }
    const ratio = detailEffectiveRatio();
    if(ratio && detailState.resolution && detailState.resolution !== 'auto'){
        const calculated = AdaptiveImageRatio.pixelSizeForRatio(ratio, detailState.resolution);
        if(calculated) return String(calculated).replace(/\s*[×x]\s*/i, 'x');
    }
    return '1024x1024';
}

function detailTaskPayload(uploaded, options={}){
    const image = detailDecodeChoice(detailState.imageChoice);
    const llm = detailDecodeChoice(detailState.llmChoice);
    const payload = {
        main_image_mode:detailState.mainImageMode,
        product_images:[...(uploaded?.product || [])],
        reference_images:[...(uploaded?.reference || [])],
        product_image_meta:[...(uploaded?.productMeta || [])],
        reference_image_meta:[...(uploaded?.referenceMeta || [])],
        image_provider_id:image.providerId,
        image_model:image.model,
        llm_provider_id:llm.providerId,
        llm_model:llm.model,
        aspect_ratio:detailEffectiveRatio(),
        resolution:detailState.resolution,
        size:detailEffectiveSize(),
        ratio_mode:detailState.ratio,
        custom_ratio_width:Math.max(1, Number(detailState.customRatioWidth) || 1),
        custom_ratio_height:Math.max(1, Number(detailState.customRatioHeight) || 1),
        custom_size_width:Math.max(64, Number(detailState.customSizeWidth) || 64),
        custom_size_height:Math.max(64, Number(detailState.customSizeHeight) || 64),
        quality:'auto',
        image_count:Number(detailState.screenCount),
        copywriting:detailState.copywriting,
        richness:detailState.richness,
        font_style:detailState.fontStyle,
        output_language:detailState.outputLanguage.trim() || '自动识别',
        model_setting:detailState.modelSetting,
        model_pose:detailState.modelPose,
        model_usage:Number(detailState.modelUsage),
        product_name:detailState.productName.trim(),
        product_facts:detailState.productFacts.trim(),
        selling_points:'',
        user_instruction:detailState.userInstruction.trim(),
    };
    if(options.submissionId) payload.submission_id = String(options.submissionId);
    if(options.forceNew) payload.force_new = true;
    return payload;
}

function detailErrorMessage(data, fallback='请求失败'){
    const detail = data?.detail ?? data?.error ?? data?.message;
    if(typeof detail === 'string' && detail.trim()) return detail.trim();
    if(Array.isArray(detail)) return detail.map(item => item?.msg || String(item)).join('；');
    if(detail && typeof detail === 'object') return detail.message || JSON.stringify(detail);
    return fallback;
}

async function detailFetchJson(url, options={}){
    const response = await fetch(url, {cache:'no-store', ...options});
    let data = null;
    try { data = await response.json(); }
    catch(_) { data = null; }
    if(!response.ok){
        const error = new Error(detailErrorMessage(data, `HTTP ${response.status}`));
        error.status = response.status;
        throw error;
    }
    return data;
}

async function detailUploadTaskImages(signal){
    const product = detailState.images.product;
    const reference = detailState.images.reference;
    const ordered = [...product, ...reference];
    const pending = ordered.filter(image => image?.file);
    let files = [];
    if(pending.length){
        const form = new FormData();
        pending.forEach(image => form.append('files', image.file, image.name || image.file?.name || 'image.png'));
        const data = await detailFetchJson('/api/ai/upload', {method:'POST', body:form, signal});
        files = Array.isArray(data?.files) ? data.files : [];
        if(files.length !== pending.length) throw new Error(`图片上传不完整：需要 ${pending.length} 张，实际 ${files.length} 张`);
    }
    let uploadedIndex = 0;
    const urls = ordered.map(image => image?.file ? String(files[uploadedIndex++]?.url || '').trim() : String(image?.url || '').trim());
    if(urls.some(url => !url)) throw new Error('图片上传结果缺少地址');
    const metadata = ordered.map((image, index) => ({
        url:urls[index], name:String(image?.name || detailImageNameFromUrl(urls[index])),
        width:Math.max(0, Number(image?.width) || 0), height:Math.max(0, Number(image?.height) || 0),
    }));
    return {
        product:urls.slice(0, product.length),
        reference:urls.slice(product.length),
        productMeta:metadata.slice(0, product.length),
        referenceMeta:metadata.slice(product.length),
    };
}

function detailPromoteUploadedImages(uploaded){
    detailReleaseDraftImages();
    detailState.images.product = detailRestoredImageRecords(uploaded?.product, uploaded?.productMeta, 'product');
    detailState.images.reference = detailRestoredImageRecords(uploaded?.reference, uploaded?.referenceMeta, 'reference');
    return detailState.images;
}

function detailAnalysisLines(value){
    return (Array.isArray(value) ? value : String(value || '').split(/\r?\n/))
        .map(item => String(item || '').trim())
        .filter(Boolean)
        .join('\n');
}

function detailCloseSmartAnalysis(){
    const modal = document.getElementById('smartAnalysisModal');
    if(modal) modal.hidden = true;
}

function detailShowSmartAnalysis(analysis){
    document.getElementById('smartProductName').value = String(analysis?.product_name || '');
    document.getElementById('smartProductFacts').value = detailMergeFeatureText(
        detailAnalysisLines(analysis?.product_facts),
        detailAnalysisLines(analysis?.selling_points),
    );
    document.getElementById('smartUncertainItems').value = detailAnalysisLines(analysis?.uncertain_items) || '没有发现需要确认的项目';
    document.getElementById('smartAnalysisModal').hidden = false;
    lucide.createIcons();
}

async function detailSmartAnalyze(){
    if(detailRuntime.isSmartAnalyzing || detailRuntime.isUploading) return;
    if(!detailState.images.product.length){ detailShowToast('请至少添加一张产品图', 'error'); return; }
    const llm = detailDecodeChoice(detailState.llmChoice);
    if(!llm.model){ detailShowToast('请先配置视觉 LLM 模型', 'error'); return; }
    detailRuntime.isSmartAnalyzing = true;
    detailRenderGenerateAction();
    try {
        const uploaded = await detailUploadTaskImages();
        detailPromoteUploadedImages(uploaded);
        detailRenderUploads();
        const result = await detailFetchJson('/api/main-image/analyze', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                product_images:uploaded.product,
                reference_images:uploaded.reference,
                llm_provider_id:llm.providerId,
                llm_model:llm.model,
                product_name:detailState.productName.trim(),
                product_facts:detailState.productFacts.trim(),
                selling_points:'',
            }),
        });
        detailShowSmartAnalysis(result?.analysis || {});
    } catch(error) {
        detailShowToast(error.message || '智能识别失败', 'error');
    } finally {
        detailRuntime.isSmartAnalyzing = false;
        detailRenderGenerateAction();
    }
}

function detailApplySmartAnalysis(){
    const proposals = {
        productName:document.getElementById('smartProductName').value.trim(),
        productFacts:document.getElementById('smartProductFacts').value.trim(),
    };
    let applied = 0;
    Object.entries(proposals).forEach(([key, value]) => {
        if(!String(detailState[key] || '').trim() && value){
            detailState[key] = value;
            const control = document.querySelector(`[data-state="${key}"]`);
            if(control) control.value = value;
            applied += 1;
        }
    });
    detailCloseSmartAnalysis();
    detailRenderGenerateAction();
    detailShowToast(applied ? `已补充 ${applied} 个空字段，已有内容保持不变` : '已有字段均未覆盖，你可以手动复制识别结果');
}

function detailTaskIsActive(task=detailRuntime.task){
    return DETAIL_ACTIVE_STATUSES.has(String(task?.status || ''));
}

function detailScreenRegenerationLocked(screen, task=detailRuntime.task){
    const taskStatus = String(task?.status || '');
    const taskBlocksScreens = DETAIL_ACTIVE_STATUSES.has(taskStatus) && taskStatus !== 'generating';
    return taskBlocksScreens || DETAIL_SCREEN_ACTIVE_STATUSES.has(String(screen?.status || ''));
}

function detailTaskStatusLabel(status){
    return ({
        uploading:'上传图片', planning:'规划提示词', analyzing:'兼容分析', repairing:'修复结果', compiling:'兼容编译', generating:'并发生成',
        succeeded:'全部完成', partial:'部分完成', failed:'任务失败', cancelled:'已取消', interrupted:'已中断', unknown:'存在待回补结果',
    })[status] || '待规划';
}

function detailTaskGroupNumber(task){
    const groupNo = Number(task?.group_no);
    if(Number.isInteger(groupNo) && groupNo > 0) return groupNo;
    // 仅兼容尚未重启迁移的旧后端；新后端返回 group_no 后不再动态计算。
    const ordered = [...detailRuntime.history].sort((left, right) => {
        const created = Number(left?.created_at || 0) - Number(right?.created_at || 0);
        return created || String(left?.id || '').localeCompare(String(right?.id || ''));
    });
    const index = ordered.findIndex(item => String(item?.id || '') === String(task?.id || ''));
    return index < 0 ? detailRuntime.history.length + 1 : index + 1;
}

function detailTaskHeading(task){
    if(!task) return '新分组';
    const title = String(task?.title || '').trim();
    const group = `分组 #${detailTaskGroupNumber(task)}`;
    return title ? `${title} · ${group}` : group;
}

function detailDefaultTaskTitle(value){
    const title = String(value || '').replace(/\s+/g, ' ').trim();
    if(!title) return '';
    if(title.endsWith('主图')) return title.slice(0, 60).trim();
    return `${title.slice(0, 58).trim()}主图`;
}

function detailActiveTaskProgress(task){
    const status = String(task?.status || '');
    if(status === 'generating'){
        const screens = Array.isArray(task?.screens) ? task.screens : [];
        const completed = screens.filter(screen => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(String(screen?.status || ''))).length;
        const total = screens.length || Math.max(0, Number(task?.settings?.image_count) || 0);
        return `生成中 ${completed}/${total}`;
    }
    return ({uploading:'上传中', planning:'规划中', analyzing:'规划中', repairing:'修复规划中', compiling:'整理规划中'})[status] || detailTaskStatusLabel(status);
}

function detailGenerationActionState(){
    if(detailRuntime.isUploading) return {mode:'submitting', label:'正在提交', disabled:true, showForce:false, matchCount:0, task:null};
    const signature = detailGenerationSignature();
    const matching = detailRuntime.history.filter(task => detailTaskGenerationSignature(task) === signature);
    const activeMatches = matching.filter(task => detailTaskIsActive(task)).sort((left, right) => Number(right?.created_at || 0) - Number(left?.created_at || 0));
    if(activeMatches.length){
        const task = activeMatches[0];
        const label = activeMatches.length > 1
            ? `${activeMatches.length} 个相同配置分组运行中 · 查看最新`
            : `分组 #${detailTaskGroupNumber(task)} · ${detailActiveTaskProgress(task)}`;
        return {mode:'view', label, disabled:false, showForce:true, matchCount:activeMatches.length, task};
    }
    const unknownMatches = matching.filter(task => String(task?.status || '') === 'unknown').sort((left, right) => Number(right?.created_at || 0) - Number(left?.created_at || 0));
    if(unknownMatches.length){
        const task = unknownMatches[0];
        return {mode:'view', label:`分组 #${detailTaskGroupNumber(task)} · 存在待回补结果`, disabled:false, showForce:false, matchCount:unknownMatches.length, task};
    }
    if(matching.some(task => DETAIL_TERMINAL_STATUSES.has(String(task?.status || '')))){
        return {mode:'repeat', label:'再次生成', disabled:false, showForce:false, matchCount:0, task:null};
    }
    if(detailRuntime.history.length){
        return {mode:'new', label:'生成新分组', disabled:false, showForce:false, matchCount:0, task:null};
    }
    return {mode:'create', label:'一键生成主图', disabled:false, showForce:false, matchCount:0, task:null};
}

function detailCreateSubmissionId(){
    if(globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
        const value = Math.floor(Math.random() * 16);
        return (char === 'x' ? value : (value & 3) | 8).toString(16);
    });
}

function detailBeginSubmission(forceNew=false){
    if(detailRuntime.isUploading) return '';
    const signature = detailGenerationSignature();
    const pending = detailRuntime.pendingSubmission;
    const submissionId = pending && pending.signature === signature && pending.forceNew === Boolean(forceNew)
        ? pending.id
        : detailCreateSubmissionId();
    detailRuntime.pendingSubmission = {id:submissionId, signature, forceNew:Boolean(forceNew)};
    detailRuntime.isUploading = true;
    return submissionId;
}

function detailEndSubmission(succeeded){
    detailRuntime.isUploading = false;
    if(succeeded) detailRuntime.pendingSubmission = null;
}

function detailRenderGenerateAction(){
    const button = document.getElementById('analyzeBtn');
    const forceButton = document.getElementById('forceGenerateBtn');
    if(!button) return detailGenerationActionState();
    const action = detailGenerationActionState();
    button.disabled = action.disabled || detailRuntime.isSmartAnalyzing;
    button.dataset.action = action.mode;
    button.querySelector('span').textContent = action.label;
    if(forceButton){
        forceButton.hidden = !action.showForce;
        forceButton.disabled = detailRuntime.isUploading || detailRuntime.isSmartAnalyzing;
    }
    const smartButton = document.getElementById('smartAnalyzeBtn');
    if(smartButton){
        smartButton.disabled = detailRuntime.isUploading || detailRuntime.isSmartAnalyzing;
        const label = smartButton.querySelector('span');
        if(label) label.textContent = detailRuntime.isSmartAnalyzing ? '识别中…' : '智能识别';
    }
    return action;
}

function detailScreenStatusLabel(status){
    return ({queued:'排队', submitting:'正在提交', generating:'生成中', recovering:'恢复查询中', unknown:'结果未知', succeeded:'已完成', failed:'生成失败', cancelled:'已取消', interrupted:'已中断'})[status] || '等待';
}

function detailLlmTraceLabel(task){
    const trace = task?.llm_trace;
    if(!trace?.model) return '';
    const provider = trace.provider_id ? ` · ${trace.provider_id}` : '';
    const repairs = Number(trace.repair_calls) || 0;
    const details = [
        `规划 ${Number(trace.planning_calls ?? trace.analysis_calls) || 0}`,
        `编译 ${Number(trace.compilation_calls) || 0}`,
        `修复 ${repairs}`,
    ];
    if(trace.parse_method) details.push(`解析 ${trace.parse_method}`);
    if(trace.resolved_language) details.push(`语种 ${trace.resolved_language}`);
    return `视觉 LLM：${trace.model}${provider} · ${details.join(' · ')}`;
}

function detailScreenCandidates(screen){
    const candidates = Array.isArray(screen?.candidates) ? screen.candidates : [];
    if(candidates.length) return candidates;
    const legacy = screen?.result;
    return legacy ? [{id:'legacy', status:'succeeded', result:legacy, image_url:Array.isArray(legacy.images) ? legacy.images[0] : ''}] : [];
}

function detailCandidateSummary(candidates){
    const items = Array.isArray(candidates) ? candidates : [];
    const succeeded = items.filter(candidate => candidate?.status === 'succeeded').length;
    const failed = items.filter(candidate => candidate?.status === 'failed').length;
    const unknown = items.filter(candidate => candidate?.status === 'unknown').length;
    const pending = Math.max(0, items.length - succeeded - failed - unknown);
    if(!failed && !unknown && !pending) return `${succeeded} 个候选`;
    return [`${succeeded} 成功`, unknown ? `${unknown} 待回补` : '', failed ? `${failed} 失败` : '', pending ? `${pending} 生成中` : ''].filter(Boolean).join(' · ');
}

function detailSelectedCandidateIndex(screen){
    const candidates = detailScreenCandidates(screen);
    const selected = Number(screen?.selected_candidate);
    if(Number.isInteger(selected) && selected >= 0 && selected < candidates.length && candidates[selected]?.status === 'succeeded') return selected;
    return candidates.findIndex(candidate => candidate?.status === 'succeeded');
}

function detailResultImage(screen){
    const candidates = detailScreenCandidates(screen);
    const selected = detailSelectedCandidateIndex(screen);
    const candidate = selected >= 0 ? candidates[selected] : null;
    if(candidate?.image_url) return String(candidate.image_url);
    const images = candidate?.result?.images;
    return Array.isArray(images) ? String(images[0] || '') : '';
}

function detailPromptValue(screen, locked){
    const screenNo = Number(screen?.screen_no);
    if(!locked && detailRuntime.promptDrafts.has(screenNo)) return detailRuntime.promptDrafts.get(screenNo);
    return String(screen?.prompt || '');
}

function detailRenderEmptyResults(title, message, active=false){
    document.getElementById('resultGrid').innerHTML = `<div class="empty-results ${active ? 'is-active' : ''}">
        <i data-lucide="${active ? 'loader-circle' : 'panels-top-left'}"></i>
        <strong>${detailEscapeHtml(title)}</strong><span>${detailEscapeHtml(message)}</span>
    </div>`;
}

function detailScreenCard(screen, locked){
    const imageUrl = detailResultImage(screen);
    const candidates = detailScreenCandidates(screen);
    const selectedCandidate = detailSelectedCandidateIndex(screen);
    const deletingScreen = detailRuntime.deletingScreenNo === Number(screen.screen_no);
    const cardLocked = locked || deletingScreen;
    const flags = [
        screen.use_model ? `<span class="screen-flag model">${screen.pose_mode === 'specific' ? '特定姿态' : '模特'}</span>` : '',
    ].join('');
    const preview = imageUrl
        ? `<button class="screen-image" type="button" data-preview-screen="${screen.screen_no}"><img src="${detailEscapeHtml(imageUrl)}" alt="第 ${screen.screen_no} 张主图" loading="lazy"></button>`
        : `<div class="screen-placeholder ${screen.status === 'generating' ? 'is-generating' : ''}"><i data-lucide="${screen.status === 'generating' ? 'loader-circle' : 'image'}"></i><span>${detailEscapeHtml(detailScreenStatusLabel(screen.status))}</span></div>`;
    const candidateStrip = candidates.length ? `<div class="candidate-strip"><span class="candidate-summary">${detailEscapeHtml(detailCandidateSummary(candidates))}</span>${candidates.map((candidate, index) => {
        const status = ['succeeded', 'failed', 'unknown', 'submitting', 'recovering', 'queued', 'generating'].includes(String(candidate?.status || '')) ? String(candidate.status) : 'queued';
        const classes = [status, index === selectedCandidate ? 'active' : ''].filter(Boolean).join(' ');
        const title = status === 'succeeded' ? `选择候选 ${index + 1}` : detailEscapeHtml(candidate?.error || (status === 'failed' ? '候选失败' : status === 'unknown' ? '结果未知' : '候选生成中'));
        const stateLabel = status === 'succeeded' ? '生成成功' : status === 'failed' ? '生成失败' : status === 'unknown' ? '待回补' : '生成中';
        const selector = `<button type="button" data-select-candidate="${index}" data-screen="${screen.screen_no}" class="${classes}" ${status !== 'succeeded' || cardLocked ? 'disabled' : ''} title="${title}" aria-label="候选 ${index + 1}，${stateLabel}">${index + 1}</button>`;
        const recover = status === 'unknown' && candidate?.upstream_task_id
            ? `<button type="button" class="candidate-recover-action" data-recover-candidate="${detailEscapeHtml(candidate.id || '')}" data-screen="${screen.screen_no}" ${cardLocked ? 'disabled' : ''} title="只查询原上游任务，不会重新生图">回补</button>`
            : '';
        return selector + recover;
    }).join('')}</div>` : '';
    const error = screen.error ? `<p class="screen-error">${detailEscapeHtml(screen.error)}</p>` : '';
    const regenerationLocked = detailScreenRegenerationLocked(screen) || deletingScreen;
    return `<article class="result-card" data-screen-no="${screen.screen_no}" draggable="${cardLocked ? 'false' : 'true'}">
        <header class="screen-card-head"><div class="screen-card-title"><span class="screen-number">第 ${screen.screen_no} 张 · ${detailEscapeHtml(screen.screen_type || '主图')}</span><strong>${detailEscapeHtml(screen.purpose || `第 ${screen.screen_no} 张主图`)}</strong></div><div class="screen-card-meta"><span class="screen-state ${detailEscapeHtml(screen.status)}">${detailEscapeHtml(detailScreenStatusLabel(screen.status))}</span>${flags ? `<div class="screen-flags">${flags}</div>` : ''}</div></header>
        ${preview}
        ${candidateStrip}
        ${error}
        <footer class="screen-card-actions"><button type="button" data-open-prompt="${screen.screen_no}" ${deletingScreen ? 'disabled' : ''}><i data-lucide="file-text"></i><span>提示词</span></button><button type="button" data-screen-params="${screen.screen_no}" ${cardLocked ? 'disabled' : ''} title="单张参数"><i data-lucide="sliders-horizontal"></i></button><button type="button" data-regenerate-screen="${screen.screen_no}" data-count="1" ${regenerationLocked ? 'disabled' : ''}><i data-lucide="refresh-cw"></i><span>重刷</span></button><button type="button" data-delete-screen="${screen.screen_no}" ${cardLocked ? 'disabled' : ''} aria-busy="${deletingScreen ? 'true' : 'false'}" title="${deletingScreen ? '删除中…' : '删除主图'}"><i data-lucide="${deletingScreen ? 'loader-circle' : 'trash-2'}"></i>${deletingScreen ? '<span>删除中…</span>' : ''}</button></footer>
    </article>`;
}

function detailRenderTaskTitle(task){
    const heading = document.getElementById('resultGroupTitle');
    const renameButton = document.getElementById('renameTaskBtn');
    const form = document.getElementById('taskTitleForm');
    const input = document.getElementById('taskTitleInput');
    if(!heading || !renameButton || !form || !input) return;
    const taskId = String(task?.id || '');
    const editing = Boolean(taskId && detailRuntime.renamingTaskId === taskId);
    heading.textContent = detailTaskHeading(task);
    heading.hidden = editing;
    renameButton.hidden = !taskId || editing;
    form.hidden = !editing;
    if(editing && input.dataset.taskId !== taskId){
        input.dataset.taskId = taskId;
        input.value = String(task?.title || '');
    } else if(!editing){
        input.dataset.taskId = '';
    }
}

function detailRenderTask(){
    const task = detailRuntime.task;
    const status = String(task?.status || '');
    const active = detailTaskIsActive(task);
    detailRenderTaskTitle(task);
    const screens = Array.isArray(task?.screens) ? [...task.screens] : [];
    const sorted = document.getElementById('directionToggle')?.checked ? screens.reverse() : screens;
    const completed = screens.filter(screen => ['succeeded', 'failed', 'unknown', 'cancelled', 'interrupted'].includes(screen.status)).length;
    document.getElementById('resultCount').textContent = screens.length ? `${completed}/${screens.length} 张` : '0 张';
    const resultStatus = document.getElementById('resultStatus');
    resultStatus.textContent = detailRuntime.deletingTaskId === String(task?.id || '') ? '删除中…' : detailTaskStatusLabel(status);
    resultStatus.dataset.status = status;
    const llmTrace = document.getElementById('llmTrace');
    const llmTraceText = detailLlmTraceLabel(task);
    llmTrace.textContent = llmTraceText;
    llmTrace.hidden = !llmTraceText;
    const importMediaWarning = document.getElementById('importMediaWarning');
    const missingMediaCount = Array.isArray(task?.import_missing_media) ? task.import_missing_media.length : 0;
    importMediaWarning.textContent = task?.import_warning || (missingMediaCount ? `导入记录中有 ${missingMediaCount} 个媒体文件缺失，请删除或替换后再生成。` : '');
    importMediaWarning.hidden = !importMediaWarning.textContent;
    const cancelButton = document.getElementById('cancelTaskBtn');
    cancelButton.hidden = !active;
    const resumable = screens.some(screen => ['failed', 'cancelled', 'interrupted', 'queued'].includes(screen.status));
    document.getElementById('resumeTaskBtn').hidden = active || !resumable;
    const deleting = Boolean(task && detailRuntime.deletingTaskId === String(task.id || ''));
    const deleteButton = document.getElementById('deleteTaskBtn');
    deleteButton.disabled = !task || active || Boolean(detailRuntime.deletingTaskId) || Boolean(detailRuntime.deletingScreenNo);
    deleteButton.setAttribute('aria-busy', deleting ? 'true' : 'false');
    deleteButton.title = deleting ? '删除中…' : '删除当前分组';
    deleteButton.setAttribute('aria-label', deleting ? '删除中…' : '删除当前分组');
    const hasImages = screens.some(screen => detailResultImage(screen));
    document.getElementById('collageBtn').disabled = !hasImages;
    document.getElementById('downloadAllBtn').disabled = !hasImages;
    const preview = task?.request_preview;
    const requestPreview = document.getElementById('requestPreview');
    document.getElementById('requestPreviewBtn').disabled = !preview;
    requestPreview.hidden = !preview;
    document.getElementById('requestPreviewText').textContent = preview ? [
        `模式：${preview.mode || task?.settings?.main_image_mode || ''}`,
        `目标画幅：${preview.aspect_ratio || task?.settings?.aspect_ratio || ''}`,
        `最终规划请求：\n${preview.request}`,
    ].join('\n\n') : '';
    const generationAction = detailRenderGenerateAction();
    const configLabel = generationAction.mode === 'view' ? detailActiveTaskProgress(generationAction.task) : task ? detailTaskStatusLabel(status) : '配置就绪';
    detailSetConfigState(detailRuntime.isUploading ? '正在提交' : configLabel, status === 'failed');

    if(!screens.length){
        if(status === 'uploading') detailRenderEmptyResults('正在上传图片', '上传完成后自动开始视觉分析', true);
        else if(['planning', 'analyzing', 'repairing', 'compiling'].includes(status)) {
            const title = status === 'repairing' ? '正在修复规划结果' : '正在一次性规划完整提示词';
            const message = '规划完成后会直接显示全部主图并并发生图';
            detailRenderEmptyResults(title, message, true);
        }
        else if(status === 'failed') detailRenderEmptyResults('主图任务失败', task?.error || '请检查视觉 LLM 配置后重试');
        else if(status === 'cancelled') detailRenderEmptyResults('任务已取消', '可以调整设置后重新开始');
        else detailRenderEmptyResults('暂无主图任务', '配置完成后开始生成');
    } else {
        if(!active){
            screens.forEach(screen => {
                const number = Number(screen.screen_no);
                if(!detailRuntime.promptDrafts.has(number)) detailRuntime.promptDrafts.set(number, String(screen.prompt || ''));
            });
        }
        document.getElementById('resultGrid').innerHTML = sorted.map(screen => detailScreenCard(screen, active)).join('');
        document.querySelectorAll('[data-preview-screen]').forEach(button => button.addEventListener('click', () => {
            detailOpenResultPreview(Number(button.dataset.previewScreen));
        }));
        document.querySelectorAll('[data-open-prompt]').forEach(button => button.addEventListener('click', () => detailOpenPromptEditor(Number(button.dataset.openPrompt))));
        document.querySelectorAll('[data-regenerate-screen]').forEach(button => button.addEventListener('click', () => {
            detailRegenerateScreen(Number(button.dataset.regenerateScreen), Number(button.dataset.count) || 1);
        }));
        document.querySelectorAll('[data-screen-params]').forEach(button => button.addEventListener('click', () => detailEditScreenParams(Number(button.dataset.screenParams))));
        document.querySelectorAll('[data-delete-screen]').forEach(button => button.addEventListener('click', () => detailDeleteScreen(Number(button.dataset.deleteScreen))));
        document.querySelectorAll('[data-select-candidate]').forEach(button => button.addEventListener('click', () => detailSelectCandidate(Number(button.dataset.screen), Number(button.dataset.selectCandidate))));
        document.querySelectorAll('[data-recover-candidate]').forEach(button => button.addEventListener('click', () => detailRecoverCandidate(Number(button.dataset.screen), button.dataset.recoverCandidate, button)));
        detailBindScreenReorder();
    }
    lucide.createIcons();
}

function detailOpenResultPreview(screenNo){
    const items = (detailRuntime.task?.screens || []).map(screen => {
        const selectedOriginal = detailSelectedCandidateIndex(screen);
        const candidates = detailScreenCandidates(screen).map((candidate, originalIndex) => ({
            url:candidate.image_url || candidate.result?.images?.[0] || '',
            name:`候选 ${originalIndex + 1}`,
            originalIndex,
        })).filter(item => item.url);
        return {
            screenNo:Number(screen.screen_no), name:`第 ${screen.screen_no} 张`, candidates,
            selected:Math.max(0, candidates.findIndex(candidate => candidate.originalIndex === selectedOriginal)),
        };
    }).filter(item => item.candidates.length);
    const index = Math.max(0, items.findIndex(item => item.screenNo === Number(screenNo)));
    detailOpenViewer(items, index, Math.max(0, items[index]?.selected || 0));
}

function detailRememberTask(task, options={}){
    const id = String(task?.id || '').trim();
    if(!id) return null;
    detailRuntime.taskCache.set(id, task);
    const existing = detailRuntime.history.findIndex(item => String(item?.id) === id);
    if(existing >= 0) detailRuntime.history.splice(existing, 1, task);
    else detailRuntime.history.push(task);
    detailRuntime.history.sort((left, right) => Number(right?.updated_at || right?.created_at || 0) - Number(left?.updated_at || left?.created_at || 0));
    if(detailTaskIsActive(task)) detailRuntime.activeTaskIds.add(id);
    else detailRuntime.activeTaskIds.delete(id);
    if(options.select) detailRuntime.viewTaskId = id;
    if(detailRuntime.viewTaskId === id) detailRuntime.task = task;
    return task;
}

function detailForgetTask(taskId){
    const id = String(taskId || '');
    detailRuntime.activeTaskIds.delete(id);
    detailRuntime.taskCache.delete(id);
    detailRuntime.history = detailRuntime.history.filter(task => String(task?.id) !== id);
    if(detailRuntime.deletingTaskId === id) detailRuntime.deletingTaskId = '';
    detailRuntime.deletingScreenNo = 0;
    if(!detailRuntime.activeTaskIds.size) detailStopPolling();
}

function detailStopPolling(){
    clearTimeout(detailRuntime.pollTimer);
    detailRuntime.pollTimer = null;
}

async function detailPollTasks(immediate=false){
    detailStopPolling();
    const poll = async () => {
        if(detailRuntime.pollInFlight){ detailRuntime.pollTimer = setTimeout(poll, 300); return; }
        const taskIds = [...detailRuntime.activeTaskIds];
        if(!taskIds.length) return;
        detailRuntime.pollInFlight = true;
        let viewedChanged = false;
        const results = await Promise.allSettled(taskIds.map(async taskId => ({
            taskId,
            task:await detailFetchJson(`/api/main-image-tasks/${encodeURIComponent(taskId)}`),
        })));
        results.forEach((result, index) => {
            const taskId = taskIds[index];
            if(!detailRuntime.activeTaskIds.has(taskId) && detailRuntime.deletingTaskId !== taskId) return;
            if(result.status === 'fulfilled'){
                detailRememberTask(result.value.task);
                if(taskId === detailRuntime.viewTaskId) viewedChanged = true;
                return;
            }
            const error = result.reason;
            if(Number(error?.status) === 404){
                detailRuntime.activeTaskIds.delete(taskId);
                const cached = detailRuntime.taskCache.get(taskId);
                if(cached) detailRememberTask({...cached, status:'failed', error:'任务记录不可用'});
                if(taskId === detailRuntime.viewTaskId) viewedChanged = true;
                detailShowToast('一个后台主图任务已不存在，已停止跟踪', 'error');
            }
        });
        detailRuntime.pollInFlight = false;
        detailRenderHistory();
        if(viewedChanged) detailRenderTask();
        if(detailRuntime.activeTaskIds.size){
            detailRuntime.pollTimer = setTimeout(poll, 900);
        }
    };
    if(immediate) await poll();
    else detailRuntime.pollTimer = setTimeout(poll, 300);
}

async function detailValidatePersistedImages(){
    const images = [...detailState.images.product, ...detailState.images.reference].filter(image => image?.persisted && image?.url);
    if(!images.length || typeof Image === 'undefined') return '';
    const failures = await Promise.all(images.map(image => new Promise(resolve => {
        const probe = new Image();
        let settled = false;
        const finish = missing => {
            if(settled) return;
            settled = true;
            clearTimeout(timeout);
            image.missing = missing;
            if(!missing){ image.width ||= probe.naturalWidth || 0; image.height ||= probe.naturalHeight || 0; }
            resolve(missing);
        };
        const timeout = setTimeout(() => finish(true), 8000);
        probe.onload = () => finish(false);
        probe.onerror = () => finish(true);
        probe.src = image.url;
    })));
    if(failures.some(Boolean)){
        detailRenderUploads();
        return '历史记录中的部分原始图片已无法访问，请删除后重新添加';
    }
    return '';
}

async function detailHandleGenerateClick(){
    const action = detailGenerationActionState();
    if(action.mode === 'view' && action.task){
        await detailOpenHistoryTask(action.task.id, {skipConfirm:true});
        return;
    }
    await detailAnalyzeDraft();
}

async function detailForceGenerate(){
    const action = detailGenerationActionState();
    if(!action.showForce || detailRuntime.isUploading) return;
    if(!window.confirm('相同配置已有任务正在运行。确定额外付费，再创建一个相同分组吗？')) return;
    await detailAnalyzeDraft({forceNew:true});
}

async function detailAnalyzeDraft(options={}){
    if(detailRuntime.isUploading) return;
    if(!options.forceNew){
        const action = detailGenerationActionState();
        if(action.mode === 'view' && action.task){
            await detailOpenHistoryTask(action.task.id, {skipConfirm:true});
            return;
        }
    }
    const error = detailValidateDraft();
    if(error){ detailShowToast(error, 'error'); return; }
    const submissionId = detailBeginSubmission(Boolean(options.forceNew));
    if(!submissionId) return;
    detailSavePreset();
    detailRuntime.abortController = new AbortController();
    detailRenderTask();
    try {
        const persistedError = await detailValidatePersistedImages();
        if(persistedError) throw new Error(persistedError);
        const uploaded = await detailUploadTaskImages(detailRuntime.abortController.signal);
        detailPromoteUploadedImages(uploaded);
        detailRenderUploads();
        if(detailRuntime.pendingSubmission) detailRuntime.pendingSubmission.signature = detailGenerationSignature();
        const payload = detailTaskPayload(uploaded, {submissionId, forceNew:Boolean(options.forceNew)});
        detailSetConfigState('提交规划');
        const created = await detailFetchJson('/api/main-image-tasks', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify(payload),
            signal:detailRuntime.abortController.signal,
        });
        const taskId = String(created?.task_id || '');
        if(!taskId) throw new Error('主图任务没有返回任务 ID');
        detailEndSubmission(true);
        detailRuntime.abortController = null;
        detailRuntime.promptDrafts.clear();
        let task = null;
        if(created?.reused){
            try { task = await detailFetchJson(`/api/main-image-tasks/${encodeURIComponent(taskId)}`); }
            catch(_) { task = null; }
        }
        detailRememberTask(task || {
            id:taskId, type:'main-image', title:detailDefaultTaskTitle(payload.product_name), group_no:Number(created?.group_no) || 0, status:String(created?.status || 'planning'), settings:payload,
            screens:[], created_at:Date.now() / 1000, updated_at:Date.now() / 1000,
        }, {select:true});
        detailMarkDraftBaseline();
        detailRenderHistory();
        detailRenderTask();
        if(created?.reused){
            detailShowToast(created.reuse_reason === 'submission_id' ? '重复提交已拦截，已打开原分组' : '相同配置正在运行，已打开原分组');
        }
        await detailPollTasks(true);
    } catch(error) {
        detailEndSubmission(false);
        detailRuntime.abortController = null;
        if(error?.name === 'AbortError'){
            detailShowToast('任务已取消');
        } else {
            detailShowToast(error.message || '任务提交失败', 'error');
            detailSetConfigState('提交失败', true);
        }
        detailRenderTask();
    }
}

async function detailCancelTask(){
    if(!detailRuntime.viewTaskId || !detailTaskIsActive()) return;
    try {
        const task = await detailFetchJson(`/api/main-image-tasks/${encodeURIComponent(detailRuntime.viewTaskId)}/cancel`, {method:'POST'});
        detailRememberTask(task);
        detailRenderHistory();
        detailRenderTask();
        detailShowToast('主图任务已取消');
    } catch(error) {
        detailShowToast(error.message || '取消失败', 'error');
    }
}

function detailPromptEditorScreen(){
    return (detailRuntime.task?.screens || []).find(item => Number(item.screen_no) === Number(detailRuntime.promptEditorScreenNo));
}

function detailRenderPromptEditor(){
    const modal = document.getElementById('promptEditorModal');
    if(!modal || modal.hidden) return;
    const screen = detailPromptEditorScreen();
    if(!screen){ detailClosePromptEditor(); return; }
    const locked = detailTaskIsActive();
    const screenNo = Number(screen.screen_no);
    document.getElementById('promptEditorNumber').textContent = `第 ${screenNo} 张 · ${detailState.mainImageMode === 'creative' ? '创意主图' : '连续主图'}`;
    document.getElementById('promptEditorTitle').textContent = screen.purpose || '生图提示词';
    const purpose = document.getElementById('promptEditorPurpose');
    purpose.textContent = String(screen.purpose || '');
    purpose.hidden = !purpose.textContent;
    const textarea = document.getElementById('promptEditorText');
    textarea.value = detailPromptValue(screen, locked);
    textarea.readOnly = locked;
    const candidates = Array.isArray(screen.prompt_candidates) ? screen.prompt_candidates : [];
    const candidateWrap = document.getElementById('promptEditorCandidates');
    const candidateSelect = document.getElementById('promptEditorCandidateSelect');
    candidateWrap.hidden = !candidates.length;
    candidateSelect.innerHTML = '<option value="">请选择候选</option>' + candidates.map((item, index) => `<option value="${index}">候选 ${index + 1}</option>`).join('');
    candidateSelect.disabled = locked;
    document.getElementById('promptEditorInstruction').disabled = locked;
    document.getElementById('promptEditorOptimize').disabled = locked;
    document.getElementById('promptEditorSave').disabled = locked;
    lucide.createIcons();
}

function detailOpenPromptEditor(screenNo){
    const screen = (detailRuntime.task?.screens || []).find(item => Number(item.screen_no) === Number(screenNo));
    if(!screen) return;
    detailRuntime.promptEditorScreenNo = Number(screenNo);
    if(!detailRuntime.promptDrafts.has(Number(screenNo))) detailRuntime.promptDrafts.set(Number(screenNo), String(screen.prompt || ''));
    document.getElementById('promptEditorModal').hidden = false;
    document.getElementById('promptEditorInstruction').value = '';
    detailRenderPromptEditor();
    document.getElementById('promptEditorText').focus();
}

function detailClosePromptEditor(){
    const modal = document.getElementById('promptEditorModal');
    if(modal) modal.hidden = true;
    detailRuntime.promptEditorScreenNo = 0;
}

async function detailSaveScreen(screenNo){
    if(!detailRuntime.viewTaskId || detailTaskIsActive()) return;
    const screen = (detailRuntime.task?.screens || []).find(item => Number(item.screen_no) === Number(screenNo));
    if(!screen) return;
    const prompt = String(detailRuntime.promptDrafts.get(screenNo) ?? screen.prompt ?? '').trim();
    if(!prompt){ detailShowToast('提示词不能为空', 'error'); return; }
    try {
        const task = await detailFetchJson(`/api/main-image-tasks/${encodeURIComponent(detailRuntime.viewTaskId)}/screens/${screenNo}`, {
            method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({prompt}),
        });
        detailRememberTask(task);
        detailRuntime.promptDrafts.set(screenNo, prompt);
        detailRenderTask();
        detailRenderPromptEditor();
        detailShowToast(`第 ${screenNo} 张提示词已保存`);
    } catch(error) { detailShowToast(error.message || '保存失败', 'error'); }
}

async function detailOptimizeScreen(screenNo, instruction=''){
    if(!detailRuntime.viewTaskId || detailTaskIsActive()) return;
    const requestedInstruction = String(instruction || '').trim() || '在保持产品一致性、当前购买任务和整体设计系统不变的前提下，优化画面表达与提示词清晰度';
    const screen = (detailRuntime.task?.screens || []).find(item => Number(item.screen_no) === Number(screenNo));
    const prompt = String(detailRuntime.promptDrafts.get(screenNo) ?? screen?.prompt ?? '').trim();
    try {
        const result = await detailFetchJson(`/api/main-image-tasks/${encodeURIComponent(detailRuntime.viewTaskId)}/screens/${screenNo}/optimize-prompt`, {
            method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({instruction:requestedInstruction, prompt, candidate_count:2}),
        });
        screen.prompt_candidates = result.prompt_candidates || [];
        detailRenderTask();
        detailRenderPromptEditor();
        detailShowToast('已生成提示词候选');
    } catch(error) { detailShowToast(error.message || '优化失败', 'error'); }
}

function detailApplyPromptCandidate(screenNo, candidateIndex){
    if(!Number.isInteger(candidateIndex) || candidateIndex < 0) return;
    const screen = (detailRuntime.task?.screens || []).find(item => Number(item.screen_no) === Number(screenNo));
    const prompt = screen?.prompt_candidates?.[candidateIndex]?.prompt;
    if(!prompt) return;
    detailRuntime.promptDrafts.set(screenNo, prompt);
    const textarea = document.getElementById('promptEditorText');
    if(textarea) textarea.value = prompt;
}

async function detailEditScreenParams(screenNo){
    const screen = (detailRuntime.task?.screens || []).find(item => Number(item.screen_no) === Number(screenNo));
    if(!screen) return;
    const base = detailRuntime.task?.settings || {};
    const current = screen.generation_params || {};
    const imageModel = window.prompt('图片模型', current.image_model || base.image_model || '');
    if(imageModel === null) return;
    const aspectRatio = window.prompt('比例', current.aspect_ratio || base.aspect_ratio || '');
    if(aspectRatio === null) return;
    const resolution = window.prompt('分辨率', current.resolution || base.resolution || '');
    if(resolution === null) return;
    const size = window.prompt('输出尺寸', current.size || base.size || '');
    if(size === null) return;
    try {
        const task = await detailFetchJson(`/api/main-image-tasks/${encodeURIComponent(detailRuntime.viewTaskId)}/screens/${screenNo}`, {
            method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({generation_params:{image_model:imageModel, aspect_ratio:aspectRatio, resolution, size, quality:current.quality || base.quality || 'auto'}}),
        });
        detailRememberTask(task);
        detailRenderTask();
        detailShowToast(`第 ${screenNo} 张参数已保存`);
    } catch(error) { detailShowToast(error.message || '参数保存失败', 'error'); }
}

async function detailSelectCandidate(screenNo, candidateIndex){
    try {
        const task = await detailFetchJson(`/api/main-image-tasks/${encodeURIComponent(detailRuntime.viewTaskId)}/screens/${screenNo}`, {
            method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({selected_candidate:candidateIndex}),
        });
        detailRememberTask(task);
        detailRenderTask();
    } catch(error) { detailShowToast(error.message || '候选切换失败', 'error'); }
}

async function detailRecoverCandidate(screenNo, candidateId, button){
    if(!detailRuntime.viewTaskId || !candidateId) return;
    if(button){ button.disabled = true; button.textContent = '查询中'; }
    try {
        const response = await detailFetchJson(
            `/api/main-image-tasks/${encodeURIComponent(detailRuntime.viewTaskId)}/screens/${screenNo}/candidates/${encodeURIComponent(candidateId)}/recover`,
            {method:'POST'},
        );
        if(response?.task) detailRememberTask(response.task);
        detailRenderTask();
        detailRenderHistory();
        detailPollTasks();
        detailShowToast(response?.reused ? '该任务正在回补，请勿重复点击' : '已开始回补，只查询原任务，不会重复扣费');
    } catch(error) {
        if(button){ button.disabled = false; button.textContent = '回补'; }
        detailShowToast(error.message || '回补查询失败', 'error');
    }
}

async function detailRegenerateScreen(screenNo, count=1){
    if(!detailRuntime.viewTaskId) return;
    const screen = (detailRuntime.task?.screens || []).find(item => Number(item.screen_no) === Number(screenNo));
    if(!screen || detailScreenRegenerationLocked(screen)) return;
    if(String(screen.status || '') === 'unknown' && !window.confirm('该张主图的上游结果状态未知，重新生成可能再次扣费。确定重新提交吗？')) return;
    const prompt = String(detailRuntime.promptDrafts.get(screenNo) ?? screen.prompt ?? '').trim();
    if(!prompt){ detailShowToast('提示词不能为空', 'error'); return; }
    try {
        const task = await detailFetchJson(`/api/main-image-tasks/${encodeURIComponent(detailRuntime.viewTaskId)}/screens/${screenNo}/regenerate`, {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({prompt, generation_params:screen.generation_params || {}}),
        });
        detailRememberTask(task);
        detailRuntime.promptDrafts.set(screenNo, prompt);
        detailRenderTask();
        detailRenderHistory();
        detailPollTasks();
        detailShowToast('已提交重新生成');
    } catch(error) {
        detailShowToast(error.message || '重新生成失败', 'error');
    }
}

async function detailDeleteScreen(screenNo){
    const deletedId = String(detailRuntime.viewTaskId || '');
    const targetNo = Number(screenNo);
    if(!deletedId || !targetNo || detailTaskIsActive() || detailRuntime.deletingTaskId || detailRuntime.deletingScreenNo) return;
    if(!window.confirm(`删除第 ${targetNo} 张主图及其候选结果？`)) return;
    detailRuntime.deletingScreenNo = targetNo;
    detailRenderTask();
    try {
        const result = await detailFetchJson(`/api/main-image-tasks/${encodeURIComponent(deletedId)}/screens/${targetNo}`, {method:'DELETE'});
        detailRuntime.promptDrafts.delete(targetNo);
        detailRuntime.deletingScreenNo = 0;
        const deletedLabel = result?.task_deleted ? '分组' : '主图';
        if(result?.task_deleted){
            detailForgetTask(deletedId);
            detailRuntime.viewTaskId = '';
            detailRuntime.task = null;
            detailRuntime.promptDrafts.clear();
            detailRenderHistory();
            detailRenderTask();
            const nextId = detailRuntime.history[0]?.id;
            if(nextId) void detailOpenHistoryTask(nextId, {skipConfirm:true});
        } else {
            if(!result?.task) throw new Error('删除响应缺少更新后的主图任务');
            detailRememberTask(result.task, {select:true});
            detailRenderHistory();
            detailRenderTask();
        }
        if(result?.cleanup_job_id){
            detailShowToast(`${deletedLabel}已删除，图片正在后台清理`);
            detailTrackCleanupJob(result.cleanup_job_id, deletedLabel);
        } else detailShowToast(`${deletedLabel}已删除`);
    } catch(error) { detailShowToast(error.message || '删除主图失败', 'error'); }
    finally {
        if(detailRuntime.deletingScreenNo === targetNo){
            detailRuntime.deletingScreenNo = 0;
            detailRenderTask();
        }
    }
}

function detailBindScreenReorder(){
    document.querySelectorAll('.result-card[draggable="true"]').forEach(card => {
        card.addEventListener('dragstart', event => { detailRuntime.screenDragNo = Number(card.dataset.screenNo); card.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; });
        card.addEventListener('dragend', () => { detailRuntime.screenDragNo = 0; document.querySelectorAll('.result-card').forEach(item => item.classList.remove('dragging', 'drag-target')); });
        card.addEventListener('dragover', event => { if(detailRuntime.screenDragNo){ event.preventDefault(); card.classList.add('drag-target'); } });
        card.addEventListener('dragleave', () => card.classList.remove('drag-target'));
        card.addEventListener('drop', event => { event.preventDefault(); card.classList.remove('drag-target'); detailReorderScreens(detailRuntime.screenDragNo, Number(card.dataset.screenNo)); });
    });
}

async function detailReorderScreens(sourceNo, targetNo){
    if(!sourceNo || !targetNo || sourceNo === targetNo || detailTaskIsActive()) return;
    const order = (detailRuntime.task?.screens || []).map(screen => Number(screen.screen_no));
    const source = order.indexOf(sourceNo), target = order.indexOf(targetNo);
    if(source < 0 || target < 0) return;
    order.splice(target, 0, order.splice(source, 1)[0]);
    try {
        const task = await detailFetchJson(`/api/main-image-tasks/${encodeURIComponent(detailRuntime.viewTaskId)}/screens/reorder`, {
            method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({screen_order:order}),
        });
        detailRememberTask(task);
        detailRenderTask();
    } catch(error) { detailShowToast(error.message || '顺序保存失败', 'error'); }
}

function detailHistoryLabel(task, index){
    const date = new Date((Number(task.updated_at) || 0) * 1000);
    const time = Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'}) : '';
    const screens = Array.isArray(task?.screens) ? task.screens : [];
    const completed = screens.filter(screen => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(String(screen?.status || ''))).length;
    const total = screens.length || Math.max(0, Number(task?.settings?.screen_count) || 0);
    const status = detailTaskIsActive(task) ? `运行中 ${completed}/${total}` : detailTaskStatusLabel(task?.status);
    const title = String(task?.title || '').trim();
    const group = title ? `${title} · #${detailTaskGroupNumber(task)}` : `分组 #${detailTaskGroupNumber(task)}`;
    return `${group} · ${time} · ${status}`;
}

function detailStartTaskRename(){
    const taskId = String(detailRuntime.task?.id || '');
    if(!taskId) return;
    detailRuntime.renamingTaskId = taskId;
    detailRenderTaskTitle(detailRuntime.task);
    requestAnimationFrame(() => {
        const input = document.getElementById('taskTitleInput');
        input?.focus();
        input?.select();
    });
}

function detailCancelTaskRename(){
    detailRuntime.renamingTaskId = '';
    detailRenderTaskTitle(detailRuntime.task);
}

async function detailSaveTaskTitle(event){
    event?.preventDefault();
    const taskId = String(detailRuntime.renamingTaskId || '');
    if(!taskId || taskId !== String(detailRuntime.viewTaskId || '')) return;
    const input = document.getElementById('taskTitleInput');
    const saveButton = document.getElementById('saveTaskTitleBtn');
    const cancelButton = document.getElementById('cancelTaskTitleBtn');
    const title = String(input?.value || '').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
    saveButton.disabled = true;
    cancelButton.disabled = true;
    try {
        const task = await detailFetchJson(`/api/main-image-tasks/${encodeURIComponent(taskId)}`, {
            method:'PATCH',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({title}),
        });
        detailRememberTask(task, {select:true});
        detailRuntime.renamingTaskId = '';
        detailRenderHistory();
        detailRenderTask();
        detailShowToast(title ? '分组名称已保存' : '已恢复默认分组名称');
    } catch(error) {
        detailShowToast(error.message || '分组名称保存失败', 'error');
    } finally {
        saveButton.disabled = false;
        cancelButton.disabled = false;
    }
}

function detailRenderHistory(){
    const select = document.getElementById('historySelect');
    select.innerHTML = detailRuntime.history.length ? detailRuntime.history.map((task, index) => `<option value="${detailEscapeHtml(task.id)}">${detailEscapeHtml(detailHistoryLabel(task, index))}</option>`).join('') : '<option value="">当前分组</option>';
    select.value = detailRuntime.viewTaskId || '';
    detailRenderGenerateAction();
}

async function detailLoadHistory(preferredId=''){
    try {
        const data = await detailFetchJson('/api/main-image-tasks');
        detailRuntime.history = [];
        detailRuntime.taskCache.clear();
        detailRuntime.activeTaskIds.clear();
        (Array.isArray(data.tasks) ? data.tasks : []).forEach(task => detailRememberTask(task));
        detailRenderHistory();
        const targetId = preferredId || detailRuntime.viewTaskId || detailRuntime.history[0]?.id;
        if(targetId) await detailOpenHistoryTask(targetId, {skipConfirm:true});
        if(detailRuntime.activeTaskIds.size) detailPollTasks();
    } catch(error) { detailShowToast(error.message || '历史加载失败', 'error'); }
}

async function detailOpenHistoryTask(taskId, options={}){
    if(!taskId) return;
    if(taskId !== detailRuntime.viewTaskId && !options.skipConfirm && detailHasUnsavedDraft() && !window.confirm('左侧有尚未提交的修改，切换历史后会被恢复内容替换。继续切换吗？')){
        detailRenderHistory();
        return;
    }
    try {
        const cached = detailRuntime.taskCache.get(String(taskId));
        const task = cached || await detailFetchJson(`/api/main-image-tasks/${encodeURIComponent(taskId)}`);
        detailRuntime.renamingTaskId = '';
        detailRememberTask(task, {select:true});
        detailRuntime.promptDrafts.clear();
        detailClosePromptEditor();
        detailApplyRestoredSettings(task.settings || {});
        detailRenderHistory();
        detailRenderTask();
    } catch(error) { detailShowToast(error.message || '分组加载失败', 'error'); }
}

async function detailResumeTask(){
    if(!detailRuntime.viewTaskId || detailTaskIsActive()) return;
    try {
        const task = await detailFetchJson(`/api/main-image-tasks/${encodeURIComponent(detailRuntime.viewTaskId)}/resume`, {method:'POST'});
        detailRememberTask(task);
        detailRenderTask(); detailRenderHistory(); detailPollTasks();
    } catch(error) { detailShowToast(error.message || '恢复失败', 'error'); }
}

function detailDeleteTask(){
    if(!detailRuntime.viewTaskId || detailTaskIsActive() || detailRuntime.deletingTaskId || detailRuntime.deletingScreenNo) return;
    const dialog = document.getElementById('deleteTaskDialog');
    const cancelButton = document.getElementById('deleteTaskCancelBtn');
    if(!dialog?.showModal) return;
    detailRuntime.deleteDialogTaskId = detailRuntime.viewTaskId;
    dialog.showModal();
    requestAnimationFrame(() => cancelButton?.focus());
}

async function detailConfirmDeleteTask(){
    const deletedId = String(detailRuntime.deleteDialogTaskId || detailRuntime.viewTaskId || '');
    const dialog = document.getElementById('deleteTaskDialog');
    if(!deletedId || !dialog || detailRuntime.deletingTaskId || detailRuntime.deletingScreenNo) return;
    dialog.close('confirm');
    detailRuntime.deleteDialogTaskId = '';
    const deleteButton = document.getElementById('deleteTaskBtn');
    detailRuntime.deletingTaskId = deletedId;
    if(deleteButton){
        deleteButton.disabled = true;
        deleteButton.setAttribute('aria-busy', 'true');
        deleteButton.title = '删除中…';
        deleteButton.setAttribute('aria-label', '删除中…');
    }
    detailRenderTask();
    try {
        const result = await detailFetchJson(`/api/main-image-tasks/${encodeURIComponent(deletedId)}`, {method:'DELETE'});
        detailForgetTask(deletedId);
        detailRuntime.viewTaskId = ''; detailRuntime.task = null; detailRuntime.promptDrafts.clear();
        detailRuntime.deletingTaskId = '';
        detailRenderHistory(); detailRenderTask();
        if(result?.cleanup_job_id){
            detailShowToast('分组已删除，图片正在后台清理');
            detailTrackCleanupJob(result.cleanup_job_id);
        } else detailShowToast('分组已删除');
        const nextId = detailRuntime.history[0]?.id;
        if(nextId) void detailOpenHistoryTask(nextId, {skipConfirm:true});
    } catch(error) { detailShowToast(error.message || '删除分组失败', 'error'); }
    finally {
        if(detailRuntime.deletingTaskId === deletedId){
            detailRuntime.deletingTaskId = '';
            detailRenderTask();
        }
    }
}

function detailCancelDeleteTask(){
    detailRuntime.deleteDialogTaskId = '';
    const dialog = document.getElementById('deleteTaskDialog');
    if(dialog?.open) dialog.close('cancel');
    document.getElementById('deleteTaskBtn')?.focus();
}

function detailTrackCleanupJob(jobId, deletedLabel='分组'){
    const id = String(jobId || '').trim();
    if(!id || detailRuntime.cleanupJobs.has(id)) return;
    const state = {failedNotified:false, timer:0, deletedLabel:String(deletedLabel || '记录')};
    detailRuntime.cleanupJobs.set(id, state);
    void detailPollCleanupJob(id, state);
}

async function detailPollCleanupJob(jobId, state){
    if(detailRuntime.cleanupJobs.get(jobId) !== state) return;
    try {
        const job = await detailFetchJson(`/api/storage-cleanup/jobs/${encodeURIComponent(jobId)}`);
        if(job?.status === 'failed' && !state.failedNotified){
            state.failedNotified = true;
            detailShowToast(`${state.deletedLabel}已删除，图片将在后台重试清理`, 'error');
        }
        if(job?.status === 'review_required'){
            detailRuntime.cleanupJobs.delete(jobId);
            detailShowToast(`${state.deletedLabel}已删除，旧图片需重新审计确认后清理`, 'error');
            return;
        }
        if(job?.status === 'succeeded'){
            detailRuntime.cleanupJobs.delete(jobId);
            detailShowToast(`${state.deletedLabel}已删除，图片清理完成`);
            return;
        }
        state.timer = window.setTimeout(() => void detailPollCleanupJob(jobId, state), job?.status === 'failed' ? 5000 : 1500);
    } catch(error){
        if(Number(error?.status) === 404){
            detailRuntime.cleanupJobs.delete(jobId);
            detailShowToast(`${state.deletedLabel}已删除，图片清理完成`);
            return;
        }
        state.timer = window.setTimeout(() => void detailPollCleanupJob(jobId, state), 5000);
    }
}

function detailDownloadAll(){
    if(!detailRuntime.viewTaskId) return;
    const link = document.createElement('a');
    link.href = `/api/main-image-tasks/${encodeURIComponent(detailRuntime.viewTaskId)}/download.zip`;
    link.download = 'main-image.zip'; link.click();
}

async function detailCollage(){
    const screens = (detailRuntime.task?.screens || []).filter(screen => detailResultImage(screen));
    if(!screens.length) return;
    try {
        const images = await Promise.all(screens.map(screen => new Promise((resolve, reject) => {
            const image = new Image(); image.crossOrigin = 'anonymous'; image.onload = () => resolve(image); image.onerror = reject; image.src = detailResultImage(screen);
        })));
        const width = Math.max(...images.map(image => image.naturalWidth));
        const heights = images.map(image => Math.round(image.naturalHeight * width / image.naturalWidth));
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = heights.reduce((sum, value) => sum + value, 0);
        const context = canvas.getContext('2d'); let y = 0;
        images.forEach((image, index) => { context.drawImage(image, 0, y, width, heights[index]); y += heights[index]; });
        detailOpenViewer([{screenNo:1, name:'拼图预览', candidates:[{url:canvas.toDataURL('image/jpeg', .92), name:'全部主图'}], selected:0}], 0, 0);
    } catch(error) { detailShowToast('拼图预览失败，可能有跨域图片', 'error'); }
}

function detailShowToast(message, type='info'){
    const toast = document.getElementById('detailToast');
    clearTimeout(detailToastTimer);
    toast.textContent = message;
    toast.className = `detail-toast visible ${type === 'error' ? 'error' : ''}`;
    detailToastTimer = setTimeout(() => { toast.className = 'detail-toast'; }, 3600);
}

function detailOpenAssets(){
    window.parent?.postMessage({type:'studio-navigate', page:'asset-manager'}, location.origin);
}

function detailBindViewer(){
    const stage = document.getElementById('previewStage');
    stage.addEventListener('wheel', event => { event.preventDefault(); detailViewerZoom(event.deltaY < 0 ? 1.14 : .88, event.clientX, event.clientY); }, {passive:false});
    stage.addEventListener('dblclick', detailViewerReset);
    stage.addEventListener('pointerdown', event => {
        const viewer = detailRuntime.viewer;
        try { stage.setPointerCapture(event.pointerId); } catch(_) {}
        viewer.pointers.set(event.pointerId, {x:event.clientX, y:event.clientY});
        if(viewer.pointers.size === 1){
            viewer.dragging = true; viewer.startX = event.clientX; viewer.startY = event.clientY; viewer.startOffsetX = viewer.x; viewer.startOffsetY = viewer.y; stage.classList.add('dragging');
        } else if(viewer.pointers.size === 2){
            const points = [...viewer.pointers.values()]; viewer.pinchDistance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        }
    });
    stage.addEventListener('pointermove', event => {
        const viewer = detailRuntime.viewer;
        if(!viewer.pointers.has(event.pointerId)) return;
        viewer.pointers.set(event.pointerId, {x:event.clientX, y:event.clientY});
        if(viewer.pointers.size === 2){
            const points = [...viewer.pointers.values()];
            const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
            if(viewer.pinchDistance) detailViewerZoom(distance / viewer.pinchDistance, (points[0].x + points[1].x) / 2, (points[0].y + points[1].y) / 2);
            viewer.pinchDistance = distance;
        } else if(viewer.dragging){
            viewer.x = viewer.startOffsetX + event.clientX - viewer.startX;
            viewer.y = viewer.startOffsetY + event.clientY - viewer.startY;
            detailViewerTransform();
        }
    });
    const release = event => {
        const viewer = detailRuntime.viewer;
        const point = viewer.pointers.get(event.pointerId);
        viewer.pointers.delete(event.pointerId);
        if(point && viewer.scale === 1 && Math.abs(point.x - viewer.startX) > 70) detailViewerStepScreen(point.x < viewer.startX ? 1 : -1);
        if(!viewer.pointers.size){ viewer.dragging = false; viewer.pinchDistance = 0; stage.classList.remove('dragging'); }
    };
    stage.addEventListener('pointerup', release); stage.addEventListener('pointercancel', release);
    document.getElementById('previewPrevScreen').addEventListener('click', () => detailViewerStepScreen(-1));
    document.getElementById('previewNextScreen').addEventListener('click', () => detailViewerStepScreen(1));
    document.getElementById('previewPrevCandidate').addEventListener('click', () => detailViewerStepCandidate(-1));
    document.getElementById('previewNextCandidate').addEventListener('click', () => detailViewerStepCandidate(1));
    document.getElementById('previewResetBtn').addEventListener('click', detailViewerReset);
    document.getElementById('previewDownloadBtn').addEventListener('click', detailViewerDownload);
    document.getElementById('previewCopyBtn').addEventListener('click', detailViewerCopy);
}

function detailBindControls(){
    document.getElementById('imageModelSelect').addEventListener('change', event => { detailState.imageChoice = event.target.value; detailSyncResolutionOptions(); detailRenderGenerateAction(); });
    document.getElementById('llmModelSelect').addEventListener('change', event => { detailState.llmChoice = event.target.value; detailRenderGenerateAction(); });
    document.querySelectorAll('[data-state]').forEach(control => control.addEventListener('change', () => {
        detailState[control.dataset.state] = control.value;
        if(control.dataset.state === 'resolution' || control.dataset.state === 'ratio') detailSyncSizeFields();
        if(control.dataset.state === 'modelSetting') detailSyncModelControls();
        if(['screenCount', 'modelUsage'].includes(control.dataset.state)) detailClampCountSettings();
        detailRenderGenerateAction();
    }));
    document.querySelectorAll('[data-state][type="text"], textarea[data-state]').forEach(control => control.addEventListener('input', () => { detailState[control.dataset.state] = control.value; detailRenderGenerateAction(); }));
    ['customRatioWidth','customRatioHeight','customSizeWidth','customSizeHeight'].forEach(key => document.getElementById(key).addEventListener('input', event => {
        detailState[key] = event.target.value;
        detailSyncSizeFields();
        detailRenderGenerateAction();
    }));
    document.getElementById('columnsSelect').addEventListener('change', event => document.getElementById('resultGrid').style.setProperty('--result-columns', event.target.value));
    document.getElementById('directionToggle').addEventListener('change', detailRenderTask);
    document.getElementById('savePresetBtn').addEventListener('click', detailSavePreset);
    document.getElementById('loadPresetBtn').addEventListener('click', detailLoadPreset);
    document.getElementById('analyzeBtn').addEventListener('click', detailHandleGenerateClick);
    document.getElementById('forceGenerateBtn').addEventListener('click', detailForceGenerate);
    document.getElementById('smartAnalyzeBtn').addEventListener('click', detailSmartAnalyze);
    document.getElementById('smartAnalysisClose').addEventListener('click', detailCloseSmartAnalysis);
    document.getElementById('smartAnalysisCancel').addEventListener('click', detailCloseSmartAnalysis);
    document.getElementById('smartAnalysisApply').addEventListener('click', detailApplySmartAnalysis);
    document.getElementById('smartAnalysisModal').addEventListener('click', event => { if(event.target.id === 'smartAnalysisModal') detailCloseSmartAnalysis(); });
    document.getElementById('cancelTaskBtn').addEventListener('click', detailCancelTask);
    document.getElementById('resumeTaskBtn').addEventListener('click', detailResumeTask);
    document.getElementById('deleteTaskBtn').addEventListener('click', detailDeleteTask);
    document.getElementById('deleteTaskCancelBtn').addEventListener('click', detailCancelDeleteTask);
    document.getElementById('deleteTaskConfirmBtn').addEventListener('click', detailConfirmDeleteTask);
    document.getElementById('deleteTaskDialog').addEventListener('cancel', () => { detailRuntime.deleteDialogTaskId = ''; });
    document.getElementById('deleteTaskDialog').addEventListener('close', () => { if(!detailRuntime.deletingTaskId) document.getElementById('deleteTaskBtn')?.focus(); });
    document.getElementById('collageBtn').addEventListener('click', detailCollage);
    document.getElementById('downloadAllBtn').addEventListener('click', detailDownloadAll);
    document.getElementById('requestPreviewBtn').addEventListener('click', () => { const panel = document.getElementById('requestPreview'); if(!panel.hidden) panel.open = !panel.open; });
    document.getElementById('historySelect').addEventListener('change', event => detailOpenHistoryTask(event.target.value));
    document.getElementById('renameTaskBtn').addEventListener('click', detailStartTaskRename);
    document.getElementById('taskTitleForm').addEventListener('submit', detailSaveTaskTitle);
    document.getElementById('cancelTaskTitleBtn').addEventListener('click', detailCancelTaskRename);
    document.querySelectorAll('[data-open-assets]').forEach(button => button.addEventListener('click', detailOpenAssets));
    document.getElementById('closePreviewBtn').addEventListener('click', detailClosePreview);
    document.getElementById('imagePreview').addEventListener('click', event => { if(event.target.id === 'imagePreview') detailClosePreview(); });
    document.getElementById('promptEditorText').addEventListener('input', event => {
        if(detailRuntime.promptEditorScreenNo) detailRuntime.promptDrafts.set(detailRuntime.promptEditorScreenNo, event.target.value);
    });
    document.getElementById('promptEditorClose').addEventListener('click', detailClosePromptEditor);
    document.getElementById('promptEditorModal').addEventListener('click', event => { if(event.target.id === 'promptEditorModal') detailClosePromptEditor(); });
    document.getElementById('promptEditorSave').addEventListener('click', () => detailSaveScreen(detailRuntime.promptEditorScreenNo));
    document.getElementById('promptEditorOptimize').addEventListener('click', () => detailOptimizeScreen(detailRuntime.promptEditorScreenNo, document.getElementById('promptEditorInstruction').value));
    document.getElementById('promptEditorCandidateSelect').addEventListener('change', event => detailApplyPromptCandidate(detailRuntime.promptEditorScreenNo, Number(event.target.value)));
    document.addEventListener('paste', event => {
        const files = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
        if(files.length) detailAddFiles('product', files);
    });
    document.addEventListener('keydown', event => {
        if(event.key === 'Escape' && detailRuntime.renamingTaskId){ detailCancelTaskRename(); return; }
        if(event.key === 'Escape' && !document.getElementById('smartAnalysisModal').hidden){ detailCloseSmartAnalysis(); return; }
        if(event.key === 'Escape' && !document.getElementById('promptEditorModal').hidden){ detailClosePromptEditor(); return; }
        if(document.getElementById('imagePreview').hidden) return;
        if(event.key === 'Escape') detailClosePreview();
        else if(event.key === 'ArrowLeft') detailViewerStepScreen(-1);
        else if(event.key === 'ArrowRight') detailViewerStepScreen(1);
        else if(event.key === 'ArrowUp') detailViewerStepCandidate(-1);
        else if(event.key === 'ArrowDown') detailViewerStepCandidate(1);
    });
    detailBindViewer();
}

function detailListenForConfigChanges(){
    window.addEventListener('message', event => {
        if(event.origin && event.origin !== location.origin) return;
        if(['providers-changed','workflows-changed'].includes(event.data?.type)) detailRefreshConfig();
        if(event.data?.type === 'main-images-changed') detailLoadHistory(detailRuntime.viewTaskId);
    });
    try {
        const channel = new BroadcastChannel('studio-api');
        channel.addEventListener('message', event => {
            if(['providers-changed','workflows-changed'].includes(event.data?.type)) detailRefreshConfig();
            if(event.data?.type === 'main-images-changed') detailLoadHistory(detailRuntime.viewTaskId);
        });
    } catch(_) {}
    document.addEventListener('visibilitychange', () => { if(!document.hidden) detailRefreshConfig(); });
}

function detailInit(){
    detailBindUpload('product');
    detailBindUpload('reference');
    detailBindControls();
    detailListenForConfigChanges();
    detailApplyStateToControls();
    detailRenderUploads();
    detailMarkDraftBaseline();
    detailRenderTask();
    detailRefreshConfig();
    detailLoadHistory();
    lucide.createIcons();
}

document.addEventListener('DOMContentLoaded', detailInit, {once:true});
