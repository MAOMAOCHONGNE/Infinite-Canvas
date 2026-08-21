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
    const sandbox = {document:{addEventListener() {}}, ...overrides};
    vm.createContext(sandbox);
    vm.runInContext(`${source}\n;globalThis.__detailTest = {
        DETAIL_MAX_IMAGES, detailState, detailRuntime, detailTotalImages, detailModelGroups,
        detailEncodeChoice, detailDecodeChoice, detailFixedResolution, detailResolutionOptions,
        detailTaskPayload, detailUploadTaskImages, detailUploadThumb, detailTaskIsActive, detailPromptValue,
        detailScreenCard, detailScreenRegenerationLocked, detailLlmTraceLabel, detailScreenCandidates, detailSelectedCandidateIndex, detailResultImage
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
    });
    assert.equal(calls[0].url, '/api/ai/upload');
    assert.equal(calls[0].options.method, 'POST');
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
        copywriting:'required', richness:'rich', font_style:'auto', output_language:'自动识别',
        model_setting:'use', model_pose:'specific', model_usage:4, reversal_screens:2,
        product_name:'产品', product_features:'保持结构', user_instruction:'突出卖点',
    });
});

test('running cards expose locked prompts and terminal cards allow regeneration', () => {
    const helpers = loadDetailHelpers();
    const screen = {
        screen_no:1, title:'首屏', purpose:'建立主视觉', prompt:'服务端提示词', status:'generating',
        use_model:true, pose_mode:'specific', is_reversal:true, result:null, error:'',
    };
    helpers.detailRuntime.task = {status:'generating', screens:[screen]};
    helpers.detailRuntime.promptDrafts.set(1, '编辑后的提示词');
    assert.equal(helpers.detailTaskIsActive(), true);
    assert.equal(helpers.detailPromptValue(screen, true), '服务端提示词');
    assert.match(helpers.detailScreenCard(screen, true), /textarea[^>]+readonly/);
    assert.match(helpers.detailScreenCard(screen, true), /data-regenerate-screen="1" data-count="1" disabled/);
    const failedSibling = {...screen, screen_no:2, status:'failed'};
    assert.equal(helpers.detailScreenRegenerationLocked(failedSibling), false);
    assert.doesNotMatch(helpers.detailScreenCard(failedSibling, true), /data-regenerate-screen="2" data-count="1" disabled/);
    assert.match(helpers.detailScreenCard(failedSibling, true), /data-save-screen="2" disabled/);
    helpers.detailRuntime.task.status = 'partial';
    assert.equal(helpers.detailTaskIsActive(), false);
    assert.equal(helpers.detailPromptValue(screen, false), '编辑后的提示词');
    assert.doesNotMatch(helpers.detailScreenCard({...screen, status:'failed'}, false), /textarea[^>]+readonly/);
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
    assert.match(source, /\/api\/detail-page-tasks\/\$\{encodeURIComponent\(detailRuntime\.taskId\)\}/);
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
            {status:'succeeded', image_url:'/output/b.png', result:{images:['/output/b.png']}},
        ], selected_candidate:1,
    };
    assert.equal(helpers.detailResultImage(screen), '/output/b.png');
    const card = helpers.detailScreenCard(screen, false);
    assert.match(card, /2 个候选/);
    assert.match(card, /data-count="4"/);
    assert.match(card, /data-optimize-screen="2"/);
    assert.match(card, /data-delete-screen="2"/);
    for(const id of ['historySelect','requestPreview','resumeTaskBtn','collageBtn','downloadAllBtn','previewPrevScreen','previewNextScreen','previewPrevCandidate','previewNextCandidate','previewStage','previewDownloadBtn','previewCopyBtn']) {
        assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(source, /ArrowLeft[\s\S]*detailViewerStepScreen\(-1\)/);
    assert.match(source, /pointerdown/);
    assert.match(source, /detailViewerZoom/);
});

test('responsive result grids use valid fixed repeat counts', () => {
    assert.doesNotMatch(css, /repeat\(min\(/);
    assert.match(css, /\.result-card\s*\{/);
    assert.match(css, /\.screen-prompt textarea\s*\{/);
    assert.match(css, /@media \(max-width: 1120px\)[\s\S]*?repeat\(3, minmax\(150px, 1fr\)\)/);
    assert.match(css, /@media \(max-width: 760px\)[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
});
