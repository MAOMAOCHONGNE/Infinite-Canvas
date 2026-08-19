const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const JS_PATH = path.join(ROOT, 'static', 'js', 'canvas.js');
const CSS_PATH = path.join(ROOT, 'static', 'css', 'canvas.css');
const MENTIONS_PATH = path.join(ROOT, 'static', 'js', 'classic-image-mentions.js');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

function referenceItemsHarness(initialConnections, activeMentions=[]){
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const block = sourceBlock(source, 'function classicApiReferenceItems', 'function removeClassicImageMentionRecord');
    return new Function('initialConnections', 'activeMentions', `
        const connections = structuredClone(initialConnections);
        const CANVAS_REFERENCE_IMAGE_MAX = 20;
        const imageRefsOnly = refs => (refs || []).filter(ref => ref?.url && (ref.kind || 'image') === 'image').slice(0, CANVAS_REFERENCE_IMAGE_MAX);
        const classicImageMentionActiveRefs = () => structuredClone(activeMentions);
        const outputImageName = url => String(url || '').split('/').pop();
        ${block}
        return classicApiReferenceItems;
    `)(initialConnections, activeMentions);
}

function removalHarness(initialNode, initialConnections){
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const block = sourceBlock(source, 'function removeClassicImageMentionRecord', 'function classicImageMentionAssetRefs');
    const mentions = require(MENTIONS_PATH);
    return new Function('initialNode', 'initialConnections', 'CLASSIC_IMAGE_MENTION_TOOLS', `
        const node = structuredClone(initialNode);
        let connections = structuredClone(initialConnections);
        let undoCount = 0;
        let syncCount = 0;
        let renderCount = 0;
        let saveCount = 0;
        const classicImageMentionFields = () => ({text:'localPrompt', mentions:'localPromptMentions'});
        const pushUndo = () => { undoCount += 1; };
        const removeClassicConnections = predicate => {
            const removed = connections.filter(predicate);
            connections = connections.filter(connection => !predicate(connection));
            return removed;
        };
        const syncGeneratorInputs = () => { syncCount += 1; };
        const render = () => { renderCount += 1; };
        const scheduleSave = () => { saveCount += 1; };
        ${block}
        return {
            remove:reference => removeClassicApiReference(node, reference),
            state:() => ({node, connections, undoCount, syncCount, renderCount, saveCount}),
        };
    `)(initialNode, initialConnections, mentions);
}

test('ordinary API thumbnails merge connected and active at-sign references by URL', () => {
    const build = referenceItemsHarness([
        {id:'connection-a', from:'image-a', to:'generator-1'},
    ], [
        {id:'mention-a', url:'/assets/a.png', name:'A mention', marker:'图片1'},
        {id:'mention-b', url:'/assets/b.png', name:'B mention', marker:'图片2'},
    ]);
    const items = build({id:'generator-1'}, [
        {id:'image-a', label:'Connected A', refs:[{url:'/assets/a.png', name:'a.png', kind:'image'}]},
    ]);

    assert.equal(items.length, 2);
    assert.deepEqual(items.map(item => item.referenceUrl), ['/assets/a.png', '/assets/b.png']);
    assert.deepEqual(items[0].connectionIds, ['connection-a']);
    assert.equal(items[0].hasMention, true);
    assert.equal(items[0].label, 'Connected A');
    assert.deepEqual(items[1].connectionIds, []);
    assert.equal(items[1].hasMention, true);
    assert.equal(items[1].reorderable, false);
});

test('every image supplied by one multi-image upstream source points to the whole connection', () => {
    const build = referenceItemsHarness([
        {id:'connection-group', from:'group-1', to:'generator-1'},
    ]);
    const items = build({id:'generator-1'}, [
        {
            id:'group-1:prompts',
            groupId:'group-1',
            label:'Grouped references',
            refs:[
                {url:'/assets/a.png', kind:'image'},
                {url:'/assets/b.png', kind:'image'},
            ],
        },
    ]);

    assert.equal(items.length, 2);
    assert.deepEqual(items.map(item => item.connectionIds), [['connection-group'], ['connection-group']]);
    assert.deepEqual(items.map(item => item.reorderable), [false, false]);
});

test('duplicate URL from several upstream nodes keeps all contributing connection IDs', () => {
    const build = referenceItemsHarness([
        {id:'connection-a', from:'image-a', to:'generator-1'},
        {id:'connection-b', from:'image-b', to:'generator-1'},
    ]);
    const items = build({id:'generator-1'}, [
        {id:'image-a', label:'A', refs:[{url:'/assets/same.png', kind:'image'}]},
        {id:'image-b', label:'B', refs:[{url:'/assets/same.png', kind:'image'}]},
    ]);

    assert.equal(items.length, 1);
    assert.deepEqual(items[0].connectionIds, ['connection-a', 'connection-b']);
    assert.deepEqual(items[0].sourceIds, ['image-a', 'image-b']);
});

