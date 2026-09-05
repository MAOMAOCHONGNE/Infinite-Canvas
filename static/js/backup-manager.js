(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.InfiniteCanvasBackup = api;
    if(root?.document){
        if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => api.initBackupManager());
        else setTimeout(() => api.initBackupManager(), 0);
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict';

    function asArray(value){ return Array.isArray(value) ? value : []; }
    function itemId(item){ return String(item?.id || ''); }
    function imageGenerationModesAvailable(options={}){
        const value = options.image_generation_modes;
        return value === true || Boolean(value && typeof value === 'object' && (
            value.available === true || Number(value.mode_count || value.count || 0) > 0 || Number(value.example_count || 0) > 0
        ));
    }
    function storageRef(){
        try { return globalThis.localStorage || null; } catch(_error){ return null; }
    }
    function readPortablePreferences(){
        const storage = storageRef();
        const themeApi = globalThis.StudioTheme;
        const scaleApi = globalThis.StudioScale;
        let favorites = {};
        try {
            if(globalThis.ClassicNodeFavorites?.loadPreference) favorites = globalThis.ClassicNodeFavorites.loadPreference(storage);
            else favorites = JSON.parse(storage?.getItem?.('infinite_canvas_classic_node_favorites_v1') || '{}');
        } catch(_error) { favorites = {}; }
        return {
            theme: themeApi?.get?.() || storage?.getItem?.('studio_theme') || storage?.getItem?.('canvas_theme') || 'light',
            scale_mode: scaleApi?.getMode?.() || storage?.getItem?.('studio_ui_scale_mode') || 'auto',
            favorites,
        };
    }
    function applyPortablePreferences(preferences){
        const source = preferences && typeof preferences === 'object' ? preferences : {};
        const storage = storageRef();
        const theme = source.theme === 'dark' ? 'dark' : 'light';
        const scaleMode = typeof source.scale_mode === 'string' ? source.scale_mode : 'auto';
        try {
            if(globalThis.StudioTheme?.set) globalThis.StudioTheme.set(theme);
            else {
                storage?.setItem?.('studio_theme', theme);
                storage?.setItem?.('canvas_theme', theme);
            }
            if(globalThis.StudioScale?.set) globalThis.StudioScale.set(scaleMode);
            else storage?.setItem?.('studio_ui_scale_mode', scaleMode);
            if(source.favorites && globalThis.ClassicNodeFavorites?.savePreference){
                globalThis.ClassicNodeFavorites.savePreference(storage, source.favorites);
            } else if(source.favorites && storage){
                storage.setItem('infinite_canvas_classic_node_favorites_v1', JSON.stringify(source.favorites));
            }
            return true;
        } catch(_error){ return false; }
    }
    function createBackupSelection(options={}){
        const projects = asArray(options.projects);
        const providers = asArray(options.providers);
        const apps = asArray(options.runninghub?.apps);
        const workflows = asArray(options.runninghub?.workflows);
        const promptLibraries = asArray(options.prompt_libraries);
        const detailPages = asArray(options.detail_pages);
        const mainImages = asArray(options.main_images);
        const imageGenerations = asArray(options.image_generations);
        const projectCanvases = new Map();
        projects.forEach(project => projectCanvases.set(itemId(project), asArray(project.canvases).map(itemId).filter(Boolean)));
        return {
            options,
            projectCanvases,
            projectIds:new Set(projects.map(itemId).filter(Boolean)),
            canvasIds:new Set(projects.flatMap(project => asArray(project.canvases).map(itemId)).filter(Boolean)),
            providerIds:new Set(providers.map(itemId).filter(Boolean)),
            runninghubAppIds:new Set(apps.map(itemId).filter(Boolean)),
            runninghubWorkflowIds:new Set(workflows.map(itemId).filter(Boolean)),
            promptLibraryIds:new Set(promptLibraries.map(itemId).filter(Boolean)),
            detailPageTaskIds:new Set(detailPages.map(itemId).filter(Boolean)),
            mainImageTaskIds:new Set(mainImages.map(itemId).filter(Boolean)),
            imageGenerationTaskIds:new Set(imageGenerations.map(itemId).filter(Boolean)),
            includeImageGenerationModes:imageGenerationModesAvailable(options),
            includeAssets:true,
            includePreferences:Boolean(options.preferences?.available),
        };
    }
    function projectSelectionState(state, projectId){
        const ids = state.projectCanvases.get(String(projectId)) || [];
        if(!ids.length) return state.projectIds.has(String(projectId)) ? 'checked' : 'unchecked';
        const count = ids.filter(id => state.canvasIds.has(id)).length;
        if(count === ids.length) return 'checked';
        return count ? 'mixed' : 'unchecked';
    }
    function setProjectSelected(state, projectId, selected){
        const id = String(projectId);
        const ids = state.projectCanvases.get(id) || [];
        if(selected) state.projectIds.add(id); else state.projectIds.delete(id);
        ids.forEach(canvasId => selected ? state.canvasIds.add(canvasId) : state.canvasIds.delete(canvasId));
    }
    function setCanvasSelected(state, canvasId, selected){
        const id = String(canvasId);
        if(selected) state.canvasIds.add(id); else state.canvasIds.delete(id);
        for(const [projectId, ids] of state.projectCanvases.entries()){
            if(!ids.includes(id)) continue;
            if(ids.some(child => state.canvasIds.has(child))) state.projectIds.add(projectId);
            else state.projectIds.delete(projectId);
            break;
        }
    }
    function setDetailPageSelected(state, taskId, selected){
        setIdsSelected(state.detailPageTaskIds, [taskId], selected);
    }
    function setMainImageSelected(state, taskId, selected){
        setIdsSelected(state.mainImageTaskIds, [taskId], selected);
    }
    function setImageGenerationSelected(state, taskId, selected){
        setIdsSelected(state.imageGenerationTaskIds, [taskId], selected);
    }
    function setIdsSelected(target, ids, selected){
        ids.forEach(id => selected ? target.add(String(id)) : target.delete(String(id)));
    }
    function idsSelectionState(target, ids){
        const clean = ids.map(String).filter(Boolean);
        if(!clean.length) return 'unchecked';
        const count = clean.filter(id => target.has(id)).length;
        if(count === clean.length) return 'checked';
        return count ? 'mixed' : 'unchecked';
    }
    function setAllSelected(state, selected){
        for(const id of state.projectCanvases.keys()) setProjectSelected(state, id, selected);
        setIdsSelected(state.providerIds, asArray(state.options.providers).map(itemId), selected);
        setIdsSelected(state.runninghubAppIds, asArray(state.options.runninghub?.apps).map(itemId), selected);
        setIdsSelected(state.runninghubWorkflowIds, asArray(state.options.runninghub?.workflows).map(itemId), selected);
        setIdsSelected(state.promptLibraryIds, asArray(state.options.prompt_libraries).map(itemId), selected);
        setIdsSelected(state.detailPageTaskIds, asArray(state.options.detail_pages).map(itemId), selected);
        setIdsSelected(state.mainImageTaskIds, asArray(state.options.main_images).map(itemId), selected);
        setIdsSelected(state.imageGenerationTaskIds, asArray(state.options.image_generations).map(itemId), selected);
        state.includeImageGenerationModes = selected && imageGenerationModesAvailable(state.options);
        state.includeAssets = selected;
        state.includePreferences = selected && Boolean(state.options.preferences?.available);
    }
    function overallSelectionState(state){
        const flags = [];
        for(const id of state.projectCanvases.keys()) flags.push(projectSelectionState(state, id));
        if(asArray(state.options.providers).length) flags.push(idsSelectionState(state.providerIds, asArray(state.options.providers).map(itemId)));
        if(asArray(state.options.runninghub?.apps).length) flags.push(idsSelectionState(state.runninghubAppIds, asArray(state.options.runninghub.apps).map(itemId)));
        if(asArray(state.options.runninghub?.workflows).length) flags.push(idsSelectionState(state.runninghubWorkflowIds, asArray(state.options.runninghub.workflows).map(itemId)));
        if(asArray(state.options.prompt_libraries).length) flags.push(idsSelectionState(state.promptLibraryIds, asArray(state.options.prompt_libraries).map(itemId)));
        if(asArray(state.options.detail_pages).length) flags.push(idsSelectionState(state.detailPageTaskIds, asArray(state.options.detail_pages).map(itemId)));
        if(asArray(state.options.main_images).length) flags.push(idsSelectionState(state.mainImageTaskIds, asArray(state.options.main_images).map(itemId)));
        if(asArray(state.options.image_generations).length) flags.push(idsSelectionState(state.imageGenerationTaskIds, asArray(state.options.image_generations).map(itemId)));
        if(imageGenerationModesAvailable(state.options)) flags.push(state.includeImageGenerationModes ? 'checked' : 'unchecked');
        if(state.options.preferences?.available) flags.push(state.includePreferences ? 'checked' : 'unchecked');
        if(flags.length && state.includeAssets) flags.push('checked');
        if(flags.length && flags.every(value => value === 'checked')) return 'checked';
        if(flags.some(value => value !== 'unchecked') || state.includeAssets) return 'mixed';
        return 'unchecked';
    }
    function buildBackupExportRequest(state){
        return {
            project_ids:[...state.projectIds],
            canvas_ids:[...state.canvasIds],
            include_assets:Boolean(state.includeAssets),
            include_logs:false,
            provider_ids:[...state.providerIds],
            runninghub_app_ids:[...state.runninghubAppIds],
            runninghub_workflow_ids:[...state.runninghubWorkflowIds],
            prompt_library_ids:[...state.promptLibraryIds],
            detail_page_task_ids:[...state.detailPageTaskIds],
            main_image_task_ids:[...state.mainImageTaskIds],
            image_generation_task_ids:[...state.imageGenerationTaskIds],
            include_image_generation_modes:Boolean(state.includeImageGenerationModes),
            include_preferences:Boolean(state.includePreferences),
            preferences:state.includePreferences ? readPortablePreferences() : {},
        };
    }
    function hasAnySelection(state){
        const payload = buildBackupExportRequest(state);
        return payload.project_ids.length > 0 || payload.canvas_ids.length > 0 || payload.provider_ids.length > 0
            || payload.runninghub_app_ids.length > 0 || payload.runninghub_workflow_ids.length > 0
            || payload.prompt_library_ids.length > 0 || payload.detail_page_task_ids.length > 0 || payload.main_image_task_ids.length > 0
            || payload.image_generation_task_ids.length > 0 || payload.include_image_generation_modes || payload.include_preferences;
    }
    function formatBytes(value){
        const bytes = Math.max(0, Number(value) || 0);
        if(bytes < 1024) return `${bytes} B`;
        if(bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if(bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }
    function formatBackupDate(value, locale){
        const numeric = typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))
            ? Number(value)
            : NaN;
        const date = Number.isFinite(numeric) && numeric > 0
            ? new Date(numeric < 100000000000 ? numeric * 1000 : numeric)
            : new Date(String(value || ''));
        if(Number.isNaN(date.getTime())) return '';
        return date.toLocaleString(locale || undefined, {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
    }

    let managerInstance = null;

    function initBackupManager(){
        if(managerInstance) return managerInstance;
        const modal = document.getElementById('backupModal');
        const modalTitle = document.getElementById('backupModalTitle');
        const modalSub = document.getElementById('backupModalSub');
        const modalBody = document.getElementById('backupModalBody');
        const modalClose = document.getElementById('backupModalClose');
        const modalCancel = document.getElementById('backupModalCancel');
        const modalPrimary = document.getElementById('backupModalPrimary');
        const fileInput = document.getElementById('backupFileInput');
        if(!modal || !modalBody) return null;
        modal.dataset.backupBound = '1';

        const zh = (cn, en) => window.StudioI18n?.lang?.() === 'en' ? en : cn;
        const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
        let mode = '';
        let options = null;
        let state = null;
        let importFile = null;
        let inspectResult = null;
        let conflictPolicies = {project_conflict:'copy', provider_conflict:'backup', runninghub_conflict:'backup'};
        let busy = false;
        let returnFocusTarget = null;
        const collapsedGroups = new Set();

        function refreshIcons(){ if(window.lucide) window.lucide.createIcons(); }
        function openModal(){
            modal.classList.add('open');
            modal.setAttribute('aria-hidden', 'false');
            document.body.classList.add('backup-modal-open');
            window.requestAnimationFrame(() => {
                const target = modal.querySelector('[data-backup-choose-file]') || modalClose || modalPrimary;
                target?.focus?.({preventScroll:true});
            });
        }
        function closeModal(){
            if(busy) return;
            modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); document.body.classList.remove('backup-modal-open');
            mode = ''; options = null; state = null; importFile = null; inspectResult = null;
            collapsedGroups.clear();
            conflictPolicies = {project_conflict:'copy', provider_conflict:'backup', runninghub_conflict:'backup'};
            if(fileInput) fileInput.value = '';
            const focusTarget = returnFocusTarget;
            returnFocusTarget = null;
            window.requestAnimationFrame(() => focusTarget?.focus?.({preventScroll:true}));
        }
        function setBusy(value, label=''){
            busy = Boolean(value);
            modal.classList.toggle('busy', busy);
            modalPrimary.disabled = busy || !state || !hasAnySelection(state);
            modalPrimary.innerHTML = busy
                ? `<span class="backup-spinner"></span><span>${esc(label || zh('处理中…','Working…'))}</span>`
                : `<i data-lucide="${mode === 'import' ? 'archive-restore' : 'download'}" class="w-4 h-4"></i><span>${mode === 'import' ? zh('开始导入','Import') : zh('开始导出','Export')}</span>`;
            refreshIcons();
        }
        function showError(message){
            const box = modalBody.querySelector('.backup-inline-status') || document.createElement('div');
            box.className = 'backup-inline-status error';
            box.textContent = String(message || zh('操作失败','Operation failed'));
            if(!box.parentNode) modalBody.prepend(box);
        }
        async function responseJson(response){
            const data = await response.json().catch(() => ({}));
            if(!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : zh('操作失败','Operation failed'));
            return data;
        }
        function checkbox(stateName, kind, id='', label='', meta='', disabled=false){
            const checked = stateName === 'checked' ? ' checked' : '';
            return `<label class="backup-tree-row${disabled ? ' disabled' : ''}">
                <input type="checkbox" data-backup-kind="${esc(kind)}" data-backup-id="${esc(id)}" data-state="${esc(stateName)}"${checked}${disabled ? ' disabled' : ''}>
                <span class="backup-check-ui"></span>
                <span class="backup-tree-label">${esc(label)}</span>
                ${meta ? `<span class="backup-tree-meta">${esc(meta)}</span>` : ''}
            </label>`;
        }
        function collapsibleCheckbox(stateName, kind, id, key, label, meta='', icon='folder'){
            const checked = stateName === 'checked' ? ' checked' : '';
            const collapsed = collapsedGroups.has(key);
            return `<div class="backup-collapsible-head">
                <label class="backup-tree-select" title="${esc(zh(`选择${label}`, `Select ${label}`))}">
                    <input type="checkbox" data-backup-kind="${esc(kind)}" data-backup-id="${esc(id)}" data-state="${esc(stateName)}"${checked}>
                    <span class="backup-check-ui"></span>
                </label>
                <button class="backup-collapse-trigger" type="button" data-backup-collapse="${esc(key)}" aria-expanded="${collapsed ? 'false' : 'true'}">
                    <i data-lucide="${esc(icon)}" class="backup-group-icon"></i>
                    <span class="backup-tree-label">${esc(label)}</span>
                    ${meta ? `<span class="backup-tree-meta">${esc(meta)}</span>` : ''}
                    <i data-lucide="${collapsed ? 'chevron-right' : 'chevron-down'}" class="backup-collapse-chevron"></i>
                </button>
            </div>`;
        }
        function renderSection(key, title, icon, content, note=''){
            const collapsed = collapsedGroups.has(key);
            return `<section class="backup-section">
                <button class="backup-section-head backup-collapse-trigger" type="button" data-backup-collapse="${esc(key)}" aria-expanded="${collapsed ? 'false' : 'true'}">
                    <i data-lucide="${esc(icon)}"></i><span>${esc(title)}</span>
                    ${note ? `<span class="backup-secret-note">${esc(note)}</span>` : ''}
                    <i data-lucide="${collapsed ? 'chevron-right' : 'chevron-down'}" class="backup-collapse-chevron"></i>
                </button>
                <div class="backup-tree${collapsed ? ' is-collapsed' : ''}">${content}</div>
            </section>`;
        }
        function renderProjectTree(){
            const projects = asArray(options?.projects);
            if(!projects.length) return `<div class="backup-tree-empty">${zh('没有可备份的项目','No projects available')}</div>`;
            return projects.map(project => {
                const projectId = itemId(project);
                const canvases = asArray(project.canvases);
                const projectState = projectSelectionState(state, projectId);
                const collapseKey = `project:${projectId}`;
                const collapsed = collapsedGroups.has(collapseKey);
                return `<div class="backup-tree-branch">
                    ${collapsibleCheckbox(projectState, 'project', projectId, collapseKey, project.name || zh('未命名项目','Untitled project'), zh(`${canvases.length} 个画布`, `${canvases.length} canvases`), 'folder')}
                    <div class="backup-tree-children${collapsed ? ' is-collapsed' : ''}">${canvases.map(canvas => checkbox(
                        state.canvasIds.has(itemId(canvas)) ? 'checked' : 'unchecked',
                        'canvas', itemId(canvas), canvas.title || zh('未命名画布','Untitled canvas'),
                        (canvas.kind === 'smart' ? zh('智能','Smart') : zh('普通','Classic'))
                    )).join('')}</div>
                </div>`;
            }).join('');
        }
        function renderDetailPageTree(){
            const tasks = asArray(options?.detail_pages);
            if(!tasks.length) return `<div class="backup-tree-empty">${zh('没有可备份的详情页历史','No detail-page history available')}</div>`;
            const ids = tasks.map(itemId).filter(Boolean);
            const groupState = idsSelectionState(state.detailPageTaskIds, ids);
            const collapseKey = 'group:detail-pages';
            const collapsed = collapsedGroups.has(collapseKey);
            const statusLabel = value => ({
                succeeded:zh('全部完成','Completed'), partial:zh('部分完成','Partially completed'), failed:zh('任务失败','Failed'),
                cancelled:zh('已取消','Cancelled'), interrupted:zh('已中断','Interrupted'), generating:zh('生成中','Generating'),
                planning:zh('规划中','Planning'), pending:zh('等待中','Pending'), unknown:zh('结果未知','Unknown result'),
            }[String(value || '').toLowerCase()] || String(value || zh('未知状态','Unknown')));
            const dateLabel = value => formatBackupDate(value);
            return `<div class="backup-tree-branch detail-page-group">
                ${collapsibleCheckbox(groupState, 'detail-page-group', '', collapseKey, zh('详情页历史','Detail-page history'), zh(`${ids.length} 组`, `${ids.length} groups`), 'panels-top-left')}
                <div class="backup-tree-children${collapsed ? ' is-collapsed' : ''}">${tasks.map(task => {
                    const taskId = itemId(task);
                    const groupNo = Number(task.group_no || 0);
                    const title = String(task.title || '').trim();
                    const name = `${groupNo > 0 ? `${zh('分组','Group')} #${groupNo}` : zh('详情页历史','Detail-page history')}${title ? ` · ${title}` : ''}`;
                    const meta = [statusLabel(task.status), dateLabel(task.updated_at || task.created_at), zh(`${Number(task.screen_count || 0)} 屏`, `${Number(task.screen_count || 0)} screens`)].filter(Boolean).join(' · ');
                    return checkbox(state.detailPageTaskIds.has(taskId) ? 'checked' : 'unchecked', 'detail-page', taskId, name, meta);
                }).join('')}</div>
            </div>`;
        }
        function renderMainImageTree(){
            const tasks = asArray(options?.main_images);
            if(!tasks.length) return `<div class="backup-tree-empty">${zh('没有可备份的一键主图历史','No main-image history available')}</div>`;
            const ids = tasks.map(itemId).filter(Boolean);
            const groupState = idsSelectionState(state.mainImageTaskIds, ids);
            const collapseKey = 'group:main-images';
            const collapsed = collapsedGroups.has(collapseKey);
            const statusLabel = value => ({
                succeeded:zh('全部完成','Completed'), partial:zh('部分完成','Partially completed'), failed:zh('任务失败','Failed'),
                cancelled:zh('已取消','Cancelled'), interrupted:zh('已中断','Interrupted'), generating:zh('生成中','Generating'),
                planning:zh('规划中','Planning'), pending:zh('等待中','Pending'), unknown:zh('结果未知','Unknown result'),
            }[String(value || '').toLowerCase()] || String(value || zh('未知状态','Unknown')));
            const dateLabel = value => formatBackupDate(value);
            return `<div class="backup-tree-branch main-image-group">
                ${collapsibleCheckbox(groupState, 'main-image-group', '', collapseKey, zh('一键主图历史','Main-image history'), zh(`${ids.length} 组`, `${ids.length} groups`), 'images')}
                <div class="backup-tree-children${collapsed ? ' is-collapsed' : ''}">${tasks.map(task => {
                    const taskId = itemId(task);
                    const groupNo = Number(task.group_no || 0);
                    const title = String(task.title || '').trim();
                    const name = `${groupNo > 0 ? `${zh('分组','Group')} #${groupNo}` : zh('一键主图历史','Main-image history')}${title ? ` · ${title}` : ''}`;
                    const meta = [statusLabel(task.status), dateLabel(task.updated_at || task.created_at), zh(`${Number(task.screen_count || 0)} 张`, `${Number(task.screen_count || 0)} images`)].filter(Boolean).join(' · ');
                    return checkbox(state.mainImageTaskIds.has(taskId) ? 'checked' : 'unchecked', 'main-image', taskId, name, meta);
                }).join('')}</div>
            </div>`;
        }
        function renderImageGenerationTree(){
            const tasks = asArray(options?.image_generations);
            if(!tasks.length) return `<div class="backup-tree-empty">${zh('没有可备份的图片生成历史','No image-generation history available')}</div>`;
            const ids = tasks.map(itemId).filter(Boolean);
            const groupState = idsSelectionState(state.imageGenerationTaskIds, ids);
            const collapseKey = 'group:image-generations';
            const collapsed = collapsedGroups.has(collapseKey);
            const statusLabel = value => ({
                succeeded:zh('已完成','Completed'), partial:zh('部分完成','Partially completed'), failed:zh('生成失败','Failed'),
                cancelled:zh('已取消','Cancelled'), interrupted:zh('已中断','Interrupted'), generating:zh('生成中','Generating'),
                submitting:zh('正在提交','Submitting'), queued:zh('排队中','Queued'), recovering:zh('恢复查询中','Recovering'), unknown:zh('结果未知','Unknown result'),
            }[String(value || '').toLowerCase()] || String(value || zh('未知状态','Unknown')));
            const dateLabel = value => formatBackupDate(value);
            return `<div class="backup-tree-branch image-generation-group">
                ${collapsibleCheckbox(groupState, 'image-generation-group', '', collapseKey, zh('图片生成历史','Image-generation history'), zh(`${ids.length} 组`, `${ids.length} groups`), 'wand-sparkles')}
                <div class="backup-tree-children${collapsed ? ' is-collapsed' : ''}">${tasks.map(task => {
                    const taskId = itemId(task);
                    const groupNo = Number(task.group_no || 0);
                    const title = String(task.title || task.mode_name || task.display_name || '').trim();
                    const name = `${groupNo > 0 ? `${zh('分组','Group')} #${groupNo}` : zh('图片生成历史','Image-generation history')}${title ? ` · ${title}` : ''}`;
                    const count = Number(task.candidate_count || task.image_count || 0);
                    const meta = [statusLabel(task.status), dateLabel(task.updated_at || task.created_at), zh(`${count} 张`, `${count} images`)].filter(Boolean).join(' · ');
                    return checkbox(state.imageGenerationTaskIds.has(taskId) ? 'checked' : 'unchecked', 'image-generation', taskId, name, meta);
                }).join('')}</div>
            </div>`;
        }
        function renderFlatGroup(title, icon, collapseKey, groupKind, itemKind, items, target, metaKey=''){
            if(!items.length) return '';
            const ids = items.map(itemId);
            const groupState = idsSelectionState(target, ids);
            const collapsed = collapsedGroups.has(collapseKey);
            return `<div class="backup-tree-branch">
                ${collapsibleCheckbox(groupState, groupKind, '', collapseKey, title, zh(`${ids.length} 项`, `${ids.length} items`), icon)}
                <div class="backup-tree-children${collapsed ? ' is-collapsed' : ''}">${items.map(item => checkbox(
                    target.has(itemId(item)) ? 'checked' : 'unchecked', itemKind, itemId(item), item.name || item.title || itemId(item),
                    metaKey && item[metaKey] != null ? zh(`${item[metaKey]} 条`, `${item[metaKey]} items`) : ''
                )).join('')}</div>
            </div>`;
        }
        function applyMixedStates(){
            modalBody.querySelectorAll('input[type="checkbox"][data-state="mixed"]').forEach(input => { input.indeterminate = true; });
        }
        function conflictHtml(){
            if(mode !== 'import' || !inspectResult) return '';
            const conflicts = inspectResult.conflicts || {};
            const projectCount = asArray(conflicts.projects).length;
            const providerCount = asArray(conflicts.providers).length;
            const providerCollisionCount = asArray(conflicts.provider_id_collisions).length;
            const rhCount = asArray(conflicts.runninghub_apps).length + asArray(conflicts.runninghub_workflows).length;
            const repeated = conflicts.already_imported ? `<div class="backup-warning"><i data-lucide="history"></i><span>${zh('这个备份以前导入过，继续导入会创建新的项目副本。','This backup was imported before. Continuing creates another copy.')}</span></div>` : '';
            const providerCollisionWarning = providerCollisionCount ? `<div class="backup-warning"><i data-lucide="copy-plus"></i><span>${zh(`有 ${providerCollisionCount} 个平台 ID 相同但请求地址不同，导入时会自动新增平台并保留本机平台。`, `${providerCollisionCount} provider IDs use different URLs; import will create new suffixed providers and keep local ones.`)}</span></div>` : '';
            const endpoint = conflicts.runninghub_endpoint || {};
            const hasRhSelection = Boolean(state?.runninghubAppIds?.size || state?.runninghubWorkflowIds?.size);
            const endpointWarning = endpoint.changed && hasRhSelection ? `<div class="backup-warning"><i data-lucide="globe-2"></i><span>${zh(`RunningHub 请求地址将切换为 ${endpoint.backup_base_url || '备份地址'}。由于地址不同，本机 RunningHub 密钥将在导入成功后清空。`, `RunningHub endpoint will switch to ${endpoint.backup_base_url || 'the backup endpoint'}. Local RunningHub keys will be cleared after a successful import because the endpoint differs.`)}</span></div>` : '';
            return `${repeated}<div class="backup-conflicts">
                <div class="backup-conflict-title">${zh('遇到重复内容时','When duplicates are found')}</div>
                ${projectCount ? `<label><span>${zh(`同名项目 ${projectCount} 个`, `${projectCount} project conflicts`)}</span><select data-conflict="project_conflict"><option value="copy"${conflictPolicies.project_conflict === 'copy' ? ' selected' : ''}>${zh('创建“（导入）”副本（推荐）','Create imported copies')}</option><option value="merge"${conflictPolicies.project_conflict === 'merge' ? ' selected' : ''}>${zh('合并到同名项目','Merge into same-name projects')}</option></select></label>` : ''}
                ${providerCount ? `<label><span>${zh(`API 平台 ${providerCount} 个`, `${providerCount} provider conflicts`)}</span><select data-conflict="provider_conflict"><option value="keep-local"${conflictPolicies.provider_conflict === 'keep-local' ? ' selected' : ''}>${zh('保留本机平台和模型设置','Keep local platform and model settings')}</option><option value="backup"${conflictPolicies.provider_conflict === 'backup' ? ' selected' : ''}>${zh('采用备份的平台和模型设置（保留本机密钥）（推荐）','Use backup platform and model settings (keep local key) (recommended)')}</option></select></label>` : ''}
                ${rhCount ? `<label><span>${zh(`RunningHub 应用/工作流 ${rhCount} 项`, `${rhCount} RunningHub app/workflow conflicts`)}</span><select data-conflict="runninghub_conflict"><option value="keep-local"${conflictPolicies.runninghub_conflict === 'keep-local' ? ' selected' : ''}>${zh('保留本机应用/工作流','Keep local apps/workflows')}</option><option value="backup"${conflictPolicies.runninghub_conflict === 'backup' ? ' selected' : ''}>${zh('采用备份应用/工作流（推荐）','Use backup apps/workflows (recommended)')}</option></select></label>` : ''}
            </div>${providerCollisionWarning}${endpointWarning}`;
        }
        function renderTree(){
            const previousScrollTop = modalBody.scrollTop;
            const providers = asArray(options?.providers);
            const apps = asArray(options?.runninghub?.apps);
            const workflows = asArray(options?.runninghub?.workflows);
            const libraries = asArray(options?.prompt_libraries);
            const detailPages = asArray(options?.detail_pages);
            const mainImages = asArray(options?.main_images);
            const imageGenerations = asArray(options?.image_generations);
            const imageGenerationModes = options?.image_generation_modes;
            const hasImageGenerationModes = imageGenerationModesAvailable(options || {});
            const imageGenerationModesMeta = hasImageGenerationModes && typeof imageGenerationModes === 'object'
                ? zh(`${Number(imageGenerationModes.mode_count || imageGenerationModes.count || 0)} 个模式、${Number(imageGenerationModes.example_count || 0)} 个示范`, `${Number(imageGenerationModes.mode_count || imageGenerationModes.count || 0)} modes, ${Number(imageGenerationModes.example_count || 0)} examples`)
                : '';
            const resourceCount = Number(options?.resource_count || 0);
            const resourceBytes = Number(options?.resource_bytes || 0);
            const assetsDisabled = mode === 'import' && resourceCount <= 0;
            const assetsMeta = mode === 'import'
                ? zh(`${resourceCount} 个文件，${formatBytes(resourceBytes)}`, `${resourceCount} files, ${formatBytes(resourceBytes)}`)
                : zh('收集所选画布、主图、详情页及图片生成任务使用的文件', 'Collect media referenced by selected canvases, main images, detail pages, and image-generation tasks');
            const detailAssetsWarning = mode === 'import' && (detailPages.length || mainImages.length || imageGenerations.length) && !state.includeAssets
                ? `<div class="backup-warning"><i data-lucide="image-off"></i><span>${zh('未选择历史素材：仅导入记录，缺失图片会在历史中标记为异常。','History media is disabled: records will import, but missing images will be marked unavailable.')}</span></div>`
                : '';
            // v2/v3 界面名称是“画布与详情页素材”；v4 扩展为下方的图片生成素材分类。
            modalBody.innerHTML = `
                <div class="backup-privacy"><i data-lucide="shield-check"></i><span>${zh('API Key、Token、密码和密钥预览永远不会进入备份。','API keys, tokens, passwords, and secret previews are never included.')}</span></div>
                ${mode === 'import' && asArray(options?.missing_resources).length ? `<div class="backup-warning"><i data-lucide="triangle-alert"></i><span>${zh(`备份记录了 ${options.missing_resources.length} 个缺失素材，相关节点会保留原路径。`, `${options.missing_resources.length} assets were missing when exported.`)}</span></div>` : ''}
                <div class="backup-select-all">${checkbox(overallSelectionState(state), 'all', '', zh('全选','Select all'))}</div>
                ${renderSection('section:projects', zh('项目与画布','Projects and canvases'), 'folders', renderProjectTree())}
                ${renderSection('section:main-images', zh('一键主图历史','Main-image history'), 'images', renderMainImageTree())}
                ${renderSection('section:detail-pages', zh('详情页历史','Detail-page history'), 'panels-top-left', renderDetailPageTree())}
                ${renderSection('section:image-generations', zh('图片生成历史','Image-generation history'), 'wand-sparkles', renderImageGenerationTree())}
                ${renderSection('section:assets', zh('画布、详情页与图片生成素材','Canvas, detail-page, and image-generation media'), 'images', checkbox(state.includeAssets && !assetsDisabled ? 'checked' : 'unchecked', 'assets', '', zh('包含所选画布、主图、详情页与图片生成任务使用的素材','Include media used by selected canvases, main images, detail pages, and image-generation tasks'), assetsMeta, assetsDisabled))}
                ${detailAssetsWarning}
                ${renderSection('section:config', zh('全局配置','Global configuration'), 'settings-2', `
                    ${renderFlatGroup(zh('API 配置平台','API providers'), 'server', 'group:providers', 'provider-group', 'provider', providers, state.providerIds)}
                    ${renderFlatGroup(zh('RunningHub 应用','RunningHub apps'), 'blocks', 'group:runninghub-apps', 'rh-app-group', 'rh-app', apps, state.runninghubAppIds)}
                    ${renderFlatGroup(zh('RunningHub 工作流','RunningHub workflows'), 'workflow', 'group:runninghub-workflows', 'rh-workflow-group', 'rh-workflow', workflows, state.runninghubWorkflowIds)}
                    ${renderFlatGroup(zh('提示词模板库','Prompt template libraries'), 'library', 'group:prompt-libraries', 'prompt-group', 'prompt-library', libraries, state.promptLibraryIds, 'item_count')}
                    ${hasImageGenerationModes ? checkbox(state.includeImageGenerationModes ? 'checked' : 'unchecked', 'image-generation-modes', '', zh('图片生成模式与示范', 'Image-generation modes and examples'), imageGenerationModesMeta) : ''}
                    ${options?.preferences?.available ? checkbox(state.includePreferences ? 'checked' : 'unchecked', 'preferences', '', zh('界面与使用偏好', 'Interface and usage preferences'), zh('主题、UI 缩放、普通画布常用节点排序', 'Theme, UI scale, and classic-canvas favorite-node order')) : ''}
                    ${(!providers.length && !apps.length && !workflows.length && !libraries.length && !hasImageGenerationModes && !options?.preferences?.available) ? `<div class="backup-tree-empty">${zh('没有可迁移的全局配置','No global configuration available')}</div>` : ''}
                `, zh('不含密钥','No secrets'))}
                ${conflictHtml()}
                <div class="backup-inline-status" aria-live="polite"></div>`;
            applyMixedStates();
            modalPrimary.disabled = !hasAnySelection(state);
            refreshIcons();
            modalBody.scrollTop = previousScrollTop;
        }
        function updateSelection(kind, id, checked){
            const providerIds = asArray(options.providers).map(itemId);
            const appIds = asArray(options.runninghub?.apps).map(itemId);
            const workflowIds = asArray(options.runninghub?.workflows).map(itemId);
            const promptIds = asArray(options.prompt_libraries).map(itemId);
            const detailPageIds = asArray(options.detail_pages).map(itemId);
            const mainImageIds = asArray(options.main_images).map(itemId);
            const imageGenerationIds = asArray(options.image_generations).map(itemId);
            if(kind === 'all') setAllSelected(state, checked);
            else if(kind === 'project') setProjectSelected(state, id, checked);
            else if(kind === 'canvas') setCanvasSelected(state, id, checked);
            else if(kind === 'assets') state.includeAssets = checked;
            else if(kind === 'provider-group') setIdsSelected(state.providerIds, providerIds, checked);
            else if(kind === 'provider') setIdsSelected(state.providerIds, [id], checked);
            else if(kind === 'rh-app-group') setIdsSelected(state.runninghubAppIds, appIds, checked);
            else if(kind === 'rh-app') setIdsSelected(state.runninghubAppIds, [id], checked);
            else if(kind === 'rh-workflow-group') setIdsSelected(state.runninghubWorkflowIds, workflowIds, checked);
            else if(kind === 'rh-workflow') setIdsSelected(state.runninghubWorkflowIds, [id], checked);
            else if(kind === 'prompt-group') setIdsSelected(state.promptLibraryIds, promptIds, checked);
            else if(kind === 'prompt-library') setIdsSelected(state.promptLibraryIds, [id], checked);
            else if(kind === 'detail-page-group') setIdsSelected(state.detailPageTaskIds, detailPageIds, checked);
            else if(kind === 'detail-page') setDetailPageSelected(state, id, checked);
            else if(kind === 'main-image-group') setIdsSelected(state.mainImageTaskIds, mainImageIds, checked);
            else if(kind === 'main-image') setMainImageSelected(state, id, checked);
            else if(kind === 'image-generation-group') setIdsSelected(state.imageGenerationTaskIds, imageGenerationIds, checked);
            else if(kind === 'image-generation') setImageGenerationSelected(state, id, checked);
            else if(kind === 'image-generation-modes') state.includeImageGenerationModes = checked;
            else if(kind === 'preferences') state.includePreferences = checked;
            renderTree();
        }
        function showLoading(title, subtitle){
            modalTitle.textContent = title;
            modalSub.textContent = subtitle || '';
            modalBody.innerHTML = `<div class="backup-loading"><span class="backup-spinner"></span><span>${zh('正在读取…','Loading…')}</span></div>`;
            modalPrimary.style.display = '';
            modalPrimary.disabled = true;
            openModal();
        }
        async function openExport(){
            mode = 'export';
            collapsedGroups.clear();
            showLoading(zh('导出备份','Export backup'), zh('选择要放进备份包的内容。','Choose what to include.'));
            try {
                options = await responseJson(await fetch('/api/backups/options'));
                state = createBackupSelection(options);
                renderTree();
                setBusy(false);
            } catch(error){ showError(error.message); }
        }
        function showImportChooser(){
            mode = 'import';
            collapsedGroups.clear();
            modalTitle.textContent = zh('导入备份','Import backup');
            modalSub.textContent = zh('先选择 Infinite Canvas 备份 ZIP，再决定导入哪些内容。','Choose a backup ZIP, then select what to import.');
            modalBody.innerHTML = `<button class="backup-file-picker" type="button" data-backup-choose-file><i data-lucide="file-archive"></i><strong>${zh('选择备份文件','Choose backup file')}</strong><span>${zh('支持由“导出备份”生成的 ZIP 文件','Supports ZIP files created by Export backup')}</span></button>`;
            modalPrimary.style.display = 'none';
            openModal();
            refreshIcons();
        }
        async function inspectFile(file){
            mode = 'import'; importFile = file;
            showLoading(zh('导入备份','Import backup'), file.name || 'backup.zip');
            try {
                const form = new FormData(); form.append('file', file);
                inspectResult = await responseJson(await fetch('/api/backups/inspect', {method:'POST', body:form}));
                options = inspectResult.backup || {};
                state = createBackupSelection(options);
                state.includeAssets = Number(options.resource_count || 0) > 0;
                modalPrimary.style.display = '';
                renderTree();
                setBusy(false);
            } catch(error){
                modalPrimary.style.display = 'none';
                modalBody.innerHTML = `<div class="backup-file-error"><i data-lucide="circle-alert"></i><strong>${zh('无法读取备份','Cannot read backup')}</strong><span>${esc(error.message)}</span><button type="button" data-backup-choose-file>${zh('重新选择','Choose another')}</button></div>`;
                refreshIcons();
            }
        }
        async function runExport(){
            if(!state || !hasAnySelection(state)) return;
            setBusy(true, zh('正在创建备份…','Creating backup…'));
            try {
                const data = await responseJson(await fetch('/api/backups/export', {
                    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(buildBackupExportRequest(state))
                }));
                const anchor = document.createElement('a');
                anchor.href = data.download_url; anchor.download = data.filename || '';
                document.body.appendChild(anchor); anchor.click(); anchor.remove();
                busy = false; closeModal();
                if(typeof window.setStatus === 'function') window.setStatus(zh('备份已开始下载','Backup download started'));
            } catch(error){ setBusy(false); showError(error.message); }
        }
        async function runImport(){
            if(!state || !importFile || !hasAnySelection(state)) return;
            setBusy(true, zh('正在安全导入…','Importing safely…'));
            try {
                const request = buildBackupExportRequest(state);
                Object.assign(request, conflictPolicies);
                const form = new FormData();
                form.append('file', importFile);
                form.append('selection', JSON.stringify(request));
                const result = await responseJson(await fetch('/api/backups/import', {method:'POST', body:form}));
                busy = false; closeModal();
                if(result.preferences && Object.keys(result.preferences).length) applyPortablePreferences(result.preferences);
                const providerMapCount = Object.keys(result.provider_id_map || {}).filter(id => result.provider_id_map[id] && result.provider_id_map[id] !== id).length;
                const importedParts = [];
                const skippedParts = [];
                if(Number(result.projects || 0) || Number(result.canvases || 0)) importedParts.push(zh(`项目 ${result.projects || 0} 个、画布 ${result.canvases || 0} 个`, `${result.projects || 0} projects, ${result.canvases || 0} canvases`));
                if(Number(result.providers_imported || 0)) importedParts.push(zh(`API 平台 ${result.providers_imported} 个`, `${result.providers_imported} API providers`));
                if(Number(result.runninghub_apps_imported || 0)) importedParts.push(zh(`RunningHub 应用 ${result.runninghub_apps_imported} 个`, `${result.runninghub_apps_imported} RunningHub apps`));
                if(Number(result.runninghub_workflows_imported || 0)) importedParts.push(zh(`RunningHub 工作流 ${result.runninghub_workflows_imported} 个`, `${result.runninghub_workflows_imported} RunningHub workflows`));
                if(Number(result.prompt_libraries_imported || 0)) importedParts.push(zh(`提示词模板库 ${result.prompt_libraries_imported} 个`, `${result.prompt_libraries_imported} prompt libraries`));
                if(Number(result.detail_pages || 0)) importedParts.push(zh(`详情页历史 ${result.detail_pages} 组`, `${result.detail_pages} detail-page histories`));
                if(Number(result.main_images || 0)) importedParts.push(zh(`一键主图历史 ${result.main_images} 组`, `${result.main_images} main-image histories`));
                if(Number(result.image_generations || 0)) importedParts.push(zh(`图片生成历史 ${result.image_generations} 组`, `${result.image_generations} image-generation histories`));
                const modeSyncZh = [];
                const modeSyncEn = [];
                const modeCreated = Number(result.image_generation_modes_created || 0);
                const modeUpdated = Number(result.image_generation_modes_updated || 0);
                const modeReactivated = Number(result.image_generation_modes_reactivated || 0);
                const modeArchived = Number(result.image_generation_modes_archived || 0);
                if(modeCreated) { modeSyncZh.push(`新增 ${modeCreated} 个`); modeSyncEn.push(`${modeCreated} created`); }
                if(modeUpdated) { modeSyncZh.push(`更新 ${modeUpdated} 个`); modeSyncEn.push(`${modeUpdated} updated`); }
                if(modeReactivated) { modeSyncZh.push(`重新启用 ${modeReactivated} 个`); modeSyncEn.push(`${modeReactivated} reactivated`); }
                if(modeArchived) { modeSyncZh.push(`停用 ${modeArchived} 个`); modeSyncEn.push(`${modeArchived} archived`); }
                if(modeSyncZh.length) {
                    importedParts.push(zh(`图片生成模式：${modeSyncZh.join('、')}`, `Image-generation modes: ${modeSyncEn.join(', ')}`));
                } else if(Number(result.image_generation_modes_imported || 0)) {
                    importedParts.push(zh(`图片生成模式 ${result.image_generation_modes_imported} 个`, `${result.image_generation_modes_imported} image-generation modes`));
                }
                if(Number(result.image_generation_examples_imported || 0)) importedParts.push(zh(`图片生成示范 ${result.image_generation_examples_imported} 个`, `${result.image_generation_examples_imported} image-generation examples`));
                if(result.preferences && Object.keys(result.preferences).length) importedParts.push(zh('界面与使用偏好 1 组', '1 interface preference set'));
                if(Number(result.providers_skipped || 0)) skippedParts.push(zh(`API 平台 ${result.providers_skipped} 个`, `${result.providers_skipped} API providers`));
                if(Number(result.runninghub_apps_skipped || 0)) skippedParts.push(zh(`RunningHub 应用 ${result.runninghub_apps_skipped} 个`, `${result.runninghub_apps_skipped} RunningHub apps`));
                if(Number(result.runninghub_workflows_skipped || 0)) skippedParts.push(zh(`RunningHub 工作流 ${result.runninghub_workflows_skipped} 个`, `${result.runninghub_workflows_skipped} RunningHub workflows`));
                if(Number(result.prompt_libraries_skipped || 0)) skippedParts.push(zh(`提示词模板库 ${result.prompt_libraries_skipped} 个`, `${result.prompt_libraries_skipped} prompt libraries`));
                if(Number(result.image_generations_skipped || 0)) skippedParts.push(zh(`图片生成历史 ${result.image_generations_skipped} 组`, `${result.image_generations_skipped} image-generation histories`));
                if(Number(result.image_generation_modes_skipped || 0)) skippedParts.push(zh(`图片生成模式 ${result.image_generation_modes_skipped} 个`, `${result.image_generation_modes_skipped} image-generation modes`));
                if(!importedParts.length) importedParts.push(zh('没有写入新的内容', 'No new content was written'));
                const endpointNote = result.runninghub_endpoint_changed
                    ? zh('RunningHub 地址已更新，本机密钥已清空，请重新填写。', 'RunningHub endpoint updated; local keys were cleared. Please enter them again.')
                    : '';
                const providerNote = providerMapCount ? zh(`新增 ${providerMapCount} 个地址不同的平台。`, `Added ${providerMapCount} providers with different endpoints.`) : '';
                const skippedNote = skippedParts.length
                    ? zh(`跳过冲突：${skippedParts.join('、')}。`, `Skipped conflicts: ${skippedParts.join(', ')}.`)
                    : '';
                const missingMediaNote = Number(result.detail_page_missing_media || 0)
                    ? zh(`有 ${result.detail_page_missing_media} 个详情页素材缺失，已在对应历史中标记。`, `${result.detail_page_missing_media} detail-page media files are missing and were marked in history.`)
                    : '';
                const mainImageMissingMediaNote = Number(result.main_image_missing_media || 0)
                    ? zh(`有 ${result.main_image_missing_media} 个一键主图素材缺失，已在对应历史中标记。`, `${result.main_image_missing_media} main-image media files are missing and were marked in history.`)
                    : '';
                const imageGenerationMissingMediaNote = Number(result.image_generation_missing_media || 0)
                    ? zh(`有 ${result.image_generation_missing_media} 个图片生成素材缺失，已在对应历史或示范中标记。`, `${result.image_generation_missing_media} image-generation media files are missing and were marked in histories or examples.`)
                    : '';
                // 直接重读当前页面数据，不依赖本地浏览器壳是否允许脚本导航。
                // 这会立即刷新项目、画布和回收站；API 设置页下次打开时也会通过 no-store 读取新配置。
                if(typeof window.loadAll === 'function') {
                    try { await window.loadAll(); } catch(_error) { /* 导入已经完成，导航兜底仍可用 */ }
                }
                const importMessage = zh(`导入完成：${importedParts.join('、')}。${skippedNote}${providerNote}${missingMediaNote}${mainImageMissingMediaNote}${imageGenerationMissingMediaNote}${endpointNote ? `\n${endpointNote}` : ''}`, `Import complete: ${importedParts.join(', ')}. ${skippedNote}${providerNote ? ` ${providerNote}` : ''}${missingMediaNote ? ` ${missingMediaNote}` : ''}${mainImageMissingMediaNote ? ` ${mainImageMissingMediaNote}` : ''}${imageGenerationMissingMediaNote ? ` ${imageGenerationMissingMediaNote}` : ''}${endpointNote ? ` ${endpointNote}` : ''}`);
                if(typeof window.setStatus === 'function') window.setStatus(importMessage);
                window.dispatchEvent(new CustomEvent('backup-imported', {detail:result}));
                window.dispatchEvent(new CustomEvent('detail-pages-changed', {detail:result}));
                window.dispatchEvent(new CustomEvent('main-images-changed', {detail:result}));
                window.dispatchEvent(new CustomEvent('image-generations-changed', {detail:result}));
                // Notify API settings and other open views that global providers/workflows changed.
                const changeMessage = {type:'providers-changed', updated_at:Date.now(), source:'backup-import'};
                const detailChangeMessage = {type:'detail-pages-changed', updated_at:changeMessage.updated_at, source:'backup-import'};
                const mainImageChangeMessage = {type:'main-images-changed', updated_at:changeMessage.updated_at, source:'backup-import'};
                const imageGenerationChangeMessage = {type:'image-generations-changed', updated_at:changeMessage.updated_at, source:'backup-import'};
                try { localStorage.setItem('studio_api_updated_at', String(changeMessage.updated_at)); } catch(_error) {}
                try {
                    const channel = new BroadcastChannel('studio-api');
                    channel.postMessage(changeMessage);
                    channel.postMessage(detailChangeMessage);
                    channel.postMessage(mainImageChangeMessage);
                    channel.postMessage(imageGenerationChangeMessage);
                    channel.close();
                } catch(_error) {}
                try { window.parent?.postMessage(changeMessage, '*'); } catch(_error) {}
                try { window.parent?.postMessage(detailChangeMessage, location.origin); } catch(_error) {}
                try { window.parent?.postMessage(mainImageChangeMessage, location.origin); } catch(_error) {}
                try { window.parent?.postMessage(imageGenerationChangeMessage, location.origin); } catch(_error) {}
                // Reload the top-level shell so every iframe rebuilds its in-memory
                // provider/workflow state, whether this manager runs in the shell or a frame.
                try {
                    const topWindow = window.top;
                    if(topWindow && topWindow.location){
                        const refreshUrl = `${topWindow.location.pathname}?_backup_refresh=${changeMessage.updated_at}`;
                        topWindow.location.href = refreshUrl;
                    }
                } catch(_error) {}
            } catch(error){ setBusy(false); showError(error.message); }
        }

        function openAction(action, focusTarget=null){
            if(action !== 'export' && action !== 'import') return false;
            returnFocusTarget = focusTarget?.focus ? focusTarget : document.activeElement;
            if(action === 'export') void openExport();
            else showImportChooser();
            return true;
        }

        // The backup entry lives in the parent studio shell. Accept only the
        // same-origin, parent-originated command so unrelated frames cannot
        // open or mutate the backup workflow.
        window.addEventListener('message', event => {
            if(event.source !== window.parent) return;
            if(event.origin !== location.origin) return;
            const action = event.data?.type === 'studio-backup-action' ? event.data.action : '';
            openAction(action);
        });
        modalBody.addEventListener('change', event => {
            const input = event.target.closest('input[data-backup-kind]');
            if(input && state) updateSelection(input.dataset.backupKind, input.dataset.backupId, input.checked);
            const conflict = event.target.closest('select[data-conflict]');
            if(conflict) conflictPolicies[conflict.dataset.conflict] = conflict.value;
        });
        modalBody.addEventListener('click', event => {
            const collapse = event.target.closest('[data-backup-collapse]');
            if(collapse && state){
                const key = collapse.dataset.backupCollapse;
                if(collapsedGroups.has(key)) collapsedGroups.delete(key); else collapsedGroups.add(key);
                renderTree();
                return;
            }
            if(event.target.closest('[data-backup-choose-file]')){ fileInput.value = ''; fileInput.click(); }
        });
        fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; if(file) inspectFile(file); });
        modalClose.addEventListener('click', closeModal);
        modalCancel.addEventListener('click', closeModal);
        modal.addEventListener('mousedown', event => { if(event.target === modal) closeModal(); });
        modalPrimary.addEventListener('click', () => mode === 'import' ? runImport() : runExport());
        window.addEventListener('keydown', event => { if(event.key === 'Escape' && modal.classList.contains('open')) closeModal(); });
        refreshIcons();
        managerInstance = {
            openAction,
            close:closeModal,
            isOpen:() => modal.classList.contains('open'),
        };
        return managerInstance;
    }

    function openBackupAction(action, focusTarget=null){
        return Boolean(initBackupManager()?.openAction(action, focusTarget));
    }

    return {
        createBackupSelection,
        projectSelectionState,
        setProjectSelected,
        setCanvasSelected,
        setDetailPageSelected,
        setMainImageSelected,
        setImageGenerationSelected,
        setAllSelected,
        buildBackupExportRequest,
        formatBytes,
        formatBackupDate,
        initBackupManager,
        openBackupAction,
    };
});
