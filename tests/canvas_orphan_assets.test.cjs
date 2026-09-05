const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PYTHON_PATH = path.join(ROOT, 'main.py');
const HTML_PATH = path.join(ROOT, 'static', 'asset-manager.html');
const SOURCE_PATH = path.join(ROOT, 'static', 'js', 'asset-manager.js');
const CSS_PATH = path.join(ROOT, 'static', 'css', 'asset-manager.css');

test('canvas orphan batch deletion uses the Windows Recycle Bin without direct unlinking', () => {
    const source = fs.readFileSync(PYTHON_PATH, 'utf8');
    assert.match(source, /@app\.get\("\/api\/canvas-assets\/orphans"\)[\s\S]*?status_code=410/);
    assert.match(source, /@app\.post\("\/api\/canvas-assets\/orphans\/delete"\)[\s\S]*?CanvasAssetDeleteRequest/);
    const retired = source.slice(
        source.indexOf('@app.get("/api/canvas-assets/orphans")'),
        source.indexOf('@app.get("/api/smart-canvas/prompt-templates")'),
    );
    assert.doesNotMatch(retired, /os\.remove\(/);
    assert.match(retired, /canvas_assets_index_cached/);
    assert.match(retired, /storage_cleanup\.move_paths_to_recycle_bin/);
});

test('asset manager renders the orphan category with recycle-bin batch deletion', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    assert.match(html, /id="assetStatus"[^>]*>已就绪</);
    assert.match(source, /setStatus\('已就绪'\)/);
    assert.doesNotMatch(source, /setStatus\('准备就绪'\)/);
    assert.match(html, /id="storageCleanupBtn"[\s\S]*?data-lucide="hard-drive-download"[\s\S]*?<span>存储清理<\/span>/);
    assert.match(source, /orphanItems:Array\.isArray\(data\?\.orphan_items\)/);
    assert.match(source, /\['smart','classic','orphan'\]/);
    assert.match(source, /data-canvas-asset-cat="orphan"|cat\.id === 'orphan'/);
    assert.match(source, /未属于当前画布/);
    assert.match(source, /data-canvas-asset-delete-selected/);
    assert.match(source, /apiJson\('\/api\/canvas-assets\/orphans\/delete/);
    assert.match(source, /Windows 回收站/);
    assert.doesNotMatch(source, /data-canvas-asset-delete="/);
    const deleteStart = source.indexOf('async function deleteSelectedCanvasAssetsToRecycleBin');
    const deleteEnd = source.indexOf('\nfunction assetDownloadName', deleteStart);
    assert.ok(deleteStart >= 0 && deleteEnd > deleteStart);
    const deleteBlock = source.slice(deleteStart, deleteEnd);
    assert.doesNotMatch(deleteBlock, /pendingBatchDelete|再次点击确认/);
    assert.doesNotMatch(deleteBlock, /refreshCanvasAssets/);
});

test('asset manager renders its core tabs before the slow canvas asset scan finishes', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const start = source.indexOf('async function loadAll()');
    const end = source.indexOf('\nfunction render()', start);
    assert.ok(start >= 0 && end > start);
    const block = source.slice(start, end);
    assert.doesNotMatch(block, /apiJson\('\/api\/canvas-assets'\)/);
    assert.match(block, /refreshCanvasAssets\(\{announce:false\}\)/);
    assert.match(source, /canvasAssetsLoading/);
});

test('storage cleanup uses one protected scan, migration preview, and background recycle confirmation', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const backend = fs.readFileSync(PYTHON_PATH, 'utf8');
    const start = source.indexOf('function renderStorageCleanupDialog()');
    const end = source.indexOf('\nfunction ', start + 10);
    assert.ok(start >= 0 && end > start);
    const block = source.slice(start, end);
    assert.match(block, /扫描可清理文件/);
    assert.match(block, /旧版来源未标记文件/);
    assert.match(block, /上传参考图/);
    assert.match(block, /候选文件示例/);
    assert.match(block, /案例/);
    assert.match(block, /确认后台清理/);
    assert.match(block, /Windows 回收站/);
    assert.match(source, /\/api\/storage-cleanup\/preview/);
    assert.match(source, /\/api\/storage-cleanup\/confirm/);
    assert.match(backend, /commit_to_recycle_bin\(\)/);
    assert.match(backend, /@app\.post\("\/api\/storage-cleanup\/confirm", status_code=202\)/);
    assert.match(source, /data-storage-cleanup-confirm/);
    assert.match(block, /全部文件/);
    assert.match(block, /可释放/);
    assert.match(source, /storage-cleanup\/jobs/);
    assert.doesNotMatch(block, /永久删除/);
    assert.doesNotMatch(block, /24 小时|保护期/);
    assert.doesNotMatch(block, /confirm\(|alert\(|prompt\(/);
});

test('storage cleanup dialog has responsive focus-visible styling', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    assert.match(css, /\.storage-cleanup-overlay/);
    assert.match(css, /\.storage-cleanup-modal/);
    assert.match(css, /\.storage-cleanup-action/);
    assert.match(css, /\.storage-cleanup-confirm/);
    assert.match(css, /storage-cleanup[^}]*:focus-visible|focus-visible[^}]*storage-cleanup/);
    assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?storage-cleanup/);
});
