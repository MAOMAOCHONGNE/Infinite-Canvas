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

const DETAIL_PRESET_KEY = 'detail_page_preset_v1';
const DETAIL_MAX_IMAGES = 6;
const DETAIL_ACTIVE_STATUSES = new Set(['uploading', 'planning', 'repairing', 'generating', 'analyzing', 'compiling']);
const DETAIL_SCREEN_ACTIVE_STATUSES = new Set(['queued', 'generating']);
const DETAIL_TERMINAL_STATUSES = new Set(['succeeded', 'partial', 'failed', 'cancelled', 'interrupted']);
const detailState = {
    providers:[],
    imageChoice:'',
    llmChoice:'',
    ratio:'3:4',
    resolution:'2k',
    screenCount:'7',
    copywriting:'required',
    richness:'concise',
    fontStyle:'auto',
    outputLanguage:'自动识别',
    modelSetting:'use',
    modelPose:'normal',
    modelUsage:'4',
    reversalScreens:'2',
    productName:'',
    productFeatures:'',
    userInstruction:'',
    customRatioWidth:'3',
    customRatioHeight:'4',
    customSizeWidth:'1536',
    customSizeHeight:'2048',
    images:{product:[], reference:[]},
};
const detailRuntime = {
    taskId:'',
    task:null,
    pollTimer:null,
    abortController:null,
    isUploading:false,
    promptDrafts:new Map(),
    history:[],
    screenDragNo:0,
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
    return `<article class="upload-thumb" draggable="true" data-image-id="${detailEscapeHtml(image.id)}" data-image-kind="${kind}" data-image-index="${index}" title="${detailEscapeHtml(image.name)}">
        <img src="${detailEscapeHtml(image.url)}" alt="">
        <span class="thumb-index">图${displayIndex}</span>
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
    lucide.createIcons();
}

function detailRemoveImage(kind, id){
    const images = detailState.images[kind] || [];
    const index = images.findIndex(image => image.id === id);
    if(index < 0) return;
    const [removed] = images.splice(index, 1);
    if(removed?.url) URL.revokeObjectURL(removed.url);
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

function detailPresetData(){
    const keys = ['imageChoice','llmChoice','ratio','resolution','screenCount','copywriting','richness','fontStyle','outputLanguage','modelSetting','modelPose','modelUsage','reversalScreens','productName','productFeatures','userInstruction','customRatioWidth','customRatioHeight','customSizeWidth','customSizeHeight'];
    return Object.fromEntries(keys.map(key => [key, detailState[key]]));
}

function detailSavePreset(){
    localStorage.setItem(DETAIL_PRESET_KEY, JSON.stringify(detailPresetData()));
    detailShowToast('详情页预设已保存');
}

function detailLoadPreset(){
    try {
        const preset = JSON.parse(localStorage.getItem(DETAIL_PRESET_KEY) || 'null');
        if(!preset || typeof preset !== 'object') throw new Error('empty');
        Object.keys(detailPresetData()).forEach(key => { if(preset[key] !== undefined) detailState[key] = String(preset[key]); });
        detailApplyStateToControls();
        detailRenderModels();
        detailShowToast('详情页预设已加载');
    } catch(_) { detailShowToast('还没有保存的详情页预设', 'error'); }
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
    detailState.modelUsage = String(Math.max(1, Math.min(7, screenCount, Number(detailState.modelUsage) || 1)));
    detailState.reversalScreens = String(Math.max(0, Math.min(3, screenCount, Number(detailState.reversalScreens) || 0)));
    document.getElementById('modelUsage').value = detailState.modelUsage;
    document.getElementById('reversalScreens').value = detailState.reversalScreens;
}

function detailValidateDraft(){
    if(!detailState.images.product.length) return '请至少添加一张产品图';
    if(!detailDecodeChoice(detailState.imageChoice).model) return '请先配置图片模型';
    if(!detailDecodeChoice(detailState.llmChoice).model) return '请先配置视觉 LLM 模型';
    if(Number(detailState.reversalScreens) > Number(detailState.screenCount)) return '插入反转屏不能超过生成数量';
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

function detailTaskPayload(uploaded){
    const image = detailDecodeChoice(detailState.imageChoice);
    const llm = detailDecodeChoice(detailState.llmChoice);
    return {
        page_type:'detail',
        product_images:[...(uploaded?.product || [])],
        reference_images:[...(uploaded?.reference || [])],
        image_provider_id:image.providerId,
        image_model:image.model,
        llm_provider_id:llm.providerId,
        llm_model:llm.model,
        aspect_ratio:detailEffectiveRatio(),
        resolution:detailState.resolution,
        size:detailEffectiveSize(),
        quality:'auto',
        screen_count:Number(detailState.screenCount),
        copywriting:detailState.copywriting,
        richness:detailState.richness,
        font_style:detailState.fontStyle,
        output_language:detailState.outputLanguage.trim() || '自动识别',
        model_setting:detailState.modelSetting,
        model_pose:detailState.modelPose,
        model_usage:Number(detailState.modelUsage),
        reversal_screens:Number(detailState.reversalScreens),
        product_name:detailState.productName.trim(),
        product_features:detailState.productFeatures.trim(),
        user_instruction:detailState.userInstruction.trim(),
    };
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
    if(!response.ok) throw new Error(detailErrorMessage(data, `HTTP ${response.status}`));
    return data;
}

async function detailUploadTaskImages(signal){
    const product = detailState.images.product;
    const reference = detailState.images.reference;
    const ordered = [...product, ...reference];
    const form = new FormData();
    ordered.forEach(image => form.append('files', image.file, image.name || image.file?.name || 'image.png'));
    const data = await detailFetchJson('/api/ai/upload', {method:'POST', body:form, signal});
    const files = Array.isArray(data?.files) ? data.files : [];
    if(files.length !== ordered.length) throw new Error(`图片上传不完整：需要 ${ordered.length} 张，实际 ${files.length} 张`);
    const urls = files.map(item => String(item?.url || '').trim());
    if(urls.some(url => !url)) throw new Error('图片上传结果缺少地址');
    return {
        product:urls.slice(0, product.length),
        reference:urls.slice(product.length),
    };
}

function detailTaskIsActive(task=detailRuntime.task){
    return detailRuntime.isUploading || DETAIL_ACTIVE_STATUSES.has(String(task?.status || ''));
}

function detailScreenRegenerationLocked(screen, task=detailRuntime.task){
    const taskStatus = String(task?.status || '');
    const taskBlocksScreens = detailRuntime.isUploading || (DETAIL_ACTIVE_STATUSES.has(taskStatus) && taskStatus !== 'generating');
    return taskBlocksScreens || DETAIL_SCREEN_ACTIVE_STATUSES.has(String(screen?.status || ''));
}

function detailTaskStatusLabel(status){
    return ({
        uploading:'上传图片', planning:'规划提示词', analyzing:'兼容分析', repairing:'修复结果', compiling:'兼容编译', generating:'并发生成',
        succeeded:'全部完成', partial:'部分完成', failed:'任务失败', cancelled:'已取消', interrupted:'已中断',
    })[status] || '待规划';
}

function detailScreenStatusLabel(status){
    return ({queued:'排队', generating:'生成中', succeeded:'已完成', failed:'生成失败', cancelled:'已取消', interrupted:'已中断'})[status] || '等待';
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
    const prompt = detailPromptValue(screen, locked);
    const candidates = detailScreenCandidates(screen);
    const selectedCandidate = detailSelectedCandidateIndex(screen);
    const flags = [
        screen.use_model ? `<span class="screen-flag model">${screen.pose_mode === 'specific' ? '特定姿态' : '模特'}</span>` : '',
        screen.is_reversal ? '<span class="screen-flag reversal">反转屏</span>' : '',
    ].join('');
    const preview = imageUrl
        ? `<button class="screen-image" type="button" data-preview-screen="${screen.screen_no}"><img src="${detailEscapeHtml(imageUrl)}" alt="第 ${screen.screen_no} 屏生成结果" loading="lazy"></button>`
        : `<div class="screen-placeholder ${screen.status === 'generating' ? 'is-generating' : ''}"><i data-lucide="${screen.status === 'generating' ? 'loader-circle' : 'image'}"></i><span>${detailEscapeHtml(detailScreenStatusLabel(screen.status))}</span></div>`;
    const candidateStrip = candidates.length ? `<div class="candidate-strip"><span>${candidates.length} 个候选</span>${candidates.map((candidate, index) => `<button type="button" data-select-candidate="${index}" data-screen="${screen.screen_no}" class="${index === selectedCandidate ? 'active' : ''}" ${candidate.status !== 'succeeded' || locked ? 'disabled' : ''} title="${candidate.status === 'succeeded' ? `选择候选 ${index + 1}` : detailEscapeHtml(candidate.error || '候选失败')}">${index + 1}</button>`).join('')}</div>` : '';
    const promptCandidates = Array.isArray(screen.prompt_candidates) ? screen.prompt_candidates : [];
    const promptChoices = promptCandidates.length ? `<select class="prompt-candidates" data-prompt-candidate="${screen.screen_no}" ${locked ? 'disabled' : ''}><option value="">优化候选</option>${promptCandidates.map((item, index) => `<option value="${index}">候选 ${index + 1}</option>`).join('')}</select>` : '';
    const error = screen.error ? `<p class="screen-error">${detailEscapeHtml(screen.error)}</p>` : '';
    const regenerationLocked = detailScreenRegenerationLocked(screen);
    return `<article class="result-card" data-screen-no="${screen.screen_no}" draggable="${locked ? 'false' : 'true'}">
        <header class="screen-card-head"><div><span class="screen-number">第 ${screen.screen_no} 屏 · ${detailEscapeHtml(screen.screen_type || '详情页')}</span><strong>${detailEscapeHtml(screen.title)}</strong></div><span class="screen-state ${detailEscapeHtml(screen.status)}">${detailEscapeHtml(detailScreenStatusLabel(screen.status))}</span></header>
        <div class="screen-flags">${flags}</div>
        ${preview}
        ${candidateStrip}
        <p class="screen-purpose">${detailEscapeHtml(screen.purpose)}</p>
        ${error}
        <label class="screen-prompt"><span>生图提示词</span><textarea data-screen-prompt="${screen.screen_no}" rows="7" ${locked ? 'readonly' : ''}>${detailEscapeHtml(prompt)}</textarea></label>
        <footer class="screen-card-actions">${promptChoices}<button type="button" data-save-screen="${screen.screen_no}" ${locked ? 'disabled' : ''} title="保存提示词"><i data-lucide="save"></i></button><button type="button" data-optimize-screen="${screen.screen_no}" ${locked ? 'disabled' : ''}><i data-lucide="sparkles"></i><span>优化</span></button><button type="button" data-screen-params="${screen.screen_no}" ${locked ? 'disabled' : ''} title="单屏参数"><i data-lucide="sliders-horizontal"></i></button><button type="button" data-regenerate-screen="${screen.screen_no}" data-count="1" ${regenerationLocked ? 'disabled' : ''}><i data-lucide="refresh-cw"></i><span>重刷</span></button><button type="button" data-regenerate-screen="${screen.screen_no}" data-count="4" ${regenerationLocked ? 'disabled' : ''}><span>×4</span></button><button type="button" data-delete-screen="${screen.screen_no}" ${locked ? 'disabled' : ''} title="删除分屏"><i data-lucide="trash-2"></i></button></footer>
    </article>`;
}

function detailRenderTask(){
    const task = detailRuntime.task;
    const status = detailRuntime.isUploading ? 'uploading' : String(task?.status || '');
    const active = detailTaskIsActive(task);
    const screens = Array.isArray(task?.screens) ? [...task.screens] : [];
    const sorted = document.getElementById('directionToggle')?.checked ? screens.reverse() : screens;
    const completed = screens.filter(screen => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(screen.status)).length;
    document.getElementById('resultCount').textContent = screens.length ? `${completed}/${screens.length} 屏` : '0 屏';
    const resultStatus = document.getElementById('resultStatus');
    resultStatus.textContent = detailTaskStatusLabel(status);
    resultStatus.dataset.status = status;
    const llmTrace = document.getElementById('llmTrace');
    const llmTraceText = detailLlmTraceLabel(task);
    llmTrace.textContent = llmTraceText;
    llmTrace.hidden = !llmTraceText;
    const cancelButton = document.getElementById('cancelTaskBtn');
    cancelButton.hidden = !active;
    const resumable = screens.some(screen => ['failed', 'cancelled', 'interrupted', 'queued'].includes(screen.status));
    document.getElementById('resumeTaskBtn').hidden = active || !resumable;
    document.getElementById('deleteTaskBtn').disabled = !task || active;
    const hasImages = screens.some(screen => detailResultImage(screen));
    document.getElementById('collageBtn').disabled = !hasImages;
    document.getElementById('downloadAllBtn').disabled = !hasImages;
    const preview = task?.request_preview;
    const requestPreview = document.getElementById('requestPreview');
    document.getElementById('requestPreviewBtn').disabled = !preview;
    requestPreview.hidden = !preview;
    document.getElementById('requestPreviewText').textContent = preview ? [
        preview.managed_instruction,
        preview.settings_line,
        preview.user_instruction,
        `图片职责：\n${(preview.image_roles || []).join('\n')}`,
        `本地后处理：\n${JSON.stringify(preview.local_postprocess || {}, null, 2)}`,
        `图片 API 参数：\n${JSON.stringify(preview.image_request || task?.settings || {}, null, 2)}`,
        `最终规划请求：\n${preview.request}`,
    ].join('\n\n') : '';
    const analyzeButton = document.getElementById('analyzeBtn');
    analyzeButton.disabled = active;
    analyzeButton.querySelector('span').textContent = active ? detailTaskStatusLabel(status) : '开始生成';
    detailSetConfigState(active ? detailTaskStatusLabel(status) : task ? detailTaskStatusLabel(status) : '配置就绪', status === 'failed');

    if(!screens.length){
        if(status === 'uploading') detailRenderEmptyResults('正在上传图片', '上传完成后自动开始视觉分析', true);
        else if(['planning', 'analyzing', 'repairing', 'compiling'].includes(status)) {
            const title = status === 'repairing' ? '正在修复规划结果' : '正在一次性规划完整提示词';
            const message = '规划完成后会直接显示全部分屏并并发生图';
            detailRenderEmptyResults(title, message, true);
        }
        else if(status === 'failed') detailRenderEmptyResults('详情页任务失败', task?.error || '请检查视觉 LLM 配置后重试');
        else if(status === 'cancelled') detailRenderEmptyResults('任务已取消', '可以调整设置后重新开始');
        else detailRenderEmptyResults('暂无分屏任务', '配置完成后开始生成');
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
        document.querySelectorAll('[data-screen-prompt]').forEach(textarea => textarea.addEventListener('input', () => {
            detailRuntime.promptDrafts.set(Number(textarea.dataset.screenPrompt), textarea.value);
        }));
        document.querySelectorAll('[data-regenerate-screen]').forEach(button => button.addEventListener('click', () => {
            detailRegenerateScreen(Number(button.dataset.regenerateScreen), Number(button.dataset.count) || 1);
        }));
        document.querySelectorAll('[data-save-screen]').forEach(button => button.addEventListener('click', () => detailSaveScreen(Number(button.dataset.saveScreen))));
        document.querySelectorAll('[data-optimize-screen]').forEach(button => button.addEventListener('click', () => detailOptimizeScreen(Number(button.dataset.optimizeScreen))));
        document.querySelectorAll('[data-screen-params]').forEach(button => button.addEventListener('click', () => detailEditScreenParams(Number(button.dataset.screenParams))));
        document.querySelectorAll('[data-delete-screen]').forEach(button => button.addEventListener('click', () => detailDeleteScreen(Number(button.dataset.deleteScreen))));
        document.querySelectorAll('[data-select-candidate]').forEach(button => button.addEventListener('click', () => detailSelectCandidate(Number(button.dataset.screen), Number(button.dataset.selectCandidate))));
        document.querySelectorAll('[data-prompt-candidate]').forEach(select => select.addEventListener('change', () => detailApplyPromptCandidate(Number(select.dataset.promptCandidate), Number(select.value))));
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
            screenNo:Number(screen.screen_no), name:`第 ${screen.screen_no} 屏`, candidates,
            selected:Math.max(0, candidates.findIndex(candidate => candidate.originalIndex === selectedOriginal)),
        };
    }).filter(item => item.candidates.length);
    const index = Math.max(0, items.findIndex(item => item.screenNo === Number(screenNo)));
    detailOpenViewer(items, index, Math.max(0, items[index]?.selected || 0));
}

function detailStopPolling(){
    clearTimeout(detailRuntime.pollTimer);
    detailRuntime.pollTimer = null;
}

async function detailPollTask(immediate=false){
    detailStopPolling();
    const poll = async () => {
        if(!detailRuntime.taskId) return;
        try {
            const wasActive = detailTaskIsActive(detailRuntime.task);
            const task = await detailFetchJson(`/api/detail-page-tasks/${encodeURIComponent(detailRuntime.taskId)}`);
            detailRuntime.task = task;
            detailRenderTask();
            if(detailTaskIsActive(task)) detailRuntime.pollTimer = setTimeout(poll, 900);
            else if(wasActive) detailLoadHistory(task.id);
        } catch(error) {
            detailRuntime.task = {...(detailRuntime.task || {}), status:'failed', error:error.message};
            detailRenderTask();
            detailShowToast(error.message, 'error');
        }
    };
    if(immediate) await poll();
    else detailRuntime.pollTimer = setTimeout(poll, 300);
}

async function detailAnalyzeDraft(){
    const error = detailValidateDraft();
    if(error){ detailShowToast(error, 'error'); return; }
    if(detailTaskIsActive()) return;
    detailSavePreset();
    detailStopPolling();
    detailRuntime.promptDrafts.clear();
    detailRuntime.taskId = '';
    detailRuntime.task = {status:'uploading', screens:[]};
    detailRuntime.isUploading = true;
    detailRuntime.abortController = new AbortController();
    detailRenderTask();
    try {
        const uploaded = await detailUploadTaskImages(detailRuntime.abortController.signal);
        detailSetConfigState('提交规划');
        const created = await detailFetchJson('/api/detail-page-tasks', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify(detailTaskPayload(uploaded)),
            signal:detailRuntime.abortController.signal,
        });
        detailRuntime.taskId = String(created?.task_id || '');
        if(!detailRuntime.taskId) throw new Error('详情页任务没有返回任务 ID');
        detailRuntime.isUploading = false;
        detailRuntime.abortController = null;
        detailRuntime.task = {status:'planning', screens:[]};
        detailRenderTask();
        await detailPollTask(true);
    } catch(error) {
        detailRuntime.isUploading = false;
        detailRuntime.abortController = null;
        if(error?.name === 'AbortError'){
            detailRuntime.task = {status:'cancelled', screens:[]};
            detailShowToast('任务已取消');
        } else {
            detailRuntime.task = {status:'failed', screens:[], error:error.message || '任务提交失败'};
            detailShowToast(error.message || '任务提交失败', 'error');
        }
        detailRenderTask();
    }
}

async function detailCancelTask(){
    if(detailRuntime.isUploading){
        detailRuntime.abortController?.abort();
        return;
    }
    if(!detailRuntime.taskId || !detailTaskIsActive()) return;
    try {
        const task = await detailFetchJson(`/api/detail-page-tasks/${encodeURIComponent(detailRuntime.taskId)}/cancel`, {method:'POST'});
        detailRuntime.task = task;
        detailStopPolling();
        detailRenderTask();
        detailShowToast('详情页任务已取消');
    } catch(error) {
        detailShowToast(error.message || '取消失败', 'error');
    }
}

async function detailSaveScreen(screenNo){
    if(!detailRuntime.taskId || detailTaskIsActive()) return;
    const screen = (detailRuntime.task?.screens || []).find(item => Number(item.screen_no) === Number(screenNo));
    if(!screen) return;
    const prompt = String(detailRuntime.promptDrafts.get(screenNo) ?? screen.prompt ?? '').trim();
    if(!prompt){ detailShowToast('提示词不能为空', 'error'); return; }
    try {
        detailRuntime.task = await detailFetchJson(`/api/detail-page-tasks/${encodeURIComponent(detailRuntime.taskId)}/screens/${screenNo}`, {
            method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({prompt}),
        });
        detailRuntime.promptDrafts.set(screenNo, prompt);
        detailRenderTask();
        detailShowToast(`第 ${screenNo} 屏提示词已保存`);
    } catch(error) { detailShowToast(error.message || '保存失败', 'error'); }
}

async function detailOptimizeScreen(screenNo){
    if(!detailRuntime.taskId || detailTaskIsActive()) return;
    const instruction = window.prompt('输入本屏提示词修改要求');
    if(!instruction?.trim()) return;
    const screen = (detailRuntime.task?.screens || []).find(item => Number(item.screen_no) === Number(screenNo));
    const prompt = String(detailRuntime.promptDrafts.get(screenNo) ?? screen?.prompt ?? '').trim();
    try {
        const result = await detailFetchJson(`/api/detail-page-tasks/${encodeURIComponent(detailRuntime.taskId)}/screens/${screenNo}/optimize-prompt`, {
            method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({instruction:instruction.trim(), prompt, candidate_count:2}),
        });
        screen.prompt_candidates = result.prompt_candidates || [];
        detailRenderTask();
        detailShowToast('已生成提示词候选');
    } catch(error) { detailShowToast(error.message || '优化失败', 'error'); }
}

function detailApplyPromptCandidate(screenNo, candidateIndex){
    if(!Number.isInteger(candidateIndex) || candidateIndex < 0) return;
    const screen = (detailRuntime.task?.screens || []).find(item => Number(item.screen_no) === Number(screenNo));
    const prompt = screen?.prompt_candidates?.[candidateIndex]?.prompt;
    if(!prompt) return;
    detailRuntime.promptDrafts.set(screenNo, prompt);
    const textarea = document.querySelector(`[data-screen-prompt="${screenNo}"]`);
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
        detailRuntime.task = await detailFetchJson(`/api/detail-page-tasks/${encodeURIComponent(detailRuntime.taskId)}/screens/${screenNo}`, {
            method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({generation_params:{image_model:imageModel, aspect_ratio:aspectRatio, resolution, size, quality:current.quality || base.quality || 'auto'}}),
        });
        detailRenderTask();
        detailShowToast(`第 ${screenNo} 屏参数已保存`);
    } catch(error) { detailShowToast(error.message || '参数保存失败', 'error'); }
}

async function detailSelectCandidate(screenNo, candidateIndex){
    try {
        detailRuntime.task = await detailFetchJson(`/api/detail-page-tasks/${encodeURIComponent(detailRuntime.taskId)}/screens/${screenNo}`, {
            method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({selected_candidate:candidateIndex}),
        });
        detailRenderTask();
    } catch(error) { detailShowToast(error.message || '候选切换失败', 'error'); }
}

async function detailRegenerateScreen(screenNo, count=1){
    if(!detailRuntime.taskId) return;
    const screen = (detailRuntime.task?.screens || []).find(item => Number(item.screen_no) === Number(screenNo));
    if(!screen || detailScreenRegenerationLocked(screen)) return;
    const prompt = String(detailRuntime.promptDrafts.get(screenNo) ?? screen.prompt ?? '').trim();
    if(!prompt){ detailShowToast('提示词不能为空', 'error'); return; }
    try {
        const task = await detailFetchJson(`/api/detail-page-tasks/${encodeURIComponent(detailRuntime.taskId)}/screens/${screenNo}/regenerate`, {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({prompt, count, generation_params:screen.generation_params || {}}),
        });
        detailRuntime.task = task;
        detailRuntime.promptDrafts.set(screenNo, prompt);
        detailRenderTask();
        detailPollTask();
        detailShowToast(count === 4 ? '已并发提交 4 个候选' : '已提交重新生成');
    } catch(error) {
        detailShowToast(error.message || '重新生成失败', 'error');
    }
}

async function detailDeleteScreen(screenNo){
    if(!window.confirm(`删除第 ${screenNo} 屏及其候选结果？`)) return;
    try {
        detailRuntime.task = await detailFetchJson(`/api/detail-page-tasks/${encodeURIComponent(detailRuntime.taskId)}/screens/${screenNo}`, {method:'DELETE'});
        detailRuntime.promptDrafts.delete(screenNo);
        detailRenderTask();
    } catch(error) { detailShowToast(error.message || '删除分屏失败', 'error'); }
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
        detailRuntime.task = await detailFetchJson(`/api/detail-page-tasks/${encodeURIComponent(detailRuntime.taskId)}/screens/reorder`, {
            method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({screen_order:order}),
        });
        detailRenderTask();
    } catch(error) { detailShowToast(error.message || '顺序保存失败', 'error'); }
}

function detailHistoryLabel(task, index){
    const date = new Date((Number(task.updated_at) || 0) * 1000);
    const time = Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'}) : '';
    return `分组 #${detailRuntime.history.length - index} · ${time} · ${detailTaskStatusLabel(task.status)}`;
}

