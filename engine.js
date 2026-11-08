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

// arXiv's 00README.json next to the main file, else at the root.
function fromReadme(root, main) {
    for (const dir of [path.join(root, path.dirname(main)), root]) {
        const readme = path.join(dir, '00README.json');
        if (!fs.existsSync(readme)) continue;
        try {
            const compiler = String((JSON.parse(fs.readFileSync(readme, 'utf8')).process || {}).compiler || '').toLowerCase();
            const found = ENGINES.find(e => compiler.includes(e));
            if (found) return found;
        } catch {
            // a malformed README falls through to the other rules
        }
    }
    return null;
}

// Drop TeX comments: a % preceded by an even number of backslashes.
const stripComments = (tex) => tex.split('\n').map(l => l.replace(/(^|[^\\])((?:\\\\)*)%.*/, '$1$2')).join('\n');

// Packages loaded by the main file and the local files it \input s,
// \include s or loads as a .sty or .cls, so a template loaded from a
// preamble file is still seen.
function packagesOf(root, main) {
    const seen = new Set();
    const packages = [];
    const visit = (file) => {
        const full = path.resolve(root, file);
        if (seen.has(full) || !full.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(full)) return;
        seen.add(full);
        const code = stripComments(fs.readFileSync(full, 'latin1'));
        const dir = path.dirname(full);
        for (const m of code.matchAll(/\\(?:usepackage|RequirePackage|documentclass|LoadClass)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
            for (const name of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
                packages.push(name);
                visit(path.join(dir, name + '.sty'));
                visit(path.join(dir, name + '.cls'));
            }
        }
        for (const m of code.matchAll(/\\(?:input|include|subfile)\s*\{([^}]+)\}/g)) {
            const name = m[1].trim();
            visit(path.join(dir, name));
            visit(path.join(dir, name + '.tex'));
        }
    };
    visit(main);
    return packages;
}

function engine(root, main) {
    const tex = fs.readFileSync(path.join(root, main), 'utf8');
    const magicMatch = tex.match(/^\s*%\s*!TEX\s+(?:TS-)?program\s*=\s*(\w+)/im);
    const magic = magicMatch && ENGINES.includes(magicMatch[1].toLowerCase()) ? magicMatch[1].toLowerCase() : null;
    const packages = packagesOf(root, main);

    // The lab template compiles with XeLaTeX or LuaLaTeX, never pdfLaTeX,
    // whatever else the source says.
    const lab = new Set(packages.filter(n => /^agenticlearning-(pdf|xe|lua)latex$/.test(n)));
    if (lab.has('agenticlearning-pdflatex')) {
        throw new Error('The lab template compiles with XeLaTeX: replace \\usepackage{agenticlearning-pdflatex} with \\usepackage{agenticlearning-xelatex}.');
    }
    if (lab.has('agenticlearning-lualatex')) return 'lualatex';
    if (lab.size) return magic === 'lualatex' ? 'lualatex' : 'xelatex';

    const fromArxiv = fromReadme(root, main);
    if (fromArxiv) return fromArxiv;
    if (magic) return magic;
    // LuaTeX-only packages win over ones XeLaTeX and LuaLaTeX share.
    if (packages.some(n => /lualatex|^luacode$|^luatexja|^lua-/i.test(n))) return 'lualatex';
    if (packages.some(n => /^(fontspec|xeCJK|polyglossia|mathspec|unicode-math)$/.test(n) || /xelatex/i.test(n))) return 'xelatex';
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
