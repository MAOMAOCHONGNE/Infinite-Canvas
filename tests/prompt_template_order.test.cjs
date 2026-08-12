const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const ORDER_MODULE = path.join(ROOT, 'static', 'js', 'prompt-template-order.js');
const order = require(ORDER_MODULE);

test('moveId reorders before and after without losing identifiers', () => {
    assert.deepEqual(order.moveId(['a','b','c'], 'c', 'a', false), ['c','a','b']);
    assert.deepEqual(order.moveId(['a','b','c'], 'a', 'c', true), ['b','c','a']);
    assert.deepEqual(order.moveId(['a','b','c'], 'a', 'a', true), ['a','b','c']);
});

test('mergeSubsetOrder only rearranges the active category slots', () => {
    const records = [
        {id:'a1', category:'a'},
        {id:'b1', category:'b'},
        {id:'a2', category:'a'},
        {id:'b2', category:'b'},
        {id:'a3', category:'a'},
    ];
    const result = order.mergeSubsetOrder(records, ['a1','a2','a3'], 'a3', 'a1', false);
    assert.deepEqual(result, ['a3','b1','a1','b2','a2']);
});

test('prompt cards are sortable only in one unfiltered category', () => {
    assert.equal(order.canSortItems({category:'view', query:''}), true);
    assert.equal(order.canSortItems({category:'all', query:''}), false);
    assert.equal(order.canSortItems({category:'view', query:'cat'}), false);
});

test('drop commits the last valid hover target even when dragleave clears its visual marker', async () => {
    const makeClassList = () => {
        const values = new Set();
        return {
            add(...names){ names.forEach(name => values.add(name)); },
            remove(...names){ names.forEach(name => values.delete(name)); },
            contains(name){ return values.has(name); },
        };
    };
    const listeners = {};
    const sourceRow = {dataset:{templateGroupOrderId:'a'}, classList:makeClassList()};
    const targetRow = {
        dataset:{templateGroupOrderId:'b'}, classList:makeClassList(),
        contains(){ return false; },
        getBoundingClientRect(){ return {top:100,height:40}; },
    };
    const handle = {
        dataset:{templateGroupDrag:'a'},
        closest(selector){ return selector.includes('group-drag') ? this : sourceRow; },
    };
    const targetChild = {closest(){ return targetRow; }};
    const root = {
        addEventListener(name, handler){ listeners[name] = handler; },
        removeEventListener(){}, contains(){ return true; },
        querySelectorAll(){ return [sourceRow,targetRow]; },
    };
    let committed = null;
    order.bindSortable(root, {
        handleSelector:'[data-template-group-drag]',
        targetSelector:'[data-template-group-order-id]',
        handleId:element => element?.dataset?.templateGroupDrag,
        targetId:element => element?.dataset?.templateGroupOrderId,
        onDrop:result => { committed = result; },
    });
    const dataTransfer = {setData(){}, effectAllowed:'', dropEffect:''};
    listeners.dragstart({target:handle,dataTransfer,preventDefault(){}});
    listeners.dragover({target:targetChild,dataTransfer,clientY:105,preventDefault(){}});
    listeners.dragleave({target:targetChild,relatedTarget:null});
    listeners.drop({target:targetChild,preventDefault(){},stopPropagation(){}});
    await Promise.resolve();
    assert.deepEqual(committed, {movedId:'a',targetId:'b',after:false});
});

test('both canvases load shared ordering before their controllers and expose drag handles', () => {
    const classicHtml = fs.readFileSync(path.join(ROOT, 'static', 'canvas.html'), 'utf8');
    const smartHtml = fs.readFileSync(path.join(ROOT, 'static', 'smart-canvas.html'), 'utf8');
    const classic = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas.js'), 'utf8');
    const smart = fs.readFileSync(path.join(ROOT, 'static', 'js', 'smart-canvas.js'), 'utf8');
    const classicCss = fs.readFileSync(path.join(ROOT, 'static', 'css', 'canvas.css'), 'utf8');
    const smartCss = fs.readFileSync(path.join(ROOT, 'static', 'css', 'smart-canvas.css'), 'utf8');

    assert.match(classicHtml, /prompt-template-order\.js[^]*canvas\.js/);
    assert.match(smartHtml, /prompt-template-order\.js[^]*smart-canvas\.js/);
    for(const source of [classic, smart]){
        assert.match(source, /data-template-group-drag/);
        assert.match(source, /data-template-item-drag/);
        assert.match(source, /categories\/reorder/);
        assert.match(source, /items\/reorder/);
        assert.match(source, /canSortItems/);
    }
    for(const css of [classicCss, smartCss]){
        assert.match(css, /\.prompt-template-drag-handle/);
        assert.match(css, /\.is-order-before/);
        assert.match(css, /\.is-order-after/);
    }
});
