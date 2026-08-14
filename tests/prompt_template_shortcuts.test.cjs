const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('both canvases expose a header target and support browse-only opening', () => {
    const classicHtml = read('static/canvas.html');
    const smartHtml = read('static/smart-canvas.html');
    const classicJs = read('static/js/canvas.js');
    const smartJs = read('static/js/smart-canvas.js');

    assert.match(classicHtml, /prompt-template-head-actions[\s\S]*id="promptTemplateTarget"[\s\S]*id="promptTemplateClose"/);
    assert.match(smartHtml, /prompt-template-head-actions[\s\S]*id="promptTemplateTarget"[\s\S]*id="promptTemplateClose"/);
    assert.match(classicJs, /function classicSelectedPromptTemplateTarget\(\)/);
    assert.match(classicJs, /ids\.length !== 1/);
    assert.match(classicJs, /\['prompt', 'generator', 'llm'\]\.includes\(node\.type\)/);
    assert.match(classicJs, /openPromptTemplateModal\(node\?\.id \|\| ''\)/);
    assert.match(classicJs, /async function openPromptTemplateModal\(nodeId=''\)/);
    assert.match(smartJs, /function smartSelectedPromptTemplateTarget\(\)/);
    assert.match(smartJs, /ids\.length !== 1/);
    assert.match(smartJs, /node\?\.type === 'smart-prompt'/);
    assert.match(smartJs, /openPromptTemplatePanel\(node\?\.id \|\| '',[\s\S]*target:node \? 'node' : 'browse'/);
});

test('T opens the prompt library while editable fields keep native typing', () => {
    for(const relative of ['static/js/canvas.js', 'static/js/smart-canvas.js']){
        const source = read(relative);
        assert.match(source, /key === 't'/);
        assert.match(source, /!isEditableTarget\(e\.target\)/);
    }
});

test('copy stays available while write, Enter, and repeated clicks require a target', () => {
    const classic = read('static/js/canvas.js');
    const smart = read('static/js/smart-canvas.js');

    for(const source of [classic, smart]){
        assert.match(source, /data-template-copy="positive"/);
        assert.match(source, /data-template-write/);
        assert.match(source, /data-template-copy="negative"/);
        assert.match(source, /copySelectedPromptTemplate/);
        assert.doesNotMatch(source, /data-template-apply="full"/);
    }
    assert.match(classic, /promptTemplateNodeId[\s\S]*data-template-write[^\n]+disabled/);
    assert.match(classic, /dataset\.lastCardId[\s\S]*if\(repeated && promptTemplateNodeId\)/);
    assert.match(smart, /canWritePromptTemplateTarget\(\)[\s\S]*data-template-write[^\n]+disabled/);
    assert.match(smart, /dataset\.lastCardId[\s\S]*if\(repeated && canWritePromptTemplateTarget\(\)\)/);
});

test('prompt-library header removes the redundant subtitle and places the library selector after search', () => {
    for(const relative of ['static/canvas.html', 'static/smart-canvas.html']){
        const source = read(relative);
        assert.match(source, /class="prompt-template-head"[\s\S]*?<strong[^>]*>提示词库<\/strong>[\s\S]*?class="prompt-template-head-actions"/);
        assert.match(source, /class="prompt-template-filter-row"[\s\S]*?class="prompt-template-search"[\s\S]*?id="promptTemplateLibrarySelect"/);
    }
    assert.doesNotMatch(read('static/canvas.html'), /data-i18n="canvas\.promptTemplateSystem"/);
    assert.doesNotMatch(read('static/smart-canvas.html'), /内置标准库 \+ 我的预设/);
});

test('prompt-library detail uses one-line metadata actions and a whole-image 240 by 200 thumbnail', () => {
    for(const relative of ['static/css/canvas.css', 'static/css/smart-canvas.css']){
        const source = read(relative);
        assert.match(source, /\.prompt-template-panel[^\n]*width:720px/);
        assert.match(source, /\.prompt-template-body[^\n]*grid-template-columns:252px minmax\(0, 1fr\)/);
        assert.match(source, /\.prompt-template-detail \.prompt-thumb-editor-preview[^\n]*width:240px[^\n]*height:200px/);
        assert.match(source, /\.prompt-template-detail \.prompt-thumb-editor-preview img[^\n]*object-fit:contain[^\n]*object-position:center/);
        assert.match(source, /\.prompt-template-head-actions/);
        assert.match(source, /\.prompt-template-detail-titleline/);
        assert.match(source, /\.prompt-template-icon-actions button[^\n]*flex-direction:row/);
    }
    for(const relative of ['static/js/canvas.js', 'static/js/smart-canvas.js']){
        const source = read(relative);
        assert.match(source, /class="prompt-template-name" title=/);
        assert.doesNotMatch(source, /class="prompt-template-source"/);
        assert.match(source, /class="prompt-template-detail-titleline"[\s\S]*?<strong>[\s\S]*?<span>[\s\S]*?prompt-template-icon-actions/);
        assert.match(source, /PromptTemplateThumbnails\?\.editor\([^\n]+layout:'canvas'/);
    }
});

test('purpose description is editable through the existing scene field in both canvases', () => {
    for(const relative of ['static/js/canvas.js', 'static/js/smart-canvas.js']){
        const source = read(relative);
        assert.match(source, /purposeEditable:editMode/);
        assert.match(source, /data-template-edit-scene/);
        assert.match(source, /querySelector\('\[data-template-edit-scene\]'\)/);
        assert.match(source, /body:JSON\.stringify\([^\n]*scene/);
    }
});

test('visible template entry labels are renamed to prompts', () => {
    const classicI18n = read('static/js/i18n/canvas.js');
    const smartI18n = read('static/js/i18n/smart-canvas.js');
    const smartJs = read('static/js/smart-canvas.js');

    assert.match(classicI18n, /"canvas\.promptTemplateShort": \{ zh: "提示词/);
    assert.match(smartI18n, /"smart\.promptTemplateLibrary": \{ zh: "提示词/);
    assert.match(smartJs, /prompt-preset-edit[^\n]+<span>提示词<\/span>/);
});
