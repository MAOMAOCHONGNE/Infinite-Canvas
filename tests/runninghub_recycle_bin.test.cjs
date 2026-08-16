const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'static/js/api-settings.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'static/api-settings.html'), 'utf8');

function functionBlock(name) {
  const start = js.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const next = js.indexOf('\nfunction ', start + 1);
  return js.slice(start, next === -1 ? js.length : next);
}

test('RunningHub settings expose a recycle-bin dialog and count', () => {
  assert.match(html, /id="rhRecycleBinBtn"/);
  assert.match(html, /id="rhRecycleBinCount"/);
  assert.match(html, /id="rhRecycleBinOverlay"/);
  assert.match(html, /id="rhRecycleAppsList"/);
  assert.match(html, /id="rhRecycleWorkflowsList"/);
});

test('ordinary deletion recycles without deleting workflow storage', () => {
  const block = functionBlock('removeRhEntry');
  assert.match(block, /recycled\s*:\s*true/);
  assert.match(block, /deletedAt\s*:/);
  assert.doesNotMatch(block, /method\s*:\s*['"]DELETE['"]/);
});

test('restore and purge are separate explicit actions', () => {
  const restore = functionBlock('restoreRhEntry');
  const purge = functionBlock('purgeRhEntry');
  assert.match(restore, /hidden\s*:\s*false/);
  assert.match(restore, /enabled\s*:\s*true/);
  assert.match(purge, /method\s*:\s*['"]DELETE['"]/);
  assert.match(purge, /purged\s*:\s*true/);
});

test('legacy built-in RunningHub entries remain purgeable after static merging', () => {
  const normalize = js.slice(js.indexOf('function normalizeRhEntries('), js.indexOf('\nfunction assignRhEntrySortOrders', js.indexOf('function normalizeRhEntries(')));
  const staticCheck = functionBlock('isStaticRunningHubEntry');
  assert.match(normalize, /raw\?\.builtin\s*===\s*true/);
  assert.match(staticCheck, /entry\?\.builtin\s*===\s*true/);
});
