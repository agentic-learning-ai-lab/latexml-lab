#!/usr/bin/env bash
#
# Compile a LaTeX source tree to paper.pdf with a pinned TeX Live.
#
# Usage:
#   ./pdf.sh <source-dir> <out.pdf>
#
# The engine comes from engine.js and the main file from mainfile.js.
# The same tarball gives the same bytes on the same runner: SOURCE_DATE_EPOCH
# is the newest file time in the source (the time it was packed), and qpdf
# finalizes with a content-derived ID. Not covered: documents that use
# TeX's random-number primitives, and a different qpdf version. Requires
# Docker and qpdf.

set -euo pipefail

if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <source-dir> <out.pdf>" >&2
    exit 64
fi

SOURCE_DIR=$(cd "$1" && pwd)
mkdir -p "$(dirname "$2")"
OUT_PDF="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# TeX Live 2025, frozen. Bumping it changes every rebuilt PDF; do it in a PR.
IMAGE="texlive/texlive:TL2025-historic@sha256:dbd65d778eb83de9b45fb0a8deb3afe44cbbaba2272e4e1e644e94dda52c7109"

command -v qpdf >/dev/null || { echo "pdf.sh needs qpdf" >&2; exit 1; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/latexml-lab-pdf.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
cp -a "$SOURCE_DIR/." "$WORK/"
if [ -n "$(find "$WORK" ! -type f ! -type d -print -quit)" ]; then
    echo "Source contains symlinks or special files; refusing to compile" >&2
    exit 1
fi

MAIN=$(node "$REPO_DIR/mainfile.js" "$WORK" || true)
if [ -z "$MAIN" ]; then
    echo "No .tex with \\documentclass found under $SOURCE_DIR" >&2
    exit 1
fi
ENGINE=$(node "$REPO_DIR/engine.js" "$WORK" "$MAIN")
EPOCH=$(node -e '
    const fs = require("fs"), path = require("path");
    let max = 0;
    (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const f = path.join(d, e.name);
            if (e.isDirectory()) walk(f);
            else max = Math.max(max, Math.floor(fs.statSync(f).mtimeMs / 1000));
        }
    })(process.argv[1]);
    process.stdout.write(String(max || 1));
' "$WORK")
echo "pdf: $MAIN with $ENGINE, SOURCE_DATE_EPOCH=$EPOCH"

case "$ENGINE" in
    xelatex) FLAG=-xelatex ;;
    lualatex) FLAG=-lualatex ;;
    *) FLAG=-pdf ;;
esac
DIR=$(dirname "$MAIN")
BASE=$(basename "$MAIN" .tex)

refuse_links() {
    if [ -n "$(find "$WORK" ! -type f ! -type d -print -quit)" ]; then
        echo "$1 contains symlinks or special files; refusing to continue" >&2
        exit 1
    fi
}

# Build from scratch: a PDF or latexmk state shipped in the source must
# not pass for a fresh compile. A shipped .bbl stays (arXiv sources often
# have no .bib).
for ext in pdf xdv dvi aux log fls fdb_latexmk synctex.gz; do
    rm -f "$WORK/$DIR/$BASE.$ext"
done

# The source is untrusted: no network, no rc files (a latexmkrc is Perl),
# and only TeX's restricted shell escape (its built-in allowlist, e.g.
# repstopdf for .eps figures), as on arXiv and Overleaf. TEXMFVAR is writable scratch for font caches under a
# non-root user. Host-side logs live outside the mounted tree.
LOGDIR=$(mktemp -d "${TMPDIR:-/tmp}/latexml-lab-log.XXXXXX")
trap 'rm -rf "$WORK" "$LOGDIR"' EXIT
STATUS=0
docker run --rm --network none \
    --user "$(id -u):$(id -g)" \
    -e SOURCE_DATE_EPOCH="$EPOCH" -e FORCE_SOURCE_DATE=1 \
    -e TEXMFVAR=/tmp/texmf-var -e HOME=/tmp \
    -v "$WORK:/work" -w "/work/$DIR" \
    "$IMAGE" \
    latexmk -norc "$FLAG" -latexoption=-shell-restricted -interaction=nonstopmode -halt-on-error -file-line-error "./$BASE.tex" \
    > "$LOGDIR/latexmk.out" 2>&1 || STATUS=$?
# The compile may have created links; check before reading anything back.
refuse_links "The compiled tree"
if [ "$STATUS" -ne 0 ] || [ ! -f "$WORK/$DIR/$BASE.pdf" ]; then
    echo "LaTeX compile failed ($ENGINE). End of the log:" >&2
    if [ -f "$WORK/$DIR/$BASE.log" ]; then
        tail -n 40 "$WORK/$DIR/$BASE.log" >&2
    else
        tail -n 40 "$LOGDIR/latexmk.out" >&2
    fi
    exit 1
fi

PDF="$WORK/$DIR/$BASE.pdf"

# A large PDF is usually oversampled figures (a 512 px image printed a
# few millimetres wide). Ghostscript resamples images above 450 ppi to
# 300 ppi and leaves text, fonts and links alone; its output is kept only
# when smaller. Dates, XMP and the ID are omitted so the bytes stay
# deterministic (qpdf adds a content-derived ID below).
GS_MIN_BYTES="${LATEXML_LAB_GS_MIN_BYTES:-8000000}"
if [ "$(wc -c < "$PDF" | tr -d ' ')" -gt "$GS_MIN_BYTES" ]; then
    docker run --rm --network none \
        --user "$(id -u):$(id -g)" \
        -v "$WORK:/work" -w "/work/$DIR" \
        "$IMAGE" \
        gs -q -dSAFER -dBATCH -dNOPAUSE -sDEVICE=pdfwrite -dCompatibilityLevel=1.7 \
            -dOmitInfoDate -dOmitID -dOmitXMP \
            -dDetectDuplicateImages=true -dPassThroughJPEGImages=true \
            -dDownsampleColorImages=true -dColorImageDownsampleType=/Bicubic \
            -dColorImageResolution=300 -dColorImageDownsampleThreshold=1.5 \
            -dDownsampleGrayImages=true -dGrayImageDownsampleType=/Bicubic \
            -dGrayImageResolution=300 -dGrayImageDownsampleThreshold=1.5 \
            -dDownsampleMonoImages=true -dMonoImageResolution=600 -dMonoImageDownsampleThreshold=1.5 \
            -sOutputFile="./$BASE.small.pdf" "./$BASE.pdf"
    refuse_links "The compressed tree"
    BEFORE=$(wc -c < "$PDF" | tr -d ' ')
    AFTER=$(wc -c < "$WORK/$DIR/$BASE.small.pdf" | tr -d ' ')
    if [ "$AFTER" -lt "$BEFORE" ]; then
        echo "pdf: images resampled to 300 ppi, $BEFORE -> $AFTER bytes"
        PDF="$WORK/$DIR/$BASE.small.pdf"
    fi
fi

qpdf --warning-exit-0 --object-streams=generate --compression-level=9 --recompress-flate \
    --deterministic-id "$PDF" "$OUT_PDF"
echo "pdf: wrote $OUT_PDF ($(wc -c < "$OUT_PDF" | tr -d ' ') bytes)"
