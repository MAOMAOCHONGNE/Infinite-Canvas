const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'static', 'detail-page.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'static', 'css', 'detail-page.css'), 'utf8');
const source = fs.readFileSync(path.join(ROOT, 'static', 'js', 'detail-page.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'static', 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'main.py'), 'utf8');
const commonI18n = fs.readFileSync(path.join(ROOT, 'static', 'js', 'i18n', 'common.js'), 'utf8');

function optionValues(selectId){
    const start = html.indexOf(`<select id="${selectId}"`);
    const end = html.indexOf('</select>', start);
    assert.ok(start >= 0 && end > start, `missing select ${selectId}`);
    return [...html.slice(start, end).matchAll(/<option(?:\s+value="([^"]*)")?[^>]*>([^<]*)<\/option>/g)]
        .map(match => match[1] || match[2].trim());
}

function loadDetailHelpers(overrides={}){
    const sandbox = {
        document:{addEventListener() {}},
        AdaptiveImageRatio:{pixelSizeForRatio:() => '1024x1024'},
        ...overrides,
    };
    vm.createContext(sandbox);
    vm.runInContext(`${source}\n;globalThis.__detailTest = {
        DETAIL_MAX_IMAGES, detailState, detailRuntime, detailTotalImages, detailModelGroups,
        detailEncodeChoice, detailDecodeChoice, detailFixedResolution, detailResolutionOptions,
        detailTaskPayload, detailUploadTaskImages, detailUploadThumb, detailTaskIsActive, detailPromptValue,
        detailScreenCard, detailScreenRegenerationLocked, detailLlmTraceLabel, detailScreenCandidates, detailSelectedCandidateIndex, detailResultImage,
        detailRestoredState: typeof detailRestoredState === 'function' ? detailRestoredState : null,
        detailRememberTask: typeof detailRememberTask === 'function' ? detailRememberTask : null,
        detailHistoryLabel,
        detailGenerationSignature: typeof detailGenerationSignature === 'function' ? detailGenerationSignature : null,
        detailTaskGenerationSignature: typeof detailTaskGenerationSignature === 'function' ? detailTaskGenerationSignature : null,
        detailGenerationActionState: typeof detailGenerationActionState === 'function' ? detailGenerationActionState : null,
        detailPromoteUploadedImages: typeof detailPromoteUploadedImages === 'function' ? detailPromoteUploadedImages : null,
        detailBeginSubmission: typeof detailBeginSubmission === 'function' ? detailBeginSubmission : null,
        detailEndSubmission: typeof detailEndSubmission === 'function' ? detailEndSubmission : null,
        detailCreateSubmissionId: typeof detailCreateSubmissionId === 'function' ? detailCreateSubmissionId : null,
        detailCandidateSummary: typeof detailCandidateSummary === 'function' ? detailCandidateSummary : null,
        detailTaskHeading: typeof detailTaskHeading === 'function' ? detailTaskHeading : null
    };`, sandbox);
    return sandbox.__detailTest;
}

test('host navigation and cache policy expose the dedicated detail-page surface', () => {
    assert.match(index, /switchUI\(this, 'detail-page'\)/);
    assert.match(index, /id="frame-detail-page"[^>]+detail-page\.html/);
    assert.match(index, /PAGE_IDS = \[[^\]]*'detail-page'/);
    assert.match(index, /event\.data\?\.type === 'studio-navigate'/);
    assert.match(commonI18n, /"nav\.detailPage": \{ zh: "一键详情页", en: "Detail Page" \}/);
    for(const asset of ['detail-page.html', 'js/detail-page.js', 'css/detail-page.css']) {
        assert.ok(main.includes(`"/static/${asset}"`), `${asset} should bypass static caching`);
    }
});

test('confirmed detail controls preserve their exact option boundaries', () => {
    assert.deepEqual(optionValues('screenCount'), Array.from({length:12}, (_, index) => String(index + 1)));
    assert.deepEqual(optionValues('modelUsage'), ['1', '2', '3', '4', '5', '6', '7']);
    assert.deepEqual(optionValues('reversalScreens'), ['0', '1', '2', '3']);
    assert.deepEqual(optionValues('modelPose'), ['normal', 'specific']);
    assert.deepEqual(optionValues('modelSetting'), ['none', 'use']);
    assert.deepEqual(optionValues('copywriting'), ['required', 'blank', 'poster']);
    assert.deepEqual(optionValues('richness'), ['concise', 'medium', 'rich']);
    assert.equal(optionValues('fontStyle').length, 10);
    assert.deepEqual(optionValues('ratioSelect'), [
        '1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1',
        '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9',
        'source', 'adaptive', 'custom'
    ]);
});

test('specific pose is a selection only and does not reveal a conditional field', () => {
    assert.match(html, /<option value="specific">特定姿态<\/option>/);
    assert.doesNotMatch(source, /detailState\.modelPose\s*===/);
    assert.doesNotMatch(source, /dataset\.state\s*===\s*['"]modelPose['"]/);
    assert.doesNotMatch(html, /id="(?:specific|custom)Pose/i);
});

test('configured providers group image and chat models and retain aliases', () => {
    const helpers = loadDetailHelpers();
    const providers = [
        {id:'alpha', name:'Alpha API', enabled:true, image_models:['img-real', 'img-real', ''], chat_models:['vision-real'], model_names:{'img-real':'商品图模型', 'vision-real':'视觉分析'}},
        {id:'disabled', enabled:false, image_models:['hidden'], chat_models:['hidden']},
        {id:'empty', enabled:true, image_models:[], chat_models:[]},
    ];
    assert.deepEqual(JSON.parse(JSON.stringify(helpers.detailModelGroups(providers, 'image'))), [{
        id:'alpha', name:'Alpha API', models:[{id:'img-real', name:'商品图模型'}]
    }]);
    assert.deepEqual(JSON.parse(JSON.stringify(helpers.detailModelGroups(providers, 'chat'))), [{
        id:'alpha', name:'Alpha API', models:[{id:'vision-real', name:'视觉分析'}]
    }]);
    const encoded = helpers.detailEncodeChoice('alpha/custom', 'model|1');
    assert.deepEqual(JSON.parse(JSON.stringify(helpers.detailDecodeChoice(encoded))), {providerId:'alpha/custom', model:'model|1'});
});

test('resolution choices follow configured routing, fixed suffixes, and auto-size models', () => {
    const helpers = loadDetailHelpers();
    const routedTools = {
        resolutionRoutingEnabled:() => true,
        availableResolutions:() => ['1k', '4k'],
        imageModelSupportsAutoSize:() => false,
    };
    assert.deepEqual(JSON.parse(JSON.stringify(helpers.detailResolutionOptions({}, 'logical', routedTools))), ['1k', '4k']);
    assert.deepEqual(JSON.parse(JSON.stringify(helpers.detailResolutionOptions({}, 'nano-banana-2-4k', routedTools))), ['1k', '4k']);
    const plainTools = {
        resolutionRoutingEnabled:() => false,
        imageModelSupportsAutoSize:(_provider, model) => model === 'gpt-image-2',
    };
    assert.deepEqual(JSON.parse(JSON.stringify(helpers.detailResolutionOptions({}, 'nano-banana-2-4k', plainTools))), ['4k']);
    assert.deepEqual(JSON.parse(JSON.stringify(helpers.detailResolutionOptions({}, 'gpt-image-2', plainTools))), ['auto', '1k', '2k', '4k', 'custom']);
});

test('uploads share one six-image boundary and preserve product/reference order', async () => {
    const appended = [];
    class TestFormData {
        append(key, file, name){ appended.push({key, file, name}); }
    }
    const calls = [];
    const helpers = loadDetailHelpers({
        FormData:TestFormData,
        fetch:async (url, options) => {
            calls.push({url, options});
            return {ok:true, json:async () => ({files:Array.from({length:6}, (_, index) => ({url:`/assets/input/${index + 1}.png`}))})};
        },
    });
    helpers.detailState.images.product = Array.from({length:4}, (_, index) => ({file:`product-${index + 1}`, name:`p${index + 1}.png`}));
    helpers.detailState.images.reference = Array.from({length:2}, (_, index) => ({file:`reference-${index + 1}`, name:`r${index + 1}.png`}));
    assert.equal(helpers.DETAIL_MAX_IMAGES, 6);
    assert.equal(helpers.detailTotalImages(), 6);
    assert.match(source, /DETAIL_MAX_IMAGES - detailTotalImages\(\)/);
    assert.match(source, /candidates\.slice\(0, available\)/);
    const uploaded = await helpers.detailUploadTaskImages();
    assert.deepEqual(appended.map(item => item.file), [
        'product-1', 'product-2', 'product-3', 'product-4', 'reference-1', 'reference-2',
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(uploaded)), {
        product:['/assets/input/1.png', '/assets/input/2.png', '/assets/input/3.png', '/assets/input/4.png'],
        reference:['/assets/input/5.png', '/assets/input/6.png'],
        productMeta:[
            {url:'/assets/input/1.png', name:'p1.png', width:0, height:0},
            {url:'/assets/input/2.png', name:'p2.png', width:0, height:0},
            {url:'/assets/input/3.png', name:'p3.png', width:0, height:0},
            {url:'/assets/input/4.png', name:'p4.png', width:0, height:0},
        ],
        referenceMeta:[
            {url:'/assets/input/5.png', name:'r1.png', width:0, height:0},
            {url:'/assets/input/6.png', name:'r2.png', width:0, height:0},
        ],
    });
    assert.equal(calls[0].url, '/api/ai/upload');
    assert.equal(calls[0].options.method, 'POST');
});

test('restored source images keep their order while only new files are uploaded', async () => {
    const appended = [];
    class TestFormData {
        append(key, file, name){ appended.push({key, file, name}); }
    }
    const helpers = loadDetailHelpers({
        FormData:TestFormData,
        fetch:async () => ({ok:true, json:async () => ({files:[{url:'/assets/new-reference.png'}]})}),
    });
    helpers.detailState.images.product = [
        {id:'old-product', file:null, persisted:true, url:'/assets/old-product.png', name:'旧产品.png', width:800, height:1200},
    ];
    helpers.detailState.images.reference = [
        {id:'old-reference', file:null, persisted:true, url:'/assets/old-reference.png', name:'旧参考.png', width:900, height:1200},
        {id:'new-reference', file:'new-file', url:'blob:new', name:'新参考.png', width:1000, height:1000},
    ];

    const uploaded = await helpers.detailUploadTaskImages();

    assert.deepEqual(appended, [{key:'files', file:'new-file', name:'新参考.png'}]);
    assert.deepEqual(JSON.parse(JSON.stringify(uploaded)), {
        product:['/assets/old-product.png'],
        reference:['/assets/old-reference.png', '/assets/new-reference.png'],
        productMeta:[{url:'/assets/old-product.png', name:'旧产品.png', width:800, height:1200}],
        referenceMeta:[
            {url:'/assets/old-reference.png', name:'旧参考.png', width:900, height:1200},
            {url:'/assets/new-reference.png', name:'新参考.png', width:1000, height:1000},
        ],
    });
});

test('uploaded local images are promoted to persistent draft records for stable matching', () => {
    const revoked = [];
    const helpers = loadDetailHelpers({URL:{revokeObjectURL:url => revoked.push(url)}});
    helpers.detailState.images.product = [
        {id:'local-product', file:'product-file', url:'blob:product', name:'产品.png', width:800, height:1200},
    ];
    helpers.detailState.images.reference = [
        {id:'local-reference', file:'reference-file', url:'blob:reference', name:'参考.png', width:900, height:1200},
    ];

    helpers.detailPromoteUploadedImages({
        product:['/assets/product.png'], reference:['/assets/reference.png'],
        productMeta:[{url:'/assets/product.png', name:'产品.png', width:800, height:1200}],
        referenceMeta:[{url:'/assets/reference.png', name:'参考.png', width:900, height:1200}],
    });

    assert.deepEqual(revoked, ['blob:product', 'blob:reference']);
    assert.deepEqual(JSON.parse(JSON.stringify(helpers.detailState.images.product.map(({file, persisted, url, name}) => ({file, persisted, url, name})))), [
        {file:null, persisted:true, url:'/assets/product.png', name:'产品.png'},
    ]);
    assert.equal(helpers.detailState.images.reference[0].url, '/assets/reference.png');
    assert.equal(helpers.detailState.images.reference[0].file, null);
});

test('generation action follows the current draft across active, changed, and terminal groups', () => {
    const helpers = loadDetailHelpers();
    Object.assign(helpers.detailState, {
        imageChoice:helpers.detailEncodeChoice('image-api', 'image-model'),
        llmChoice:helpers.detailEncodeChoice('vision-api', 'vision-model'),
        productName:'香水', productFeatures:'透明瓶身', userInstruction:'暖金色',
    });
    helpers.detailState.images.product = [
        {file:null, persisted:true, url:'/assets/product.png', name:'产品.png', width:800, height:1200},
    ];
    const uploaded = {
        product:['/assets/product.png'], reference:[],
        productMeta:[{url:'/assets/product.png', name:'产品.png', width:800, height:1200}], referenceMeta:[],
    };
    const settings = helpers.detailTaskPayload(uploaded);
    const activeTask = {id:'active', group_no:1, status:'planning', settings, screens:[], created_at:1, updated_at:1};
    helpers.detailRememberTask(activeTask);

    assert.equal(helpers.detailGenerationSignature(), helpers.detailTaskGenerationSignature(activeTask));
    let action = helpers.detailGenerationActionState();
    assert.equal(action.mode, 'view');
    assert.equal(action.task.id, 'active');
    assert.equal(action.matchCount, 1);
    assert.match(action.label, /分组 #1 · 规划中/);

    helpers.detailState.productFeatures = '磨砂瓶身';
    action = helpers.detailGenerationActionState();
    assert.equal(action.mode, 'new');
    assert.equal(action.label, '生成新分组');

    helpers.detailState.productFeatures = '透明瓶身';
    helpers.detailRememberTask({...activeTask, status:'succeeded', updated_at:2});
    action = helpers.detailGenerationActionState();
    assert.equal(action.mode, 'repeat');
    assert.equal(action.label, '再次生成');
});

test('multiple forced active matches open the newest group and expose a paid duplicate action', () => {
    const helpers = loadDetailHelpers();
    helpers.detailState.imageChoice = helpers.detailEncodeChoice('image-api', 'image-model');
    helpers.detailState.llmChoice = helpers.detailEncodeChoice('vision-api', 'vision-model');
    helpers.detailState.images.product = [{file:null, persisted:true, url:'/assets/p.png', name:'p.png'}];
    const settings = helpers.detailTaskPayload({product:['/assets/p.png'], reference:[]});
    helpers.detailRememberTask({id:'older', group_no:1, status:'generating', settings, screens:[{status:'succeeded'}, {status:'generating'}], created_at:1, updated_at:5});
    helpers.detailRememberTask({id:'newer', group_no:2, status:'generating', settings, screens:[{status:'generating'}, {status:'queued'}], created_at:2, updated_at:2});

    const action = helpers.detailGenerationActionState();
    assert.equal(action.mode, 'view');
    assert.equal(action.task.id, 'newer');
    assert.equal(action.matchCount, 2);
    assert.equal(action.showForce, true);
    assert.match(action.label, /2 个相同配置分组运行中/);
    const newerIndex = helpers.detailRuntime.history.findIndex(task => task.id === 'newer');
    assert.match(helpers.detailHistoryLabel(helpers.detailRuntime.history[newerIndex], newerIndex), /分组 #2/);
    assert.match(html, /id="forceGenerateBtn"[^>]+hidden/);
    assert.match(css, /\.secondary-command\[hidden\]\s*\{\s*display:\s*none/);
});

test('submission lock is synchronous and reuses an uncertain submission id', () => {
    const generated = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    const helpers = loadDetailHelpers({crypto:{randomUUID:() => generated.shift()}});
    helpers.detailState.productName = '同一草稿';

    const first = helpers.detailBeginSubmission(false);
    assert.equal(first, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(helpers.detailRuntime.isUploading, true);
    assert.equal(helpers.detailBeginSubmission(false), '');

    helpers.detailEndSubmission(false);
    assert.equal(helpers.detailBeginSubmission(false), first);
    helpers.detailEndSubmission(true);
    assert.equal(helpers.detailBeginSubmission(false), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
});

test('task payload carries submission id and force flag only when supplied', () => {
    const helpers = loadDetailHelpers();
    const submissionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const payload = helpers.detailTaskPayload({product:[], reference:[]}, {submissionId, forceNew:true});
    assert.equal(payload.submission_id, submissionId);
    assert.equal(payload.force_new, true);
});

test('upload thumbnails use the same global image numbering sent to the LLM', () => {
    const helpers = loadDetailHelpers();
    helpers.detailState.images.product = [{id:'p1'}, {id:'p2'}];
    assert.match(helpers.detailUploadThumb({id:'p1', url:'blob:p1', name:'p1.png'}, 'product', 0), />图1</);
    assert.match(helpers.detailUploadThumb({id:'r1', url:'blob:r1', name:'r1.png'}, 'reference', 0), />图3</);
});

test('task payload carries selected providers, controls, and uploaded role arrays', () => {
    const helpers = loadDetailHelpers();
    Object.assign(helpers.detailState, {
        imageChoice:helpers.detailEncodeChoice('image-api', 'image-model'),
        llmChoice:helpers.detailEncodeChoice('vision-api', 'vision-model'),
        resolution:'custom', customSizeWidth:'1536', customSizeHeight:'2048',
        ratio:'3:4', screenCount:'7', modelSetting:'use', modelPose:'specific',
        modelUsage:'4', reversalScreens:'2', copywriting:'required', richness:'rich',
        productName:'产品', productFeatures:'保持结构', userInstruction:'突出卖点',
    });
    const payload = helpers.detailTaskPayload({product:['/assets/p.png'], reference:['/assets/r.png']});
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
        page_type:'detail', product_images:['/assets/p.png'], reference_images:['/assets/r.png'],
        image_provider_id:'image-api', image_model:'image-model', llm_provider_id:'vision-api', llm_model:'vision-model',
        aspect_ratio:'3:4', resolution:'custom', size:'1536x2048', quality:'auto', screen_count:7,
        ratio_mode:'3:4', custom_ratio_width:3, custom_ratio_height:4, custom_size_width:1536, custom_size_height:2048,
        copywriting:'required', richness:'rich', font_style:'auto', output_language:'自动识别',
        model_setting:'use', model_pose:'specific', model_usage:4, reversal_screens:2,
        product_name:'产品', product_features:'保持结构', user_instruction:'突出卖点',
        product_image_meta:[], reference_image_meta:[],
    });
});

test('result cards keep prompt editing in a compact modal action and stack flags below status', () => {
    const helpers = loadDetailHelpers();
    const screen = {
        screen_no:1, title:'首屏', purpose:'建立主视觉', prompt:'服务端提示词', status:'generating',
        use_model:true, pose_mode:'specific', is_reversal:true, result:null, error:'',
    };
    helpers.detailRuntime.task = {status:'generating', screens:[screen]};
    helpers.detailRuntime.promptDrafts.set(1, '编辑后的提示词');
    assert.equal(helpers.detailTaskIsActive(), true);
    assert.equal(helpers.detailPromptValue(screen, true), '服务端提示词');
    const runningCard = helpers.detailScreenCard(screen, true);
    assert.doesNotMatch(runningCard, /<textarea/);
    assert.doesNotMatch(runningCard, /class="screen-purpose"/);
    assert.match(runningCard, /data-open-prompt="1"/);
    assert.match(runningCard, /screen-card-meta[\s\S]*screen-state[\s\S]*screen-flags/);
    assert.match(runningCard, /data-regenerate-screen="1" data-count="1" disabled/);
    const failedSibling = {...screen, screen_no:2, status:'failed'};
    assert.equal(helpers.detailScreenRegenerationLocked(failedSibling), false);
    assert.doesNotMatch(helpers.detailScreenCard(failedSibling, true), /data-regenerate-screen="2" data-count="1" disabled/);
    assert.match(helpers.detailScreenCard(failedSibling, true), /data-open-prompt="2"/);
    helpers.detailRuntime.task.status = 'partial';
    assert.equal(helpers.detailTaskIsActive(), false);
    assert.equal(helpers.detailPromptValue(screen, false), '编辑后的提示词');
    assert.doesNotMatch(helpers.detailScreenCard({...screen, status:'failed'}, false), /<textarea/);
    for(const id of ['promptEditorModal','promptEditorText','promptEditorSave','promptEditorOptimize']) {
        assert.match(html, new RegExp(`id="${id}"`));
    }
});

test('history settings restore every field and persisted source image metadata', () => {
    const helpers = loadDetailHelpers();
    assert.equal(typeof helpers.detailRestoredState, 'function');
    const restored = helpers.detailRestoredState({
        image_provider_id:'image-api', image_model:'gpt-image-2', llm_provider_id:'vision-api', llm_model:'gemini',
        aspect_ratio:'5:4', resolution:'custom', size:'1600x1280', screen_count:6,
        copywriting:'poster', richness:'rich', font_style:'tech', output_language:'英文',
        model_setting:'use', model_pose:'specific', model_usage:5, reversal_screens:2,
        product_name:'香水', product_features:'透明瓶身', user_instruction:'暖金婚礼风格',
        product_images:['/assets/product.png'], reference_images:['/assets/reference.png'],
        product_image_meta:[{url:'/assets/product.png', name:'产品原图.png', width:1200, height:1600}],
        reference_image_meta:[{url:'/assets/reference.png', name:'风格参考.png', width:900, height:1200}],
    });
    assert.equal(restored.imageChoice, helpers.detailEncodeChoice('image-api', 'gpt-image-2'));
    assert.equal(restored.llmChoice, helpers.detailEncodeChoice('vision-api', 'gemini'));
    assert.equal(restored.ratio, '5:4');
    assert.equal(restored.resolution, 'custom');
    assert.equal(restored.customSizeWidth, '1600');
    assert.equal(restored.customSizeHeight, '1280');
    assert.equal(restored.screenCount, '6');
    assert.equal(restored.productFeatures, '透明瓶身');
    assert.equal(restored.userInstruction, '暖金婚礼风格');
    assert.deepEqual(JSON.parse(JSON.stringify(restored.images.product.map(({url, name, width, height, persisted}) => ({url, name, width, height, persisted})))), [
        {url:'/assets/product.png', name:'产品原图.png', width:1200, height:1600, persisted:true},
    ]);
    assert.equal(restored.images.reference[0].name, '风格参考.png');
});

test('tracking a background task never replaces the history group being viewed', () => {
    const helpers = loadDetailHelpers();
    assert.equal(typeof helpers.detailRememberTask, 'function');
    helpers.detailRuntime.viewTaskId = 'viewed';
    helpers.detailRuntime.task = {id:'viewed', status:'succeeded', screens:[]};

    helpers.detailRememberTask({id:'background', status:'generating', screens:[{status:'succeeded'}, {status:'generating'}]});
    assert.equal(helpers.detailRuntime.task.id, 'viewed');
    assert.equal(helpers.detailRuntime.activeTaskIds.has('background'), true);
    assert.match(helpers.detailHistoryLabel(helpers.detailRuntime.history.find(item => item.id === 'background'), 0), /运行中 1\/2/);

    helpers.detailRememberTask({id:'viewed', status:'partial', screens:[{status:'succeeded'}]});
    assert.equal(helpers.detailRuntime.task.status, 'partial');
    assert.equal(helpers.detailRuntime.activeTaskIds.has('viewed'), false);
});

test('detail task endpoints, repair state, cancellation, and regeneration are wired', () => {
    assert.match(main, /import detail_page_v4 as detail_v4/);
    assert.match(main, /detail_v4\.DETAIL_PAGE_V4_SYSTEM_PROMPT/);
    assert.match(main, /stage="planning"/);
    assert.match(main, /compilation_calls": 0/);
    assert.match(main, /@app\.post\("\/api\/detail-page-tasks"\)/);
    assert.match(main, /@app\.post\("\/api\/detail-page-tasks\/preview"\)/);
    assert.match(main, /@app\.get\("\/api\/detail-page-tasks"\)/);
    assert.match(main, /@app\.get\("\/api\/detail-page-tasks\/\{task_id\}"\)/);
    assert.match(main, /@app\.post\("\/api\/detail-page-tasks\/\{task_id\}\/cancel"\)/);
    assert.match(main, /@app\.post\("\/api\/detail-page-tasks\/\{task_id\}\/resume"\)/);
    assert.match(main, /@app\.patch\("\/api\/detail-page-tasks\/\{task_id\}\/screens\/\{screen_no\}"\)/);
    assert.match(main, /optimize-prompt/);
    assert.match(main, /@app\.post\("\/api\/detail-page-tasks\/\{task_id\}\/screens\/\{screen_no\}\/regenerate"\)/);
    assert.match(main, /screens\/reorder/);
    assert.match(main, /download\.zip/);
    assert.match(source, /\/api\/detail-page-tasks\/\$\{encodeURIComponent\(detailRuntime\.viewTaskId\)\}/);
    assert.match(html, /id="cancelTaskBtn"/);
    assert.match(html, /id="llmTrace"/);
    assert.match(html, /<span>开始生成<\/span>/);
});

test('task header exposes the actual visual LLM and bounded compiler diagnostics', () => {
    const helpers = loadDetailHelpers();
    const label = helpers.detailLlmTraceLabel({llm_trace:{
        provider_id:'vision-api', model:'gemini-3.6-flash', planning_calls:1,
        compilation_calls:0, repair_calls:0, parse_method:'fenced_json', resolved_language:'中文',
    }});
    assert.match(label, /视觉 LLM：gemini-3\.6-flash · vision-api/);
    assert.match(label, /规划 1 · 编译 0 · 修复 0/);
    assert.match(label, /解析 fenced_json/);
    assert.match(label, /语种 中文/);
    assert.match(css, /\.llm-trace\s*\{/);
});

test('candidate cards, history, diagnostics, and complete viewer controls are present', () => {
    const helpers = loadDetailHelpers();
    const screen = {
        screen_no:2, title:'场景屏', purpose:'展示使用', prompt:'prompt', status:'succeeded',
        candidates:[
            {status:'succeeded', image_url:'/output/a.png', result:{images:['/output/a.png']}},
            {status:'failed', error:'Server disconnected'},
            {status:'failed', error:'上游超时'},
            {status:'failed', error:'请求失败'},
        ], selected_candidate:0,
    };
    assert.equal(helpers.detailResultImage(screen), '/output/a.png');
    const card = helpers.detailScreenCard(screen, false);
    assert.equal(helpers.detailCandidateSummary(screen.candidates), '1 成功 · 3 失败');
    assert.match(card, /1 成功 · 3 失败/);
    assert.match(card, /class="failed"[^>]+disabled[^>]+title="Server disconnected"/);
    assert.match(css, /\.candidate-strip button\.failed/);
    assert.match(css, /\.candidate-strip button\.failed::after\s*\{[^}]*content:\s*"×"/);
    assert.doesNotMatch(card, /data-count="4"/);
    assert.match(card, /data-open-prompt="2"/);
    assert.match(html, /id="promptEditorOptimize"/);
    assert.match(card, /data-delete-screen="2"/);
    for(const id of ['historySelect','requestPreview','resumeTaskBtn','collageBtn','downloadAllBtn','previewPrevScreen','previewNextScreen','previewPrevCandidate','previewNextCandidate','previewStage','previewDownloadBtn','previewCopyBtn']) {
        assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(source, /ArrowLeft[\s\S]*detailViewerStepScreen\(-1\)/);
    assert.match(source, /pointerdown/);
    assert.match(source, /detailViewerZoom/);
});

test('named detail-page groups retain their stable number in headings and history', () => {
    const helpers = loadDetailHelpers();
    const task = {id:'named', title:'圣诞香水', group_no:27, status:'succeeded', screens:[], created_at:1, updated_at:1};
    helpers.detailRememberTask(task);
    assert.equal(helpers.detailTaskHeading(task), '圣诞香水 · 分组 #27');
    assert.match(helpers.detailHistoryLabel(task, 0), /^圣诞香水 · #27 ·/);
    for(const id of ['renameTaskBtn', 'taskTitleForm', 'taskTitleInput', 'saveTaskTitleBtn', 'cancelTaskTitleBtn']) {
        assert.match(html, new RegExp(`id="${id}"`));
    }
});

test('unknown async candidates are distinguished and expose query-only refill', () => {
    const helpers = loadDetailHelpers();
    const screen = {
        screen_no:1, title:'恢复屏', purpose:'恢复结果', prompt:'prompt', status:'unknown',
        candidates:[
            {id:'ok', status:'succeeded', image_url:'/output/a.png', result:{images:['/output/a.png']}},
            {id:'lost', status:'unknown', upstream_task_id:'task-123', error:'自动查询超时'},
            {id:'failed', status:'failed', error:'平台明确失败'},
        ], selected_candidate:0,
    };
    const card = helpers.detailScreenCard(screen, false);
    assert.equal(helpers.detailCandidateSummary(screen.candidates), '1 成功 · 1 待回补 · 1 失败');
    assert.match(card, /data-recover-candidate="lost"/);
    assert.match(card, /回补/);
    assert.match(css, /\.candidate-strip button\.unknown/);
    assert.match(source, /\/recover/);
    assert.doesNotMatch(html, /手动输入任务|粘贴图片 URL|上传补图/);
});

test('responsive result grids use valid fixed repeat counts', () => {
    assert.doesNotMatch(css, /repeat\(min\(/);
    assert.match(css, /\.result-card\s*\{/);
    assert.match(css, /\.prompt-editor-dialog\s*\{/);
    assert.match(css, /scrollbar-gutter:\s*stable/);
    assert.match(css, /@media \(max-width: 1120px\)[\s\S]*?repeat\(3, minmax\(150px, 1fr\)\)/);
    assert.match(css, /@media \(max-width: 760px\)[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
});
