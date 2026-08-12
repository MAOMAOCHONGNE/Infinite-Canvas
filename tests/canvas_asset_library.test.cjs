const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'static', 'canvas.html');
const SOURCE_PATH = path.join(ROOT, 'static', 'js', 'canvas.js');
const CSS_PATH = path.join(ROOT, 'static', 'css', 'canvas.css');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

test('classic plain A toggles assets outside editable targets and ignores repeat', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const block = sourceBlock(source, "window.addEventListener('keydown'", "window.addEventListener('keyup'");

    assert.match(block, /!e\.ctrlKey\s*&&\s*!e\.metaKey\s*&&\s*!e\.altKey/);
    assert.match(block, /key\s*===\s*'a'/);
    assert.match(block, /!isEditableTarget\(e\.target\)/);
    assert.match(block, /if\(e\.repeat\) return/);
    assert.match(block, /toggleCanvasAssetLibrary\(\)/);
});

test('ordinary Image preview emits an asset-save drag without removing node move or resize', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const imageBlock = sourceBlock(source, "if(node.type === 'image') {", "if(node.type === 'prompt')");
    const renderTail = sourceBlock(source, "el.querySelector('.node-head').onmousedown", 'function bindOutputWrap');

    assert.match(imageBlock, /draggable="true"/);
    assert.match(imageBlock, /bindCanvasAssetSaveDragSource\(loadedImg/);
    assert.match(imageBlock, /url:node\.url/);
    assert.doesNotMatch(imageBlock, /node\.url\s*=/);
    assert.match(renderTail, /startNodeDrag\(e, node\)/);
    assert.match(renderTail, /startNodeResize\(e, node\)/);
});

test('ordinary images and Output results share an asset payload while Output compatibility remains', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const payloadBlock = sourceBlock(source, 'function setCanvasAssetSaveDragData', 'function bindCanvasAssetSaveDragSource');
    const outputBlock = sourceBlock(source, 'function bindOutputWrap', 'function outputDomKeyForItem');

    assert.match(payloadBlock, /application\/x-canvas-asset-save/);
    assert.match(payloadBlock, /application\/x-canvas-output-image/);
    assert.match(payloadBlock, /text\/uri-list/);
    assert.match(payloadBlock, /text\/plain/);
    assert.match(outputBlock, /setCanvasAssetSaveDragData/);
    assert.match(outputBlock, /legacyOutput:true/);
    assert.match(outputBlock, /openOutputLightbox/);
});

test('asset drop zone recognizes custom drags and keeps highlight lifecycle visible', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const dropBlock = sourceBlock(source, 'function hasCanvasAssetSaveDrop', 'gateAssetManagerBtn?.addEventListener');
    const css = fs.readFileSync(CSS_PATH, 'utf8');

    assert.match(dropBlock, /application\/x-canvas-asset-save/);
    assert.match(dropBlock, /addEventListener\('dragenter'/);
    assert.match(dropBlock, /addEventListener\('dragover'/);
    assert.match(dropBlock, /classList\.add\('drag-over'\)/);
    assert.match(dropBlock, /classList\.remove\('drag-over'\)/);
    assert.match(css, /\.canvas-asset-drop\.drag-over\s*\{/);
});

test('asset panel provides a visible live success and failure status region', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const statusBlock = sourceBlock(source, 'function showCanvasAssetStatus', 'function canvasAssetLibraries');

    assert.match(html, /id="canvasAssetStatus"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(css, /\.canvas-asset-status\s*\{/);
    assert.match(css, /\.canvas-asset-status\.success\s*\{/);
    assert.match(css, /\.canvas-asset-status\.error\s*\{/);
    assert.match(statusBlock, /statusEl\.hidden\s*=\s*!text/);
    assert.match(statusBlock, /statusEl\.classList\.toggle\('success'/);
    assert.match(statusBlock, /statusEl\.classList\.toggle\('error'/);
});

test('asset uploads reject non-OK and empty responses instead of failing silently', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const uploadBlock = sourceBlock(source, 'async function uploadFilesToLibrary', 'function openAssetManager');
    const dropBlock = sourceBlock(source, "canvasAssetDropZone?.addEventListener('drop'", 'gateAssetManagerBtn?.addEventListener');

    assert.ok((uploadBlock.match(/if\(!\w+\.ok\)/g) || []).length >= 2);
    assert.match(uploadBlock, /responseErrorMessage/);
    assert.match(uploadBlock, /if\(!items\.length\) throw new Error/);
    assert.match(dropBlock, /showCanvasAssetStatus\([^)]*,\s*'success'\)/);
    assert.match(dropBlock, /showCanvasAssetStatus\([^)]*,\s*'error'\)/);
});
