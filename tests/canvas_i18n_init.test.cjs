const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'canvas.js'), 'utf8');

test('classic canvas applies translations only after canvas state is initialized', () => {
    const canvasState = source.indexOf('let canvas = null;');
    assert.ok(canvasState > 0, 'classic canvas state declaration is missing');
    assert.doesNotMatch(source.slice(0, canvasState), /StudioI18n\?\.apply\?\.\(\)|StudioI18n\.apply\(\)/);
    assert.match(source.slice(canvasState), /StudioI18n\.apply\(\)/);
});
