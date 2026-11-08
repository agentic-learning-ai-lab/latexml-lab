#!/usr/bin/env node
'use strict';

// Pick the main .tex of a source tree and print its path relative to the
// tree. In order: the "toplevel" file named by arXiv's 00README.json;
// the shallowest main.tex or ms.tex with \documentclass; the shallowest
// .tex with \documentclass. Sources are often wrapped in one
// folder and may carry a template's example paper next to the real one.
//
//   node mainfile.js <source-dir>

const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.isFile()) out.push(full);
    }
    return out;
}

const declaresDocument = (file) =>
    fs.readFileSync(file, 'latin1').split('\n').some(l => /^[^%]*\\documentclass/.test(l));

function mainFile(root) {
    const files = walk(root);
    const depth = (f) => path.relative(root, f).split(path.sep).length;
    const byDepth = (a, b) => depth(a) - depth(b) || a.localeCompare(b);

    for (const readme of files.filter(f => path.basename(f) === '00README.json').sort(byDepth)) {
        try {
            const spec = JSON.parse(fs.readFileSync(readme, 'utf8'));
            const top = (spec.sources || []).find(s => s.usage === 'toplevel');
            const cand = top && path.join(path.dirname(readme), top.filename);
            const rel = cand && path.relative(root, cand);
            if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && fs.existsSync(cand)) return rel;
        } catch {
            // a malformed README falls through to the other rules
        }
    }
    const tex = files.filter(f => f.endsWith('.tex') && declaresDocument(f)).sort(byDepth);
    const preferred = tex.find(f => ['main.tex', 'ms.tex'].includes(path.basename(f)));
    const pick = preferred || tex[0];
    return pick ? path.relative(root, pick) : null;
}

if (require.main === module) {
    const found = mainFile(process.argv[2]);
    if (!found) process.exit(1);
    process.stdout.write(found);
}

module.exports = { mainFile };
