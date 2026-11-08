# Contributing

Most fixes start from a paper that converts badly, and this page covers how
to turn one into a change.

## Reproducing a problem

Convert the paper with `./convert.sh <source> out/` and open `out/latexml.log`,
where lines starting with `Error:` name the command or package LaTeXML could
not handle, with its file and line. An `ltx_ERROR` element in
`out/paper-content.json` is an error the reader sees on the page.

Then cut the source down to a small fixture under `test/fixtures/<name>/`
that shows the same error, as `test/fixtures/boxes/` does for boxes and
listings.

## Kinds of fixes

- **Missing or broken package support.** Add `bindings/<package>.sty.ltxml`
  (or `<class>.cls.ltxml`), which takes precedence over the image's own
  binding. Support what papers use and ignore layout-only options.
- **Source rewrites.** Steps in `convert.sh` that edit the working copy
  before LaTeXML runs (TikZ, subfigures, `xcolor`). They never touch the
  caller's tree.
- **Output extraction.** `extract.js` cuts the article out of LaTeXML's page
  and copies the figures.

## Checks

```bash
npm test
shellcheck convert.sh
./convert.sh test/fixtures/boxes /tmp/out
```

CI runs the same three, plus actionlint, on every pull request. Say in the
pull request which papers you converted to check the change.

## Pull requests

Open a pull request against `main`. A maintainer reviews every one, and an
automated reviewer leaves advisory comments that never block a merge.
