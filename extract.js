#!/usr/bin/env node

/**
 * Extract the article body + figures from a LaTeXML conversion into the
 * shape the lab site's full-paper viewer expects:
 *
 *   <out-dir>/paper-content.json   { html, css, source, converter?, generated }
 *   <out-dir>/assets/<figures>
 *
 * This is a port of `downloadArxivHtml` in the site repo
 * (build/build_arxiv_papers.js) minus the arXiv-specific steps:
 *
 *   - images are local files (no HTTP download), and
 *   - `arxiv.org/html/...#anchor` links do not occur in LaTeXML output,
 *     so that rewrite is dropped.
 *
 * Everything else — the article cut, nav/logo/footer removal, figure
 * `<object>`→`<img>` promotion, citation punctuation fixes, ltx_ERROR
 * and [HTML] color-code cleanup, inline `<style>` capture — is kept
 * byte-for-byte in the same order so both paths produce the same DOM.
 *
 * Usage:
 *   node extract.js <latexml-output-dir> <out-dir>
 */

const fs = require('fs');
const path = require('path');

const IMAGE_EXT = /\.(?:png|jpg|jpeg|gif|svg|webp)$/i;

/**
 * Locate the LaTeXML document in `dir`. convert.sh names it main.html;
 * tests / manual runs may produce one document under another name.
 */
function findMainHtml(dir) {
    const preferred = path.join(dir, 'main.html');
    if (fs.existsSync(preferred)) return preferred;

    const candidates = fs.readdirSync(dir)
        .filter(name => name.toLowerCase().endsWith('.html'))
        .filter(name => fs.statSync(path.join(dir, name)).isFile());
    if (candidates.length !== 1) {
        throw new Error(`Expected exactly one .html in ${dir}, found ${candidates.length}`);
    }
    return path.join(dir, candidates[0]);
}

/**
 * Pull the `<article class="ltx_document">` body out of the page.
 * LaTeXML wraps every document in one; ar5ivist inherits that.
 */
function extractArticle(html) {
    const match = html.match(/<article[^>]*class="ltx_document[^"]*"[^>]*>([\s\S]*?)<\/article>/);
    if (!match) {
        throw new Error('Could not find <article class="ltx_document"> in LaTeXML output');
    }
    return match[1];
}

/**
 * The outermost <figure class="ltx_figure…"> elements in `html`, whole
 * (subfigures are nested <figure>s, so tags are counted, not matched).
 */
function frontFigures(html) {
    const figures = [];
    const tag = /<(\/?)figure\b[^>]*>/g;
    let depth = 0;
    let start = -1;
    let m;
    while ((m = tag.exec(html))) {
        if (!m[1]) {
            if (depth === 0) start = /class="ltx_figure\b/.test(m[0]) ? m.index : -1;
            depth++;
        } else if (depth > 0) {
            depth--;
            if (depth === 0 && start >= 0) figures.push(html.substring(start, tag.lastIndex));
        }
    }
    return figures;
}

/**
 * Apply the arXiv-path cleanup steps to the article body. Order matters:
 * `<object>` figures are promoted before image collection so SVG/data
 * attributes are handled like every other <img>.
 */
function cleanupContent(content) {
    // Page chrome LaTeXML emits around the document.
    content = content.replace(/<nav[^>]*class="ltx_page_navbar"[^>]*>[\s\S]*?<\/nav>/g, '');
    content = content.replace(/<div[^>]*class="ltx_page_logo"[^>]*>[\s\S]*?<\/div>/g, '');
    content = content.replace(/<footer[^>]*>[\s\S]*?<\/footer>/g, '');

    // Keep only the main content starting from the first section
    // (drops title, authors, abstract, metadata — the site renders its
    // own header from data/papers.yaml).
    // Figures placed before the first section (a teaser right after
    // \maketitle) are kept and moved ahead of it.
    const firstSectionMatch = content.match(/(<section[^>]*class="ltx_section[^"]*"[^>]*>)/);
    if (firstSectionMatch) {
        const start = content.indexOf(firstSectionMatch[0]);
        content = frontFigures(content.substring(0, start)).join('\n') + content.substring(start);
    }

    // Rewrite <object data="x.svg"> figures as <img> so image collection
    // below sees them. Same regex as the arXiv path.
    content = content.replace(/<object\b([^>]*)>\s*<\/object>/gi, (tag, attrs) => {
        const data = attrs.match(/\sdata="([^"]+\.(?:png|jpg|jpeg|gif|svg))"/i);
        if (!data) return tag;
        const rest = attrs.replace(/\s(?:data|type)="[^"]*"/gi, '');
        const alt = /\salt="/i.test(rest) ? '' : ' alt="Refer to caption"';
        return `<img src="${data[1]}"${rest}${alt}>`;
    });

    // cleveref's "Figure~1": LaTeXML prints the ~ between the name and
    // the number as a small tilde (U+02DC). Make it the no-break space it is.
    content = content.replace(/(ltx_ref_tag">[^<]*<\/span>)\u02dc/g, '$1\u00a0');

    // Fix double commas in citations.
    content = content.replace(/,,\s*/g, ', ');

    // Normalize citation links: move author names outside of <a> tags
    // (<a>Author et al., Year</a> → Author et al., <a>Year</a>).
    content = content.replace(/<a class="ltx_ref" href="([^"]*)"[^>]*>([^<,]+,\s*)(\d{4}[a-z]?)(,?\s*)<\/a>/g,
        '$2<a class="ltx_ref" href="$1" title="">$3</a>$4');

    // Trailing comma-space before a closing paren / semicolon.
    content = content.replace(/,\s+\)/g, ')');
    content = content.replace(/,\s+;/g, ';');

    // "Author et al.,<span>, </span><a>year</a>" in tables.
    content = content.replace(/,<span class="ltx_text"[^>]*>,\s*<\/span>/g, ', ');

    // Table macros that failed to render (e.g. \rowcolor).
    content = content.replace(/<span class="ltx_ERROR undefined">\\rowcolor<\/span>/g, '');
    content = content.replace(/<span class="ltx_ERROR undefined">\\[a-zA-Z]+<\/span>/g, '');

    // Leftover [HTML] color codes from \rowcolor.
    content = content.replace(/\[HTML\][a-fA-F0-9]{6}/g, '');

    return content;
}

