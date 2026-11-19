#!/usr/bin/env node
'use strict';

// LaTeXML renders a tabular inside \begin{adjustbox}{...} as nested inline
// spans instead of a <table>, so the page shows the cells as run-on text.
// A width-only adjustbox (max width, width, center) just fits the table to
// the page, which the HTML view does on its own, so this drops the wrapper
// around tables and keeps the body.
//
//   node adjustbox.js <file.tex>...     (edits in place, prints the count)

const fs = require('fs');

const WIDTH_KEYS = new Set(['max width', 'width', 'max totalwidth', 'totalwidth', 'center']);

function widthOnly(opts) {
    return opts.split(',').map(s => s.trim()).filter(Boolean)
        .every(o => WIDTH_KEYS.has(o.split('=')[0].trim().replace(/\s+/g, ' ')));
}

function rewrite(text) {
    let count = 0;
    const out = text.replace(
        /\\begin\{adjustbox\}\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}([\s\S]*?)\\end\{adjustbox\}/g,
        (whole, opts, body) => {
            if (!widthOnly(opts)) return whole;
            if (!/\\begin\{tabular[x*]?\}/.test(body)) return whole;
            if (/\\begin\{adjustbox\}/.test(body)) return whole;
            count++;
            return body;
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
