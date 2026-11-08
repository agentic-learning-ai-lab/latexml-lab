# latexml-lab

latexml-lab turns a paper's LaTeX source into the full-paper HTML view on
[agenticlearning.ai](https://agenticlearning.ai). It runs the converter arXiv
uses for its own HTML papers, [`latexml/ar5ivist`](https://github.com/dginev/ar5ivist),
so the output has arXiv's `ltx_*` markup, and the site uses it for every paper
whether or not the paper is on arXiv.

## Quick start

You need Docker and Node 20:

```bash
./convert.sh path/to/latex-source out/
```

The source directory holds the paper's `.tex` files, figures and `.bib` or
`.bbl`, and `out/` receives `paper-content.json`, the figures in `assets/`,
and `latexml.log`. The first run pulls the `latexml/ar5ivist:2512.17` image,
which is about 2.5 GB.

## The PDF

```bash
./pdf.sh path/to/latex-source out/paper.pdf
```

`pdf.sh` compiles the same source with `latexmk` on TeX Live 2025
(`texlive/texlive:TL2025-historic`, pinned by digest), then finalizes it
with `qpdf`. The source is untrusted, so the compile has no network, no
shell escape and no `latexmkrc`, and it always starts from scratch. The
same source compiles to the same bytes, except in a document that uses
TeX's random numbers or after a `qpdf` upgrade. It needs Docker and `qpdf`. The site's conversion workflow
runs it beside `convert.sh`, and a failed compile fails the run.

The engine is chosen in this order:

1. The lab template, loaded from the main file or from a file it inputs:
   `agenticlearning-xelatex` compiles with XeLaTeX (or LuaLaTeX with a
   `%!TEX program = lualatex` comment) and `agenticlearning-lualatex` with
   LuaLaTeX. The `-pdflatex` variant is refused.
2. arXiv's `00README.json` compiler.
3. A `%!TEX program = ...` comment in the main file.
4. A LuaTeX-only package (`luacode`, `luatexja`) means LuaLaTeX; `fontspec`,
   `unicode-math`, `polyglossia`, `xeCJK` or `mathspec` mean XeLaTeX.
5. Otherwise pdfLaTeX.

## Additions to arXiv's pipeline

Each step below runs before or after `latexmlc`, which itself runs unchanged.

| Step | What it fixes |
|---|---|
| Bibliography | A source with a `.bib` but no `.bbl` gets one from BibTeX, run on the cite keys the paper uses. A paper that cites with plain `\cite` gets an author-year bibliography for the web view; its PDF keeps its own style. |
| TikZ | Each `tikzpicture` is compiled with `pdflatex` and replaced by the resulting image. LaTeXML's own TikZ output often overlaps text and shapes. |
| Subfigures | Panel widths are rewritten into `\textwidth` units, so panels that sit side by side in the PDF stay side by side. |
| Figures | PDF and EPS figures are re-rendered at least 1400 px wide, cropped as `trim` says. A raster figure that LaTeXML shrank is replaced by its original, scaled down to 1400 px if wider. |
| `xcolor` options | The paper's `xcolor` options are passed before any package loads it, so `\rowcolor` and the `dvipsnames` colours survive. |
| Bindings | `bindings/` overrides or adds LaTeXML support for `tcolorbox`, `\lstnewenvironment`, `multibib`, `unicode-math` and the `fairmeta` class. |

## GitHub Actions workflow

`.github/workflows/convert.yml` converts a source tarball given by URL and
uploads the result as the artifact `latexml-lab-<slug>`. It runs only on
`workflow_dispatch`: the site starts it with `npm run paper:html -- <slug>`
and then installs the artifact.

## Limitations

- LaTeXML ignores a local `.cls` it has no binding for, and falls back to a
  generic class, so commands the class defines render as errors. The fix is
  a binding in `bindings/`, as `fairmeta.cls.ltxml` is for Meta's template.
- biblatex sources are converted without a bibliography.
- The image has no XeLaTeX, so TikZ pictures in a paper that needs it stay
  as LaTeXML's SVG.

## License

MIT. See [LICENSE](LICENSE).
