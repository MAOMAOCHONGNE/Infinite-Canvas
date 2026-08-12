const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'static', 'canvas.html');
const SOURCE_PATH = path.join(ROOT, 'static', 'js', 'canvas.js');
const CSS_PATH = path.join(ROOT, 'static', 'css', 'canvas.css');
const I18N_PATH = path.join(ROOT, 'static', 'js', 'i18n', 'canvas.js');
const GEOMETRY_PATH = path.join(ROOT, 'static', 'js', 'image-outpaint-geometry.js');
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

test('crop exposes free/source plus the requested ratios in the requested order', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const block = sourceBlock(html, 'id="imageCropTools"', 'id="imageMaskTools"');
    assert.deepEqual(presetValues(block, 'data-crop-ratio'), ['free', 'source', ...REQUESTED_RATIOS]);
});

test('outpaint exposes free plus all requested ratios and defaults to medium gray', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const block = sourceBlock(html, 'id="imageOutpaintTools"', 'id="imageMaskTools"');
    assert.deepEqual(presetValues(block, 'data-outpaint-ratio'), ['free', ...REQUESTED_RATIOS]);
    assert.match(block, /id="outpaintBackgroundColor"[^>]*type="color"[^>]*value="#808080"/);
    assert.match(block, /id="outpaintBackgroundValue"[^>]*>#808080</);
});

test('ratio outpaint creates the smallest centered canvas that fully contains the source', () => {
    const geometry = require(GEOMETRY_PATH);

    const landscape = geometry.minimumCanvasForSource(1200, 600, '2:3');
    assert.deepEqual(landscape, {x:0, y:600, w:1200, h:1800});

    const portrait = geometry.minimumCanvasForSource(310, 400, '4:3');
    assert.ok(Math.abs(portrait.w / portrait.h - 4 / 3) < 1e-12);
    assert.equal(portrait.h, 400);
    assert.equal(portrait.x, (portrait.w - 310) / 2);
    assert.equal(portrait.y, 0);
});

test('locked outpaint resize preserves ratio and never shrinks below the source', () => {
    const geometry = require(GEOMETRY_PATH);
    const start = geometry.minimumCanvasForSource(310, 400, '9:16');
    const grown = geometry.resizeCanvasAroundSource(start, 310, 400, 'right', 120, 0, '9:16');
    const shrunk = geometry.resizeCanvasAroundSource(grown, 310, 400, 'bottom', 0, -5000, '9:16');

    assert.equal(grown.w / grown.h, 9 / 16);
    assert.ok(grown.w > start.w && grown.h > start.h);
    assert.equal(shrunk.w / shrunk.h, 9 / 16);
    assert.ok(shrunk.w >= 310 && shrunk.h >= 400);
    assert.equal(shrunk.x, (shrunk.w - 310) / 2);
    assert.equal(shrunk.y, (shrunk.h - 400) / 2);
});

test('outpaint export geometry keeps an exact integer ratio and centers rounding padding', () => {
    const geometry = require(GEOMETRY_PATH);
    const rect = geometry.minimumCanvasForSource(310, 400, '4:3');
    const output = geometry.outputGeometry({
        canvasW:rect.w,
        canvasH:rect.h,
        sourceX:rect.x,
        sourceY:rect.y,
        sourceDisplayW:310,
        sourceDisplayH:400,
        naturalW:310,
        naturalH:400,
        preset:'4:3'
    });

    assert.equal(output.w / output.h, 4 / 3);
    assert.equal(output.w % 4, 0);
    assert.equal(output.h % 3, 0);
    assert.equal(output.dx, (output.w - 310) / 2);
    assert.equal(output.dy, (output.h - 400) / 2);
});

test('outpaint color is previewed and baked only by the outpaint apply path', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const i18n = fs.readFileSync(I18N_PATH, 'utf8');
    const outpaintBlock = sourceBlock(source, 'async function applyImageOutpaint()', 'async function applyImageMask()');
    const cropBlock = sourceBlock(source, 'async function applyImageCrop()', 'async function applyImageOutpaint()');

    assert.match(source, /DEFAULT_OUTPAINT_BACKGROUND\s*=\s*['"]#808080['"]/);
    assert.match(source, /cropCanvasEl\.style\.width\s*=\s*`\$\{cropState\.w\}px`/);
    assert.match(source, /cropCanvasEl\.style\.height\s*=\s*`\$\{cropState\.h\}px`/);
    assert.match(source, /--outpaint-background/);
    assert.match(outpaintBlock, /ctx\.fillStyle\s*=\s*outpaintBackgroundColor/);
    assert.doesNotMatch(outpaintBlock, /ctx\.fillStyle\s*=\s*['"]#ffffff['"]/);
    assert.doesNotMatch(cropBlock, /outpaintBackgroundColor/);
    assert.match(css, /background:\s*var\(--outpaint-background,\s*#808080\)/);
    assert.match(i18n, /canvas\.outpaintHint[^\n]+自定义空白区域背景色/);
    assert.doesNotMatch(i18n, /canvas\.outpaintHint[^\n]+填充白色/);
});
