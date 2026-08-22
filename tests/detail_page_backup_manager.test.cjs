const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'static', 'js', 'backup-manager.js');
const backup = require(MODULE_PATH);

function fixture(){
    return {
        projects:[], providers:[], runninghub:{apps:[], workflows:[]}, prompt_libraries:[],
        detail_pages:[
            {id:'detail-a', group_no:7, title:'香水详情页', status:'succeeded', screen_count:6},
            {id:'detail-b', group_no:8, title:'礼盒详情页', status:'failed', screen_count:4},
        ],
    };
}

test('detail histories are selected by default and exported as identifiers only', () => {
    const state = backup.createBackupSelection(fixture());
    assert.deepEqual([...state.detailPageTaskIds].sort(), ['detail-a', 'detail-b']);
    const payload = backup.buildBackupExportRequest(state);
    assert.deepEqual(payload.detail_page_task_ids.sort(), ['detail-a', 'detail-b']);
    assert.equal(payload.include_assets, true);
    assert.doesNotMatch(JSON.stringify(payload), /香水详情页|礼盒详情页/);
});

test('select all and individual detail history controls participate in overall selection', () => {
    const state = backup.createBackupSelection(fixture());
    backup.setDetailPageSelected(state, 'detail-b', false);
    assert.equal(state.detailPageTaskIds.has('detail-a'), true);
    assert.equal(state.detailPageTaskIds.has('detail-b'), false);
    backup.setAllSelected(state, false);
    assert.equal(state.detailPageTaskIds.size, 0);
    assert.equal(backup.buildBackupExportRequest(state).detail_page_task_ids.length, 0);
});

test('backup UI renders detail history section, shared media wording, and import result count', () => {
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    assert.match(source, /详情页历史/);
    assert.match(source, /画布与详情页素材/);
    assert.match(source, /detail-page-group/);
    assert.match(source, /result\.detail_pages/);
    assert.match(source, /detail-pages-changed/);
});
