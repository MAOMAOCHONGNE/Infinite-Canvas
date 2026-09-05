const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const index = read('static/index.html');
const html = read('static/image-generation.html');
const css = read('static/css/image-generation.css');
const js = read('static/js/image-generation.js');
const i18n = read('static/js/i18n/common.js');
const main = read('main.py');

function loadPageModule(overrides = {}) {
  const sandbox = {
    module: {exports: {}},
    localStorage: {getItem: () => null, setItem: () => {}},
    ...overrides,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(js, sandbox, {filename: 'image-generation.js'});
  return sandbox.module.exports;
}

function functionSource(name, nextName) {
  const start = js.indexOf(`function ${name}`);
  const end = nextName ? js.indexOf(`function ${nextName}`, start) : js.length;
  assert.ok(start >= 0 && end > start, `missing source function ${name}`);
  return js.slice(start, end);
}

test('image generation has an independent shell and navigation entry', () => {
  assert.match(index, /switchUI\(this, 'image-generation'\)/);
  assert.match(index, /id="frame-image-generation"/);
  assert.match(index, /'image-generation'/);
  assert.match(i18n, /"nav\.imageGeneration"\s*:\s*\{\s*zh:\s*"图片生成"/);
  assert.match(html, /<title>图片生成<\/title>/);
  for (const id of ['modeSearch', 'recentModes', 'favoriteModes', 'modeCategories', 'modeGrid', 'modeWorkbench']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(main, /"\/static\/image-generation\.html"/);
  assert.match(main, /"\/static\/js\/image-generation\.js"/);
  assert.match(main, /"\/static\/css\/image-generation\.css"/);
  assert.doesNotMatch(js, /\/api\/chat|haojieai\.top\/api\/chat/);
});

test('mode hall supports normalized search, favorites, recents and accessible cards', () => {
  assert.match(js, /imageGenerationPreferences:v1/);
  assert.match(js, /replace\(\/\\s\+\/g,\s*['"]['"]\)/);
  assert.match(js, /mode_no/);
  assert.match(js, /synonyms/);
  assert.match(js, /aria-pressed/);
  assert.match(js, /role="button"/);
  assert.match(js, /localStorage\.setItem/);
  assert.match(html, /id="clearModeSearch"/);
});

test('mode cards prioritize one-line names and active progress over static metadata', () => {
  const card = functionSource('modeCard', 'modesByIds');
  assert.match(card, /mode\.example\?\.input_media/);
  assert.match(card, /<div class="mode-card-top"><span class="mode-card-no">\$\{modeNumber\(mode\)\}<\/span><h3>/);
  assert.match(card, /const unseenNotice = progress \? null : modeUnseenNotice\(mode\.id\)/);
  assert.match(card, /cardStatus[\s\S]*?<div class="mode-card-progress/);
  assert.match(card, /class="status-spinner" data-lucide="loader-circle"/);
  assert.match(card, /mode-card-status-dot/);
  assert.match(card, /mode-card-example-pair/);
  assert.match(card, /原图示范/);
  assert.match(card, /生成图示范/);
  assert.doesNotMatch(card, /figcaption/);
  assert.doesNotMatch(card, /mode-card-example-arrow|mode-card-example-count|\+\$\{/);
  assert.match(css, /@keyframes image-generation-spin[\s\S]*?\.status-spinner \{[\s\S]*?animation: image-generation-spin 1s linear infinite/);
  assert.doesNotMatch(card, /const summary|const tags|mode-card-meta|mode-tag|图以内/);
  assert.match(js, /mode\.description, mode\.category, mode\.summary,.*mode\.tags/);
  assert.match(css, /\.mode-card-example-pair\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)[\s\S]*?aspect-ratio: 16 \/ 10/);
  assert.match(css, /\.mode-card-example-frame\s*\{[\s\S]*?height: 100%/);
  assert.match(css, /\.mode-card-example-frame \.mode-card-example\s*\{[\s\S]*?object-fit: contain/);
  assert.doesNotMatch(css, /\.mode-card-example-side figcaption/);
});

test('mode hall keeps completed tasks visible until their mode is viewed', () => {
  const {taskHallNotice, taskNoticeStateAfterTask, frameSurfaceVisible} = loadPageModule();
  const success = taskHallNotice({status:'succeeded', candidate_count:2, candidates:[{status:'succeeded'}, {status:'succeeded'}]});
  const partial = taskHallNotice({status:'succeeded', candidate_count:3, candidates:[{status:'succeeded'}, {status:'succeeded'}, {status:'failed'}]});
  const failure = taskHallNotice({status:'failed', candidate_count:1, candidates:[{status:'failed'}]});
  assert.equal(success.tone, 'complete');
  assert.equal(success.label, '已完成 · 2张');
  assert.equal(partial.tone, 'partial');
  assert.equal(partial.label, '已完成 · 2/3张');
  assert.equal(failure.tone, 'failure');
  assert.equal(failure.label, '生成失败');
  assert.equal(taskHallNotice({status:'unknown', candidate_count:1, candidates:[{status:'unknown'}]}), null);
  assert.equal(taskHallNotice({status:'succeeded', results_deleted:true, candidate_count:1, successful_candidate_count:1}), null);
  const activeTask = {id:'task-new', mode_id:'mode-1', status:'generating', candidate_count:1, candidates:[{status:'generating'}]};
  const completedTask = {id:'task-new', mode_id:'mode-1', status:'succeeded', candidate_count:1, candidates:[{status:'succeeded'}]};
  let noticeState = taskNoticeStateAfterTask({}, activeTask, false);
  assert.deepEqual(JSON.parse(JSON.stringify(noticeState)), {pendingTaskIds:['task-new'], unseenTaskIds:[]});
  noticeState = taskNoticeStateAfterTask(noticeState, completedTask, false);
  assert.deepEqual(JSON.parse(JSON.stringify(noticeState)), {pendingTaskIds:[], unseenTaskIds:['task-new']});
  const viewedState = taskNoticeStateAfterTask(taskNoticeStateAfterTask({}, activeTask, false), completedTask, true);
  assert.deepEqual(JSON.parse(JSON.stringify(viewedState)), {pendingTaskIds:[], unseenTaskIds:[]});
  const deletedState = taskNoticeStateAfterTask(noticeState, {...completedTask, results_deleted:true}, false);
  assert.deepEqual(JSON.parse(JSON.stringify(deletedState)), {pendingTaskIds:[], unseenTaskIds:[]});
  const activeFrame = {id:'frame-image-generation', classList:{contains:value => value === 'active'}};
  const inactiveFrame = {id:'frame-image-generation', classList:{contains:() => false}};
  assert.equal(frameSurfaceVisible(null, 'visible'), true);
  assert.equal(frameSurfaceVisible(activeFrame, 'visible'), true);
  assert.equal(frameSurfaceVisible(inactiveFrame, 'visible'), false);
  assert.equal(frameSurfaceVisible(activeFrame, 'hidden'), false);
  assert.match(js, /taskNotices:\{[\s\S]*?pendingTaskIds:[\s\S]*?unseenTaskIds:/);
  assert.match(js, /function syncTaskNotice\(task\)[\s\S]*?taskNoticeStateAfterTask\(notices, task, workbenchShowsMode\(task\.mode_id\)\)[\s\S]*?savePreferences\(\)/);
  assert.match(js, /function workbenchShowsMode\(modeId\)[\s\S]*?frameSurfaceVisible\(window\.frameElement, document\.visibilityState\)/);
  assert.match(js, /function rememberTask\(task\)[\s\S]*?syncTaskNotice\(merged\)/);
  assert.match(js, /async function selectMode\(modeId\)[\s\S]*?await loadModeTasks\(modePayload\.id[\s\S]*?markModeTaskNoticesSeen\(modePayload\.id\)/);
  assert.match(js, /function reconcileAfterDataCleanup\(deletedTaskIds\)[\s\S]*?forgetImageGenerationTasks\(deleted\)/);
  assert.match(js, /function forgetTaskNotices\(taskIds\)[\s\S]*?\[\.\.\.\(taskIds \|\| \[\]\)\]/);
  assert.match(css, /\.mode-card-progress\.is-unseen\s*\{[\s\S]*?font-size: 12px/);
  assert.match(css, /\.mode-card-progress\.is-complete[^}]*var\(--ig-accent-soft\)/);
  assert.match(css, /\.mode-card-progress\.is-partial[^}]*var\(--ig-warm-soft\)/);
  assert.match(css, /\.mode-card-progress\.is-failure[^}]*var\(--ig-danger\)/);
});

test('active result cards show a live elapsed time without extra wording', () => {
  const {timestampMilliseconds, formatElapsedDuration, candidateElapsedStart} = loadPageModule();
  assert.equal(timestampMilliseconds(1788013312.5), 1788013312500);
  assert.equal(timestampMilliseconds(1788013312500), 1788013312500);
  assert.equal(formatElapsedDuration(0), '00:00');
  assert.equal(formatElapsedDuration(65_000), '01:05');
  assert.equal(formatElapsedDuration(3_723_000), '01:02:03');
  assert.equal(candidateElapsedStart({created_at:100}, {created_at:110, submitted_at:120}), 120000);
  assert.equal(candidateElapsedStart({created_at:100}, {created_at:110}), 110000);
  const item = functionSource('renderGalleryItem', 'resultSelectionLabel');
  assert.match(item, /ACTIVE_TASK_STATUSES\.has\(status\)[\s\S]*?candidate-elapsed/);
  assert.doesNotMatch(item, /已等待/);
  assert.match(js, /function syncCandidateElapsedTimer\(\)[\s\S]*?setInterval\(updateCandidateElapsedTimes, 1000\)/);
  assert.match(js, /function renderResults\(\)[\s\S]*?syncCandidateElapsedTimer\(\)/);
  assert.match(js, /function setWorkbenchVisible\(visible\)[\s\S]*?if\(!isVisible\)[\s\S]*?clearInterval\(runtime\.elapsedTimer\)/);
  assert.match(css, /\.candidate-placeholder \.candidate-elapsed \{[^}]*font-size: 12px;[^}]*font-variant-numeric: tabular-nums/);
});

test('mode hall uses the available width and keeps compact cards responsive', () => {
  assert.doesNotMatch(html, />本机模式库</);
  assert.match(css, /\.image-generation-app \{[\s\S]*?grid-template-rows: 58px minmax\(0, 1fr\)/);
  assert.match(css, /\.page-identity h1 \{[^}]*margin: 0;/);
  assert.match(css, /\.mode-band,\s*\.catalog-band \{\s*width: 100%;/);
  assert.match(css, /\.mode-grid \{[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.mode-card \{[\s\S]*?grid-template-rows: auto auto[\s\S]*?min-height: 0/);
  assert.match(css, /\.mode-card-top \{[\s\S]*?justify-content: flex-start[\s\S]*?padding-right: 30px/);
  assert.match(css, /\.mode-card h3 \{[\s\S]*?min-width: 0[\s\S]*?white-space: nowrap[\s\S]*?text-overflow: ellipsis/);
  assert.match(css, /@media \(min-width: 901px\)[\s\S]*?html\.studio-ui-scaled body:not\(\.studio-scale-host\) \.image-generation-app \{[\s\S]*?height: calc\(100vh \/ var\(--studio-ui-scale, 1\)\)[\s\S]*?min-height: calc\(100vh \/ var\(--studio-ui-scale, 1\)\)/);
  assert.doesNotMatch(css, /\.mode-grid \{[\s\S]*?repeat\(auto-fill/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.mode-grid \{ grid-template-columns: repeat\(3/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.mode-grid \{ grid-template-columns: repeat\(2/);
});

test('workbench keeps example data compatible while opening cases from the header', () => {
  const cssCacheMtime = Math.floor(fs.statSync(path.join(root, 'static/css/image-generation.css')).mtimeMs / 1000);
  const jsCacheMtime = Math.floor(fs.statSync(path.join(root, 'static/js/image-generation.js')).mtimeMs / 1000);
  const htmlCacheMtime = Math.floor(fs.statSync(path.join(root, 'static/image-generation.html')).mtimeMs / 1000);
  assert.match(html, /class="workbench-columns"[\s\S]*?id="inputPanel"[\s\S]*?class="result-panel"[\s\S]*?id="modeExample"[\s\S]*?id="modeResults"[\s\S]*?id="modeHistory"/);
  assert.match(html, new RegExp(`image-generation\\.css\\?v=[^\"]*\\.${cssCacheMtime}`));
  assert.match(html, new RegExp(`image-generation\\.js\\?v=[^\"]*\\.${jsCacheMtime}`));
  assert.match(index, new RegExp(`id="frame-image-generation" data-src="/static/image-generation\\.html\\?v=[^\"]*\\.${htmlCacheMtime}"`));
  assert.match(html, /<div class="result-panel-title"><h3 id="resultPanelTitle">生成记录<\/h3><span id="resultCount" class="result-count">0 张<\/span><\/div>/);
  assert.doesNotMatch(html, /最新结果与本模式历史/);
  for (const id of ['viewModeExample', 'modeExample', 'modeExampleDialog', 'modeExampleDialogContent', 'caseImagePreviewDialog', 'caseImagePreview', 'closeCaseImagePreview', 'modeInputSlots', 'slotFilePicker', 'modeResults', 'modeHistory', 'historyCount']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, />当前模式示范</);
  assert.doesNotMatch(html, /id="refreshModeHistory"/);
  assert.doesNotMatch(js, /byId\('refreshModeHistory'\)/);
  const example = functionSource('renderExample', 'providerList');
  assert.match(example, /container\.hidden = true/);
  assert.doesNotMatch(example, /container\.hidden = false/);
  assert.match(example, /dialogContent\.innerHTML = markup/);
  assert.match(example, /viewButton\.hidden = false/);
  assert.match(example, /example-case-layout/);
  assert.match(example, /example-notice/);
  assert.match(example, /注意事项/);
  assert.match(example, /example\.caption/);
  assert.match(example, /const promptView = examplePromptView\(example\.sample_user_prompt\)/);
  assert.doesNotMatch(example, /example\.show_user_prompt/);
  assert.doesNotMatch(example, /example\.title/);
  assert.match(example, /example-prompt/);
  assert.match(example, /promptView\.empty \? ' is-empty' : ''/);
  assert.match(example, /escapeHtml\(promptView\.text\)/);
  assert.match(css, /\.example-prompt\.is-empty p \{[\s\S]*?color: var\(--ig-muted\)/);
  assert.match(example, /example-media-frame/);
  assert.match(example, /example-media-label">处理前/);
  assert.match(example, /example-media-label">处理后/);
  assert.doesNotMatch(example, /example-heading|example-label/);
  assert.match(example, /example-output-side/);
  assert.match(example, /dialogTitle\.textContent = modeLabel \? `案例预览/);
  assert.match(js, /function openModeExampleDialog\(\)[\s\S]*?dialog\.showModal\(\)/);
  assert.match(js, /byId\('viewModeExample'\)\.addEventListener\('click', openModeExampleDialog\)/);
  assert.match(js, /function setWorkbenchVisible\(visible\)/);
  assert.match(js, /app\.classList\.toggle\('workbench-active', isVisible\)/);
  assert.match(css, /\.image-generation-app\.workbench-active\s*\{[\s\S]*?grid-template-rows: minmax\(0, 1fr\)/);
  assert.match(css, /\.image-generation-app\.workbench-active \.page-header\s*\{\s*display: none/);
  assert.match(css, /\.example-section,\s*\.workbench-columns\s*\{\s*width: 100%;\s*max-width: none;/);
  assert.match(css, /\.workbench-scroll\s*\{[\s\S]*?padding: 14px 16px 28px/);
  assert.match(css, /\.workbench-columns\s*\{\s*display: grid;\s*grid-template-columns: 480px minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.image-generation-app\.workbench-active[\s\S]*?grid-template-rows: minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.workbench-header\s*\{\s*position: sticky; top: 0/);
  assert.match(css, /\.example-case-layout\s*\{[\s\S]*?grid-template-columns: minmax\(220px, \.72fr\) minmax\(0, 1\.28fr\)/);
  assert.match(css, /\.example-notice\s*\{[\s\S]*?background: #fff0dc/);
  assert.match(css, /\.example-media-frame\s*\{[\s\S]*?aspect-ratio: 1 \/ 1/);
  assert.match(css, /\.example-media-frame img\s*\{[\s\S]*?object-fit: contain/);
  assert.match(css, /\.example-media-label\s*\{[\s\S]*?text-align: center/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.example-case-media\s*\{\s*grid-template-columns: 1fr/);
  assert.match(css, /\.mode-example-dialog\s*\{[\s\S]*?width: min\(1600px, calc\(100vw - 40px\)\)[\s\S]*?height: min\(820px, calc\(100vh - 40px\)\)/);
  assert.match(css, /\.mode-example-shell\s*\{[\s\S]*?height: 100%/);
  assert.match(css, /\.mode-example-shell > \.dialog-header\s*\{[\s\S]*?min-height: 50px/);
  assert.match(css, /\.mode-example-dialog-content\s*\{[\s\S]*?padding: 20px 24px 24px/);
  assert.match(css, /\.mode-example-dialog-content \.example-case-layout\s*\{[\s\S]*?grid-template-columns: minmax\(280px, \.48fr\) minmax\(0, 1\.52fr\)[\s\S]*?gap: 32px/);
  assert.match(css, /\.mode-example-dialog-content \.example-case-media\s*\{[\s\S]*?padding: 16px[\s\S]*?border: 1px solid var\(--ig-border\)/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.mode-example-dialog\s*\{[\s\S]*?width: calc\(100vw - 20px\)/);
});

test('case viewer keeps small images at 100% and supports wheel panzoom without click toggles', () => {
  const {exampleMediaLayout, caseImagePreviewFitSize, clampCaseImagePreviewPan, caseImagePreviewZoomState} = loadPageModule();
  assert.equal(typeof exampleMediaLayout, 'function');
  assert.equal(exampleMediaLayout(0, true), 'output-only');
  assert.equal(exampleMediaLayout(2, true), 'comparison');
  assert.equal(exampleMediaLayout(2, false), 'input-only');
  const wideFit = caseImagePreviewFitSize({imageWidth:2000, imageHeight:1000, viewportWidth:1600, viewportHeight:900});
  assert.equal(wideFit.width, 1600);
  assert.equal(wideFit.height, 800);
  assert.equal(wideFit.scale, .8);
  const tallFit = caseImagePreviewFitSize({imageWidth:1000, imageHeight:2000, viewportWidth:1600, viewportHeight:900});
  assert.equal(tallFit.width, 450);
  assert.equal(tallFit.height, 900);
  assert.equal(tallFit.scale, .45);
  const smallFit = caseImagePreviewFitSize({imageWidth:600, imageHeight:400, viewportWidth:1600, viewportHeight:900});
  assert.equal(smallFit.width, 600);
  assert.equal(smallFit.height, 400);
  assert.equal(smallFit.scale, 1);
  const largePan = clampCaseImagePreviewPan({x:900, y:-700, imageWidth:2400, imageHeight:1600, viewportWidth:1600, viewportHeight:900});
  assert.equal(largePan.x, 400);
  assert.equal(largePan.y, -350);
  const smallPan = clampCaseImagePreviewPan({x:100, y:100, imageWidth:800, imageHeight:600, viewportWidth:1600, viewportHeight:900});
  assert.equal(smallPan.x, 0);
  assert.equal(smallPan.y, 0);
  const zoomed = caseImagePreviewZoomState({
    scale:.5,
    nextScale:1,
    panX:0,
    panY:0,
    pointerX:250,
    pointerY:0,
    imageWidth:2000,
    imageHeight:1000,
    viewportWidth:1000,
    viewportHeight:800,
    minScale:.1,
    maxScale:8,
  });
  assert.equal(zoomed.scale, 1);
  assert.equal(zoomed.panX, -250);
  assert.equal(zoomed.panY, 0);

  const render = functionSource('renderExample', 'openModeExampleDialog');
  assert.match(render, /const mediaLayout = exampleMediaLayout\(inputs\.length, Boolean\(outputUrl\)\)/);
  assert.match(render, /example-case-media is-\$\{mediaLayout\}/);
  assert.match(render, /data-example-image=/);
  assert.match(render, /example-image-zoom[\s\S]*?data-lucide="zoom-in"/);

  const open = functionSource('openCaseImagePreview', 'closeCaseImagePreview');
  assert.match(open, /caseImagePreviewDialog/);
  assert.match(open, /caseImagePreview/);
  assert.match(open, /document\.body\.classList\.add\('case-image-preview-active'\)/);
  assert.match(open, /notifyCaseImagePreviewHost\(true\)/);
  assert.match(open, /dialog\.showModal\(\)/);
  const applyView = functionSource('applyCaseImagePreviewView', 'setCaseImagePreviewZoomAt');
  assert.match(applyView, /caseImagePreviewFitSize/);
  assert.match(applyView, /image\.naturalWidth/);
  assert.match(applyView, /image\.style\.width/);
  assert.match(applyView, /scale\(\$\{state\.scale\}\)/);
  const bind = functionSource('bindStaticEvents', 'bootstrap');
  assert.match(bind, /modeExampleDialogContent[\s\S]*?\[data-example-image\][\s\S]*?openCaseImagePreview/);
  assert.match(bind, /caseImagePreview[\s\S]*?pointerdown[\s\S]*?pointermove[\s\S]*?pointerup/);
  assert.match(bind, /casePreviewShell\.addEventListener\('wheel'[\s\S]*?setCaseImagePreviewZoomAt[\s\S]*?passive:false/);
  assert.doesNotMatch(js, /CASE_PREVIEW_CLICK_DELAY|nextCaseImagePreviewMode|toggleCaseImagePreviewMode/);
  assert.doesNotMatch(bind, /casePreviewImage\.addEventListener\('click'/);
  assert.match(bind, /caseImagePreview[\s\S]*?dblclick[\s\S]*?closeCaseImagePreview/);
  assert.match(bind, /document\.addEventListener\('keydown'[\s\S]*?caseImagePreviewDialog[\s\S]*?event\.key === 'Escape'[\s\S]*?closeCaseImagePreview/);
  assert.match(bind, /caseImagePreviewDialog[\s\S]*?event\.key === '\+'[\s\S]*?panCaseImagePreviewBy/);
  const close = functionSource('closeCaseImagePreview', 'providerList');
  assert.match(close, /if\(dialog\?\.open\) dialog\.close\(\)/);
  assert.doesNotMatch(close, /notifyCaseImagePreviewHost\(false\)/);
  assert.match(bind, /caseImagePreviewDialog[\s\S]*?close[\s\S]*?notifyCaseImagePreviewHost\(false\)/);

  assert.match(css, /\.example-case-media\.is-output-only\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.example-image-zoom\s*\{[\s\S]*?opacity: 0/);
  assert.match(css, /\.example-image-trigger:hover \.example-image-zoom,[\s\S]*?opacity: 1/);
  assert.match(css, /\.case-image-preview-dialog\s*\{[\s\S]*?width: 100vw[\s\S]*?height: 100vh/);
  assert.match(css, /\.case-image-preview-shell\s*\{[\s\S]*?padding: 0[\s\S]*?overflow: hidden/);
  assert.match(css, /\.case-image-preview\s*\{[\s\S]*?width: auto[\s\S]*?height: auto[\s\S]*?max-width: none[\s\S]*?max-height: none[\s\S]*?object-fit: contain/);
  assert.match(css, /\.case-image-preview-shell\.can-pan \.case-image-preview\s*\{[\s\S]*?cursor: grab/);
  assert.match(css, /html\.studio-ui-scaled body\.case-image-preview-active:not\(\.studio-scale-host\)\s*\{[\s\S]*?width: 100% !important[\s\S]*?min-height: 100vh !important[\s\S]*?transform: none !important/);
  assert.match(index, /body\.image-generation-case-preview-active[\s\S]*?#frame-image-generation[\s\S]*?position: fixed[\s\S]*?z-index:/);
  assert.match(index, /body\.image-generation-case-preview-restoring #frame-image-generation[\s\S]*?transition: none/);
  assert.match(index, /setImageGenerationCasePreviewActive[\s\S]*?image-generation-case-preview-restoring[\s\S]*?requestAnimationFrame/);
  assert.match(index, /image-generation-case-preview-state[\s\S]*?event\.source !== frame\.contentWindow[\s\S]*?setImageGenerationCasePreviewActive/);
});

test('case prompt view preserves descriptions and explains missing user input', () => {
  const {examplePromptView} = loadPageModule();
  const empty = examplePromptView('   ');
  assert.equal(empty.text, '本案例未填写用户描述');
  assert.equal(empty.empty, true);

  const filled = examplePromptView('  保留红色主标题\n增加金色边框  ');
  assert.equal(filled.text, '保留红色主标题\n增加金色边框');
  assert.equal(filled.empty, false);
});

test('workbench input slots expand on demand and preserve slot keys', () => {
  assert.match(html, /class="input-heading-line"[\s\S]*?id="inputPanelTitle">上传图片<\/h3>[\s\S]*?id="inputModeHint" class="input-mode-hint"/);
  assert.match(html, /id="inputModeRoles" class="input-mode-roles"/);
  assert.doesNotMatch(html, /支持粘贴上传 · 多图可拖拽排序/);
  assert.match(html, /id="modeInputSlots" class="input-slots"[\s\S]*?id="modeGuidance" class="mode-guidance" hidden>[\s\S]*?id="workbenchModeSummary"[\s\S]*?class="field user-prompt-field"/);
  const slots = functionSource('renderInputSlots', 'bindSlotDragEvents');
  assert.match(slots, /const requiredReady = runtime\.inputs\.filter\(slot => slot\.required\)\.every\(slot => slot\.media\)/);
  assert.match(slots, /const firstEmptyOptional = requiredReady \? runtime\.inputs\.find\(slot => !slot\.media && !slot\.required\) : null/);
  assert.match(slots, /runtime\.inputs\.filter\(slot => slot\.required \|\| slot\.media \|\| \(editable && slot === firstEmptyOptional\)\)/);
  assert.match(slots, /data-upload-slot="\$\{escapeHtml\(slot\.slot_key\)\}"/);
  assert.match(slots, /class="slot-image slot-preview-trigger"[\s\S]*?data-preview-slot="\$\{escapeHtml\(slot\.slot_key\)\}"[\s\S]*?title="点击查看原图"/);
  assert.match(slots, /container\.querySelectorAll\('\[data-preview-slot\]'\)/);
  assert.match(slots, /previewUploadedImage\(image\.dataset\.previewSlot\)/);
  assert.match(slots, /const addLabel = slot\.required \? slot\.label : '添加图片'/);
  const hint = functionSource('syncInputModeHint', 'renderInputSlots');
  assert.match(hint, /const definitions = slotDefinitions\(mode\)/);
  assert.match(hint, /`必传 \$\{required\} 张` : '无需必传'/);
  assert.match(hint, /`可选 \+\$\{optional\} 张` : '无可选图片'/);
  assert.match(js, /function uploadRuleDetails\(mode\)[\s\S]*?图\$\{index \+ 1\}为\$\{slot\.label\}/);
  assert.match(js, /另外可再上传最多\$\{optionalCount\}张参考图/);
  assert.match(hint, /byId\('inputModeRoles'\)\.textContent = details\.roles/);
  assert.match(hint, /roles\.hidden = !details\.roles/);
  assert.match(css, /\.input-heading-line \{[\s\S]*?display: flex[\s\S]*?flex-wrap: wrap/);
  assert.match(css, /\.panel-heading \.input-mode-hint \{[\s\S]*?color: #f07824[\s\S]*?font-size: 13px[\s\S]*?font-weight: 850/);
  assert.match(css, /\.panel-heading \.input-mode-roles \{[\s\S]*?color: rgb\(0 0 0 \/ 60%\)[\s\S]*?font-size: 14px/);
  assert.match(html, /<div id="modeGuidance" class="mode-guidance" hidden>\s*<p id="workbenchModeSummary"><\/p>\s*<\/div>/);
  assert.match(css, /\.mode-guidance \{[\s\S]*?display: block[\s\S]*?border: 1px solid #f3a34b[\s\S]*?border-left: 4px solid #f07824[\s\S]*?background: #fff0dc[\s\S]*?color: rgb\(0 0 0 \/ 60%\)/);
  assert.match(css, /html\.studio-theme-dark \.panel-heading \.input-mode-roles,[\s\S]*?html\.studio-theme-dark \.mode-guidance \{ color: rgb\(255 255 255 \/ 72%\); \}/);
  assert.match(css, /\.mode-guidance p \{[\s\S]*?font-size: 14px[\s\S]*?font-weight: 400[\s\S]*?line-height: 1\.55[\s\S]*?white-space: pre-wrap[\s\S]*?overflow-wrap: anywhere/);
  assert.doesNotMatch(css, /\.mode-guidance svg/);
  assert.doesNotMatch(html, /id="modeGuidance"[^>]*>[\s\S]*?<h[1-6][^>]*>注意事项<\/h[1-6]>/);
  assert.match(js, /byId\('modeGuidance'\)\.hidden = !guidance/);
  const payload = functionSource('generationImagesPayload', 'effectiveOutputSize');
  assert.match(payload, /slot_key:item\.slot_key, role:item\.slot_key/);
  assert.doesNotMatch(payload, /role:item\.label/);
});

test('workbench uses one outer scroll with a wider compact input rail', () => {
  assert.match(css, /\.workbench-header \{[\s\S]*?grid-template-columns: auto minmax\(0, 1fr\) auto/);
  assert.match(html, /id="userPrompt" rows="3"/);
  assert.match(css, /\.user-prompt-field textarea \{ min-height: 68px; \}/);
  assert.match(html, /class="field provider-field"[\s\S]*?class="field model-field"[\s\S]*?class="field ratio-field"[\s\S]*?class="field resolution-field"[\s\S]*?class="field count-field"/);
  assert.match(css, /\.input-panel \{ position: static; max-height: none; overflow: visible;/);
  assert.match(css, /\.input-actions \{ position: static;[\s\S]*?border-top: 1px solid var\(--ig-border\)/);
  assert.match(html, /id="workbenchStatus" class="workbench-status" aria-live="polite" hidden[\s\S]*?id="workbenchStatusIcon"[\s\S]*?id="workbenchStatusText"/);
  assert.match(html, /id="workbenchStatus"[\s\S]*?<\/p>\s*<div class="input-actions"/);
  assert.match(css, /\.workbench-status\.ready \{[\s\S]*?var\(--ig-warm-soft\)/);
  assert.match(css, /\.primary-button\.ready-pulse \{[\s\S]*?animation:/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?ready-pulse/);
  assert.match(css, /\.input-slots \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.input-panel \.panel-heading h3 \{ font-size: 13px;/);
  assert.match(css, /\.input-panel \.field > span \{ font-size: 12px;/);
  assert.match(css, /\.input-panel \.field textarea,[\s\S]*?\.input-panel \.field select,[\s\S]*?\.input-panel \.field input \{ font-size: 14px;/);
  assert.match(css, /\.input-panel \.slot-open strong,[\s\S]*?\.input-panel \.slot-open span,[\s\S]*?\.input-panel \.slot-label \{ font-size: 12px;/);
  assert.match(css, /\.input-panel \.settings-heading \{ font-size: 13px;/);
  assert.match(css, /\.input-panel \.input-actions \.secondary-button,[\s\S]*?\.input-panel \.input-actions \.primary-button \{ font-size: 12px;/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.input-slots \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(html, /<div class="settings-heading">生成设置<\/div>\s*<div class="settings-grid">/);
  assert.match(css, /\.settings-grid \{[\s\S]*?grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.settings-grid \.provider-field,[\s\S]*?\.settings-grid \.model-field,[\s\S]*?\.settings-grid \.ratio-field,[\s\S]*?\.settings-grid \.resolution-field,[\s\S]*?\.settings-grid \.count-field \{ grid-column: span 3; \}/);
  assert.match(css, /\.example-media-frame img \{[\s\S]*?object-fit: contain/);
  assert.match(css, /\.candidate-item \{[\s\S]*?aspect-ratio: var\(--item-ratio, 4 \/ 3\)/);
  assert.match(css, /\.mode-history \{[\s\S]*?grid-auto-flow: column[\s\S]*?overflow-x: auto/);
  assert.match(css, /@media \(max-width: 1180px\)[\s\S]*?\.workbench-columns \{ grid-template-columns: 480px minmax\(0, 1fr\); \}/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.workbench-columns \{ grid-template-columns: 1fr; \}/);
});

test('user descriptions support a synchronized large editor', () => {
  assert.match(html, /class="user-prompt-label-row"[\s\S]*?for="userPrompt">用户描述<[\s\S]*?id="openUserPromptEditor"[\s\S]*?data-lucide="maximize-2"/);
  for (const id of ['userPromptEditorDialog', 'userPromptEditorTitle', 'userPromptEditorFont', 'userPromptEditor', 'userPromptEditorCount', 'closeUserPromptEditor']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="closeUserPromptEditor"[^>]*title="保存并关闭"[^>]*aria-label="保存并关闭"/);
  for (const size of ['small', 'medium', 'large', 'xlarge']) assert.match(html, new RegExp(`data-prompt-font="${size}"`));
  assert.match(html, /id="userPromptEditor"[^>]*maxlength="20000"/);

  const update = functionSource('updateUserPrompt', 'openUserPromptEditor');
  assert.match(update, /runtime\.userPrompt = nextValue/);
  assert.match(update, /source !== 'compact'[\s\S]*?compact\.value = nextValue/);
  assert.match(update, /source !== 'editor'[\s\S]*?editor\.value = nextValue/);
  assert.match(update, /markDirty\(\)/);
  const historyEdit = functionSource('makeHistoryPromptEditable', 'updateUserPrompt');
  assert.match(historyEdit, /applyTaskAsEditable\(runtime\.viewedTask, '由历史创建'\)/);
  const syncFormSource = functionSource('syncForm', 'syncGenerateButtonLabel');
  assert.match(syncFormSource, /syncUserPromptEditorFromRuntime\(\)/);
  assert.match(js, /byId\('userPrompt'\)\.addEventListener\('input',[\s\S]*?updateUserPrompt\(event\.target\.value, 'compact'\)/);
  assert.match(js, /byId\('userPromptEditor'\)\.addEventListener\('input',[\s\S]*?updateUserPrompt\(event\.target\.value, 'editor'\)/);
  assert.match(js, /localStorage\.setItem\(USER_PROMPT_EDITOR_FONT_KEY, selected\)/);

  assert.match(css, /\.user-prompt-expand \{[\s\S]*?width: 22px;[\s\S]*?height: 21px/);
  assert.match(css, /\.user-prompt-editor-dialog \{[\s\S]*?width: 700px;[\s\S]*?height: 800px;[\s\S]*?min-width: min\(480px,[\s\S]*?min-height: min\(360px,[\s\S]*?resize: both/);
  assert.match(css, /\.user-prompt-editor-shell \{[\s\S]*?display: flex[\s\S]*?flex-direction: column/);
  assert.match(css, /\.user-prompt-editor-header \{[\s\S]*?min-height: 46px[\s\S]*?padding: 9px 12px/);
  assert.match(css, /\.user-prompt-editor-title h2 \{[\s\S]*?font-size: 12px[\s\S]*?font-weight: 900/);
  assert.match(css, /\.user-prompt-editor-font \{[\s\S]*?border-radius: 999px/);
  assert.match(css, /\.user-prompt-editor-font button\.active \{ background: var\(--ig-text\); color: var\(--ig-panel\)/);
  assert.match(css, /\.user-prompt-editor \{[\s\S]*?border-radius: 12px[\s\S]*?background: var\(--ig-surface\)/);
  assert.match(css, /\.user-prompt-editor-dialog\.font-small \.user-prompt-editor \{ font-size: 12px; \}/);
  assert.match(css, /\.user-prompt-editor-dialog\.font-medium \.user-prompt-editor \{ font-size: 14px; \}/);
  assert.match(css, /\.user-prompt-editor-dialog\.font-large \.user-prompt-editor \{ font-size: 17px; \}/);
  assert.match(css, /\.user-prompt-editor-dialog\.font-xlarge \.user-prompt-editor \{ font-size: 21px;/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.user-prompt-editor-dialog \{[\s\S]*?width: calc\(100vw - 16px\)[\s\S]*?height: calc\(100vh - 16px\)[\s\S]*?resize: none/);
});

test('image generation exposes the shared prompt library beside the large editor', () => {
  assert.match(html, /class="user-prompt-label-row"[\s\S]*?id="openPromptLibrary"[\s\S]*?提示词[\s\S]*?id="openUserPromptEditor"/);
  for (const id of ['imageGenerationPromptDialog', 'imageGenerationPromptTitle', 'imageGenerationPromptSearch', 'imageGenerationPromptLibrarySelect', 'imageGenerationPromptCats', 'imageGenerationPromptBody', 'closeImageGenerationPrompt']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /prompt-template-thumbnails\.css/);
  assert.match(html, /prompt-template-thumbnails\.js/);
  const {imagePromptTemplateCategoryLabel, imagePromptTemplateSearchText} = loadPageModule();
  assert.equal(imagePromptTemplateCategoryLabel('custom'), '我的提示词');
  assert.match(imagePromptTemplateSearchText({name:'电影海报', scene:'产品宣传', positive:'高质感摄影', libraryName:'我的库'}), /电影海报\s+产品宣传\s+高质感摄影\s+我的库/);
  assert.match(js, /async function loadImagePromptLibrary\(\)[\s\S]*?requestJson\('\/api\/prompt-libraries'\)/);
  assert.match(js, /function renderImagePromptLibrary\(\)[\s\S]*?PromptTemplateThumbnails\?\.card/);
  assert.match(js, /async function applyImagePromptTemplate\([\s\S]*?runtime\.readOnlyHistory[\s\S]*?copyImagePromptText/);
  assert.match(js, /async function applyImagePromptTemplate\([\s\S]*?updateUserPrompt\(positive, 'prompt-library'\)/);
  assert.match(js, /imagePromptLibraryState\.lastCardId[\s\S]*?repeated[\s\S]*?applyImagePromptTemplate/);
  assert.match(js, /byId\('openPromptLibrary'\)\.addEventListener\('click', openImagePromptLibrary\)/);
});

test('workbench typography uses only the 16 14 and 12 pixel hierarchy', () => {
  assert.match(css, /\.workbench \{[\s\S]*?--ig-workbench-title-size: 16px;[\s\S]*?--ig-workbench-body-size: 14px;[\s\S]*?--ig-workbench-small-size: 12px;/);
  assert.match(css, /\.workbench-title h2,[\s\S]*?\.workbench \.input-panel \.panel-heading h3,[\s\S]*?\.workbench \.panel-heading \.input-mode-hint,[\s\S]*?\.workbench \.mode-guidance p \{ font-size: var\(--ig-workbench-title-size\); \}/);
  assert.match(css, /\.workbench \.panel-heading \.input-mode-roles,[\s\S]*?\.workbench \.field (?:textarea|input),[\s\S]*?\.workbench #resultPanelTitle[\s\S]*?font-size: var\(--ig-workbench-body-size\)/);
  assert.match(css, /\.workbench \.field input,[\s\S]*?\.workbench \.back-button,[\s\S]*?font-size: var\(--ig-workbench-body-size\)/);
  assert.match(css, /\.workbench \.mode-number,[\s\S]*?\.workbench \.draft-state,[\s\S]*?\.workbench \.candidate-select-action,[\s\S]*?\.workbench \.history-item-status[\s\S]*?font-size: var\(--ig-workbench-small-size\)/);
  assert.match(html, /image-generation\.css\?v=[^"']+/);
  assert.match(html, /image-generation\.js\?v=[^"']+/);
  assert.match(index, /image-generation\.html\?v=[^"']+/);
  assert.match(html, /aria-label="记录删除与 Windows 回收站图片清单"/);
  assert.doesNotMatch(html, /aria-label="将永久删除的内容"/);
});

test('workbench variable messages share the requested neutral tone and emphasis', () => {
  assert.match(css, /\.panel-heading \.input-mode-roles \{[^}]*color: rgb\(0 0 0 \/ 60%\);[^}]*font-size: 14px;/);
  assert.match(css, /\.mode-guidance \{[^}]*color: rgb\(0 0 0 \/ 60%\);/);
  assert.match(css, /\.draft-state \{[^}]*background: var\(--ig-surface-strong\);[^}]*color: rgb\(0 0 0 \/ 60%\);[^}]*font-size: 12px;/);
  assert.match(css, /\.draft-state\.dirty \{[^}]*background: var\(--ig-warm-soft\);[^}]*color: rgb\(0 0 0 \/ 60%\);/);
  assert.match(css, /\.draft-state\.saved \{[^}]*background: var\(--ig-accent-soft\);[^}]*color: rgb\(0 0 0 \/ 60%\);/);
  assert.match(css, /html\.studio-theme-dark \.draft-state,[\s\S]*?html\.theme-dark \.draft-state\.saved \{ color: rgb\(255 255 255 \/ 72%\); \}/);
  assert.match(css, /\.workbench \.mode-guidance p \{ font-size: var\(--ig-workbench-title-size\); \}/);
  assert.match(css, /\.workbench \.panel-heading \.input-mode-hint,[\s\S]*?font-size: var\(--ig-workbench-title-size\)/);
});

test('workbench back control is a prominent return-home button at every viewport', () => {
  assert.match(html, /id="backToModes"[^>]*class="back-button"[^>]*>[\s\S]*?data-lucide="arrow-left"[\s\S]*?<span>返回首页<\/span>/);
  assert.match(html, /id="backToModes"[^>]*title="返回首页（Esc）"[^>]*aria-keyshortcuts="Escape"/);
  assert.doesNotMatch(html, /id="backToModes"[^>]*>[\s\S]*?<span>全部模式<\/span>/);
  assert.match(css, /:root \{[\s\S]*?--ig-command: #111820;[\s\S]*?--ig-on-command: #fff;/);
  assert.match(css, /\.back-button \{[\s\S]*?height: 40px;[\s\S]*?border-color: transparent;[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;[\s\S]*?color: var\(--ig-text\);/);
  assert.match(css, /\.back-button:hover,[\s\S]*?\.back-button:focus-visible \{[\s\S]*?background: color-mix\(in srgb, var\(--ig-command\) 84%, #fff\);[\s\S]*?color: var\(--ig-on-command\);/);
  assert.match(css, /\.back-button svg \{[\s\S]*?width: 29px;[\s\S]*?height: 29px;[\s\S]*?border-radius: 999px;[\s\S]*?background: var\(--ig-command\);[\s\S]*?color: var\(--ig-on-command\);/);
  assert.match(css, /\.back-button:hover svg,[\s\S]*?\.back-button:focus-visible svg \{[\s\S]*?background: transparent;[\s\S]*?color: currentColor;/);
  assert.match(css, /#generateImages \{[^}]*border-color: var\(--ig-command\);[^}]*background: var\(--ig-command\);[^}]*color: var\(--ig-on-command\);/);
  assert.match(css, /#generateImages:hover:not\(:disabled\),\s*#generateImages:active:not\(:disabled\) \{[^}]*background: var\(--ig-command-hover\);/);
  assert.match(css, /\.workbench-title::before \{[^}]*width: 1px;[^}]*height: 24px;[^}]*background: var\(--ig-border\);/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.workbench-header \{[^}]*grid-template-columns: auto minmax\(0, 1fr\) auto;[^}]*\}[\s\S]*?\.back-button span \{ display: inline; \}/);
  assert.doesNotMatch(css, /\.back-button span \{ display: none; \}/);
});

test('Escape returns from the workbench only when no higher-priority interaction owns it', () => {
  assert.match(js, /function editableShortcutTarget\(target\)[\s\S]*?closest\('input, textarea, select, \[contenteditable\]:not\(\[contenteditable="false"\]\)'\)/);
  assert.match(js, /function canLeaveWorkbenchWithEscape\(event\)[\s\S]*?event\.key === 'Escape'[\s\S]*?!event\.defaultPrevented[\s\S]*?!event\.isComposing[\s\S]*?event\.keyCode !== 229[\s\S]*?!event\.repeat/);
  assert.match(js, /canLeaveWorkbenchWithEscape[\s\S]*?!document\.querySelector\('dialog\[open\]'\)[\s\S]*?!editableShortcutTarget\(event\.target\)[\s\S]*?Boolean\(runtime\.currentMode\)[\s\S]*?!byId\('modeWorkbench'\)\?\.hidden/);
  assert.match(js, /document\.addEventListener\('keydown',[\s\S]*?if\(canLeaveWorkbenchWithEscape\(event\)\)\{[\s\S]*?event\.preventDefault\(\);[\s\S]*?leaveWorkbench\(\);[\s\S]*?return;/);
  assert.match(js, /async function leaveWorkbench\(\)[\s\S]*?runtime\.leavingWorkbench[\s\S]*?await imageGenerationSaveDraft\(\{silent:true\}\)/);
});

test('workbench separates saved draft inputs from latest task results', () => {
  for (const id of [
    'modeExample', 'modeInputSlots', 'userPrompt', 'imageProvider', 'imageModel',
    'aspectRatio', 'resolution', 'imageCount', 'modeResults', 'modeHistory',
    'createDraftFromTask', 'newGenerationDraft'
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(js, /\/api\/image-generation\/modes\/\$\{[^}]+\}\/draft/);
  assert.match(js, /\/api\/image-generation-tasks\?mode_id=/);
  assert.match(js, /readOnlyHistory/);
  assert.match(js, /fromTaskInputs/);
  assert.match(js, /const controlsLocked = runtime\.readOnlyHistory \|\| runtime\.submitLocked/);
  assert.match(js, /userPrompt'\)\.readOnly\s*=\s*controlsLocked/);
  assert.match(js, /await imageGenerationSaveDraft\(\{silent:true\}\);[\s\S]{0,220}?await openTask/);
});

test('history viewing stays separate from quick editable re-input', () => {
  assert.match(js, /function applyTaskAsEditable\(task, draftLabel='已重新输入'\)/);
  assert.match(js, /async function reuseTaskInputs\(taskId\)[\s\S]*?applyTaskAsEditable\(task, '参数已载入'\)[\s\S]*?showReadyToGenerateHint\(\)/);
  assert.match(js, /data-candidate-action="reuse-inputs"[\s\S]*?title="再次生成"[\s\S]*?aria-label="再次生成"[\s\S]*?data-lucide="refresh-cw"/);
  const candidateActionsStart = js.indexOf('function candidateActionsHtml');
  const candidateActionsEnd = js.indexOf('function renderGalleryItem', candidateActionsStart);
  const candidateActions = js.slice(candidateActionsStart, candidateActionsEnd);
  const successActionsStart = candidateActions.indexOf('if(url){');
  const successActionsEnd = candidateActions.indexOf('} else if', successActionsStart);
  const successActions = candidateActions.slice(successActionsStart, successActionsEnd);
  assert.ok(successActions.indexOf('download') < successActions.indexOf('reuse-inputs'), 'again action must be last');
  assert.doesNotMatch(successActions, /data-candidate-action="preview"/);
  assert.doesNotMatch(successActions, /data-candidate-action="regenerate"/);
  assert.doesNotMatch(successActions, /重新生成（会产生费用）/);
  const historyStart = js.indexOf('function renderHistory');
  const historyEnd = js.indexOf('async function openTask', historyStart);
  const history = js.slice(historyStart, historyEnd);
  assert.doesNotMatch(history, /showInputs:true/);
  const globalStart = js.indexOf('async function openGlobalTask');
  const globalEnd = js.indexOf('function openGlobalHistory', globalStart);
  assert.doesNotMatch(js.slice(globalStart, globalEnd), /showInputs:true/);
  assert.match(js, /if\(action === 'reuse-inputs'\) return reuseTaskInputs\(taskId\)/);
});

test('re-input status stays visible until the draft changes or generation starts', () => {
  assert.match(js, /function showReadyToGenerateHint\(\)[\s\S]*?setWorkbenchStatus\('参数已载入，可直接生成', false, 'ready'\)[\s\S]*?ready-pulse/);
  assert.match(js, /function markDirty\(\)[\s\S]*?clearReadyToGenerateHint\(\)/);
  assert.match(js, /async function submitGeneration\(\)[\s\S]*?clearReadyToGenerateHint\(\)/);
  assert.match(js, /function setWorkbenchStatus\(message, error=false, kind=''\)[\s\S]*?byId\('workbenchStatusText'\)/);
  assert.match(js, /function clearReadyToGenerateHint\(\)[\s\S]*?classList\.remove\('ready-pulse'\)/);
  assert.doesNotMatch(js, /showToast\('已重新输入，可直接生成'\)/);
});

test('uploads become durable media before draft save and ordering does not reupload', () => {
  assert.match(js, /\/api\/image-generation\/media/);
  assert.match(js, /FormData/);
  assert.match(js, /media_id/);
  assert.match(js, /dragstart/);
  assert.match(js, /imageGenerationSaveDraft/);
  assert.match(js, /const maximum = Math\.min\(6, Number\(mode\?\.max_upload_count\) \|\| 6\)/);
  assert.match(js, /runtime\.currentMode\?\.max_upload_count \|\| 6/);
  assert.match(js, /replacedCount/);
  assert.doesNotMatch(js, /FileReader/);
});

test('slot drag uses insertion ordering without replacing images or labels', () => {
  const drag = functionSource('bindSlotDragEvents', 'openSlotPicker');
  assert.match(drag, /const internalSlotKey = runtime\.draggedSlotKey \|\| event\.dataTransfer\.getData\('text\/plain'\)/);
  assert.match(drag, /const internalDrag = internalSlotKey && runtime\.inputs\.some\(item => item\.slot_key === internalSlotKey && item\.media\)/);
  assert.match(drag, /if\(internalDrag\)\{ reorderSlotMedia\(internalSlotKey, slot\.dataset\.slotKey\); return; \}/);
  assert.match(drag, /if\(event\.dataTransfer\.files\?\.length\)\{ uploadFilesToSlot/);

  const reorder = functionSource('reorderSlotMedia', 'firstEmptySlot');
  assert.match(reorder, /const sourceIndex = runtime\.inputs\.findIndex/);
  assert.match(reorder, /const targetIndex = runtime\.inputs\.findIndex/);
  assert.match(reorder, /const mediaOrder = runtime\.inputs\.map\(item => item\.media\)/);
  assert.match(reorder, /mediaOrder\.splice\(sourceIndex, 1\)/);
  assert.match(reorder, /mediaOrder\.splice\(targetIndex, 0, movedMedia\)/);
  assert.match(reorder, /runtime\.inputs\.forEach\(\(item, index\) => \{ item\.media = mediaOrder\[index\] \|\| null; \}\)/);
  assert.doesNotMatch(reorder, /\[source\.media, target\.media\]/);
});

test('unsaved local drafts retain canonical media previews across reloads', () => {
  assert.match(js, /function currentLocalDraftPayload\(\)/);
  assert.match(js, /media:\{[\s\S]*?id:item\.media\.id,[\s\S]*?url:item\.media\.url \|\| ''/);
  assert.match(js, /runtime\.pendingDrafts\[modeId\] = currentLocalDraftPayload\(\)/);
  assert.match(js, /beforeunload[\s\S]*?currentLocalDraftPayload\(\)/);
});

test('page has responsive, dark-theme and focus-visible contracts', () => {
  assert.match(css, /@media\s*\(max-width:/);
  assert.match(css, /studio-theme-dark|theme-dark/);
  assert.match(css, /:focus-visible/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /data-lucide=/);
});

test('generation locks synchronously and uses an idempotent submission UUID', () => {
  assert.match(js, /crypto\.randomUUID\(\)/);
  assert.match(js, /runtime\.submitLocked\s*=\s*true/);
  assert.match(js, /submission_id:submissionId/);
  assert.match(js, /submissionIdForKind\(runtime\.submissionIds, submissionKind/);
  assert.match(js, /force_new:Boolean\(forceNew\)/);
  assert.doesNotMatch(html, /id="forceGenerateImages"/);
  assert.doesNotMatch(js, /forceGenerateImages/);
  assert.doesNotMatch(js, /绕过相同配置复用/);
  assert.match(js, /function effectiveOutputSize\(\)/);
  const lock = js.indexOf('runtime.submitLocked = true');
  const firstAwait = js.indexOf('await', lock);
  assert.ok(lock >= 0 && firstAwait > lock, 'submit lock must be set before the first await');
});

test('each deliberate generate click creates a new group while request retries stay idempotent', () => {
  const submitStart = js.indexOf('async function submitGeneration');
  const submitEnd = js.indexOf('function emitImageGenerationsChanged', submitStart);
  assert.ok(submitStart >= 0 && submitEnd > submitStart, 'missing source function submitGeneration');
  const submit = js.slice(submitStart, submitEnd);
  assert.match(submit, /submissionIdForKind\(runtime\.submissionIds, submissionKind/);
  assert.match(submit, /generationTaskPayload\(true, submissionId\)/);
  assert.match(submit, /acceptedTaskId = taskId[\s\S]*?runtime\.submissionIds\.delete\(submissionKind\)/);
  assert.match(submit, /result\.reused \? '本次提交已受理，不会重复扣费'/);
  assert.doesNotMatch(submit, /已打开相同配置的现有任务/);
});

test('generation count defaults and every display fallback use one image', () => {
  assert.match(js, /const DEFAULT_SETTINGS = \{[\s\S]*?image_count:1/);
  assert.match(html, /id="imageCount"><option selected>1<\/option>/);
  assert.match(js, /imageCount'\)\.value = String\(runtime\.settings\.image_count \|\| 1\)/);
  assert.doesNotMatch(js, /image_count\s*:\s*4|image_count\s*\|\|\s*4|selected>4<\/option>/);
});

test('image generation exposes the complete canvas ratio set and special ratio modes', () => {
  const fixedRatios = ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9', '9:21'];
  for (const ratio of fixedRatios) {
    assert.match(html, new RegExp(`<option value="${ratio.replace(':', '\\:')}">${ratio.replace(':', '\\:')}</option>`));
  }
  assert.match(html, /<option value="source">拉伸适配<\/option>/);
  assert.match(html, /<option value="adaptive">自适应<\/option>/);
  assert.match(html, /<option value="custom">自定义<\/option>/);
  assert.match(html, /id="customRatioFields"/);
  assert.match(html, /id="customRatioWidth"/);
  assert.match(html, /id="customRatioHeight"/);
  assert.match(html, /id="sourceRatioHint"/);
  assert.match(html, /\/static\/js\/adaptive-image-ratio\.js/);
});

test('ratio resolver keeps old records compatible and validates source adaptive and custom modes', () => {
  const {normalizeGenerationRatioSettings, resolveGenerationRatio} = loadPageModule();
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalizeGenerationRatioSettings({aspect_ratio:'4:5', resolution:'2k'}))),
    {ratio_mode:'fixed', aspect_ratio:'4:5', custom_ratio_width:'', custom_ratio_height:''},
  );
  const source = resolveGenerationRatio(
    {ratio_mode:'source', aspect_ratio:'', resolution:'2k'},
    [{media:{id:'input-1', width:1600, height:900}}],
  );
  assert.equal(source.valid, true);
  assert.equal(source.aspect_ratio, '16:9');
  assert.equal(source.stretch_aspect_ratio, '16:9');
  assert.match(source.display_label, /16:9/);
  assert.match(source.size, /^\d+x\d+$/);

  const missingSource = resolveGenerationRatio({ratio_mode:'source', resolution:'2k'}, []);
  assert.equal(missingSource.valid, false);
  assert.match(missingSource.error, /图片/);

  const adaptive = resolveGenerationRatio({ratio_mode:'adaptive', resolution:'4k'}, []);
  assert.equal(adaptive.valid, true);
  assert.equal(adaptive.aspect_ratio, '');
  assert.equal(adaptive.size, 'auto');
  assert.equal(adaptive.display_label, '自适应');

  const custom = resolveGenerationRatio({ratio_mode:'custom', custom_ratio_width:'5', custom_ratio_height:'7', resolution:'1k'}, []);
  assert.equal(custom.valid, true);
  assert.equal(custom.aspect_ratio, '5:7');
  assert.match(custom.size, /^\d+x\d+$/);
  assert.equal(resolveGenerationRatio({ratio_mode:'custom', custom_ratio_width:'0', custom_ratio_height:'7'}, []).valid, false);
  assert.equal(resolveGenerationRatio({ratio_mode:'custom', custom_ratio_width:'1.5', custom_ratio_height:'7'}, []).valid, false);
  const restoredCustom = normalizeGenerationRatioSettings({ratio_mode:'custom', aspect_ratio:'4:5'});
  assert.equal(restoredCustom.custom_ratio_width, '4');
  assert.equal(restoredCustom.custom_ratio_height, '5');
  assert.match(js, /value === 'custom'[\s\S]*?custom_ratio_width[\s\S]*?custom_ratio_height/);
});

test('fixed ratio selection clears any stale unsupported-ratio hint', () => {
  const {ratioHintView} = loadPageModule();
  assert.deepEqual(
    JSON.parse(JSON.stringify(ratioHintView({ratio_mode:'fixed', aspect_ratio:'4:1', resolution:'4k'}, []))),
    {hidden:true, text:'', error:false},
  );
});

test('draft changes and a new generation clear a previous submission error', () => {
  const markDirty = functionSource('markDirty', 'requiredSlotsFilled');
  const submitStart = js.indexOf('async function submitGeneration');
  const submitEnd = js.indexOf('function emitImageGenerationsChanged', submitStart);
  assert.ok(submitStart >= 0 && submitEnd > submitStart, 'missing source function submitGeneration');
  const submitGeneration = js.slice(submitStart, submitEnd);
  assert.match(js, /function clearWorkbenchErrorStatus\(\)[\s\S]*?classList\.contains\('error'\)[\s\S]*?setWorkbenchStatus\('\'\)/);
  assert.match(markDirty, /clearWorkbenchErrorStatus\(\)/);
  assert.match(submitGeneration, /clearWorkbenchErrorStatus\(\)/);
});

test('preview uses a large complete-image canvas with bottom comparison tools', () => {
  for (const id of ['previewStage', 'previewImage', 'previewSourceImage', 'previewSourceLayer', 'previewCompareSlider', 'previewCompareModes', 'previewAlignModes', 'previewZoomLabel', 'previewResetView']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const mode of ['single', 'slider', 'side-by-side']) assert.match(html, new RegExp(`data-preview-mode="${mode}"`));
  for (const align of ['fit', 'stretch', 'width', 'height']) assert.match(html, new RegExp(`data-preview-align="${align}"`));
  assert.doesNotMatch(html, /快闪/);
  assert.match(html, /id="previewResetView"[\s\S]*?data-preview-align="stretch"/);
  assert.match(html, /<div id="previewStage"[\s\S]*?<div class="preview-panzoom"[\s\S]*?id="previewCompareSlider"/);
  assert.match(html, /<div class="preview-toolbar"[\s\S]*?id="previewAlignModes"[\s\S]*?id="previewCompareModes"/);
  assert.doesNotMatch(html, /class="preview-image-label"/);
  assert.doesNotMatch(html, /data-lucide="panel-left-right"/, 'bundled Lucide does not provide this icon');
  assert.match(css, /\.preview-stage[\s\S]*?object-fit:\s*contain/);
  assert.match(css, /\.preview-dialog \{ width: min\(98vw, 1680px\); height: min\(96vh, 1120px\)/);
  assert.match(css, /\.preview-stage \{[\s\S]*?background: #080a0b/);
  assert.match(css, /\.preview-toolbar \{[\s\S]*?grid-template-columns:/);
  assert.match(css, /\.preview-panzoom \{[\s\S]*?position: absolute[\s\S]*?min-height: 0/);
  assert.doesNotMatch(css, /\.preview-panzoom \{[^}]*will-change: transform/);
  assert.match(css, /\.preview-compare-slider \{[\s\S]*?cursor: ew-resize[\s\S]*?touch-action: none/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.preview-toolbar \{ grid-template-columns: 1fr/);
  assert.match(css, /\.preview-stage\[data-preview-align="fit"\][\s\S]*?object-fit: contain/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.preview-panzoom/);
  assert.doesNotMatch(css, /blink/);
  assert.match(css, /\.preview-shell[\s\S]*?background:\s*var\(--ig-panel\)/);
  assert.match(js, /function setPreviewMode\(/);
  assert.match(js, /const PREVIEW_MODES = new Set\(\['single','slider','side-by-side'\]\)/);
  assert.match(js, /const PREVIEW_ALIGN_MODES = new Set\(\['fit','stretch','width','height'\]\)/);
  assert.doesNotMatch(js, /previewBlink/);
  assert.match(js, /stage\.addEventListener\('dblclick'[\s\S]*?currentMode === 'single'[\s\S]*?setPreviewMode\('slider'\)[\s\S]*?currentMode === 'slider'[\s\S]*?setPreviewMode\('single'\)/);
  assert.match(js, /stage\.addEventListener\('wheel'[\s\S]*?setPreviewZoomAt/);
  assert.match(js, /stage\.addEventListener\('pointerdown'[\s\S]*?previewPanDrag/);
  assert.match(js, /function previewSliderPercentAt\(clientX\)[\s\S]*?frame\?\.getBoundingClientRect\(\)[\s\S]*?return \(\(clientX - rect\.left\) \/ rect\.width\) \* 100/);
  assert.match(js, /function queuePreviewSliderPosition\(clientX\)[\s\S]*?requestAnimationFrame\(flushPreviewSliderPosition\)/);
  assert.match(js, /slider\.addEventListener\('pointerdown'[\s\S]*?slider\.setPointerCapture/);
  assert.match(js, /slider\.addEventListener\('pointermove'[\s\S]*?queuePreviewSliderPosition\(event\.clientX\)/);
  assert.match(js, /slider\.addEventListener\('keydown'[\s\S]*?event\.key !== 'ArrowLeft'[\s\S]*?setPreviewSlider\(Number\(slider\.value\)/);
  assert.match(js, /event\.target === byId\('previewCompareSlider'\)\) return/);
  assert.match(js, /function resetPreviewView\(\)[\s\S]*?setPreviewAlign\('fit'\)[\s\S]*?resetPreviewTransform/);
  assert.match(js, /setPreviewMode\('single'\)/);
  assert.match(js, /previewMode:stage\?\.dataset\.previewMode/);
  assert.match(js, /class="candidate-preview-trigger"[\s\S]*?data-candidate-action="preview"/);
  const {previewSourceUrl} = loadPageModule();
  assert.equal(previewSourceUrl({inputs:[{media:{url:'/media/input.png'}}]}), '/media/input.png');
  assert.equal(previewSourceUrl({inputs:[]}), '');
});

test('side-by-side preview keeps fixed panes while zooming and panning both images together', () => {
  const {linkedSidePreviewZoomState} = loadPageModule();
  assert.deepEqual(
    JSON.parse(JSON.stringify(linkedSidePreviewZoomState(1, {x:0, y:0}, 2))),
    {zoom:2, pan:{x:0, y:0}},
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(linkedSidePreviewZoomState(2, {x:40, y:-30}, 3))),
    {zoom:3, pan:{x:60, y:-45}},
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(linkedSidePreviewZoomState(3, {x:60, y:-45}, .8))),
    {zoom:1, pan:{x:0, y:0}},
  );
  const transform = functionSource('applyPreviewTransform', 'resetPreviewTransform');
  assert.match(transform, /frame\.style\.transform = ''/);
  assert.match(transform, /\[byId\('previewImage'\), byId\('previewSourceImage'\)\][\s\S]*?image\.style\.transform = linkedTransform/);
  assert.doesNotMatch(transform, /scale\(\$\{previewZoom\}\)/);
  const zoom = functionSource('setPreviewZoomAt', 'bindPreviewViewportEvents');
  assert.match(zoom, /stage\.dataset\.previewMode === 'side-by-side'[\s\S]*?linkedSidePreviewZoomState/);
  assert.match(css, /\.preview-stage\[data-preview-mode="side-by-side"\] \.preview-panzoom \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)[\s\S]*?gap: 1px[\s\S]*?transform: none/);
  assert.match(css, /\.preview-stage\[data-preview-mode="side-by-side"\] \.preview-image-frame img \{[\s\S]*?transform-origin: 50% 50%/);
});

test('preview keeps slider dragging separate from Space-assisted canvas panning', () => {
  const {previewPointerIntent} = loadPageModule();
  assert.equal(typeof previewPointerIntent, 'function');
  assert.equal(previewPointerIntent({mode:'single', zoom:2, spaceHeld:false, button:0}), '');
  assert.equal(previewPointerIntent({mode:'side-by-side', zoom:2, spaceHeld:false, button:0}), '');
  assert.equal(previewPointerIntent({mode:'slider', zoom:2, spaceHeld:false, button:0}), 'slider');
  assert.equal(previewPointerIntent({mode:'slider', zoom:2, spaceHeld:true, button:0}), 'pan');
  assert.equal(previewPointerIntent({mode:'slider', zoom:1, spaceHeld:true, button:0}), 'blocked');
  assert.equal(previewPointerIntent({mode:'single', zoom:2, spaceHeld:true, button:1}), '');
});

test('preview zoom enlarges the real image layout instead of scaling a rasterized layer', () => {
  const {previewImageRenderLayout} = loadPageModule();
  assert.equal(typeof previewImageRenderLayout, 'function');
  assert.deepEqual(
    JSON.parse(JSON.stringify(previewImageRenderLayout('fit', 3.9))),
    {width:'390%', height:'390%', maxWidth:'none', maxHeight:'none', objectFit:'contain'},
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(previewImageRenderLayout('width', 2.5))),
    {width:'250%', height:'auto', maxWidth:'none', maxHeight:'none', objectFit:'contain'},
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(previewImageRenderLayout('height', 2))),
    {width:'auto', height:'200%', maxWidth:'none', maxHeight:'none', objectFit:'contain'},
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(previewImageRenderLayout('stretch', 1.2))),
    {width:'120%', height:'120%', maxWidth:'none', maxHeight:'none', objectFit:'fill'},
  );
});

test('uploaded input images open the original in the shared single-image preview', () => {
  assert.match(js, /function openImagePreview\(url, \{alt='图片预览', sourceUrl='', previewMode='single', previewAlign='fit'\}=\{\}\)/);
  assert.match(js, /function previewUploadedImage\(slotKey\)/);
  assert.match(js, /openImagePreview\(url, \{alt:`\$\{slot\?\.label \|\| '上传图片'\}原图预览`\}\)/);
  assert.match(js, /byId\('previewCompareModes'\)\.hidden = !sourceUrl/);
  assert.match(css, /\.slot-preview-trigger \{ cursor: zoom-in; \}/);
  assert.match(css, /\.slot-image \{[\s\S]*?object-fit: contain[\s\S]*?object-position: center/);
  assert.match(css, /\.slot-preview-trigger:focus-visible \{[\s\S]*?outline: 2px solid var\(--ig-accent\)/);
});

test('changing generation count updates the primary action label immediately', () => {
  assert.match(js, /function syncGenerateButtonLabel\(\)/);
  assert.match(js, /imageCount'\)\.addEventListener\('change',[\s\S]*?syncGenerateButtonLabel\(\); markDirty\(\)/);
});

test('submission UUID is reset on every draft or history context change', () => {
  assert.match(js, /function resetSubmissionContext\(\)\{[\s\S]*?submissionIds\.clear\(\)/);
  assert.doesNotMatch(js, /forceRepeatAvailable/);
  for (const pattern of [
    /function blankDraft\(\)\{\s*resetSubmissionContext\(\)/,
    /function applyDraft\(draft\)\{\s*resetSubmissionContext\(\)/,
    /function applyTaskAsReadonly\(task\)\{\s*resetSubmissionContext\(\)/,
    /function fromTaskInputs\(\)\{[\s\S]*?if\(!task\) return;[\s\S]*?resetSubmissionContext\(\)/,
    /function startNewDraft\(\)\{[\s\S]*?resetSubmissionContext\(\)/,
    /async function selectMode\(modeId\)\{[\s\S]*?resetSubmissionContext\(\)/,
  ]) assert.match(js, pattern);
  assert.match(js, /function markDirty\(\)[\s\S]*?if\(!runtime\.submitLocked\) resetSubmissionContext\(\)/);
  const submit = js.slice(js.indexOf('async function submitGeneration'), js.indexOf('function emitImageGenerationsChanged'));
  const caught = submit.slice(submit.indexOf('} catch(error)'), submit.indexOf('} finally'));
  assert.doesNotMatch(caught, /resetSubmissionContext/, 'ambiguous submit failure must retain the exact draft UUID');
});

test('normal submission UUID is retained and reused until its request is accepted', () => {
  const {submissionIdForKind} = loadPageModule();
  const ids = new Map();
  let sequence = 0;
  const create = () => `uuid-${++sequence}`;
  const normal = submissionIdForKind(ids, 'normal', create);
  assert.equal(submissionIdForKind(ids, 'normal', create), normal);
  assert.equal(sequence, 1);
  ids.delete('normal');
  assert.equal(ids.has('normal'), false, 'accepted normal submission clears its UUID');
});

test('accepted task refresh failures are never described as submission failures', () => {
  const {submissionFailureMessage} = loadPageModule();
  assert.equal(
    submissionFailureMessage('accepted-task-id', new Error('refresh exploded')),
    '任务已创建，结果刷新失败，后台继续运行',
  );
  assert.equal(submissionFailureMessage('', new Error('submit disconnected')), 'submit disconnected');
  const submit = js.slice(js.indexOf('async function submitGeneration'), js.indexOf('function emitImageGenerationsChanged'));
  const accepted = submit.indexOf('acceptedTaskId = taskId');
  const deleteKind = submit.indexOf('runtime.submissionIds.delete(submissionKind)', accepted);
  const refresh = submit.indexOf('await openTask(taskId)', accepted);
  assert.ok(accepted >= 0 && deleteKind > accepted && refresh > deleteKind, 'acceptance must clear only that kind before refresh');
  assert.match(submit, /if\(!await openTask\(taskId\)\) throw new Error\('任务详情刷新失败'\)/);
  assert.match(submit, /submissionFailureMessage\(taskId, refreshError\)/);
});

test('submission blocks context navigation and keeps the captured mode identity', () => {
  assert.match(js, /function blockContextChangeWhileSubmitting\(\)[\s\S]*?任务正在提交，请等待提交完成后再切换页面或历史记录/);
  for (const name of ['selectMode', 'leaveWorkbench', 'openGlobalTask']) {
    const start = js.indexOf(`async function ${name}`);
    const next = js.indexOf('\n    function ', start + 1);
    const nextAsync = js.indexOf('\n    async function ', start + 1);
    const candidates = [next, nextAsync].filter(index => index > start);
    const end = candidates.length ? Math.min(...candidates) : js.length;
    const body = js.slice(start, end);
    const block = body.indexOf('blockContextChangeWhileSubmitting()');
    const firstAwait = body.indexOf('await');
    assert.ok(block >= 0 && (firstAwait < 0 || block < firstAwait), `${name} must block before its first await`);
  }
  const submit = js.slice(js.indexOf('async function submitGeneration'), js.indexOf('function emitImageGenerationsChanged'));
  const captureId = submit.indexOf("const submittedModeId = String(runtime.currentMode.id || '')");
  const captureName = submit.indexOf("const submittedModeName = String(runtime.currentMode.display_name || '')");
  const firstAwait = submit.indexOf('await');
  assert.ok(captureId >= 0 && captureName >= 0 && captureId < firstAwait && captureName < firstAwait);
  assert.match(submit, /rememberTask\(\{id:taskId, mode_id:submittedModeId, mode_name:submittedModeName/);
  assert.match(submit, /if\(String\(runtime\.currentMode\?\.id \|\| ''\) === submittedModeId\)[\s\S]*?await openTask\(taskId\)/);
  assert.match(submit, /if\(String\(runtime\.currentMode\?\.id \|\| ''\) === submittedModeId\)[\s\S]*?await loadModeTasks\(submittedModeId/);
});

test('global history saves the current draft before a non-redundant mode switch', () => {
  const start = js.indexOf('async function openGlobalTask');
  const end = js.indexOf('function openGlobalHistory', start);
  const handler = js.slice(start, end);
  const save = handler.indexOf('await imageGenerationSaveDraft({silent:true})');
  const select = handler.indexOf('await selectMode(modeId)');
  assert.ok(save >= 0 && select > save, 'dirty draft must be saved before selecting another mode');
  assert.match(handler, /if\(modeId && runtime\.currentMode\?\.id !== modeId\)[\s\S]*?if\(!await selectMode\(modeId\)\) return false/);
});

test('background polling follows every active task across mode switches', () => {
  assert.match(js, /activeTaskIds:new Set\(\)/);
  assert.match(js, /for\(const taskId of \[\.\.\.runtime\.activeTaskIds\]\)/);
  assert.match(js, /setTimeout\(pollActiveTasks/);
  assert.doesNotMatch(js, /selectMode[\s\S]{0,800}clearInterval/);
  assert.match(js, /image-generations-changed/);
});

test('mode history loads all 200 records and task actions preserve the viewed task', () => {
  assert.match(js, /image-generation-tasks\?mode_id=\$\{encodeURIComponent\(modeId\)\}&limit=200/);
  assert.doesNotMatch(js, /image-generation-tasks\?mode_id=\$\{encodeURIComponent\(modeId\)\}&limit=100/);
  assert.match(js, /if\(refreshMode && runtime\.currentMode\) await loadModeTasks\(runtime\.currentMode\.id, \{preserveViewed:true\}\)/);
});

test('summary-only history infers partial success without weakening full candidate status', () => {
  const {taskVisualStatus} = loadPageModule();
  assert.equal(taskVisualStatus({
    status: 'succeeded', candidate_count: 4, successful_candidate_count: 2,
  }), 'partial');
  assert.equal(taskVisualStatus({
    status: 'succeeded', candidate_count: 4, successful_candidate_count: 4,
  }), 'succeeded');
  assert.equal(taskVisualStatus({
    status: 'succeeded', candidates: [{status: 'succeeded'}, {status: 'failed'}],
  }), 'partial');
  assert.equal(taskVisualStatus({
    status: 'succeeded', candidates: [{status: 'succeeded'}, {status: 'succeeded'}],
  }), 'succeeded');
  assert.equal(taskVisualStatus({
    status: 'deleted', candidate_count: 0, successful_candidate_count: 0, results_deleted: true,
  }), 'deleted');
  assert.equal(taskVisualStatus({
    status: 'failed', candidate_count: 0, successful_candidate_count: 0,
  }), 'deleted', 'legacy records emptied before the deleted marker existed stay compatible');
  assert.equal(taskVisualStatus({
    status: 'failed', candidate_count: 1, successful_candidate_count: 0,
  }), 'failed');
  assert.match(js, /function renderHistory\(\)[\s\S]*?taskStatusLabel\(task\)/);
});

test('global status filters use visual status exclusively for terminal records', () => {
  const {taskMatchesStatusFilter} = loadPageModule();
  const partial = {status: 'succeeded', candidate_count: 4, successful_candidate_count: 2};
  assert.equal(taskMatchesStatusFilter(partial, 'partial'), true);
  assert.equal(taskMatchesStatusFilter(partial, 'succeeded'), false);
  assert.equal(taskMatchesStatusFilter({status: 'succeeded', candidate_count: 4, successful_candidate_count: 4}, 'succeeded'), true);
  assert.equal(taskMatchesStatusFilter({status: 'generating'}, 'active'), true);
  assert.match(js, /if\(!taskMatchesStatusFilter\(task, status\)\) return false/);
  assert.doesNotMatch(js, /visual !== status && String\(task\.status/);
});

test('read-only history uses its saved mode snapshot while editable copies adapt to current mode', () => {
  const readonlyStart = js.indexOf('function applyTaskAsReadonly');
  const copyStart = js.indexOf('function fromTaskInputs', readonlyStart);
  const readonly = js.slice(readonlyStart, copyStart);
  const copyEnd = js.indexOf('function startNewDraft', copyStart);
  const editableCopy = js.slice(copyStart, copyEnd);
  assert.match(readonly, /task\?\.mode_snapshot/);
  assert.match(readonly, /normalizeInputsForMode\(modeSnapshot, task\?\.inputs \|\| \[\]\)/);
  assert.match(editableCopy, /normalizeInputsForMode\(runtime\.currentMode, task\.inputs \|\| \[\]\)/);
  assert.match(js, /function inputModeDefinition\(\)[\s\S]*?runtime\.readOnlyHistory[\s\S]*?snapshot[\s\S]*?: runtime\.currentMode/);
  assert.match(js, /function syncInputModeHint\(\)[\s\S]*?inputModeDefinition\(\)[\s\S]*?slotDefinitions\(mode\)/);
});

test('candidate and task actions keep recovery separate from paid regeneration', () => {
  assert.match(js, /\/candidates\/\$\{encodeURIComponent\(candidateId\)\}\/recover/);
  assert.match(js, /\/candidates\/\$\{encodeURIComponent\(candidateId\)\}\/regenerate/);
  assert.match(js, /confirm_cost:true/);
  assert.match(js, /submission_id:submissionId/);
  assert.match(js, /download\.zip/);
  assert.match(js, /\/cancel/);
  assert.match(js, /method:'DELETE'/);
});

test('unknown candidate action requires an explicit recoverable flag', () => {
  const {unknownCandidateAction, candidateStatusLabel, candidateUnknownReason, taskStatusLabel} = loadPageModule();
  assert.equal(unknownCandidateAction({status: 'unknown', recoverable: true}), 'recover');
  assert.equal(unknownCandidateAction({status: 'unknown', recoverable: false}), '');
  assert.equal(unknownCandidateAction({status: 'unknown'}), '');
  assert.equal(unknownCandidateAction({status: 'failed', recoverable: true}), '');
  assert.equal(candidateStatusLabel({status: 'unknown', recoverable: true}), '待回补');
  assert.equal(candidateStatusLabel({status: 'unknown', recoverable: false}), '结果未知');
  assert.equal(candidateUnknownReason({status: 'unknown', recoverable: false, error: '上游连接中断'}), '上游连接中断');
  assert.equal(candidateUnknownReason({status: 'unknown', recoverable: false, error: ''}), '上游连接中断，未返回任务编号；无法安全回补');
  assert.equal(taskStatusLabel({status: 'unknown', candidates: [{status: 'unknown', recoverable: false}]}), '结果未知');
  assert.equal(taskStatusLabel({status: 'unknown', candidates: [{status: 'unknown', recoverable: true}]}), '待回补');
  assert.equal(taskStatusLabel({status: 'unknown'}), '结果未知');
  const start = js.indexOf('function candidateActionsHtml');
  const end = js.indexOf('function renderResults', start);
  const actions = js.slice(start, end);
  assert.match(actions, /unknownCandidateAction\(candidate\) === 'recover'/);
  assert.doesNotMatch(actions, /unknownCandidateAction\(candidate\) === 'regenerate'/);
  const item = functionSource('renderGalleryItem', 'resultSelectionLabel');
  assert.match(item, /candidateStatusLabel\(candidate\)/);
  assert.match(item, /candidateUnknownReason\(candidate\)/);
  assert.match(css, /\.candidate-unknown-reason\s*\{[\s\S]*?overflow-wrap: anywhere/);
});

test('image generation completion sound classifies terminal outcomes and transitions once', () => {
  const {taskCompletionOutcome, completionTransitionOutcome} = loadPageModule();
  const success = {id: 'task-success', status: 'succeeded', candidate_count: 3, candidates: [
    {status: 'succeeded'}, {status: 'failed'}, {status: 'succeeded'},
  ]};
  const failure = {id: 'task-failure', status: 'failed', candidate_count: 2, candidates: [
    {status: 'failed'}, {status: 'failed'},
  ]};
  const unknown = {id: 'task-unknown', status: 'unknown', candidate_count: 2, candidates: [
    {status: 'unknown'}, {status: 'unknown'},
  ]};
  assert.equal(taskCompletionOutcome(success), 'success');
  assert.equal(taskCompletionOutcome(failure), 'failure');
  assert.equal(taskCompletionOutcome(unknown), '');
  assert.equal(taskCompletionOutcome({status: 'cancelled', candidate_count: 1, candidates: [{status: 'cancelled'}]}), '');
  assert.equal(completionTransitionOutcome({status: 'generating'}, success), 'success');
  assert.equal(completionTransitionOutcome({status: 'generating'}, failure), 'failure');
  assert.equal(completionTransitionOutcome({status: 'succeeded'}, success), '');
  assert.equal(completionTransitionOutcome({status: 'generating'}, unknown), '');
  assert.match(js, /completionNoticeTaskIds/);
  assert.match(js, /document\.visibilityState\s*!==\s*['"]hidden['"]/);
  assert.match(js, /playImageGenerationCompletionSound/);
  assert.match(js, /660[\s\S]*880/);
  assert.match(js, /440[\s\S]*330/);
});

test('image generation completion sound plays the selected tone once and respects visibility', () => {
  const frequencies = [];
  class FakeAudioContext {
    constructor(){ this.currentTime = 0; this.state = 'running'; this.destination = {}; }
    createOscillator(){
      const oscillator = {
        type: '',
        frequency: {setValueAtTime: value => frequencies.push(value)},
        connect: () => oscillator,
        start: () => {},
        stop: () => {},
      };
      return oscillator;
    }
    createGain(){
      const gain = {
        gain: {setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {}},
        connect: () => gain,
      };
      return gain;
    }
  }
  const document = {visibilityState: 'visible', readyState: 'loading', addEventListener: () => {}};
  const page = loadPageModule({window: {AudioContext: FakeAudioContext}, document});
  assert.equal(page.maybePlayTaskCompletionSound({id: 'task-1', status: 'generating'}, {id: 'task-1', status: 'succeeded', candidates: [{status: 'succeeded'}]}), 'success');
  assert.equal(page.maybePlayTaskCompletionSound({id: 'task-1', status: 'generating'}, {id: 'task-1', status: 'succeeded', candidates: [{status: 'succeeded'}]}), '');
  assert.deepEqual(frequencies, [660, 880]);
  assert.equal(page.maybePlayTaskCompletionSound({id: 'task-1', status: 'generating'}, {id: 'task-1', status: 'generating'}), '');
  assert.equal(page.maybePlayTaskCompletionSound({id: 'task-1', status: 'generating'}, {id: 'task-1', status: 'succeeded', candidates: [{status: 'succeeded'}]}), 'success');
  document.visibilityState = 'hidden';
  assert.equal(page.maybePlayTaskCompletionSound({id: 'task-2', status: 'generating'}, {id: 'task-2', status: 'failed', candidates: [{status: 'failed'}]}), '');
  assert.deepEqual(frequencies, [660, 880]);

  const failureFrequencies = [];
  class FailureAudioContext extends FakeAudioContext {
    createOscillator(){
      const oscillator = super.createOscillator();
      oscillator.frequency.setValueAtTime = value => failureFrequencies.push(value);
      return oscillator;
    }
  }
  const failurePage = loadPageModule({window: {AudioContext: FailureAudioContext}, document: {visibilityState: 'visible', readyState: 'loading', addEventListener: () => {}}});
  assert.equal(failurePage.playImageGenerationCompletionSound('failure'), undefined);
  assert.deepEqual(failureFrequencies, [440, 330]);
});

test('candidate actions lock synchronously and regeneration reuses one operation UUID', () => {
  const start = js.indexOf('async function handleCandidateAction');
  const end = js.indexOf('async function handleTaskAction', start);
  assert.ok(start >= 0 && end > start, 'candidate action handler must exist');
  const handler = js.slice(start, end);
  assert.match(handler, /const actionKey = `\$\{taskId\}:\$\{candidateId\}:\$\{action\}`/);
  assert.match(handler, /const regenerationKey = `\$\{taskId\}:\$\{candidateId\}:regenerate`/);
  assert.match(handler, /candidateActionLocks\.has\(actionKey\)[\s\S]*?return/);
  const lockIndex = handler.indexOf('candidateActionLocks.add(actionKey)');
  const firstAwait = handler.indexOf('await');
  assert.ok(lockIndex >= 0 && firstAwait > lockIndex, 'candidate lock must be acquired before the first await');
  assert.match(handler, /regenerationSubmissions\.get\(regenerationKey\)/);
  assert.match(handler, /submissionId = crypto\.randomUUID\(\)/);
  assert.match(handler, /regenerationSubmissions\.set\(regenerationKey, submissionId\)/);
  assert.match(handler, /if\(!confirm\([\s\S]*?regenerationSubmissions\.delete\(regenerationKey\)[\s\S]*?return/);
  assert.match(handler, /requestSent = true;[\s\S]*?\/regenerate/);
  assert.match(handler, /submission_id:submissionId/);
  assert.doesNotMatch(handler, /submission_id:crypto\.randomUUID\(\)/);
  assert.match(handler, /catch\(error\)[\s\S]*?action === 'regenerate' && !requestSent[\s\S]*?delete\(regenerationKey\)/);
  assert.match(handler, /finally\s*\{[\s\S]*?candidateActionLocks\.delete\(actionKey\)/);
});

test('accepted regeneration adopts the returned task and keeps its idempotency UUID', () => {
  const start = js.indexOf('async function handleCandidateAction');
  const end = js.indexOf('async function handleTaskAction', start);
  const handler = js.slice(start, end);
  const acceptedStart = handler.indexOf("result = await requestJson(`/api/image-generation-tasks/${encodeURIComponent(taskId)}/candidates/${encodeURIComponent(candidateId)}/regenerate`");
  const acceptedEnd = handler.indexOf('emitImageGenerationsChanged(action)', acceptedStart);
  assert.ok(acceptedStart >= 0 && acceptedEnd > acceptedStart, 'regeneration acceptance branch must exist');
  const accepted = handler.slice(acceptedStart, acceptedEnd);
  assert.match(accepted, /actionAccepted = true/);
  assert.match(accepted, /const returnedTask = result\?\.task/);
  assert.match(accepted, /adoptTaskSnapshot\(returnedTask/);
  assert.doesNotMatch(accepted, /regenerationSubmissions\.delete\(regenerationKey\)/, 'accepted paid action must retain its UUID');
  assert.match(handler, /重新生成已受理，结果刷新失败，后台继续运行/);
});

test('archived mode history opens from the task snapshot and stays read-only', () => {
  const {modeContextFromTask} = loadPageModule();
  const context = modeContextFromTask({
    mode_id:'archived-mode', mode_name:'旧证件照',
    mode_snapshot:{reference_images:[{key:'portrait', required:true}], max_upload_count:2},
  });
  assert.equal(context.id, 'archived-mode');
  assert.equal(context.display_name, '旧证件照');
  assert.equal(context.status, 'archived');
  assert.equal(context.max_upload_count, 2);
  const archivedStart = js.indexOf('async function openArchivedTask');
  const archivedEnd = js.indexOf('async function openGlobalTask', archivedStart);
  const archived = js.slice(archivedStart, archivedEnd);
  assert.match(archived, /modeContextFromTask\(task\)/);
  assert.match(archived, /runtime\.currentMode = modeContext/);
  assert.match(archived, /applyTaskAsReadonly\(task\)/);
  assert.match(js, /if\(!modeIsActive\) return await openArchivedTask\(taskId, modeId\)/);
  assert.match(js, /createDraftFromTask'\)\.disabled = runtime\.submitLocked \|\| !modeActive/);
  assert.match(js, /if\(!currentModeIsActive\(\)\) return showToast\('这个模式已归档，不能再创建生成草稿'/);
  assert.match(js, /const canGenerate = currentModeIsActive\(\)/);
  assert.match(js, /if\(action === 'regenerate' && !currentModeIsActive\(\)\) return showToast\('这个模式已归档，不能重新生成图片'/);
});

test('mode and task navigation ignore stale slower responses', () => {
  const {isLatestNavigation} = loadPageModule();
  assert.equal(isLatestNavigation(4, 4), true);
  assert.equal(isLatestNavigation(3, 4), false);
  assert.match(js, /modeNavigationVersion:0, taskNavigationVersion:0/);
  const taskStart = js.indexOf('async function openTask');
  const taskEnd = js.indexOf('async function loadModeTasks', taskStart);
  const openTask = js.slice(taskStart, taskEnd);
  assert.match(openTask, /const navigationVersion = requestVersion \|\| \+\+runtime\.taskNavigationVersion/);
  assert.match(openTask, /if\(!isLatestNavigation\(navigationVersion, runtime\.taskNavigationVersion\)\) return false/);
  const historyStart = js.indexOf('function renderHistory');
  const historyEnd = js.indexOf('async function openTask', historyStart);
  const history = js.slice(historyStart, historyEnd);
  const claim = history.indexOf('const taskRequestVersion = ++runtime.taskNavigationVersion');
  const save = history.indexOf('await imageGenerationSaveDraft({silent:true})');
  assert.ok(claim >= 0 && save > claim, 'history click must claim its sequence before saving the draft');
  const modeStart = js.indexOf('async function selectMode');
  const modeEnd = js.indexOf('async function leaveWorkbench', modeStart);
  const selectMode = js.slice(modeStart, modeEnd);
  assert.match(selectMode, /const requestVersion = \+\+runtime\.modeNavigationVersion/);
  const guards = selectMode.match(/isLatestNavigation\(requestVersion, runtime\.modeNavigationVersion\)/g) || [];
  assert.ok(guards.length >= 3, 'selectMode must guard after each asynchronous phase');
});

test('recover is independently locked and never submits paid generation fields', () => {
  const start = js.indexOf("if(action === 'recover')");
  const end = js.indexOf("} else if(action === 'regenerate')", start);
  assert.ok(start >= 0 && end > start, 'recover branch must exist');
  const recover = js.slice(start, end);
  assert.match(recover, /\/recover/);
  assert.doesNotMatch(recover, /\/regenerate|confirm_cost|submission_id|crypto\.randomUUID/);
});

test('mode and global history do not expose internal prompts', () => {
  assert.match(js, /mode_id=/);
  assert.match(html, /id="globalHistoryDialog"/);
  assert.match(html, /id="globalHistoryModeFilter"/);
  assert.match(html, /id="globalHistoryStatusFilter"/);
  assert.match(html, /<option value="partial">部分成功<\/option>/);
  assert.match(html, /id="globalHistoryDateFilter"/);
  assert.match(html, /id="globalHistoryNameFilter"/);
  assert.match(html, /id="openDataManagement"[\s\S]*?data-lucide="database"[\s\S]*?数据管理/);
  assert.match(html, /<option value="deleted">已删除<\/option>/);
  const publicHtml = html.slice(0, html.indexOf('<dialog id="adminPasswordDialog"'));
  assert.doesNotMatch(publicHtml, /预设提示词|最终内部提示词/);
  const publicHistoryStart = js.indexOf('function renderHistory');
  const publicHistoryEnd = js.indexOf('async function openTask', publicHistoryStart);
  const publicHistory = js.slice(publicHistoryStart, publicHistoryEnd);
  assert.doesNotMatch(publicHistory, /preset_prompt|final_prompt|prompt_versions/);
  const globalHistoryStart = js.indexOf('function renderGlobalHistory');
  const globalHistoryEnd = js.indexOf('async function openGlobalTask', globalHistoryStart);
  const globalHistory = js.slice(globalHistoryStart, globalHistoryEnd);
  assert.doesNotMatch(globalHistory, /preset_prompt|final_prompt|prompt_versions/);
});

test('global history dialog uses the comfortable 16 14 and 12 pixel type scale', () => {
  assert.match(css, /\.history-dialog \.dialog-header h2 \{[\s\S]*?font-size: 16px/);
  assert.match(css, /\.page-header \.header-command,[\s\S]*?\.history-dialog \.header-command \{[\s\S]*?font-size: 12px/);
  assert.match(css, /#openDataManagement span \{[\s\S]*?font-size: 12px/);
  assert.match(css, /\.global-history-filters span \{[\s\S]*?font-size: 12px/);
  assert.match(css, /\.global-history-filters input,[\s\S]*?\.global-history-filters select \{[\s\S]*?height: 38px[\s\S]*?font-size: 14px/);
  assert.match(css, /\.global-history-row \{[\s\S]*?min-width: 0[\s\S]*?min-height: 54px/);
  assert.match(css, /\.global-history-row strong \{ font-size: 14px;/);
  assert.match(css, /\.global-history-row span \{[\s\S]*?font-size: 12px/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.global-history-row \{[\s\S]*?grid-template-columns:/);
});

test('global history is a scannable local-generation ledger', () => {
  const dialogStart = html.indexOf('<dialog id="globalHistoryDialog"');
  const dialogEnd = html.indexOf('<dialog id="imagePreviewDialog"', dialogStart);
  const dialog = html.slice(dialogStart, dialogEnd);
  assert.ok(dialogStart >= 0 && dialogEnd > dialogStart, 'global history dialog must exist');
  assert.ok(dialog.indexOf('id="globalHistoryNameFilter"') < dialog.indexOf('id="globalHistoryModeFilter"'), 'name search must be first');
  assert.match(dialog, /id="globalHistoryCount"[\s\S]*?aria-live="polite"/);
  assert.match(dialog, /id="clearGlobalHistoryNameFilter"[\s\S]*?aria-label="清除名称搜索"[\s\S]*?hidden/);

  const {globalHistoryGroupLabel, globalHistoryIdentity} = loadPageModule();
  assert.equal(globalHistoryGroupLabel({group_no:74}), '074');
  assert.equal(globalHistoryGroupLabel({group_no:1000}), '1000');
  assert.equal(globalHistoryGroupLabel({}), '---');
  assert.deepEqual(
    JSON.parse(JSON.stringify(globalHistoryIdentity({name:'15效果图转二维图', mode_name:'15效果图转二维图'}))),
    {title:'15效果图转二维图', mode:''},
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(globalHistoryIdentity({name:'我的二维码', mode_name:'15效果图转二维图'}))),
    {title:'我的二维码', mode:'15效果图转二维图'},
  );

  const renderStart = js.indexOf('function renderGlobalHistory');
  const renderEnd = js.indexOf('async function openGlobalTask', renderStart);
  const render = js.slice(renderStart, renderEnd);
  assert.match(render, /global-history-group/);
  assert.match(render, /global-history-identity/);
  assert.match(render, /global-history-status is-\$\{escapeHtml\(visualStatus\)\}/);
  assert.match(render, /global-history-date/);
  assert.match(render, /data-clear-global-history-filters/);
  assert.match(js, /function clearGlobalHistoryNameSearch\(\)[\s\S]*?renderGlobalHistory\(\)[\s\S]*?\.focus\(\)/);
  assert.match(css, /\.global-history-row \{[\s\S]*?grid-template-columns: 64px minmax\(0, 1fr\) auto 112px/);
  assert.match(css, /\.global-history-row \.global-history-group \{[\s\S]*?color: var\(--ig-text\)/);
  assert.doesNotMatch(css, /\.global-history-row \.global-history-group \{[^}]*background:/);
  assert.match(css, /\.global-history-status\.is-succeeded[\s\S]*?var\(--ig-accent-soft\)/);
  assert.match(css, /font-variant-numeric: tabular-nums/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?grid-template-areas:[\s\S]*?"group identity status"[\s\S]*?"group date status"/);
  assert.doesNotMatch(css, /\.global-history-row > :nth-child\(3\),[\s\S]*?\.global-history-row > :nth-child\(5\) \{ display: none; \}/);
});

test('data management uses fixed cleanup scope and queues recycle-bin cleanup', () => {
  const managementStart = js.indexOf('function openDataManagementDialog');
  const managementEnd = js.indexOf('async function openArchivedTask', managementStart);
  const management = js.slice(managementStart, managementEnd);
  assert.match(html, /id="dataManagementDialog"[\s\S]*?id="dataManagementTitle">删除历史数据/);
  for (const retention of ['24h', '7d', '30d', 'all']) {
    assert.match(html, new RegExp(`name="cleanupRetention" value="${retention}"`));
  }
  for (const label of ['任务记录', '用户上传图', '用户生成图', '生成失败等无用记录', '未被引用的上传图片']) {
    assert.match(html, new RegExp(`type="checkbox" checked disabled><span>${label}</span>`));
  }
  assert.match(html, /id="dataCleanupConfirmDialog"[\s\S]*?Windows 回收站[\s\S]*?id="cancelDataCleanupConfirm"[\s\S]*?id="confirmDataCleanup"[\s\S]*?确认删除/);
  assert.match(management, /await imageGenerationSaveDraft\(\{silent:true\}\)/);
  assert.match(management, /\/api\/image-generation-tasks\/cleanup-preview/);
  assert.match(management, /\/api\/image-generation-tasks\/cleanup/);
  assert.match(management, /confirmation_id:runtime\.cleanup\.confirmationId/);
  assert.match(management, /cancelDataCleanupConfirm[\s\S]*?focus\(\)/);
  assert.doesNotMatch(management, /(?:window\.)?confirm\s*\(/);
  assert.doesNotMatch(management, /method:'DELETE'/);
  assert.doesNotMatch(management, /runtime\.allTasks = \[\]|runtime\.taskCache\.clear\(\)/);
  assert.doesNotMatch(management, /localStorage\.(?:clear|removeItem)/);
  assert.match(js, /byId\('openDataManagement'\)\.addEventListener\('click', openDataManagementDialog\)/);
  assert.match(js, /byId\('confirmDataCleanup'\)\.addEventListener\('click', confirmDataCleanup\)/);
  assert.match(css, /--ig-cleanup: #c14f2c/);
  assert.match(css, /\.history-cleanup-command \{[\s\S]*?background: var\(--ig-cleanup\)[\s\S]*?color: #fff/);
  assert.match(css, /\.cleanup-retention-options \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.cleanup-fixed-scope \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.cleanup-retention-options label \{[^}]*font-size: 12px;[^}]*white-space: nowrap/);
  assert.match(css, /\.cleanup-fixed-scope input:disabled \{ opacity: 1/);
  assert.match(css, /\.danger-confirm-button \{[\s\S]*?background: var\(--ig-danger\)/);
  assert.match(management, /error\.status === 405[\s\S]*?服务尚未加载数据管理，请重启软件后重试/);
  assert.doesNotMatch(html, /本机图片生成/);

  const {cleanupConfirmationView} = loadPageModule();
  assert.equal(cleanupConfirmationView('all', '').title, '删除全部历史数据？');
  assert.equal(cleanupConfirmationView('7d', '2026-08-22T10:30:00+08:00').title, '删除7天前的数据？');
  assert.match(management, /queueStorageCleanupJob\(result\?\.cleanup_job_id/);
  assert.match(management, /void loadAllTaskSummaries\(\)/);

  const taskActions = functionSource('taskActionsHtml', 'downloadTaskResults');
  assert.match(taskActions, /data-task-action="download"/);
  assert.match(taskActions, /taskVisualStatus\(task\) !== 'deleted'/);
  assert.doesNotMatch(taskActions, /<a href="\/api\/image-generation-tasks/);
  const download = functionSource('downloadTaskResults', 'candidateActionsHtml');
  assert.match(download, /fetch\(`\/api\/image-generation-tasks\/\$\{encodeURIComponent\(taskId\)\}\/download\.zip`/);
  assert.match(download, /await response\.json\(\)/);
  assert.match(download, /URL\.createObjectURL\(blob\)/);
});

test('global history exposes a guarded bulk cleanup for failed and deleted records', () => {
  assert.match(html, /id="cleanupTerminalRecords"[\s\S]*?清理失败\/已删除[\s\S]*?id="cleanupTerminalRecordsCount"/);
  assert.match(html, /id="terminalCleanupConfirmDialog"[\s\S]*?清理失败和已删除记录？[\s\S]*?id="terminalCleanupFailedCount"[\s\S]*?id="terminalCleanupDeletedCount"[\s\S]*?id="confirmTerminalCleanup"/);
  assert.match(js, /function terminalCleanupStatus\(task\)[\s\S]*?taskVisualStatus\(task\)/);
  assert.match(js, /function terminalCleanupCounts\(tasks=\[\]\)[\s\S]*?counts\.total = counts\.failed \+ counts\.deleted/);
  assert.match(js, /function openTerminalCleanupConfirm\(\)[\s\S]*?runtime\.allTasks[\s\S]*?terminalCleanupStatus/);
  assert.match(js, /requestJson\('\/api\/image-generation-tasks\/cleanup-terminal'/);
  assert.match(js, /method:'POST'/);
  assert.match(js, /reconcileAfterDataCleanup\(deletedTaskIds\)/);
  assert.match(js, /queueStorageCleanupJob\(result\?\.cleanup_job_id/);
  assert.match(js, /byId\('cleanupTerminalRecords'\)\.addEventListener\('click', openTerminalCleanupConfirm\)/);
  assert.match(js, /byId\('confirmTerminalCleanup'\)\.addEventListener\('click', confirmTerminalCleanup\)/);
  const {terminalCleanupStatus, terminalCleanupCounts} = loadPageModule();
  assert.equal(terminalCleanupStatus({status:'failed', candidate_count:1, candidates:[{status:'failed'}]}), 'failed');
  assert.equal(terminalCleanupStatus({status:'succeeded', results_deleted:true, candidate_count:1}), 'deleted');
  assert.equal(terminalCleanupStatus({status:'cancelled', candidate_count:1, candidates:[{status:'cancelled'}]}), '');
  assert.deepEqual(
    JSON.parse(JSON.stringify(terminalCleanupCounts([
      {status:'failed', candidate_count:1, candidates:[{status:'failed'}]},
      {status:'succeeded', results_deleted:true, candidate_count:1},
      {status:'succeeded', candidate_count:1, candidates:[{status:'succeeded'}]},
    ]))),
    {failed:1, deleted:1, total:2},
  );
  assert.match(css, /\.terminal-cleanup-command\s*\{[\s\S]*?background: transparent[\s\S]*?var\(--ig-danger\)/);
  assert.match(css, /\.terminal-cleanup-counts\s*\{[\s\S]*?grid-template-columns: repeat\(3/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.terminal-cleanup-counts \{ grid-template-columns: 1fr/);
});

test('public mode cards never expose internal special hint tokens', () => {
  assert.doesNotMatch(js, /mode\.description \|\| mode\.special_hint/);
  assert.match(js, /mode\.description \|\| mode\.remark/);
});

test('workbench flattens task candidates into one adaptive result gallery', () => {
  for (const id of ['resultManageBar', 'selectAllResults', 'downloadSelectedResults', 'deleteSelectedResults']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /id="finishManageResults"/);
  assert.doesNotMatch(html, /id="manageResults"/);
  assert.match(html, /<div id="resultManageBar" class="result-manage-bar">/);
  assert.match(js, /function modeTaskRecords\(\)/);
  assert.match(js, /function resultItems\(\)[\s\S]*?flatMap\(task/);
  assert.match(js, /function galleryRows\(items\)/);
  assert.match(js, /function calculateResultGalleryRowSize\(/);
  assert.match(js, /RESULT_MEDIA_MAX_SIZE = 700/);
  assert.match(js, /class="candidate-gallery"/);
  assert.match(js, /class="candidate-gallery-row/);
  assert.doesNotMatch(js, /container\.innerHTML = `<div class="result-task-head"/);
  assert.match(css, /\.candidate-gallery-row \{[\s\S]*?display: flex/);
  assert.match(css, /\.candidate-gallery-row \{[\s\S]*?justify-content: flex-start[\s\S]*?gap: 12px/);
  assert.match(css, /\.candidate-item \{[\s\S]*?max-width: 700px[\s\S]*?max-height: 700px/);
  assert.match(css, /\.candidate-gallery-row\.is-sized \.candidate-item \{[\s\S]*?height: var\(--item-height\)/);
  assert.doesNotMatch(css, /candidate-gallery-row\.single \.candidate-item \{[\s\S]*?360px/);
});

test('result gallery sizing uses a fluid safety ceiling while preserving ratio', () => {
  const {calculateResultGalleryRowSize} = loadPageModule();
  const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.01, `${actual} should be close to ${expected}`);
  const portrait = calculateResultGalleryRowSize({containerWidth:1000, itemRatios:[9 / 16], viewportHeight:1000, gap:12});
  closeTo(portrait.height, 700);
  closeTo(portrait.widths[0], 393.75);
  const landscape = calculateResultGalleryRowSize({containerWidth:1000, itemRatios:[16 / 9], viewportHeight:1000, gap:12});
  closeTo(landscape.widths[0], 700);
  closeTo(landscape.height, 393.75);
  const narrowPair = calculateResultGalleryRowSize({containerWidth:500, itemRatios:[9 / 16, 9 / 16], viewportHeight:1000, gap:12});
  closeTo(narrowPair.height, (500 - 12) / (9 / 16 + 9 / 16));
  assert.ok(narrowPair.height < 700);
  assert.ok(narrowPair.widths.every(width => width <= 700));
  const wideTriple = calculateResultGalleryRowSize({containerWidth:1300, itemRatios:[9 / 16, 9 / 16, 9 / 16], viewportHeight:1000, gap:12});
  closeTo(wideTriple.height, 700);
  assert.ok(wideTriple.widths.every(width => width <= 700));
});

test('result gallery keeps up to three generated images in one adaptive row', () => {
  const {galleryRows} = loadPageModule();
  const rows = galleryRows([
    {ratio:16 / 9},
    {ratio:16 / 9},
    {ratio:16 / 9},
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, 3);
});

test('result gallery removes redundant grouping chrome and folds task history', () => {
  const results = functionSource('renderResults', 'candidateFromTask');
  assert.doesNotMatch(results, /全部生成图片|taskActionsHtml\(latestTask\)/);
  assert.match(results, /byId\('resultCount'\)/);
  assert.match(results, /resultCount\.textContent = `\$\{successful\} 张/);
  assert.match(js, /resultCount\.textContent = '0 张'/);
  assert.match(js, /const resultTitle = document\.querySelector\('\.workbench-header-actions > \.result-panel-title'\)/);
  assert.match(js, /resultTitle\.hidden = selectedCount > 0/);
  assert.doesNotMatch(results, /results-summary/);
  const item = functionSource('renderGalleryItem', 'syncResultManageBar');
  assert.doesNotMatch(item, /candidate-no/);
  assert.match(css, /\.candidate-item \{[\s\S]*?border: 1px solid transparent/);
  assert.doesNotMatch(css, /\.candidate-no\s*\{/);
  assert.match(html, /<details id="historySection" class="history-drawer">[\s\S]*?id="modeHistory"/);
  const history = functionSource('renderHistory', 'openTask');
  assert.match(history, /class="history-item-actions">\$\{taskActionsHtml\(task\)\}/);
  assert.match(history, /\.history-item\[data-task-id\]/);
  assert.match(history, /\[data-task-action\]/);
  assert.match(css, /\.history-item-shell:hover \.history-item-actions,[\s\S]*?opacity: 1/);
});

test('case action remains in the result tools and candidate controls reveal on intent', () => {
  assert.match(html, /class="result-panel-tools">[\s\S]*?id="viewModeExample"/);
  assert.doesNotMatch(html, /id="refreshModeHistory"/);
  assert.doesNotMatch(html, /id="manageResults"/);
  assert.match(html, /class="workbench-header-actions">[\s\S]*?class="result-panel-tools">[\s\S]*?id="viewModeExample"/);
  assert.match(css, /\.view-example-button,[\s\S]*?linear-gradient\(135deg, #ff5a2f 0%, #ff8848 100%\)[\s\S]*?color: #fff/);
  assert.match(css, /\.compact-button\.view-example-button svg \{ width: 14\.3px; height: 14\.3px; \}/);
  assert.match(css, /\.candidate-actions \{[\s\S]*?right: 4px; top: 4px[\s\S]*?opacity: 0; pointer-events: none/);
  assert.match(css, /\.candidate-item:hover \.candidate-actions,[\s\S]*?\.candidate-item:focus-within \.candidate-actions \{ opacity: 1; pointer-events: auto/);
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.candidate-actions,\s*\.candidate-select-action \{ opacity: 1; pointer-events: auto/);
  const item = functionSource('renderGalleryItem', 'syncResultManageBar');
  assert.match(item, /ACTIVE_TASK_STATUSES\.has\(status\) \? 'status-spinner'/);
});

test('result gallery keeps batch actions visible and supports direct multi-selection', () => {
  assert.match(html, /class="result-panel-tools">[\s\S]*?id="resultManageBar"[\s\S]*?id="selectAllResults"[\s\S]*?id="downloadSelectedResults"[\s\S]*?id="deleteSelectedResults"[\s\S]*?id="viewModeExample"/);
  assert.match(html, /id="resultSelectionCount"[^>]*class="result-selection-count"[^>]*aria-live="polite"[^>]*><\/span>/);
  assert.doesNotMatch(html, /batch-download-help|data-selection-tip/);
  assert.doesNotMatch(html, /id="downloadSelectedResults"[^>]*title=/);
  assert.doesNotMatch(css, /batch-download-help|data-selection-tip/);
  assert.doesNotMatch(css, /\.result-count::before/);
  assert.match(css, /\.result-selection-count\s*\{[\s\S]*?border-radius: 999px[\s\S]*?background: var\(--ig-accent-soft\)/);
  assert.match(css, /\.result-selection-count:empty\s*\{\s*display: none;/);
  assert.doesNotMatch(html, /id="finishManageResults"|<span>取消<\/span>/);
  assert.doesNotMatch(html, /id="resultManageBar"[^>]*hidden/);
  assert.doesNotMatch(js, /resultManageMode/);
  assert.match(js, /data-candidate-action="select"/);
  assert.match(js, /class="candidate-select-action"/);
  assert.match(js, /function toggleResultSelection\(key, selected\)/);
  assert.match(js, /function clearResultSelection\(\)/);
  assert.doesNotMatch(js, /selectable\.every\(item => runtime\.selectedResultKeys\.has\(item\.key\)\)/);
  assert.match(js, /const selectionAction = resultSelectionAction\(selectedCount\)/);
  assert.match(js, /if\(selectionAction\.clearsSelection\) runtime\.selectedResultKeys\.clear\(\)/);
  assert.doesNotMatch(js, /byId\('finishManageResults'\)/);
  const {resultSelectionLabel, resultSelectionAction, isResultQuickSelect} = loadPageModule();
  assert.equal(resultSelectionLabel(0), '');
  assert.equal(resultSelectionLabel(1), '已选 1 张');
  assert.equal(resultSelectionLabel(3), '已选 3 张');
  assert.equal(resultSelectionAction(0).label, '全选');
  assert.equal(resultSelectionAction(0).clearsSelection, false);
  assert.equal(resultSelectionAction(1).label, '取消选择');
  assert.equal(resultSelectionAction(1).clearsSelection, true);
  assert.equal(isResultQuickSelect('preview', {ctrlKey: true, button: 0}), true);
  assert.equal(isResultQuickSelect('preview', {ctrlKey: false, button: 0}), false);
  assert.equal(isResultQuickSelect('download', {ctrlKey: true, button: 0}), false);
  assert.match(js, /确定删除已选择的 \$\{selected\.length\} 张图片吗/);
  const deleteSelected = functionSource('deleteSelectedResults', 'bindResultActions');
  assert.match(deleteSelected, /requestJson\('\/api\/image-generation-tasks\/candidates\/delete'/);
  assert.match(deleteSelected, /method:'POST'/);
  assert.match(deleteSelected, /body:JSON\.stringify\(\{items:/);
  assert.doesNotMatch(deleteSelected, /for\(const item of selected\)/);
  assert.match(deleteSelected, /response\?\.tasks[\s\S]*?adoptTaskSnapshot/);
  assert.match(deleteSelected, /forgetImageGenerationTasks\(response\?\.deleted_task_ids/);
  assert.match(deleteSelected, /queueStorageCleanupJob\(response\?\.cleanup_job_id/);
  assert.doesNotMatch(deleteSelected, /await loadModeTasks/);
  assert.match(deleteSelected, /runtime\.resultBatchDeleting = true/);
  assert.match(deleteSelected, /finally[\s\S]*?runtime\.resultBatchDeleting = false/);
  assert.match(js, /deleteButton\.disabled = selectedCount === 0 \|\| runtime\.resultBatchDeleting/);
  assert.match(js, /runtime\.resultBatchDeleting \? '删除中…' : '删除所选'/);
  assert.match(js, /function downloadSelectedResults\(\)[\s\S]*?document\.createElement\('a'\)[\s\S]*?link\.download = ''/);
  const downloadStart = js.indexOf('function downloadSelectedResults');
  const downloadEnd = js.indexOf('async function deleteSelectedResults', downloadStart);
  assert.doesNotMatch(js.slice(downloadStart, downloadEnd), /admin\.active/);
  assert.match(js, /byId\('downloadSelectedResults'\)\.addEventListener\('click', downloadSelectedResults\)/);
  assert.match(js, /const downloadButton = byId\('downloadSelectedResults'\)[\s\S]*?downloadButton\.disabled = selectedDownloadableCount === 0/);
  assert.match(js, /isResultQuickSelect\(action, event\)[\s\S]*?toggleResultSelection\(resultKey\)/);
  assert.match(css, /\.candidate-item\.selected \{[\s\S]*?border-color: var\(--ig-accent\)/);
  assert.match(css, /\.candidate-select-action \{[\s\S]*?right: 6px; bottom: 6px[\s\S]*?opacity: 0/);
  assert.match(css, /\.candidate-item\.selected \.candidate-select-action \{[\s\S]*?var\(--ig-accent\)/);
  assert.match(css, /\.candidate-item:hover \.candidate-select-action,[\s\S]*?\.candidate-item\.selected \.candidate-select-action[\s\S]*?opacity: 1/);
  assert.match(css, /\.candidate-preview-trigger \{ cursor: zoom-in; \}/);
  assert.match(css, /html\.result-quick-select \.candidate-preview-trigger \{ cursor: copy; \}/);
  assert.match(js, /function syncResultQuickSelectCursor\(active\)[\s\S]*?document\.documentElement\.classList\.toggle\('result-quick-select', Boolean\(active\)\)/);
  assert.match(js, /document\.addEventListener\('keydown',[\s\S]*?syncResultQuickSelectCursor\(event\.ctrlKey\)/);
  assert.match(js, /document\.addEventListener\('keyup', event => \{[\s\S]*?syncResultQuickSelectCursor\(event\.ctrlKey\)/);
  assert.match(js, /window\.addEventListener\('blur', \(\) => \{[\s\S]*?syncResultQuickSelectCursor\(false\)/);
});

test('result gallery keeps selection actions visible in the workbench header while scrolling', () => {
  assert.match(html, /class="workbench-header-actions">[\s\S]*?id="resultPanelTitle"[\s\S]*?id="resultManageBar"[\s\S]*?id="viewModeExample"/);
  assert.doesNotMatch(html, /class="result-panel-heading"/);
  assert.match(css, /\.workbench-header-actions\s*\{[\s\S]*?display: flex;[\s\S]*?align-items: center[\s\S]*?column-gap: 24px/);
  assert.match(css, /\.workbench-header-actions\s*> \.result-panel-title\s*\{[\s\S]*?white-space: nowrap/);
  assert.match(css, /\.workbench-header-actions\s*> \.result-panel-title\[hidden\]\s*\{\s*display: none;\s*\}/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.workbench-header-actions\s*\{[\s\S]*?grid-column: 1 \/ -1/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.image-generation-app\.workbench-active \.page-content\s*\{\s*overflow: visible;/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?html\s*\{\s*overflow: auto;\s*\}[\s\S]*?body\s*\{\s*overflow: visible;\s*\}/);
});

test('failed result cards explain the error and can be selected for deletion without download', () => {
  const {
    candidateFailureView, resultItemSelectable, resultItemDownloadable, isResultQuickSelect,
  } = loadPageModule();
  const quotaError = '图片编辑接口调用失败：{"error":{"message":"预扣费额度失败, 剩余额度: ฿0.059832, 需要预扣费额度: ฿0.060000 (request id: secret-request)"}}';
  assert.deepEqual(
    JSON.parse(JSON.stringify(candidateFailureView({status:'failed', error:quotaError}))),
    {
      summary:'额度不足，生成未完成',
      detail:'上游账户额度不足：剩余额度 ฿0.059832，需要 ฿0.060000。请充值后重试。',
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(candidateFailureView({status:'failed', error:'候选生成失败'}))),
    {summary:'候选生成失败', detail:'候选生成失败'},
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(candidateFailureView({status:'failed', error:''}))),
    {summary:'生成失败', detail:'上游未返回具体失败原因'},
  );

  assert.equal(resultItemSelectable({candidateId:'ok', status:'succeeded', url:'/result.png'}), true);
  assert.equal(resultItemSelectable({candidateId:'failed', status:'failed', url:''}), true);
  assert.equal(resultItemSelectable({candidateId:'queued', status:'queued', url:''}), false);
  assert.equal(resultItemDownloadable({candidateId:'ok', status:'succeeded', url:'/result.png'}), true);
  assert.equal(resultItemDownloadable({candidateId:'failed', status:'failed', url:''}), false);
  assert.equal(isResultQuickSelect('failed-record', {ctrlKey:true, button:0}), true);

  const item = functionSource('renderGalleryItem', 'syncResultManageBar');
  assert.match(item, /candidateFailureView\(candidate\)/);
  assert.match(item, /class="candidate-failure-summary"/);
  assert.match(item, /<details class="candidate-failure-details">/);
  assert.match(item, /<summary>查看详情<\/summary>/);
  assert.match(item, /data-candidate-action="failed-record"/);
  assert.match(item, /status === 'failed' \? '选择记录' :/);
  assert.match(js, /const selectable = items\.filter\(resultItemSelectable\)/);
  assert.match(js, /const selectedDownloadableCount = items\.filter\(item => runtime\.selectedResultKeys\.has\(item\.key\) && resultItemDownloadable\(item\)\)\.length/);
  assert.match(js, /downloadButton\.disabled = selectedDownloadableCount === 0 \|\| runtime\.resultBatchDeleting/);
  assert.match(js, /const selected = resultItems\(\)\.filter\(item => resultItemSelectable\(item\) && runtime\.selectedResultKeys\.has\(item\.key\)\)/);
  assert.match(css, /\.candidate-failure-summary\s*\{[\s\S]*?color: var\(--ig-danger\)/);
  assert.match(css, /\.candidate-failure-details\s*\{[\s\S]*?max-width:/);
  assert.match(css, /html\.result-quick-select \.candidate-item\.failed \.candidate-placeholder \{ cursor: copy; \}/);
  assert.match(css, /\.candidate-item\.failed\.selected \{ border-color: var\(--ig-accent\); \}/);
});

test('generated result preview supports buttons and keyboard arrow navigation', () => {
  for (const id of ['previewPrevious', 'previewNext', 'previewCounter']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="previewCounter"[^>]*hidden/);
  assert.doesNotMatch(js, /previewCounter'\)\.textContent/);
  assert.match(js, /previewItems:\[\], previewIndex:-1/);
  assert.match(js, /function navigatePreview\(delta\)/);
  assert.match(js, /event\.key === 'ArrowLeft' \|\| event\.key === 'ArrowRight'/);
  assert.match(js, /navigatePreview\(event\.key === 'ArrowLeft' \? -1 : 1\)/);
  assert.match(js, /function previewUploadedImage[\s\S]*?openImagePreview\(url, \{alt:/);
  assert.match(js, /function previewCandidate[\s\S]*?previewItems:runtime\.previewItems|function previewCandidate[\s\S]*?previewItems, previewIndex/);
  assert.match(css, /\.preview-nav-previous \{ left: 10px; \}/);
});
