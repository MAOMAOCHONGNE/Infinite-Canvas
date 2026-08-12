const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'static', 'smart-canvas.html');
const SOURCE_PATH = path.join(ROOT, 'static', 'js', 'smart-canvas.js');
const CSS_PATH = path.join(ROOT, 'static', 'css', 'smart-canvas.css');
const REQUESTED_RATIOS = [
    '1:1', '2:3', '3:2', '3:4', '4:3', '4:5',
    '5:4', '9:16', '16:9', '21:9', '9:21'
];

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

function presetValues(block, attribute){
    return [...block.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'g'))].map(match => match[1]);
}

test('smart crop exposes free/source plus the requested ratios in order', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const block = sourceBlock(html, 'id="imageCropTools"', 'id="imagePreviewTools"');
    assert.deepEqual(presetValues(block, 'data-crop-ratio'), ['free', 'source', ...REQUESTED_RATIOS]);
});
test('smart outpaint exposes free plus all requested ratios and medium-gray color control', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const block = sourceBlock(html, 'id="imageOutpaintTools"', 'id="imagePreviewTools"');
    assert.deepEqual(presetValues(block, 'data-outpaint-ratio'), ['free', ...REQUESTED_RATIOS]);
    assert.match(block, /id="outpaintBackgroundColor"[^>]*type="color"[^>]*value="#808080"/);
    assert.match(block, /id="outpaintBackgroundValue"[^>]*>#808080</);
});

test('smart page loads the shared geometry helper before its controller', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const helperAt = html.indexOf('/static/js/image-outpaint-geometry.js');
    const controllerAt = html.indexOf('/static/js/smart-canvas.js');
    assert.ok(helperAt >= 0 && controllerAt > helperAt);
});

test('smart controller keeps independent outpaint state and reuses locked geometry', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const stateBlock = sourceBlock(source, 'let cropState = null', 'let imageEditMode =');
    const resizeBlock = sourceBlock(source, 'function resizeOutpaintFromDrag', 'function clampAspectCropToBounds');
    const modeBlock = sourceBlock(source, 'function setImageEditMode', 'let previewCompareOn');

    assert.match(stateBlock, /DEFAULT_OUTPAINT_BACKGROUND\s*=\s*['"]#808080['"]/);
    assert.match(stateBlock, /outpaintAspectPreset\s*=\s*['"]free['"]/);
    assert.match(stateBlock, /outpaintAspectRatio\s*=\s*null/);
    assert.match(modeBlock, /imageOutpaintTools[^\n]+imageEditMode\s*===\s*['"]outpaint['"]/);
    assert.match(resizeBlock, /ImageOutpaintGeometry\.resizeCanvasAroundSource/);
});

test('smart outpaint previews and exports the selected color with exact shared output geometry', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const applyBlock = sourceBlock(source, 'async function applyImageOutpaint()', 'async function applyImageMask()');

    assert.match(source, /function currentOutpaintOutputGeometry/);
    assert.match(source, /ImageOutpaintGeometry\.outputGeometry/);
    assert.match(source, /--outpaint-background/);
    assert.match(applyBlock, /currentOutpaintOutputGeometry\(\)/);
    assert.match(applyBlock, /ctx\.fillStyle\s*=\s*outpaintBackgroundColor/);
    assert.doesNotMatch(applyBlock, /ctx\.fillStyle\s*=\s*['"]#ffffff['"]/);
    assert.match(css, /background:\s*var\(--outpaint-background,\s*#808080\)/);
});

test('smart apply retains output-size persistence and uses a color-neutral follow-up prompt', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const applyBlock = sourceBlock(source, 'async function applyImageOutpaint()', 'async function applyImageMask()');

    assert.match(applyBlock, /applyOutpaintSizeToSmartParams\(outW,\s*outH\)/);
    assert.match(applyBlock, /solid-color padding/i);
    assert.doesNotMatch(applyBlock, /white area/i);
});
