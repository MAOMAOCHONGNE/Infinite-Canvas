const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const helperSource = fs.readFileSync(path.join(root, 'static/js/prompt-template-thumbnails.js'), 'utf8');

function loadHelper(overrides={}){
  class FakeFormData { append(){} }
  const window = {};
  const context = {
    window,
    console,
    FormData:FakeFormData,
    fetch:async () => ({ok:true,json:async()=>({})}),
    document:{},
    ...overrides
  };
  vm.runInNewContext(helperSource, context);
  return window.PromptTemplateThumbnails;
}

test('thumbnail helper preserves text paste targets and recognizes clipboard images', () => {
  const helper = loadHelper();
  const editable = {closest:selector => selector.includes('textarea') ? {} : null};
  const plain = {closest:() => null};
  assert.equal(helper.isEditableTarget(editable), true);
  assert.equal(helper.isEditableTarget(plain), false);
  const file = {type:'image/png'};
  const event = {clipboardData:{items:[{kind:'file',type:'image/png',getAsFile:() => file}]}};
  assert.equal(helper.clipboardImage(event), file);
});

test('image clipboard paste is handled even while the template search or editor has focus', () => {
  assert.match(helperSource, /const paste = event => \{\s*if\(busy \|\| !isActive\?\.\(\)\) return;\s*const file = clipboardImage\(event\)/);
  assert.doesNotMatch(helperSource, /!isActive\?\.\(\) \|\| isEditableTarget\(event\.target\)/);
});

test('handled thumbnail paste stops the canvas paste path and restores unsaved edit fields after rerender', async () => {
  let pasteHandler = null;
  const document = {
    addEventListener(type, handler){ if(type === 'paste') pasteHandler = handler; },
    removeEventListener(){},
  };
  const helper = loadHelper({
    document,
    fetch:async () => ({ok:true,json:async()=>({library:{libraries:[]},item:{id:'template_1'}})})
  });
  const listeners = {};
  const root = {
    classList:{add(){},remove(){}},
    addEventListener(type, handler){ listeners[type] = handler; },
    removeEventListener(){},
    contains(){ return true; },
  };
  const fields = new Map([
    ['name', '尚未保存的名称'],
    ['scene', '尚未保存的用途'],
    ['category', 'lighting'],
    ['positive', '尚未保存的模板内容'],
  ]);
  const eventState = {prevented:false,stopped:false,immediate:false};
  const file = {type:'image/png',name:'thumbnail.png'};
  const event = {
    clipboardData:{items:[{kind:'file',type:'image/png',getAsFile:() => file}]},
    preventDefault(){ eventState.prevented = true; },
    stopPropagation(){ eventState.stopped = true; },
    stopImmediatePropagation(){ eventState.immediate = true; },
  };

  helper.mount({
    root,
    isActive:() => true,
    getItemId:() => 'template_1',
    preserveDraft:() => {
      const snapshot = new Map(fields);
      return () => {
        fields.clear();
        snapshot.forEach((value, key) => fields.set(key, value));
      };
    },
    onLibrary:() => {
      fields.set('name', '新模板');
      fields.set('scene', '我的提示词预设');
      fields.set('category', 'mine');
      fields.set('positive', '新提示词');
    },
  });

  assert.equal(typeof pasteHandler, 'function');
  pasteHandler(event);
  assert.deepEqual(eventState, {prevented:true,stopped:true,immediate:true});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Object.fromEntries(fields), {
    name:'尚未保存的名称',
    scene:'尚未保存的用途',
    category:'lighting',
    positive:'尚未保存的模板内容',
  });
});

test('thumbnail helper stages a new-template image locally instead of uploading without an item id', () => {
  let pasteHandler = null;
  let fetchCalls = 0;
  let stagedFile = null;
  const helper = loadHelper({
    document:{
      addEventListener(type, handler){ if(type === 'paste') pasteHandler = handler; },
      removeEventListener(){}
    },
    fetch:async () => { fetchCalls += 1; return {ok:true,json:async()=>({})}; }
  });
  const root = {
    classList:{add(){},remove(){}},
    addEventListener(){},
    removeEventListener(){},
    contains(){ return true; }
  };
  const image = {type:'image/png',name:'draft.png'};
  helper.mount({
    root,
    isActive:() => true,
    getItemId:() => '',
    onPendingFile:file => { stagedFile = file; }
  });
  const event = {
    clipboardData:{items:[{kind:'file',type:'image/png',getAsFile:() => image}]},
    preventDefault(){}, stopPropagation(){}, stopImmediatePropagation(){}
  };
  pasteHandler(event);
  assert.equal(stagedFile, image);
  assert.equal(fetchCalls, 0);
});

