const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const JS_PATH = path.join(ROOT, 'static', 'js', 'canvas.js');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

function runningHubNodeInfoBuilder(){
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const valueBlock = sourceBlock(source, 'function rhFieldValue', 'function rhRequiredLabel');
    const buildBlock = sourceBlock(source, 'async function rhBuildNodeInfoList', 'async function runRhNode');
    return new Function(
        'rhParamKey', 'rhFieldKind', 'rhFieldIndexes', 'rhActiveFields', 'rhCurrentKind',
        'rhDefaultValue', 'rhRandomEnabled', 'rhRandomActive', 'comfyRandomValue',
        'rhFieldRole', 'rhMediaSources', 'rhUploadValueIfNeeded',
        `${valueBlock}\n${buildBlock}\nreturn rhBuildNodeInfoList;`,
    )(
        (nodeId, fieldName) => `${nodeId}::${fieldName}`,
        field => ['INT', 'INTEGER', 'NUMBER', 'FLOAT'].includes(String(field?.fieldType || '').toUpperCase()) ? 'number' : 'text',
        () => ({}),
        node => node.fields || [],
        node => node.rhMode || 'app',
        field => field?.fieldValue ?? '',
        () => false,
        () => false,
        () => 0,
        field => /prompt|text|caption|description/i.test(`${field?.fieldName || ''} ${field?.label || ''}`) ? 'prompt' : 'text',
        () => ({prompt:'', image:[], video:[], audio:[]}),
        async value => value,
    );
}

function runningHubPromptState(){
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const block = sourceBlock(source, 'function rhFieldRole', 'function rhExtractFieldOptions');
    return new Function('rhFieldKind', `${block}\nreturn rhPromptBindingState;`)(field => {
        const type = String(field?.fieldType || '').toUpperCase();
        if(['INT', 'INTEGER', 'NUMBER', 'FLOAT'].includes(type)) return 'number';
        if(type === 'IMAGE') return 'image';
        return 'text';
    });
}

function runningHubPromptRenderer(){
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const block = sourceBlock(source, 'function renderRhPromptSection', 'function renderRhParams');
    return new Function(
        'rhPromptBindingState', 'renderPromptPreview', 'renderRhPromptFields', 'escapeHtml', 'tr',
        `${block}\nreturn renderRhPromptSection;`,
    );
}

test('upstream-capable Text field submits connected prompt even when its stored default is empty', async () => {
    const buildNodeInfoList = runningHubNodeInfoBuilder();
    const field = {nodeId:'9', fieldName:'Text', fieldType:'STRING', sourceFromUpstream:true, fieldValue:''};
    const node = {rhMode:'app', fields:[field], rhParams:{'9::Text':{value:''}}};

    const result = await buildNodeInfoList(node, {prompt:'connected prompt', image:[], video:[], audio:[]});

    assert.deepEqual(result, [{nodeId:'9', fieldName:'Text', fieldValue:'connected prompt'}]);
});

test('manual-only Prompt field keeps its configured value instead of using upstream text', async () => {
    const buildNodeInfoList = runningHubNodeInfoBuilder();
    const field = {nodeId:'10', fieldName:'Prompt', fieldType:'STRING', sourceFromUpstream:false, fieldValue:''};
    const node = {rhMode:'app', fields:[field], rhParams:{'10::Prompt':{value:'manual prompt'}}};

    const result = await buildNodeInfoList(node, {prompt:'connected prompt', image:[], video:[], audio:[]});

    assert.deepEqual(result, [{nodeId:'10', fieldName:'Prompt', fieldValue:'manual prompt'}]);
});

test('connected prompt remains visible but is marked unsupported when no Prompt or Text field accepts upstream input', () => {
    const bindingState = runningHubPromptState();
    const media = {
        prompt:'connected prompt',
        sources:[{id:'prompt-1', prompt:'connected prompt'}],
    };

    const state = bindingState([{nodeId:'14', fieldName:'seed', fieldType:'INT'}], media);

    assert.equal(state.unsupported, true);
    assert.deepEqual(state.connectedSources, media.sources);
    assert.equal(state.promptFields.length, 0);
    assert.equal(state.upstreamPromptFields.length, 0);
});

