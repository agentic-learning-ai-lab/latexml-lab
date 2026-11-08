#!/usr/bin/env node
'use strict';

// LaTeXML ignores a subfigure's width: inside \begin{subfigure}{0.48\linewidth}
// it keeps \linewidth at the full page width, so every panel looks full-size
// and LaTeXML breaks rows that sit side by side in the PDF. This rewrites
// \includegraphics[width=X\linewidth] inside a subfigure of width W into
// width=(X*W)\textwidth, the panel's real size, and the subfigure's own
// width into \textwidth units.
//
//   node subfig.js <file.tex>...     (edits in place, prints the count)

const fs = require('fs');

// The subfigure's own width may be given against any of these; a panel
// inside it is relative to the subfigure only through \linewidth or \hsize
// (\textwidth and \columnwidth keep meaning the page's).
const OUTER = /^\s*([\d.]*)\s*\\(linewidth|textwidth|columnwidth|hsize)\s*$/;
const INNER = /^\s*([\d.]*)\s*\\(linewidth|hsize)\s*$/;

function fraction(spec, re = OUTER) {
    const m = re.exec(spec);
    return m ? Number(m[1] || 1) : null;
}

function rewrite(text) {
    let count = 0;
    const out = text.replace(
        /\\begin\{subfigure\}(\[[^\]]*\])?\{([^{}]*)\}([\s\S]*?)\\end\{subfigure\}/g,
        (whole, pos, width, body) => {
            const outer = fraction(width);
            if (outer === null) return whole;
            const newBody = body.replace(
                /(\\includegraphics\s*\[[^\]]*?\bwidth\s*=\s*)([^,\]]*)/g,
                (m, head, spec) => {
                    const inner = fraction(spec, INNER);
                    if (inner === null) return m;
                    count++;
                    return `${head}${+(inner * outer).toFixed(4)}\\textwidth`;
                });
            // The box itself too: LaTeXML breaks a row when the panels'
            // widths add up past \textwidth.
            return `\\begin{subfigure}${pos || ''}{${+outer.toFixed(4)}\\textwidth}${newBody}\\end{subfigure}`;
        });
    return { out, count };
}

if (require.main === module) {
    let total = 0;
    for (const file of process.argv.slice(2)) {
        const { out, count } = rewrite(fs.readFileSync(file, 'utf8'));
        if (count) fs.writeFileSync(file, out);
        total += count;
    }
    console.log(total);
}

module.exports = { rewrite };
