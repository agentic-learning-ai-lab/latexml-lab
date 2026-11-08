#!/usr/bin/env node
'use strict';

// Pick the TeX engine for a source tree's main file and print it
// (pdflatex, xelatex or lualatex). In order: the lab template
// (agenticlearning-xelatex or -lualatex; the -pdflatex variant is
// refused); arXiv's 00README.json "process.compiler"; a
// `%!TEX program = ...` comment in the main file; packages that only
// compile under XeLaTeX or LuaLaTeX; else pdflatex.
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
    const tex = fs.readFileSync(path.join(root, main), 'utf8');
    const magicMatch = tex.match(/^\s*%\s*!TEX\s+(?:TS-)?program\s*=\s*(\w+)/im);
    const magic = magicMatch && ENGINES.includes(magicMatch[1].toLowerCase()) ? magicMatch[1].toLowerCase() : null;
    const code = tex.split('\n').map(l => l.replace(/(^|[^\\])%.*/, '$1')).join('\n');
    const packages = [...code.matchAll(/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]*)\}/g)]
        .flatMap(m => m[1].split(',').map(s => s.trim()));

    // The lab template compiles with XeLaTeX or LuaLaTeX, never pdfLaTeX,
    // whatever else the source says.
    const lab = packages.find(n => /^agenticlearning-(pdf|xe|lua)latex$/.test(n));
    if (lab === 'agenticlearning-pdflatex') {
        throw new Error('The lab template compiles with XeLaTeX: replace \\usepackage{agenticlearning-pdflatex} with \\usepackage{agenticlearning-xelatex}.');
    }
    if (lab === 'agenticlearning-lualatex') return 'lualatex';
    if (lab) return magic === 'lualatex' ? 'lualatex' : 'xelatex';

    const fromArxiv = fromReadme(path.join(root, path.dirname(main)));
    if (fromArxiv) return fromArxiv;
    if (magic) return magic;
    for (const n of packages) {
        if (/^(fontspec|xeCJK|polyglossia|mathspec|unicode-math)$/.test(n) || /xelatex/i.test(n)) return 'xelatex';
        if (/lualatex|^luacode$|^luatexja/i.test(n)) return 'lualatex';
    }
    return 'pdflatex';
}

if (require.main === module) {
    try {
        process.stdout.write(engine(process.argv[2], process.argv[3]));
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
}

module.exports = { engine };
