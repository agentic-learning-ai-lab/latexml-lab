'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mainFile } = require('../mainfile');

test('picks the paper over a template example in a wrapped source', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mainfile-'));
    fs.mkdirSync(path.join(root, 'latex'));
    fs.writeFileSync(path.join(root, 'latex', 'example_paper.tex'), '\\documentclass{article}\n');
    fs.writeFileSync(path.join(root, 'latex', 'main.tex'), '\\documentclass{article}\n');
    assert.strictEqual(mainFile(root), path.join('latex', 'main.tex'));

    // arXiv's 00README.json names the top-level file, but never outside the tree.
    fs.writeFileSync(path.join(root, 'latex', 'paper.tex'), '\\documentclass{article}\n');
    fs.writeFileSync(path.join(root, 'latex', '00README.json'),
        JSON.stringify({ sources: [{ usage: 'toplevel', filename: 'paper.tex' }] }));
    assert.strictEqual(mainFile(root), path.join('latex', 'paper.tex'));
    fs.writeFileSync(path.join(root, 'latex', '00README.json'),
        JSON.stringify({ sources: [{ usage: 'toplevel', filename: '../../etc/hosts' }] }));
    assert.strictEqual(mainFile(root), path.join('latex', 'main.tex'));
});