test('classic prompt library wires edit-draft preservation and ignores already-consumed canvas paste events', () => {
  const classic = fs.readFileSync(path.join(root, 'static/js/canvas.js'), 'utf8');
  assert.match(classic, /function preserveCanvasPromptTemplateEditDraft\(\)/);
  assert.match(classic, /preserveDraft:preserveCanvasPromptTemplateEditDraft/);
  assert.match(classic, /window\.addEventListener\('paste', e => \{\s*if\(!canvas \|\| e\.defaultPrevented\) return;/);
});

test('thumbnail cards use a placeholder without broken image markup when empty', () => {
  const helper = loadHelper();
  const empty = helper.card({name:'角色参考',category:'character',thumbnail:''});
  const filled = helper.card({name:'角色参考',category:'character',thumbnail:'/assets/prompt-thumbnails/example.webp'});
  assert.match(empty, /prompt-thumb-placeholder/);
  assert.doesNotMatch(empty, /<img/);
  assert.match(filled, /example\.webp/);
  assert.match(filled, /draggable="false"/);
});

test('filled thumbnails keep fallback text hidden and canvas previews contain the full image', () => {
  const sharedCss = fs.readFileSync(path.join(root, 'static/css/prompt-template-thumbnails.css'), 'utf8');
  const classicCss = fs.readFileSync(path.join(root, 'static/css/canvas.css'), 'utf8');
  const smartCss = fs.readFileSync(path.join(root, 'static/css/smart-canvas.css'), 'utf8');

  assert.match(sharedCss, /\.prompt-thumb-placeholder\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*;\s*\}/);
  for(const css of [classicCss, smartCss]){
    assert.match(css, /\.prompt-template-detail \.prompt-thumb-editor-preview img\s*\{\s*object-fit\s*:\s*contain\s*;/);
  }
});

test('canvas thumbnail editor uses purpose copy, compact upload guidance, and no thumbnail heading', () => {
  const helper = loadHelper();
  const html = helper.editor({id:'tpl_1',name:'海报',category:'view',scene:'适合活动海报'}, {
    layout:'canvas',
    purpose:'适合活动海报',
    purposeEditable:true
  });
  assert.match(html, /prompt-thumb-editor is-canvas-layout/);
  assert.match(html, /用途说明/);
  assert.match(html, /data-template-edit-scene/);
  assert.match(html, /拖入图片\s*\/\s*Ctrl\+V/);
  assert.match(html, /data-prompt-thumb-action="choose"/);
  assert.doesNotMatch(html, /<strong>缩略图<\/strong>/);
  assert.doesNotMatch(html, /点击选择，或在未编辑文字时/);
});

test('all three prompt-library pages load the shared thumbnail assets', () => {
  for(const page of ['canvas.html','smart-canvas.html','asset-manager.html']){
    const html = fs.readFileSync(path.join(root, 'static', page), 'utf8');
    assert.match(html, /prompt-template-thumbnails\.css/);
    assert.match(html, /prompt-template-thumbnails\.js/);
  }
});

test('all three controllers render thumbnails and synchronize the returned library', () => {
  const classic = fs.readFileSync(path.join(root, 'static/js/canvas.js'), 'utf8');
  const smart = fs.readFileSync(path.join(root, 'static/js/smart-canvas.js'), 'utf8');
  const manager = fs.readFileSync(path.join(root, 'static/js/asset-manager.js'), 'utf8');
  for(const source of [classic, smart, manager]){
    assert.match(source, /PromptTemplateThumbnails\?\.card/);
    assert.match(source, /PromptTemplateThumbnails\?\.editor/);
    assert.match(source, /PromptTemplateThumbnails\?\.mount/);
  }
  assert.match(classic, /canvasPromptLibraries = library\?\.libraries/);
  assert.match(smart, /promptLibraries = library\?\.libraries/);
  assert.match(manager, /promptLibrary = library \|\| promptLibrary/);
});

test('asset manager stages new-template thumbnails, uses the T-panel layout, and uploads only after save', () => {
  const manager = fs.readFileSync(path.join(root, 'static/js/asset-manager.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'static/css/asset-manager.css'), 'utf8');
  assert.match(manager, /function stagePromptDraftThumbnail\(file\)/);
  assert.match(manager, /isActive:\(\) => activeTab === 'prompts'/);
  assert.match(manager, /onPendingFile:stagePromptDraftThumbnail/);
  assert.match(manager, /layout:'canvas', purposeInputId:'promptEditScene'/);
  assert.match(manager, /await window\.PromptTemplateThumbnails\?\.upload\(data\.item\?\.id, promptDraftThumbnailFile\)/);
  assert.match(css, /\.asset-detail \.prompt-thumb-editor\.is-canvas-layout/);
});

test('backend contracts include safe storage, cleanup, and backup remapping', () => {
  const source = fs.readFileSync(path.join(root, 'main.py'), 'utf8');
  assert.match(source, /PROMPT_THUMBNAIL_DIR = os\.path\.join\(ASSETS_DIR, "prompt-thumbnails"\)/);
  assert.match(source, /source\.thumbnail\(\(512, 512\), Image\.Resampling\.LANCZOS\)/);
  assert.match(source, /@app\.post\("\/api\/prompt-libraries\/items\/\{item_id\}\/thumbnail"\)/);
  assert.match(source, /@app\.delete\("\/api\/prompt-libraries\/items\/\{item_id\}\/thumbnail"\)/);
  assert.match(source, /remove_prompt_thumbnail\(removed\.get\("thumbnail"\)\)/);
  assert.match(source, /backup:\/\/prompt-thumbnails\//);
  assert.match(source, /backup_restore_prompt_thumbnails/);
});
