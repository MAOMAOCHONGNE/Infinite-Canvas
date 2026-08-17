const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const ONLINE_PATH = path.join(ROOT, 'static', 'online.html');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

function loadFieldHelpers(){
    const source = fs.readFileSync(ONLINE_PATH, 'utf8');
    const block = sourceBlock(source, 'function runningHubFieldKind', 'function renderRunningHubParams');
    return new Function(`${block}\nreturn {runningHubFieldKind, runningHubFieldRole, runningHubFieldOptions, runningHubParamFields, runningHubPromptRequired};`)();
}

test('image-only RunningHub application needs no prompt and exposes its real select field', () => {
    const helpers = loadFieldHelpers();
    const entry = {
        fields: [
            {nodeId:'193', fieldName:'value', fieldType:'SELECT', label:'短边尺寸', fieldValue:'4096', options:['1024','2048','4096'], enabled:true},
            {nodeId:'187', fieldName:'image', fieldType:'IMAGE', fieldValue:'default.png', enabled:true},
        ],
    };

    assert.equal(helpers.runningHubPromptRequired(entry), false);
    const params = helpers.runningHubParamFields(entry);
    assert.equal(params.length, 1);
    assert.equal(params[0].label, '短边尺寸');
    assert.deepEqual(helpers.runningHubFieldOptions(params[0]), ['1024','2048','4096']);
});

test('prompt and media fields are excluded from the entry parameter panel', () => {
    const helpers = loadFieldHelpers();
    const entry = {
        fields: [
            {nodeId:'1', fieldName:'prompt', fieldType:'STRING', enabled:true},
            {nodeId:'2', fieldName:'image', fieldType:'IMAGE', enabled:true},
            {nodeId:'3', fieldName:'steps', fieldType:'INT', fieldValue:'20', enabled:true},
        ],
    };

    assert.equal(helpers.runningHubPromptRequired(entry), true);
    assert.deepEqual(helpers.runningHubParamFields(entry).map(field => field.fieldName), ['steps']);
});

test('online page switches RunningHub entries to their own parameters and request payload', () => {
    const source = fs.readFileSync(ONLINE_PATH, 'utf8');
    const submit = sourceBlock(source, 'async function submitImage', 'function renderImageCard');

    assert.match(source, /id="promptSection"/);
    assert.match(source, /id="sizeControls"/);
    assert.match(source, /id="runningHubParamsPanel"/);
    assert.match(source, /function currentRunningHubEntry/);
    assert.match(source, /function collectRunningHubParams/);
    assert.match(source, /function setModel\(next\)[\s\S]*updateAdaptivePanel\(\)/);
    assert.match(source, /escapeHtml\(String\(numericValue\)\)/);
    assert.match(submit, /if\(!prompt && runningHubPromptRequired\(currentRunningHubEntry\(\)\)\)/);
    assert.match(submit, /reqBody\.runninghub_params = collectRunningHubParams\(\)/);
});
