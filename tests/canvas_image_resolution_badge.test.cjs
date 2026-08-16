const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('classic image nodes show their original resolution on hover or selection', () => {
    const script = read('static/js/canvas.js');
    const css = read('static/css/canvas.css');

    assert.match(script, /function canvasImageResolutionLabel\(node\)/);
    assert.match(script, /node\?\.natural_w/);
    assert.match(script, /node\?\.natural_h/);
    assert.match(script, /canvasImageResolutionBadgeHtml\(node\)/);
    assert.match(script, /updateCanvasImageResolutionBadge\(nodeEl, node\)/);
    assert.match(css, /\.image-preview-wrap:hover \.canvas-image-resolution-badge/);
    assert.match(css, /\.image-node\.selected \.canvas-image-resolution-badge/);
    assert.match(css, /body\.canvas-node-drag \.canvas-image-resolution-badge[^}]*opacity\s*:\s*0\s*!important/);
});

test('classic output images measure once on hover and cache their original resolution', () => {
    const script = read('static/js/canvas.js');
    const css = read('static/css/canvas.css');

    assert.match(script, /const canvasOutputImageDimensionRequests = new Map\(\)/);
    assert.match(script, /function ensureOutputImageResolution\(wrap, node\)/);
    assert.match(script, /wrap\.addEventListener\('mouseenter', \(\) => ensureOutputImageResolution\(wrap, node\)/);
    assert.match(script, /natural_w:size\.w, natural_h:size\.h/);
    assert.match(script, /outputImageResolutionBadgeHtml\(meta\)/);
    assert.match(css, /\.output-img-wrap:hover \.output-image-resolution-badge/);
    assert.doesNotMatch(css, /\.output-node\.selected \.output-image-resolution-badge/);
});
