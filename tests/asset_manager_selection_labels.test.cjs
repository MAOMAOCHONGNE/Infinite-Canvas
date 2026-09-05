const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'static', 'js', 'asset-manager.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'static', 'asset-manager.html'), 'utf8');

test('asset manager uses the clearer role-library label', () => {
    assert.match(HTML, /data-tab="assets"[\s\S]*?<span>角色库<\/span>/);
    assert.match(SOURCE, /activeAssetCategory\(\)\?\.name \|\| '角色库'/);
});

test('all bulk selectors use the new toggle labels and shared toggle helper', () => {
    assert.match(SOURCE, /return selectionIsComplete\(items, set\) \? '取消选择' : '全部选择';/);
    assert.match(SOURCE, /toggleSelectionAll\(currentAssetItems\(\), selectedAssetIds\)/);
    assert.match(SOURCE, /toggleSelectionAll\(currentWorkflowItems\(\), selectedWorkflowIds\)/);
    assert.match(SOURCE, /toggleSelectionAll\(currentPromptItems\(\), selectedPromptIds\)/);
    assert.match(SOURCE, /toggleSelectionAll\(currentCanvasAssetItems\(\), selectedCanvasAssetIds\)/);
    assert.match(SOURCE, /toggleSelectionAll\(localUploadItems\(\), selectedLocalUploadIds\)/);
    assert.doesNotMatch(SOURCE, /data-asset-clear-selection[\s\S]*?<span>清空<\/span>/);
    assert.doesNotMatch(SOURCE, /data-workflow-clear-selection[\s\S]*?<span>清空<\/span>/);
    assert.doesNotMatch(SOURCE, /data-prompt-clear-selection[\s\S]*?<span>清空<\/span>/);
    assert.doesNotMatch(SOURCE, /data-canvas-asset-clear-selection[\s\S]*?<span>清空<\/span>/);
});

test('storage cleanup uses one unified scan action and shows file and space summaries', () => {
    assert.match(SOURCE, /data-storage-cleanup-scan/);
    assert.doesNotMatch(SOURCE, /data-storage-cleanup-kind=/);
    assert.match(SOURCE, /全部文件/);
    assert.match(SOURCE, /可清理/);
    assert.match(SOURCE, /summary\.total_files/);
    assert.match(SOURCE, /summary\.candidate_bytes/);
    assert.match(SOURCE, /旧版来源未标记文件/);
    assert.match(SOURCE, /legacy_unmarked_history/);
    assert.match(SOURCE, /旧案例残留/);
    assert.match(SOURCE, /fixed-example/);
    assert.match(SOURCE, /fixed_example_orphan/);
    assert.match(SOURCE, /canvas_log_only/);
    assert.match(SOURCE, /画布日志仅作为历史记录保留，不代表当前仍占用图片/);
    assert.match(SOURCE, /确认后台清理/);
});