function detailRenderHistory(){
    const select = document.getElementById('historySelect');
    select.innerHTML = detailRuntime.history.length ? detailRuntime.history.map((task, index) => `<option value="${detailEscapeHtml(task.id)}">${detailEscapeHtml(detailHistoryLabel(task, index))}</option>`).join('') : '<option value="">当前分组</option>';
    select.value = detailRuntime.taskId || '';
}

async function detailLoadHistory(preferredId=''){
    try {
        const data = await detailFetchJson('/api/detail-page-tasks');
        detailRuntime.history = Array.isArray(data.tasks) ? data.tasks : [];
        detailRenderHistory();
        const targetId = preferredId || detailRuntime.taskId || detailRuntime.history[0]?.id;
        if(targetId && targetId !== detailRuntime.taskId) await detailOpenHistoryTask(targetId);
    } catch(error) { detailShowToast(error.message || '历史加载失败', 'error'); }
}

async function detailOpenHistoryTask(taskId){
    if(!taskId) return;
    detailStopPolling();
    try {
        detailRuntime.task = await detailFetchJson(`/api/detail-page-tasks/${encodeURIComponent(taskId)}`);
        detailRuntime.taskId = taskId;
        detailRuntime.promptDrafts.clear();
        detailRenderHistory();
        detailRenderTask();
        if(detailTaskIsActive()) detailPollTask();
    } catch(error) { detailShowToast(error.message || '分组加载失败', 'error'); }
}