test('large thumbnail removal clears its mention and every contributing connection in one undo step', () => {
    const harness = removalHarness({
        id:'generator-1',
        localPrompt:'Use @图片1 twice: @图片1',
        localPromptMentions:[{id:'mention-a', url:'/assets/a.png', name:'a.png', marker:'图片1'}],
    }, [
        {id:'connection-a', from:'image-a', to:'generator-1'},
        {id:'connection-b', from:'image-b', to:'generator-1'},
        {id:'connection-other', from:'image-c', to:'generator-1'},
    ]);

    const result = harness.remove({
        referenceUrl:'/assets/a.png',
        hasMention:true,
        mention:{id:'mention-a', url:'/assets/a.png'},
        connectionIds:['connection-a', 'connection-b'],
    });
    const state = harness.state();

    assert.equal(result.mentionRemoved, true);
    assert.deepEqual(result.connectionIds, ['connection-a', 'connection-b']);
    assert.equal(state.node.localPrompt, 'Use twice:');
    assert.deepEqual(state.node.localPromptMentions, []);
    assert.deepEqual(state.connections.map(connection => connection.id), ['connection-other']);
    assert.equal(state.undoCount, 1);
    assert.equal(state.syncCount, 1);
    assert.equal(state.renderCount, 1);
    assert.equal(state.saveCount, 1);
});

test('mention-only thumbnail removal leaves unrelated incoming connections untouched', () => {
    const harness = removalHarness({
        id:'generator-1',
        localPrompt:'Place @图片2 above the subject',
        localPromptMentions:[{id:'mention-b', url:'/assets/b.png', name:'b.png', marker:'图片2'}],
    }, [
        {id:'connection-a', from:'image-a', to:'generator-1'},
    ]);

    const result = harness.remove({
        referenceUrl:'/assets/b.png',
        hasMention:true,
        mention:{id:'mention-b', url:'/assets/b.png'},
        connectionIds:[],
    });
    const state = harness.state();

    assert.equal(result.mentionRemoved, true);
    assert.deepEqual(result.connectionIds, []);
    assert.equal(state.node.localPrompt, 'Place above the subject');
    assert.deepEqual(state.connections.map(connection => connection.id), ['connection-a']);
    assert.equal(state.undoCount, 1);
    assert.equal(state.syncCount, 0);
});

test('connected-only thumbnail removal disconnects its source without changing prompt references', () => {
    const harness = removalHarness({
        id:'generator-1',
        localPrompt:'Keep @图片2',
        localPromptMentions:[{id:'mention-b', url:'/assets/b.png', name:'b.png', marker:'图片2'}],
    }, [
        {id:'connection-a', from:'image-a', to:'generator-1'},
        {id:'connection-b', from:'image-b', to:'generator-1'},
    ]);

    const result = harness.remove({
        referenceUrl:'/assets/a.png',
        hasMention:false,
        connectionIds:['connection-a'],
    });
    const state = harness.state();

    assert.equal(result.mentionRemoved, false);
    assert.deepEqual(result.connectionIds, ['connection-a']);
    assert.equal(state.node.localPrompt, 'Keep @图片2');
    assert.deepEqual(state.node.localPromptMentions.map(item => item.id), ['mention-b']);
    assert.deepEqual(state.connections.map(connection => connection.id), ['connection-b']);
    assert.equal(state.undoCount, 1);
    assert.equal(state.syncCount, 1);
});

test('ordinary API reference UI exposes separate inline and thumbnail delete controls', () => {
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const binding = sourceBlock(source, 'function bindClassicImageMentionEditor', 'function renderCanvasAssetLibrary');
    const renderer = sourceBlock(source, 'function renderClassicApiReferenceInputs', 'function renderVideoImageInputs');
    const refresh = sourceBlock(source, 'function refreshGeneratorInputViews', 'async function runGenerator');

    assert.match(binding, /data-classic-inline-mention-remove/);
    assert.match(binding, /removeMentionOccurrence/);
    assert.match(binding, /const occurrenceIndex = matchingTokens\.indexOf\(token\)/);
    assert.match(binding, /scheduleSave\(\);\s*}\s*, true\);/);
    assert.match(binding, /refreshNodes\(\[node\.id\]\)/);
    assert.match(renderer, /className = 'api-reference-remove'/);
    assert.match(renderer, /classList\.add\('classic-api-reference-list'\)/);
    assert.match(renderer, /removeClassicApiReference\(node, reference\)/);
    assert.match(refresh, /renderClassicApiReferenceInputs/);
    assert.match(css, /\.classic-inline-mention-remove/);
    assert.match(css, /\.api-reference-remove/);
    assert.match(css, /\.api-reference-remove\s*\{[^}]*top:2px;[^}]*right:2px;/);
    assert.doesNotMatch(css, /\.api-reference-remove\s*\{[^}]*top:-/);
    assert.match(css, /\.classic-api-reference-list\s*\{[^}]*gap:6px;[^}]*min-height:56px;/);
    assert.match(css, /\.classic-api-reference-list \.input-item\s*\{[^}]*width:50px;[^}]*height:50px;/);
});
