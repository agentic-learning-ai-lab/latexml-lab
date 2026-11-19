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

test('keeps \\renewcommand and ignores braces in comments', () => {
    const src = '\\renewcommand{\\plab}[3]{% a } in a comment\n' +
        '\\llap{\\makebox[\\wd0][l]{\\hspace{#1\\wd0}\\raisebox{#2\\ht0}[0pt][0pt]{\\textbf{(#3)}}}}}\nrest\n';
    const { out, count } = rewrite(src);
    assert.strictEqual(count, 1);
    assert.ok(out.startsWith('\\usepackage{lxpanel}\\renewcommand{\\plab}[3]{\\lxPanelLabel{#1}{#2}{\\textbf{(#3)}}}'));
    assert.ok(out.endsWith('\nrest\n'));
});

test('wraps each \\usebox0 and its label calls in \\lxPanelBox', () => {
    const src = `${PLAB}\n\\begin{minipage}{\\linewidth}\n` +
        '\\sbox0{\\includegraphics[width=\\linewidth]{a}}\\usebox0\\plab{0}{0.9}{a}\\plab{0.5}{0.9}{b}\\\\[0.2em]\n' +
        '\\sbox0{\\includegraphics{b}}\\usebox0 \\plab{0}{0.8}{c}\n\\usebox0 x\n\\end{minipage}\n';
    const { out } = rewrite(src);
    assert.ok(out.includes('\\lxPanelBox{\\usebox0\\plab{0}{0.9}{a}\\plab{0.5}{0.9}{b}}\\\\[0.2em]'));
    assert.ok(out.includes('\\lxPanelBox{\\usebox0 \\plab{0}{0.8}{c}}'));
    assert.ok(out.includes('\n\\usebox0 x\n'));
});
