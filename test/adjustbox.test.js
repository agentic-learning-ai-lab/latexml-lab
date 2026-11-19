'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { rewrite } = require('../adjustbox');

const TAB = '\\begin{tabular}{lc}\na & b \\\\\n\\end{tabular}\n';

test('drops a width-only adjustbox around a tabular', () => {
    const { out, count } = rewrite(`\\begin{adjustbox}{max width=\\linewidth}\n${TAB}\\end{adjustbox}`);
    assert.strictEqual(count, 1);
    assert.strictEqual(out, `\n${TAB}`);
});

test('keeps adjustbox with other keys, or around non-tables', () => {
    const rot = `\\begin{adjustbox}{angle=90}\n${TAB}\\end{adjustbox}`;
    const img = '\\begin{adjustbox}{max width=\\linewidth}\\includegraphics{a}\\end{adjustbox}';
    assert.strictEqual(rewrite(rot).count, 0);
    assert.strictEqual(rewrite(img).count, 0);
    assert.strictEqual(rewrite(rot + img).out, rot + img);
});
