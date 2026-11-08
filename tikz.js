#!/usr/bin/env node
'use strict';

// Helpers for convert.sh's TikZ pre-rendering:
//
//   node tikz.js scan <work-dir> <main.tex> <plan.tsv>
//       Walk the document (main file, then \input/\include in TeX's order)
//       and write one plan line per tikzpicture:
//           <file relative to work-dir> TAB <start> TAB <end>
//       where [start, end) is the byte span of the whole environment in
//       that file. Prints the number of tikzpictures.
//
//   node tikz.js replace <work-dir> <plan.tsv> [<main.tex>]
//       Replace each span with \includegraphics{tikz-N.pdf} (N = plan
//       order). All spans are validated before anything is written. With
//       the main file, a \resizebox or \scalebox around the \input of a
//       picture-only file becomes a sized \includegraphics.
//
//   node tikz.js wrap <scratch-dir> <plan.tsv>
//       In a scratch copy of the tree, wrap each planned picture in
//       \begin{lxlabpic}...\end{lxlabpic}.
//
//   node tikz.js preview <main.tex> <out.tex>
//       Copy the main file with the preview package loaded and
//       \PreviewEnvironment{lxlabpic} enabled before \begin{document}.

const fs = require('fs');
const path = require('path');

// One column per character: 1 when it is inside a % comment.
function commentMask(text) {
    const mask = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '%' || isEscaped(text, i)) continue;
        while (i < text.length && text[i] !== '\n') mask[i++] = 1;
        // leave i on the newline; the for-loop advance skips it
    }
    return mask;
}

// True when text[i] is preceded by an odd number of backslashes.
function isEscaped(text, i) {
    let n = 0;
    for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) n++;
    return n % 2 === 1;
}

const TOKEN = new RegExp(
    '\\\\(begin\\s*\\{\\s*tikzpicture\\s*\\}' +
    '|end\\s*\\{\\s*tikzpicture\\s*\\}' +
    '|input\\s*\\{([^}]*)\\}' +
    '|include\\s*\\{([^}]*)\\}' +
    '|input\\s+([^\\s{}]+))',
    'g'
);

// Events in one file, in source order: tikz spans and \input/\include.
function fileEvents(absPath) {
    const text = fs.readFileSync(absPath, 'utf8');
    const mask = commentMask(text);
    const events = [];
    let depth = 0;
    let start = -1;
    let m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(text)) !== null) {
        if (mask[m.index]) continue;
        const head = m[1];
        if (head.startsWith('begin')) {
            if (depth === 0) start = m.index;
            depth++;
        } else if (head.startsWith('end')) {
            if (depth === 0) continue;
            depth--;
            if (depth === 0) {
                events.push({ type: 'tikz', pos: start, start, end: m.index + m[0].length });
            }
        } else if (depth === 0) {
            const target = (m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '').trim();
            if (target) {
                events.push({
                    type: 'input',
                    pos: m.index,
                    target,
                    include: head.startsWith('include'),
                });
            }
        }
    }
    return events;
}

function inside(root, p) {
    return p === root || p.startsWith(root + path.sep);
}

// TeX resolves \input relative to its working directory (the main file's
// folder); fall back to the including file's folder for sources that rely
// on it. Returns a path relative to root, or null.
function resolveInput(root, baseDir, fromDir, target, include) {
    const candidates = [];
    const add = (dir) => {
        candidates.push(path.resolve(dir, target));
        if (!/\.[A-Za-z0-9]+$/.test(target)) {
            candidates.push(path.resolve(dir, target + '.tex'));
        }
    };
    add(baseDir);
    if (fromDir !== baseDir) add(fromDir);
    if (include && !/\.tex$/i.test(target)) {
        candidates.push(path.resolve(baseDir, target + '.tex'));
    }
    for (const cand of candidates) {
        if (!inside(root, cand)) continue;
        try {
            if (fs.statSync(cand).isFile()) return path.relative(root, cand);
        } catch {
            // try the next candidate
        }
    }
    return null;
}

function scan(root, mainRel) {
    const baseDir = path.dirname(path.resolve(root, mainRel));
    const found = [];
    const walk = (rel, stack) => {
        const abs = path.resolve(root, rel);
        if (stack.includes(abs)) return;
        const events = fileEvents(abs).sort((a, b) => a.pos - b.pos);
        for (const ev of events) {
            if (ev.type === 'tikz') {
                found.push({ file: rel, start: ev.start, end: ev.end });
            } else {
                const next = resolveInput(root, baseDir, path.dirname(abs), ev.target, ev.include);
                if (next) walk(next, stack.concat(abs));
            }
        }
    };
    walk(mainRel, []);
    return found;
}

