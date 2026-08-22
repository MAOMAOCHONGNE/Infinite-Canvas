const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const classic = fs.readFileSync(path.join(root, 'static/js/canvas.js'), 'utf8');
const smart = fs.readFileSync(path.join(root, 'static/js/smart-canvas.js'), 'utf8');
const classicHtml = fs.readFileSync(path.join(root, 'static/canvas.html'), 'utf8');
const smartHtml = fs.readFileSync(path.join(root, 'static/smart-canvas.html'), 'utf8');
const classicCss = fs.readFileSync(path.join(root, 'static/css/canvas.css'), 'utf8');
const smartCss = fs.readFileSync(path.join(root, 'static/css/smart-canvas.css'), 'utf8');

test('classic and smart canvases expose a sticky-note creator with the agreed eye-comfort defaults', () => {
    for(const source of [classic, smart]){
        assert.match(source, /type:'(?:note|smart-note)'/);
        assert.match(source, /text:'新建便签'/);
        assert.match(source, /fontSize:36/);
        assert.match(source, /textColor:'#ffffff'/);
        assert.match(source, /backgroundColor:'#a86e25'/i);
    }
});

test('both creation menus include a visual-only sticky-note entry', () => {
    assert.match(classic, /FavoriteNodes\.blankCanvasTypes\(\)[\s\S]*?setQuickCreateMenu\(createMenu/);
    assert.match(classic, /if\(type === 'note'\) addNoteNode\(menuPoint\)/);
    assert.match(smartHtml, /data-create-type="note"/);
    assert.match(smartHtml, /便签/);
});

test('sticky notes have editable text and explicit font/background controls in both renderers', () => {
    for(const source of [classic, smart]){
        assert.match(source, /note-text/);
        assert.match(source, /data-note-font-size/);
        assert.match(source, /data-note-text-color/);
        assert.match(source, /data-note-background-color/);
    }
});

test('sticky notes are sized visual nodes and do not appear in execution-only node type lists', () => {
    assert.match(classic, /if\(type === 'note'\) return \{w:360, h:260\}/);
    assert.match(smart, /type:'smart-note'[\s\S]{0,220}w:360[\s\S]{0,120}h:260/);
    const classicPortTypes = classic.match(/const canOutput = \[[^\]]+\]\.includes\(node\.type\);/);
    assert.ok(classicPortTypes, 'classic canvas should explicitly list output-capable nodes');
    assert.doesNotMatch(classicPortTypes[0], /'note'/);
    assert.doesNotMatch(smart, /isSmartRunnableNode\(node\)[\s\S]{0,180}smart-note/);
});

test('both canvases style notes with a selectable visual surface rather than an execution port card', () => {
    assert.match(classicCss, /\.note-node/);
    assert.match(smartCss, /\.image-node\.note-smart-node/);
});
