#!/usr/bin/env node
'use strict';

// Panel labels drawn over a figure with a box-relative macro, e.g.
//
//   \newcommand{\plab}[3]{\llap{\makebox[\wd0][l]{\hspace{#1\wd0}%
//       \raisebox{#2\ht0}[0pt][0pt]{\small\textbf{(#3)}}}}}
//   \sbox0{\includegraphics[width=\linewidth]{fig}}\usebox0\plab{0}{0.88}{a}
//
// LaTeXML drops the \hspace and turns the \raisebox into an absolute
// offset in pt, so the labels land beside the image and push the caption
// down. This rewrites such a macro to \lxPanelLabel{x}{y}{label}
// (bindings/lxpanel.sty.ltxml), which keeps x and y as fractions of the
// image box for CSS to place.
//
//   node panel.js <file.tex>...     (edits in place, prints the count)

const fs = require('fs');

// Balanced {...} group starting at text[i] === '{'; returns end index (exclusive).
function group(text, i) {
    let depth = 0;
    for (let k = i; k < text.length; k++) {
        const c = text[k];
        if (c === '\\') { k++; continue; }
        if (c === '%') {  // a comment runs to the end of the line
            const nl = text.indexOf('\n', k);
            if (nl < 0) return -1;
            k = nl;
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return k + 1;
    }
    return -1;
}

function rewrite(text) {
    let count = 0;
    let out = '';
    let pos = 0;
    const names = [];
    const DEF = /\\((?:re)?newcommand)\*?\s*\{?\s*(\\[A-Za-z@]+)\s*\}?\s*\[\s*3\s*\]\s*\{/g;
    let m;
    while ((m = DEF.exec(text)) !== null) {
        const bodyStart = m.index + m[0].length - 1;
        const bodyEnd = group(text, bodyStart);
        if (bodyEnd < 0) continue;
        const body = text.slice(bodyStart + 1, bodyEnd - 1);
        // A box-relative label: x from #1 times the box width, y from #2
        // times the box height, label content inside a \raisebox.
        if (!/#1\s*\\wd\s*0/.test(body) || !/#2\s*\\ht\s*0/.test(body)) continue;
        const rb = /\\raisebox\s*\{\s*#2\s*\\ht\s*0\s*\}(\s*\[[^\]]*\]){0,2}\s*\{/.exec(body);
        if (!rb) continue;
        const cStart = rb.index + rb[0].length - 1;
        const cEnd = group(body, cStart);
        if (cEnd < 0) continue;
        const content = body.slice(cStart + 1, cEnd - 1);
        if (!content.includes('#3')) continue;
        out += text.slice(pos, m.index) +
            `\\usepackage{lxpanel}\\${m[1]}{${m[2]}}[3]{\\lxPanelLabel{#1}{#2}{${content}}}`;
        names.push(m[2]);
        pos = bodyEnd;
        DEF.lastIndex = bodyEnd;
        count++;
    }
    out += text.slice(pos);
    if (names.length) out = wrapUses(out, names);
    return { out, count };
}

// Each `\usebox0` followed by label calls becomes
// `\lxPanelBox{\usebox0\plab{..}{..}{..}...}`, so the image and its labels
// share one positioning box in the HTML (LaTeXML otherwise puts an image in
// a minipage in its own paragraph, apart from the labels).
function wrapUses(text, names) {
    const alt = names.map(n => n.replace(/[\\@]/g, c => '\\' + c)).join('|');
    const USE = new RegExp(`\\\\usebox\\s*\\{?\\s*0\\s*\\}?(?=\\s*(?:${alt})\\b)`, 'g');
    const CALL = new RegExp(`^\\s*(?:${alt})(?![A-Za-z@])\\s*`);
    let out = '';
    let pos = 0;
    let m;
    while ((m = USE.exec(text)) !== null) {
        let end = m.index + m[0].length;
        let c;
        while ((c = CALL.exec(text.slice(end))) !== null) {
            let k = end + c[0].length;
            let ok = true;
            for (let a = 0; a < 3; a++) {
                while (/\s/.test(text[k])) k++;
                if (text[k] !== '{') { ok = false; break; }
                const e = group(text, k);
                if (e < 0) { ok = false; break; }
                k = e;
            }
            if (!ok) break;
            end = k;
        }
        out += text.slice(pos, m.index) + '\\lxPanelBox{' + text.slice(m.index, end) + '}';
        pos = end;
        USE.lastIndex = end;
    }
    return out + text.slice(pos);
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
