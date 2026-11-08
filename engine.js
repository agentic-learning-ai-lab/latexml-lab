#!/usr/bin/env node
'use strict';

// Pick the TeX engine for a source tree's main file and print it
// (pdflatex, xelatex or lualatex). In order: arXiv's 00README.json
// "process.compiler"; a `%!TEX program = ...` comment in the main file;
// packages that only compile under XeLaTeX or LuaLaTeX; else pdflatex.
//
//   node engine.js <source-dir> <main.tex relative to it>

const fs = require('fs');
const path = require('path');

const ENGINES = ['pdflatex', 'xelatex', 'lualatex'];

function fromReadme(root) {
    const readme = path.join(root, '00README.json');
    if (!fs.existsSync(readme)) return null;
    try {
        const compiler = String((JSON.parse(fs.readFileSync(readme, 'utf8')).process || {}).compiler || '');
        return ENGINES.find(e => compiler.toLowerCase().includes(e)) || null;
    } catch {
        return null;
    }
}

function engine(root, main) {
    const fromArxiv = fromReadme(path.join(root, path.dirname(main)));
    if (fromArxiv) return fromArxiv;

    const tex = fs.readFileSync(path.join(root, main), 'utf8');
    const magic = tex.match(/^\s*%\s*!TEX\s+(?:TS-)?program\s*=\s*(\w+)/im);
    if (magic && ENGINES.includes(magic[1].toLowerCase())) return magic[1].toLowerCase();

    const code = tex.split('\n').map(l => l.replace(/(^|[^\\])%.*/, '$1')).join('\n');
    for (const m of code.matchAll(/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]*)\}/g)) {
        const names = m[1].split(',').map(s => s.trim());
        // A package named for its engine (the lab's agenticlearning-xelatex)
        // loads fontspec itself.
        if (names.some(n => /^(fontspec|xeCJK|polyglossia|mathspec|unicode-math)$/.test(n) || /xelatex/i.test(n))) return 'xelatex';
        if (names.some(n => /lualatex|^luacode$|^luatexja/i.test(n))) return 'lualatex';
    }
    return 'pdflatex';
}

if (require.main === module) {
    process.stdout.write(engine(process.argv[2], process.argv[3]));
}

module.exports = { engine };
