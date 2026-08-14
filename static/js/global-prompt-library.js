(function(){
    'use strict';
    if(window.__globalPromptLibraryInstalled) return;
    window.__globalPromptLibraryInstalled = true;

    const state = {
        root:null,
        libraryData:{libraries:[], active_library_id:''},
        libraryId:'',
        category:'all',
        query:'',
        selectedId:'',
        loading:false,
    };

    function escapeHtml(value=''){
        return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    }

    function escapeAttr(value=''){
        return escapeHtml(value);
    }

    function isEditableTarget(target){
        if(!target) return false;
        if(target.isContentEditable) return true;
        return Boolean(target.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
    }

    function libraries(){
        return Array.isArray(state.libraryData?.libraries) ? state.libraryData.libraries : [];
    }

    function activeLibrary(){
        const entries = libraries();
        return entries.find(item => item.id === state.libraryId) || entries[0] || {id:'', name:'提示词库', categories:[], items:[]};
    }

    function categoryLabel(id, library=activeLibrary()){
        const builtins = {all:'全部', view:'视角', storyboard:'分镜', character:'角色', product:'产品', lighting:'光影', custom:'我的'};
        return (library.categories || []).find(item => item.id === id)?.name || builtins[id] || id || '未分组';
    }

    function categories(library=activeLibrary()){
        const result = [];
        const seen = new Set();
        const add = (id, name) => {
            const key = String(id || 'custom');
            if(seen.has(key)) return;
            seen.add(key);
            result.push({id:key, name:name || categoryLabel(key, library)});
        };
        (library.categories || []).forEach(item => add(item.id, item.name));
        (library.items || []).forEach(item => add(item.category || 'custom'));
        return result;
    }

    function filteredItems(){
        const library = activeLibrary();
        const query = state.query.trim().toLowerCase();
        return (library.items || []).filter(item => {
            if(state.category !== 'all' && String(item.category || 'custom') !== state.category) return false;
            if(!query) return true;
            return [item.name, item.scene, item.positive, item.negative].some(value => String(value || '').toLowerCase().includes(query));
        });
    }

    function selectedItem(items=filteredItems()){
        return items.find(item => String(item.id) === state.selectedId) || items[0] || null;
    }

    function ensureUi(){
        if(state.root?.isConnected) return state.root;
        const style = document.createElement('style');
        style.id = 'globalPromptLibraryStyle';
        style.textContent = `
            .global-prompt-library-overlay{position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;justify-content:center;padding:24px;background:rgba(15,23,42,.38);backdrop-filter:blur(3px);font-family:Inter,"Microsoft YaHei",system-ui,sans-serif;color:#172033}
            .global-prompt-library-overlay.open{display:flex}
            .global-prompt-library-dialog{width:min(820px,calc(100vw - 32px));height:min(720px,calc(100vh - 48px));display:flex;flex-direction:column;overflow:hidden;border:1px solid #dbe3ef;border-radius:18px;background:#fff;box-shadow:0 28px 80px rgba(15,23,42,.24)}
            .global-prompt-library-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 12px;border-bottom:1px solid #e8edf4}
            .global-prompt-library-title{display:flex;align-items:baseline;gap:10px}.global-prompt-library-title strong{font-size:17px}.global-prompt-library-title span{font-size:12px;color:#8a96a8}
            .global-prompt-library-close{width:34px;height:34px;border:0;border-radius:10px;background:#f4f7fb;color:#536174;font-size:22px;cursor:pointer}.global-prompt-library-close:hover{background:#e9eef6;color:#111827}
            .global-prompt-library-tools{display:grid;grid-template-columns:220px minmax(0,1fr);gap:10px;padding:12px 18px 8px}.global-prompt-library-tools select,.global-prompt-library-tools input{width:100%;height:38px;border:1px solid #dbe3ef;border-radius:10px;background:#fff;padding:0 12px;color:#172033;font:inherit;font-size:13px;outline:none}.global-prompt-library-tools select:focus,.global-prompt-library-tools input:focus{border-color:#7199f7;box-shadow:0 0 0 3px rgba(75,123,240,.12)}
            .global-prompt-library-tabs{display:flex;gap:7px;overflow:auto;padding:2px 18px 10px;scrollbar-width:thin}.global-prompt-library-tab{flex:0 0 auto;border:1px solid #dbe3ef;border-radius:999px;background:#fff;padding:7px 12px;color:#59677a;font-size:12px;font-weight:600;cursor:pointer}.global-prompt-library-tab.active{border-color:#111827;background:#111827;color:#fff}
            .global-prompt-library-body{display:grid;grid-template-columns:265px minmax(0,1fr);gap:12px;min-height:0;flex:1;padding:0 18px 18px}.global-prompt-library-list,.global-prompt-library-detail{min-height:0;overflow:auto;border:1px solid #e0e7f0;border-radius:13px;background:#fbfcfe}.global-prompt-library-list{padding:8px}.global-prompt-library-card{display:grid;grid-template-columns:52px minmax(0,1fr);gap:10px;width:100%;padding:8px;border:1px solid transparent;border-radius:10px;background:transparent;text-align:left;cursor:pointer;color:inherit}.global-prompt-library-card:hover{background:#f1f5fb}.global-prompt-library-card.active{border-color:#111827;background:#fff;box-shadow:0 2px 10px rgba(15,23,42,.07)}
            .global-prompt-library-thumb{width:52px;height:52px;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:9px;background:linear-gradient(135deg,#f3e8ff,#e0e7ff);color:#6d5bd0;font-size:16px;font-weight:800}.global-prompt-library-thumb img{width:100%;height:100%;object-fit:cover}.global-prompt-library-card-copy{min-width:0}.global-prompt-library-card-copy strong,.global-prompt-library-card-copy span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.global-prompt-library-card-copy strong{font-size:13px;margin:3px 0 6px}.global-prompt-library-card-copy span{font-size:11px;color:#8a96a8}
            .global-prompt-library-detail{padding:18px;background:#fff}.global-prompt-library-detail h3{margin:0 0 4px;font-size:18px}.global-prompt-library-meta{margin-bottom:14px;color:#8491a4;font-size:12px}.global-prompt-library-detail-media{display:flex;align-items:stretch;gap:12px;margin-bottom:14px}.global-prompt-library-detail-thumb{width:240px;height:200px;flex:0 0 240px;display:flex;align-items:center;justify-content:center;overflow:hidden;border:1px solid #e3e9f2;border-radius:12px;background:linear-gradient(135deg,#f3e8ff,#e0e7ff);color:#6d5bd0;font-size:28px;font-weight:800}.global-prompt-library-detail-thumb img{width:240px;height:200px;object-fit:cover;object-position:center}.global-prompt-library-detail-placeholder{display:flex;width:100%;height:100%;align-items:center;justify-content:center}.global-prompt-library-scene{flex:1;margin:0;padding:10px 12px;border-radius:10px;background:#f6f8fc;color:#526075;font-size:12px;line-height:1.55}.global-prompt-library-section{margin-top:14px}.global-prompt-library-section label{display:block;margin-bottom:7px;color:#7e8b9f;font-size:11px;font-weight:700}.global-prompt-library-text{max-height:210px;overflow:auto;white-space:pre-wrap;word-break:break-word;border:1px solid #e3e9f2;border-radius:11px;background:#fbfcfe;padding:12px;font-size:13px;line-height:1.65;color:#283447}
            .global-prompt-library-actions{display:flex;gap:9px;margin-top:16px}.global-prompt-library-copy{height:38px;border:0;border-radius:10px;padding:0 16px;background:#101827;color:#fff;font-size:13px;font-weight:700;cursor:pointer}.global-prompt-library-copy.secondary{border:1px solid #dbe3ef;background:#fff;color:#334155}.global-prompt-library-copy:hover{filter:brightness(.96)}
            .global-prompt-library-empty{display:flex;min-height:180px;align-items:center;justify-content:center;padding:24px;color:#98a3b3;font-size:13px}.global-prompt-library-status{min-height:18px;margin-left:auto;align-self:center;color:#16815f;font-size:12px}
            html.theme-dark .global-prompt-library-dialog,html.studio-theme-dark .global-prompt-library-dialog{border-color:#344154;background:#151d29;color:#e7edf6}.theme-dark .global-prompt-library-tools select,.theme-dark .global-prompt-library-tools input,.studio-theme-dark .global-prompt-library-tools select,.studio-theme-dark .global-prompt-library-tools input,.theme-dark .global-prompt-library-detail,.studio-theme-dark .global-prompt-library-detail{border-color:#344154;background:#182231;color:#e7edf6}.theme-dark .global-prompt-library-list,.studio-theme-dark .global-prompt-library-list{border-color:#344154;background:#111925}.theme-dark .global-prompt-library-card.active,.studio-theme-dark .global-prompt-library-card.active{background:#222d3d}.theme-dark .global-prompt-library-text,.theme-dark .global-prompt-library-scene,.studio-theme-dark .global-prompt-library-text,.studio-theme-dark .global-prompt-library-scene{border-color:#344154;background:#111925;color:#dce5f1}
            @media(max-width:680px){.global-prompt-library-overlay{padding:8px}.global-prompt-library-dialog{width:100%;height:calc(100vh - 16px);border-radius:14px}.global-prompt-library-tools{grid-template-columns:1fr}.global-prompt-library-body{grid-template-columns:1fr;grid-template-rows:210px minmax(0,1fr)}.global-prompt-library-detail-media{display:block}.global-prompt-library-detail-thumb{width:100%;height:180px;margin-bottom:10px}.global-prompt-library-detail-thumb img{width:100%;height:180px}}
        `;
        document.head.appendChild(style);

        const root = document.createElement('div');
        root.id = 'globalPromptLibrary';
        root.className = 'global-prompt-library-overlay';
        root.setAttribute('aria-hidden', 'true');
        root.innerHTML = `
            <section class="global-prompt-library-dialog" role="dialog" aria-modal="true" aria-labelledby="globalPromptLibraryTitle">
                <header class="global-prompt-library-head">
                    <div class="global-prompt-library-title"><strong id="globalPromptLibraryTitle">提示词库</strong><span>浏览并复制</span></div>
                    <button class="global-prompt-library-close" type="button" aria-label="关闭" title="关闭">×</button>
                </header>
                <div class="global-prompt-library-tools">
                    <select data-global-prompt-library aria-label="提示词库"></select>
                    <input data-global-prompt-search type="search" placeholder="搜索提示词" autocomplete="off">
                </div>
                <div class="global-prompt-library-tabs" data-global-prompt-tabs></div>
                <div class="global-prompt-library-body">
                    <div class="global-prompt-library-list" data-global-prompt-list></div>
                    <div class="global-prompt-library-detail" data-global-prompt-detail></div>
                </div>
            </section>`;
        document.body.appendChild(root);
        state.root = root;

        root.querySelector('.global-prompt-library-close')?.addEventListener('click', close);
        root.addEventListener('click', event => { if(event.target === root) close(); });
        root.querySelector('[data-global-prompt-library]')?.addEventListener('change', event => {
            state.libraryId = event.target.value || '';
            state.category = 'all';
            state.selectedId = '';
            render();
        });
        root.querySelector('[data-global-prompt-search]')?.addEventListener('input', event => {
            state.query = event.target.value || '';
            state.selectedId = '';
            render();
        });
        root.addEventListener('click', async event => {
            const tab = event.target.closest('[data-global-prompt-category]');
            if(tab){ state.category = tab.dataset.globalPromptCategory || 'all'; state.selectedId = ''; render(); return; }
            const card = event.target.closest('[data-global-prompt-id]');
            if(card){ state.selectedId = card.dataset.globalPromptId || ''; render(); return; }
            const copy = event.target.closest('[data-global-prompt-copy]');
            if(copy){
                const item = selectedItem();
                const field = copy.dataset.globalPromptCopy || 'positive';
                await copyText(item?.[field] || '');
            }
        });
        return root;
    }

    function setStatus(message){
        const element = state.root?.querySelector('[data-global-prompt-status]');
        if(!element) return;
        element.textContent = message || '';
        if(message) setTimeout(() => { if(element.textContent === message) element.textContent = ''; }, 1800);
    }

    async function copyText(text){
        const value = String(text || '').trim();
        if(!value){ setStatus('没有可复制的内容'); return false; }
        try {
            if(navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
            else throw new Error('clipboard unavailable');
        } catch(error) {
            const textarea = document.createElement('textarea');
            textarea.value = value;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            const ok = document.execCommand('copy');
            textarea.remove();
            if(!ok){ setStatus('复制失败，请手动复制'); return false; }
        }
        setStatus('已复制提示词');
        return true;
    }

    function render(){
        const root = ensureUi();
        const library = activeLibrary();
        const selector = root.querySelector('[data-global-prompt-library]');
        if(selector){
            selector.innerHTML = libraries().map(item => `<option value="${escapeAttr(item.id)}" ${item.id === library.id ? 'selected' : ''}>${escapeHtml(item.name || '提示词库')}</option>`).join('');
        }
        const tabs = root.querySelector('[data-global-prompt-tabs]');
        if(tabs){
            tabs.innerHTML = [{id:'all', name:'全部'}, ...categories(library)].map(item => `<button class="global-prompt-library-tab ${item.id === state.category ? 'active' : ''}" type="button" data-global-prompt-category="${escapeAttr(item.id)}">${escapeHtml(item.name)}</button>`).join('');
        }
        const items = filteredItems();
        const selected = selectedItem(items);
        if(selected && state.selectedId !== String(selected.id)) state.selectedId = String(selected.id || '');
        const list = root.querySelector('[data-global-prompt-list]');
        if(list){
            list.innerHTML = items.length ? items.map(item => `
                <button class="global-prompt-library-card ${String(item.id) === state.selectedId ? 'active' : ''}" type="button" data-global-prompt-id="${escapeAttr(item.id)}">
                    <span class="global-prompt-library-thumb">${item.thumbnail ? `<img src="${escapeAttr(item.thumbnail)}" alt="">` : escapeHtml((item.name || '词').slice(0, 1))}</span>
                    <span class="global-prompt-library-card-copy"><strong>${escapeHtml(item.name || '提示词')}</strong><span>${escapeHtml(item.scene || categoryLabel(item.category, library))}</span></span>
                </button>`).join('') : '<div class="global-prompt-library-empty">没有匹配的提示词</div>';
        }
        const detail = root.querySelector('[data-global-prompt-detail]');
        if(detail){
            detail.innerHTML = selected ? `
                <h3>${escapeHtml(selected.name || '提示词')}</h3>
                <div class="global-prompt-library-meta">${escapeHtml(categoryLabel(selected.category, library))} · ${escapeHtml(library.name || '提示词库')}</div>
                <div class="global-prompt-library-detail-media">
                    <div class="global-prompt-library-detail-thumb">
                        ${selected.thumbnail
                            ? `<img src="${escapeAttr(selected.thumbnail)}" alt="${escapeAttr(selected.name || '提示词缩略图')}" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="global-prompt-library-detail-placeholder" hidden>${escapeHtml((selected.name || '词').slice(0, 1))}</span>`
                            : `<span class="global-prompt-library-detail-placeholder">${escapeHtml((selected.name || '词').slice(0, 1))}</span>`}
                    </div>
                    <p class="global-prompt-library-scene">${escapeHtml(selected.scene || '暂无用途说明')}</p>
                </div>
                <div class="global-prompt-library-section"><label>提示词</label><div class="global-prompt-library-text">${escapeHtml(selected.positive || '')}</div></div>
                ${selected.negative ? `<div class="global-prompt-library-section"><label>负向提示词</label><div class="global-prompt-library-text">${escapeHtml(selected.negative)}</div></div>` : ''}
                <div class="global-prompt-library-actions">
                    <button class="global-prompt-library-copy" type="button" data-global-prompt-copy="positive">复制提示词</button>
                    ${selected.negative ? '<button class="global-prompt-library-copy secondary" type="button" data-global-prompt-copy="negative">复制负向提示词</button>' : ''}
                    <span class="global-prompt-library-status" data-global-prompt-status></span>
                </div>` : '<div class="global-prompt-library-empty">选择一个提示词查看内容</div>';
        }
    }

    async function load(){
        if(state.loading) return;
        state.loading = true;
        try {
            const response = await fetch('/api/prompt-libraries');
            if(!response.ok) throw new Error('提示词库加载失败');
            const data = await response.json();
            state.libraryData = data.library || {libraries:[]};
            const entries = libraries();
            if(!state.libraryId || !entries.some(item => item.id === state.libraryId)){
                state.libraryId = state.libraryData.active_library_id || entries[0]?.id || '';
            }
            state.category = 'all';
            state.selectedId = '';
            render();
        } catch(error) {
            const detail = state.root?.querySelector('[data-global-prompt-detail]');
            if(detail) detail.innerHTML = `<div class="global-prompt-library-empty">${escapeHtml(error?.message || '提示词库加载失败')}</div>`;
        } finally {
            state.loading = false;
        }
    }

    async function open(){
        const root = ensureUi();
        root.classList.add('open');
        root.setAttribute('aria-hidden', 'false');
        state.query = '';
        const search = root.querySelector('[data-global-prompt-search]');
        if(search) search.value = '';
        await load();
        search?.focus();
    }

    function close(){
        if(!state.root) return;
        state.root.classList.remove('open');
        state.root.setAttribute('aria-hidden', 'true');
    }

    document.addEventListener('keydown', event => {
        if(event.key === 'Escape' && state.root?.classList.contains('open')){ event.preventDefault(); close(); return; }
        if(event.key.toLowerCase() !== 't' || event.repeat) return;
        if(event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        if(isEditableTarget(event.target)) return;
        if(state.root?.classList.contains('open')) return;
        event.preventDefault();
        event.stopPropagation();
        open();
    }, true);

    window.GlobalPromptLibrary = {open, close, isOpen:() => Boolean(state.root?.classList.contains('open'))};
})();