/**
 * True if `src` is a file we can resolve inside the conversion directory.
 * Remote URLs, data: URIs and root-absolute paths are left untouched.
 */
function isLocalImageSrc(src) {
    return Boolean(src) &&
        !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(src) &&
        IMAGE_EXT.test(src);
}

/**
 * Copy every local image the article references into `<outDir>/assets`,
 * keeping the path relative to the conversion directory (LaTeXML writes
 * top-level x1.png/x2.png; a figure included from figures/ stays under
 * figures/). That is the same naming the arXiv path uses for ar5iv
 * output (`./assets/<path-within-html-dir>`).
 *
 * Returns a map of original src → asset-relative path.
 */
function copyImages(content, sourceDir, outDir) {
    const assetsDir = path.join(outDir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });

    const assetNames = new Map();
    const srcs = new Set();
    for (const match of content.matchAll(/src="([^"]+)"/g)) {
        if (isLocalImageSrc(match[1])) srcs.add(match[1]);
    }

    for (const src of srcs) {
        const rel = src.replace(/^\.\//, '');
        const from = path.resolve(sourceDir, rel);
        // Never follow a reference out of the conversion directory.
        if (!from.startsWith(path.resolve(sourceDir) + path.sep)) {
            console.warn(`  skipping image outside the conversion dir: ${src}`);
            continue;
        }
        if (!fs.existsSync(from) || !fs.statSync(from).isFile()) {
            console.warn(`  warning: referenced image not found: ${src}`);
            continue;
        }

        const destRel = rel.split(path.sep).join('/');
        const dest = path.join(assetsDir, destRel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(from, dest);
        assetNames.set(src, destRel);
    }

    return assetNames;
}

/**
 * Point every copied image at ./assets/<file>.
 */
function rewriteImagePaths(content, assetNames) {
    return content.replace(/src="([^"]+)"/g, (match, src) => {
        const rel = assetNames.get(src);
        return rel ? `src="./assets/${rel}"` : match;
    });
}

/**
 * Full extraction: read the LaTeXML document, clean it, copy figures,
 * and write paper-content.json + assets/ under `outDir`.
 */
function extract(sourceDir, outDir) {
    const htmlPath = findMainHtml(sourceDir);
    const html = fs.readFileSync(htmlPath, 'utf8');

    let content = cleanupContent(extractArticle(html));
    const assetNames = copyImages(content, sourceDir, outDir);
    content = rewriteImagePaths(content, assetNames);

    // Same style capture as the arXiv path: every <style> tag, joined.
    const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
    const styles = styleMatch ? styleMatch.join('\n') : '';

    const output = {
        html: content.trim(),
        css: styles,
        source: 'latexml',
        // The latexml-lab commit that produced this file (set by the
        // workflow); lets the site tell which converter version it ran.
        ...(process.env.LATEXML_LAB_VERSION ? { converter: process.env.LATEXML_LAB_VERSION } : {}),
        generated: new Date().toISOString(),
    };

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
        path.join(outDir, 'paper-content.json'),
        JSON.stringify(output, null, 2) + '\n'
    );

    return { output, htmlPath, imageCount: assetNames.size };
}

function main() {
    const [sourceDir, outDir] = process.argv.slice(2);
    if (!sourceDir || !outDir) {
        console.error('Usage: node extract.js <latexml-output-dir> <out-dir>');
        process.exit(1);
    }
    try {
        const result = extract(path.resolve(sourceDir), path.resolve(outDir));
        console.log(`✓ ${result.htmlPath} → ${path.resolve(outDir)}/paper-content.json (${result.imageCount} image(s))`);
    } catch (err) {
        console.error(`extract failed: ${err.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    findMainHtml,
    extractArticle,
    cleanupContent,
    copyImages,
    rewriteImagePaths,
    extract,
};
