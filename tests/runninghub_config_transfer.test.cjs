const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const TRANSFER_MODULE = path.join(ROOT, 'static', 'js', 'runninghub-config-transfer.js');
const transfer = require(TRANSFER_MODULE);

function workflowFixture(overrides={}){
    return {
        id:'2085314308715667457',
        workflowId:'2085314308715667457',
        title:'放大呀',
        note:'测试工作流',
        thumbnail:'data:image/jpeg;base64,DO_NOT_EXPORT',
        raw:{apiKey:'DO_NOT_EXPORT', response:'temporary'},
        fields:[
            {nodeId:'187', fieldName:'image', fieldValue:'pasted/example.png', fieldType:'IMAGE', enabled:true},
            {nodeId:'999', fieldName:'api_key', fieldValue:'DO_NOT_EXPORT', fieldType:'TEXT', enabled:true}
        ],
        workflowJson:{
            '187':{class_type:'LoadImage', inputs:{image:'pasted/example.png'}},
            compare:{inputs:{url:'/view?filename=a.jpg&Rh-Comfy-Auth=secret-token&Rh-Identify=user-id'}},
            embedded:'data:image/png;base64,DO_NOT_EXPORT'
        },
        optionalImageMode:'prune-workflow',
        ...overrides
    };
}

test('portable export excludes thumbnails, raw responses, credentials, and image binaries', () => {
    const payload = transfer.buildExport({workflows:[workflowFixture()]});
    const encoded = JSON.stringify(payload);

    assert.equal(payload.format, transfer.FORMAT);
    assert.equal(payload.workflows.length, 1);
    assert.equal(payload.workflows[0].thumbnail, undefined);
    assert.equal(payload.workflows[0].raw, undefined);
    assert.doesNotMatch(encoded, /DO_NOT_EXPORT|Rh-Comfy-Auth|Rh-Identify|secret-token|user-id/);
    assert.match(encoded, /pasted\/example\.png/);
});

test('export and import preserve runnable app/workflow configuration and order', () => {
    const payload = transfer.buildExport({
        apps:[{id:'1997622492837646338', title:'光线迁移', fields:[{nodeId:'1', fieldName:'prompt', fieldValue:'光线', enabled:true}]}],
        workflows:[workflowFixture({sortOrder:4})],
        scope:'all'
    });
    const parsed = transfer.parseImport(JSON.stringify(payload));

    assert.equal(parsed.apps[0].appId, '1997622492837646338');
    assert.equal(parsed.apps[0].fields[0].fieldValue, '光线');
    assert.equal(parsed.workflows[0].workflowId, '2085314308715667457');
    assert.equal(parsed.workflows[0].workflowJson['187'].inputs.image, 'pasted/example.png');
    assert.equal(parsed.workflows[0].sortOrder, 4);
});

test('import overwrite preserves the recipient thumbnail while skip leaves the current entry untouched', () => {
    const existing = {
        apps:[{id:'app-1', appId:'app-1', title:'旧名称', thumbnail:'/local.jpg', fields:[]}],
        workflows:[]
    };
    const imported = transfer.parseImport(transfer.buildExport({
        apps:[{id:'app-1', title:'新名称', fields:[]}],
        scope:'single'
    }));

    const skipped = transfer.mergeConfig(existing, imported, {overwrite:false});
    assert.equal(skipped.apps.entries[0].title, '旧名称');
    assert.deepEqual(skipped.apps.skippedIds, ['app-1']);

    const overwritten = transfer.mergeConfig(existing, imported, {overwrite:true});
    assert.equal(overwritten.apps.entries[0].title, '新名称');
    assert.equal(overwritten.apps.entries[0].thumbnail, '/local.jpg');
});

test('drag reorder supports insertion before and after a target and rewrites sortOrder', () => {
    const entries = ['A','B','C'].map((id, index) => ({id, sortOrder:index}));
    const before = transfer.reorderEntries(entries, 1, 0, false);
    const after = transfer.reorderEntries(entries, 0, 2, true);

    assert.deepEqual(before.map(entry => entry.id), ['B','A','C']);
    assert.deepEqual(after.map(entry => entry.id), ['B','C','A']);
    assert.deepEqual(before.map(entry => entry.sortOrder), [0,1,2]);
});

test('full import applies exported ordering only when same-ID entries are overwritten', () => {
    const existing = {
        apps:[{id:'A', title:'old A'}, {id:'B', title:'old B'}],
        workflows:[]
    };
    const imported = transfer.parseImport(transfer.buildExport({
        apps:[{id:'B', title:'new B'}, {id:'A', title:'new A'}],
        scope:'all'
    }));

    const skipped = transfer.mergeConfig(existing, imported, {overwrite:false});
    const overwritten = transfer.mergeConfig(existing, imported, {overwrite:true});
    assert.deepEqual(skipped.apps.entries.map(entry => entry.id), ['A','B']);
    assert.deepEqual(overwritten.apps.entries.map(entry => entry.id), ['B','A']);
});

test('settings page wires transfer controls, per-card export, and persistent drag order', () => {
    const html = fs.readFileSync(path.join(ROOT, 'static', 'api-settings.html'), 'utf8');
    const source = fs.readFileSync(path.join(ROOT, 'static', 'js', 'api-settings.js'), 'utf8');
    const backend = fs.readFileSync(path.join(ROOT, 'main.py'), 'utf8');

    assert.match(html, /runninghub-config-transfer\.js[^]*api-settings\.js/);
    assert.match(html, /importRunningHubConfig\(\)/);
    assert.match(html, /exportRunningHubConfig\(\)/);
    assert.match(source, /startRhEntryDrag/);
    assert.match(source, /dropRhEntryDrag/);
    assert.match(source, /saveImportedRunningHubWorkflows/);
    assert.match(source, /title="导出这个配置"/);
    assert.match(backend, /entry\["sortOrder"\]/);
    assert.match(backend, /return sorted\(merged, key=lambda entry: int\(entry\.get\("sortOrder", 0\)\)\)/);
});
