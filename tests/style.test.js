const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('maintained Apps Script files parse and have no trailing whitespace or merge markers', () => {
  for (const file of ['Code.gs', 'Config.gs', 'Filters.gs', 'Helpers.gs', 'tzid.gs']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotThrow(() => new vm.Script(source, {filename: file}), file);
    assert.doesNotMatch(source, /[ \t]+$/m, `${file} has trailing whitespace`);
    assert.doesNotMatch(source, /^(<<<<<<< |=======\s*$|>>>>>>> )/m, `${file} has merge markers`);
  }
});
