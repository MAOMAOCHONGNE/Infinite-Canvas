(function(){
    'use strict';

    const PREFERENCE_KEY = 'imageGenerationPreferences:v1';
    const LOCAL_DRAFT_KEY = 'imageGenerationPendingDrafts:v1';
    const ADMIN_SESSION_KEY = 'imageGenerationAdminToken:v1';
    const USER_PROMPT_EDITOR_FONT_KEY = 'imageGenerationUserPromptEditorFont:v1';
    const USER_PROMPT_MAX_LENGTH = 20000;
    const USER_PROMPT_EDITOR_FONTS = [
        {id:'small', className:'font-small'},
        {id:'medium', className:'font-medium'},
        {id:'large', className:'font-large'},
        {id:'xlarge', className:'font-xlarge'},
    ];
    const CASE_PREVIEW_MIN_SCALE = .05;
    const CASE_PREVIEW_MAX_SCALE = 8;
    const CASE_PREVIEW_ZOOM_STEP = 1.12;
    const MAX_RECENTS = 8;
    // 700px is only a safety ceiling. Actual card dimensions stay fluid and are
    // calculated from the current result area, viewport and row item count.
    const RESULT_MEDIA_MAX_SIZE = 700;
    const RESULT_GALLERY_VERTICAL_RESERVE = 210;
    const RESULT_GALLERY_GAP = 12;
    const RESULT_GALLERY_MAX_ITEMS_PER_ROW = 3;
    const ACTIVE_TASK_STATUSES = new Set(['queued','submitting','generating','recovering']);
    const FIXED_IMAGE_RATIOS = Object.freeze(['1:1','1:4','1:8','2:3','3:2','3:4','4:1','4:3','4:5','5:4','8:1','9:16','16:9','21:9','9:21']);
    const RATIO_MODES = new Set(['fixed','source','adaptive','custom']);
    const DEFAULT_SETTINGS = {
        image_provider_id:'', image_model:'', ratio_mode:'fixed', aspect_ratio:'1:1', custom_ratio_width:'', custom_ratio_height:'', resolution:'2k', size:'2048x2048', image_count:1,
    };

    const runtime = {
        modes:[], config:{api_providers:[]}, currentMode:null, inputs:[], userPrompt:'', settings:{...DEFAULT_SETTINGS},
        tasks:[], viewedTask:null, readOnlyHistory:false, search:'', category:'全部', uploadSlotKey:'', draggedSlotKey:'',
        dirty:false, saving:false, submitLocked:false, leavingWorkbench:false, submissionIds:new Map(), preferences:loadPreferences(), pendingDrafts:loadLocalDrafts(), toastTimer:null, readyPulseTimer:null,
        taskCache:new Map(), activeTaskIds:new Set(), completionNoticeTaskIds:new Set(), deletedTaskIds:new Set(), allTasks:[], pollTimer:null, pollInFlight:false, elapsedTimer:null,
        candidateActionLocks:new Set(), regenerationSubmissions:new Map(), modeNavigationVersion:0, taskNavigationVersion:0,
        selectedResultKeys:new Set(), resultBatchDeleting:false, previewItems:[], previewIndex:-1,
        resultGalleryResizeObserver:null, resultGalleryResizeScheduled:false,
        casePreview:{scale:1, fitScale:1, initialized:false, panX:0, panY:0, dragging:false, startX:0, startY:0, originX:0, originY:0, pointerId:null},
        cleanup:{confirmationId:'', retention:'', cutoffAt:''}, terminalCleanup:{taskIds:[], failedCount:0, deletedCount:0, running:false}, cleanupJobs:new Map(),
        admin:{active:false, token:loadAdminToken(), modes:[], currentMode:null, exampleTarget:null, nextModeNo:0},
    };
    const imagePromptLibraryState = {
        libraries:[], templates:[], loaded:false, loading:null, activeLibraryId:'', query:'', category:'all', selectedId:'', lastCardId:'', lastCardAt:0, lastFocus:null,
    };

    function byId(id){ return document.getElementById(id); }
    function escapeHtml(value){
        return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    }
    function normalizeSearch(value){ return String(value || '').toLocaleLowerCase().replace(/\s+/g,''); }
    function uniqueStrings(values){ return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))]; }
    function ratioParts(value){
        const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
        if(!match) return null;
        const width = Number(match[1]);
        const height = Number(match[2]);
        return width > 0 && height > 0 ? {width, height} : null;
    }
    function greatestCommonDivisor(a, b){
        a = Math.abs(Math.round(Number(a) || 0));
        b = Math.abs(Math.round(Number(b) || 0));
        while(b){ const next = b; b = a % b; a = next; }
        return a || 1;
    }
    function normalizedIntegerRatio(width, height){
        width = Number(width); height = Number(height);
        if(!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 999 || height > 999) return '';
        const divisor = greatestCommonDivisor(width, height);
        return `${width / divisor}:${height / divisor}`;
    }
    function normalizeGenerationRatioSettings(settings={}){
        const suppliedMode = String(settings.ratio_mode || '').trim();
        const ratioMode = RATIO_MODES.has(suppliedMode) ? suppliedMode : 'fixed';
        let aspectRatio = String(settings.aspect_ratio ?? '').trim();
        if(ratioMode === 'fixed' && !ratioParts(aspectRatio)) aspectRatio = '1:1';
        if(ratioMode === 'adaptive') aspectRatio = '';
        let customWidth = String(settings.custom_ratio_width ?? '').trim();
        let customHeight = String(settings.custom_ratio_height ?? '').trim();
        if(ratioMode === 'custom' && (!customWidth || !customHeight)){
            const savedCustom = ratioParts(aspectRatio);
            if(savedCustom){ customWidth ||= String(savedCustom.width); customHeight ||= String(savedCustom.height); }
        }
        return {ratio_mode:ratioMode, aspect_ratio:aspectRatio, custom_ratio_width:customWidth, custom_ratio_height:customHeight};
    }
    function normalizeRuntimeSettings(settings={}){
        return {...DEFAULT_SETTINGS, ...settings, ...normalizeGenerationRatioSettings(settings)};
    }
    function firstInputDimensions(inputs=[]){
        for(const item of inputs || []){
            const media = item?.media || item;
            if(!media || !(media.id || media.url || media.image_url)) continue;
            const width = Number(media.width);
            const height = Number(media.height);
            if(width > 0 && height > 0) return {width, height};
        }
        return null;
    }
    function closestFixedRatio(width, height){
        const shared = globalThis.AdaptiveImageRatio?.closestSupportedRatio?.(width, height, FIXED_IMAGE_RATIOS);
        if(shared) return shared;
        let best = '1:1';
        let bestScore = Infinity;
        for(const candidate of FIXED_IMAGE_RATIOS){
            const parts = ratioParts(candidate);
            const score = Math.abs(Number(width) - Number(height) * parts.width / parts.height);
            if(score < bestScore - 1e-9){ best = candidate; bestScore = score; }
        }
        return best;
    }
    function sizeForRatio(ratio, resolution='2k'){
        const shared = globalThis.AdaptiveImageRatio?.pixelSizeForRatio?.(ratio, resolution);
        if(shared) return shared;
        const parts = ratioParts(ratio);
        if(!parts) return '';
        const key = ['1k','2k','4k'].includes(String(resolution || '').toLowerCase()) ? String(resolution).toLowerCase() : '2k';
        const longSide = { '1k':1536, '2k':2048, '4k':3840 }[key];
        const pixelLimit = { '1k':1572864, '2k':4194304, '4k':8294400 }[key];
        const scale = Math.min(longSide / Math.max(parts.width, parts.height), Math.sqrt(pixelLimit / (parts.width * parts.height)));
        const snappedScale = Math.max(16, Math.floor(scale / 16) * 16);
        return `${Math.round(parts.width * snappedScale)}x${Math.round(parts.height * snappedScale)}`;
    }
    function resolveGenerationRatio(settings={}, inputs=[]){
        const normalized = normalizeGenerationRatioSettings(settings);
        const result = {valid:true, error:'', ratio_mode:normalized.ratio_mode, aspect_ratio:'', display_label:'', size:'', stretch_aspect_ratio:''};
        if(normalized.ratio_mode === 'adaptive'){
            result.display_label = '自适应';
            result.size = 'auto';
            return result;
        }
        if(normalized.ratio_mode === 'source'){
            const dimensions = firstInputDimensions(inputs);
            if(!dimensions){
                result.valid = false;
                result.error = '拉伸适配需要一张已读取尺寸的输入图片';
                result.display_label = '等待输入图片';
                return result;
            }
            result.aspect_ratio = closestFixedRatio(dimensions.width, dimensions.height);
            result.stretch_aspect_ratio = result.aspect_ratio;
            result.display_label = `拉伸适配 → ${result.aspect_ratio}`;
        } else if(normalized.ratio_mode === 'custom'){
            result.aspect_ratio = normalizedIntegerRatio(normalized.custom_ratio_width, normalized.custom_ratio_height);
            if(!result.aspect_ratio){
                result.valid = false;
                result.error = '自定义比例的宽和高必须是 1–999 的正整数';
                result.display_label = '请输入有效的自定义比例';
                return result;
            }
            result.display_label = `自定义 ${result.aspect_ratio}`;
        } else {
            result.aspect_ratio = ratioParts(normalized.aspect_ratio) ? normalized.aspect_ratio : '1:1';
            result.display_label = result.aspect_ratio;
        }
        result.size = String(settings.resolution || '').toLowerCase() === 'auto' ? 'auto' : sizeForRatio(result.aspect_ratio, settings.resolution || '2k');
        return result;
    }
    function ratioHintView(settings={}, inputs=[]){
        const normalized = normalizeGenerationRatioSettings(settings);
        if(normalized.ratio_mode === 'fixed') return {hidden:true, text:'', error:false};
        const resolved = resolveGenerationRatio(settings, inputs);
        if(normalized.ratio_mode === 'adaptive') return {hidden:false, text:'由图片模型自动决定输出比例和尺寸', error:false};
        return {hidden:false, text:resolved.valid ? resolved.display_label : resolved.error, error:!resolved.valid};
    }
    function safeJson(raw, fallback){ try { const value = JSON.parse(raw); return value && typeof value === 'object' ? value : fallback; } catch(_) { return fallback; } }
    function loadPreferences(){
        let value = {};
        try { value = safeJson(localStorage.getItem(PREFERENCE_KEY), {}); } catch(_) {}
        const taskNotices = value.taskNotices && typeof value.taskNotices === 'object' ? value.taskNotices : {};
        return {
            favorites:uniqueStrings(value.favorites),
            recents:uniqueStrings(value.recents).slice(0, MAX_RECENTS),
            taskNotices:{
                pendingTaskIds:uniqueStrings(taskNotices.pendingTaskIds),
                unseenTaskIds:uniqueStrings(taskNotices.unseenTaskIds),
            },
        };
    }
    function savePreferences(){
        try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify(runtime.preferences)); } catch(_) {}
    }
    function loadLocalDrafts(){ return safeJson(localStorage.getItem(LOCAL_DRAFT_KEY), {}); }
    function saveLocalDrafts(){ localStorage.setItem(LOCAL_DRAFT_KEY, JSON.stringify(runtime.pendingDrafts)); }
    function loadAdminToken(){ try { return sessionStorage.getItem(ADMIN_SESSION_KEY) || ''; } catch(_) { return ''; } }
    function saveAdminToken(token){
        runtime.admin.token = String(token || '');
        try {
            if(runtime.admin.token) sessionStorage.setItem(ADMIN_SESSION_KEY, runtime.admin.token);
            else sessionStorage.removeItem(ADMIN_SESSION_KEY);
        } catch(_) {}
    }
    function mediaUrl(media){ return String(media?.url || media?.image_url || ''); }
    function modeNumber(mode){ return Number(mode?.mode_no) > 0 ? `#${String(mode.mode_no).padStart(2, '0')}` : '#--'; }
    function formatDate(value){
        if(!value) return '';
        const date = new Date(Number(value) < 100000000000 ? Number(value) * 1000 : value);
        return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
    }
    function localDateKey(value){
        const date = new Date(Number(value) < 100000000000 ? Number(value) * 1000 : value);
        if(Number.isNaN(date.valueOf())) return '';
        const part = number => String(number).padStart(2, '0');
        return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
    }
    function statusLabel(status){
        return ({queued:'排队中',submitting:'正在提交',generating:'生成中',recovering:'正在恢复查询',unknown:'待回补',succeeded:'已完成',failed:'失败',cancelled:'已取消',partial:'部分成功',interrupted:'已中断',deleting:'删除中',deleted:'已删除'})[status] || status || '未知';
    }
    function timestampMilliseconds(value){
        const numeric = Number(value);
        if(!Number.isFinite(numeric) || numeric <= 0) return 0;
        return numeric < 100000000000 ? numeric * 1000 : numeric;
    }
    function formatElapsedDuration(milliseconds){
        const totalSeconds = Math.max(0, Math.floor(Number(milliseconds) / 1000) || 0);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        const part = value => String(value).padStart(2, '0');
        return hours > 0 ? `${part(hours)}:${part(minutes)}:${part(seconds)}` : `${part(minutes)}:${part(seconds)}`;
    }
    function candidateElapsedStart(task, candidate){
        return timestampMilliseconds(candidate?.submitted_at || candidate?.created_at || task?.created_at);
    }
    function updateCandidateElapsedTimes(now=Date.now()){
        document.querySelectorAll('[data-candidate-elapsed-start]').forEach(element => {
            const startedAt = Number(element.dataset.candidateElapsedStart) || now;
            element.textContent = formatElapsedDuration(now - startedAt);
        });
    }
    function syncCandidateElapsedTimer(){
        clearInterval(runtime.elapsedTimer);
        runtime.elapsedTimer = null;
        if(!document.querySelector('[data-candidate-elapsed-start]')) return;
        updateCandidateElapsedTimes();
        runtime.elapsedTimer = setInterval(updateCandidateElapsedTimes, 1000);
    }
    function showToast(message, error=false){
        const toast = byId('imageGenerationToast');
        toast.textContent = String(message || '');
        toast.classList.toggle('error', error);
        toast.hidden = false;
        clearTimeout(runtime.toastTimer);
        runtime.toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
    }
    function resetSubmissionContext(){
        runtime.submissionIds.clear();
    }
    function submissionIdForKind(submissionIds, kind, createUuid){
        const key = kind === 'force' ? 'force' : 'normal';
        let submissionId = submissionIds.get(key);
        if(!submissionId){
            submissionId = createUuid();
            submissionIds.set(key, submissionId);
        }
        return submissionId;
    }
    function unknownCandidateAction(candidate){
        if(String(candidate?.status || '') !== 'unknown') return '';
        return candidate?.recoverable === true ? 'recover' : '';
    }
    function candidateStatusLabel(candidate){
        const status = String(candidate?.status || '');
        if(status === 'unknown' && candidate?.recoverable !== true) return '结果未知';
        return statusLabel(status);
    }
    function candidateUnknownReason(candidate){
        if(String(candidate?.status || '') !== 'unknown' || candidate?.recoverable === true) return '';
        const raw = String(candidate?.error || '').trim();
        if(raw && !/^结果未知(?:[，,]|$)/.test(raw)) return raw;
        return '上游连接中断，未返回任务编号；无法安全回补';
    }
    function taskStatusLabel(task){
        const visual = taskVisualStatus(task);
        if(visual !== 'unknown') return statusLabel(visual);
        const candidates = Array.isArray(task?.candidates) ? task.candidates : [];
        const hasRecoverableCandidate = candidates.some(candidate => (
            String(candidate?.status || '') === 'unknown' && candidate?.recoverable === true
        ));
        return hasRecoverableCandidate ? '待回补' : '结果未知';
    }
    function submissionFailureMessage(acceptedTaskId, error){
        return acceptedTaskId ? '任务已创建，结果刷新失败，后台继续运行' : (error?.message || '任务提交失败');
    }
    function isLatestNavigation(requestVersion, currentVersion){ return requestVersion === currentVersion; }
    function currentModeIsActive(){
        const modeId = String(runtime.currentMode?.id || '');
        return Boolean(modeId && runtime.modes.some(mode => String(mode.id) === modeId && mode.status === 'active'));
    }
    function modeContextFromTask(task){
        const snapshot = task?.mode_snapshot && typeof task.mode_snapshot === 'object' ? task.mode_snapshot : {};
        return {
            ...snapshot,
            id:String(task?.mode_id || snapshot.id || ''),
            display_name:String(task?.mode_name || snapshot.display_name || '已归档模式'),
            mode_no:Number(task?.mode_no || snapshot.mode_no || 0),
            description:String(snapshot.description || '此模式已归档，历史记录仅供查看'),
            status:'archived',
        };
    }
    function blockContextChangeWhileSubmitting(){
        if(!runtime.submitLocked) return false;
        const message = '任务正在提交，请等待提交完成后再切换页面或历史记录';
        setWorkbenchStatus(message);
        showToast(message);
        return true;
    }
    function setPageStatus(message){ byId('pageStatus').textContent = message; }
    function setWorkbenchStatus(message, error=false, kind=''){
        const element = byId('workbenchStatus');
        if(!element) return;
        const text = byId('workbenchStatusText');
        const icon = byId('workbenchStatusIcon');
        if(text) text.textContent = message || '';
        else element.textContent = message || '';
        element.hidden = !message;
        element.classList.toggle('error', error);
        element.classList.toggle('ready', kind === 'ready');
        if(icon){
            const iconNode = icon.tagName?.toLowerCase() === 'svg' ? (() => {
                const replacement = document.createElement('i');
                replacement.id = 'workbenchStatusIcon';
                icon.replaceWith(replacement);
                return replacement;
            })() : icon;
            iconNode.dataset.lucide = error ? 'circle-alert' : kind === 'ready' ? 'check-circle-2' : 'info';
        }
        refreshIcons();
    }
    function clearReadyToGenerateHint(){
        const status = byId('workbenchStatus');
        if(status?.classList.contains('ready')) setWorkbenchStatus('');
        const button = byId('generateImages');
        if(button) button.classList.remove('ready-pulse');
        clearTimeout(runtime.readyPulseTimer);
        runtime.readyPulseTimer = null;
    }
    function clearWorkbenchErrorStatus(){
        const status = byId('workbenchStatus');
        if(status?.classList.contains('error')) setWorkbenchStatus('');
    }
    function showReadyToGenerateHint(){
        setWorkbenchStatus('参数已载入，可直接生成', false, 'ready');
        const button = byId('generateImages');
        if(!button) return;
        clearTimeout(runtime.readyPulseTimer);
        button.classList.remove('ready-pulse');
        void button.offsetWidth;
        button.classList.add('ready-pulse');
        runtime.readyPulseTimer = setTimeout(() => {
            button.classList.remove('ready-pulse');
            runtime.readyPulseTimer = null;
        }, 2400);
    }
    function refreshIcons(){ try { globalThis.lucide?.createIcons(); } catch(_) {} }

    function savedUserPromptEditorFont(){
        try {
            const saved = localStorage.getItem(USER_PROMPT_EDITOR_FONT_KEY);
            return USER_PROMPT_EDITOR_FONTS.some(item => item.id === saved) ? saved : 'medium';
        } catch(_) { return 'medium'; }
    }
    function setUserPromptEditorFont(fontId){
        const selected = USER_PROMPT_EDITOR_FONTS.some(item => item.id === fontId) ? fontId : 'medium';
        const dialog = byId('userPromptEditorDialog');
        if(dialog){
            USER_PROMPT_EDITOR_FONTS.forEach(item => dialog.classList.remove(item.className));
            dialog.classList.add(USER_PROMPT_EDITOR_FONTS.find(item => item.id === selected)?.className || 'font-medium');
        }
        byId('userPromptEditorFont')?.querySelectorAll('[data-prompt-font]').forEach(button => {
            const active = button.dataset.promptFont === selected;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        try { localStorage.setItem(USER_PROMPT_EDITOR_FONT_KEY, selected); } catch(_) {}
    }
    function updateUserPromptEditorCount(value=runtime.userPrompt){
        const count = byId('userPromptEditorCount');
        if(count) count.textContent = `${String(value || '').length} / ${USER_PROMPT_MAX_LENGTH}`;
    }
    function syncUserPromptEditorFromRuntime(){
        const editor = byId('userPromptEditor');
        if(editor && editor.value !== runtime.userPrompt) editor.value = runtime.userPrompt;
        updateUserPromptEditorCount();
    }
    function makeHistoryPromptEditable(){
        if(!runtime.readOnlyHistory || !currentModeIsActive()) return;
        applyTaskAsEditable(runtime.viewedTask, '由历史创建');
    }
    function updateUserPrompt(value, source='compact'){
        makeHistoryPromptEditable();
        const nextValue = String(value || '').slice(0, USER_PROMPT_MAX_LENGTH);
        runtime.userPrompt = nextValue;
        const compact = byId('userPrompt');
        const editor = byId('userPromptEditor');
        if(source !== 'compact' && compact && compact.value !== nextValue) compact.value = nextValue;
        if(source !== 'editor' && editor && editor.value !== nextValue) editor.value = nextValue;
        updateUserPromptEditorCount(nextValue);
        markDirty();
    }

    function imagePromptTemplateName(template){
        return String(template?.name || template?.name_en || '').trim();
    }
    function imagePromptTemplateScene(template){
        return String(template?.scene || template?.scene_en || '').trim();
    }
    function imagePromptTemplateCategoryLabel(category){
        const id = String(category || '');
        if(id === 'all') return '全部';
        const configured = activeImagePromptLibrary()?.categories?.find(item => String(item?.id || '') === id);
        return String(configured?.name || ({view:'视图', storyboard:'分镜', character:'角色', product:'产品', lighting:'光影', custom:'我的提示词', mine:'我的提示词'})[id] || id || '其他');
    }
    function imagePromptTemplateSearchText(template){
        return [template?.name, template?.name_en, template?.scene, template?.scene_en, template?.positive, template?.negative, template?.libraryName].join(' ').toLocaleLowerCase();
    }
    function activeImagePromptLibrary(){
        return imagePromptLibraryState.libraries.find(lib => String(lib?.id || '') === imagePromptLibraryState.activeLibraryId)
            || imagePromptLibraryState.libraries[0]
            || {id:'system', name:'系统提示词库', readonly:true, items:[]};
    }
    function imagePromptTemplateItemsForLibrary(library){
        return (Array.isArray(library?.items) ? library.items : [])
            .filter(item => item?.id && String(item?.positive || '').trim())
            .map(item => ({...item, libraryId:String(library.id || ''), libraryName:String(library.name || '提示词库'), remote:true}));
    }
    function activeImagePromptTemplateItems(){
        return imagePromptTemplateItemsForLibrary(activeImagePromptLibrary());
    }
    function imagePromptTemplateGroups(){
        const library = activeImagePromptLibrary();
        const categories = Array.isArray(library?.categories) ? library.categories.filter(item => item?.id) : [];
        if(categories.length) return categories.map(item => ({id:String(item.id), name:String(item.name || imagePromptTemplateCategoryLabel(item.id))}));
        const ids = [...new Set(activeImagePromptTemplateItems().map(item => String(item.category || 'custom')).filter(Boolean))];
        return ids.map(id => ({id, name:imagePromptTemplateCategoryLabel(id)}));
    }
    function imagePromptTemplateVisibleItems(){
        const query = String(imagePromptLibraryState.query || '').trim().toLocaleLowerCase();
        return imagePromptLibraryState.templates.filter(item => {
            if(imagePromptLibraryState.category !== 'all' && String(item.category || 'custom') !== imagePromptLibraryState.category) return false;
            return !query || imagePromptTemplateSearchText(item).includes(query);
        });
    }
    async function copyImagePromptText(value){
        const text = String(value || '').trim();
        if(!text) return false;
        try {
            if(typeof navigator !== 'undefined' && navigator.clipboard?.writeText){
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch(_) {}
        if(typeof document === 'undefined' || !document.body) return false;
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        let copied = false;
        try { copied = Boolean(document.execCommand?.('copy')); } catch(_) {}
        textarea.remove();
        return copied;
    }
    async function loadImagePromptLibrary(){
        if(imagePromptLibraryState.loaded) return imagePromptLibraryState.templates;
        if(imagePromptLibraryState.loading) return imagePromptLibraryState.loading;
        imagePromptLibraryState.loading = requestJson('/api/prompt-libraries').then(data => {
            imagePromptLibraryState.libraries = Array.isArray(data?.library?.libraries) ? data.library.libraries : [];
            if(!imagePromptLibraryState.libraries.some(lib => String(lib?.id || '') === imagePromptLibraryState.activeLibraryId)){
                imagePromptLibraryState.activeLibraryId = imagePromptLibraryState.libraries.some(lib => lib?.id === 'system') ? 'system' : String(imagePromptLibraryState.libraries[0]?.id || '');
            }
            imagePromptLibraryState.templates = activeImagePromptTemplateItems();
            imagePromptLibraryState.loaded = true;
            imagePromptLibraryState.loading = null;
            return imagePromptLibraryState.templates;
        }).catch(error => {
            imagePromptLibraryState.libraries = [];
            imagePromptLibraryState.templates = [];
            imagePromptLibraryState.loaded = false;
            imagePromptLibraryState.loading = null;
            throw error;
        });
        return imagePromptLibraryState.loading;
    }
    function selectedImagePromptTemplate(){
        return imagePromptLibraryState.templates.find(item => String(item.id) === imagePromptLibraryState.selectedId) || null;
    }
    function renderImagePromptLibrary(){
        const body = byId('imageGenerationPromptBody');
        const cats = byId('imageGenerationPromptCats');
        const select = byId('imageGenerationPromptLibrarySelect');
        const target = byId('imageGenerationPromptTarget');
        if(!body || !cats || !select) return;
        imagePromptLibraryState.templates = activeImagePromptTemplateItems();
        select.innerHTML = imagePromptLibraryState.libraries.map(lib => `<option value="${escapeHtml(lib.id)}" ${String(lib.id) === imagePromptLibraryState.activeLibraryId ? 'selected' : ''}>${escapeHtml(lib.name || '提示词库')}</option>`).join('');
        const groups = [{id:'all', name:'全部'}, ...imagePromptTemplateGroups()];
        const counts = imagePromptLibraryState.templates.reduce((result, item) => {
            const category = String(item.category || 'custom');
            result[category] = (result[category] || 0) + 1;
            result.all += 1;
            return result;
        }, {all:0});
        cats.innerHTML = `<div class="image-generation-prompt-cats-inner">${groups.map(group => `<button type="button" class="image-generation-prompt-cat ${group.id === imagePromptLibraryState.category ? 'active' : ''}" data-image-prompt-category="${escapeHtml(group.id)}" role="tab" aria-selected="${group.id === imagePromptLibraryState.category ? 'true' : 'false'}">${escapeHtml(group.name)}<small>${counts[group.id] || 0}</small></button>`).join('')}</div>`;
        const items = imagePromptTemplateVisibleItems();
        if(items.length && !items.some(item => String(item.id) === imagePromptLibraryState.selectedId)) imagePromptLibraryState.selectedId = String(items[0].id);
        const selected = items.find(item => String(item.id) === imagePromptLibraryState.selectedId) || items[0] || null;
        const thumb = item => globalThis.PromptTemplateThumbnails?.card?.(item) || `<span class="prompt-thumb-card" aria-hidden="true"><span class="prompt-thumb-placeholder"><span>词</span></span></span>`;
        const itemMarkup = items.length ? items.map(item => `<button type="button" class="image-generation-prompt-card ${String(item.id) === String(selected?.id || '') ? 'active' : ''}" data-image-prompt-template-id="${escapeHtml(item.id)}">
            ${thumb(item)}
            <span class="image-generation-prompt-card-copy"><span class="image-generation-prompt-card-name" title="${escapeHtml(imagePromptTemplateName(item))}">${escapeHtml(imagePromptTemplateName(item) || '未命名提示词')}</span><span class="image-generation-prompt-card-scene">${escapeHtml(imagePromptTemplateScene(item) || item.positive || '')}</span></span>
            <span class="image-generation-prompt-card-tag">${escapeHtml(imagePromptTemplateCategoryLabel(item.category || 'custom'))}</span>
        </button>`).join('') : '<div class="image-generation-prompt-empty">当前筛选条件下没有提示词</div>';
        const canWrite = Boolean(selected && !runtime.readOnlyHistory);
        const positive = String(selected?.positive || '').trim();
        const negative = String(selected?.negative || '').trim();
        const params = Object.entries(selected?.params || {}).map(([key, value]) => `${key}: ${value}`).join('\n');
        body.innerHTML = `<div class="image-generation-prompt-list">${itemMarkup}</div><section class="image-generation-prompt-detail">
            ${selected ? `<div class="image-generation-prompt-detail-head"><div class="image-generation-prompt-detail-title"><strong>${escapeHtml(imagePromptTemplateName(selected) || '未命名提示词')}</strong><span>${escapeHtml(imagePromptTemplateCategoryLabel(selected.category || 'custom'))} · ${escapeHtml(selected.libraryName || '提示词库')}</span></div></div>
            <div class="image-generation-prompt-detail-media">${globalThis.PromptTemplateThumbnails?.image?.(selected, 'image-generation-prompt-detail-thumb') || '<span class="prompt-thumb-placeholder"><span>词</span></span>'}</div>
            <div class="image-generation-prompt-preview"><div class="image-generation-prompt-section"><label>正向提示词</label><p>${escapeHtml(positive || '暂无正向提示词')}</p></div>${negative ? `<div class="image-generation-prompt-section"><label>负向提示词</label><p>${escapeHtml(negative)}</p></div>` : ''}${params ? `<div class="image-generation-prompt-section"><label>参数</label><p>${escapeHtml(params)}</p></div>` : ''}</div>
            <div class="image-generation-prompt-actions"><button type="button" data-image-prompt-action="copy" ${positive ? '' : 'disabled'}><i data-lucide="copy"></i><span>复制正向提示词</span></button><button type="button" class="primary" data-image-prompt-action="write" ${canWrite && positive ? '' : 'disabled'}><i data-lucide="corner-down-left"></i><span>${runtime.readOnlyHistory ? '历史记录只读' : '替换用户描述'}</span></button></div>` : '<div class="image-generation-prompt-empty">请选择一条提示词查看详情</div>'}
        </section>`;
        if(target) target.textContent = runtime.readOnlyHistory ? '历史记录只读，双击将复制正向提示词' : '双击提示词可替换用户描述';
        refreshIcons();
    }
    async function applyImagePromptTemplate(template=selectedImagePromptTemplate()){
        const positive = String(template?.positive || '').trim();
        if(!positive){ showToast('该提示词没有正向内容', true); return false; }
        if(runtime.readOnlyHistory){
            const copied = await copyImagePromptText(positive);
            showToast(copied ? '提示词已复制' : '复制失败', !copied);
            return copied;
        }
        if(positive.length > USER_PROMPT_MAX_LENGTH){ showToast(`提示词超过 ${USER_PROMPT_MAX_LENGTH} 字，未写入`, true); return false; }
        updateUserPrompt(positive, 'prompt-library');
        closeImagePromptLibrary();
        byId('userPrompt')?.focus();
        showToast('提示词已替换用户描述');
        return true;
    }
    async function openImagePromptLibrary(){
        const dialog = byId('imageGenerationPromptDialog');
        if(!dialog || !runtime.currentMode) return;
        imagePromptLibraryState.lastFocus = document.activeElement;
        imagePromptLibraryState.query = '';
        imagePromptLibraryState.category = 'all';
        const search = byId('imageGenerationPromptSearch');
        if(search) search.value = '';
        if(!dialog.open) dialog.showModal();
        try {
            await loadImagePromptLibrary();
            renderImagePromptLibrary();
            requestAnimationFrame(() => search?.focus());
        } catch(error){
            byId('imageGenerationPromptBody').innerHTML = '<div class="image-generation-prompt-empty">提示词库读取失败，请稍后重试</div>';
            showToast(error.message || '提示词库读取失败', true);
        }
    }
    function closeImagePromptLibrary(){
        const dialog = byId('imageGenerationPromptDialog');
        if(dialog?.open) dialog.close();
        const focus = imagePromptLibraryState.lastFocus;
        imagePromptLibraryState.lastFocus = null;
        if(focus && typeof focus.focus === 'function' && document.contains(focus)) focus.focus();
    }
    function openUserPromptEditor(){
        const dialog = byId('userPromptEditorDialog');
        const editor = byId('userPromptEditor');
        if(!dialog || !editor || !runtime.currentMode) return;
        syncUserPromptEditorFromRuntime();
        setUserPromptEditorFont(savedUserPromptEditorFont());
        if(!dialog.open) dialog.showModal();
        requestAnimationFrame(() => {
            editor.focus();
            editor.setSelectionRange(0, 0);
            editor.scrollTop = 0;
        });
    }
    function closeUserPromptEditor(){
        const dialog = byId('userPromptEditorDialog');
        if(dialog?.open) dialog.close();
    }

    async function requestJson(url, options={}){
        const response = await fetch(url, {cache:'no-store', ...options});
        let payload = null;
        try { payload = await response.json(); } catch(_) {}
        if(!response.ok){
            const detail = typeof payload?.detail === 'string' ? payload.detail : `请求失败（HTTP ${response.status}）`;
            const error = new Error(detail);
            error.status = response.status;
            throw error;
        }
        return payload;
    }
    function isProtectedImageGenerationPath(url){
        const path = String(url || '').split('?')[0];
        return path.startsWith('/api/image-generation/admin/')
            || path === '/api/image-generation/admin/modes'
            || /^\/api\/image-generation\/modes\/[^/]+\/(?:prompt-draft|activate-prompt|restore-prompt|duplicate|archive|trash|restore|example)$/.test(path)
            || /^\/api\/image-generation\/modes\/[^/]+$/.test(path)
            || path === '/api/image-generation-tasks';
    }
    async function adminRequestJson(url, options={}){
        if(!runtime.admin.token) throw new Error('管理状态已失效');
        if(!isProtectedImageGenerationPath(url)) throw new Error('拒绝向非图片生成管理接口发送管理令牌');
        const headers = {...(options.headers || {}), 'X-Image-Generation-Admin':runtime.admin.token};
        try {
            return await requestJson(url, {...options, headers});
        } catch(error) {
            if(error.status === 403) leaveAdminUi();
            if(error.status === 403) await reloadPublicModes().catch(() => {});
            throw error;
        }
    }

    function isFavorite(modeId){ return runtime.preferences.favorites.includes(String(modeId || '')); }
    function toggleFavorite(modeId){
        const id = String(modeId || '');
        runtime.preferences.favorites = isFavorite(id)
            ? runtime.preferences.favorites.filter(item => item !== id)
            : [id, ...runtime.preferences.favorites];
        savePreferences();
        renderHall();
        syncWorkbenchHeader();
    }
    function recordRecent(modeId){
        const id = String(modeId || '');
        runtime.preferences.recents = [id, ...runtime.preferences.recents.filter(item => item !== id)].slice(0, MAX_RECENTS);
        savePreferences();
    }

    function modeSearchText(mode){
        return normalizeSearch([
            mode.mode_no, Number(mode.mode_no) > 0 ? String(mode.mode_no).padStart(2, '0') : '', mode.display_name,
            mode.description, mode.category, mode.summary, ...(mode.tags || []), ...(mode.synonyms || []),
        ].join(' '));
    }
    function filteredModes(){
        const query = normalizeSearch(runtime.search);
        return runtime.modes.filter(mode => {
            if(mode.status !== 'active') return false;
            if(runtime.category !== '全部' && String(mode.category || '其他') !== runtime.category) return false;
            return !query || modeSearchText(mode).includes(query);
        });
    }
    function candidateStats(task){
        const candidates = Array.isArray(task?.candidates) ? task.candidates : [];
        const total = Number(task?.candidate_count) || candidates.length || Number(task?.generation_settings?.image_count) || 0;
        const succeeded = candidates.length ? candidates.filter(item => item?.status === 'succeeded').length : Number(task?.successful_candidate_count) || 0;
        const active = candidates.filter(item => ACTIVE_TASK_STATUSES.has(String(item?.status || ''))).length;
        const unknown = candidates.filter(item => item?.status === 'unknown').length;
        const failed = candidates.filter(item => item?.status === 'failed').length;
        return {total, succeeded, active, unknown, failed};
    }
    function taskVisualStatus(task){
        const status = String(task?.status || '');
        const stats = candidateStats(task);
        if(status === 'recovering') return 'recovering';
        if(ACTIVE_TASK_STATUSES.has(status)) return status;
        if(task?.results_deleted || (status === 'failed' && Number(task?.candidate_count) === 0)) return 'deleted';
        if(stats.succeeded && (stats.failed || stats.unknown)) return 'partial';
        if(status === 'succeeded' && stats.succeeded > 0 && stats.succeeded < stats.total) return 'partial';
        if(stats.unknown && !stats.succeeded) return 'unknown';
        return status || 'unknown';
    }
    function taskCompletionOutcome(task){
        const stats = candidateStats(task);
        if(stats.active > 0) return '';
        if(stats.succeeded > 0) return 'success';
        const candidates = Array.isArray(task?.candidates) ? task.candidates : [];
        if(candidates.length && candidates.every(candidate => String(candidate?.status || '') === 'failed')) return 'failure';
        if(!candidates.length && String(task?.status || '') === 'failed' && Number(task?.candidate_count || 0) > 0 && Number(task?.successful_candidate_count || 0) === 0) return 'failure';
        return '';
    }
    function taskHallNotice(task){
        const status = taskVisualStatus(task);
        const stats = candidateStats(task);
        if(status === 'partial' && stats.succeeded > 0){
            return {tone:'partial', label:`已完成 · ${stats.succeeded}/${stats.total || '?'}张`};
        }
        if(status === 'succeeded' && stats.succeeded > 0){
            return {tone:'complete', label:`已完成 · ${stats.succeeded}张`};
        }
        if(status === 'failed') return {tone:'failure', label:'生成失败'};
        return null;
    }
    function completionTransitionOutcome(previousTask, task){
        const previousStatus = String(previousTask?.status || '');
        if(!ACTIVE_TASK_STATUSES.has(previousStatus)) return '';
        if(ACTIVE_TASK_STATUSES.has(String(task?.status || ''))) return '';
        return taskCompletionOutcome(task);
    }
    let imageGenerationCompletionSoundAt = 0;
    function playImageGenerationCompletionSound(outcome='success'){
        const now = Date.now();
        if(now - imageGenerationCompletionSoundAt < 1200) return;
        imageGenerationCompletionSoundAt = now;
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if(!AudioCtx) return;
            const ctx = playImageGenerationCompletionSound._ctx || (playImageGenerationCompletionSound._ctx = new AudioCtx());
            const play = () => {
                const start = ctx.currentTime + 0.015;
                const tones = outcome === 'failure'
                    ? [{freq:440, at:0, duration:0.12}, {freq:330, at:0.12, duration:0.16}]
                    : [{freq:660, at:0, duration:0.12}, {freq:880, at:0.12, duration:0.16}];
                tones.forEach(tone => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(tone.freq, start + tone.at);
                    gain.gain.setValueAtTime(0.0001, start + tone.at);
                    gain.gain.exponentialRampToValueAtTime(0.075, start + tone.at + 0.018);
                    gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.at + tone.duration);
                    osc.connect(gain).connect(ctx.destination);
                    osc.start(start + tone.at);
                    osc.stop(start + tone.at + tone.duration + 0.02);
                });
            };
            if(ctx.state === 'suspended') ctx.resume().then(play).catch(() => {});
            else play();
        } catch(_) {}
    }
    function maybePlayTaskCompletionSound(previousTask, task){
        const taskId = String(task?.id || '');
        if(taskId && ACTIVE_TASK_STATUSES.has(String(task?.status || ''))){
            runtime.completionNoticeTaskIds.delete(taskId);
            return '';
        }
        const outcome = completionTransitionOutcome(previousTask, task);
        const pageVisible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
        if(!taskId || !outcome || !pageVisible) return '';
        if(runtime.completionNoticeTaskIds.has(taskId)) return '';
        runtime.completionNoticeTaskIds.add(taskId);
        playImageGenerationCompletionSound(outcome);
        return outcome;
    }
    function taskNoticePreferences(){
        const notices = runtime.preferences.taskNotices;
        if(notices && Array.isArray(notices.pendingTaskIds) && Array.isArray(notices.unseenTaskIds)) return notices;
        runtime.preferences.taskNotices = {pendingTaskIds:[], unseenTaskIds:[]};
        return runtime.preferences.taskNotices;
    }
    function taskNoticeStateAfterTask(notices, task, workbenchVisible=false){
        const id = String(task?.id || '');
        const next = {
            pendingTaskIds:uniqueStrings(notices?.pendingTaskIds),
            unseenTaskIds:uniqueStrings(notices?.unseenTaskIds),
        };
        if(!id) return next;
        const setPresence = (listName, present) => {
            const list = next[listName];
            const index = list.indexOf(id);
            if(present && index < 0) list.unshift(id);
            else if(!present && index >= 0) list.splice(index, 1);
        };
        const active = ACTIVE_TASK_STATUSES.has(String(task?.status || ''));
        const wasPending = next.pendingTaskIds.includes(id);
        if(active){
            setPresence('pendingTaskIds', true);
            setPresence('unseenTaskIds', false);
        } else if(wasPending){
            setPresence('pendingTaskIds', false);
            setPresence('unseenTaskIds', Boolean(taskHallNotice(task)) && !workbenchVisible);
        } else if(next.unseenTaskIds.includes(id) && !taskHallNotice(task)){
            setPresence('unseenTaskIds', false);
        }
        return next;
    }
    function frameSurfaceVisible(frame, visibilityState='visible'){
        if(visibilityState === 'hidden') return false;
        if(!frame) return true;
        if(frame.id === 'frame-image-generation' && typeof frame.classList?.contains === 'function'){
            return frame.classList.contains('active');
        }
        return true;
    }
    function workbenchShowsMode(modeId){
        if(typeof document === 'undefined') return false;
        if(!frameSurfaceVisible(window.frameElement, document.visibilityState)) return false;
        return String(runtime.currentMode?.id || '') === String(modeId || '') && !byId('modeWorkbench')?.hidden;
    }
    function syncTaskNotice(task){
        const taskId = String(task?.id || '');
        if(!taskId) return;
        const notices = taskNoticePreferences();
        const next = taskNoticeStateAfterTask(notices, task, workbenchShowsMode(task.mode_id));
        if(JSON.stringify(next) === JSON.stringify(notices)) return;
        runtime.preferences.taskNotices = next;
        savePreferences();
    }
    function markModeTaskNoticesSeen(modeId){
        const notices = taskNoticePreferences();
        const targetModeId = String(modeId || '');
        const before = notices.unseenTaskIds.length;
        notices.unseenTaskIds = notices.unseenTaskIds.filter(taskId => {
            const task = runtime.taskCache.get(taskId) || runtime.allTasks.find(item => String(item?.id || '') === taskId);
            return String(task?.mode_id || '') !== targetModeId;
        });
        if(notices.unseenTaskIds.length !== before) savePreferences();
    }
    function forgetTaskNotices(taskIds){
        const removed = new Set([...(taskIds || [])].map(value => String(value || '')).filter(Boolean));
        if(!removed.size) return;
        const notices = taskNoticePreferences();
        const pending = notices.pendingTaskIds.filter(taskId => !removed.has(taskId));
        const unseen = notices.unseenTaskIds.filter(taskId => !removed.has(taskId));
        if(pending.length === notices.pendingTaskIds.length && unseen.length === notices.unseenTaskIds.length) return;
        notices.pendingTaskIds = pending;
        notices.unseenTaskIds = unseen;
        savePreferences();
    }
    function forgetImageGenerationTasks(taskIds){
        const deleted = new Set([...(taskIds || [])].map(value => String(value || '')).filter(Boolean));
        if(!deleted.size) return;
        forgetTaskNotices(deleted);
        runtime.taskNavigationVersion += 1;
        for(const taskId of deleted){
            runtime.deletedTaskIds.add(taskId);
            runtime.taskCache.delete(taskId);
            runtime.activeTaskIds.delete(taskId);
            runtime.completionNoticeTaskIds.delete(taskId);
        }
        runtime.allTasks = runtime.allTasks.filter(task => !deleted.has(String(task?.id || '')));
        runtime.tasks = runtime.tasks.filter(task => !deleted.has(String(task?.id || '')));
        for(const key of [...runtime.selectedResultKeys]){
            if(deleted.has(String(key).split(':', 1)[0])) runtime.selectedResultKeys.delete(key);
        }
        if(runtime.viewedTask?.id && deleted.has(String(runtime.viewedTask.id))) runtime.viewedTask = null;
        if(!runtime.activeTaskIds.size){
            clearTimeout(runtime.pollTimer);
            runtime.pollTimer = null;
        }
    }
    function rememberTask(task){
        if(!task?.id) return;
        if(runtime.deletedTaskIds.has(String(task.id))) return;
        const previous = runtime.taskCache.get(task.id) || {};
        const merged = {...previous, ...task};
        if(Array.isArray(task.candidates)) merged._detail_updated_at = task.updated_at || task.created_at || 0;
        runtime.taskCache.set(task.id, merged);
        const index = runtime.allTasks.findIndex(item => item.id === task.id);
        if(index >= 0) runtime.allTasks[index] = {...runtime.allTasks[index], ...task};
        else runtime.allTasks.push(merged);
        if(ACTIVE_TASK_STATUSES.has(String(merged.status || ''))) runtime.activeTaskIds.add(task.id);
        else runtime.activeTaskIds.delete(task.id);
        syncTaskNotice(merged);
    }
    function adoptTaskSnapshot(task, {makeViewed=false}={}){
        if(!task?.id) return false;
        rememberTask(task);
        if(String(runtime.currentMode?.id || '') === String(task.mode_id || '')){
            const index = runtime.tasks.findIndex(item => item.id === task.id);
            if(index >= 0) runtime.tasks[index] = {...runtime.tasks[index], ...task};
            else runtime.tasks.push(task);
            runtime.tasks.sort((a, b) => Number(b.updated_at || b.created_at || 0) - Number(a.updated_at || a.created_at || 0));
            if(makeViewed) runtime.viewedTask = task;
            renderResults();
            renderHistory();
        }
        renderHall();
        renderGlobalHistory();
        return true;
    }
    function modeProgress(modeId){
        const active = [...runtime.activeTaskIds].map(id => runtime.taskCache.get(id)).filter(task => task?.mode_id === modeId);
        if(!active.length) return null;
        active.sort((a, b) => Number(b.updated_at || b.created_at || 0) - Number(a.updated_at || a.created_at || 0));
        const task = active[0];
        const stats = candidateStats(task);
        const label = task.status === 'recovering' ? '正在恢复查询' : `生成中 ${stats.succeeded}/${stats.total || '?'}`;
        return {label, task};
    }
    function modeUnseenNotice(modeId){
        const targetModeId = String(modeId || '');
        const tasks = taskNoticePreferences().unseenTaskIds
            .map(taskId => runtime.taskCache.get(taskId) || runtime.allTasks.find(item => String(item?.id || '') === taskId))
            .filter(task => String(task?.mode_id || '') === targetModeId)
            .sort((a, b) => Number(b?.updated_at || b?.created_at || 0) - Number(a?.updated_at || a?.created_at || 0));
        for(const task of tasks){
            const notice = taskHallNotice(task);
            if(notice) return {...notice, task};
        }
        return null;
    }
    function modeCard(mode, compact=false){
        const favorite = isFavorite(mode.id);
        const progress = modeProgress(mode.id);
        const unseenNotice = progress ? null : modeUnseenNotice(mode.id);
        const cardStatus = progress || unseenNotice;
        const exampleInputs = (mode.example?.input_media || []).map(item => item?.media || item).filter(mediaUrl);
        const exampleInputUrl = mediaUrl(exampleInputs[0]);
        const exampleUrl = mediaUrl(mode.example?.output_media);
        const progressMarkup = cardStatus
            ? `<div class="mode-card-progress${unseenNotice ? ` is-unseen is-${unseenNotice.tone}` : ''}" role="status" aria-label="${escapeHtml(cardStatus.label)}">${progress ? '<i class="status-spinner" data-lucide="loader-circle"></i>' : '<span class="mode-card-status-dot" aria-hidden="true"></span>'}<span>${escapeHtml(cardStatus.label)}</span></div>`
            : '';
        const exampleMarkup = exampleInputUrl && exampleUrl
            ? `<div class="mode-card-example-pair" aria-label="原图和生成图示范">
                <div class="mode-card-example-side"><div class="mode-card-example-frame"><img class="mode-card-example" src="${escapeHtml(exampleInputUrl)}" alt="${escapeHtml(mode.display_name || '模式')}原图示范" loading="lazy"></div></div>
                <div class="mode-card-example-side"><div class="mode-card-example-frame"><img class="mode-card-example" src="${escapeHtml(exampleUrl)}" alt="${escapeHtml(mode.display_name || '模式')}生成图示范" loading="lazy"></div></div>
            </div>`
            : exampleUrl
                ? `<div class="mode-card-example-single"><img class="mode-card-example" src="${escapeHtml(exampleUrl)}" alt="${escapeHtml(mode.display_name || '模式')}效果示范" loading="lazy"></div>`
                : '<div class="mode-card-example-placeholder" aria-hidden="true"><i data-lucide="image"></i></div>';
        const noticeClass = unseenNotice ? ` has-unseen-result notice-${unseenNotice.tone}` : '';
        const statusLabel = cardStatus ? `，${cardStatus.label}` : '';
        return `<article class="mode-card${compact ? ' compact' : ''}${noticeClass}" role="button" tabindex="0" data-mode-id="${escapeHtml(mode.id)}" aria-label="打开${escapeHtml(mode.display_name)}${escapeHtml(statusLabel)}">
            <div class="mode-card-top"><span class="mode-card-no">${modeNumber(mode)}</span><h3>${escapeHtml(mode.display_name || '未命名模式')}</h3></div>
            <button class="favorite-button" type="button" data-favorite-id="${escapeHtml(mode.id)}" aria-pressed="${favorite}" title="${favorite ? '取消收藏' : '收藏模式'}" aria-label="${favorite ? '取消收藏' : '收藏模式'}"><i data-lucide="star"></i></button>
            ${exampleMarkup}
            ${progressMarkup}
        </article>`;
    }
    function modesByIds(ids){
        const byModeId = new Map(runtime.modes.map(mode => [String(mode.id), mode]));
        return (ids || []).map(id => byModeId.get(String(id))).filter(mode => mode?.status === 'active');
    }
    function renderCategories(){
        const categories = ['全部', ...uniqueStrings(runtime.modes.filter(mode => mode.status === 'active').map(mode => mode.category || '其他'))];
        if(!categories.includes(runtime.category)) runtime.category = '全部';
        byId('modeCategories').innerHTML = categories.map(category => `<button class="category-tab" type="button" data-category="${escapeHtml(category)}" aria-pressed="${category === runtime.category}">${escapeHtml(category)}</button>`).join('');
    }
    function renderHall(){
        renderCategories();
        const recent = modesByIds(runtime.preferences.recents);
        const favorites = modesByIds(runtime.preferences.favorites);
        const filtered = filteredModes();
        byId('recentSection').hidden = !recent.length || Boolean(runtime.search);
        byId('favoriteSection').hidden = !favorites.length || Boolean(runtime.search);
        byId('recentModes').innerHTML = recent.map(mode => modeCard(mode, true)).join('');
        byId('favoriteModes').innerHTML = favorites.map(mode => modeCard(mode, true)).join('');
        byId('modeGrid').innerHTML = filtered.map(mode => modeCard(mode)).join('');
        byId('modeGrid').hidden = !filtered.length;
        byId('modeEmpty').hidden = Boolean(filtered.length);
        byId('modeCount').textContent = `${filtered.length} 个模式`;
        byId('clearModeSearch').hidden = !runtime.search;
        bindHallCards();
        refreshIcons();
    }
    function bindHallCards(){
        document.querySelectorAll('[data-mode-id]').forEach(card => {
            card.addEventListener('click', event => {
                if(event.target.closest('[data-favorite-id]')) return;
                selectMode(card.dataset.modeId);
            });
            card.addEventListener('keydown', event => {
                if(event.target.closest('[data-favorite-id]')) return;
                if(event.key === 'Enter' || event.key === ' '){ event.preventDefault(); selectMode(card.dataset.modeId); }
            });
        });
        document.querySelectorAll('[data-favorite-id]').forEach(button => button.addEventListener('click', event => {
            event.stopPropagation(); toggleFavorite(button.dataset.favoriteId);
        }));
    }

    function currentDraftPayload(){
        const ratio = resolveGenerationRatio(runtime.settings, runtime.inputs);
        return {
            inputs:runtime.inputs.filter(item => item.media?.id).map(item => ({slot_key:item.slot_key, media_id:item.media.id})),
            user_prompt:runtime.userPrompt,
            generation_settings:{
                image_provider_id:runtime.settings.image_provider_id || '', image_model:runtime.settings.image_model || '',
                ratio_mode:runtime.settings.ratio_mode || 'fixed',
                aspect_ratio:ratio.valid ? ratio.aspect_ratio : String(runtime.settings.aspect_ratio || ''),
                custom_ratio_width:String(runtime.settings.custom_ratio_width || ''), custom_ratio_height:String(runtime.settings.custom_ratio_height || ''),
                resolution:runtime.settings.resolution || '2k', size:ratio.valid ? ratio.size : (runtime.settings.size || ''),
                image_count:Math.max(1, Math.min(6, Number(runtime.settings.image_count) || 1)),
            },
        };
    }
    function currentLocalDraftPayload(){
        const payload = currentDraftPayload();
        payload.inputs = runtime.inputs.filter(item => item.media?.id).map(item => ({
            slot_key:item.slot_key,
            media:{
                id:item.media.id,
                url:item.media.url || '',
                media_type:item.media.media_type || '',
                size:Number(item.media.size) || 0,
                width:Number(item.media.width) || 0,
                height:Number(item.media.height) || 0,
            },
        }));
        return payload;
    }
    function setDraftState(label, kind=''){
        const element = byId('draftState');
        element.textContent = label;
        element.classList.toggle('dirty', kind === 'dirty');
        element.classList.toggle('saved', kind === 'saved');
    }
    function markDirty(){
        if(runtime.readOnlyHistory) return;
        clearReadyToGenerateHint();
        clearWorkbenchErrorStatus();
        runtime.dirty = true;
        if(!runtime.submitLocked) resetSubmissionContext();
        setDraftState('有未保存修改', 'dirty');
    }
    function requiredSlotsFilled(){
        const required = (runtime.currentMode?.reference_images || []).filter(slot => slot.required).map(slot => slot.key);
        const filled = new Set(runtime.inputs.filter(item => item.media?.id).map(item => item.slot_key));
        return required.every(key => filled.has(key));
    }
    async function imageGenerationSaveDraft({silent=false}={}){
        if(!runtime.currentMode || runtime.readOnlyHistory || runtime.saving || !runtime.dirty) return true;
        const modeId = runtime.currentMode.id;
        const payload = currentDraftPayload();
        runtime.pendingDrafts[modeId] = currentLocalDraftPayload();
        saveLocalDrafts();
        if(!requiredSlotsFilled()){
            setDraftState('等待必填图片', 'dirty');
            if(!silent) showToast('已暂存在本机；补齐必填图片后会保存到模式草稿');
        }
        runtime.saving = true;
        setDraftState('保存中…');
        try {
            await requestJson(`/api/image-generation/modes/${encodeURIComponent(modeId)}/draft`, {
                method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload),
            });
            delete runtime.pendingDrafts[modeId];
            saveLocalDrafts();
            runtime.dirty = false;
            setDraftState('已保存', 'saved');
            emitImageGenerationsChanged('draft');
            if(!silent) showToast('草稿已保存');
            return true;
        } catch(error) {
            setDraftState('本机暂存', 'dirty');
            if(!silent) showToast(error.message || '草稿保存失败', true);
            return false;
        } finally { runtime.saving = false; }
    }
    function generationImagesPayload(){
        return runtime.inputs.filter(item => item.media?.id).map(item => ({
            slot_key:item.slot_key, role:item.slot_key, media_id:item.media.id,
            hash:item.media.hash || item.media.id, url:item.media.url || '',
        }));
    }
    function effectiveOutputSize(){
        return resolveGenerationRatio(runtime.settings, runtime.inputs).size;
    }
    function generationTaskPayload(forceNew=false, submissionId=''){
        const ratio = resolveGenerationRatio(runtime.settings, runtime.inputs);
        if(!ratio.valid) throw new Error(ratio.error);
        return {
            mode_id:runtime.currentMode.id,
            images:generationImagesPayload(),
            user_prompt:runtime.userPrompt,
            image_provider_id:runtime.settings.image_provider_id,
            image_model:runtime.settings.image_model,
            ratio_mode:ratio.ratio_mode,
            aspect_ratio:ratio.aspect_ratio,
            custom_ratio_width:String(runtime.settings.custom_ratio_width || ''),
            custom_ratio_height:String(runtime.settings.custom_ratio_height || ''),
            resolution:runtime.settings.resolution || '2k',
            size:ratio.size,
            image_count:Math.max(1, Math.min(6, Number(runtime.settings.image_count) || 1)),
            submission_id:submissionId,
            force_new:Boolean(forceNew),
        };
    }
    async function submitGeneration(){
        if(runtime.submitLocked || runtime.readOnlyHistory || !runtime.currentMode || !currentModeIsActive()) return;
        clearReadyToGenerateHint();
        clearWorkbenchErrorStatus();
        runtime.submitLocked = true;
        const submittedModeId = String(runtime.currentMode.id || '');
        const submittedModeName = String(runtime.currentMode.display_name || '');
        const submissionKind = 'normal';
        const submissionId = submissionIdForKind(runtime.submissionIds, submissionKind, () => crypto.randomUUID());
        let acceptedTaskId = '';
        const button = byId('generateImages');
        const originalHtml = button.innerHTML;
        button.disabled = true;
        byId('generateImages').disabled = true;
        renderInputSlots();
        syncForm();
        try {
            if(!requiredSlotsFilled()) throw new Error('请先补齐模式要求的必填图片');
            if(!runtime.settings.image_provider_id || !runtime.settings.image_model) throw new Error('请先选择可用的图片平台和模型');
            const count = Math.max(1, Math.min(6, Number(runtime.settings.image_count) || 1));
            const taskPayload = generationTaskPayload(true, submissionId);
            const costMessage = `本次将生成 ${count} 张图片，每张都会产生费用。确认继续吗？`;
            if(count > 1 && !confirm(costMessage)) return;
            button.innerHTML = '<i class="status-spinner" data-lucide="loader-circle"></i><span>正在提交…</span>';
            refreshIcons();
            await imageGenerationSaveDraft({silent:true});
            const result = await requestJson('/api/image-generation-tasks', {
                method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(taskPayload),
            });
            const taskId = String(result.task_id || '');
            if(!taskId) throw new Error('服务没有返回任务编号');
            acceptedTaskId = taskId;
            runtime.submissionIds.delete(submissionKind);
            runtime.activeTaskIds.add(taskId);
            try {
                rememberTask({id:taskId, mode_id:submittedModeId, mode_name:submittedModeName, status:result.status || 'queued', group_no:result.group_no, candidate_count:count, created_at:Date.now() / 1000});
                scheduleActivePoll(300);
                if(String(runtime.currentMode?.id || '') === submittedModeId){
                runtime.dirty = false;
                setDraftState('已提交', 'saved');
                    if(!await openTask(taskId)) throw new Error('任务详情刷新失败');
                    if(String(runtime.currentMode?.id || '') === submittedModeId){
                        if(!await loadModeTasks(submittedModeId, {preserveViewed:true})) throw new Error('任务历史刷新失败');
                    }
                }
                renderHall();
                showToast(result.reused ? '本次提交已受理，不会重复扣费' : `已创建分组 ${result.group_no || ''}`);
                emitImageGenerationsChanged(result.reused ? 'task-reused' : 'task-created');
            } catch(refreshError) {
                const message = submissionFailureMessage(taskId, refreshError);
                setWorkbenchStatus(message, true);
                showToast(message, true);
                emitImageGenerationsChanged('task-created-refresh-failed');
            }
        } catch(error) {
            if(acceptedTaskId){
                runtime.submissionIds.delete(submissionKind);
                runtime.activeTaskIds.add(acceptedTaskId);
                const message = submissionFailureMessage(acceptedTaskId, error);
                setWorkbenchStatus(message, true);
                showToast(message, true);
            } else {
                const message = submissionFailureMessage('', error);
                setWorkbenchStatus(message, true);
                showToast(message, true);
            }
        } finally {
            runtime.submitLocked = false;
            button.innerHTML = originalHtml;
            button.disabled = false;
            syncForm();
            renderInputSlots();
            refreshIcons();
        }
    }
    function emitImageGenerationsChanged(reason){
        const detail = {type:'image-generations-changed', reason, mode_id:runtime.currentMode?.id || ''};
        try { window.parent?.postMessage(detail, '*'); } catch(_) {}
        try { const channel = new BroadcastChannel('studio-api'); channel.postMessage(detail); channel.close(); } catch(_) {}
    }

    function slotDefinitions(mode){
        const definitions = (mode?.reference_images || []).map(slot => ({slot_key:String(slot.key), label:String(slot.label || slot.key), required:Boolean(slot.required), extra:false}));
        const maximum = Math.min(6, Number(mode?.max_upload_count) || 6);
        const extras = mode?.allow_extra_images ? Math.min(Number(mode.extra_image_limit) || 0, Math.max(0, maximum - definitions.length)) : 0;
        for(let index = 0; index < extras; index += 1){
            definitions.push({slot_key:`extra-${index + 1}`, label:`附加图 ${index + 1}`, required:false, extra:true});
        }
        return definitions.slice(0, maximum);
    }
    function normalizeInputsForMode(mode, sourceInputs){
        const mediaBySlot = new Map((sourceInputs || []).map(item => [String(item.slot_key || ''), item.media || (item.media_id ? {
            id:item.media_id, url:item.url || '', media_type:item.media_type || '', size:Number(item.size) || 0,
            width:Number(item.width) || 0, height:Number(item.height) || 0,
        } : null)]));
        return slotDefinitions(mode).map(slot => ({...slot, media:mediaBySlot.get(slot.slot_key) || null}));
    }
    function inputModeDefinition(){
        const snapshot = runtime.viewedTask?.mode_snapshot;
        return runtime.readOnlyHistory && snapshot && typeof snapshot === 'object' ? snapshot : runtime.currentMode;
    }
    function uploadRuleDetails(mode){
        const definitions = slotDefinitions(mode || {});
        const requiredSlots = definitions.filter(slot => slot.required);
        const optionalCount = definitions.filter(slot => !slot.required).length;
        const requiredText = requiredSlots.length ? `必传 ${requiredSlots.length} 张` : '无需必传';
        const optionalText = optionalCount ? `可选 +${optionalCount} 张` : '无可选图片';
        const roles = requiredSlots.map((slot, index) => `图${index + 1}为${slot.label}`).join('，');
        const extraText = optionalCount ? `另外可再上传最多${optionalCount}张参考图` : '';
        return {
            countText:`${requiredText} · ${optionalText}`,
            roles:roles ? `${roles}${extraText ? `；${extraText}` : ''}` : extraText,
        };
    }
    function syncInputModeHint(){
        const mode = inputModeDefinition() || {};
        const definitions = slotDefinitions(mode);
        const required = definitions.filter(slot => slot.required).length;
        const optional = definitions.length - required;
        const requiredText = required ? `必传 ${required} 张` : '无需必传';
        const optionalText = optional ? `可选 +${optional} 张` : '无可选图片';
        const details = uploadRuleDetails(mode);
        byId('inputModeHint').textContent = details.countText || `${requiredText} · ${optionalText}`;
        const roles = byId('inputModeRoles');
        byId('inputModeRoles').textContent = details.roles;
        roles.hidden = !details.roles;
    }
    function renderInputSlots(){
        const container = byId('modeInputSlots');
        const editable = !runtime.readOnlyHistory && !runtime.submitLocked;
        const requiredReady = runtime.inputs.filter(slot => slot.required).every(slot => slot.media);
        const firstEmptyOptional = requiredReady ? runtime.inputs.find(slot => !slot.media && !slot.required) : null;
        const visibleSlots = runtime.inputs.filter(slot => slot.required || slot.media || (editable && slot === firstEmptyOptional));
        container.innerHTML = visibleSlots.map(slot => {
            const url = mediaUrl(slot.media);
            const required = slot.required ? '必填' : '可选';
            const addLabel = slot.required ? slot.label : '添加图片';
            const addHint = slot.required ? required : (slot.extra ? required : `${slot.label} · ${required}`);
            return `<div class="input-slot${url ? ' has-media' : ''}" data-slot-key="${escapeHtml(slot.slot_key)}" draggable="${Boolean(url) && editable}" title="${escapeHtml(slot.label)}">
                ${url ? `<img class="slot-image slot-preview-trigger" src="${escapeHtml(url)}" alt="${escapeHtml(slot.label)}" role="button" tabindex="0" data-preview-slot="${escapeHtml(slot.slot_key)}" title="点击查看原图" aria-label="查看${escapeHtml(slot.label)}原图">` : editable ? `<button class="slot-open" type="button" data-upload-slot="${escapeHtml(slot.slot_key)}"><i data-lucide="image-plus"></i><strong>${escapeHtml(addLabel)}</strong><span>${escapeHtml(addHint)}</span></button>` : `<div class="slot-open"><strong>${escapeHtml(slot.label)}</strong><span>${required}</span></div>`}
                ${url ? `<span class="slot-label">${escapeHtml(slot.label)} · ${required}</span>${editable ? `<button class="slot-remove" type="button" data-remove-slot="${escapeHtml(slot.slot_key)}" title="移除图片" aria-label="移除${escapeHtml(slot.label)}"><i data-lucide="x"></i></button>` : ''}` : ''}
            </div>`;
        }).join('');
        container.querySelectorAll('[data-upload-slot]').forEach(button => button.addEventListener('click', () => openSlotPicker(button.dataset.uploadSlot)));
        container.querySelectorAll('[data-remove-slot]').forEach(button => button.addEventListener('click', () => removeSlotMedia(button.dataset.removeSlot)));
        container.querySelectorAll('[data-preview-slot]').forEach(image => {
            const openPreview = () => previewUploadedImage(image.dataset.previewSlot);
            image.addEventListener('click', event => { event.stopPropagation(); openPreview(); });
            image.addEventListener('keydown', event => {
                if(event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault(); event.stopPropagation(); openPreview();
            });
        });
        bindSlotDragEvents();
        refreshIcons();
    }
    function bindSlotDragEvents(){
        document.querySelectorAll('.input-slot').forEach(slot => {
            slot.addEventListener('dragstart', event => {
                if(runtime.readOnlyHistory || !slot.classList.contains('has-media')) return event.preventDefault();
                runtime.draggedSlotKey = slot.dataset.slotKey;
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', runtime.draggedSlotKey);
            });
            slot.addEventListener('dragover', event => {
                event.preventDefault();
                if(runtime.draggedSlotKey) event.dataTransfer.dropEffect = 'move';
                slot.classList.add('drag-over');
            });
            slot.addEventListener('dragleave', () => slot.classList.remove('drag-over'));
            slot.addEventListener('drop', event => {
                event.preventDefault(); slot.classList.remove('drag-over');
                const internalSlotKey = runtime.draggedSlotKey || event.dataTransfer.getData('text/plain');
                const internalDrag = internalSlotKey && runtime.inputs.some(item => item.slot_key === internalSlotKey && item.media);
                if(internalDrag){ reorderSlotMedia(internalSlotKey, slot.dataset.slotKey); return; }
                if(event.dataTransfer.files?.length){ uploadFilesToSlot(event.dataTransfer.files, slot.dataset.slotKey); return; }
            });
            slot.addEventListener('dragend', () => { runtime.draggedSlotKey = ''; });
        });
    }
    function openSlotPicker(slotKey){
        if(runtime.readOnlyHistory || runtime.submitLocked) return;
        runtime.uploadSlotKey = slotKey;
        byId('slotFilePicker').value = '';
        byId('slotFilePicker').click();
    }
    function removeSlotMedia(slotKey){
        if(runtime.readOnlyHistory || runtime.submitLocked) return;
        const slot = runtime.inputs.find(item => item.slot_key === slotKey);
        if(slot){ slot.media = null; markDirty(); renderInputSlots(); syncRatioControls(); }
    }
    function reorderSlotMedia(fromKey, toKey){
        if(runtime.readOnlyHistory || runtime.submitLocked || !fromKey || !toKey || fromKey === toKey) return;
        const sourceIndex = runtime.inputs.findIndex(item => item.slot_key === fromKey);
        const targetIndex = runtime.inputs.findIndex(item => item.slot_key === toKey);
        if(sourceIndex < 0 || targetIndex < 0 || !runtime.inputs[sourceIndex]?.media) return;
        const mediaOrder = runtime.inputs.map(item => item.media);
        const [movedMedia] = mediaOrder.splice(sourceIndex, 1);
        mediaOrder.splice(targetIndex, 0, movedMedia);
        runtime.inputs.forEach((item, index) => { item.media = mediaOrder[index] || null; });
        runtime.draggedSlotKey = '';
        markDirty();
        renderInputSlots();
        syncRatioControls();
    }
    function firstEmptySlot(){ return runtime.inputs.find(slot => !slot.media)?.slot_key || ''; }
    async function uploadFilesToSlot(fileList, requestedSlotKey){
        if(runtime.readOnlyHistory || runtime.submitLocked) return;
        const files = [...(fileList || [])].filter(file => /^image\/(png|jpeg|webp|gif)$/i.test(file.type));
        if(!files.length) return showToast('请选择 PNG、JPEG、WebP 或 GIF 图片', true);
        const available = runtime.inputs.filter(slot => !slot.media || slot.slot_key === requestedSlotKey);
        if(files.length > available.length) return showToast(`当前模式最多还可添加 ${available.length} 张图片`, true);
        const requested = runtime.inputs.find(slot => slot.slot_key === requestedSlotKey);
        const replacedCount = requested?.media ? 1 : 0;
        if(files.length + runtime.inputs.filter(slot => slot.media).length - replacedCount > Number(runtime.currentMode?.max_upload_count || 6)){
            return showToast(`当前模式最多上传 ${runtime.currentMode.max_upload_count} 张图片`, true);
        }
        const form = new FormData();
        files.forEach(file => form.append('files', file, file.name));
        setWorkbenchStatus(`正在保存 ${files.length} 张图片…`);
        try {
            const result = await requestJson('/api/image-generation/media', {method:'POST', body:form});
            const records = Array.isArray(result.items) ? result.items : [];
            const order = [];
            if(requested) order.push(requested);
            runtime.inputs.forEach(slot => { if(!order.includes(slot) && !slot.media) order.push(slot); });
            records.forEach((media, index) => { if(order[index]) order[index].media = media; });
            markDirty();
            renderInputSlots();
            syncRatioControls();
            setWorkbenchStatus('图片已保存到本机素材区');
            await imageGenerationSaveDraft({silent:true});
        } catch(error) {
            setWorkbenchStatus(error.message || '图片上传失败', true);
            showToast(error.message || '图片上传失败', true);
        }
    }

    function examplePromptView(value){
        const text = String(value || '').trim();
        return {text:text || '本案例未填写用户描述', empty:!text};
    }
    function exampleMediaLayout(inputCount, hasOutput){
        if(Number(inputCount) > 0 && hasOutput) return 'comparison';
        if(hasOutput) return 'output-only';
        if(Number(inputCount) > 0) return 'input-only';
        return 'empty';
    }
    function caseImagePreviewFitSize({imageWidth=0, imageHeight=0, viewportWidth=0, viewportHeight=0}={}){
        const width = Math.max(0, Number(imageWidth) || 0);
        const height = Math.max(0, Number(imageHeight) || 0);
        const availableWidth = Math.max(0, Number(viewportWidth) || 0);
        const availableHeight = Math.max(0, Number(viewportHeight) || 0);
        if(!width || !height || !availableWidth || !availableHeight) return {width:0, height:0, scale:0};
        const scale = Math.min(1, availableWidth / width, availableHeight / height);
        return {width:width * scale, height:height * scale, scale};
    }
    function clampCaseImagePreviewPan({x=0, y=0, imageWidth=0, imageHeight=0, viewportWidth=0, viewportHeight=0}={}){
        const maxX = Math.max(0, ((Number(imageWidth) || 0) - (Number(viewportWidth) || 0)) / 2);
        const maxY = Math.max(0, ((Number(imageHeight) || 0) - (Number(viewportHeight) || 0)) / 2);
        return {
            x:Math.max(-maxX, Math.min(maxX, Number(x) || 0)),
            y:Math.max(-maxY, Math.min(maxY, Number(y) || 0)),
        };
    }
    function caseImagePreviewZoomState({scale=1, nextScale=1, panX=0, panY=0, pointerX=0, pointerY=0, imageWidth=0, imageHeight=0, viewportWidth=0, viewportHeight=0, minScale=CASE_PREVIEW_MIN_SCALE, maxScale=CASE_PREVIEW_MAX_SCALE}={}){
        const current = Math.max(Number(minScale) || CASE_PREVIEW_MIN_SCALE, Math.min(Number(maxScale) || CASE_PREVIEW_MAX_SCALE, Number(scale) || 1));
        const next = Math.max(Number(minScale) || CASE_PREVIEW_MIN_SCALE, Math.min(Number(maxScale) || CASE_PREVIEW_MAX_SCALE, Number(nextScale) || current));
        const factor = next / current;
        const pan = clampCaseImagePreviewPan({
            x:Number(pointerX || 0) - (Number(pointerX || 0) - Number(panX || 0)) * factor,
            y:Number(pointerY || 0) - (Number(pointerY || 0) - Number(panY || 0)) * factor,
            imageWidth:(Number(imageWidth) || 0) * next,
            imageHeight:(Number(imageHeight) || 0) * next,
            viewportWidth,
            viewportHeight,
        });
        return {scale:next, panX:pan.x, panY:pan.y};
    }
    function renderExample(){
        const example = runtime.currentMode?.example;
        const container = byId('modeExample');
        const dialogContent = byId('modeExampleDialogContent');
        const viewButton = byId('viewModeExample');
        if(!example){
            container.hidden = true;
            container.innerHTML = '';
            if(dialogContent) dialogContent.innerHTML = '';
            if(viewButton){ viewButton.hidden = true; viewButton.disabled = true; }
            return;
        }
        const inputs = (example.input_media || []).map((item, index) => ({
            media:item.media || item,
            slotKey:String(item.slot_key || `图 ${index + 1}`),
        })).filter(item => mediaUrl(item.media));
        const outputUrl = mediaUrl(example.output_media);
        if(!inputs.length && !outputUrl){
            container.hidden = true;
            container.innerHTML = '';
            if(dialogContent) dialogContent.innerHTML = '';
            if(viewButton){ viewButton.hidden = true; viewButton.disabled = true; }
            return;
        }
        const mode = runtime.currentMode || {};
        const modeLabel = [modeNumber(mode), mode.display_name].filter(Boolean).join(' ');
        const notice = String(example.caption || '').trim();
        // Case descriptions are public by default; the former visibility checkbox
        // is intentionally no longer part of the administrator workflow.
        const promptView = examplePromptView(example.sample_user_prompt);
        const inputMarkup = inputs.map((item, index) => {
            const url = mediaUrl(item.media);
            const alt = `${item.slotKey}示范输入图 ${index + 1}`;
            return `<figure class="example-media-item"><button type="button" class="example-media-frame example-image-trigger" data-example-image="${escapeHtml(url)}" data-example-alt="${escapeHtml(alt)}" aria-label="放大查看${escapeHtml(alt)}"><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy"><span class="example-image-zoom" aria-hidden="true"><i data-lucide="zoom-in"></i></span></button></figure>`;
        }).join('');
        const outputMarkup = outputUrl ? `<figure class="example-media-item example-output-item"><button type="button" class="example-media-frame example-image-trigger" data-example-image="${escapeHtml(outputUrl)}" data-example-alt="示范效果图" aria-label="放大查看示范效果图"><img src="${escapeHtml(outputUrl)}" alt="示范效果图" loading="lazy"><span class="example-image-zoom" aria-hidden="true"><i data-lucide="zoom-in"></i></span></button></figure>` : '';
        const mediaLayout = exampleMediaLayout(inputs.length, Boolean(outputUrl));
        const inputSide = inputs.length ? `<section class="example-media-side example-input-side" aria-label="处理前示范图片"><div class="example-media-grid">${inputMarkup}</div><div class="example-media-label">处理前</div></section>` : '';
        const comparisonArrow = mediaLayout === 'comparison' ? `<div class="example-arrow" aria-hidden="true"><i data-lucide="arrow-right"></i></div>` : '';
        const outputSide = outputUrl ? `<section class="example-media-side example-output-side" aria-label="处理后示范图片"><div class="example-media-grid">${outputMarkup}</div><div class="example-media-label">处理后</div></section>` : '';
        const markup = `<div class="example-case-layout">
            <aside class="example-case-info" aria-label="案例说明">
                ${notice ? `<section class="example-notice" aria-label="注意事项"><h3>注意事项</h3><p>${escapeHtml(notice)}</p></section>` : ''}
                <section class="example-prompt${promptView.empty ? ' is-empty' : ''}" aria-label="用户描述"><h3>用户描述</h3><p>${escapeHtml(promptView.text)}</p></section>
            </aside>
            <div class="example-case-media is-${mediaLayout}" aria-label="案例前后对比">
                ${inputSide}${comparisonArrow}${outputSide}
            </div>
        </div>`;
        const dialogTitle = byId('modeExampleDialogTitle');
        if(dialogTitle) dialogTitle.textContent = modeLabel ? `案例预览 ${modeLabel}` : '案例预览';
        // Keep the legacy container populated for admin/data compatibility, but
        // show the case only from the deliberate header action.
        container.hidden = true;
        container.innerHTML = markup;
        if(dialogContent) dialogContent.innerHTML = markup;
        if(viewButton){
            viewButton.hidden = false;
            viewButton.disabled = false;
            viewButton.title = `查看${runtime.currentMode?.display_name || ''}案例`;
            viewButton.setAttribute('aria-label', viewButton.title);
        }
        refreshIcons();
    }

    function openModeExampleDialog(){
        if(!runtime.currentMode?.example) return;
        const dialog = byId('modeExampleDialog');
        if(!dialog) return;
        renderExample();
        if(!dialog.open) dialog.showModal();
        refreshIcons();
    }

    function notifyCaseImagePreviewHost(active){
        if(typeof window === 'undefined' || window.parent === window) return;
        try {
            window.parent.postMessage({type:'image-generation-case-preview-state', active:Boolean(active)}, window.location.origin || '*');
        } catch(_) {}
    }

    function applyCaseImagePreviewView(){
        const shell = byId('caseImagePreviewDialog')?.querySelector('.case-image-preview-shell');
        const image = byId('caseImagePreview');
        if(!shell || !image || !image.naturalWidth || !image.naturalHeight) return;
        const fit = caseImagePreviewFitSize({
            imageWidth:image.naturalWidth,
            imageHeight:image.naturalHeight,
            viewportWidth:shell.clientWidth,
            viewportHeight:shell.clientHeight,
        });
        const state = runtime.casePreview;
        const wasAtFit = !state.initialized || (Math.abs(state.scale - state.fitScale) < .001 && Math.abs(state.panX) < .5 && Math.abs(state.panY) < .5);
        state.fitScale = fit.scale || 1;
        if(wasAtFit){
            state.scale = state.fitScale;
            state.panX = 0;
            state.panY = 0;
        }
        state.initialized = true;
        const minScale = Math.min(CASE_PREVIEW_MIN_SCALE, state.fitScale);
        state.scale = Math.max(minScale, Math.min(CASE_PREVIEW_MAX_SCALE, Number(state.scale) || state.fitScale));
        const renderedWidth = image.naturalWidth * state.scale;
        const renderedHeight = image.naturalHeight * state.scale;
        const pan = clampCaseImagePreviewPan({
            x:state.panX,
            y:state.panY,
            imageWidth:renderedWidth,
            imageHeight:renderedHeight,
            viewportWidth:shell.clientWidth,
            viewportHeight:shell.clientHeight,
        });
        state.panX = pan.x;
        state.panY = pan.y;
        image.style.width = `${image.naturalWidth}px`;
        image.style.height = `${image.naturalHeight}px`;
        image.style.transform = `translate3d(calc(-50% + ${state.panX}px), calc(-50% + ${state.panY}px), 0) scale(${state.scale})`;
        const canPan = renderedWidth > shell.clientWidth + 1 || renderedHeight > shell.clientHeight + 1;
        shell.classList.toggle('can-pan', canPan);
        image.setAttribute('aria-label', `当前缩放 ${Math.round(state.scale * 100)}%，滚轮缩放${canPan ? '，拖动查看' : ''}，双击关闭`);
    }

    function setCaseImagePreviewZoomAt(nextScale, clientX, clientY){
        const shell = byId('caseImagePreviewDialog')?.querySelector('.case-image-preview-shell');
        const image = byId('caseImagePreview');
        if(!shell || !image || !image.naturalWidth || !image.naturalHeight) return;
        if(!runtime.casePreview.initialized) applyCaseImagePreviewView();
        const rect = shell.getBoundingClientRect();
        const state = caseImagePreviewZoomState({
            scale:runtime.casePreview.scale,
            nextScale,
            panX:runtime.casePreview.panX,
            panY:runtime.casePreview.panY,
            pointerX:Number(clientX) - rect.left - rect.width / 2,
            pointerY:Number(clientY) - rect.top - rect.height / 2,
            imageWidth:image.naturalWidth,
            imageHeight:image.naturalHeight,
            viewportWidth:shell.clientWidth,
            viewportHeight:shell.clientHeight,
            minScale:Math.min(CASE_PREVIEW_MIN_SCALE, runtime.casePreview.fitScale || 1),
            maxScale:CASE_PREVIEW_MAX_SCALE,
        });
        Object.assign(runtime.casePreview, state);
        applyCaseImagePreviewView();
    }

    function panCaseImagePreviewBy(deltaX, deltaY){
        const shell = byId('caseImagePreviewDialog')?.querySelector('.case-image-preview-shell');
        const image = byId('caseImagePreview');
        if(!shell?.classList.contains('can-pan') || !image?.naturalWidth || !image?.naturalHeight) return false;
        const state = runtime.casePreview;
        const pan = clampCaseImagePreviewPan({
            x:state.panX + Number(deltaX || 0),
            y:state.panY + Number(deltaY || 0),
            imageWidth:image.naturalWidth * state.scale,
            imageHeight:image.naturalHeight * state.scale,
            viewportWidth:shell.clientWidth,
            viewportHeight:shell.clientHeight,
        });
        state.panX = pan.x;
        state.panY = pan.y;
        applyCaseImagePreviewView();
        return true;
    }

    function openCaseImagePreview(url, alt='案例图片'){
        const dialog = byId('caseImagePreviewDialog');
        const image = byId('caseImagePreview');
        const source = String(url || '').trim();
        if(!dialog || !image || !source) return;
        Object.assign(runtime.casePreview, {scale:1, fitScale:1, initialized:false, panX:0, panY:0, dragging:false, pointerId:null});
        image.onload = applyCaseImagePreviewView;
        image.src = source;
        image.alt = String(alt || '案例图片');
        document.body.classList.add('case-image-preview-active');
        notifyCaseImagePreviewHost(true);
        if(!dialog.open) dialog.showModal();
        if(image.complete) applyCaseImagePreviewView();
        refreshIcons();
    }

    function closeCaseImagePreview(){
        const dialog = byId('caseImagePreviewDialog');
        if(dialog?.open) dialog.close();
    }

    function providerList(){ return (runtime.config.api_providers || []).filter(provider => provider?.enabled !== false && Array.isArray(provider.image_models) && provider.image_models.length); }
    function renderProviderOptions(){
        const providers = providerList();
        const currentProviderExists = providers.some(provider => String(provider.id) === String(runtime.settings.image_provider_id));
        if(!currentProviderExists && !runtime.settings.image_provider_id){
            runtime.settings.image_provider_id = String(providers[0]?.id || '');
        }
        const missingProvider = runtime.settings.image_provider_id && !currentProviderExists
            ? `<option value="${escapeHtml(runtime.settings.image_provider_id)}">${escapeHtml(runtime.settings.image_provider_id)}（当前不可用）</option>` : '';
        byId('imageProvider').innerHTML = providers.length || missingProvider ? missingProvider + providers.map(provider => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name || provider.id)}</option>`).join('') : '<option value="">请先配置图片模型</option>';
        byId('imageProvider').value = runtime.settings.image_provider_id;
        renderModelOptions();
    }
    function renderModelOptions(){
        const provider = providerList().find(item => String(item.id) === String(runtime.settings.image_provider_id));
        const models = provider?.image_models || [];
        let currentModelExists = models.includes(runtime.settings.image_model);
        if(!currentModelExists && !runtime.settings.image_model){
            runtime.settings.image_model = String(models[0] || '');
            currentModelExists = models.includes(runtime.settings.image_model);
        }
        const missingModel = runtime.settings.image_model && !currentModelExists
            ? `<option value="${escapeHtml(runtime.settings.image_model)}">${escapeHtml(runtime.settings.image_model)}（当前不可用）</option>` : '';
        byId('imageModel').innerHTML = models.length || missingModel ? missingModel + models.map(model => `<option value="${escapeHtml(model)}">${escapeHtml(provider?.model_names?.[model] || model)}</option>`).join('') : '<option value="">未配置图片模型</option>';
        byId('imageModel').value = runtime.settings.image_model;
        byId('generateImages').disabled = runtime.readOnlyHistory || !provider || !currentModelExists;
    }
    function ratioSelectValue(){
        const normalized = normalizeGenerationRatioSettings(runtime.settings);
        return normalized.ratio_mode === 'fixed' ? normalized.aspect_ratio : normalized.ratio_mode;
    }
    function syncRatioControls(){
        const normalized = normalizeGenerationRatioSettings(runtime.settings);
        const selector = byId('aspectRatio');
        selector.value = ratioSelectValue();
        if(!selector.value){
            runtime.settings.ratio_mode = 'fixed';
            runtime.settings.aspect_ratio = '1:1';
            selector.value = '1:1';
        }
        const customFields = byId('customRatioFields');
        customFields.hidden = normalized.ratio_mode !== 'custom';
        byId('customRatioWidth').value = normalized.custom_ratio_width;
        byId('customRatioHeight').value = normalized.custom_ratio_height;
        const hint = byId('sourceRatioHint');
        const hintView = ratioHintView(runtime.settings, runtime.inputs);
        hint.hidden = hintView.hidden;
        hint.classList.toggle('error', hintView.error);
        hint.textContent = hintView.text;
    }
    function syncForm(){
        byId('userPrompt').value = runtime.userPrompt;
        syncUserPromptEditorFromRuntime();
        syncRatioControls();
        byId('resolution').value = runtime.settings.resolution || '2k';
        byId('imageCount').value = String(runtime.settings.image_count || 1);
        renderProviderOptions();
        const modeActive = currentModeIsActive();
        const controlsLocked = runtime.readOnlyHistory || runtime.submitLocked || !modeActive;
        byId('inputPanel').classList.toggle('read-only', controlsLocked);
        byId('historyReadOnlyNotice').hidden = !runtime.readOnlyHistory;
        const historyNotice = byId('historyReadOnlyNotice').querySelector('span');
        if(historyNotice) historyNotice.textContent = modeActive ? '历史记录不会覆盖本模式保存的草稿。' : '这个模式已归档，只能查看当时的输入和结果。';
        byId('createDraftFromTask').disabled = runtime.submitLocked || !modeActive;
        byId('newGenerationDraft').disabled = runtime.submitLocked || !modeActive;
        byId('userPrompt').readOnly = controlsLocked;
        for(const id of ['imageProvider','imageModel','aspectRatio','customRatioWidth','customRatioHeight','resolution','imageCount']) byId(id).disabled = controlsLocked;
        byId('saveDraft').disabled = controlsLocked;
        const provider = providerList().find(item => String(item.id) === String(runtime.settings.image_provider_id));
        byId('generateImages').disabled = controlsLocked || !provider || !(provider.image_models || []).includes(runtime.settings.image_model);
        syncGenerateButtonLabel();
    }
    function syncGenerateButtonLabel(){
        byId('generateImages').querySelector('span').textContent = `生成 ${Math.max(1, Math.min(6, Number(runtime.settings.image_count) || 1))} 张`;
    }
    function blankDraft(){
        resetSubmissionContext();
        clearReadyToGenerateHint();
        runtime.inputs = normalizeInputsForMode(runtime.currentMode, []);
        runtime.userPrompt = '';
        runtime.settings = {...DEFAULT_SETTINGS};
        runtime.readOnlyHistory = false;
        runtime.dirty = false;
    }
    function applyDraft(draft){
        resetSubmissionContext();
        clearReadyToGenerateHint();
        const source = draft || {};
        runtime.inputs = normalizeInputsForMode(runtime.currentMode, source.inputs || []);
        runtime.userPrompt = String(source.user_prompt || '');
        runtime.settings = normalizeRuntimeSettings(source.generation_settings || {});
        runtime.readOnlyHistory = false;
        runtime.dirty = false;
        setDraftState(source.updated_at ? '已恢复草稿' : '本机暂存', 'saved');
    }
    function applyTaskAsReadonly(task){
        resetSubmissionContext();
        clearReadyToGenerateHint();
        const modeSnapshot = task?.mode_snapshot && typeof task.mode_snapshot === 'object' ? task.mode_snapshot : runtime.currentMode;
        runtime.inputs = normalizeInputsForMode(modeSnapshot, task?.inputs || []);
        runtime.userPrompt = String(task?.user_prompt || '');
        runtime.settings = normalizeRuntimeSettings(task?.generation_settings || {});
        runtime.readOnlyHistory = true;
        runtime.dirty = false;
        setDraftState('历史只读');
    }
    function fromTaskInputs(){
        applyTaskAsEditable(runtime.viewedTask, '由历史创建');
    }
    function applyTaskAsEditable(task, draftLabel='已重新输入'){
        if(!task) return;
        if(!currentModeIsActive()) return showToast('这个模式已归档，不能再创建生成草稿', true);
        resetSubmissionContext();
        runtime.inputs = normalizeInputsForMode(runtime.currentMode, task.inputs || []);
        runtime.userPrompt = String(task.user_prompt || '');
        runtime.settings = normalizeRuntimeSettings(task.generation_settings || {});
        runtime.readOnlyHistory = false;
        runtime.dirty = true;
        renderWorkbenchInputs();
        setDraftState(draftLabel, 'dirty');
    }
    async function reuseTaskInputs(taskId){
        if(!currentModeIsActive()) return showToast('这个模式已归档，不能重新输入', true);
        let task = runtime.taskCache.get(taskId);
        if(!task && runtime.viewedTask?.id === taskId) task = runtime.viewedTask;
        try {
            if(!task || !Array.isArray(task.inputs) || !task.generation_settings){
                task = await requestJson(`/api/image-generation-tasks/${encodeURIComponent(taskId)}`);
            }
            if(String(task?.mode_id || '') !== String(runtime.currentMode?.id || '')) return showToast('这条记录不属于当前模式', true);
            applyTaskAsEditable(task, '参数已载入');
            showReadyToGenerateHint();
        } catch(error) { showToast(error.message || '重新输入失败', true); }
    }
    function startNewDraft(){
        if(!currentModeIsActive()) return showToast('这个模式已归档，不能新建生成任务', true);
        resetSubmissionContext();
        blankDraft();
        renderWorkbenchInputs();
        runtime.dirty = true;
        setDraftState('新草稿', 'dirty');
    }
    function renderWorkbenchInputs(){ syncInputModeHint(); renderInputSlots(); syncForm(); }

    function candidateImage(candidate){ return candidate?.image || candidate?.result || null; }
    function candidateFailureView(candidate){
        const raw = String(candidate?.error || '').trim();
        if(!raw) return {summary:'生成失败', detail:'上游未返回具体失败原因'};
        if(/insufficient_user_quota|预扣费额度失败|(?:余额|额度)不足/i.test(raw)){
            const remaining = raw.match(/剩余额度\s*[:：]\s*([^,，\s)]+)/i)?.[1] || '';
            const required = raw.match(/需要预扣费额度\s*[:：]\s*([^,，\s)]+)/i)?.[1] || '';
            const amounts = remaining && required ? `：剩余额度 ${remaining}，需要 ${required}` : '';
            return {summary:'额度不足，生成未完成', detail:`上游账户额度不足${amounts}。请充值后重试。`};
        }
        const embedded = raw.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/i)?.[1] || '';
        let detail = raw;
        if(embedded){
            try { detail = JSON.parse(`"${embedded}"`); }
            catch(_) { detail = embedded.replace(/\\"/g, '"'); }
        }
        detail = String(detail)
            .replace(/\s*\(request id:[^)]+\)/gi, '')
            .replace(/\s*request id\s*[:：]\s*\S+/gi, '')
            .replace(/用户\[[^\]]+\]\s*/g, '')
            .replace(/\s+/g, ' ')
            .trim() || '上游未返回具体失败原因';
        const summary = detail.length > 44 ? `${detail.slice(0, 44)}…` : detail;
        return {summary, detail};
    }
    function resultItemSelectable(item){
        return Boolean(item?.candidateId && (item?.url || item?.status === 'failed'));
    }
    function resultItemDownloadable(item){
        return Boolean(item?.candidateId && item?.url && item?.status === 'succeeded');
    }
    function modeTaskRecords(){
        const modeId = String(runtime.currentMode?.id || '');
        const records = new Map();
        for(const task of runtime.tasks || []){
            if(!task?.id || (modeId && String(task.mode_id || '') !== modeId)) continue;
            const cached = runtime.taskCache.get(task.id) || {};
            records.set(String(task.id), {...task, ...cached});
        }
        if(runtime.viewedTask?.id && (!modeId || String(runtime.viewedTask.mode_id || '') === modeId)){
            const current = records.get(String(runtime.viewedTask.id)) || {};
            records.set(String(runtime.viewedTask.id), {...current, ...runtime.viewedTask});
        }
        return [...records.values()].sort((a, b) => Number(b.updated_at || b.created_at || 0) - Number(a.updated_at || a.created_at || 0));
    }
    function resultItems(){
        return modeTaskRecords().flatMap(task => (Array.isArray(task.candidates) ? task.candidates : []).map((candidate, index) => {
            const image = candidateImage(candidate);
            const url = mediaUrl(image);
            const width = Number(image?.width) || 4;
            const height = Number(image?.height) || 3;
            return {
                task, candidate, image, url,
                status:String(candidate?.status || 'queued'),
                index, taskId:String(task.id || ''), candidateId:String(candidate?.id || ''),
                key:`${String(task.id || '')}:${String(candidate?.id || '')}`,
                ratio:width > 0 && height > 0 ? width / height : 4 / 3,
            };
        }));
    }
    function galleryRatio(value){
        return Math.max(.55, Math.min(3.2, Number(value) || 4 / 3));
    }
    function galleryRows(items){
        const rows = [];
        let row = [];
        items.forEach(item => {
            if(row.length >= RESULT_GALLERY_MAX_ITEMS_PER_ROW){ rows.push(row); row = []; }
            row.push(item);
        });
        if(row.length) rows.push(row);
        return rows;
    }
    function galleryRowMetrics(row){
        const ratios = (row || []).map(item => galleryRatio(item?.ratio));
        const ratioTotal = ratios.reduce((sum, ratio) => sum + ratio, 0);
        const dimensionCap = ratios.length
            ? Math.min(...ratios.map(ratio => Math.min(RESULT_MEDIA_MAX_SIZE, RESULT_MEDIA_MAX_SIZE / ratio)))
            : RESULT_MEDIA_MAX_SIZE;
        return {ratios, ratioTotal, dimensionCap};
    }
    function calculateResultGalleryRowSize({containerWidth=0, itemRatios=[], viewportHeight=0, gap=RESULT_GALLERY_GAP}={}){
        const ratios = (itemRatios || []).map(galleryRatio);
        if(!ratios.length) return {height:0, widths:[], ratioTotal:0, dimensionCap:RESULT_MEDIA_MAX_SIZE};
        const safeGap = Math.max(0, Number(gap) || RESULT_GALLERY_GAP);
        const ratioTotal = ratios.reduce((sum, ratio) => sum + ratio, 0);
        const availableWidth = Math.max(0, (Number(containerWidth) || 0) - safeGap * Math.max(0, ratios.length - 1));
        const viewportHeightValue = Number(viewportHeight) || 0;
        const viewportCap = viewportHeightValue > 0
            ? Math.min(RESULT_MEDIA_MAX_SIZE, Math.max(1, viewportHeightValue - RESULT_GALLERY_VERTICAL_RESERVE))
            : RESULT_MEDIA_MAX_SIZE;
        const dimensionCap = Math.min(...ratios.map(ratio => Math.min(RESULT_MEDIA_MAX_SIZE, RESULT_MEDIA_MAX_SIZE / ratio)));
        const widthCap = availableWidth > 0 ? availableWidth / ratioTotal : dimensionCap;
        const height = Math.max(1, Math.min(viewportCap, dimensionCap, widthCap));
        return {height, widths:ratios.map(ratio => ratio * height), ratioTotal, dimensionCap};
    }
    function syncResultGalleryLayout(container=byId('modeResults')){
        const rows = container?.querySelectorAll?.('.candidate-gallery-row') || [];
        const viewportHeight = Number(globalThis.innerHeight || document.documentElement?.clientHeight || 0);
        rows.forEach(row => {
            const items = [...row.children].filter(item => item?.classList?.contains('candidate-item'));
            if(!items.length) return;
            const ratios = items.map(item => galleryRatio(item.dataset.galleryRatio || item.style.getPropertyValue('--item-ratio')));
            const computedStyle = typeof getComputedStyle === 'function' ? getComputedStyle(row) : null;
            const gap = Number.parseFloat(computedStyle?.columnGap || computedStyle?.gap || '') || RESULT_GALLERY_GAP;
            const size = calculateResultGalleryRowSize({containerWidth:row.clientWidth, itemRatios:ratios, viewportHeight, gap});
            row.style.setProperty('--row-height', `${size.height}px`);
            items.forEach((item, index) => {
                item.style.setProperty('--item-width', `${size.widths[index]}px`);
                item.style.setProperty('--item-height', `${size.height}px`);
            });
            row.classList.add('is-sized');
        });
    }
    function scheduleResultGalleryLayout(){
        if(runtime.resultGalleryResizeScheduled) return;
        runtime.resultGalleryResizeScheduled = true;
        const flush = () => {
            runtime.resultGalleryResizeScheduled = false;
            syncResultGalleryLayout();
        };
        if(typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(flush);
        else globalThis.setTimeout(flush, 0);
    }
    function bindResultGalleryResizeObserver(){
        const container = byId('modeResults');
        if(!container || typeof globalThis.ResizeObserver !== 'function') return;
        runtime.resultGalleryResizeObserver?.disconnect?.();
        runtime.resultGalleryResizeObserver = new globalThis.ResizeObserver(() => scheduleResultGalleryLayout());
        runtime.resultGalleryResizeObserver.observe(container);
    }
    function taskActionsHtml(task){
        const cancel = ACTIVE_TASK_STATUSES.has(String(task.status || ''))
            ? `<button type="button" data-task-action="cancel" data-task-id="${escapeHtml(task.id)}" title="停止本地等待" aria-label="停止本地等待"><i data-lucide="square"></i></button>` : '';
        const canDownload = taskVisualStatus(task) !== 'deleted' && candidateStats(task).succeeded > 0;
        return `<div class="result-task-tools">${cancel}
            <button type="button" data-task-action="rename" data-task-id="${escapeHtml(task.id)}" title="修改分组名称" aria-label="修改分组名称"><i data-lucide="pencil"></i></button>
            <button type="button" data-task-action="download" data-task-id="${escapeHtml(task.id)}" title="${canDownload ? '下载全部成功图片' : '当前没有可下载图片'}" aria-label="下载全部成功图片" ${canDownload ? '' : 'disabled'}><i data-lucide="archive"></i></button>
            <button type="button" data-task-action="delete" data-task-id="${escapeHtml(task.id)}" title="删除分组" aria-label="删除分组"><i data-lucide="trash-2"></i></button>
        </div>`;
    }

    async function downloadTaskResults(taskId){
        const response = await fetch(`/api/image-generation-tasks/${encodeURIComponent(taskId)}/download.zip`, {cache:'no-store'});
        if(!response.ok){
            let detail = '';
            try { detail = String((await response.json())?.detail || ''); } catch(_) {}
            throw new Error(detail || `下载失败（HTTP ${response.status}）`);
        }
        const blob = await response.blob();
        const disposition = response.headers.get('content-disposition') || '';
        const match = disposition.match(/filename="?([^";]+)"?/i);
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = match?.[1] || 'image-generation.zip';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    }
    function candidateActionsHtml(task, candidate, url){
        const candidateId = escapeHtml(candidate.id || '');
        const taskId = escapeHtml(task.id || '');
        const actions = [];
        const canGenerate = currentModeIsActive();
        if(url){
            actions.push(`<a href="${escapeHtml(url)}" download title="下载图片" aria-label="下载图片"><i data-lucide="download"></i></a>`);
            if(runtime.admin.active && candidate.status === 'succeeded') actions.push(`<button type="button" data-candidate-action="set-example" data-task-id="${taskId}" data-candidate-id="${candidateId}" title="设为模式示范" aria-label="设为模式示范"><i data-lucide="images"></i></button>`);
            if(canGenerate) actions.push(`<button type="button" data-candidate-action="reuse-inputs" data-task-id="${taskId}" data-candidate-id="${candidateId}" title="再次生成" aria-label="再次生成"><i data-lucide="refresh-cw"></i></button>`);
        } else if(unknownCandidateAction(candidate) === 'recover'){
            actions.push(`<button type="button" data-candidate-action="recover" data-task-id="${taskId}" data-candidate-id="${candidateId}" title="只查询上游结果，不重新生图" aria-label="回补查询"><i data-lucide="search"></i></button>`);
        } else if(canGenerate && ['failed','cancelled'].includes(candidate.status)){
            actions.push(`<button type="button" data-candidate-action="regenerate" data-task-id="${taskId}" data-candidate-id="${candidateId}" title="重新生成（会产生费用）" aria-label="重新生成"><i data-lucide="refresh-cw"></i></button>`);
        }
        return actions.length ? `<div class="candidate-actions">${actions.join('')}</div>` : '';
    }
    function renderGalleryItem(item, itemIndex){
        const {task, candidate, url, status, taskId, candidateId, key, ratio} = item;
        const selected = runtime.selectedResultKeys.has(key);
        const selectable = resultItemSelectable(item);
        const failure = status === 'failed' ? candidateFailureView(candidate) : null;
        const galleryItemRatio = galleryRatio(ratio);
        const unknownReason = status === 'unknown' ? candidateUnknownReason(candidate) : '';
        const elapsedStart = candidateElapsedStart(task, candidate);
        const elapsedMarkup = ACTIVE_TASK_STATUSES.has(status) && elapsedStart
            ? `<span class="candidate-elapsed" data-candidate-elapsed-start="${elapsedStart}">${formatElapsedDuration(Date.now() - elapsedStart)}</span>`
            : '';
        const imageMarkup = url
            ? `<img class="candidate-preview-trigger" src="${escapeHtml(url)}" alt="生成结果 ${itemIndex + 1}" data-candidate-action="preview" data-task-id="${escapeHtml(taskId)}" data-candidate-id="${escapeHtml(candidateId)}" title="点击预览；Ctrl + 鼠标左键快速多选">`
            : failure
                ? `<div class="candidate-placeholder candidate-failure" data-candidate-action="failed-record" data-task-id="${escapeHtml(taskId)}" data-candidate-id="${escapeHtml(candidateId)}" title="Ctrl + 鼠标左键快速多选"><i data-lucide="circle-x"></i><strong>失败</strong><span class="candidate-failure-summary">${escapeHtml(failure.summary)}</span><details class="candidate-failure-details"><summary>查看详情</summary><p>${escapeHtml(failure.detail)}</p></details></div>`
                : `<div class="candidate-placeholder${status === 'unknown' ? ' candidate-unknown' : ''}"${unknownReason ? ` title="${escapeHtml(unknownReason)}"` : ''}><i class="${ACTIVE_TASK_STATUSES.has(status) ? 'status-spinner' : ''}" data-lucide="${status === 'unknown' ? 'circle-help' : 'loader-circle'}"></i><strong>${escapeHtml(candidateStatusLabel(candidate))}</strong>${elapsedMarkup}${unknownReason ? `<span class="candidate-unknown-reason">${escapeHtml(unknownReason)}</span>` : ''}</div>`;
        const selectLabel = status === 'failed' ? '选择记录' : '选择图片';
        const selectButton = selectable
            ? `<button class="candidate-select-action" type="button" data-candidate-action="select" data-task-id="${escapeHtml(taskId)}" data-candidate-id="${escapeHtml(candidateId)}" aria-pressed="${selected}" title="${selected ? '取消选择' : selectLabel}"><i data-lucide="${selected ? 'check' : 'mouse-pointer-2'}"></i><span>${selected ? '已选' : selectLabel}</span></button>` : '';
        return `<div class="candidate-item ${escapeHtml(status)}${selectable ? ' selectable' : ''}${selected ? ' selected' : ''}" data-result-key="${escapeHtml(key)}" data-gallery-ratio="${galleryItemRatio.toFixed(4)}" style="--item-ratio:${galleryItemRatio.toFixed(4)}">${imageMarkup}${selectButton}${!url && !failure ? `<span class="candidate-state">${escapeHtml(candidateStatusLabel(candidate))}</span>` : ''}${candidateActionsHtml(task, candidate, url)}</div>`;
    }
    function resultSelectionLabel(count){
        const selectedCount = Math.max(0, Number(count) || 0);
        return selectedCount ? `已选 ${selectedCount} 张` : '';
    }
    function resultSelectionAction(count){
        const clearsSelection = Math.max(0, Number(count) || 0) > 0;
        return {
            clearsSelection,
            icon:clearsSelection ? 'x' : 'check-check',
            label:clearsSelection ? '取消选择' : '全选',
        };
    }
    function isResultQuickSelect(action, event){
        return ['preview','failed-record'].includes(action) && Boolean(event?.ctrlKey) && Number(event?.button ?? 0) === 0;
    }
    function syncResultQuickSelectCursor(active){
        document.documentElement.classList.toggle('result-quick-select', Boolean(active));
    }
    function syncResultManageBar(items=resultItems()){
        const bar = byId('resultManageBar');
        if(!bar) return;
        const selectable = items.filter(resultItemSelectable);
        const validKeys = new Set(selectable.map(item => item.key));
        runtime.selectedResultKeys.forEach(key => { if(!validKeys.has(key)) runtime.selectedResultKeys.delete(key); });
        const selectedCount = [...runtime.selectedResultKeys].filter(key => validKeys.has(key)).length;
        const selectedDownloadableCount = items.filter(item => runtime.selectedResultKeys.has(item.key) && resultItemDownloadable(item)).length;
        const resultTitle = document.querySelector('.workbench-header-actions > .result-panel-title');
        if(resultTitle) resultTitle.hidden = selectedCount > 0;
        byId('resultSelectionCount').textContent = resultSelectionLabel(selectedCount);
        const selectAll = byId('selectAllResults');
        if(selectAll){
            const selectionAction = resultSelectionAction(selectedCount);
            selectAll.innerHTML = `<i data-lucide="${selectionAction.icon}"></i><span>${selectionAction.label}</span>`;
            selectAll.dataset.hasSelection = String(selectionAction.clearsSelection);
            selectAll.setAttribute('aria-label', selectionAction.label);
            selectAll.title = selectionAction.label;
            selectAll.disabled = runtime.resultBatchDeleting;
        }
        const deleteButton = byId('deleteSelectedResults');
        if(deleteButton){
            const deleteLabel = runtime.resultBatchDeleting ? '删除中…' : '删除所选';
            deleteButton.disabled = selectedCount === 0 || runtime.resultBatchDeleting;
            deleteButton.innerHTML = `<i class="${runtime.resultBatchDeleting ? 'status-spinner' : ''}" data-lucide="${runtime.resultBatchDeleting ? 'loader-circle' : 'trash-2'}"></i><span>${deleteLabel}</span>`;
        }
        const downloadButton = byId('downloadSelectedResults');
        if(downloadButton) downloadButton.disabled = selectedDownloadableCount === 0 || runtime.resultBatchDeleting;
        refreshIcons();
    }
    function renderResults(){
        const container = byId('modeResults');
        const resultCount = byId('resultCount');
        const items = resultItems();
        if(!items.length){
            if(resultCount) resultCount.textContent = '0 张';
            container.innerHTML = `<div class="result-empty"><i data-lucide="image"></i><strong>还没有生成记录</strong><span>配置图片和描述后可在这里查看结果</span></div>`;
            syncResultManageBar(items); syncCandidateElapsedTimer(); refreshIcons(); return;
        }
        const successful = items.filter(item => item.status === 'succeeded' && item.url).length;
        const activeTasks = modeTaskRecords().filter(task => ACTIVE_TASK_STATUSES.has(String(task.status || ''))).length;
        if(resultCount) resultCount.textContent = `${successful} 张${activeTasks ? ` · ${activeTasks} 个任务进行中` : ''}`;
        const rows = galleryRows(items);
        container.innerHTML = `<div class="candidate-gallery">${rows.map(row => {
            const metrics = galleryRowMetrics(row);
            return `<div class="candidate-gallery-row${row.length === 1 ? ' single' : ''}" data-ratio-total="${metrics.ratioTotal.toFixed(4)}" data-dimension-cap="${metrics.dimensionCap.toFixed(4)}">${row.map(item => renderGalleryItem(item, items.indexOf(item))).join('')}</div>`;
        }).join('')}</div>`;
        syncResultManageBar(items);
        bindResultActions();
        syncCandidateElapsedTimer();
        refreshIcons();
        syncResultGalleryLayout(container);
    }
    function candidateFromTask(task, candidateId){ return (task?.candidates || []).find(item => String(item?.id || '') === String(candidateId || '')); }
    function toggleResultSelection(key, selected){
        if(!key || runtime.resultBatchDeleting) return;
        if(selected === undefined) selected = !runtime.selectedResultKeys.has(key);
        if(selected) runtime.selectedResultKeys.add(key); else runtime.selectedResultKeys.delete(key);
        renderResults();
    }
    function clearResultSelection(){
        runtime.selectedResultKeys.clear();
        renderResults();
    }
    function downloadSelectedResults(){
        if(runtime.resultBatchDeleting) return;
        const selected = resultItems().filter(item => resultItemDownloadable(item) && runtime.selectedResultKeys.has(item.key));
        if(!selected.length) return showToast('选中记录中没有可下载图片', true);
        selected.forEach(item => {
            const link = document.createElement('a');
            link.href = item.url;
            link.download = '';
            link.rel = 'noopener';
            document.body.appendChild(link);
            link.click();
            link.remove();
        });
        showToast(`已开始下载 ${selected.length} 张图片`);
    }
    async function deleteSelectedResults(){
        if(runtime.resultBatchDeleting) return;
        const selected = resultItems().filter(item => resultItemSelectable(item) && runtime.selectedResultKeys.has(item.key));
        if(!selected.length) return showToast('请先选择要删除的图片', true);
        if(!confirm(`确定删除已选择的 ${selected.length} 张图片吗？删除后不可在本模式记录中恢复。`)) return;
        runtime.resultBatchDeleting = true;
        syncResultManageBar();
        try {
            const response = await requestJson('/api/image-generation-tasks/candidates/delete', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({items:selected.map(item => ({task_id:item.taskId, candidate_id:item.candidateId}))}),
            });
            (response?.tasks || []).forEach(task => {
                adoptTaskSnapshot(task, {makeViewed:runtime.viewedTask?.id === task.id});
            });
            forgetImageGenerationTasks(response?.deleted_task_ids || []);
            selected.forEach(item => runtime.selectedResultKeys.delete(item.key));
            const deletedCount = Number(response?.deleted) || selected.length;
            renderResults(); renderHistory(); renderGlobalHistory(); renderHall();
            queueStorageCleanupJob(response?.cleanup_job_id, {
                queuedMessage:`已删除 ${deletedCount} 张图片，正在移入 Windows 回收站`,
                successMessage:'图片已移入 Windows 回收站',
            });
            emitImageGenerationsChanged('delete-candidates');
        } catch(error) {
            showToast(error.message || '删除所选图片失败', true);
        } finally {
            runtime.resultBatchDeleting = false;
            renderResults();
        }
    }
    function bindResultActions(){
        byId('modeResults').querySelectorAll('[data-candidate-action]').forEach(button => button.addEventListener('click', event => {
            const action = button.dataset.candidateAction;
            const resultKey = button.closest('[data-result-key]')?.dataset.resultKey || '';
            if(action === 'select'){
                event.preventDefault();
                event.stopPropagation();
            }
            if(isResultQuickSelect(action, event)){
                event.preventDefault();
                event.stopPropagation();
                toggleResultSelection(resultKey);
                return;
            }
            handleCandidateAction(action, button.dataset.taskId, button.dataset.candidateId, resultKey);
        }));
        byId('modeResults').querySelectorAll('[data-task-action]').forEach(button => button.addEventListener('click', () => handleTaskAction(button.dataset.taskAction, button.dataset.taskId)));
    }
    function previewSourceUrl(task){
        for(const item of task?.inputs || []){
            const media = item?.media || item;
            const url = typeof media === 'string' ? media : mediaUrl(media);
            if(url) return url;
        }
        return '';
    }
    const PREVIEW_MODES = new Set(['single','slider','side-by-side']);
    const PREVIEW_ALIGN_MODES = new Set(['fit','stretch','width','height']);
    let previewZoom = 1;
    let previewPan = {x:0, y:0};
    let previewPanDrag = null;
    let previewSpacePanHeld = false;
    let previewSliderPointerId = null;
    let previewSliderFrame = 0;
    let previewSliderPendingX = null;
    function previewPointerIntent({mode='single', zoom=1, spaceHeld=false, button=0}={}){
        if(Number(button) !== 0) return '';
        if(spaceHeld) return Number(zoom) > 1.001 ? 'pan' : 'blocked';
        return mode === 'slider' ? 'slider' : '';
    }
    function previewImageRenderLayout(align='fit', zoom=1){
        const selected = PREVIEW_ALIGN_MODES.has(align) ? align : 'fit';
        const scale = Math.max(.35, Math.min(6, Number(zoom) || 1));
        const size = `${Math.round(scale * 10000) / 100}%`;
        return {
            width:selected === 'height' ? 'auto' : size,
            height:selected === 'width' ? 'auto' : size,
            maxWidth:'none',
            maxHeight:'none',
            objectFit:selected === 'stretch' ? 'fill' : 'contain',
        };
    }
    function previewSpacePanShortcutTarget(target){
        return typeof Element !== 'undefined'
            && target instanceof Element
            && Boolean(target.closest('textarea, select, input:not([type="range"]), [contenteditable]:not([contenteditable="false"])'));
    }
    function previewStage(){ return byId('previewStage'); }
    function previewPanzoom(){ return previewStage()?.querySelector('.preview-panzoom'); }
    function updatePreviewZoomLabel(){
        const label = byId('previewZoomLabel');
        if(label) label.textContent = `${Math.round(previewZoom * 100)}%`;
    }
    function linkedSidePreviewZoomState(currentZoom=1, currentPan={x:0, y:0}, nextZoom=1){
        const zoom = Math.max(1, Math.min(6, Number(nextZoom) || 1));
        if(zoom <= 1.001) return {zoom:1, pan:{x:0, y:0}};
        const baseZoom = Math.max(1, Number(currentZoom) || 1);
        const ratio = zoom / baseZoom;
        return {
            zoom,
            pan:{
                x:(Number(currentPan?.x) || 0) * ratio,
                y:(Number(currentPan?.y) || 0) * ratio,
            },
        };
    }
    function applyPreviewTransform(){
        const stage = previewStage();
        const frame = previewPanzoom();
        const linkedTransform = `translate3d(${previewPan.x}px, ${previewPan.y}px, 0)`;
        if(frame) frame.style.transform = '';
        applyPreviewImageLayout();
        [byId('previewImage'), byId('previewSourceImage')].forEach(image => {
            if(!image) return;
            image.style.transform = linkedTransform;
            image.style.transformOrigin = '50% 50%';
            image.style.willChange = '';
        });
        stage?.classList.toggle('space-pan-ready', previewSpacePanHeld && previewZoom > 1.001);
        updatePreviewZoomLabel();
    }
    function stopPreviewPan(pointerId){
        const stage = previewStage();
        const activePointerId = previewPanDrag?.pointerId;
        if(pointerId != null && activePointerId != null && pointerId !== activePointerId) return;
        previewPanDrag = null;
        stage?.classList.remove('panning');
        if(activePointerId != null && stage?.hasPointerCapture?.(activePointerId)) stage.releasePointerCapture(activePointerId);
    }
    function setPreviewSpacePanHeld(active){
        previewSpacePanHeld = Boolean(active);
        if(!previewSpacePanHeld) stopPreviewPan();
        previewStage()?.classList.toggle('space-pan-ready', previewSpacePanHeld && previewZoom > 1.001);
    }
    function resetPreviewTransform(){
        previewZoom = 1;
        previewPan = {x:0, y:0};
        stopPreviewPan();
        applyPreviewTransform();
    }
    function resetPreviewResultPresentation(){
        [byId('previewImage'), byId('previewSourceImage')].forEach(image => {
            if(!image) return;
            image.style.width = '';
            image.style.height = '';
            image.style.maxWidth = '';
            image.style.maxHeight = '';
            image.style.objectFit = '';
            image.style.objectPosition = '';
            image.style.boxSizing = '';
            image.style.padding = '';
            image.style.transform = '';
            image.style.transformOrigin = '';
            image.style.willChange = '';
        });
    }
    function applyPreviewImageLayout(){
        const stage = previewStage();
        if(!stage) return;
        const align = PREVIEW_ALIGN_MODES.has(stage.dataset.previewAlign) ? stage.dataset.previewAlign : 'fit';
        stage.dataset.previewAlign = align;
        const layout = previewImageRenderLayout(align, previewZoom);
        [byId('previewImage'), byId('previewSourceImage')].forEach(image => {
            if(!image) return;
            image.style.boxSizing = 'border-box';
            image.style.objectPosition = 'center';
            Object.assign(image.style, layout);
        });
    }
    function applyPreviewFillLayout(){ applyPreviewImageLayout(); }
    function setPreviewSlider(value){
        const percent = Math.max(0, Math.min(100, Number(value) || 0));
        byId('previewCompareSlider').value = String(percent);
        byId('previewStage').style.setProperty('--compare-position', `${percent}%`);
    }
    function previewSliderPercentAt(clientX){
        const frame = previewPanzoom();
        const rect = frame?.getBoundingClientRect();
        if(!rect || !rect.width) return 50;
        return ((clientX - rect.left) / rect.width) * 100;
    }
    function flushPreviewSliderPosition(){
        previewSliderFrame = 0;
        if(previewSliderPendingX == null) return;
        const clientX = previewSliderPendingX;
        previewSliderPendingX = null;
        setPreviewSlider(previewSliderPercentAt(clientX));
    }
    function queuePreviewSliderPosition(clientX){
        previewSliderPendingX = clientX;
        if(previewSliderFrame) return;
        if(typeof requestAnimationFrame === 'function') previewSliderFrame = requestAnimationFrame(flushPreviewSliderPosition);
        else previewSliderFrame = setTimeout(flushPreviewSliderPosition, 16);
    }
    function setPreviewMode(mode){
        const stage = byId('previewStage');
        const hasSource = stage.dataset.hasSource === 'true';
        const legacyMode = ({default:'slider', fill:'slider'})[mode] || mode;
        const selected = PREVIEW_MODES.has(legacyMode) && (legacyMode === 'single' || hasSource) ? legacyMode : 'single';
        stage.dataset.previewMode = selected;
        byId('previewCompareModes').querySelectorAll('[data-preview-mode]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.previewMode === selected));
        });
        applyPreviewImageLayout();
        applyPreviewTransform();
    }
    function setPreviewAlign(mode){
        const stage = previewStage();
        const selected = PREVIEW_ALIGN_MODES.has(mode) ? mode : 'fit';
        stage.dataset.previewAlign = selected;
        byId('previewAlignModes').querySelectorAll('[data-preview-align]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.previewAlign === selected));
        });
        applyPreviewImageLayout();
        applyPreviewTransform();
    }
    function resetPreviewView(){
        setPreviewAlign('fit');
        resetPreviewTransform();
    }
    function setPreviewZoomAt(nextZoom, clientX, clientY){
        const stage = previewStage();
        const frame = previewPanzoom();
        if(!stage || !frame) return;
        if(stage.dataset.previewMode === 'side-by-side'){
            const linked = linkedSidePreviewZoomState(previewZoom, previewPan, nextZoom);
            previewZoom = linked.zoom;
            previewPan = linked.pan;
            applyPreviewTransform();
            return;
        }
        const frameRect = frame.getBoundingClientRect();
        const localX = clientX - frameRect.left - frameRect.width / 2;
        const localY = clientY - frameRect.top - frameRect.height / 2;
        const beforeX = (localX - previewPan.x) / previewZoom;
        const beforeY = (localY - previewPan.y) / previewZoom;
        previewZoom = Math.max(.35, Math.min(6, Number(nextZoom) || 1));
        if(previewZoom <= 1.001){
            previewZoom = 1;
            previewPan = {x:0, y:0};
        } else {
            previewPan = {x:localX - beforeX * previewZoom, y:localY - beforeY * previewZoom};
        }
        applyPreviewTransform();
    }
    function bindPreviewViewportEvents(){
        const stage = previewStage();
        if(!stage || stage.dataset.previewEventsBound === 'true') return;
        stage.dataset.previewEventsBound = 'true';
        const slider = byId('previewCompareSlider');
        const endSliderDrag = event => {
            if(previewSliderPointerId == null || (event?.pointerId != null && event.pointerId !== previewSliderPointerId)) return;
            const pointerId = previewSliderPointerId;
            previewSliderPointerId = null;
            slider.releasePointerCapture?.(pointerId);
            if(previewSliderPendingX != null) flushPreviewSliderPosition();
        };
        slider.addEventListener('pointerdown', event => {
            const intent = previewPointerIntent({mode:stage.dataset.previewMode, zoom:previewZoom, spaceHeld:previewSpacePanHeld, button:event.button});
            if(intent !== 'slider') return;
            previewSliderPointerId = event.pointerId;
            slider.setPointerCapture?.(event.pointerId);
            slider.focus({preventScroll:true});
            queuePreviewSliderPosition(event.clientX);
            event.preventDefault();
            event.stopPropagation();
        });
        slider.addEventListener('pointermove', event => {
            if(previewSliderPointerId !== event.pointerId) return;
            queuePreviewSliderPosition(event.clientX);
            event.preventDefault();
        });
        slider.addEventListener('keydown', event => {
            if(stage.dataset.previewMode !== 'slider' || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
            const step = Number(slider.step) > 0 ? Number(slider.step) : 1;
            const direction = event.key === 'ArrowLeft' ? -1 : 1;
            setPreviewSlider(Number(slider.value) + direction * step);
            event.preventDefault();
        });
        slider.addEventListener('pointerup', endSliderDrag);
        slider.addEventListener('pointercancel', endSliderDrag);
        slider.addEventListener('lostpointercapture', endSliderDrag);
        stage.addEventListener('wheel', event => {
            event.preventDefault();
            event.stopPropagation();
            const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
            setPreviewZoomAt(previewZoom * factor, event.clientX, event.clientY);
        }, {passive:false});
        stage.addEventListener('dblclick', event => {
            if(event.target.closest('button, a')) return;
            if(stage.dataset.hasSource !== 'true') return;
            const currentMode = stage.dataset.previewMode || 'single';
            if(currentMode === 'single') setPreviewMode('slider');
            else if(currentMode === 'slider') setPreviewMode('single');
        });
        stage.addEventListener('pointerdown', event => {
            const intent = previewPointerIntent({mode:stage.dataset.previewMode, zoom:previewZoom, spaceHeld:previewSpacePanHeld, button:event.button});
            if(intent !== 'pan' || event.target.closest('button, a')) return;
            previewPanDrag = {pointerId:event.pointerId, clientX:event.clientX, clientY:event.clientY, startX:previewPan.x, startY:previewPan.y};
            stage.classList.add('panning');
            stage.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        });
        stage.addEventListener('pointermove', event => {
            if(!previewPanDrag) return;
            previewPan = {
                x:previewPanDrag.startX + event.clientX - previewPanDrag.clientX,
                y:previewPanDrag.startY + event.clientY - previewPanDrag.clientY,
            };
            applyPreviewTransform();
        });
        const endPan = event => stopPreviewPan(event?.pointerId);
        stage.addEventListener('pointerup', endPan);
        stage.addEventListener('pointercancel', endPan);
        byId('previewResetView').addEventListener('click', resetPreviewView);
    }
    function syncPreviewNavigation(){
        const previous = byId('previewPrevious');
        const next = byId('previewNext');
        const count = runtime.previewItems.length;
        const navigable = count > 1;
        if(previous){ previous.hidden = !navigable; previous.disabled = !navigable || runtime.previewIndex <= 0; }
        if(next){ next.hidden = !navigable; next.disabled = !navigable || runtime.previewIndex >= count - 1; }
    }
    function openImagePreview(url, {alt='图片预览', sourceUrl='', previewMode='single', previewAlign='fit'}={}){
        if(!url) return;
        const options = arguments[1] || {};
        const previewItems = options.previewItems;
        const previewIndex = options.previewIndex;
        if(Array.isArray(previewItems)){
            runtime.previewItems = previewItems.filter(item => item?.url);
            runtime.previewIndex = Math.max(0, Math.min(runtime.previewItems.length - 1, Number(previewIndex) || 0));
        } else {
            runtime.previewItems = [];
            runtime.previewIndex = -1;
        }
        byId('previewImage').src = url;
        byId('previewImage').alt = alt;
        const sourceImage = byId('previewSourceImage');
        if(sourceUrl) sourceImage.src = sourceUrl;
        else sourceImage.removeAttribute('src');
        byId('previewStage').dataset.hasSource = String(Boolean(sourceUrl));
        byId('previewCompareModes').hidden = !sourceUrl;
        setPreviewSlider(50);
        setPreviewAlign(previewAlign);
        resetPreviewTransform();
        setPreviewMode(previewMode);
        byId('previewDownload').href = url;
        const dialog = byId('imagePreviewDialog');
        if(!dialog.open) dialog.showModal();
        syncPreviewNavigation();
        bindPreviewViewportEvents();
        if(typeof requestAnimationFrame === 'function') requestAnimationFrame(applyPreviewImageLayout);
        refreshIcons();
    }
    function previewUploadedImage(slotKey){
        const slot = runtime.inputs.find(item => item.slot_key === slotKey);
        const url = mediaUrl(slot?.media);
        if(!url) return;
        openImagePreview(url, {alt:`${slot?.label || '上传图片'}原图预览`});
    }
    function previewCandidate(taskId, candidateId){
        const task = runtime.taskCache.get(taskId) || runtime.viewedTask;
        const candidate = candidateFromTask(task, candidateId);
        const url = mediaUrl(candidateImage(candidate));
        if(!url) return;
        let sourceUrl = previewSourceUrl(task);
        if(!sourceUrl && String(runtime.viewedTask?.id || '') === String(taskId)) sourceUrl = previewSourceUrl(runtime.viewedTask);
        const previewItems = resultItems().filter(item => item.url);
        const previewIndex = previewItems.findIndex(item => item.taskId === String(taskId || '') && item.candidateId === String(candidateId || ''));
        openImagePreview(url, {alt:`生成图片 ${candidateId || ''}`.trim(), sourceUrl, previewItems, previewIndex});
    }
    function navigatePreview(delta){
        if(!byId('imagePreviewDialog')?.open || runtime.previewItems.length < 2) return;
        const nextIndex = runtime.previewIndex + Number(delta || 0);
        if(nextIndex < 0 || nextIndex >= runtime.previewItems.length) return;
        const item = runtime.previewItems[nextIndex];
        const sourceUrl = previewSourceUrl(item.task);
        const stage = previewStage();
        openImagePreview(item.url, {
            alt:`生成图片 ${item.candidateId || ''}`.trim(), sourceUrl,
            previewItems:runtime.previewItems, previewIndex:nextIndex,
            previewMode:stage?.dataset.previewMode || 'single',
            previewAlign:stage?.dataset.previewAlign || 'fit',
        });
    }
    async function handleCandidateAction(action, taskId, candidateId, resultKey=''){
        if(action === 'preview') return previewCandidate(taskId, candidateId);
        if(action === 'select') return toggleResultSelection(resultKey || `${taskId}:${candidateId}`);
        if(action === 'reuse-inputs') return reuseTaskInputs(taskId);
        if(action === 'set-example') return openSetExampleDialog(taskId, candidateId);
        if(action !== 'recover' && action !== 'regenerate') return;
        if(action === 'regenerate' && !currentModeIsActive()) return showToast('这个模式已归档，不能重新生成图片', true);
        const actionKey = `${taskId}:${candidateId}:${action}`;
        const regenerationKey = `${taskId}:${candidateId}:regenerate`;
        if(runtime.candidateActionLocks.has(actionKey)){
            showToast(action === 'recover' ? '回补查询已经在进行中' : '这次重新生成正在提交，请勿重复点击');
            return;
        }
        runtime.candidateActionLocks.add(actionKey);
        let requestSent = false;
        let actionAccepted = false;
        try {
            let result = null;
            if(action === 'recover'){
                requestSent = true;
                result = await requestJson(`/api/image-generation-tasks/${encodeURIComponent(taskId)}/candidates/${encodeURIComponent(candidateId)}/recover`, {method:'POST'});
                actionAccepted = true;
                runtime.activeTaskIds.add(taskId); scheduleActivePoll(250);
                showToast(result.reused ? '正在继续现有查询，不会重新生图' : '已开始回补查询，不会产生新的生成费用');
            } else if(action === 'regenerate'){
                let submissionId = runtime.regenerationSubmissions.get(regenerationKey);
                if(!submissionId){
                    submissionId = crypto.randomUUID();
                    runtime.regenerationSubmissions.set(regenerationKey, submissionId);
                }
                if(!confirm('重新生成会产生一次新的图片费用。确认继续吗？')){
                    runtime.regenerationSubmissions.delete(regenerationKey);
                    return;
                }
                requestSent = true;
                result = await requestJson(`/api/image-generation-tasks/${encodeURIComponent(taskId)}/candidates/${encodeURIComponent(candidateId)}/regenerate`, {
                    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({confirm_cost:true, submission_id:submissionId}),
                });
                actionAccepted = true;
                runtime.activeTaskIds.add(taskId); scheduleActivePoll(250);
                showToast(result.reused ? '这次重生操作已受理，未重复提交' : '已新增一个候选并开始生成');
            }
            const returnedTask = result?.task;
            const stillViewingTask = runtime.viewedTask?.id === taskId;
            if(returnedTask?.id){
                adoptTaskSnapshot(returnedTask, {makeViewed:stillViewingTask});
            } else if(stillViewingTask && !await openTask(taskId)){
                showToast(action === 'regenerate'
                    ? '重新生成已受理，结果刷新失败，后台继续运行'
                    : '回补查询已受理，结果刷新失败，后台继续运行', true);
            }
            emitImageGenerationsChanged(action);
        } catch(error) {
            if(action === 'regenerate' && !requestSent) runtime.regenerationSubmissions.delete(regenerationKey);
            if(actionAccepted){
                showToast(action === 'regenerate'
                    ? '重新生成已受理，结果刷新失败，后台继续运行'
                    : '回补查询已受理，结果刷新失败，后台继续运行', true);
            } else {
                showToast(error.message || '候选操作失败', true);
            }
        } finally {
            runtime.candidateActionLocks.delete(actionKey);
        }
    }
    async function handleTaskAction(action, taskId){
        let refreshMode = true;
        try {
            if(action === 'rename'){
                const task = runtime.taskCache.get(taskId) || runtime.viewedTask;
                const name = prompt('请输入分组名称', task?.name || '');
                if(name === null) return;
                await requestJson(`/api/image-generation-tasks/${encodeURIComponent(taskId)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})});
                showToast('分组名称已更新');
            } else if(action === 'cancel'){
                if(!confirm('停止后只会结束本地等待，上游任务可能仍继续运行。确认停止吗？')) return;
                await requestJson(`/api/image-generation-tasks/${encodeURIComponent(taskId)}/cancel`, {method:'POST'});
                runtime.activeTaskIds.delete(taskId);
                showToast('已停止本地等待；上游任务可能仍在运行');
            } else if(action === 'download'){
                await downloadTaskResults(taskId);
                showToast('已开始下载可用图片');
            } else if(action === 'delete'){
                if(!confirm('确认删除这个分组？本地会停止查询，但上游任务可能继续运行。')) return;
                const response = await requestJson(`/api/image-generation-tasks/${encodeURIComponent(taskId)}`, {method:'DELETE'});
                forgetImageGenerationTasks([taskId]);
                renderResults(); renderHistory(); renderGlobalHistory(); renderHall();
                queueStorageCleanupJob(response?.cleanup_job_id, {
                    queuedMessage:'分组已删除，图片正在移入 Windows 回收站',
                    successMessage:'分组图片已移入 Windows 回收站',
                });
                refreshMode = false;
            }
            if(refreshMode && runtime.currentMode) await loadModeTasks(runtime.currentMode.id, {preserveViewed:true});
            renderGlobalHistory(); renderHall();
            emitImageGenerationsChanged(action);
        } catch(error) {
            const noDownload = action === 'download' && error.message === '当前没有可下载结果';
            showToast(error.message || '分组操作失败', !noDownload);
        }
    }
    function renderHistory(){
        byId('historyCount').textContent = `${runtime.tasks.length} 条`;
        byId('modeHistory').innerHTML = runtime.tasks.length ? runtime.tasks.map(task => `<div class="history-item-shell"><button class="history-item${runtime.viewedTask?.id === task.id ? ' active' : ''}" type="button" data-task-id="${escapeHtml(task.id)}"><span><strong>${escapeHtml(task.name || `${runtime.currentMode.display_name} · 分组 ${task.group_no || ''}`)}</strong><span>${escapeHtml(formatDate(task.updated_at || task.created_at))}</span></span><span class="history-item-status">${escapeHtml(taskStatusLabel(task))}</span></button><div class="history-item-actions">${taskActionsHtml(task)}</div></div>`).join('') : '<div class="result-empty"><span>暂无生成批次</span></div>';
        byId('modeHistory').querySelectorAll('.history-item[data-task-id]').forEach(button => button.addEventListener('click', async () => {
            if(blockContextChangeWhileSubmitting()) return;
            runtime.modeNavigationVersion += 1;
            const taskRequestVersion = ++runtime.taskNavigationVersion;
            await imageGenerationSaveDraft({silent:true});
            if(!isLatestNavigation(taskRequestVersion, runtime.taskNavigationVersion)) return;
            await openTask(button.dataset.taskId, {requestVersion:taskRequestVersion});
        }));
        byId('modeHistory').querySelectorAll('[data-task-action]').forEach(button => button.addEventListener('click', event => {
            event.stopPropagation();
            handleTaskAction(button.dataset.taskAction, button.dataset.taskId);
        }));
        refreshIcons();
    }
    async function openTask(taskId, {showInputs=false, expectedModeId='', requestVersion=0}={}){
        if(showInputs && blockContextChangeWhileSubmitting()) return;
        const navigationVersion = requestVersion || ++runtime.taskNavigationVersion;
        if(!isLatestNavigation(navigationVersion, runtime.taskNavigationVersion)) return false;
        try {
            const task = await requestJson(`/api/image-generation-tasks/${encodeURIComponent(taskId)}`);
            if(!isLatestNavigation(navigationVersion, runtime.taskNavigationVersion)) return false;
            if(expectedModeId && String(runtime.currentMode?.id || '') !== String(expectedModeId)) return false;
            if(showInputs && blockContextChangeWhileSubmitting()) return;
            runtime.viewedTask = task;
            rememberTask(runtime.viewedTask);
            renderResults(); renderHistory();
            if(showInputs){ applyTaskAsReadonly(runtime.viewedTask); renderWorkbenchInputs(); }
            return true;
        } catch(error) {
            if(!isLatestNavigation(navigationVersion, runtime.taskNavigationVersion)) return false;
            showToast(error.message || '历史记录加载失败', true);
            return false;
        }
    }
    async function loadModeTaskDetails(modeId, modeRequestVersion=0){
        const pending = runtime.tasks.filter(task => {
            const cached = runtime.taskCache.get(task.id);
            const summaryUpdated = String(task.updated_at || task.created_at || '');
            const detailUpdated = String(cached?._detail_updated_at || '');
            return Number(task.candidate_count || 0) > 0 && (!Array.isArray(cached?.candidates) || summaryUpdated !== detailUpdated);
        });
        const queue = [...pending];
        const workers = Array.from({length:Math.min(6, queue.length)}, async () => {
            while(queue.length){
                const summary = queue.shift();
                try {
                    const detail = await requestJson(`/api/image-generation-tasks/${encodeURIComponent(summary.id)}`);
                    if(modeRequestVersion && !isLatestNavigation(modeRequestVersion, runtime.modeNavigationVersion)) return;
                    if(String(runtime.currentMode?.id || '') !== String(modeId || '')) return;
                    rememberTask(detail);
                } catch(_) {
                    // One stale history record must not hide the remaining gallery.
                }
            }
        });
        await Promise.all(workers);
    }
    async function loadModeTasks(modeId, {preserveViewed=false, modeRequestVersion=0}={}){
        const payload = await requestJson(`/api/image-generation-tasks?mode_id=${encodeURIComponent(modeId)}&limit=200`);
        if(modeRequestVersion && !isLatestNavigation(modeRequestVersion, runtime.modeNavigationVersion)) return false;
        if(String(runtime.currentMode?.id || '') !== String(modeId || '')) return false;
        runtime.tasks = (Array.isArray(payload.items) ? payload.items : [])
            .filter(task => !runtime.deletedTaskIds.has(String(task?.id || '')));
        runtime.tasks.sort((a, b) => Number(b.updated_at || b.created_at || 0) - Number(a.updated_at || a.created_at || 0));
        runtime.tasks.forEach(rememberTask);
        await loadModeTaskDetails(modeId, modeRequestVersion);
        if(modeRequestVersion && !isLatestNavigation(modeRequestVersion, runtime.modeNavigationVersion)) return false;
        const viewedId = preserveViewed && runtime.tasks.some(task => task.id === runtime.viewedTask?.id) ? runtime.viewedTask.id : runtime.tasks[0]?.id;
        if(viewedId) return await openTask(viewedId, {expectedModeId:modeId});
        runtime.viewedTask = null; renderResults(); renderHistory();
        return true;
    }
    function scheduleActivePoll(delay=1600){
        clearTimeout(runtime.pollTimer);
        runtime.pollTimer = setTimeout(pollActiveTasks, delay);
    }
    async function pollActiveTasks(){
        if(runtime.pollInFlight) return scheduleActivePoll();
        runtime.pollInFlight = true;
        let changed = false;
        try {
            for(const taskId of [...runtime.activeTaskIds]){
                try {
                    const task = await requestJson(`/api/image-generation-tasks/${encodeURIComponent(taskId)}`);
                    const previous = runtime.taskCache.get(taskId);
                    maybePlayTaskCompletionSound(previous, task);
                    rememberTask(task);
                    if(JSON.stringify([previous?.status, previous?.updated_at, previous?.successful_candidate_count]) !== JSON.stringify([task.status, task.updated_at, task.successful_candidate_count])) changed = true;
                    if(runtime.viewedTask?.id === taskId) runtime.viewedTask = task;
                } catch(error) {
                    if(error.status === 404){
                        runtime.activeTaskIds.delete(taskId);
                        forgetTaskNotices([taskId]);
                    }
                }
            }
            if(changed){
                if(runtime.currentMode){
                    runtime.tasks = runtime.allTasks.filter(task => task.mode_id === runtime.currentMode.id).sort((a,b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
                    renderResults(); renderHistory();
                }
                renderHall(); renderGlobalHistory(); emitImageGenerationsChanged('progress');
            }
        } finally {
            runtime.pollInFlight = false;
            if(runtime.activeTaskIds.size) scheduleActivePoll();
        }
    }
    async function loadAllTaskSummaries(){
        try {
            const firstPayload = await requestJson('/api/image-generation-tasks?limit=200');
            const items = Array.isArray(firstPayload.items) ? [...firstPayload.items] : [];
            let offset = items.length;
            while(items.length && items.length % 200 === 0){
                const page = await requestJson(`/api/image-generation-tasks?offset=${offset}&limit=200`);
                const next = Array.isArray(page.items) ? page.items : [];
                items.push(...next);
                offset += next.length;
                if(next.length < 200) break;
            }
            runtime.allTasks = items
                .filter(task => !runtime.deletedTaskIds.has(String(task?.id || '')));
            runtime.allTasks.forEach(rememberTask);
            if(runtime.activeTaskIds.size) scheduleActivePoll(500);
            renderHall(); renderGlobalHistory();
        } catch(error) { setPageStatus('任务记录读取失败'); }
    }

    function globalHistoryFiltered(){
        const modeId = byId('globalHistoryModeFilter')?.value || '';
        const status = byId('globalHistoryStatusFilter')?.value || '';
        const date = byId('globalHistoryDateFilter')?.value || '';
        const name = normalizeSearch(byId('globalHistoryNameFilter')?.value || '');
        return runtime.allTasks.filter(task => {
            if(modeId && task.mode_id !== modeId) return false;
            if(!taskMatchesStatusFilter(task, status)) return false;
            if(date){
                const taskDate = localDateKey(task.updated_at || task.created_at || 0);
                if(taskDate !== date) return false;
            }
            return !name || normalizeSearch(task.name || task.mode_name || '').includes(name);
        }).sort((a,b) => Number(b.updated_at || b.created_at || 0) - Number(a.updated_at || a.created_at || 0));
    }
    function globalHistoryGroupLabel(task){
        const raw = String(task?.group_no ?? '').trim();
        if(!raw) return '---';
        const numeric = Number(raw);
        const label = Number.isFinite(numeric)
            ? String(Math.max(0, Math.trunc(numeric))).padStart(3, '0')
            : raw.replace(/^#/, '');
        return label;
    }
    function globalHistoryIdentity(task){
        const mode = String(task?.mode_name || '').trim();
        const title = String(task?.name || mode || '图片生成').trim() || '图片生成';
        return {
            title,
            mode: mode && normalizeSearch(mode) !== normalizeSearch(title) ? mode : '',
        };
    }
    function terminalCleanupStatus(task){
        if(candidateStats(task).active > 0) return '';
        const status = taskVisualStatus(task);
        return status === 'failed' || status === 'deleted' ? status : '';
    }
    function terminalCleanupCounts(tasks=[]){
        const counts = {failed:0, deleted:0, total:0};
        for(const task of tasks || []){
            const status = terminalCleanupStatus(task);
            if(status === 'failed') counts.failed += 1;
            else if(status === 'deleted') counts.deleted += 1;
        }
        counts.total = counts.failed + counts.deleted;
        return counts;
    }
    function syncTerminalCleanupAction(){
        const button = byId('cleanupTerminalRecords');
        const count = byId('cleanupTerminalRecordsCount');
        if(!button) return;
        const stats = terminalCleanupCounts(runtime.allTasks);
        if(count) count.textContent = String(stats.total);
        button.disabled = stats.total === 0 || Boolean(runtime.terminalCleanup.running);
        button.setAttribute('aria-busy', String(Boolean(runtime.terminalCleanup.running)));
        button.setAttribute('aria-label', `清理失败和已删除记录，共 ${stats.total} 条`);
        button.title = stats.total ? `清理失败和已删除记录（${stats.total} 条）` : '没有可清理的失败或已删除记录';
    }
    function taskMatchesStatusFilter(task, status){
        if(!status) return true;
        if(status === 'active') return ACTIVE_TASK_STATUSES.has(String(task?.status || ''));
        return taskVisualStatus(task) === status;
    }
    function renderGlobalHistory(){
        syncTerminalCleanupAction();
        const list = byId('globalHistoryList');
        if(!list) return;
        const items = globalHistoryFiltered();
        const total = runtime.allTasks.length;
        const count = byId('globalHistoryCount');
        if(count) count.textContent = items.length === total ? `${total} 条` : `${items.length} / ${total} 条`;
        list.innerHTML = items.length ? items.map(task => {
            const identity = globalHistoryIdentity(task);
            const visualStatus = taskVisualStatus(task);
            const mode = identity.mode ? `<span class="global-history-mode">模式 · ${escapeHtml(identity.mode)}</span>` : '';
            return `<button class="global-history-row" type="button" data-global-task-id="${escapeHtml(task.id)}" aria-label="打开 ${escapeHtml(identity.title)}，${escapeHtml(taskStatusLabel(task))}">
                <span class="global-history-group">${escapeHtml(globalHistoryGroupLabel(task))}</span>
                <span class="global-history-identity"><strong>${escapeHtml(identity.title)}</strong>${mode}</span>
                <span class="global-history-status is-${escapeHtml(visualStatus)}">${escapeHtml(taskStatusLabel(task))}</span>
                <span class="global-history-date">${escapeHtml(formatDate(task.updated_at || task.created_at))}</span>
            </button>`;
        }).join('') : total
            ? `<div class="global-history-empty"><i data-lucide="search-x"></i><strong>没有找到匹配记录</strong><span>换个名称、模式、状态或日期试试</span><button type="button" data-clear-global-history-filters>清除筛选</button></div>`
            : `<div class="global-history-empty"><i data-lucide="history"></i><strong>还没有生成记录</strong><span>完成图片生成后，记录会保存在这里</span></div>`;
        list.querySelectorAll('[data-global-task-id]').forEach(button => button.addEventListener('click', () => openGlobalTask(button.dataset.globalTaskId)));
        list.querySelector('[data-clear-global-history-filters]')?.addEventListener('click', clearGlobalHistoryFilters);
        syncGlobalHistoryNameClear();
        refreshIcons();
    }

    function syncGlobalHistoryNameClear(){
        const input = byId('globalHistoryNameFilter');
        const button = byId('clearGlobalHistoryNameFilter');
        if(button) button.hidden = !String(input?.value || '');
    }
    function clearGlobalHistoryNameSearch(){
        const input = byId('globalHistoryNameFilter');
        if(!input) return;
        input.value = '';
        syncGlobalHistoryNameClear();
        renderGlobalHistory();
        input.focus();
    }
    function clearGlobalHistoryFilters(){
        for(const id of ['globalHistoryModeFilter','globalHistoryStatusFilter','globalHistoryDateFilter','globalHistoryNameFilter']){
            const control = byId(id);
            if(control) control.value = '';
        }
        syncGlobalHistoryNameClear();
        renderGlobalHistory();
        byId('globalHistoryNameFilter')?.focus();
    }

    function openTerminalCleanupConfirm(){
        const stats = terminalCleanupCounts(runtime.allTasks);
        if(!stats.total){
            syncTerminalCleanupAction();
            showToast('没有可清理的失败或已删除记录');
            return;
        }
        runtime.terminalCleanup = {
            taskIds: runtime.allTasks
                .filter(task => terminalCleanupStatus(task))
                .map(task => String(task.id || ''))
                .filter(Boolean),
            failedCount: stats.failed,
            deletedCount: stats.deleted,
            running: false,
        };
        byId('terminalCleanupFailedCount').textContent = `${stats.failed} 条`;
        byId('terminalCleanupDeletedCount').textContent = `${stats.deleted} 条`;
        byId('terminalCleanupTotalCount').textContent = `${stats.total} 条`;
        setDialogStatus('terminalCleanupConfirmStatus');
        if(byId('globalHistoryDialog')?.open) byId('globalHistoryDialog').close();
        byId('terminalCleanupConfirmDialog').showModal();
        requestAnimationFrame(() => byId('cancelTerminalCleanup')?.focus());
        refreshIcons();
    }
    function cancelTerminalCleanupConfirm(){
        if(byId('terminalCleanupConfirmDialog')?.open) byId('terminalCleanupConfirmDialog').close();
        runtime.terminalCleanup = {taskIds:[], failedCount:0, deletedCount:0, running:false};
        setDialogStatus('terminalCleanupConfirmStatus');
        if(!byId('globalHistoryDialog')?.open) openGlobalHistory();
        requestAnimationFrame(() => byId('cleanupTerminalRecords')?.focus());
    }
    async function confirmTerminalCleanup(){
        const button = byId('confirmTerminalCleanup');
        const label = button?.querySelector('span');
        const taskIds = [...runtime.terminalCleanup.taskIds];
        if(!taskIds.length){
            cancelTerminalCleanupConfirm();
            return;
        }
        runtime.terminalCleanup.running = true;
        syncTerminalCleanupAction();
        if(button){ button.disabled = true; button.setAttribute('aria-busy', 'true'); }
        if(label) label.textContent = '正在清理…';
        setDialogStatus('terminalCleanupConfirmStatus');
        try {
            const result = await requestJson('/api/image-generation-tasks/cleanup-terminal', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({task_ids:taskIds}),
            });
            const deletedTaskIds = Array.isArray(result?.deleted_task_ids) ? result.deleted_task_ids : taskIds;
            reconcileAfterDataCleanup(deletedTaskIds);
            runtime.terminalCleanup = {taskIds:[], failedCount:0, deletedCount:0, running:false};
            if(byId('terminalCleanupConfirmDialog')?.open) byId('terminalCleanupConfirmDialog').close();
            openGlobalHistory();
            queueStorageCleanupJob(result?.cleanup_job_id, {
                queuedMessage: result?.deleted_task_count
                    ? `已移除 ${result.deleted_task_count} 条失败/已删除记录，图片正在后台清理`
                    : '没有需要清理的失败/已删除记录',
                successMessage:'无效记录图片清理完成，可在 Windows 回收站恢复',
            });
            emitImageGenerationsChanged('terminal-cleanup');
        } catch(error) {
            runtime.terminalCleanup.running = false;
            setDialogStatus('terminalCleanupConfirmStatus', error.message || '清理失败，原数据已保留', true);
            showToast(error.message || '清理失败，原数据已保留', true);
        } finally {
            if(button){ button.disabled = false; button.removeAttribute('aria-busy'); }
            if(label) label.textContent = '确认清理';
            syncTerminalCleanupAction();
        }
    }

    const CLEANUP_RETENTION_LABELS = Object.freeze({
        '24h':'24小时前', '7d':'7天前', '30d':'30天前', all:'全部历史数据',
    });
    function selectedCleanupRetention(){
        return document.querySelector('input[name="cleanupRetention"]:checked')?.value || '24h';
    }
    function cleanupConfirmationView(retention, cutoffAt){
        if(retention === 'all') return {
            title:'删除全部历史数据？',
            description:'将删除全部历史记录，并把无引用图片移入 Windows 回收站：',
            cutoff:'全部时间范围内的历史数据',
        };
        const date = new Date(cutoffAt);
        const formatted = Number.isNaN(date.valueOf()) ? '' : date.toLocaleString('zh-CN', {
            year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit',
        });
        return {
            title:`删除${CLEANUP_RETENTION_LABELS[retention] || '所选时间之前'}的数据？`,
            description:`将删除 ${formatted || '所选截止时间'} 之前的记录，并把无引用图片移入 Windows 回收站：`,
            cutoff:formatted ? `截止时间：${formatted}` : '截止时间由本机服务确定',
        };
    }
    function closeDataManagement({restoreHistory=true}={}){
        const dialog = byId('dataManagementDialog');
        if(dialog?.open) dialog.close();
        if(restoreHistory && !byId('globalHistoryDialog')?.open) openGlobalHistory();
    }
    function openDataManagementDialog(){
        if(byId('globalHistoryDialog')?.open) byId('globalHistoryDialog').close();
        runtime.cleanup = {confirmationId:'', retention:'', cutoffAt:''};
        setDialogStatus('dataManagementStatus');
        const dialog = byId('dataManagementDialog');
        dialog.showModal();
        requestAnimationFrame(() => document.querySelector('input[name="cleanupRetention"]:checked')?.focus());
        refreshIcons();
    }
    async function requestDataCleanupPreview(){
        const button = byId('requestDataCleanup');
        const label = button?.querySelector('span');
        const retention = selectedCleanupRetention();
        setDialogStatus('dataManagementStatus');
        if(runtime.currentMode && !await imageGenerationSaveDraft({silent:true})){
            return setDialogStatus('dataManagementStatus', '当前草稿未能安全保存，未进入删除确认', true);
        }
        if(button){ button.disabled = true; button.setAttribute('aria-busy', 'true'); }
        if(label) label.textContent = '正在核对…';
        try {
            const preview = await requestJson('/api/image-generation-tasks/cleanup-preview', {
                method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({retention}),
            });
            if(!preview?.has_targets){
                setDialogStatus('dataManagementStatus', '该时间范围内没有可删除的数据');
                return;
            }
            runtime.cleanup = {
                confirmationId:String(preview.confirmation_id || ''),
                retention:String(preview.retention || retention),
                cutoffAt:String(preview.cutoff_at || ''),
            };
            if(!runtime.cleanup.confirmationId) throw new Error('服务没有返回删除确认');
            const view = cleanupConfirmationView(runtime.cleanup.retention, runtime.cleanup.cutoffAt);
            byId('dataCleanupConfirmTitle').textContent = view.title;
            byId('dataCleanupConfirmDescription').textContent = view.description;
            byId('dataCleanupCutoff').textContent = view.cutoff;
            setDialogStatus('dataCleanupConfirmStatus');
            byId('dataManagementDialog').close();
            byId('dataCleanupConfirmDialog').showModal();
            requestAnimationFrame(() => byId('cancelDataCleanupConfirm')?.focus());
            refreshIcons();
        } catch(error) {
            const message = error.status === 405
                ? '服务尚未加载数据管理，请重启软件后重试'
                : (error.message || '无法核对待删除数据');
            setDialogStatus('dataManagementStatus', message, true);
            showToast(message, true);
        } finally {
            if(button){ button.disabled = false; button.removeAttribute('aria-busy'); }
            if(label) label.textContent = '删除';
        }
    }
    function cancelDataCleanupConfirm(){
        if(byId('dataCleanupConfirmDialog')?.open) byId('dataCleanupConfirmDialog').close();
        setDialogStatus('dataManagementStatus');
        byId('dataManagementDialog').showModal();
        requestAnimationFrame(() => byId('requestDataCleanup')?.focus());
    }
    async function restoreDraftAfterCleanup(){
        if(!runtime.currentMode) return;
        const localDraft = runtime.pendingDrafts[runtime.currentMode.id];
        let serverDraft = null;
        try {
            serverDraft = (await requestJson(`/api/image-generation/modes/${encodeURIComponent(runtime.currentMode.id)}/draft`))?.item;
        } catch(_) {}
        if(localDraft || serverDraft) applyDraft(localDraft || serverDraft);
        else blankDraft();
        renderWorkbenchInputs();
    }
    function reconcileAfterDataCleanup(deletedTaskIds){
        const deleted = new Set((deletedTaskIds || []).map(String));
        forgetImageGenerationTasks(deleted);
        runtime.selectedResultKeys.clear();
        if(runtime.readOnlyHistory){
            const localDraft = runtime.currentMode ? runtime.pendingDrafts[runtime.currentMode.id] : null;
            if(localDraft) applyDraft(localDraft);
            else blankDraft();
            renderWorkbenchInputs();
            void restoreDraftAfterCleanup();
        }
        if(runtime.currentMode){
            runtime.tasks = runtime.allTasks
                .filter(task => String(task.mode_id || '') === String(runtime.currentMode.id || ''))
                .sort((a,b) => Number(b.updated_at || b.created_at || 0) - Number(a.updated_at || a.created_at || 0));
            renderResults();
            renderHistory();
        }
        renderGlobalHistory(); renderHall();
        void loadAllTaskSummaries();
    }
    function queueStorageCleanupJob(jobId, {queuedMessage='', successMessage='图片已移入 Windows 回收站'}={}){
        const id = String(jobId || '');
        if(!id || runtime.cleanupJobs.has(id)){
            if(queuedMessage) showToast(queuedMessage);
            return;
        }
        const state = {timer:null, failedAttempt:0};
        runtime.cleanupJobs.set(id, state);
        if(queuedMessage) showToast(queuedMessage);
        const finish = message => {
            clearTimeout(state.timer);
            runtime.cleanupJobs.delete(id);
            if(message) showToast(message);
        };
        const poll = async () => {
            try {
                const job = await requestJson(`/api/storage-cleanup/jobs/${encodeURIComponent(id)}`);
                if(String(job?.status || '') === 'failed'){
                    const attempt = Number(job?.attempts) || 0;
                    if(attempt > state.failedAttempt){
                        state.failedAttempt = attempt;
                        showToast('记录已删除，图片将在后台重试移入 Windows 回收站', true);
                    }
                } else if(String(job?.status || '') === 'succeeded'){
                    finish(successMessage);
                    return;
                }
            } catch(error) {
                if(error?.status === 404){
                    finish(successMessage);
                    return;
                }
            }
            state.timer = setTimeout(poll, 1600);
        };
        state.timer = setTimeout(poll, 500);
    }
    async function confirmDataCleanup(){
        const button = byId('confirmDataCleanup');
        const label = button?.querySelector('span');
        if(!runtime.cleanup.confirmationId) return setDialogStatus('dataCleanupConfirmStatus', '删除确认已失效，请重新选择时间范围', true);
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        if(label) label.textContent = '正在删除记录…';
        setDialogStatus('dataCleanupConfirmStatus');
        try {
            const result = await requestJson('/api/image-generation-tasks/cleanup', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({confirmation_id:runtime.cleanup.confirmationId}),
            });
            const retention = runtime.cleanup.retention;
            runtime.cleanup = {confirmationId:'', retention:'', cutoffAt:''};
            reconcileAfterDataCleanup(result?.deleted_task_ids || []);
            if(byId('dataCleanupConfirmDialog')?.open) byId('dataCleanupConfirmDialog').close();
            openGlobalHistory();
            queueStorageCleanupJob(result?.cleanup_job_id, {
                queuedMessage:retention === 'all'
                    ? '全部历史记录已删除，图片正在移入 Windows 回收站'
                    : `历史记录已删除，图片正在移入 Windows 回收站`,
                successMessage:'历史图片清理完成，可在 Windows 回收站恢复',
            });
            emitImageGenerationsChanged('data-cleanup');
        } catch(error) {
            runtime.cleanup.confirmationId = '';
            setDialogStatus('dataCleanupConfirmStatus', error.message || '删除失败，原数据已保留', true);
            showToast(error.message || '删除失败，原数据已保留', true);
        } finally {
            button.disabled = false;
            button.removeAttribute('aria-busy');
            if(label) label.textContent = '确认删除';
        }
    }
    async function openArchivedTask(taskId, expectedModeId=''){
        const modeRequestVersion = ++runtime.modeNavigationVersion;
        const taskRequestVersion = ++runtime.taskNavigationVersion;
        setPageStatus('正在打开归档历史…');
        try {
            const task = await requestJson(`/api/image-generation-tasks/${encodeURIComponent(taskId)}`);
            if(!isLatestNavigation(modeRequestVersion, runtime.modeNavigationVersion)
                || !isLatestNavigation(taskRequestVersion, runtime.taskNavigationVersion)) return false;
            if(expectedModeId && String(task.mode_id || '') !== String(expectedModeId)) throw new Error('历史记录与模式不匹配');
            const modeContext = modeContextFromTask(task);
            resetSubmissionContext();
            runtime.currentMode = modeContext;
            rememberTask(task);
            runtime.tasks = runtime.allTasks
                .filter(item => String(item.mode_id || '') === String(modeContext.id || ''))
                .sort((a, b) => Number(b.updated_at || b.created_at || 0) - Number(a.updated_at || a.created_at || 0));
            const taskIndex = runtime.tasks.findIndex(item => item.id === task.id);
            if(taskIndex >= 0) runtime.tasks[taskIndex] = {...runtime.tasks[taskIndex], ...task};
            else runtime.tasks.unshift(task);
            runtime.viewedTask = task;
            applyTaskAsReadonly(task);
            setWorkbenchVisible(true);
            syncWorkbenchHeader();
            renderExample();
            renderWorkbenchInputs();
            renderResults();
            renderHistory();
            setPageStatus(`${modeContext.display_name}（已归档，只读）`);
            refreshIcons();
            return true;
        } catch(error) {
            if(!isLatestNavigation(modeRequestVersion, runtime.modeNavigationVersion)) return false;
            setPageStatus('归档历史打开失败');
            showToast(error.message || '归档历史打开失败', true);
            return false;
        }
    }
    async function openGlobalTask(taskId){
        if(blockContextChangeWhileSubmitting()) return;
        const summary = runtime.taskCache.get(taskId) || runtime.allTasks.find(task => task.id === taskId);
        const modeId = summary?.mode_id;
        const modeIntentVersion = ++runtime.modeNavigationVersion;
        const taskIntentVersion = ++runtime.taskNavigationVersion;
        if(runtime.currentMode) await imageGenerationSaveDraft({silent:true});
        if(!isLatestNavigation(modeIntentVersion, runtime.modeNavigationVersion)
            || !isLatestNavigation(taskIntentVersion, runtime.taskNavigationVersion)) return false;
        if(blockContextChangeWhileSubmitting()) return;
        byId('globalHistoryDialog').close();
        const modeIsActive = runtime.modes.some(mode => String(mode.id) === String(modeId || '') && mode.status === 'active');
        if(!modeIsActive) return await openArchivedTask(taskId, modeId);
        let targetTaskVersion = taskIntentVersion;
        if(modeId && runtime.currentMode?.id !== modeId){
            if(!await selectMode(modeId)) return false;
            targetTaskVersion = ++runtime.taskNavigationVersion;
        }
        if(runtime.currentMode?.id === modeId){
            return await openTask(taskId, {expectedModeId:modeId, requestVersion:targetTaskVersion});
        }
        return false;
    }
    function openGlobalHistory(){
        byId('globalHistoryModeFilter').innerHTML = '<option value="">全部模式</option>' + runtime.modes.map(mode => `<option value="${escapeHtml(mode.id)}">${escapeHtml(modeNumber(mode) + ' ' + mode.display_name)}</option>`).join('');
        renderGlobalHistory();
        byId('globalHistoryDialog').showModal();
        requestAnimationFrame(() => byId('globalHistoryNameFilter')?.focus());
        refreshIcons();
    }

    function syncWorkbenchHeader(){
        const mode = runtime.currentMode;
        if(!mode) return;
        byId('workbenchModeNo').textContent = modeNumber(mode);
        byId('workbenchModeName').textContent = mode.display_name || '未命名模式';
        const guidance = String(mode.description || mode.remark || '').trim();
        byId('workbenchModeSummary').textContent = guidance;
        byId('modeGuidance').hidden = !guidance;
        const favorite = isFavorite(mode.id);
        byId('workbenchFavorite').setAttribute('aria-pressed', String(favorite));
        byId('workbenchFavorite').title = favorite ? '取消收藏' : '收藏模式';
        byId('workbenchFavorite').disabled = !currentModeIsActive();
        syncInputModeHint();
    }
    function setWorkbenchVisible(visible){
        const isVisible = Boolean(visible);
        const app = document.querySelector('.image-generation-app');
        if(app) app.classList.toggle('workbench-active', isVisible);
        byId('modeHall').hidden = isVisible;
        byId('modeWorkbench').hidden = !isVisible;
        if(!isVisible){
            closeUserPromptEditor();
            clearInterval(runtime.elapsedTimer);
            runtime.elapsedTimer = null;
        }
    }
    async function selectMode(modeId){
        if(blockContextChangeWhileSubmitting()) return;
        const next = runtime.modes.find(mode => String(mode.id) === String(modeId));
        if(!next) return;
        clearReadyToGenerateHint();
        const requestVersion = ++runtime.modeNavigationVersion;
        runtime.taskNavigationVersion += 1;
        resetSubmissionContext();
        if(runtime.currentMode?.id && runtime.currentMode.id !== next.id) await imageGenerationSaveDraft({silent:true});
        if(!isLatestNavigation(requestVersion, runtime.modeNavigationVersion)) return false;
        setPageStatus('正在打开模式…');
        try {
            const [modePayload, draftPayload] = await Promise.all([
                requestJson(`/api/image-generation/modes/${encodeURIComponent(next.id)}`),
                requestJson(`/api/image-generation/modes/${encodeURIComponent(next.id)}/draft`),
            ]);
            if(!isLatestNavigation(requestVersion, runtime.modeNavigationVersion)) return false;
            if(blockContextChangeWhileSubmitting()) return;
            runtime.currentMode = modePayload;
            recordRecent(modePayload.id);
            runtime.tasks = [];
            runtime.viewedTask = null;
            const serverDraft = draftPayload?.item;
            const localDraft = runtime.pendingDrafts[modePayload.id];
            if(serverDraft || localDraft) applyDraft(localDraft || serverDraft);
            else blankDraft();
            setWorkbenchVisible(true);
            syncWorkbenchHeader(); renderExample(); renderWorkbenchInputs(); renderResults(); renderHistory();
            if(!await loadModeTasks(modePayload.id, {modeRequestVersion:requestVersion})) return false;
            if(!isLatestNavigation(requestVersion, runtime.modeNavigationVersion)) return false;
            markModeTaskNoticesSeen(modePayload.id);
            renderHall();
            setPageStatus(`${modeNumber(modePayload)} ${modePayload.display_name}`);
            syncForm();
            refreshIcons();
            return true;
        } catch(error) {
            if(!isLatestNavigation(requestVersion, runtime.modeNavigationVersion)) return false;
            setPageStatus('模式打开失败');
            showToast(error.message || '模式打开失败', true);
            return false;
        }
    }
    async function leaveWorkbench(){
        if(runtime.leavingWorkbench || blockContextChangeWhileSubmitting()) return;
        runtime.leavingWorkbench = true;
        try {
            clearReadyToGenerateHint();
            const requestVersion = ++runtime.modeNavigationVersion;
            runtime.taskNavigationVersion += 1;
            resetSubmissionContext();
            await imageGenerationSaveDraft({silent:true});
            if(!isLatestNavigation(requestVersion, runtime.modeNavigationVersion)) return;
            if(blockContextChangeWhileSubmitting()) return;
            runtime.currentMode = null;
            setWorkbenchVisible(false);
            setPageStatus(`${runtime.modes.filter(mode => mode.status === 'active').length} 个可用模式`);
            renderHall();
        } finally {
            runtime.leavingWorkbench = false;
        }
    }

    function editableShortcutTarget(target){
        return target instanceof Element
            && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
    }
    function canLeaveWorkbenchWithEscape(event){
        return event.key === 'Escape'
            && !event.defaultPrevented
            && !event.isComposing
            && event.keyCode !== 229
            && !event.repeat
            && !document.querySelector('dialog[open]')
            && !editableShortcutTarget(event.target)
            && Boolean(runtime.currentMode)
            && !byId('modeWorkbench')?.hidden;
    }

    function setDialogStatus(id, message='', error=false){
        const element = byId(id);
        if(!element) return;
        element.textContent = String(message || '');
        element.classList.toggle('error', Boolean(error));
    }
    function syncAdminControls(){
        document.querySelectorAll('.admin-only').forEach(element => { element.hidden = !runtime.admin.active; });
        renderResults();
        refreshIcons();
    }
    function clearAdminProtectedView(){
        for(const id of ['adminModeName','adminModeCategory','adminModeSort','adminModeDescription','adminExampleCaption','adminPromptText','exampleCaption','exampleUserPrompt']){
            const element = byId(id);
            if(element) element.value = '';
        }
        for(const id of ['adminModeSelect']){
            const element = byId(id);
            if(element) element.innerHTML = '';
        }
        for(const id of ['adminModeList','adminExamplePreview','setExamplePreview']){
            const element = byId(id);
            if(element) element.replaceChildren();
        }
        if(byId('adminModeFields')) byId('adminModeFields').hidden = true;
        if(byId('adminModeEmpty')) byId('adminModeEmpty').hidden = false;
        if(byId('adminModeNumber')) byId('adminModeNumber').textContent = '#--';
        if(byId('adminModeNameHeading')) byId('adminModeNameHeading').textContent = '模式';
        if(byId('adminModeStatus')) byId('adminModeStatus').textContent = '已停用';
        if(byId('adminModeEnabled')) byId('adminModeEnabled').checked = false;
        if(byId('adminExampleCaptionField')) byId('adminExampleCaptionField').hidden = true;
        setDialogStatus('adminManagerStatus');
        setDialogStatus('setExampleStatus');
    }
    function leaveAdminUi(){
        saveAdminToken('');
        runtime.admin.active = false;
        runtime.admin.modes = [];
        runtime.admin.currentMode = null;
        runtime.admin.exampleTarget = null;
        runtime.admin.nextModeNo = 0;
        for(const id of ['adminManagerDialog','setExampleDialog']){
            const dialog = byId(id);
            if(dialog?.open) dialog.close();
        }
        clearAdminProtectedView();
        syncAdminControls();
    }
    async function reloadPublicModes(){
        const payload = await requestJson('/api/image-generation/modes');
        runtime.modes = Array.isArray(payload.items) ? payload.items : [];
        if(runtime.currentMode && currentModeIsActive()){
            const refreshed = runtime.modes.find(mode => mode.id === runtime.currentMode.id);
            if(refreshed) runtime.currentMode = refreshed;
        }
        renderHall(); renderExample(); syncWorkbenchHeader(); syncForm();
    }
    async function enterAdminUi(){
        await loadAdminModes(runtime.currentMode?.id || '');
        runtime.admin.active = true;
        syncAdminControls();
    }
    async function restoreAdminSession(){
        if(!runtime.admin.token) return;
        try {
            const session = await adminRequestJson('/api/image-generation/admin/session');
            if(session.active) await enterAdminUi();
            else leaveAdminUi();
        } catch(_) { leaveAdminUi(); }
    }
    async function unlockAdminMode(event){
        event.preventDefault();
        const button = byId('unlockAdminMode');
        button.disabled = true;
        setDialogStatus('adminPasswordStatus', '正在校验…');
        try {
            const result = await requestJson('/api/image-generation/admin/unlock', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({password:byId('adminPassword').value}),
            });
            saveAdminToken(result.token);
            byId('adminPassword').value = '';
            byId('adminPasswordDialog').close();
            await enterAdminUi();
            byId('adminManagerDialog').showModal();
            showToast('已进入本机管理模式');
        } catch(error) {
            setDialogStatus('adminPasswordStatus', error.message || '密码校验失败', true);
        } finally { button.disabled = false; }
    }
    async function exitAdminMode(){
        try { await adminRequestJson('/api/image-generation/admin/lock', {method:'POST'}); }
        catch(_) {}
        leaveAdminUi();
        await reloadPublicModes().catch(() => {});
        showToast('已退出管理模式');
    }
    function adminModeById(modeId){ return runtime.admin.modes.find(mode => String(mode.id) === String(modeId || '')); }
    function renderAdminModeBrowser(){
        const items = runtime.admin.modes;
        const currentId = runtime.admin.currentMode?.id || '';
        const creating = Boolean(runtime.admin.currentMode?.__isNew);
        const newOption = creating ? `<option value="" selected>${escapeHtml(modeNumber(runtime.admin.currentMode) + ' 新增模式（未保存）')}</option>` : '';
        byId('adminModeSelect').innerHTML = newOption + items.map(mode => `<option value="${escapeHtml(mode.id)}"${mode.id === currentId ? ' selected' : ''}>${escapeHtml(modeNumber(mode) + ' ' + mode.display_name + ' · ' + adminStatusLabel(mode.status))}</option>`).join('');
        byId('adminModeList').innerHTML = items.map(mode => `<button class="admin-mode-row${mode.id === currentId ? ' active' : ''}" type="button" data-admin-mode-id="${escapeHtml(mode.id)}"><span>${escapeHtml(modeNumber(mode))}</span><strong>${escapeHtml(mode.display_name)}</strong><span>${escapeHtml(adminStatusLabel(mode.status))}</span></button>`).join('');
        byId('adminModeList').querySelectorAll('[data-admin-mode-id]').forEach(button => button.addEventListener('click', () => loadAdminModeDetail(button.dataset.adminModeId)));
        byId('createAdminMode').disabled = creating;
    }
    async function loadAdminModes(preferredId=''){
        const payload = await adminRequestJson('/api/image-generation/admin/modes');
        runtime.admin.modes = Array.isArray(payload.items) ? payload.items : [];
        runtime.admin.nextModeNo = Number(payload.next_mode_no) || Math.max(0, ...runtime.admin.modes.map(mode => Number(mode.mode_no) || 0)) + 1;
        const target = adminModeById(preferredId) || adminModeById(runtime.admin.currentMode?.id) || runtime.admin.modes[0];
        renderAdminModeBrowser();
        if(target) await loadAdminModeDetail(target.id);
        else renderAdminModeEditor();
    }
    async function loadAdminModeDetail(modeId){
        setDialogStatus('adminManagerStatus', '正在读取模式…');
        try {
            const payload = await adminRequestJson(`/api/image-generation/admin/modes/${encodeURIComponent(modeId)}`);
            runtime.admin.currentMode = payload.item;
            const summaryIndex = runtime.admin.modes.findIndex(mode => mode.id === payload.item.id);
            if(summaryIndex >= 0) runtime.admin.modes[summaryIndex] = {...runtime.admin.modes[summaryIndex], ...payload.item};
            renderAdminModeBrowser();
            renderAdminModeEditor();
            setDialogStatus('adminManagerStatus');
        } catch(error) { setDialogStatus('adminManagerStatus', error.message || '模式读取失败', true); }
    }
    function startAdminModeCreation(){
        if(!(runtime.admin.nextModeNo > 0)) runtime.admin.nextModeNo = Math.max(0, ...runtime.admin.modes.map(mode => Number(mode.mode_no) || 0)) + 1;
        runtime.admin.currentMode = {
            __isNew:true,
            id:'',
            mode_no:runtime.admin.nextModeNo,
            display_name:'',
            description:'',
            remark:'',
            category:'',
            sort_order:runtime.admin.nextModeNo,
            preset_prompt:'',
            required_reference_count:0,
            reference_images:[],
            max_upload_count:0,
            allow_extra_images:false,
            extra_image_limit:0,
            status:'active',
            example:null,
        };
        renderAdminModeBrowser();
        renderAdminModeEditor();
        setDialogStatus('adminManagerStatus', '填写设置后点击“创建模式”，保存前不会占用编号');
        byId('adminModeName').focus();
    }
    function adminStatusLabel(status){ return status === 'active' ? '已启动' : '已停用'; }
    function syncAdminStatusToggle(){
        const enabled = byId('adminModeEnabled').checked;
        byId('adminModeStatus').textContent = enabled ? '已启动' : '已停用';
        byId('adminModeStatus').closest('.admin-status-toggle')?.classList.toggle('is-active', enabled);
    }
    function renderAdminExamplePreview(example){
        const container = byId('adminExamplePreview');
        const captionField = byId('adminExampleCaptionField');
        const captionInput = byId('adminExampleCaption');
        if(!example){
            container.innerHTML = '<div class="admin-example-empty"><i data-lucide="image-off"></i><span>暂无固定示例图</span></div>';
            captionField.hidden = true;
            captionInput.value = '';
            refreshIcons();
            return;
        }
        const inputs = (example.input_media || []).map((item, index) => ({
            media:item?.media || item,
            label:String(item?.slot_key || `图 ${index + 1}`),
        })).filter(item => mediaUrl(item.media));
        const inputMarkup = inputs.length
            ? inputs.map(item => `<img src="${escapeHtml(mediaUrl(item.media))}" alt="${escapeHtml(item.label)}" loading="lazy">`).join('')
            : '<div class="admin-example-media-empty"><i data-lucide="image-off"></i></div>';
        const outputUrl = mediaUrl(example.output_media);
        const outputMarkup = outputUrl
            ? `<img src="${escapeHtml(outputUrl)}" alt="处理后示例" loading="lazy">`
            : '<div class="admin-example-media-empty"><i data-lucide="image-off"></i></div>';
        container.innerHTML = `<figure><div class="admin-example-media-grid">${inputMarkup}</div><figcaption>处理前</figcaption></figure><figure><div class="admin-example-media-grid single">${outputMarkup}</div><figcaption>处理后</figcaption></figure>`;
        captionField.hidden = false;
        captionInput.value = example.caption || '';
        refreshIcons();
    }
    function clampAdminRuleCount(value, fallback=0, maximum=6){
        const parsed = Number.parseInt(String(value ?? ''), 10);
        if(!Number.isFinite(parsed)) return Math.max(0, Math.min(maximum, fallback));
        return Math.max(0, Math.min(maximum, parsed));
    }
    function adminRequiredSlotLabels(){
        return [...byId('adminRequiredSlotFields').querySelectorAll('[data-admin-slot-label]')].map(input => String(input.value || '').trim());
    }
    function adminRuleDraft(mode){
        const referenceImages = Array.isArray(mode?.reference_images) ? mode.reference_images : [];
        const currentRequired = referenceImages.filter(slot => slot && slot.required);
        const namedOptional = referenceImages.filter(slot => slot && !slot.required);
        const requiredCount = clampAdminRuleCount(byId('adminRequiredCount')?.value, currentRequired.length);
        const requestedOptional = clampAdminRuleCount(
            byId('adminOptionalCount')?.value,
            Number(mode?.extra_image_limit || 0) + namedOptional.length,
            Math.max(0, 6 - requiredCount),
        );
        const optionalSlots = namedOptional.slice(0, requestedOptional);
        const extraImageLimit = Math.max(0, requestedOptional - optionalSlots.length);
        const usedKeys = new Set(referenceImages.map(slot => String(slot?.key || '')).filter(Boolean));
        const labels = adminRequiredSlotLabels();
        const nextKey = index => {
            let key = `ref${index + 1}`;
            let suffix = 2;
            while(usedKeys.has(key)) key = `ref${index + 1}-${suffix++}`;
            usedKeys.add(key);
            return key;
        };
        const requiredSlots = Array.from({length:requiredCount}, (_, index) => {
            const original = currentRequired[index];
            const key = original?.key || nextKey(index);
            usedKeys.add(String(key));
            return {
                key:String(key),
                label:labels[index] || String(original?.label || `参考图 ${index + 1}`).trim() || `参考图 ${index + 1}`,
                required:true,
            };
        });
        const requestedMax = requiredCount + requestedOptional;
        return {
            requiredCount,
            optionalCount:requestedOptional,
            referenceImages:[...requiredSlots, ...optionalSlots],
            maxUploadCount:requestedMax,
            allowExtraImages:extraImageLimit > 0,
            extraImageLimit,
        };
    }
    function renderAdminRequiredSlotFields(mode){
        const container = byId('adminRequiredSlotFields');
        const referenceImages = Array.isArray(mode?.reference_images) ? mode.reference_images : [];
        const currentRequired = referenceImages.filter(slot => slot && slot.required);
        const count = clampAdminRuleCount(byId('adminRequiredCount')?.value, currentRequired.length);
        const previousLabels = adminRequiredSlotLabels();
        container.innerHTML = Array.from({length:count}, (_, index) => {
            const label = previousLabels[index] || String(currentRequired[index]?.label || `参考图 ${index + 1}`).trim() || `参考图 ${index + 1}`;
            return `<label class="field"><span>图${index + 1}名称</span><input data-admin-slot-label="${index}" maxlength="200" value="${escapeHtml(label)}" placeholder="例如：设计稿/参考图"></label>`;
        }).join('');
    }
    function updateAdminUploadRulePreview(){
        const mode = runtime.admin.currentMode;
        if(!mode) return;
        const draft = adminRuleDraft(mode);
        const details = uploadRuleDetails({
            required_reference_count:draft.requiredCount,
            reference_images:draft.referenceImages,
            max_upload_count:draft.maxUploadCount,
            allow_extra_images:draft.allowExtraImages,
            extra_image_limit:draft.extraImageLimit,
        });
        const preview = byId('adminUploadRulePreview');
        preview.textContent = `${details.countText}${details.roles ? `\n${details.roles}` : ''}`;
    }
    function renderAdminUploadRules(mode){
        const referenceImages = Array.isArray(mode?.reference_images) ? mode.reference_images : [];
        const requiredCount = referenceImages.filter(slot => slot && slot.required).length;
        const namedOptionalCount = referenceImages.filter(slot => slot && !slot.required).length;
        const optionalCount = Math.min(6 - requiredCount, Math.max(0, Number(mode?.extra_image_limit || 0) + namedOptionalCount));
        byId('adminRequiredCount').value = String(requiredCount);
        byId('adminOptionalCount').value = String(optionalCount);
        renderAdminRequiredSlotFields(mode);
        updateAdminUploadRulePreview();
    }
    function renderAdminModeEditor(){
        const mode = runtime.admin.currentMode;
        byId('adminModeEmpty').hidden = Boolean(mode);
        byId('adminModeFields').hidden = !mode;
        if(!mode) return;
        byId('adminModeNumber').textContent = modeNumber(mode);
        byId('adminModeNameHeading').textContent = mode.__isNew ? '新增模式' : (mode.display_name || '模式');
        byId('adminModeName').value = mode.display_name || '';
        byId('adminModeCategory').value = mode.category || '';
        byId('adminModeSort').value = Number.isFinite(Number(mode.sort_order)) ? String(mode.sort_order) : '';
        const modeDescription = String(mode.description || '').trim() || String(mode.remark || '').trim();
        byId('adminModeDescription').value = modeDescription;
        byId('adminPromptText').value = mode.preset_prompt || '';
        byId('adminModeEnabled').checked = mode.status === 'active';
        syncAdminStatusToggle();
        renderAdminExamplePreview(mode.example);
        renderAdminUploadRules(mode);
        byId('saveAdminMode').querySelector('span').textContent = mode.__isNew ? '创建模式' : '保存设置';
        setDialogStatus('adminManagerStatus');
        refreshIcons();
    }
    async function refreshAdminAndPublic(modeId=''){
        await reloadPublicModes();
        await loadAdminModes(modeId || runtime.admin.currentMode?.id || '');
    }
    async function saveAdminMode(){
        const mode = runtime.admin.currentMode;
        if(!mode) return;
        const creating = Boolean(mode.__isNew);
        const button = byId('saveAdminMode');
        const sortRaw = byId('adminModeSort').value.trim();
        const payload = {};
        const addChanged = (key, value, current) => { if(creating || value !== current) payload[key] = value; };
        const modeDescription = String(mode.description || '').trim() || String(mode.remark || '').trim();
        addChanged('display_name', byId('adminModeName').value.trim(), String(mode.display_name || ''));
        addChanged('sort_order', sortRaw ? Math.max(0, Number.parseInt(sortRaw, 10) || 0) : 0, Number(mode.sort_order) || 0);
        addChanged('category', byId('adminModeCategory').value.trim(), String(mode.category || ''));
        addChanged('description', byId('adminModeDescription').value.trim(), modeDescription);
        if(Object.hasOwn(payload, 'description')) payload.remark = payload.description;
        addChanged('preset_prompt', byId('adminPromptText').value, String(mode.preset_prompt || ''));
        const uploadRules = adminRuleDraft(mode);
        if(JSON.stringify(uploadRules.referenceImages) !== JSON.stringify(mode.reference_images || [])) payload.reference_images = uploadRules.referenceImages;
        addChanged('required_reference_count', uploadRules.requiredCount, Number(mode.required_reference_count) || 0);
        addChanged('max_upload_count', uploadRules.maxUploadCount, Number(mode.max_upload_count) || 0);
        addChanged('allow_extra_images', uploadRules.allowExtraImages, Boolean(mode.allow_extra_images));
        addChanged('extra_image_limit', uploadRules.extraImageLimit, Number(mode.extra_image_limit) || 0);
        if(mode.example) addChanged('example_caption', byId('adminExampleCaption').value, String(mode.example.caption || ''));
        const enabled = byId('adminModeEnabled').checked;
        if(creating || enabled !== (mode.status === 'active')) payload.status = enabled ? 'active' : 'archived';
        if(creating && !payload.display_name){
            setDialogStatus('adminManagerStatus', '请先填写模式名称', true);
            byId('adminModeName').focus();
            return;
        }
        if(!Object.keys(payload).length){
            setDialogStatus('adminManagerStatus', '没有需要保存的修改');
            return;
        }
        button.disabled = true;
        setDialogStatus('adminManagerStatus', creating ? '正在创建模式…' : '正在保存…');
        try {
            const endpoint = creating ? '/api/image-generation/admin/modes' : `/api/image-generation/modes/${encodeURIComponent(mode.id)}`;
            const saved = await adminRequestJson(endpoint, {method:creating ? 'POST' : 'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
            await refreshAdminAndPublic(saved.item.id);
            showToast(creating ? `${modeNumber(saved.item)} 模式已创建` : '当前预设已保存');
        } catch(error) {
            setDialogStatus('adminManagerStatus', error.message || (creating ? '创建失败' : '保存失败'), true);
        } finally { button.disabled = false; }
    }
    function renderExampleDialogPreview(inputMedia, outputMedia){
        const inputs = (inputMedia || []).map((item, index) => ({
            media:item.media || item,
            slotKey:String(item.slot_key || `图 ${index + 1}`),
        })).filter(item => mediaUrl(item.media));
        const inputMarkup = inputs.map(item => `<figure><div class="set-example-media-frame"><img src="${escapeHtml(mediaUrl(item.media))}" alt="${escapeHtml(item.slotKey)}" loading="lazy"></div><figcaption>${escapeHtml(item.slotKey)}</figcaption></figure>`).join('');
        const outputMarkup = mediaUrl(outputMedia) ? `<figure><div class="set-example-media-frame"><img src="${escapeHtml(mediaUrl(outputMedia))}" alt="示范输出" loading="lazy"></div><figcaption>处理后</figcaption></figure>` : '';
        const mediaLayout = exampleMediaLayout(inputs.length, Boolean(outputMarkup));
        const inputSide = inputs.length ? `<div class="media-side set-example-input-side" aria-label="处理前示范图片">${inputMarkup}</div>` : '';
        const comparisonArrow = mediaLayout === 'comparison' ? `<div class="set-example-preview-arrow" aria-hidden="true"><i data-lucide="arrow-right"></i></div>` : '';
        const outputSide = outputMarkup ? `<div class="media-side set-example-output-side" aria-label="处理后示范图片">${outputMarkup}</div>` : '';
        byId('setExamplePreview').className = `set-example-preview is-${mediaLayout}`;
        byId('setExamplePreview').innerHTML = `${inputSide}${comparisonArrow}${outputSide}`;
        refreshIcons();
    }
    function exampleMediaDimensions(example){
        if(!example || typeof example !== 'object') return [];
        const records = [];
        const add = value => {
            const media = value?.media && typeof value.media === 'object' ? value.media : value;
            const width = Number(media?.width);
            const height = Number(media?.height);
            if(width > 0 && height > 0) records.push({width, height});
        };
        for(const item of (Array.isArray(example.input_media) ? example.input_media : [])) add(item);
        add(example.output_media);
        return records;
    }
    function exampleSavedToast(example){
        const dimensions = exampleMediaDimensions(example);
        if(!dimensions.length) return '固定效果示范已保存';
        const maximum = dimensions.reduce((current, item) => ({
            width:Math.max(current.width, item.width),
            height:Math.max(current.height, item.height),
        }), {width:0, height:0});
        return `固定效果示范已保存 · 最大 ${maximum.width}×${maximum.height}`;
    }
    async function openSetExampleDialog(taskId, candidateId){
        if(!runtime.admin.active) return;
        let task = runtime.taskCache.get(taskId);
        // History summaries may contain candidates but omit the original prompt;
        // fetch the full task so the admin field is always prefilled accurately.
        if(!task?.candidates || typeof task.user_prompt !== 'string' || !Array.isArray(task.inputs)) task = await requestJson(`/api/image-generation-tasks/${encodeURIComponent(taskId)}`);
        const candidate = candidateFromTask(task, candidateId);
        if(!candidate || candidate.status !== 'succeeded') return showToast('只有成功图片可以设为示范', true);
        runtime.admin.exampleTarget = {kind:'create', taskId, candidateId, modeId:task.mode_id};
        const output = candidateImage(candidate);
        renderExampleDialogPreview(task.inputs, output);
        byId('setExampleTitle').textContent = '设为模式示范';
        byId('exampleCaption').value = '';
        byId('exampleUserPrompt').value = task.user_prompt || '';
        setDialogStatus('setExampleStatus');
        byId('setExampleDialog').showModal();
        refreshIcons();
    }
    async function saveModeExample(event){
        event.preventDefault();
        const target = runtime.admin.exampleTarget;
        if(!target) return;
        const submit = byId('setExampleForm')?.querySelector('button[type="submit"]');
        const originalLabel = submit ? submit.textContent : '';
        if(submit){ submit.disabled = true; submit.textContent = '正在优化示范图…'; }
        setDialogStatus('setExampleStatus', '正在按 1,048,576 像素上限优化输入图和输出图，请稍候…');
        try {
            const payload = {task_id:target.taskId, candidate_id:target.candidateId, caption:byId('exampleCaption').value, sample_user_prompt:byId('exampleUserPrompt').value, show_user_prompt:true};
            const saved = await adminRequestJson(`/api/image-generation/modes/${encodeURIComponent(target.modeId)}/example`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
            byId('setExampleDialog').close();
            runtime.admin.exampleTarget = null;
            await refreshAdminAndPublic(target.modeId);
            showToast(exampleSavedToast(saved.item));
        } catch(error) {
            setDialogStatus('setExampleStatus', error.message || '示范保存失败', true);
        } finally {
            if(submit){ submit.disabled = false; submit.textContent = originalLabel || '保存固定示范'; }
        }
    }
    function openAdminManager(modeId=''){
        if(!runtime.admin.active){
            if(!byId('adminPasswordDialog').open) byId('adminPasswordDialog').showModal();
            byId('adminPassword').focus();
            return;
        }
        const managerDialog = byId('adminManagerDialog');
        if(!managerDialog.open) managerDialog.showModal();
        loadAdminModes(modeId || runtime.currentMode?.id || '').catch(error => setDialogStatus('adminManagerStatus', error.message, true));
    }

    function bindStaticEvents(){
        byId('modeSearch').addEventListener('input', event => { runtime.search = event.target.value; if(runtime.search) runtime.category = '全部'; renderHall(); });
        byId('clearModeSearch').addEventListener('click', () => { runtime.search = ''; byId('modeSearch').value = ''; renderHall(); byId('modeSearch').focus(); });
        byId('modeCategories').addEventListener('click', event => { const button = event.target.closest('[data-category]'); if(button){ runtime.category = button.dataset.category; renderHall(); } });
        byId('backToModes').addEventListener('click', leaveWorkbench);
        byId('viewModeExample').addEventListener('click', openModeExampleDialog);
        byId('modeExampleDialogContent').addEventListener('click', event => {
            const trigger = event.target.closest('[data-example-image]');
            if(trigger) openCaseImagePreview(trigger.dataset.exampleImage, trigger.dataset.exampleAlt);
        });
        const casePreviewDialog = byId('caseImagePreviewDialog');
        const casePreviewImage = byId('caseImagePreview');
        const casePreviewShell = casePreviewDialog.querySelector('.case-image-preview-shell');
        const finishCasePreviewDrag = event => {
            if(!runtime.casePreview.dragging || runtime.casePreview.pointerId !== event.pointerId) return;
            runtime.casePreview.dragging = false;
            runtime.casePreview.pointerId = null;
            casePreviewShell.classList.remove('is-dragging');
            try { casePreviewShell.releasePointerCapture(event.pointerId); } catch(_) {}
        };
        casePreviewShell.addEventListener('pointerdown', event => {
            if(event.button !== 0 || event.target.closest('button') || !casePreviewShell.classList.contains('can-pan')) return;
            Object.assign(runtime.casePreview, {
                dragging:true,
                pointerId:event.pointerId,
                startX:event.clientX,
                startY:event.clientY,
                originX:runtime.casePreview.panX,
                originY:runtime.casePreview.panY,
            });
            casePreviewShell.classList.add('is-dragging');
            try { casePreviewShell.setPointerCapture(event.pointerId); } catch(_) {}
        });
        casePreviewShell.addEventListener('pointermove', event => {
            const state = runtime.casePreview;
            if(!state.dragging || state.pointerId !== event.pointerId) return;
            const deltaX = event.clientX - state.startX;
            const deltaY = event.clientY - state.startY;
            const pan = clampCaseImagePreviewPan({
                x:state.originX + deltaX,
                y:state.originY + deltaY,
                imageWidth:casePreviewImage.naturalWidth * state.scale,
                imageHeight:casePreviewImage.naturalHeight * state.scale,
                viewportWidth:casePreviewShell.clientWidth,
                viewportHeight:casePreviewShell.clientHeight,
            });
            state.panX = pan.x;
            state.panY = pan.y;
            applyCaseImagePreviewView();
            event.preventDefault();
        });
        casePreviewShell.addEventListener('pointerup', finishCasePreviewDrag);
        casePreviewShell.addEventListener('pointercancel', finishCasePreviewDrag);
        casePreviewShell.addEventListener('wheel', event => {
            if(event.target.closest('button')) return;
            event.preventDefault();
            event.stopPropagation();
            const factor = event.deltaY < 0 ? CASE_PREVIEW_ZOOM_STEP : 1 / CASE_PREVIEW_ZOOM_STEP;
            setCaseImagePreviewZoomAt(runtime.casePreview.scale * factor, event.clientX, event.clientY);
        }, {passive:false});
        casePreviewImage.addEventListener('dblclick', event => {
            event.preventDefault();
            event.stopPropagation();
            closeCaseImagePreview();
        });
        byId('caseImagePreviewDialog').addEventListener('click', event => {
            if(event.target === event.currentTarget) closeCaseImagePreview();
        });
        byId('caseImagePreviewDialog').addEventListener('close', () => {
            const image = byId('caseImagePreview');
            document.body.classList.remove('case-image-preview-active');
            notifyCaseImagePreviewHost(false);
            casePreviewShell.classList.remove('can-pan', 'is-dragging');
            Object.assign(runtime.casePreview, {scale:1, fitScale:1, initialized:false, panX:0, panY:0, dragging:false, pointerId:null});
            image.onload = null;
            image.removeAttribute('src');
            image.removeAttribute('style');
            image.removeAttribute('aria-label');
            image.alt = '';
        });
        byId('workbenchFavorite').addEventListener('click', () => runtime.currentMode && toggleFavorite(runtime.currentMode.id));
        byId('slotFilePicker').addEventListener('change', event => uploadFilesToSlot(event.target.files, runtime.uploadSlotKey));
        byId('userPrompt').addEventListener('input', event => updateUserPrompt(event.target.value, 'compact'));
        byId('openPromptLibrary').addEventListener('click', openImagePromptLibrary);
        byId('openUserPromptEditor').addEventListener('click', openUserPromptEditor);
        byId('closeUserPromptEditor').addEventListener('click', closeUserPromptEditor);
        byId('userPromptEditor').addEventListener('input', event => updateUserPrompt(event.target.value, 'editor'));
        byId('userPromptEditorFont').addEventListener('click', event => {
            const button = event.target.closest('[data-prompt-font]');
            if(button) setUserPromptEditorFont(button.dataset.promptFont);
        });
        byId('userPromptEditorDialog').addEventListener('click', event => {
            if(event.target === event.currentTarget) closeUserPromptEditor();
        });
        const imagePromptDialog = byId('imageGenerationPromptDialog');
        const imagePromptBody = byId('imageGenerationPromptBody');
        byId('closeImageGenerationPrompt').addEventListener('click', closeImagePromptLibrary);
        imagePromptDialog.addEventListener('cancel', event => {
            event.preventDefault();
            closeImagePromptLibrary();
        });
        imagePromptDialog.addEventListener('click', event => {
            if(event.target === event.currentTarget) closeImagePromptLibrary();
        });
        byId('imageGenerationPromptSearch').addEventListener('input', event => {
            imagePromptLibraryState.query = event.target.value || '';
            renderImagePromptLibrary();
        });
        byId('imageGenerationPromptLibrarySelect').addEventListener('change', event => {
            imagePromptLibraryState.activeLibraryId = event.target.value || '';
            imagePromptLibraryState.category = 'all';
            imagePromptLibraryState.selectedId = '';
            renderImagePromptLibrary();
        });
        byId('imageGenerationPromptCats').addEventListener('click', event => {
            const category = event.target.closest('[data-image-prompt-category]');
            if(!category) return;
            imagePromptLibraryState.category = category.dataset.imagePromptCategory || 'all';
            imagePromptLibraryState.selectedId = '';
            renderImagePromptLibrary();
        });
        imagePromptBody.addEventListener('click', async event => {
            const action = event.target.closest('[data-image-prompt-action]');
            if(action){
                event.preventDefault();
                const template = selectedImagePromptTemplate();
                if(action.dataset.imagePromptAction === 'copy'){
                    const copied = await copyImagePromptText(template?.positive || '');
                    showToast(copied ? '提示词已复制' : '复制失败', !copied);
                } else if(action.dataset.imagePromptAction === 'write') await applyImagePromptTemplate(template);
                return;
            }
            const card = event.target.closest('[data-image-prompt-template-id]');
            if(!card || !imagePromptBody.contains(card)) return;
            const cardId = card.dataset.imagePromptTemplateId || '';
            const now = Date.now();
            const repeated = imagePromptLibraryState.lastCardId === cardId && now - Number(imagePromptLibraryState.lastCardAt || 0) <= 650;
            imagePromptLibraryState.lastCardId = cardId;
            imagePromptLibraryState.lastCardAt = now;
            imagePromptLibraryState.selectedId = cardId;
            if(repeated){
                imagePromptLibraryState.lastCardId = '';
                imagePromptLibraryState.lastCardAt = 0;
                await applyImagePromptTemplate(selectedImagePromptTemplate());
                return;
            }
            renderImagePromptLibrary();
        });
        imagePromptBody.addEventListener('keydown', async event => {
            if(event.key !== 'Enter' || event.target.closest('[data-image-prompt-action]')) return;
            const card = event.target.closest('[data-image-prompt-template-id]');
            if(!card || !imagePromptBody.contains(card)) return;
            event.preventDefault();
            imagePromptLibraryState.selectedId = card.dataset.imagePromptTemplateId || '';
            await applyImagePromptTemplate(selectedImagePromptTemplate());
        });
        byId('imageProvider').addEventListener('change', event => { runtime.settings.image_provider_id = event.target.value; runtime.settings.image_model = ''; renderModelOptions(); markDirty(); });
        byId('imageModel').addEventListener('change', event => { runtime.settings.image_model = event.target.value; markDirty(); });
        byId('aspectRatio').addEventListener('change', event => {
            const value = String(event.target.value || '1:1');
            if(['source','adaptive','custom'].includes(value)){
                runtime.settings.ratio_mode = value;
                if(value === 'adaptive') runtime.settings.aspect_ratio = '';
                if(value === 'custom' && (!runtime.settings.custom_ratio_width || !runtime.settings.custom_ratio_height)){
                    const initial = ratioParts(runtime.settings.aspect_ratio) || {width:1, height:1};
                    runtime.settings.custom_ratio_width = String(initial.width);
                    runtime.settings.custom_ratio_height = String(initial.height);
                }
            } else {
                runtime.settings.ratio_mode = 'fixed';
                runtime.settings.aspect_ratio = value;
            }
            syncRatioControls();
            markDirty();
        });
        for(const [id, key] of [['customRatioWidth','custom_ratio_width'], ['customRatioHeight','custom_ratio_height']]){
            byId(id).addEventListener('input', event => {
                runtime.settings[key] = event.target.value;
                const resolved = resolveGenerationRatio(runtime.settings, runtime.inputs);
                if(resolved.valid && runtime.settings.ratio_mode === 'custom') runtime.settings.aspect_ratio = resolved.aspect_ratio;
                syncRatioControls();
                markDirty();
            });
        }
        byId('resolution').addEventListener('change', event => { runtime.settings.resolution = event.target.value; syncRatioControls(); markDirty(); });
        byId('imageCount').addEventListener('change', event => { runtime.settings.image_count = Number(event.target.value) || 1; syncGenerateButtonLabel(); markDirty(); });
        byId('saveDraft').addEventListener('click', () => imageGenerationSaveDraft());
        byId('generateImages').addEventListener('click', () => submitGeneration());
        byId('createDraftFromTask').addEventListener('click', fromTaskInputs);
        byId('newGenerationDraft').addEventListener('click', startNewDraft);
        byId('selectAllResults').addEventListener('click', () => {
            const selectable = resultItems().filter(resultItemSelectable);
            const selectedCount = selectable.filter(item => runtime.selectedResultKeys.has(item.key)).length;
            const selectionAction = resultSelectionAction(selectedCount);
            if(selectionAction.clearsSelection) runtime.selectedResultKeys.clear();
            else selectable.forEach(item => runtime.selectedResultKeys.add(item.key));
            renderResults();
        });
        byId('downloadSelectedResults').addEventListener('click', downloadSelectedResults);
        byId('deleteSelectedResults').addEventListener('click', deleteSelectedResults);
        byId('openGlobalHistory').addEventListener('click', openGlobalHistory);
        byId('cleanupTerminalRecords').addEventListener('click', openTerminalCleanupConfirm);
        byId('openDataManagement').addEventListener('click', openDataManagementDialog);
        byId('closeDataManagement').addEventListener('click', () => closeDataManagement());
        byId('cancelDataManagement').addEventListener('click', () => closeDataManagement());
        byId('requestDataCleanup').addEventListener('click', requestDataCleanupPreview);
        byId('cancelDataCleanupConfirm').addEventListener('click', cancelDataCleanupConfirm);
        byId('confirmDataCleanup').addEventListener('click', confirmDataCleanup);
        byId('dataManagementDialog').addEventListener('cancel', event => {
            event.preventDefault();
            closeDataManagement();
        });
        byId('dataCleanupConfirmDialog').addEventListener('cancel', event => {
            event.preventDefault();
            cancelDataCleanupConfirm();
        });
        byId('cancelTerminalCleanup').addEventListener('click', cancelTerminalCleanupConfirm);
        byId('confirmTerminalCleanup').addEventListener('click', confirmTerminalCleanup);
        byId('terminalCleanupConfirmDialog').addEventListener('cancel', event => {
            event.preventDefault();
            cancelTerminalCleanupConfirm();
        });
        byId('previewPrevious').addEventListener('click', () => navigatePreview(-1));
        byId('previewNext').addEventListener('click', () => navigatePreview(1));
        byId('previewCompareSlider').addEventListener('input', event => setPreviewSlider(event.target.value));
        byId('previewCompareModes').addEventListener('click', event => {
            const button = event.target.closest('[data-preview-mode]');
            if(button) setPreviewMode(button.dataset.previewMode);
        });
        byId('previewAlignModes').addEventListener('click', event => {
            const button = event.target.closest('[data-preview-align]');
            if(button) setPreviewAlign(button.dataset.previewAlign);
        });
        byId('previewSourceImage').addEventListener('load', applyPreviewImageLayout);
        byId('imagePreviewDialog').addEventListener('close', () => {
            setPreviewSpacePanHeld(false);
            resetPreviewTransform();
            byId('previewImage').removeAttribute('src');
            byId('previewSourceImage').removeAttribute('src');
            resetPreviewResultPresentation();
            runtime.previewItems = [];
            runtime.previewIndex = -1;
            syncPreviewNavigation();
        });
        bindResultGalleryResizeObserver();
        window.addEventListener('resize', () => {
            scheduleResultGalleryLayout();
            if(byId('imagePreviewDialog').open) applyPreviewImageLayout();
            if(byId('caseImagePreviewDialog').open) applyCaseImagePreviewView();
        });
        for(const id of ['globalHistoryModeFilter','globalHistoryStatusFilter','globalHistoryDateFilter']) byId(id).addEventListener('change', renderGlobalHistory);
        byId('globalHistoryNameFilter').addEventListener('input', () => {
            syncGlobalHistoryNameClear();
            renderGlobalHistory();
        });
        byId('clearGlobalHistoryNameFilter').addEventListener('click', clearGlobalHistoryNameSearch);
        document.addEventListener('keydown', event => {
            syncResultQuickSelectCursor(event.ctrlKey);
            if(byId('imagePreviewDialog')?.open && (event.code === 'Space' || event.key === ' ') && !previewSpacePanShortcutTarget(event.target)){
                event.preventDefault();
                setPreviewSpacePanHeld(true);
                return;
            }
            if(byId('caseImagePreviewDialog')?.open){
                if(event.key === 'Escape'){
                    event.preventDefault();
                    closeCaseImagePreview();
                    return;
                }
                if(event.key === '+' || event.key === '='){
                    event.preventDefault();
                    const shell = byId('caseImagePreviewDialog').querySelector('.case-image-preview-shell');
                    const rect = shell.getBoundingClientRect();
                    setCaseImagePreviewZoomAt(runtime.casePreview.scale * CASE_PREVIEW_ZOOM_STEP, rect.left + rect.width / 2, rect.top + rect.height / 2);
                    return;
                }
                if(event.key === '-' || event.key === '_'){
                    event.preventDefault();
                    const shell = byId('caseImagePreviewDialog').querySelector('.case-image-preview-shell');
                    const rect = shell.getBoundingClientRect();
                    setCaseImagePreviewZoomAt(runtime.casePreview.scale / CASE_PREVIEW_ZOOM_STEP, rect.left + rect.width / 2, rect.top + rect.height / 2);
                    return;
                }
                const arrowPan = {ArrowLeft:[40,0], ArrowRight:[-40,0], ArrowUp:[0,40], ArrowDown:[0,-40]}[event.key];
                if(arrowPan && panCaseImagePreviewBy(...arrowPan)){
                    event.preventDefault();
                    return;
                }
            }
            if(byId('imagePreviewDialog')?.open && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')){
                if(event.target === byId('previewCompareSlider')) return;
                event.preventDefault();
                navigatePreview(event.key === 'ArrowLeft' ? -1 : 1);
                return;
            }
            if(canLeaveWorkbenchWithEscape(event)){
                event.preventDefault();
                leaveWorkbench();
                return;
            }
            if(event.ctrlKey && event.altKey && event.key.toLowerCase() === 'm'){
                event.preventDefault();
                openAdminManager(runtime.currentMode?.id || '');
            }
        });
        document.addEventListener('keyup', event => {
            syncResultQuickSelectCursor(event.ctrlKey);
            if(event.code === 'Space' || event.key === ' '){
                event.preventDefault();
                setPreviewSpacePanHeld(false);
            }
        });
        window.addEventListener('blur', () => {
            syncResultQuickSelectCursor(false);
            setPreviewSpacePanHeld(false);
        });
        document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => {
            const dialog = byId(button.dataset.closeDialog);
            if(dialog?.open) dialog.close();
        }));
        byId('adminPasswordDialog').addEventListener('close', () => {
            byId('adminPassword').value = '';
            setDialogStatus('adminPasswordStatus');
        });
        byId('setExampleDialog').addEventListener('close', () => {
            runtime.admin.exampleTarget = null;
            byId('setExamplePreview').replaceChildren();
            setDialogStatus('setExampleStatus');
        });
        byId('adminPasswordForm').addEventListener('submit', unlockAdminMode);
        byId('openAdminManager').addEventListener('click', () => openAdminManager());
        byId('manageCurrentMode').addEventListener('click', () => openAdminManager(runtime.currentMode?.id || ''));
        byId('exitAdminMode').addEventListener('click', exitAdminMode);
        byId('adminModeSelect').addEventListener('change', event => loadAdminModeDetail(event.target.value));
        byId('createAdminMode').addEventListener('click', startAdminModeCreation);
        byId('adminModeEnabled').addEventListener('change', syncAdminStatusToggle);
        byId('adminRequiredCount').addEventListener('input', () => {
            const requiredCount = clampAdminRuleCount(byId('adminRequiredCount').value);
            byId('adminRequiredCount').value = String(requiredCount);
            const optionalMaximum = Math.max(0, 6 - requiredCount);
            const optionalCount = clampAdminRuleCount(byId('adminOptionalCount').value, 0, optionalMaximum);
            byId('adminOptionalCount').value = String(optionalCount);
            renderAdminRequiredSlotFields(runtime.admin.currentMode || {});
            updateAdminUploadRulePreview();
        });
        byId('adminOptionalCount').addEventListener('input', () => {
            const requiredCount = clampAdminRuleCount(byId('adminRequiredCount').value);
            const optionalMaximum = Math.max(0, 6 - requiredCount);
            byId('adminOptionalCount').value = String(clampAdminRuleCount(byId('adminOptionalCount').value, 0, optionalMaximum));
            updateAdminUploadRulePreview();
        });
        byId('adminRequiredSlotFields').addEventListener('input', updateAdminUploadRulePreview);
        byId('saveAdminMode').addEventListener('click', saveAdminMode);
        byId('setExampleForm').addEventListener('submit', saveModeExample);
        document.addEventListener('paste', event => {
            if(!runtime.currentMode || runtime.readOnlyHistory) return;
            const files = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
            if(files.length){ event.preventDefault(); uploadFilesToSlot(files, firstEmptySlot()); }
        });
        window.addEventListener('beforeunload', () => {
            if(runtime.currentMode && runtime.dirty){ runtime.pendingDrafts[runtime.currentMode.id] = currentLocalDraftPayload(); saveLocalDrafts(); }
        });
        window.addEventListener('message', event => {
            if(event.data?.type === 'studio-theme-changed') document.documentElement.classList.toggle('studio-theme-dark', event.data.theme === 'dark');
        });
    }

    async function bootstrap(){
        bindStaticEvents();
        refreshIcons();
        try {
            const [modePayload, configPayload] = await Promise.all([
                requestJson('/api/image-generation/modes'),
                requestJson('/api/config').catch(() => ({api_providers:[]})),
            ]);
            runtime.modes = Array.isArray(modePayload.items) ? modePayload.items : [];
            runtime.config = configPayload || {api_providers:[]};
            setPageStatus(`${runtime.modes.filter(mode => mode.status === 'active').length} 个可用模式`);
            renderHall();
            await loadAllTaskSummaries();
        } catch(error) {
            setPageStatus('模式读取失败');
            byId('modeGrid').innerHTML = '';
            byId('modeEmpty').hidden = false;
            byId('modeEmpty').querySelector('strong').textContent = '无法读取本机模式';
            showToast(error.message || '模式读取失败', true);
        }
        await restoreAdminSession();
    }

        if(typeof module !== 'undefined' && module.exports){
            module.exports = {normalizeSearch, modeSearchText, slotDefinitions, taskVisualStatus, taskStatusLabel, taskCompletionOutcome, taskHallNotice, taskNoticeStateAfterTask, frameSurfaceVisible, completionTransitionOutcome, playImageGenerationCompletionSound, maybePlayTaskCompletionSound, submissionIdForKind, submissionFailureMessage, unknownCandidateAction, candidateStatusLabel, candidateUnknownReason, taskMatchesStatusFilter, globalHistoryGroupLabel, globalHistoryIdentity, terminalCleanupStatus, terminalCleanupCounts, cleanupConfirmationView, isLatestNavigation, modeContextFromTask, normalizeGenerationRatioSettings, resolveGenerationRatio, ratioHintView, previewSourceUrl, linkedSidePreviewZoomState, previewPointerIntent, previewImageRenderLayout, examplePromptView, exampleMediaLayout, caseImagePreviewFitSize, clampCaseImagePreviewPan, caseImagePreviewZoomState, candidateFailureView, resultItemSelectable, resultItemDownloadable, resultSelectionLabel, resultSelectionAction, isResultQuickSelect, timestampMilliseconds, formatElapsedDuration, candidateElapsedStart, galleryRatio, galleryRows, galleryRowMetrics, calculateResultGalleryRowSize, imagePromptTemplateName, imagePromptTemplateScene, imagePromptTemplateCategoryLabel, imagePromptTemplateSearchText, imagePromptTemplateVisibleItems, selectedImagePromptTemplate, applyImagePromptTemplate};
        }
    if(typeof document !== 'undefined'){
        if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap, {once:true});
        else bootstrap();
    }
})();
