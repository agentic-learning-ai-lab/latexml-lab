'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { engine } = require('../engine');

function tree(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-'));
    for (const [name, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        fs.writeFileSync(path.join(root, name), body);
    }
    return root;
}

test('defaults to pdflatex', () => {
    assert.strictEqual(engine(tree({ 'main.tex': '\\documentclass{article}\n\\usepackage{graphicx}\n' }), 'main.tex'), 'pdflatex');
});

test('fontspec and the lab style need xelatex; a commented package does not', () => {
    assert.strictEqual(engine(tree({ 'm.tex': '\\usepackage{amsmath,fontspec}\n' }), 'm.tex'), 'xelatex');
    assert.strictEqual(engine(tree({ 'm.tex': '\\usepackage{agenticlearning-xelatex}\n' }), 'm.tex'), 'xelatex');
    assert.strictEqual(engine(tree({ 'm.tex': '% \\usepackage{fontspec}\n' }), 'm.tex'), 'pdflatex');
});

test('the magic comment overrides packages, and 00README.json overrides both', () => {
    const root = tree({ 'p/main.tex': '%!TEX program = lualatex\n\\usepackage{fontspec}\n' });
    assert.strictEqual(engine(root, 'p/main.tex'), 'lualatex');
    fs.writeFileSync(path.join(root, 'p/00README.json'), JSON.stringify({ process: { compiler: 'pdflatex' } }));
    assert.strictEqual(engine(root, 'p/main.tex'), 'pdflatex');
});
