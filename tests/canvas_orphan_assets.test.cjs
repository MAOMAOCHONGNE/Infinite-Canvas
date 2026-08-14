const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PYTHON_PATH = path.join(ROOT, 'main.py');
const SOURCE_PATH = path.join(ROOT, 'static', 'js', 'asset-manager.js');

test('orphan asset index protects references from recycle-bin canvases', () => {
    const source = fs.readFileSync(PYTHON_PATH, 'utf8');
    const start = source.indexOf('def canvas_orphan_assets_index():');
    const end = source.indexOf('\ndef display_title', start);
    assert.ok(start >= 0 && end > start);
    const block = source.slice(start, end);
    assert.doesNotMatch(block, /if\s+canvas\.get\("deleted_at"\)\s*:\s*\n\s*continue/);
    assert.match(block, /iter_canvas_asset_values/);
    assert.match(block, /OUTPUT_OUTPUT_DIR/);
    assert.match(block, /OUTPUT_INPUT_DIR/);
});

test('orphan assets have a read-only list endpoint and guarded delete endpoint', () => {
    const source = fs.readFileSync(PYTHON_PATH, 'utf8');
    assert.match(source, /@app\.get\("\/api\/canvas-assets\/orphans"\)/);
    assert.match(source, /@app\.post\("\/api\/canvas-assets\/orphans\/delete"\)/);
    assert.match(source, /allowed = \{str\(item\.get\("url"\)/);
    assert.match(source, /os\.remove\(path\)/);
});

test('canvas asset manager exposes orphan category and confirmation delete actions', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    assert.match(source, /id:'orphans', name:'孤立素材'/);
    assert.match(source, /apiJson\('\/api\/canvas-assets\/orphans'\)/);
    assert.match(source, /data-canvas-orphan-delete-selected/);
    assert.match(source, /data-canvas-orphan-delete-one/);
    assert.match(source, /confirm\(/);
    assert.match(source, /\/api\/canvas-assets\/orphans\/delete/);
});
