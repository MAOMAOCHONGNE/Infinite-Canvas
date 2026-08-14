const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const HELPER_PATH = path.join(ROOT, 'static', 'js', 'classic-image-mentions.js');

test('classic image mentions map named images while preserving connected references', () => {
    const mentions = require(HELPER_PATH);
    const request = mentions.buildPromptRequest({
        text: '保留 @人物 的脸，改成 @服装 的款式',
        defaultRefs: [{url:'/assets/person.png', name:'人物'}],
        mentions: [
            {id:'person', url:'/assets/person.png', name:'人物'},
            {id:'dress', url:'/assets/dress.png', name:'服装'},
        ],
    });

    assert.equal(request.mentioned, true);
    assert.deepEqual(request.refs.map(item => item.url), ['/assets/person.png', '/assets/dress.png']);
    assert.match(request.prompt, /图1：人物/);
    assert.match(request.prompt, /图2：服装/);
    assert.match(request.prompt, /保留 图1 的脸，改成 图2 的款式/);
});

test('unmentioned connected images keep the legacy prompt and request behavior', () => {
    const mentions = require(HELPER_PATH);
    const request = mentions.buildPromptRequest({
        text: '生成一张海报',
        defaultRefs: [{url:'/assets/person.png', name:'人物'}],
        mentions: [{id:'dress', url:'/assets/dress.png', name:'服装'}],
    });

    assert.equal(request.prompt, '生成一张海报');
    assert.equal(request.mentioned, false);
    assert.deepEqual(request.refs.map(item => item.url), ['/assets/person.png']);
});

test('typing at-sign then choosing an image creates a stable unique marker', () => {
    const mentions = require(HELPER_PATH);
    const first = mentions.insertMention({
        text:'参考 @',
        selectionStart:4,
        selectionEnd:4,
        ref:{url:'/assets/a.png', name:'商品图'},
        mentions:[],
    });
    const second = mentions.insertMention({
        text:`${first.text}再参考 @`,
        selectionStart:first.text.length + 5,
        selectionEnd:first.text.length + 5,
        ref:{url:'/assets/b.png', name:'商品图'},
        mentions:first.mentions,
    });

    assert.equal(first.text, '参考 @商品图 ');
    assert.equal(second.mentions[1].name, '商品图（2）');
    assert.match(second.text, /@商品图（2）/);
});

test('numbered image markers keep the real filename as hover and request metadata', () => {
    const mentions = require(HELPER_PATH);
    const inserted = mentions.insertMention({
        text:'Edit @',
        selectionStart:6,
        selectionEnd:6,
        ref:{url:'/assets/real-file.png', name:'real-file.png', marker:'图片2'},
        mentions:[],
    });

    assert.equal(inserted.text, 'Edit @图片2 ');
    assert.equal(inserted.mentions[0].marker, '图片2');
    assert.equal(inserted.mentions[0].name, 'real-file.png');

    const request = mentions.buildPromptRequest({
        text:inserted.text,
        defaultRefs:[{url:'/assets/other.png', name:'other.png'}],
        mentions:inserted.mentions,
    });
    assert.equal(request.mentioned, true);
    assert.deepEqual(request.refs.map(item => item.url), ['/assets/other.png', '/assets/real-file.png']);
    assert.doesNotMatch(request.prompt, /@图片2/);
    assert.match(request.prompt, /real-file\.png/);
});

test('choosing a numbered image upgrades an existing filename marker without losing text', () => {
    const mentions = require(HELPER_PATH);
    const text = 'Use @real-file.png then @';
    const inserted = mentions.insertMention({
        text,
        selectionStart:text.length,
        selectionEnd:text.length,
        ref:{url:'/assets/real-file.png', name:'real-file.png', marker:'图片1'},
        mentions:[{id:'legacy', url:'/assets/real-file.png', name:'real-file.png'}],
    });

    assert.equal(inserted.text, 'Use @图片1 then @图片1 ');
    assert.equal(inserted.mentions.length, 1);
    assert.equal(inserted.mentions[0].marker, '图片1');
    assert.equal(inserted.mentions[0].name, 'real-file.png');
});

test('removing a mention removes its marker without affecting other text', () => {
    const mentions = require(HELPER_PATH);
    const result = mentions.removeMention({
        text:'保留 @人物 ，参考 @服装 。',
        mention:{id:'dress', url:'/assets/dress.png', name:'服装'},
        mentions:[
            {id:'person', url:'/assets/person.png', name:'人物'},
            {id:'dress', url:'/assets/dress.png', name:'服装'},
        ],
    });

    assert.equal(result.text, '保留 @人物 ，参考 。');
    assert.deepEqual(result.mentions.map(item => item.id), ['person']);
});

