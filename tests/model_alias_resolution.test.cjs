const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const tools = require(path.join(ROOT, 'static/js/model-config.js'));

test('model display names fall back to ids and honor aliases for every model kind', () => {
    const provider = {model_names:{'image-real':'Image A', 'chat-real':'Chat A', 'video-real':'Video A'}};
    assert.equal(tools.displayName(provider, 'image-real'), 'Image A');
    assert.equal(tools.displayName(provider, 'chat-real'), 'Chat A');
    assert.equal(tools.displayName(provider, 'video-real'), 'Video A');
    assert.equal(tools.displayName(provider, 'unaliased-real'), 'unaliased-real');
});

test('resolution routing is disabled by default and exposes only configured enabled slots', () => {
    const provider = {
        image_model_resolution_maps:{
            logical:{enabled:true, models:{'1k':'real-1k', '4k':'real-4k'}},
            disabled:{enabled:false, models:{'2k':'real-2k'}},
        },
    };
    assert.equal(tools.resolutionRoutingEnabled(provider, 'missing'), false);
    assert.equal(tools.resolutionRoutingEnabled(provider, 'disabled'), false);
    assert.equal(tools.resolutionRoutingEnabled(provider, 'logical'), true);
    assert.deepEqual(tools.availableResolutions(provider, 'logical'), ['1k', '4k']);
    assert.equal(tools.effectiveModel(provider, 'logical', '4k'), 'real-4k');
    assert.equal(tools.effectiveModel(provider, 'logical', '2k'), '');
    assert.equal(tools.effectiveModel(provider, 'disabled', '2k'), 'disabled');
});

test('image parameter strategies auto-detect known families and allow a logical GPT Image override', () => {
    assert.equal(tools.imageParameterStrategy({}, 'gpt-image-2'), 'gpt-image');
    assert.equal(tools.imageParameterStrategy({}, 'nano-banana-pro'), 'banana');
    assert.equal(tools.imageParameterStrategy({}, 'unknown-image-model'), 'legacy');

    const provider = {
        model_image_strategies:{logical:'gpt-image'},
        image_model_resolution_maps:{
            logical:{enabled:true, models:{'2k':'provider-specific-image-v6'}},
        },
    };
    assert.equal(tools.imageParameterStrategy(provider, 'logical', 'provider-specific-image-v6'), 'gpt-image');
    assert.equal(tools.imageModelSupportsAutoSize(provider, 'logical', 'provider-specific-image-v6'), true);
});

test('API settings and both canvases load and use the shared model configuration helper', () => {
    const pages = [
        ['static/api-settings.html', 'static/js/api-settings.js'],
        ['static/canvas.html', 'static/js/canvas.js'],
        ['static/smart-canvas.html', 'static/js/smart-canvas.js'],
    ];
    for(const [htmlPath, scriptPath] of pages){
        const html = fs.readFileSync(path.join(ROOT, htmlPath), 'utf8');
        const source = fs.readFileSync(path.join(ROOT, scriptPath), 'utf8');
        assert.match(html, /model-config\.js\?v=[^"']+/);
        assert.match(source, /ModelConfigTools/);
    }
});

test('settings preserve aliases and expose double-click alias and image routing controls', () => {
    const source = fs.readFileSync(path.join(ROOT, 'static/js/api-settings.js'), 'utf8');
    assert.match(source, /function editModelAlias\(/);
    assert.match(source, /ondblclick="editModelAlias\('/);
    assert.match(source, /function toggleImageModelResolutionMap\(/);
    assert.match(source, /image_model_resolution_maps/);
    assert.match(source, /const modelNameMap = \{\.\.\.modelNameSource\}/);
    assert.match(source, /\{value:'gpt-image', label:'GPT Image'\}/);
    assert.match(source, /\['gpt-image','banana','legacy'\]\.includes\(strategy\)/);
});

test('both canvases use aliases and mapping-aware resolution availability', () => {
    for(const file of ['static/js/canvas.js', 'static/js/smart-canvas.js']){
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.match(source, /ModelConfigTools\.displayName/);
        assert.match(source, /ModelConfigTools\.availableResolutions/);
        assert.match(source, /ModelConfigTools\.resolutionRoutingEnabled/);
        assert.match(source, /imageModelSupportsAutoSize/);
        assert.match(source, /ratio === 'adaptive'[\s\S]*?return 'auto'/);
    }
});
