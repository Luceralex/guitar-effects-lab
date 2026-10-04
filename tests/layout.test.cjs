const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML, DOMParser } = require('linkedom');

const root = path.join(__dirname, '..');

test('Mentor workspaces retain every audio and trainer control', () => {
  const { window, document } = parseHTML(fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
  for (const id of [
    'source-select', 'synth-panel', 'instrument-row', 'file-panel', 'mic-panel',
    'btn-mic', 'mic-input-select', 'mic-output-select', 'master-volume', 'btn-panic',
    'btn-ab', 'viz-tabs', 'canvas-spectrum', 'fretboard-wrap', 'trainer-ctrl',
    'tb-mode', 'canvas-fretboard', 'rack-section', 'effects-rack', 'preset-select',
    'quick-load-score', 'quick-connect', 'workspace-nav',
  ]) {
    assert.equal(document.querySelectorAll(`#${id}`).length, 1, `missing or duplicated ${id}`);
  }
  assert.equal(document.querySelectorAll('#workspace-nav [data-workspace]').length, 3);
  assert.ok(document.querySelector('main #rack-section'));
  const logo = fs.readFileSync(path.join(root, 'assets', 'mentor-logo.svg'), 'utf8');
  assert.equal(new DOMParser().parseFromString(logo, 'image/svg+xml').documentElement.tagName, 'svg');

  const clicked = [];
  document.getElementById('viz-tabs').addEventListener('click', (e) => clicked.push(e.target.dataset.tab));
  const context = { document, requestAnimationFrame: (fn) => fn() };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'js', 'ui.js'), 'utf8'), context);
  const ui = context.UI;
  const tabs = [];
  ui.app = { viz: { setTab: (tab) => tabs.push(tab), forceResize() {} } };
  ui.setWorkspace('practice');
  assert.equal(document.body.dataset.workspace, 'practice');
  assert.equal(clicked.at(-1), 'fretboard');
  ui.setWorkspace('tone');
  assert.equal(document.body.dataset.workspace, 'tone');
  assert.equal(tabs.at(-1), 'none');
  ui.setWorkspace('analysis');
  assert.equal(clicked.at(-1), 'spectrum');
  assert.equal(document.querySelectorAll('#workspace-nav [aria-current="page"]').length, 1);
});
