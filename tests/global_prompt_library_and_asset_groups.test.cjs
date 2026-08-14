const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('classic canvas creates real folders for the local-material source', () => {
    const source = read('static/js/canvas.js');
    assert.doesNotMatch(source, /canvasAssetAddCategoryBtn\.disabled = localMode/);
    assert.match(source, /canvasAssetLibraryIsLocal\(\)[\s\S]*?fetch\('\/api\/local-assets\/folders'/);
    assert.match(source, /body:JSON\.stringify\(\{parent,\s*name:/);
    assert.match(source, /localCanvasAssetLibrary = \{items:Array\.isArray\(data\.items\)/);
    assert.match(source, /activeCanvasAssetCategoryId = data\.folder\?\.path/);
});

test('the default asset library is visibly named role material library everywhere', () => {
    const backend = read('main.py');
    assert.match(backend, /"id": "default", "name": "角色素材库"/);
    assert.match(backend, /library\.get\("id"\) == "default"[\s\S]*?library\["name"\] = "角色素材库"/);
    for(const relative of ['static/js/canvas.js', 'static/js/smart-canvas.js', 'static/js/asset-manager.js']){
        const source = read(relative);
        assert.doesNotMatch(source, /默认资产库/);
        assert.match(source, /角色素材库/);
    }
});

test('non-canvas application pages load the global prompt-library launcher', () => {
    const pages = [
        'static/index.html',
        'static/zimage.html',
        'static/enhance.html',
        'static/klein.html',
        'static/angle.html',
        'static/online.html',
        'static/gpt-chat.html',
        'static/asset-manager.html',
        'static/api-settings.html',
        'static/comfyui-settings.html',
        'static/canvas-list.html',
    ];
    for(const relative of pages){
        assert.match(read(relative), /\/static\/js\/global-prompt-library\.js\?v=/, relative);
    }
});

test('global T opens a browse-and-copy prompt library without stealing input', () => {
    const source = read('static/js/global-prompt-library.js');
    assert.match(source, /\/api\/prompt-libraries/);
    assert.match(source, /event\.key\.toLowerCase\(\) !== 't'/);
    assert.match(source, /isEditableTarget\(event\.target\)/);
    assert.match(source, /event\.ctrlKey \|\| event\.metaKey \|\| event\.altKey \|\| event\.shiftKey/);
    assert.match(source, /复制提示词/);
    assert.match(source, /navigator\.clipboard/);
    assert.doesNotMatch(source, /promptTemplateNodeId|selectedNodeIds|写入到/);
});

test('global prompt detail renders the saved thumbnail with a safe fallback', () => {
    const source = read('static/js/global-prompt-library.js');
    assert.match(source, /global-prompt-library-detail-thumb/);
    assert.match(source, /selected\.thumbnail/);
    assert.match(source, /onerror="this\.hidden=true;this\.nextElementSibling\.hidden=false"/);
    assert.match(source, /width:240px[^\n]*height:200px[^\n]*object-fit:cover/);
});
