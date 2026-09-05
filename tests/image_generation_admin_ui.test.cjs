const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const html = read('static/image-generation.html');
const js = read('static/js/image-generation.js');
const css = read('static/css/image-generation.css');

function functionSource(name, nextName) {
  const start = js.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  const end = nextName ? js.indexOf(`function ${nextName}`, start + 1) : js.length;
  assert.ok(end > start, `${name} must end before ${nextName}`);
  return js.slice(start, end);
}

test('ordinary mode hides every management entry and prompt editor', () => {
  for (const id of ['openAdminManager', 'exitAdminMode', 'manageCurrentMode']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*class="[^"]*admin-only[^"]*"[^>]*hidden`));
  }
  for (const id of ['adminPasswordDialog', 'adminManagerDialog', 'setExampleDialog']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(js, /document\.querySelectorAll\('\.admin-only'\)[\s\S]*?element\.hidden\s*=\s*!runtime\.admin\.active/);
  const candidateActions = functionSource('candidateActionsHtml', 'renderResults');
  assert.match(candidateActions, /runtime\.admin\.active\s*&&\s*candidate\.status\s*===\s*'succeeded'[\s\S]*?data-candidate-action="set-example"/);
});

test('Ctrl+Alt+M is the only hidden shortcut and opens the password dialog', () => {
  assert.match(js, /event\.ctrlKey\s*&&\s*event\.altKey\s*&&\s*event\.key\.toLowerCase\(\)\s*===\s*'m'/);
  assert.match(js, /event\.ctrlKey[\s\S]{0,180}?openAdminManager\(/);
  const openManager = functionSource('openAdminManager', 'bindStaticEvents');
  assert.match(openManager, /if\(!runtime\.admin\.active\)\s*\{?[\s\S]*?byId\('adminPasswordDialog'\)\.showModal\(\)/);
  assert.match(html, /id="adminPasswordForm"/);
  assert.match(html, /id="adminPassword"[^>]*type="password"/);
  assert.match(html, /id="unlockAdminMode"[^>]*type="submit"/);
});

test('admin token lives only in sessionStorage and is restored after public bootstrap', () => {
  assert.match(js, /const ADMIN_SESSION_KEY\s*=\s*'imageGenerationAdminToken:v1'/);
  assert.match(js, /sessionStorage\.getItem\(ADMIN_SESSION_KEY\)/);
  assert.match(js, /sessionStorage\.setItem\(ADMIN_SESSION_KEY,\s*runtime\.admin\.token\)/);
  assert.match(js, /sessionStorage\.removeItem\(ADMIN_SESSION_KEY\)/);
  assert.doesNotMatch(js, /localStorage\.(?:getItem|setItem)\(ADMIN_SESSION_KEY/);
  const unlock = functionSource('unlockAdminMode', 'exitAdminMode');
  assert.match(unlock, /requestJson\('\/api\/image-generation\/admin\/unlock'[\s\S]*?password:byId\('adminPassword'\)\.value/);
  assert.match(unlock, /saveAdminToken\(result\.token\)/);
  assert.doesNotMatch(unlock, /(?:localStorage|sessionStorage)\.(?:setItem|getItem)[\s\S]*?password/i);
  const bootstrap = functionSource('bootstrap');
  const publicLoad = bootstrap.indexOf("requestJson('/api/image-generation/modes')");
  const restore = bootstrap.indexOf('restoreAdminSession()');
  assert.ok(publicLoad >= 0 && restore > publicLoad, 'restore must run only after public startup succeeds');
});

test('protected requests attach the token only to same-origin image-generation routes', () => {
  const predicate = functionSource('isProtectedImageGenerationPath', 'adminRequestJson');
  assert.match(predicate, /String\(url\s*\|\|\s*''\)\.split\('\?'\)\[0\]/);
  assert.match(predicate, /path\.startsWith\('\/api\/image-generation\/admin\/'\)/);
  assert.doesNotMatch(predicate, /\/api\/image-generation\/source\//);
  assert.match(predicate, /path\s*===\s*'\/api\/image-generation-tasks'/);
  assert.doesNotMatch(predicate, /https?:\/\//);

  const request = functionSource('adminRequestJson', 'isFavorite');
  const reject = request.indexOf('if(!isProtectedImageGenerationPath(url))');
  const header = request.indexOf("'X-Image-Generation-Admin':runtime.admin.token");
  const fetch = request.indexOf('requestJson(url, {...options, headers})');
  assert.ok(reject >= 0 && header > reject && fetch > header, 'path must be approved before the token header is created or sent');
});

test('403 and explicit logout clear every protected state without an inactivity timer', () => {
  const request = functionSource('adminRequestJson', 'isFavorite');
  assert.match(request, /if\(error\.status\s*===\s*403\)\s*\{?[\s\S]{0,80}?leaveAdminUi\(\)/);
  assert.match(request, /if\(error\.status\s*===\s*403\)[\s\S]{0,180}?reloadPublicModes\(\)/);

  const leave = functionSource('leaveAdminUi', 'reloadPublicModes');
  assert.match(leave, /saveAdminToken\(''\)/);
  for (const contract of [
    /runtime\.admin\.active\s*=\s*false/,
    /runtime\.admin\.modes\s*=\s*\[\]/,
    /runtime\.admin\.currentMode\s*=\s*null/,
    /runtime\.admin\.exampleTarget\s*=\s*null/,
  ]) assert.match(leave, contract);

  const logout = functionSource('exitAdminMode', 'adminModeById');
  assert.match(logout, /\/api\/image-generation\/admin\/lock/);
  assert.match(logout, /leaveAdminUi\(\)/);
  assert.match(logout, /reloadPublicModes\(\)/);
  assert.doesNotMatch(js, /setTimeout\([^\n]*?(?:leaveAdminUi|exitAdminMode|lockAdmin)|setInterval\([^\n]*?(?:leaveAdminUi|exitAdminMode|lockAdmin)/i);
});

test('mode manager is one simplified settings form with a status switch', () => {
  for (const id of [
    'adminModeSelect', 'adminExamplePreview', 'adminModeName', 'adminModeSort',
    'adminModeCategory', 'adminModeDescription', 'adminExampleCaption',
    'adminPromptText', 'adminModeEnabled', 'saveAdminMode', 'adminRequiredCount',
    'adminOptionalCount', 'adminRequiredSlotFields', 'adminUploadRulePreview',
  ]) assert.match(html, new RegExp(`id="${id}"`));

  assert.match(js, /adminRequestJson\('\/api\/image-generation\/admin\/modes'\)/);
  assert.match(js, /adminRequestJson\(`\/api\/image-generation\/admin\/modes\/\$\{encodeURIComponent\(modeId\)\}`\)/);
  const editor = functionSource('renderAdminModeEditor', 'refreshAdminAndPublic');
  assert.match(editor, /const modeDescription = String\(mode\.description \|\| ''\)\.trim\(\) \|\| String\(mode\.remark \|\| ''\)\.trim\(\)/);
  assert.match(editor, /adminModeDescription'\)\.value = modeDescription/);
  assert.match(editor, /adminPromptText'\)\.value = mode\.preset_prompt \|\| ''/);
  assert.match(editor, /adminModeEnabled'\)\.checked = mode\.status === 'active'/);
  assert.match(editor, /renderAdminExamplePreview\(mode\.example\)/);
  assert.match(editor, /renderAdminUploadRules\(mode\)/);
  assert.match(html, /id="adminModeEnabled"[^>]*role="switch"/);
  assert.match(html, /id="adminPromptText"[^>]*aria-labelledby="promptManagerTitle"/);
  assert.match(js, /enabled \? '已启动' : '已停用'/);
  assert.match(css, /\.admin-status-toggle\.is-active \.admin-status-track/);
  assert.match(css, /\.admin-mode-editor > \.result-empty\[hidden\][\s\S]*?display: none !important/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*?\.admin-example-preview\s*\{\s*grid-template-columns: 1fr;\s*\}[\s\S]*?\.admin-save-bar\s*\{\s*align-items: stretch; flex-direction: column/);
});

test('mode manager creates a truly blank mode and allocates its number only on save', () => {
  assert.match(html, /id="createAdminMode"[^>]*>[\s\S]*?data-lucide="plus"[\s\S]*?<span>新增模式<\/span>/);
  const listing = functionSource('loadAdminModes', 'loadAdminModeDetail');
  assert.match(listing, /runtime\.admin\.nextModeNo\s*=\s*Number\(payload\.next_mode_no\)/);
  const start = functionSource('startAdminModeCreation', 'adminStatusLabel');
  assert.match(start, /__isNew:true/);
  assert.match(start, /mode_no:runtime\.admin\.nextModeNo/);
  assert.match(start, /display_name:''/);
  assert.match(start, /preset_prompt:''/);
  assert.match(start, /reference_images:\[\]/);
  assert.match(start, /required_reference_count:0/);
  assert.match(start, /example:null/);
  assert.doesNotMatch(start, /duplicate|\.\.\.runtime\.admin\.currentMode/);

  const save = functionSource('saveAdminMode', 'renderExampleDialogPreview');
  assert.match(save, /const creating = Boolean\(mode\.__isNew\)/);
  assert.match(save, /if\(creating && !payload\.display_name\)/);
  assert.match(save, /creating \? '\/api\/image-generation\/admin\/modes'/);
  assert.match(save, /method:creating \? 'POST' : 'PATCH'/);
  assert.match(save, /await refreshAdminAndPublic\(saved\.item\.id\)/);
  assert.doesNotMatch(save, /\/duplicate/);

  const bind = functionSource('bindStaticEvents', 'bootstrap');
  assert.match(bind, /byId\('createAdminMode'\)\.addEventListener\('click', startAdminModeCreation\)/);
});

test('one save sends only changed settings and never launches generation', () => {
  const save = functionSource('saveAdminMode', 'renderExampleDialogPreview');
  for (const field of ['display_name', 'sort_order', 'category', 'description', 'preset_prompt', 'example_caption']) {
    assert.match(save, new RegExp(`addChanged\\('${field}'`));
  }
  assert.match(save, /enabled !== \(mode\.status === 'active'\)[\s\S]*?payload\.status = enabled \? 'active' : 'archived'/);
  assert.match(save, /if\(!Object\.keys\(payload\)\.length\)[\s\S]*?没有需要保存的修改/);
  assert.match(save, /Object\.hasOwn\(payload, 'description'\)[\s\S]*?payload\.remark = payload\.description/);
  for (const field of ['required_reference_count', 'max_upload_count', 'allow_extra_images', 'extra_image_limit', 'reference_images']) {
    assert.match(save, new RegExp(field));
  }
  assert.match(save, /method:creating \? 'POST' : 'PATCH'[\s\S]*?body:JSON\.stringify\(payload\)/);
  assert.doesNotMatch(save, /tags|prompt-draft|activate-prompt|restore-prompt|image-generation-tasks|generationTaskPayload/);
});

test('administrator upload rules preview and edit preserve structured slot roles', () => {
  for (const name of ['uploadRuleDetails', 'adminRuleDraft', 'renderAdminRequiredSlotFields', 'renderAdminUploadRules', 'updateAdminUploadRulePreview']) {
    assert.match(js, new RegExp(`function ${name}`));
  }
  const details = functionSource('uploadRuleDetails', 'syncInputModeHint');
  assert.match(details, /requiredSlots\.map\(\(slot, index\) => `图\$\{index \+ 1\}为\$\{slot\.label\}`\)/);
  assert.match(details, /extraText = optionalCount \? `另外可再上传最多\$\{optionalCount\}张参考图`/);
  const draft = functionSource('adminRuleDraft', 'renderAdminRequiredSlotFields');
  assert.match(draft, /requiredCount/);
  assert.match(draft, /optionalCount/);
  assert.match(draft, /referenceImages:\[\.\.\.requiredSlots, \.\.\.optionalSlots\]/);
  assert.match(draft, /maxUploadCount:requestedMax/);
  assert.match(draft, /allowExtraImages:extraImageLimit > 0/);
  assert.match(js, /adminRequiredCount.*addEventListener\('input'/);
  assert.match(js, /adminOptionalCount.*addEventListener\('input'/);
  assert.match(js, /adminRequiredSlotFields.*addEventListener\('input'/);
  assert.match(css, /\.admin-upload-rule-preview \{[\s\S]*?border-left: 4px solid #f07824[\s\S]*?font-size: 12px/);
  assert.match(css, /\.admin-upload-rule-counts \{[\s\S]*?grid-template-columns: repeat\(2/);
});

test('successful candidate creates a fixed example that renders in the main settings form', () => {
  for (const id of [
    'setExampleForm', 'setExamplePreview', 'exampleCaption',
    'exampleUserPrompt', 'adminExamplePreview', 'adminExampleCaption',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /class="field example-notice-field"[\s\S]*?<span>注意事项<\/span>/);
  assert.doesNotMatch(html, /id="exampleTitle"|示范标题|例如：蓝底证件照/);
  assert.doesNotMatch(html, /exampleShowUserPrompt|向普通用户显示这段示范描述/);
  assert.doesNotMatch(html, />固定处理前 \/ 处理后</);
  assert.match(html, /id="exampleCaption" rows="2"/);
  assert.match(html, /id="exampleUserPrompt" rows="3"/);
  assert.match(html, /class="set-example-body"[\s\S]*?id="setExamplePreview"[\s\S]*?id="setExampleStatus"[\s\S]*?class="dialog-actions set-example-actions"/);
  assert.match(css, /\.set-example-shell\s*\{\s*width: min\(760px/);
  assert.match(css, /\.set-example-shell\s*\{[\s\S]*?grid-template-rows: 50px minmax\(0, 1fr\) auto[\s\S]*?overflow: hidden/);
  assert.match(css, /\.set-example-shell > \.dialog-header\s*\{[\s\S]*?min-height: 50px[\s\S]*?margin: 0/);
  assert.match(css, /\.set-example-body\s*\{[\s\S]*?overflow: auto/);
  assert.match(css, /\.set-example-actions\s*\{[\s\S]*?margin: 0/);
  assert.match(css, /\.set-example-preview\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 38px minmax\(0, 1fr\)[\s\S]*?padding: 14px/);
  assert.match(css, /\.set-example-preview \.media-side\s*\{[\s\S]*?repeat\(auto-fit, minmax\(120px, 1fr\)\)/);
  assert.match(css, /\.set-example-media-frame img\s*\{[\s\S]*?max-width: 100%[\s\S]*?max-height: 100%[\s\S]*?object-fit: contain/);
  assert.match(css, /\.set-example-preview-arrow\s*\{[\s\S]*?border-radius: 50%/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*?\.set-example-preview-arrow\s*\{\s*justify-self: center; transform: rotate\(90deg\)/);

  const open = functionSource('openSetExampleDialog', 'saveModeExample');
  assert.match(open, /candidate\.status\s*!==\s*'succeeded'/);
  assert.match(open, /task\.inputs/);
  assert.match(open, /task\.user_prompt/);
  assert.match(open, /typeof task\.user_prompt !== 'string'/);
  assert.match(open, /byId\('exampleUserPrompt'\)\.value = task\.user_prompt \|\| ''/);
  const preview = functionSource('renderExampleDialogPreview', 'openSetExampleDialog');
  assert.match(preview, /set-example-media-frame/);
  assert.match(preview, /set-example-preview-arrow/);
  assert.match(preview, /exampleMediaLayout\(inputs\.length, Boolean\(outputMarkup\)\)/);
  assert.match(preview, /is-\$\{mediaLayout\}/);

  const save = functionSource('saveModeExample', 'openAdminManager');
  assert.match(save, /method:'POST'/);
  for (const field of ['task_id', 'candidate_id', 'caption', 'sample_user_prompt', 'show_user_prompt']) {
    assert.match(save, new RegExp(`${field}:`));
  }
  assert.match(save, /show_user_prompt:true/);
  assert.match(save, /正在按 1,048,576 像素上限优化输入图和输出图/);
  assert.match(save, /正在优化示范图…/);
  assert.match(save, /finally\s*\{[\s\S]*?submit\.disabled = false/);
  assert.doesNotMatch(save, /exampleTitle|title:byId/);
  assert.match(save, /refreshAdminAndPublic\(target\.modeId\)/);

  const inline = functionSource('renderAdminExamplePreview', 'renderAdminModeEditor');
  assert.match(inline, /example\.input_media/);
  assert.match(inline, /example\.output_media/);
  assert.match(inline, /admin-example-media-grid/);
  assert.match(inline, /captionInput\.value = example\.caption \|\| ''/);
  assert.match(css, /\.admin-example-preview\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.admin-example-media-grid img\s*\{[\s\S]*?object-fit: contain/);
});

test('saving a fixed example reports the optimized media dimensions', () => {
  const save = functionSource('saveModeExample', 'openAdminManager');
  assert.match(js, /function exampleMediaDimensions\(example\)/);
  assert.match(js, /function exampleSavedToast\(example\)/);
  assert.match(save, /exampleSavedToast\(saved\.item\)/);
  assert.match(js, /固定效果示范已保存 · 最大/);
});

test('removed tags, trash, duplicate and prompt-version controls stay absent', () => {
  for (const value of [
    'adminModeTags', '标签（逗号分隔）', 'duplicateAdminMode', '复制为新模式',
    'archiveAdminMode', 'trashAdminMode', 'restoreAdminMode', 'deleteAdminMode',
    '移入回收站', '恢复使用', 'adminPromptVersion', 'adminPromptNote',
    '版本备注', 'savePromptDraft', '保存提示词草稿', 'testPromptDraft', '使用草稿试生成',
    'activatePromptDraft', '设为当前提示词', 'restorePromptVersion', '恢复所选版本',
    'restoreOriginalPrompt', '恢复原始提示词', 'editModeExample', 'deleteModeExample',
  ]) {
    assert.ok(!html.includes(value), `HTML must not contain ${value}`);
    assert.ok(!js.includes(value), `JS must not contain ${value}`);
  }
  const adminHtml = html.slice(html.indexOf('<dialog id="adminPasswordDialog"'));
  const adminJs = js.slice(js.indexOf('function adminRuleDraft'));
  assert.ok(!adminHtml.includes('永久删除'), 'admin HTML must not restore permanent-delete controls');
  assert.ok(!adminJs.includes('永久删除'), 'admin JS must not restore permanent-delete controls');
});

test('obsolete manual preset review controls and requests are absent', () => {
  for (const value of [
    'checkModeSource', 'sourceReviewList', 'applyModeSource',
    '检查预设更新', '应用已确认决定', '/api/image-generation/source/check',
    '/api/image-generation/source/apply', 'haojieai.top',
  ]) {
    assert.ok(!html.includes(value), `HTML must not contain ${value}`);
    assert.ok(!js.includes(value), `JS must not contain ${value}`);
  }
});

test('all management controls and dialog actions are wired', () => {
  const bind = functionSource('bindStaticEvents', 'bootstrap');
  for (const [id, event] of [
    ['adminPasswordForm', 'submit'], ['openAdminManager', 'click'], ['exitAdminMode', 'click'],
    ['manageCurrentMode', 'click'], ['adminModeSelect', 'change'], ['saveAdminMode', 'click'],
    ['adminModeEnabled', 'change'], ['setExampleForm', 'submit'],
  ]) {
    assert.match(bind, new RegExp(`byId\\('${id}'\\)\\.addEventListener\\('${event}'`), `${id} must bind ${event}`);
  }
  assert.match(bind, /\[data-close-dialog\][\s\S]*?addEventListener\('click'/);
});

test('public mode cards use fixed examples without reading protected prompt fields', () => {
  const card = functionSource('modeCard', 'modesByIds');
  assert.match(card, /mode\.example\?\.output_media/);
  assert.match(card, /mode-card-example/);
  assert.match(card, /mode-card-example-placeholder/);
  assert.doesNotMatch(card, /preset_prompt|final_prompt|prompt_versions|current_version_id/);

  const example = functionSource('renderExample', 'syncWorkbenchHeader');
  assert.match(example, /example\.input_media/);
  assert.match(example, /example\.output_media/);
  assert.doesNotMatch(example, /example\.title/);
  assert.match(example, /item\.slot_key/);
  assert.match(example, /example-media-frame/);
  assert.match(example, /example-media-label/);
  assert.doesNotMatch(example, /preset_prompt|final_prompt|prompt_versions|current_version_id/);
});
