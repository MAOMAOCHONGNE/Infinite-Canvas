(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    else root.CanvasHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    function createSnapshotHistory({limit=30, capture, restore}={}){
        if(typeof capture !== 'function' || typeof restore !== 'function'){
            throw new TypeError('capture and restore must be functions');
        }
        const maxEntries = Math.max(1, Number(limit) || 1);
        const undoStack = [];
        const redoStack = [];

        function push(stack, snapshot){
            stack.push(snapshot);
            if(stack.length > maxEntries) stack.shift();
        }

        function record(snapshot){
            push(undoStack, arguments.length ? snapshot : capture());
            redoStack.length = 0;
        }

        function undo(){
            if(!undoStack.length) return false;
            push(redoStack, capture());
            restore(undoStack.pop());
            return true;
        }

        function redo(){
            if(!redoStack.length) return false;
            push(undoStack, capture());
            restore(redoStack.pop());
            return true;
        }

        return {record, undo, redo};
    }

    function historyShortcutAction(event={}){
        if(!event.ctrlKey && !event.metaKey) return '';
        const key = String(event.key || '').toLowerCase();
        if(key === 'z') return event.shiftKey ? 'redo' : 'undo';
        if(key === 'y') return 'redo';
        return '';
    }

    return {createSnapshotHistory, historyShortcutAction};
});