test('a suffixed duplicate marker does not accidentally activate the shorter name', () => {
    const mentions = require(HELPER_PATH);
    const request = mentions.buildPromptRequest({
        text:'只参考 @商品图（2）',
        defaultRefs:[],
        mentions:[
            {id:'first', url:'/assets/first.png', name:'商品图'},
            {id:'second', url:'/assets/second.png', name:'商品图（2）'},
        ],
    });

    assert.deepEqual(request.refs.map(item => item.url), ['/assets/second.png']);
    assert.match(request.prompt, /只参考 图1/);
});

test('classic canvas loads and integrates the mention helper for API and LLM node mode', () => {
    const html = fs.readFileSync(path.join(ROOT, 'static', 'canvas.html'), 'utf8');
    const source = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas.js'), 'utf8');

    assert.match(html, /classic-image-mentions\.js/);
    assert.match(source, /localPromptMentions/);
    assert.match(source, /llmInputMentions/);
    assert.match(source, /buildClassicGeneratorMentionRequest/);
    assert.match(source, /buildClassicLLMMentionRequest/);
    assert.match(source, /data-classic-image-mention-chips/);
});

test('composite prompt mapping keeps same-name mentions bound to their own source images', () => {
    const mentions = require(HELPER_PATH);
    const request = mentions.buildCompositePromptRequest({
        defaultRefs:[],
        parts:[
            {
                text:'让 @商品图 保持红色',
                mentions:[{id:'red', url:'/assets/red.png', name:'商品图'}],
            },
            {
                text:'再参考 @商品图 的构图',
                mentions:[{id:'blue', url:'/assets/blue.png', name:'商品图'}],
            },
        ],
    });

    assert.equal(request.mentioned, true);
    assert.deepEqual(request.refs.map(item => item.url), ['/assets/red.png', '/assets/blue.png']);
    assert.match(request.prompt, /让 图1 保持红色/);
    assert.match(request.prompt, /再参考 图2 的构图/);
});

test('chat message records snapshot each turn image list independently', () => {
    const mentions = require(HELPER_PATH);
    const first = mentions.buildChatMessage({
        content:'分析 @正面图',
        requestContent:'分析 图1',
        refs:[{url:'/assets/front.png', name:'正面图'}],
    });
    const second = mentions.buildChatMessage({
        content:'分析 @背面图',
        requestContent:'分析 图1',
        refs:[{url:'/assets/back.png', name:'背面图'}],
    });

    assert.deepEqual(first.images.map(item => item.url), ['/assets/front.png']);
    assert.deepEqual(second.images.map(item => item.url), ['/assets/back.png']);
    assert.equal(first.content, '分析 @正面图');
    assert.equal(first.requestContent, '分析 图1');
    second.images[0].name = 'changed';
    assert.equal(first.images[0].name, '正面图');
});

test('classic Chat and Prompt modes persist and propagate their image mentions', () => {
    const source = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas.js'), 'utf8');
    const backend = fs.readFileSync(path.join(ROOT, 'main.py'), 'utf8');

    assert.match(source, /chatInputMentions/);
    assert.match(source, /promptMentions/);
    assert.match(source, /data-mention-mode="chat"/);
    assert.match(source, /data-mention-mode="prompt"/);
    assert.match(source, /buildCompositePromptRequest/);
    assert.match(source, /requestContent/);
    assert.match(source, /llm-chat-message-images/);
    assert.match(backend, /display_message/);
    assert.match(backend, /message_images/);
    assert.match(backend, /canvas_llm_history_message/);
});

test('classic canvas renders numbered image chips and supports click-to-mention thumbnails', () => {
    const source = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas.js'), 'utf8');
    const styles = fs.readFileSync(path.join(ROOT, 'static', 'css', 'canvas.css'), 'utf8');

    assert.match(source, /classicImageMentionLabel/);
    assert.match(source, /insertClassicImageMentionRef/);
    assert.match(source, /bindClassicImageMentionThumbnailClicks/);
    assert.match(source, /data-classic-image-mention-index/);
    assert.match(source, /图片\$\{index \+ 1\}/);
    assert.match(styles, /input-item\.is-mentionable/);
    assert.match(styles, /llm-chat-message-image-label/);
});

