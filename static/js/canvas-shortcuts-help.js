(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.CanvasShortcutsHelp = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    const ALL_PROFILES = ['smart', 'classic'];
    const ITEMS = [
        {id:'box-select', keys:['Ctrl'], i18n:'smart.shortcutBoxSelect', label:'按住并拖拽框选节点', profiles:ALL_PROFILES},
        {id:'group', keys:['Ctrl', 'G'], i18n:'smart.shortcutGroup', label:'合并选中的图片为组', profiles:ALL_PROFILES},
        {id:'ungroup', keys:['Ctrl', 'Shift', 'G'], i18n:'smart.shortcutUngroup', label:'释放选中的分组', profiles:['smart']},
        {id:'undo', keys:['Ctrl', 'Z'], i18n:'smart.shortcutUndo', label:'撤销上一步操作', profiles:ALL_PROFILES},
        {id:'redo-shift', keys:['Ctrl', 'Shift', 'Z'], i18n:'smart.shortcutUndoAlt', label:'恢复上一步操作', profiles:ALL_PROFILES},
        {id:'redo-y', keys:['Ctrl', 'Y'], i18n:'smart.shortcutUndoAlt', label:'恢复上一步操作', profiles:ALL_PROFILES},
        {id:'copy', keys:['Ctrl', 'C'], i18n:'smart.shortcutCopy', label:'复制选中的节点', profiles:ALL_PROFILES},
        {id:'paste', keys:['Ctrl', 'V'], i18n:'smart.shortcutPaste', label:'粘贴节点或剪贴板图片', profiles:ALL_PROFILES},
        {id:'alt-copy', keys:['Alt'], i18n:'smart.shortcutAltCopy', label:'按住并拖动复制节点', profiles:ALL_PROFILES},
        {id:'alt-shift-copy', keys:['Alt', 'Shift'], i18n:'smart.shortcutAltShiftCopy', label:'复制节点并保留输入连线', profiles:ALL_PROFILES},
        {id:'assets', keys:['A'], i18n:'smart.shortcutAssets', label:'打开/关闭资源库', profiles:ALL_PROFILES},
        {id:'overview', keys:['Z'], i18n:'smart.shortcutOverview', label:'缩小画布视图', profiles:ALL_PROFILES},
        {id:'create-menu', keys:['双击'], i18n:'smart.shortcutCreateMenu', label:'打开快捷菜单', profiles:['smart']},
        {id:'pan', keys:['空白处'], i18n:'smart.shortcutPan', label:'拖动画布', profiles:ALL_PROFILES},
        {id:'zoom', keys:['滚轮'], i18n:'smart.shortcutZoom', label:'缩放画布或预览图片', profiles:ALL_PROFILES},
        {id:'delete', keys:['Del'], i18n:'smart.shortcutDelete', label:'删除选中节点', profiles:ALL_PROFILES},
    ];

    function escapeHtml(value){
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
        })[char]);
    }

    function shortcutItems(profile='smart'){
        const resolved = profile === 'classic' ? 'classic' : 'smart';
        return ITEMS
            .filter(item => item.profiles.includes(resolved))
            .map(item => ({...item, keys:item.keys.slice(), profiles:item.profiles.slice()}));
    }

    function shortcutItemsHtml(profile='smart'){
        const translationAttribute = ['data', 'i18n'].join('-');
        return shortcutItems(profile).map(item => {
            const keys = item.keys.map(key => `<kbd>${escapeHtml(key)}</kbd>`).join('');
            return `<div class="shortcut-item" data-shortcut-id="${escapeHtml(item.id)}"><span class="shortcut-keys">${keys}</span><span ${translationAttribute}="${escapeHtml(item.i18n)}">${escapeHtml(item.label)}</span></div>`;
        }).join('');
    }

    function renderShortcutList(container, profile='smart'){
        if(!container) return false;
        container.innerHTML = shortcutItemsHtml(profile);
        return true;
    }

    function createShortcutController({modal, toggle, onOpen}={}){
        function setOpen(open){
            const next = Boolean(open);
            modal?.classList?.toggle('open', next);
            toggle?.classList?.toggle('active', next);
            toggle?.setAttribute?.('aria-expanded', String(next));
            if(next) onOpen?.();
            return next;
        }
        return {
            open:() => setOpen(true),
            close:() => setOpen(false),
            toggle:() => setOpen(!modal?.classList?.contains('open')),
            isOpen:() => Boolean(modal?.classList?.contains('open')),
        };
    }

    function mountShortcutHelp({modal, toggle, list, profile='smart', keyboardTarget, onOpen}={}){
        renderShortcutList(list, profile);
        const controller = createShortcutController({modal, toggle, onOpen});
        toggle?.setAttribute?.('aria-expanded', 'false');
        toggle?.addEventListener?.('click', event => {
            event.preventDefault?.();
            event.stopPropagation?.();
            controller.toggle();
        });
        modal?.querySelectorAll?.('[data-shortcut-close]')?.forEach(button => {
            button.addEventListener('click', event => {
                event.preventDefault?.();
                controller.close();
            });
        });
        keyboardTarget?.addEventListener?.('keydown', event => {
            if(event.key === 'Escape' && controller.isOpen()) controller.close();
        });
        return controller;
    }

    return {
        shortcutItems,
        shortcutItemsHtml,
        renderShortcutList,
        createShortcutController,
        mountShortcutHelp,
    };
});
