'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { rewrite } = require('../panel');

const PLAB = '\\newcommand{\\plab}[3]{\\llap{\\makebox[\\wd0][l]{\\hspace{#1\\wd0}' +
    '\\raisebox{#2\\ht0}[0pt][0pt]{\\small\\textbf{(#3)}}}}}';

test('rewrites a box-relative label macro to \\lxPanelLabel, keeping its content', () => {
    const { out, count } = rewrite(`\\documentclass{article}\n${PLAB}\n\\begin{document}x\\end{document}\n`);
    assert.strictEqual(count, 1);
    assert.ok(out.includes('\\usepackage{lxpanel}\\newcommand{\\plab}[3]{\\lxPanelLabel{#1}{#2}{\\small\\textbf{(#3)}}}'));
    assert.ok(!out.includes('\\llap'));
});

test('leaves other three-argument macros alone', () => {
    const src = '\\newcommand{\\foo}[3]{#1 and #2 and #3}\n\\newcommand{\\bar}[3]{\\raisebox{#2pt}{#3}#1}\n';
    const { out, count } = rewrite(src);
    assert.strictEqual(count, 0);
    assert.strictEqual(out, src);
});