test('classic inline mention parts embed numbered images between text and round-trip to saved prompt text', () => {
    const mentions = require(HELPER_PATH);
    const text = 'Use @\u56fe\u72471 and @\u56fe\u72472 now';
    const records = [
        {id:'one', url:'/assets/one.png', thumbnail:'/thumbs/one.png', name:'one-file.png', marker:'\u56fe\u72471'},
        {id:'two', url:'/assets/two.png', name:'two-file.png', marker:'\u56fe\u72472'},
    ];

    const parts = mentions.inlineParts(text, records);

    assert.deepEqual(parts.map(part => part.type), ['text', 'mention', 'text', 'mention', 'text']);
    assert.equal(parts[1].label, '\u56fe\u72471');
    assert.equal(parts[1].name, 'one-file.png');
    assert.equal(parts[1].thumbnail, '/thumbs/one.png');
    assert.equal(parts[3].label, '\u56fe\u72472');
    assert.equal(mentions.inlineText(parts), text);
});

test('classic inline mention markup renders a non-editable thumbnail token inside escaped prompt text', () => {
    const mentions = require(HELPER_PATH);
    const html = mentions.inlineHtml('Before <tag> @\u56fe\u72471 after', [
        {id:'one', url:'/assets/one.png', name:'real-file.png', marker:'\u56fe\u72471'},
    ]);

    assert.match(html, /Before &lt;tag&gt; /);
    assert.match(html, /class="classic-inline-mention-token"/);
    assert.match(html, /contenteditable="false"/);
    assert.match(html, /<img[^>]+src="\/assets\/one\.png"/);
    assert.match(html, /title="real-file\.png"/);
    assert.match(html, />\u56fe\u72471<\/span>/);
    assert.doesNotMatch(html, /@\u56fe\u72471/);
});

test('classic inline mention can display an image number while preserving a legacy filename marker', () => {
    const mentions = require(HELPER_PATH);
    const parts = mentions.inlineParts('Use @legacy-file.png', [
        {id:'legacy', url:'/assets/legacy.png', name:'legacy-file.png', marker:'legacy-file.png', label:'\u56fe\u72471'},
    ]);

    assert.equal(parts[1].label, '\u56fe\u72471');
    assert.equal(parts[1].marker, 'legacy-file.png');
    assert.equal(mentions.inlineText(parts), 'Use @legacy-file.png');
});

test('classic inline editor serializes DOM text, line breaks, and image tokens to the saved plain prompt', () => {
    const mentions = require(HELPER_PATH);
    const textNode = text => ({nodeType:3, textContent:text});
    const element = (tagName, children=[], options={}) => ({
        nodeType:1,
        tagName,
        childNodes:children,
        dataset:options.dataset || {},
        classList:{contains:name => (options.classes || []).includes(name)},
    });
    const root = element('DIV', [
        textNode('First '),
        element('SPAN', [], {classes:['classic-inline-mention-token'], dataset:{marker:'\u56fe\u72471', name:'one.png', url:'/one.png'}}),
        element('BR'),
        textNode('Second line'),
    ]);

    const parts = mentions.inlineDomParts(root);

    assert.equal(mentions.inlineText(parts), 'First @\u56fe\u72471\nSecond line');
    assert.equal(parts[1].type, 'mention');
    assert.equal(parts[1].url, '/one.png');
});

test('classic inline editor treats the browser placeholder break as an empty saved prompt', () => {
    const mentions = require(HELPER_PATH);
    const root = {
        nodeType:1,
        tagName:'DIV',
        childNodes:[{nodeType:1, tagName:'BR', childNodes:[], classList:{contains:() => false}, dataset:{}}],
        classList:{contains:() => false},
    };

    assert.equal(mentions.inlineEditorText(root), '');
});

test('classic API prompt renderer uses one inline contenteditable surface instead of an external chip row', () => {
    const source = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas.js'), 'utf8');
    const start = source.indexOf('function classicApiLocalPromptEditorHtml');
    const end = source.indexOf('function classicApiPromptSectionHtml', start);
    assert.ok(start >= 0 && end > start, 'classic API prompt renderer boundary must exist');
    const context = {
        escapeHtml:value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;'),
        escapeAttr:value => String(value ?? '').replace(/"/g, '&quot;'),
        tr:key => key,
    };
    vm.runInNewContext(`${source.slice(start, end)}\nresult = classicApiLocalPromptEditorHtml({id:'api-1', localPrompt:'Use @\\u56fe\\u72471'}, false, false);`, context);

    assert.match(context.result, /class="api-local-prompt-input classic-inline-mention-editor"/);
    assert.match(context.result, /contenteditable="true"/);
    assert.match(context.result, /role="textbox"/);
    assert.doesNotMatch(context.result, /<textarea/);
    assert.doesNotMatch(context.result, /data-mention-mode="api"/);
});
