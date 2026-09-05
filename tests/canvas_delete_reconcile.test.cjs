const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const classic = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas.js'), 'utf8');
const smart = fs.readFileSync(path.join(ROOT, 'static', 'js', 'smart-canvas.js'), 'utf8');
const backend = fs.readFileSync(path.join(ROOT, 'main.py'), 'utf8');

function block(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing block ${start}`);
    return source.slice(from, to);
}

test('canvas auto-reconcile endpoint is disabled and cannot mutate records', () => {
    assert.match(backend, /@app\.post\("\/api\/canvas-assets\/reconcile-delete"\)/);
    assert.match(backend, /画布节点删除不会自动清理/);
    assert.doesNotMatch(backend, /@app\.post\("\/api\/canvas-assets\/reconcile-delete", status_code=202\)/);
    assert.doesNotMatch(classic, /仅从画布删除|删除画布节点及对应生成记录/);
    assert.doesNotMatch(smart, /仅从画布删除|删除画布节点及对应生成记录/);
});

test('classic canvas keeps logs and only saves node deletion', () => {
    const deleteNode = block(classic, 'function deleteNode(id, event)', 'function clearNodeContentBeforeDelete');
    const clearOutput = block(classic, 'function clearNodeContentBeforeDelete', 'function deleteNodeFromButton');
    const batchDelete = block(classic, 'function deleteSelectedNodes()', 'function hasImageFiles');
    const reconcile = block(classic, 'async function flushClassicCanvasSave', 'function scheduleSave');
    const back = block(classic, "backToManagerBtn?.addEventListener('click'", "window.addEventListener('beforeunload'");
    assert.match(deleteNode, /pushUndo\(\)/);
    assert.doesNotMatch(deleteNode, /queueClassicCanvasDeleteReconcile/);
    assert.doesNotMatch(clearOutput, /queueClassicCanvasDeleteReconcile/);
    assert.doesNotMatch(batchDelete, /queueClassicCanvasDeleteReconcile/);
    assert.doesNotMatch(reconcile, /pruneClassicCanvasLogsForDeletedMedia/);
    assert.doesNotMatch(reconcile, /\/api\/canvas-assets\/reconcile-delete/);
    assert.match(back, /flushClassicCanvasSave/);
    assert.doesNotMatch(back, /flushClassicCanvasDeleteReconcile/);
    assert.match(block(classic, 'function snapshotForHistory()', 'function getCanvasHistory'), /logs/);
});

test('smart canvas keeps logs and only saves node deletion', () => {
    const deleteNode = block(smart, 'function deleteNode(id)', 'function clearNodeMediaBeforeDelete');
    const clearNode = block(smart, 'function clearNodeMediaBeforeDelete', 'function deleteNodeFromButton');
    const deleteImage = block(smart, 'function deleteImage(id, imageIndex)', 'async function renameSmartNodeImage');
    const reconcile = block(smart, 'async function flushSmartCanvasSave', 'function scheduleSave');
    const back = block(smart, 'async function backToCanvasList()', "window.addEventListener('beforeunload'");
    assert.match(deleteNode, /pushUndo\(\)/);
    assert.doesNotMatch(deleteNode, /queueSmartCanvasDeleteReconcile/);
    assert.doesNotMatch(clearNode, /queueSmartCanvasDeleteReconcile/);
    assert.doesNotMatch(deleteImage, /queueSmartCanvasDeleteReconcile/);
    assert.doesNotMatch(reconcile, /pruneSmartCanvasLogsForDeletedMedia/);
    assert.doesNotMatch(reconcile, /\/api\/canvas-assets\/reconcile-delete/);
    assert.match(back, /flushSmartCanvasSave/);
    assert.doesNotMatch(back, /flushSmartCanvasDeleteReconcile/);
    assert.match(block(smart, 'function snapshotForUndo()', 'const smartCanvasHistory'), /logs/);
});

test('new canvas image results retain their owning local task id', () => {
    assert.match(backend, /result\["canvas_task_id"\] = task_id/);
    assert.match(classic, /source\.canvas_task_id = source\.canvas_task_id \|\| result\.canvas_task_id \|\| taskId/);
    assert.match(smart, /canvas_task_id:taskId/);
});
