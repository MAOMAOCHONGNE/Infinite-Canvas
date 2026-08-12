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
    function createBackupSelection(options={}){
        const projects = asArray(options.projects);
        const providers = asArray(options.providers);
        const apps = asArray(options.runninghub?.apps);
        const workflows = asArray(options.runninghub?.workflows);
        const promptLibraries = asArray(options.prompt_libraries);
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
            includeAssets:true,
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
        state.includeAssets = selected;
    }
    function overallSelectionState(state){
        const flags = [];
        for(const id of state.projectCanvases.keys()) flags.push(projectSelectionState(state, id));
        if(asArray(state.options.providers).length) flags.push(idsSelectionState(state.providerIds, asArray(state.options.providers).map(itemId)));
        if(asArray(state.options.runninghub?.apps).length) flags.push(idsSelectionState(state.runninghubAppIds, asArray(state.options.runninghub.apps).map(itemId)));
        if(asArray(state.options.runninghub?.workflows).length) flags.push(idsSelectionState(state.runninghubWorkflowIds, asArray(state.options.runninghub.workflows).map(itemId)));
        if(asArray(state.options.prompt_libraries).length) flags.push(idsSelectionState(state.promptLibraryIds, asArray(state.options.prompt_libraries).map(itemId)));
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
        };
    }
    function hasAnySelection(state){
        const payload = buildBackupExportRequest(state);
        return payload.project_ids.length > 0 || payload.canvas_ids.length > 0 || payload.provider_ids.length > 0
            || payload.runninghub_app_ids.length > 0 || payload.runninghub_workflow_ids.length > 0
            || payload.prompt_library_ids.length > 0;
    }
    function formatBytes(value){
        const bytes = Math.max(0, Number(value) || 0);
        if(bytes < 1024) return `${bytes} B`;
        if(bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if(bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }

    function initBackupManager(){
        const menuButton = document.getElementById('backupMenuBtn');
        const menu = document.getElementById('backupMenu');
        const modal = document.getElementById('backupModal');
        const modalTitle = document.getElementById('backupModalTitle');
        const modalSub = document.getElementById('backupModalSub');
        const modalBody = document.getElementById('backupModalBody');
        const modalClose = document.getElementById('backupModalClose');
        const modalCancel = document.getElementById('backupModalCancel');
        const modalPrimary = document.getElementById('backupModalPrimary');
        const fileInput = document.getElementById('backupFileInput');
        if(!menuButton || !menu || !modal || !modalBody || menuButton.dataset.backupBound === '1') return;
        menuButton.dataset.backupBound = '1';

        const zh = (cn, en) => window.StudioI18n?.lang?.() === 'en' ? en : cn;
        const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
        let mode = '';
        let options = null;
        let state = null;
        let importFile = null;
        let inspectResult = null;
        let conflictPolicies = {project_conflict:'copy', provider_conflict:'keep-local', runninghub_conflict:'keep-local'};
        let busy = false;
        const collapsedGroups = new Set();

        function refreshIcons(){ if(window.lucide) window.lucide.createIcons(); }
        function openModal(){ modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false'); document.body.classList.add('backup-modal-open'); }
        function closeModal(){
            if(busy) return;
            modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); document.body.classList.remove('backup-modal-open');
            mode = ''; options = null; state = null; importFile = null; inspectResult = null;
            collapsedGroups.clear();
            conflictPolicies = {project_conflict:'copy', provider_conflict:'keep-local', runninghub_conflict:'keep-local'};
            if(fileInput) fileInput.value = '';
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
            const rhCount = asArray(conflicts.runninghub_apps).length + asArray(conflicts.runninghub_workflows).length;
            const repeated = conflicts.already_imported ? `<div class="backup-warning"><i data-lucide="history"></i><span>${zh('这个备份以前导入过，继续导入会创建新的项目副本。','This backup was imported before. Continuing creates another copy.')}</span></div>` : '';
            return `${repeated}<div class="backup-conflicts">
                <div class="backup-conflict-title">${zh('遇到重复内容时','When duplicates are found')}</div>
                ${projectCount ? `<label><span>${zh(`同名项目 ${projectCount} 个`, `${projectCount} project conflicts`)}</span><select data-conflict="project_conflict"><option value="copy"${conflictPolicies.project_conflict === 'copy' ? ' selected' : ''}>${zh('创建“（导入）”副本（推荐）','Create imported copies')}</option><option value="merge"${conflictPolicies.project_conflict === 'merge' ? ' selected' : ''}>${zh('合并到同名项目','Merge into same-name projects')}</option></select></label>` : ''}
                ${providerCount ? `<label><span>${zh(`API 平台 ${providerCount} 个`, `${providerCount} provider conflicts`)}</span><select data-conflict="provider_conflict"><option value="keep-local"${conflictPolicies.provider_conflict === 'keep-local' ? ' selected' : ''}>${zh('保留本机配置（推荐）','Keep local')}</option><option value="backup"${conflictPolicies.provider_conflict === 'backup' ? ' selected' : ''}>${zh('使用备份配置（无密钥）','Use backup config')}</option></select></label>` : ''}
                ${rhCount ? `<label><span>${zh(`RunningHub ${rhCount} 项`, `${rhCount} RunningHub conflicts`)}</span><select data-conflict="runninghub_conflict"><option value="keep-local"${conflictPolicies.runninghub_conflict === 'keep-local' ? ' selected' : ''}>${zh('保留本机配置（推荐）','Keep local')}</option><option value="backup"${conflictPolicies.runninghub_conflict === 'backup' ? ' selected' : ''}>${zh('使用备份配置（无密钥）','Use backup config')}</option></select></label>` : ''}
            </div>`;
        }
        function renderTree(){
            const previousScrollTop = modalBody.scrollTop;
            const providers = asArray(options?.providers);
            const apps = asArray(options?.runninghub?.apps);
            const workflows = asArray(options?.runninghub?.workflows);
            const libraries = asArray(options?.prompt_libraries);
            const resourceCount = Number(options?.resource_count || 0);
            const resourceBytes = Number(options?.resource_bytes || 0);
            const assetsDisabled = mode === 'import' && resourceCount <= 0;
            const assetsMeta = mode === 'import'
                ? zh(`${resourceCount} 个文件，${formatBytes(resourceBytes)}`, `${resourceCount} files, ${formatBytes(resourceBytes)}`)
                : zh('仅收集所选画布实际使用的文件', 'Only files referenced by selected canvases');
            modalBody.innerHTML = `
                <div class="backup-privacy"><i data-lucide="shield-check"></i><span>${zh('API Key、Token、密码和密钥预览永远不会进入备份。','API keys, tokens, passwords, and secret previews are never included.')}</span></div>
                ${mode === 'import' && asArray(options?.missing_resources).length ? `<div class="backup-warning"><i data-lucide="triangle-alert"></i><span>${zh(`备份记录了 ${options.missing_resources.length} 个缺失素材，相关节点会保留原路径。`, `${options.missing_resources.length} assets were missing when exported.`)}</span></div>` : ''}
                <div class="backup-select-all">${checkbox(overallSelectionState(state), 'all', '', zh('全选','Select all'))}</div>
                ${renderSection('section:projects', zh('项目与画布','Projects and canvases'), 'folders', renderProjectTree())}
                ${renderSection('section:assets', zh('画布素材','Canvas media'), 'images', checkbox(state.includeAssets && !assetsDisabled ? 'checked' : 'unchecked', 'assets', '', zh('包含所选画布使用的素材','Include media used by selected canvases'), assetsMeta, assetsDisabled))}
                ${renderSection('section:config', zh('全局配置','Global configuration'), 'settings-2', `
                    ${renderFlatGroup(zh('API 配置平台','API providers'), 'server', 'group:providers', 'provider-group', 'provider', providers, state.providerIds)}
                    ${renderFlatGroup(zh('RunningHub 应用','RunningHub apps'), 'blocks', 'group:runninghub-apps', 'rh-app-group', 'rh-app', apps, state.runninghubAppIds)}
                    ${renderFlatGroup(zh('RunningHub 工作流','RunningHub workflows'), 'workflow', 'group:runninghub-workflows', 'rh-workflow-group', 'rh-workflow', workflows, state.runninghubWorkflowIds)}
                    ${renderFlatGroup(zh('提示词模板库','Prompt template libraries'), 'library', 'group:prompt-libraries', 'prompt-group', 'prompt-library', libraries, state.promptLibraryIds, 'item_count')}
                    ${(!providers.length && !apps.length && !workflows.length && !libraries.length) ? `<div class="backup-tree-empty">${zh('没有可迁移的全局配置','No global configuration available')}</div>` : ''}
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
                if(typeof window.loadAll === 'function') await window.loadAll();
                alert(zh(`导入完成：${result.projects || 0} 个项目，${result.canvases || 0} 个画布。`, `Imported ${result.projects || 0} projects and ${result.canvases || 0} canvases.`));
            } catch(error){ setBusy(false); showError(error.message); }
        }

        menuButton.addEventListener('click', event => {
            event.stopPropagation();
            menu.classList.toggle('open');
            menuButton.setAttribute('aria-expanded', menu.classList.contains('open') ? 'true' : 'false');
        });
        menu.addEventListener('click', event => {
            const action = event.target.closest('[data-backup-action]')?.dataset.backupAction;
            if(!action) return;
            menu.classList.remove('open'); menuButton.setAttribute('aria-expanded', 'false');
            if(action === 'export') openExport();
            else showImportChooser();
        });
        document.addEventListener('click', event => {
            if(!event.target.closest('.backup-menu-wrap')){ menu.classList.remove('open'); menuButton.setAttribute('aria-expanded', 'false'); }
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
    }

    return {
        createBackupSelection,
        projectSelectionState,
        setProjectSelected,
        setCanvasSelected,
        setAllSelected,
        buildBackupExportRequest,
        formatBytes,
        initBackupManager,
    };
});
