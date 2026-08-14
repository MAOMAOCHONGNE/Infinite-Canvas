(function(global){
    'use strict';

    function escapeHtml(value){
        return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    }

    function isEditableTarget(target){
        if(!target || typeof target.closest !== 'function') return false;
        return Boolean(target.closest('input,textarea,select,[contenteditable="true"],[contenteditable=""]'));
    }

    function clipboardImage(event){
        const items = [...(event?.clipboardData?.items || [])];
        const entry = items.find(item => item.kind === 'file' && String(item.type || '').startsWith('image/'));
        return entry?.getAsFile?.() || null;
    }

    function firstImageFile(files){
        return [...(files || [])].find(file => String(file?.type || '').startsWith('image/')) || null;
    }

    function transferHasImage(transfer){
        const items = [...(transfer?.items || [])];
        if(items.some(item => item.kind === 'file' && String(item.type || '').startsWith('image/'))) return true;
        return Boolean(firstImageFile(transfer?.files));
    }

    function chooseImageFile(){
        return new Promise(resolve => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.hidden = true;
            input.addEventListener('change', () => {
                const file = firstImageFile(input.files);
                input.remove();
                resolve(file);
            }, {once:true});
            document.body.appendChild(input);
            input.click();
        });
    }

    async function request(itemId, file=null){
        const url = `/api/prompt-libraries/items/${encodeURIComponent(itemId)}/thumbnail`;
        const options = file ? {method:'POST', body:(() => { const form = new FormData(); form.append('file', file); return form; })()} : {method:'DELETE'};
        const response = await fetch(url, options);
        const data = await response.json().catch(() => ({}));
        if(!response.ok) throw new Error(data.detail || (file ? '缩略图上传失败' : '缩略图移除失败'));
        return data;
    }

    function placeholder(category='custom'){
        const labels = {view:'视',storyboard:'镜',character:'角',product:'品',lighting:'光',custom:'词',mine:'词'};
        return `<span class="prompt-thumb-placeholder" aria-hidden="true"><span>${escapeHtml(labels[category] || '词')}</span></span>`;
    }

    function image(item, className='prompt-thumb-image'){
        const url = String(item?.thumbnail || '').trim();
        if(!url) return placeholder(item?.category);
        return `<img class="${escapeHtml(className)}" src="${escapeHtml(url)}" alt="${escapeHtml(item?.name || '提示词缩略图')}" loading="lazy" draggable="false" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="prompt-thumb-placeholder" hidden aria-hidden="true"><span>词</span></span>`;
    }

    function card(item){
        return `<span class="prompt-thumb-card" aria-hidden="true">${image(item)}</span>`;
    }

    function editor(item, {disabled=false, layout='default', purpose='', purposeEditable=false, purposeInputId=''}={}){
        const id = escapeHtml(item?.id || '');
        const hasImage = Boolean(String(item?.thumbnail || '').trim());
        if(layout === 'canvas'){
            const purposeText = String(purpose || '').trim();
            return `<div class="prompt-thumb-editor is-canvas-layout ${disabled ? 'is-disabled' : ''}" data-prompt-thumb-drop="${id}">
                <div class="prompt-thumb-editor-preview">${image(item)}</div>
                <div class="prompt-thumb-editor-copy">
                    <div class="prompt-thumb-purpose">
                        <strong>用途说明</strong>
                        ${purposeEditable
                            ? `<textarea ${purposeInputId ? `id="${escapeHtml(purposeInputId)}"` : ''} data-template-edit-scene placeholder="说明这个提示词适合做什么…">${escapeHtml(purposeText)}</textarea>`
                            : `<p>${escapeHtml(purposeText || '暂无用途说明')}</p>`}
                    </div>
                    <div class="prompt-thumb-editor-footer">
                        <span class="prompt-thumb-editor-hint">拖入图片 / Ctrl+V</span>
                        <div class="prompt-thumb-editor-actions">
                            <button type="button" data-prompt-thumb-action="choose" data-prompt-thumb-id="${id}" ${disabled ? 'disabled' : ''}>${hasImage ? '更换图片' : '选择图片'}</button>
                            ${hasImage ? `<button type="button" class="danger" data-prompt-thumb-action="remove" data-prompt-thumb-id="${id}" ${disabled ? 'disabled' : ''}>移除</button>` : ''}
                        </div>
                    </div>
                </div>
            </div>`;
        }
        return `<div class="prompt-thumb-editor ${disabled ? 'is-disabled' : ''}" data-prompt-thumb-drop="${id}">
            <div class="prompt-thumb-editor-preview">${image(item)}</div>
            <div class="prompt-thumb-editor-copy">
                <strong>缩略图</strong>
                <span>拖入图片、点击选择，或在未编辑文字时按 Ctrl+V</span>
                <div class="prompt-thumb-editor-actions">
                    <button type="button" data-prompt-thumb-action="choose" data-prompt-thumb-id="${id}" ${disabled ? 'disabled' : ''}>${hasImage ? '更换图片' : '选择图片'}</button>
                    ${hasImage ? `<button type="button" class="danger" data-prompt-thumb-action="remove" data-prompt-thumb-id="${id}" ${disabled ? 'disabled' : ''}>移除</button>` : ''}
                </div>
            </div>
        </div>`;
    }

    function mount({root, isActive, getItemId, preserveDraft, onPendingFile, onPendingRemove, onLibrary, onError, onSuccess}={}){
        if(!root) return () => {};
        let dragDepth = 0;
        let busy = false;

        const fail = error => (onError || console.error)(error?.message || String(error || '缩略图操作失败'));
        const apply = async (itemId, file) => {
            if(busy || !file) return;
            const restoreDraft = preserveDraft?.();
            if(!itemId){
                onPendingFile?.(file);
                restoreDraft?.();
                return;
            }
            busy = true;
            root.classList.add('prompt-thumb-busy');
            try {
                const data = await request(itemId, file);
                onLibrary?.(data.library, data.item);
                restoreDraft?.();
                onSuccess?.('缩略图已保存');
            } catch(error){ fail(error); }
            finally { busy = false; root.classList.remove('prompt-thumb-busy'); }
        };
        const remove = async itemId => {
            if(busy) return;
            if(!itemId){
                const restoreDraft = preserveDraft?.();
                onPendingRemove?.();
                restoreDraft?.();
                return;
            }
            busy = true;
            root.classList.add('prompt-thumb-busy');
            try {
                const data = await request(itemId);
                onLibrary?.(data.library, data.item);
                onSuccess?.('缩略图已移除');
            } catch(error){ fail(error); }
            finally { busy = false; root.classList.remove('prompt-thumb-busy'); }
        };
        const click = async event => {
            const action = event.target.closest?.('[data-prompt-thumb-action]');
            if(!action || !root.contains(action)) return;
            event.preventDefault();
            event.stopPropagation();
            const itemId = action.dataset.promptThumbId || getItemId?.();
            if(action.dataset.promptThumbAction === 'remove') return remove(itemId);
            const file = await chooseImageFile();
            if(file) await apply(itemId, file);
        };
        const dragEnter = event => {
            const zone = event.target.closest?.('[data-prompt-thumb-drop]');
            if(!zone || !root.contains(zone) || !transferHasImage(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            dragDepth += 1;
            zone.classList.add('is-dragover');
        };
        const dragOver = event => {
            const zone = event.target.closest?.('[data-prompt-thumb-drop]');
            if(!zone || !root.contains(zone)) return;
            event.preventDefault();
            event.stopPropagation();
            if(event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
            zone.classList.add('is-dragover');
        };
        const dragLeave = event => {
            const zone = event.target.closest?.('[data-prompt-thumb-drop]');
            if(!zone || !root.contains(zone)) return;
            event.stopPropagation();
            dragDepth = Math.max(0, dragDepth - 1);
            if(!dragDepth) zone.classList.remove('is-dragover');
        };
        const drop = event => {
            const zone = event.target.closest?.('[data-prompt-thumb-drop]');
            if(!zone || !root.contains(zone)) return;
            event.preventDefault();
            event.stopPropagation();
            dragDepth = 0;
            zone.classList.remove('is-dragover');
            const file = firstImageFile(event.dataTransfer?.files);
            if(file) apply(zone.dataset.promptThumbDrop || getItemId?.(), file);
        };
        const paste = event => {
            if(busy || !isActive?.()) return;
            const file = clipboardImage(event);
            const itemId = getItemId?.();
            if(!file) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            apply(itemId, file);
        };
        root.addEventListener('click', click);
        root.addEventListener('dragenter', dragEnter);
        root.addEventListener('dragover', dragOver);
        root.addEventListener('dragleave', dragLeave);
        root.addEventListener('drop', drop);
        document.addEventListener('paste', paste);
        return () => {
            root.removeEventListener('click', click);
            root.removeEventListener('dragenter', dragEnter);
            root.removeEventListener('dragover', dragOver);
            root.removeEventListener('dragleave', dragLeave);
            root.removeEventListener('drop', drop);
            document.removeEventListener('paste', paste);
        };
    }

    global.PromptTemplateThumbnails = {isEditableTarget, clipboardImage, firstImageFile, transferHasImage, chooseImageFile, request, upload:request, image, card, editor, mount};
})(window);
