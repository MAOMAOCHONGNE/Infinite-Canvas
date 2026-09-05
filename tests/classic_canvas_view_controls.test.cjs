const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'static/js/canvas.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'static/canvas.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'static/css/canvas.css'), 'utf8');

test('classic canvas exposes the four view controls below the minimap', () => {
    for(const id of ['canvasViewControls','minimapToggle','canvasGridSnapToggle','canvasFitViewBtn','canvasZoomBtn','canvasZoomMenu','canvasZoomCustomForm']){
        assert.match(html, new RegExp(`id="${id}"`), `missing ${id}`);
    }
    for(const percent of [25,34,50,67,100,150,200]){
        assert.match(html, new RegExp(`data-canvas-zoom="${percent}"`), `missing ${percent}% preset`);
    }
    assert.match(html, /id="canvasZoomInput"[^>]*min="6"[^>]*max="800"/);
    assert.match(css, /\.canvas-view-controls/);
    assert.match(css, /\.minimap\s*\{[^}]*bottom:68px/);
});

test('view preferences are local per canvas and default to visible minimap with snapping off', () => {
    assert.match(source, /classicCanvasViewPreferences:v1/);
    assert.match(source, /minimapVisible:item\?\.minimapVisible !== false/);
    assert.match(source, /gridSnapEnabled:item\?\.gridSnapEnabled === true/);
    assert.match(source, /localStorage\.setItem\(CANVAS_VIEW_PREFERENCES_KEY/);
    assert.match(source, /loadCanvasViewPreferences\(open \? canvas\?\.id : ''\)/);
});

test('zoom control clamps to 6%-800% and preserves the viewport center', () => {
    assert.match(source, /const nextScale = Math\.max\(0\.06, Math\.min\(8, Number\(percent\) \/ 100\)\)/);
    assert.match(source, /const before = screenToWorld\(boardRect\.left \+ center\.x, boardRect\.top \+ center\.y\)/);
    assert.match(source, /viewport\.x = center\.x - before\.x \* viewport\.scale/);
    assert.match(source, /viewport\.y = center\.y - before\.y \* viewport\.scale/);
    assert.match(source, /scale:Number\.isFinite\(Number\(item\.scale\)\) \? Math\.max\(\.06, Math\.min\(8/);
});

test('grid snapping preserves group offsets and keeps existing Alt duplicate behavior when snapping is off', () => {
    assert.match(source, /const CANVAS_GRID_SNAP_SIZE = 24/);
    assert.match(source, /function canvasSnapCoordinate\(value\)/);
    assert.match(source, /canvasGridSnapIsEnabled\(\) && !e\.altKey/);
    assert.match(source, /dx = canvasSnapCoordinate\(dragNode\.ox \+ dx\) - dragNode\.ox/);
    assert.match(source, /dy = canvasSnapCoordinate\(dragNode\.oy \+ dy\) - dragNode\.oy/);
    assert.match(source, /const bypassGridSnap = Boolean\(\s*e\.altKey\s*&&\s*typeof canvasGridSnapIsEnabled === 'function'\s*&&\s*canvasGridSnapIsEnabled\(\)\s*\)/);
    assert.match(source, /if\(e\.altKey && !bypassGridSnap\)/);
});

test('hidden minimap skips rendering but leaves view controls and viewport behavior active', () => {
    assert.match(source, /if\(!canvasMinimapIsVisible\(\)\) return;/);
    assert.match(source, /if\(minimapVisible && !minimapRenderQueued\)/);
    assert.match(source, /canvasViewControls\.hidden = !available/);
    assert.match(source, /#canvasViewControls/);
});

test('view controls do not enter zoom-preview or board-pan paths', () => {
    assert.match(source, /isZoomPreviewIgnoredTarget[\s\S]*#canvasViewControls/);
    assert.match(source, /startBoardPan[\s\S]*#canvasViewControls/);
    assert.match(source, /canvasViewControls\?\.addEventListener\('mousedown'/);
});