function cmdScan(root, mainRel, planPath) {
    // A file \input from two places (typically both branches of an
    // \if...\else...\fi, of which TeX runs one) holds one picture: plan
    // it once, where it first appears. If TeX really draws it twice, the
    // preview's page count no longer matches and convert.sh skips TikZ.
    const all = scan(path.resolve(root), mainRel).map(f => ({ ...f, key: `${f.file}\t${f.start}\t${f.end}` }));
    const seen = new Set();
    const found = all.filter(f => !seen.has(f.key) && seen.add(f.key));
    // If repeated pictures appear in a different order later (branches
    // that list the same files in another order), the page order of the
    // preview is unknown: refuse rather than risk swapping figures.
    const lastOrder = [...new Map(all.map((f, i) => [f.key, i])).entries()]
        .sort((a, b) => a[1] - b[1]).map(([k]) => k);
    if (lastOrder.join('\n') !== found.map(f => f.key).join('\n')) {
        throw new Error('repeated tikzpictures appear in different orders');
    }
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(
        planPath,
        found.map((f) => `${f.file}\t${f.start}\t${f.end}`).join('\n') +
            (found.length ? '\n' : '')
    );
    process.stdout.write(String(found.length));
}

// A picture that is the only content of \resizebox{W}{H}{...} or
// \scalebox{s}{...} becomes \includegraphics[width=W] / [scale=s] in place
// of the whole wrapper: LaTeXML sizes a plain graphic correctly, while a
// box transform around one renders at the wrong size.
const WRAPPER = /\\(resizebox)\s*\{([^{}]*)\}\s*\{([^{}]*)\}\s*\{(?:\s|%[^\n]*\n)*$|\\(scalebox)\s*\{([^{}]*)\}\s*\{(?:\s|%[^\n]*\n)*$/;

// \resizebox{W}{H} as \includegraphics options: both sizes when both are
// given (resizebox may distort too), else the one that is.
function sizeOpts(w, h) {
    [w, h] = [w.trim(), h.trim()];
    if (w !== '!' && h !== '!') return `[width=${w},height=${h}]`;
    return w !== '!' ? `[width=${w}]` : h !== '!' ? `[height=${h}]` : '';
}

function absorbWrapper(text, start, end) {
    const m = WRAPPER.exec(text.slice(Math.max(0, start - 200), start));
    const close = /^(?:\s|%[^\n]*\n)*\}/.exec(text.slice(end));
    if (!m || !close) return { start, end, opts: '' };
    let opts;
    if (m[1]) {
        opts = sizeOpts(m[2], m[3]);
    } else {
        opts = `[scale=${m[5].trim()}]`;
    }
    return { start: start - m[0].length, end: end + close[0].length, opts };
}

function cmdReplace(root, planPath, mainRel) {
    const lines = fs.readFileSync(planPath, 'utf8').split('\n').filter(Boolean);
    const files = new Map();
    lines.forEach((line, i) => {
        const [file, startRaw, endRaw] = line.split('\t');
        const start = Number(startRaw);
        const end = Number(endRaw);
        const abs = path.resolve(root, file);
        if (!inside(path.resolve(root), abs) || !fs.existsSync(abs)) {
            throw new Error(`plan names missing file ${file}`);
        }
        if (!files.has(abs)) files.set(abs, { text: fs.readFileSync(abs, 'utf8'), edits: [] });
        const entry = files.get(abs);
        const span = entry.text.slice(start, end);
        if (!/^\\begin\s*\{\s*tikzpicture\s*\}/.test(span) ||
            !/\\end\s*\{\s*tikzpicture\s*\}\s*$/.test(span)) {
            throw new Error(`plan span for ${file} is not a tikzpicture`);
        }
        entry.edits.push({ start, end, n: i + 1 });
    });

    for (const [abs, entry] of files) {
        let text = entry.text;
        const ordered = entry.edits.slice().sort((a, b) => a.start - b.start);
        for (let i = 1; i < ordered.length; i++) {
            if (ordered[i].start < ordered[i - 1].end) {
                throw new Error(`overlapping tikzpictures in ${abs}`);
            }
        }
        // Replace from the end so earlier offsets stay valid.
        entry.edits.sort((a, b) => b.start - a.start);
        for (const edit of entry.edits) {
            const { start, end, opts } = absorbWrapper(text, edit.start, edit.end);
            text = text.slice(0, start) +
                `\\includegraphics${opts}{tikz-${edit.n}.pdf}` +
                text.slice(end);
        }
        fs.writeFileSync(abs, text);
    }

    if (mainRel) absorbInputWrappers(root, path.dirname(path.resolve(root, mainRel)), files);
}

// A picture often lives in its own file, scaled where it is included:
// \resizebox{W}{H}{\input{figures/x}}. When a replaced file now holds only
// \includegraphics{tikz-N.pdf}, rewrite such an include site into a sized
// \includegraphics, as absorbWrapper does for a wrapper in the same file.
function absorbInputWrappers(root, mainDir, files) {
    const only = new Map(); // include name -> tikz-N.pdf
    for (const [abs] of files) {
        const body = fs.readFileSync(abs, 'utf8').replace(/%[^\n]*/g, '').trim();
        const m = /^\\includegraphics\{(tikz-\d+\.pdf)\}$/.exec(body);
        if (!m) continue;
        const rel = path.relative(mainDir, abs).split(path.sep).join('/');
        only.set(rel, m[1]);
        only.set(rel.replace(/\.tex$/, ''), m[1]);
    }
    if (!only.size) return;
    const INPUT = String.raw`\\(?:input|include)\s*\{\s*([^}]+?)\s*\}`;
    const RESIZE = new RegExp(String.raw`\\resizebox\s*\{([^{}]*)\}\s*\{([^{}]*)\}\s*\{\s*` + INPUT + String.raw`\s*\}`, 'g');
    const SCALE = new RegExp(String.raw`\\scalebox\s*\{([^{}]*)\}\s*\{\s*` + INPUT + String.raw`\s*\}`, 'g');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.tex') ? [path.join(dir, e.name)] : []);
    for (const file of walk(path.resolve(root))) {
        const text = fs.readFileSync(file, 'utf8');
        const out = text
            .replace(RESIZE, (m, w, h, name) => {
                const pdf = only.get(path.posix.normalize(name));
                if (!pdf) return m;
                return `\\includegraphics${sizeOpts(w, h)}{${pdf}}`;
            })
            .replace(SCALE, (m, k, name) => {
                const pdf = only.get(path.posix.normalize(name));
                return pdf ? `\\includegraphics[scale=${k.trim()}]{${pdf}}` : m;
            });
        if (out !== text) fs.writeFileSync(file, out);
    }
}

// In a scratch copy of the tree, wrap each planned picture in
// \begin{lxlabpic}...\end{lxlabpic}. The preview compile captures only
// that environment, so an inline \tikz{...} (a tikzpicture too) does not
// become a page of its own.
function cmdWrap(root, planPath) {
    const files = new Map();
    for (const line of fs.readFileSync(planPath, 'utf8').split('\n').filter(Boolean)) {
        const [file, start, end] = line.split('\t');
        const abs = path.resolve(root, file);
        if (!inside(path.resolve(root), abs)) throw new Error(`plan names a file outside ${root}`);
        if (!files.has(abs)) files.set(abs, []);
        files.get(abs).push({ start: Number(start), end: Number(end) });
    }
    for (const [abs, spans] of files) {
        let text = fs.readFileSync(abs, 'utf8');
        for (const { start, end } of spans.sort((a, b) => b.start - a.start)) {
            text = text.slice(0, start) + '\\begin{lxlabpic}' + text.slice(start, end) +
                '\\end{lxlabpic}' + text.slice(end);
        }
        fs.writeFileSync(abs, text);
    }
}

function cmdPreview(mainPath, outPath) {
    const text = fs.readFileSync(mainPath, 'utf8');
    const mask = commentMask(text);
    let pos = -1;
    const re = /\\begin\s*\{\s*document\s*\}/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (!mask[m.index]) {
            pos = m.index;
            break;
        }
    }
    if (pos < 0) {
        process.stderr.write('no \\begin{document} found\n');
        process.exit(2);
    }

    let insert = '';
    const previewLoaded = /\\usepackage(\[[^\]]*\])?\{[^}]*\bpreview\b[^}]*\}/.test(
        text.replace(/%.*$/gm, '')
    );
    if (!previewLoaded) {
        insert += '\\usepackage[active,tightpage]{preview}\n';
    }
    insert += '\\newenvironment{lxlabpic}{}{}\\PreviewEnvironment{lxlabpic}\n';
    if (pos > 0 && text[pos - 1] !== '\n') insert = '\n' + insert;

    // The image has no XeLaTeX, so a XeLaTeX paper's pictures compile with
    // LuaLaTeX, which runs fontspec too; let it past iftex's \RequireXeTeX.
    const hook = '\\AddToHook{package/iftex/after}{\\let\\RequireXeTeX\\relax}\n';
    fs.writeFileSync(outPath, hook + text.slice(0, pos) + insert + text.slice(pos));
}

function main(argv) {
    const [mode, ...args] = argv;
    try {
        if (mode === 'scan' && args.length === 3) {
            cmdScan(args[0], args[1], args[2]);
        } else if (mode === 'replace' && (args.length === 2 || args.length === 3)) {
            cmdReplace(args[0], args[1], args[2]);
        } else if (mode === 'wrap' && args.length === 2) {
            cmdWrap(args[0], args[1]);
        } else if (mode === 'preview' && args.length === 2) {
            cmdPreview(args[0], args[1]);
        } else {
            process.stderr.write('usage: tikz.js scan|replace|wrap|preview ...\n');
            process.exit(64);
        }
    } catch (err) {
        process.stderr.write(`tikz.js: ${err.message}\n`);
        process.exit(1);
    }
}

main(process.argv.slice(2));
