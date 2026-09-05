const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const pages = [
    fs.readFileSync(path.join(ROOT, 'static/js/main-image.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'static/js/detail-page.js'), 'utf8'),
];
const htmlPages = [
    fs.readFileSync(path.join(ROOT, 'static/main-image.html'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'static/detail-page.html'), 'utf8'),
];

test('main-image and detail-page use the same non-blocking group-delete contract', () => {
    for(const source of pages){
        assert.match(source, /deletingTaskId/);
        assert.match(source, /cleanup_job_id/);
        assert.match(source, /storage-cleanup\/jobs/);
        assert.match(source, /图片正在后台清理/);
        assert.match(source, /图片将在后台重试清理/);
        assert.match(source, /旧图片需重新审计确认后清理/);
        assert.match(source, /status === 'review_required'/);
        assert.match(source, /status === 'succeeded'[\s\S]*?图片清理完成/);
        assert.match(source, /Number\(error\?\.status\) === 404[\s\S]*?图片清理完成/);
        assert.match(source, /void detailOpenHistoryTask\(nextId/);
        assert.match(source, /cached \|\| await detailFetchJson/);
        assert.match(source, /aria-busy/);
        assert.match(source, /!detailRuntime\.activeTaskIds\.has\(taskId\)/);
        assert.match(source, /if\(!detailRuntime\.activeTaskIds\.size\) detailStopPolling\(\)/);
    }
});

test('group delete no longer awaits the next history fetch before rendering', () => {
    for(const source of pages){
        assert.doesNotMatch(source, /if\(nextId\) await detailOpenHistoryTask\(nextId/);
    }
});

test('single-screen delete uses the same 202 cleanup contract and handles the last screen', () => {
    for(const source of pages){
        const start = source.indexOf('async function detailDeleteScreen');
        const end = source.indexOf('function detailBindScreenReorder', start);
        const deleteScreen = source.slice(start, end);
        assert.match(source, /deletingScreenNo/);
        assert.match(deleteScreen, /result\?\.task_deleted/);
        assert.match(deleteScreen, /result\?\.task/);
        assert.match(deleteScreen, /detailTrackCleanupJob\(result\.cleanup_job_id,/);
        assert.match(deleteScreen, /图片正在后台清理/);
        assert.match(deleteScreen, /const result = await detailFetchJson/);
        assert.doesNotMatch(deleteScreen, /const task = await detailFetchJson/);
    }
});

test('both one-click pages use an app-owned delete confirmation dialog', () => {
    for(const html of htmlPages){
        assert.match(html, /<dialog id="deleteTaskDialog"/);
        assert.match(html, /id="deleteTaskCancelBtn"/);
        assert.match(html, /id="deleteTaskConfirmBtn"/);
        assert.match(html, /分组记录会立即删除，图片将在后台清理/);
    }
    for(const source of pages){
        assert.match(source, /deleteDialogTaskId/);
        assert.match(source, /function detailConfirmDeleteTask\(\)/);
        assert.match(source, /function detailCancelDeleteTask\(\)/);
        const deleteFunction = source.slice(source.indexOf('function detailDeleteTask'));
        assert.doesNotMatch(deleteFunction.slice(0, 700), /window\.confirm\(/);
    }
});