async function detailResumeTask(){
    if(!detailRuntime.taskId || detailTaskIsActive()) return;
    try {
        detailRuntime.task = await detailFetchJson(`/api/detail-page-tasks/${encodeURIComponent(detailRuntime.taskId)}/resume`, {method:'POST'});
        detailRenderTask(); detailPollTask();
    } catch(error) { detailShowToast(error.message || '恢复失败', 'error'); }
}

async function detailDeleteTask(){
    if(!detailRuntime.taskId || detailTaskIsActive() || !window.confirm('删除当前详情页分组？')) return;
    try {
        await detailFetchJson(`/api/detail-page-tasks/${encodeURIComponent(detailRuntime.taskId)}`, {method:'DELETE'});
        detailRuntime.taskId = ''; detailRuntime.task = null; detailRuntime.promptDrafts.clear();
        detailRenderTask(); await detailLoadHistory();
    } catch(error) { detailShowToast(error.message || '删除分组失败', 'error'); }
}

function detailDownloadAll(){
    if(!detailRuntime.taskId) return;
    const link = document.createElement('a');
    link.href = `/api/detail-page-tasks/${encodeURIComponent(detailRuntime.taskId)}/download.zip`;
    link.download = 'detail-page.zip'; link.click();
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
        detailOpenViewer([{screenNo:1, name:'拼图预览', candidates:[{url:canvas.toDataURL('image/jpeg', .92), name:'全部分屏'}], selected:0}], 0, 0);
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
    document.getElementById('imageModelSelect').addEventListener('change', event => { detailState.imageChoice = event.target.value; detailSyncResolutionOptions(); });
    document.getElementById('llmModelSelect').addEventListener('change', event => { detailState.llmChoice = event.target.value; });
    document.querySelectorAll('[data-state]').forEach(control => control.addEventListener('change', () => {
        detailState[control.dataset.state] = control.value;
        if(control.dataset.state === 'resolution' || control.dataset.state === 'ratio') detailSyncSizeFields();
        if(control.dataset.state === 'modelSetting') detailSyncModelControls();
        if(['screenCount', 'modelUsage', 'reversalScreens'].includes(control.dataset.state)) detailClampCountSettings();
    }));
    document.querySelectorAll('[data-state][type="text"], textarea[data-state]').forEach(control => control.addEventListener('input', () => { detailState[control.dataset.state] = control.value; }));
    ['customRatioWidth','customRatioHeight','customSizeWidth','customSizeHeight'].forEach(key => document.getElementById(key).addEventListener('input', event => {
        detailState[key] = event.target.value;
        detailSyncSizeFields();
    }));
    document.getElementById('columnsSelect').addEventListener('change', event => document.getElementById('resultGrid').style.setProperty('--result-columns', event.target.value));
    document.getElementById('directionToggle').addEventListener('change', detailRenderTask);
    document.getElementById('savePresetBtn').addEventListener('click', detailSavePreset);
    document.getElementById('loadPresetBtn').addEventListener('click', detailLoadPreset);
    document.getElementById('analyzeBtn').addEventListener('click', detailAnalyzeDraft);
    document.getElementById('cancelTaskBtn').addEventListener('click', detailCancelTask);
    document.getElementById('resumeTaskBtn').addEventListener('click', detailResumeTask);
    document.getElementById('deleteTaskBtn').addEventListener('click', detailDeleteTask);
    document.getElementById('collageBtn').addEventListener('click', detailCollage);
    document.getElementById('downloadAllBtn').addEventListener('click', detailDownloadAll);
    document.getElementById('requestPreviewBtn').addEventListener('click', () => { const panel = document.getElementById('requestPreview'); if(!panel.hidden) panel.open = !panel.open; });
    document.getElementById('historySelect').addEventListener('change', event => detailOpenHistoryTask(event.target.value));
    document.querySelectorAll('[data-open-assets]').forEach(button => button.addEventListener('click', detailOpenAssets));
    document.getElementById('closePreviewBtn').addEventListener('click', detailClosePreview);
    document.getElementById('imagePreview').addEventListener('click', event => { if(event.target.id === 'imagePreview') detailClosePreview(); });
    document.addEventListener('paste', event => {
        const files = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
        if(files.length) detailAddFiles('product', files);
    });
    document.addEventListener('keydown', event => {
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
    });
    try {
        const channel = new BroadcastChannel('studio-api');
        channel.addEventListener('message', event => {
            if(['providers-changed','workflows-changed'].includes(event.data?.type)) detailRefreshConfig();
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
    detailRenderTask();
    detailRefreshConfig();
    detailLoadHistory();
    lucide.createIcons();
}

document.addEventListener('DOMContentLoaded', detailInit, {once:true});
