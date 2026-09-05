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
        detail_pages:[], main_images:[],
        image_generations:[
            {id:'task-a', group_no:12, mode_name:'一键证件照', status:'succeeded', candidate_count:2},
            {id:'task-b', group_no:13, mode_name:'文化墙', status:'generating', candidate_count:4},
        ],
        image_generation_modes:{available:true, mode_count:51, example_count:3},
    };
}

test('image-generation history and local mode configuration are selected by default', () => {
    const state = backup.createBackupSelection(fixture());
    assert.deepEqual([...state.imageGenerationTaskIds].sort(), ['task-a', 'task-b']);
    assert.equal(state.includeImageGenerationModes, true);
    const payload = backup.buildBackupExportRequest(state);
    assert.deepEqual(payload.image_generation_task_ids.sort(), ['task-a', 'task-b']);
    assert.equal(payload.include_image_generation_modes, true);
    assert.doesNotMatch(JSON.stringify(payload), /一键证件照|文化墙/);
});

test('image-generation selections participate in individual and select-all controls', () => {
    const state = backup.createBackupSelection(fixture());
    backup.setImageGenerationSelected(state, 'task-b', false);
    assert.deepEqual(backup.buildBackupExportRequest(state).image_generation_task_ids, ['task-a']);
    backup.setAllSelected(state, false);
    const cleared = backup.buildBackupExportRequest(state);
    assert.deepEqual(cleared.image_generation_task_ids, []);
    assert.equal(cleared.include_image_generation_modes, false);
});

test('backup UI renders image-generation history, configuration and shared media wording', () => {
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'static', 'canvas-list.html'), 'utf8');
    const shell = fs.readFileSync(path.join(ROOT, 'static', 'index.html'), 'utf8');
    assert.match(source, /图片生成历史/);
    assert.match(source, /image-generation-group/);
    assert.match(source, /图片生成模式与示范/);
    assert.match(source, /画布、详情页与图片生成素材/);
    assert.match(shell, /选择画布、历史和配置/);
});

test('import result reports image-generation counts, missing media and refresh events', () => {
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    assert.match(source, /result\.image_generations/);
    assert.match(source, /result\.image_generation_modes_imported/);
    assert.match(source, /result\.image_generation_examples_imported/);
    assert.match(source, /result\.image_generation_missing_media/);
    assert.match(source, /result\.image_generations_skipped/);
    assert.match(source, /image-generations-changed/);
});

test('backup dates support image-generation ISO timestamps and legacy numeric timestamps', () => {
    assert.notEqual(backup.formatBackupDate('2026-08-25T08:30:00+00:00', 'zh-CN'), '');
    assert.notEqual(backup.formatBackupDate(1787646600000, 'zh-CN'), '');
    assert.equal(backup.formatBackupDate('not-a-date', 'zh-CN'), '');
});
