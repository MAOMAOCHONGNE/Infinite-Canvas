const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas-list.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'static', 'canvas-list.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'static', 'css', 'canvas-list.css'), 'utf8');

test('empty-board create card hides the hint, can be dragged, and persists its dragged position', () => {
    assert.match(source, /syncBoardEmptyState\(\)/);
    assert.match(source, /!isEmpty \|\| !!createCardEl/);
    assert.match(source, /attachCreateCardDrag\(el\)/);
    assert.match(source, /createCanvasOnBoard\(input\.value\.trim\(\), createKind, \{ \.\.\.createCardWorldPt \}\)/);
    assert.match(css, /\.ws-create-head[^}]*cursor:grab/);
});

test('workspace cards expose automatic, selected, and uploaded cover controls', () => {
    assert.match(source, /canvasCoverPreviewUrl/);
    assert.match(source, /data-act="cover"/);
    assert.match(source, /\/cover-options/);
    assert.match(source, /cover_mode:'auto'/);
    assert.match(source, /\/cover-upload/);
    assert.match(html, /id="coverModal"/);
    assert.match(html, /id="coverFileInput"/);
    assert.match(css, /\.ws-card-cover/);
    assert.match(css, /\.cover-grid/);
    assert.match(source, /draggable="false"/);
    assert.match(source, /coverImage\.ondragstart = event => event\.preventDefault\(\)/);
    assert.match(css, /\.ws-card-cover img[^}]*pointer-events:none[^}]*-webkit-user-drag:none/);
});
