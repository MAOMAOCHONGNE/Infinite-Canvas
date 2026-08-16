const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function cssRule(source, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `missing CSS rule: ${selector}`);
    return match[1];
}

test('classic canvas uses an arrow while idle and a closed hand only during board panning', () => {
    const css = read('static/css/canvas.css');
    const script = read('static/js/canvas.js');
    const idle = cssRule(css, '.board');

    assert.match(idle, /cursor\s*:\s*default\s*;/);
    assert.doesNotMatch(idle, /cursor\s*:\s*grab\s*;/);
    assert.match(css, /body\.canvas-board-pan[^}]*cursor\s*:\s*grabbing\s*!important/);
    assert.match(script, /document\.body\.classList\.add\('canvas-board-pan'\)/);
    assert.match(script, /classList\.remove\([^)]*'canvas-board-pan'/);
});

test('smart canvas uses an arrow while idle and a closed hand only during shell panning', () => {
    const css = read('static/css/smart-canvas.css');
    const script = read('static/js/smart-canvas.js');
    const idle = cssRule(css, '.shell');
    const active = cssRule(css, '.shell.panning');

    assert.match(idle, /cursor\s*:\s*default\s*;/);
    assert.doesNotMatch(idle, /cursor\s*:\s*grab\s*;/);
    assert.match(active, /cursor\s*:\s*grabbing\s*;/);
    assert.match(script, /shell\.classList\.add\('panning'\)/);
    assert.match(script, /shell\.classList\.remove\('panning'\)/);
});
