const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    extractArticle,
    cleanupContent,
    extract,
} = require('../extract');

const FIXTURES = path.join(__dirname, 'fixtures');

test('cleanup cuts to the first section and applies the arXiv-path fixes', () => {
    const html = fs.readFileSync(path.join(FIXTURES, 'main.html'), 'utf8');
    const content = cleanupContent(extractArticle(html));

    assert.ok(content.startsWith('<section class="ltx_section" id="S1">'));
    assert.ok(!content.includes('This abstract must be cut.'));
    assert.ok(!content.includes('LaTeXML logo'));
    assert.ok(!content.includes('Page footer must go.'));
    assert.ok(!content.includes('ltx_page_navbar'));

    // Double comma collapsed.
    assert.ok(!content.includes(',,'));
    // Missing macro spans + [HTML] color codes removed.
    assert.ok(!content.includes('ltx_ERROR'));
    assert.ok(!content.includes('[HTML]'));
    // Citation link split: author text outside, year inside.
    assert.ok(content.includes('Smith et al., <a class="ltx_ref" href="#bib.bib1" title="">2020</a>'));
    // Trailing comma before ) / ; removed.
    assert.ok(content.includes('(a)'));
    assert.ok(content.includes('(b;'));
    // ",<span>, </span>" table artifact collapsed.
    assert.ok(content.includes('table cell, year.'));
    // cleveref's ~ as a no-break space, not a small tilde.
    assert.ok(content.includes('Figure</span>\u00a0<span class="ltx_text ltx_ref_tag">1'));
});

test('extract writes paper-content.json and copies figures to assets/', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'latexml-lab-test-'));
    const { output } = extract(FIXTURES, out);
    const doc = JSON.parse(fs.readFileSync(path.join(out, 'paper-content.json'), 'utf8'));

    assert.deepEqual(Object.keys(doc).sort(), ['css', 'generated', 'html', 'source']);
    assert.equal(doc.html, output.html);
    assert.ok(doc.css.includes('ARTICLE-STYLE'));
    // <object data=svg> becomes an <img>; both figures move under assets/.
    assert.ok(doc.html.includes('<img src="./assets/x1.svg" alt="Refer to caption">'));
    assert.ok(doc.html.includes('src="./assets/figs/pic.png"'));
    assert.ok(fs.existsSync(path.join(out, 'assets', 'figs', 'pic.png')));
    fs.rmSync(out, { recursive: true, force: true });
});