test('configured workflow without a prompt field advertises that prompt input is not needed before connection', () => {
    const bindingState = runningHubPromptState();

    const state = bindingState(
        [{nodeId:'14', fieldName:'seed', fieldType:'INT'}],
        {prompt:'', sources:[]},
    );

    assert.equal(state.promptGuidance, 'info');
    assert.equal(state.unsupported, false);
});

test('connected prompt changes unsupported workflow guidance from information to warning', () => {
    const bindingState = runningHubPromptState();

    const state = bindingState(
        [{nodeId:'14', fieldName:'seed', fieldType:'INT'}],
        {prompt:'connected prompt', sources:[{prompt:'connected prompt'}]},
    );

    assert.equal(state.promptGuidance, 'warning');
    assert.equal(state.unsupported, true);
});

test('supported or not-yet-configured workflows do not show prompt guidance', () => {
    const bindingState = runningHubPromptState();

    const supported = bindingState(
        [{nodeId:'1', fieldName:'Prompt', fieldType:'STRING'}],
        {prompt:'', sources:[]},
    );
    const notConfigured = bindingState([], {prompt:'', sources:[]});

    assert.equal(supported.promptGuidance, '');
    assert.equal(notConfigured.promptGuidance, '');
});

test('Prompt and Text fields automatically accept upstream text unless explicitly opted out', () => {
    const bindingState = runningHubPromptState();
    const media = {prompt:'connected prompt', sources:[{prompt:'connected prompt'}]};
    const fields = [
        {nodeId:'1', fieldName:'Prompt', fieldType:'STRING'},
        {nodeId:'2', fieldName:'Text', fieldType:'STRING', sourceFromUpstream:true},
        {nodeId:'3', fieldName:'Negative Prompt', fieldType:'STRING', sourceFromUpstream:false},
    ];

    const state = bindingState(fields, media);

    assert.equal(state.unsupported, false);
    assert.equal(state.promptFields.length, 3);
    assert.deepEqual(state.upstreamPromptFields.map(field => field.nodeId), ['1', '2']);
});

test('unsupported RunningHub prompt area renders the connected text and exact warning', () => {
    const renderPromptSectionFactory = runningHubPromptRenderer();
    const container = {
        innerHTML:'',
        insertAdjacentHTML(position, html){
            this.innerHTML = position === 'afterbegin' ? `${html}${this.innerHTML}` : `${this.innerHTML}${html}`;
        },
    };
    const warning = '当前 RunningHub 工作流不支持提示词输入，本提示词不会提交';
    const renderPromptSection = renderPromptSectionFactory(
        () => ({
            promptFields:[],
            upstreamPromptFields:[],
            connectedSources:[{prompt:'connected prompt'}],
            unsupported:true,
        }),
        (target, sources) => { target.innerHTML = `preview:${sources.map(source => source.prompt).join('|')}`; },
        () => { throw new Error('prompt fields should not render for an unsupported workflow'); },
        value => String(value),
        key => key === 'canvas.rhPromptUnsupported' ? warning : key,
    );

    renderPromptSection(container, {}, [], {prompt:'connected prompt'});

    assert.match(container.innerHTML, /preview:connected prompt/);
    assert.match(container.innerHTML, new RegExp(warning));
});

test('unsupported configured RunningHub workflow renders neutral guidance before prompt connection', () => {
    const renderPromptSectionFactory = runningHubPromptRenderer();
    const container = {
        innerHTML:'',
        insertAdjacentHTML(position, html){
            this.innerHTML = position === 'afterbegin' ? `${html}${this.innerHTML}` : `${this.innerHTML}${html}`;
        },
    };
    const info = '当前所选工作流不需要提示词输入';
    const renderPromptSection = renderPromptSectionFactory(
        () => ({
            promptFields:[],
            upstreamPromptFields:[],
            connectedSources:[],
            unsupported:false,
            promptGuidance:'info',
        }),
        target => { target.innerHTML = ''; },
        () => { throw new Error('prompt fields should not render for an unsupported workflow'); },
        value => String(value),
        key => key === 'canvas.rhPromptNotRequired' ? info : key,
    );

    renderPromptSection(container, {}, [{fieldName:'seed'}], {prompt:''});

    assert.match(container.innerHTML, /rh-prompt-info/);
    assert.match(container.innerHTML, new RegExp(info));
    assert.doesNotMatch(container.innerHTML, /rh-prompt-warning/);
});
