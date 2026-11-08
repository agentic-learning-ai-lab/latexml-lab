#!/usr/bin/env bash
#
# Convert a LaTeX source tree to the same HTML arXiv serves, using the
# converter arXiv itself runs (latexml/ar5ivist — latexmlc with arXiv's
# bindings and flags).
#
# Usage:
#   ./convert.sh <source-dir> <out-dir>
#
# <out-dir> receives paper-content.json, assets/, and latexml.log.
# Requires Docker; see README.md.

set -euo pipefail

if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <source-dir> <out-dir>" >&2
    exit 64
fi

SOURCE_DIR=$(cd "$1" && pwd)
mkdir -p "$2"
OUT_DIR=$(cd "$2" && pwd)
REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
IMAGE="latexml/ar5ivist:2512.17"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/latexml-lab.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/out"

# Convert a copy so the container never writes into the caller's tree.
cp -a "$SOURCE_DIR/." "$WORK/"
# Sources are untrusted: a symlink could make later steps read or write
# files outside the work directory, and a LaTeXML binding (.ltxml) is Perl
# that LaTeXML would run.
refuse_links() {
    if [ -n "$(find "$WORK" ! -type f ! -type d -print -quit)" ]; then
        echo "$1 contains symlinks or special files; refusing to continue:" >&2
        find "$WORK" ! -type f ! -type d | sed "s|^$WORK/|  |" >&2
        exit 1
    fi
}
refuse_links "Source"
if [ -n "$(find "$WORK" -name '*.ltxml' -print -quit)" ]; then
    echo "Source contains LaTeXML bindings (.ltxml); refusing to convert" >&2
    exit 1
fi

# Main file: main.tex when it declares a document, else the first .tex
# that does (latex_lib.findMainTexFile uses the same rule).
MAIN=""
if [ -f "$WORK/main.tex" ] && grep -a -q '\\documentclass' "$WORK/main.tex"; then
    MAIN="main.tex"
else
    while IFS= read -r f; do
        if grep -a -q '\\documentclass' "$f"; then
            MAIN="${f#"$WORK"/}"
            break
        fi
    done < <(find "$WORK" -name '*.tex' -type f | sort)
fi
if [ -z "$MAIN" ]; then
    echo "No .tex with \\documentclass found under $SOURCE_DIR" >&2
    exit 1
fi
echo "main source: $MAIN"

# Give subfigure panels their real widths (see subfig.js).
SUBFIG_TEX=()
while IFS= read -r -d '' f; do SUBFIG_TEX+=("$f"); done < <(find "$WORK" -name '*.tex' -type f -print0)
SUBFIG_COUNT=$(node "$REPO_DIR/subfig.js" "${SUBFIG_TEX[@]}")
echo "subfigures: resized $SUBFIG_COUNT panel widths"

MAIN_PATH="$WORK/$MAIN"
MAIN_DIR=$(dirname "$MAIN")
MAIN_BASE=$(basename "$MAIN")
JOBNAME="${MAIN_BASE%.tex}"
MAIN_DIR_ABS=$(cd "$(dirname "$MAIN_PATH")" && pwd)
BBL="$MAIN_DIR_ABS/$JOBNAME.bbl"
AUX="$MAIN_DIR_ABS/$JOBNAME.aux"

LOG="$WORK/latexml.log"

# LaTeXML builds the bibliography from a .bbl, but archives usually ship only
# the .bib (the site's pack step drops build outputs). Synthesize the .aux
# bibtex reads — \citation lines, \bibstyle, \bibdata — and run bibtex in the
# image. A TeX draft pass cannot work here: XeTeX-only classes abort under
# lualatex ("XeTeX is required") and the image has no xelatex.
HAS_BIB=0
HAS_BIBLATEX=0
BIBSTYLE=""
BIBDATA=""
: > "$WORK/cited"
while IFS= read -r -d '' texfile; do
    stripped=$(sed -E 's/(^|[^\\])%.*/\1/' "$texfile")
    # Join lines so a {...} argument may span newlines (newlines act as
    # whitespace inside \cite, \bibliography and \bibliographystyle).
    flat=$(printf '%s' "$stripped" | tr '\n' ' ')
    if printf '%s\n' "$flat" | grep -a -E '\\bibliography[[:space:]]*\{' >/dev/null; then
        HAS_BIB=1
    fi
    if printf '%s\n' "$flat" | grep -a -E '\\usepackage(\[[^]]*\])?\{[^}]*biblatex[^}]*\}|\\addbibresource' >/dev/null; then
        HAS_BIBLATEX=1
    fi
    if [ -z "$BIBSTYLE" ]; then
        BIBSTYLE=$(printf '%s\n' "$flat" \
            | grep -a -oE '\\bibliographystyle[[:space:]]*\{[^}]*\}' \
            | head -n 1 | sed -E 's/^[^{]*\{//; s/\}[[:space:]]*$//' || true)
    fi
    if [ -z "$BIBDATA" ]; then
        BIBDATA=$(printf '%s\n' "$flat" \
            | grep -a -oE '\\bibliography[[:space:]]*\{[^}]*\}' \
            | head -n 1 | sed -E 's/^[^{]*\{//; s/\}[[:space:]]*$//' || true)
    fi
    printf '%s\n' "$flat" \
        | grep -a -oE '\\([Cc]ite(yearpar|author|alp|alt|p|t)?|nocite)\*?(\[[^]]*\]){0,2}\{[^}]*\}' \
        | sed -E 's/^[^{]*\{//; s/\}[[:space:]]*$//' \
        | tr ',' '\n' >> "$WORK/cited" || true
done < <(find "$WORK" -name '*.tex' -type f -print0)
BIBSTYLE=${BIBSTYLE:-plain}

# The site shows author-year citations, which it reads from natbib's bibitem
# tags. A paper citing with plain \cite (no natbib, no cite package) gets a
# plainnat .bbl and natbib in numeric mode, so each entry carries its authors
# and year. The PDF keeps the paper's own style.
AUTHOR_YEAR=0
if ! grep -a -rE --include='*.tex' '^[^%]*\\usepackage(\[[^]]*\])?\{[^}]*\b(natbib|cite)\b' "$WORK" >/dev/null; then
    AUTHOR_YEAR=1
    BIBSTYLE=plainnat
fi

if [ -f "$BBL" ]; then
    echo "bibliography: found existing $JOBNAME.bbl"
elif [ "$HAS_BIB" -eq 0 ]; then
    printf '%s\n' "bibliography: skipped (no \\bibliography in source)"
elif [ "$HAS_BIBLATEX" -eq 1 ]; then
    echo "bibliography: skipped (biblatex/biber source)"
else
    {
        sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' "$WORK/cited" \
            | awk 'NF && !seen[$0]++ { print "\\citation{" $0 "}" }'
        printf '\\bibstyle{%s}\n\\bibdata{%s}\n' "$BIBSTYLE" "$BIBDATA"
    } > "$AUX"

    set +e
    docker run --rm --network none \
        --user "$(id -u):$(id -g)" \
        -v "$WORK:/work" -w "/work/$MAIN_DIR" \
        --entrypoint bibtex \
        "$IMAGE" \
        "$JOBNAME" \
        > "$WORK/bibtex.log" 2>&1
    BIBTEX_STATUS=$?
    set -e

    if [ -f "$BBL" ] && [ "$AUTHOR_YEAR" -eq 1 ]; then
        perl -0pi -e 's/(?=\\begin\s*\{document\})/\\usepackage[numbers]{natbib}\n/' "$MAIN_PATH"
        echo "bibliography: generated $JOBNAME.bbl (plainnat, for author-year citations)"
    elif [ -f "$BBL" ]; then
        echo "bibliography: generated $JOBNAME.bbl (synthesized .aux + bibtex)"
    else
        echo "bibliography: skipped (bibtex failed, exit $BIBTEX_STATUS)"
        tail -n 5 "$WORK/bibtex.log" >&2 || true
    fi
    # Do not let LaTeXML read our partial .aux.
    rm -f "$AUX"
fi

# TikZ: LaTeXML turns each tikzpicture into an SVG approximation, which
# mangles labels that TeX places precisely. When the source has any
# tikzpicture, compile a preview-mode copy of the paper (one tightly
# cropped PDF page per picture) with the real TeX engine, split it into
# tikz-N.pdf, and replace each environment with \includegraphics in the
# working copy. The figure re-render step below then rasterizes those
# PDFs sharply. Any failure leaves LaTeXML's SVG in place.
TIKZ_DIR="$WORK/.tikz"
TIKZ_PLAN="$TIKZ_DIR/plan.tsv"
# No leading dot: TeX's openout_any=p refuses to write dot-files.
TIKZ_PREVIEW="_latexml_tikz_preview"

HAS_TIKZ=0
while IFS= read -r -d '' texfile; do
    if grep -a -v '^[[:space:]]*%' "$texfile" | grep -a '\\begin{tikzpicture}' >/dev/null; then
        HAS_TIKZ=1
        break
    fi
done < <(find "$WORK" -name '*.tex' -type f -print0)

if [ "$HAS_TIKZ" -eq 0 ]; then
    printf '%s\n' "tikz: skipped (no \\begin{tikzpicture})"
else
    mkdir -p "$TIKZ_DIR"
    TIKZ_REASON=""
    TIKZ_K=0

    set +e
    TIKZ_K=$(node "$REPO_DIR/tikz.js" scan "$WORK" "$MAIN" "$TIKZ_PLAN")
    TIKZ_STATUS=$?
    set -e
    if [ "$TIKZ_STATUS" -ne 0 ] || ! printf '%s' "$TIKZ_K" | grep -qE '^[0-9]+$'; then
        TIKZ_REASON="could not scan tikzpictures"
        TIKZ_K=0
    elif [ "$TIKZ_K" -eq 0 ]; then
        TIKZ_REASON="no tikzpicture in document order"
    fi

    # The preview copy keeps the main file's folder so \input paths resolve.
    PREVIEW_TEX="$MAIN_DIR_ABS/$TIKZ_PREVIEW.tex"
    PREVIEW_PDF="$MAIN_DIR_ABS/$TIKZ_PREVIEW.pdf"
    if [ -z "$TIKZ_REASON" ]; then
        set +e
        node "$REPO_DIR/tikz.js" preview "$MAIN_PATH" "$PREVIEW_TEX"
        TIKZ_STATUS=$?
        set -e
        if [ "$TIKZ_STATUS" -ne 0 ]; then
            TIKZ_REASON="no \\begin{document} in main file"
        fi
    fi

    # pdflatex unless the paper needs the site's lualatex rule (same
    # detection as the bibliography step used to do).
    TIKZ_ENGINE=pdflatex
    if [ -z "$TIKZ_REASON" ]; then
        TIKZ_MAIN_TEXT=$(sed -E 's/(^|[^\\])%.*/\1/' "$MAIN_PATH")
        if grep -a -qiE '^[[:space:]]*%[[:space:]]*!TEX[[:space:]]+(TS-)?program[[:space:]]*=[[:space:]]*(xelatex|lualatex)' "$MAIN_PATH" \
            || printf '%s\n' "$TIKZ_MAIN_TEXT" \
                | grep -a -iE '\\(usepackage|RequirePackage)(\[[^]]*\])?\{[^}]*(fontspec|unicode-math|xeCJK|polyglossia|mathspec)[^}]*\}' >/dev/null \
            || printf '%s\n' "$TIKZ_MAIN_TEXT" \
                | grep -a -iE '\\(usepackage|RequirePackage)(\[[^]]*\])?\{[^}]*(xelatex|lualatex)[^}]*\}' >/dev/null; then
            TIKZ_ENGINE=lualatex
        fi
    fi

    if [ -z "$TIKZ_REASON" ]; then
        set +e
        docker run --rm --network none \
            --user "$(id -u):$(id -g)" \
            -e HOME=/tmp \
            -v "$WORK:/work" -w "/work/$MAIN_DIR" \
            --entrypoint "$TIKZ_ENGINE" \
            "$IMAGE" \
            -interaction=nonstopmode "$TIKZ_PREVIEW.tex" \
            > "$TIKZ_DIR/tex.log" 2>&1
        TIKZ_STATUS=$?
        set -e
        # TeX errors elsewhere in the paper are fine as long as the PDF
        # came out; the page count below checks it has every picture.
        if [ ! -f "$PREVIEW_PDF" ]; then
            TIKZ_REASON="$TIKZ_ENGINE produced no PDF (exit $TIKZ_STATUS)"
        fi
    fi

    if [ -z "$TIKZ_REASON" ]; then
        set +e
        TIKZ_PAGES=$(docker run --rm --network none \
            --user "$(id -u):$(id -g)" \
            -v "$WORK:/work" -w "/work/$MAIN_DIR" \
            --entrypoint gs \
            "$IMAGE" \
            -q -dNODISPLAY --permit-file-read=/work/ \
            -c "($TIKZ_PREVIEW.pdf) (r) file runpdfbegin pdfpagecount = quit" \
            2>/dev/null)
        TIKZ_STATUS=$?
        set -e
        TIKZ_PAGES=$(printf '%s' "$TIKZ_PAGES" | tr -d '[:space:]')
        if [ "$TIKZ_STATUS" -ne 0 ] || ! printf '%s' "$TIKZ_PAGES" | grep -qE '^[0-9]+$'; then
            TIKZ_REASON="could not count preview pages"
        elif [ "$TIKZ_PAGES" -ne "$TIKZ_K" ]; then
            TIKZ_REASON="$TIKZ_PAGES preview pages for $TIKZ_K tikzpictures"
        fi
    fi

    # Never overwrite a source file that already uses one of our names.
    if [ -z "$TIKZ_REASON" ]; then
        for n in $(seq 1 "$TIKZ_K"); do
            if [ -e "$MAIN_DIR_ABS/tikz-$n.pdf" ]; then
                TIKZ_REASON="tikz-$n.pdf already exists in the source"
                break
            fi
        done
    fi

    if [ -z "$TIKZ_REASON" ]; then
        set +e
        docker run --rm --network none \
            --user "$(id -u):$(id -g)" \
            -v "$WORK:/work" -w "/work/$MAIN_DIR" \
            --entrypoint gs \
            "$IMAGE" \
            -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite \
            -dFirstPage=1 -dLastPage="$TIKZ_K" \
            -sOutputFile="/work/$MAIN_DIR/tikz-%d.pdf" \
            "/work/$MAIN_DIR/$TIKZ_PREVIEW.pdf" \
            > "$TIKZ_DIR/split.log" 2>&1
        TIKZ_STATUS=$?
        set -e
        if [ "$TIKZ_STATUS" -ne 0 ]; then
            TIKZ_REASON="gs split failed (exit $TIKZ_STATUS)"
        else
            for n in $(seq 1 "$TIKZ_K"); do
                if [ ! -f "$MAIN_DIR_ABS/tikz-$n.pdf" ]; then
                    TIKZ_REASON="missing tikz-$n.pdf after split"
                    break
                fi
            done
        fi
    fi

    if [ -z "$TIKZ_REASON" ]; then
        set +e
        node "$REPO_DIR/tikz.js" replace "$WORK" "$TIKZ_PLAN"
        TIKZ_STATUS=$?
        set -e
        if [ "$TIKZ_STATUS" -ne 0 ]; then
            TIKZ_REASON="could not splice \\includegraphics"
        fi
    fi

    rm -f "$PREVIEW_TEX" "$PREVIEW_PDF" \
        "$MAIN_DIR_ABS/$TIKZ_PREVIEW.aux" "$MAIN_DIR_ABS/$TIKZ_PREVIEW.log" \
        "$MAIN_DIR_ABS/$TIKZ_PREVIEW.out" "$MAIN_DIR_ABS/$TIKZ_PREVIEW.toc" \
        2>/dev/null || true

    if [ -n "$TIKZ_REASON" ]; then
        echo "tikz: skipped ($TIKZ_REASON)"
    else
        echo "tikz: pre-rendered $TIKZ_K"
    fi
fi

# LaTeXML drops the options of a package that another package already
# loaded: adjustbox and tikz load xcolor through pgf, so a later
# \usepackage[table,dvipsnames]{xcolor} loses \rowcolor and the dvips
# colour names. Pass the paper's xcolor options up front, as LaTeX's own
# fix for an option clash does.
XCOLOR_OPTS=$(find "$WORK" -name '*.tex' -type f -exec cat {} + \
    | sed -E 's/(^|[^\\])%.*/\1/' \
    | grep -a -oE '\\usepackage\[[^]]*\]\{xcolor\}' \
    | sed -E 's/^[^[]*\[//; s/\].*$//' | tr '\n' ',' | sed 's/,$//' || true)
if [ -n "$XCOLOR_OPTS" ]; then
    OPTS=$XCOLOR_OPTS perl -0pi -e 's/^/\\PassOptionsToPackage{$ENV{OPTS}}{xcolor}\n/' "$MAIN_PATH"
    echo "xcolor: passing options $XCOLOR_OPTS"
fi

# --path=/work/bindings lets bindings/ in this repo override arXiv's
# stock bindings. --destination lands the document (and any generated
# figure files) in $WORK/out/main.html.
set +e
# Run from the main file's folder: TeX resolves \input paths against the
# working directory, and archives often wrap the sources in one folder.
docker run --rm --network none \
    --user "$(id -u):$(id -g)" \
    -v "$WORK:/work" -w "/work/$MAIN_DIR" \
    -v "$REPO_DIR/bindings:/work/bindings:ro" \
    "$IMAGE" \
    --path=/work/bindings \
    --source="$(basename "$MAIN")" \
    --destination=/work/out/main.html \
    --debug=images \
    2>&1 | tee "$LOG"
STATUS=${PIPESTATUS[0]}
set -e
refuse_links "LaTeXML's output"

# latexmlc also writes its log beside the destination; keep both.
if [ -f "$WORK/out/main.log" ]; then
    cat "$WORK/out/main.log" >> "$LOG"
fi

# LaTeXML can exit 0 while still reporting a fatal error (missing
# packages, unresolvable input); treat either as failure.
if [ "$STATUS" -ne 0 ] || grep -a -qE '(^|[[:space:]])Fatal:' "$LOG"; then
    echo "" >&2
    echo "LaTeXML conversion failed (docker exit $STATUS):" >&2
    tail -n 80 "$LOG" >&2 || true
    cp "$LOG" "$OUT_DIR/latexml.log" || true
    exit 1
fi

# Figures: LaTeXML writes each source at roughly 2x its display size and
# then scales it down, so its files look soft on HiDPI screens.
# --debug=images logs every source → output mapping; replace those outputs
# with a sharper render at the same aspect ratio. The HTML, whose
# width/height attributes are the display size, is left untouched.
FIG_DIR="$WORK/.figures"
PLAN="$FIG_DIR/plan.tsv"
mkdir -p "$FIG_DIR"

# Pair each "Processing <source> as key=...|<transforms>" with the
# "[Destination /work/out/<dest>]" line that follows it. The log may
# contain the same entry twice (stdout and out/main.log); dedupe.
awk -v prefix="$MAIN_DIR/" '
    /^Processing / {
        line = $0
        sub(/^Processing /, "", line)
        if (!match(line, / as key=/)) next
        src = substr(line, 1, RSTART - 1)
        # Source paths are relative to the directory LaTeXML ran in
        # (-w /work/$MAIN_DIR); store them relative to /work like the
        # destination paths the log reports.
        if (src ~ /^\/work\//) src = substr(src, 7)
        else if (src !~ /^\//) src = prefix src
        rest = substr(line, RSTART + RLENGTH)
        # "-" marks "no transforms": an empty field would vanish when the
        # plan is read back with a tab IFS.
        xf = "-"
        p = index(rest, "|")
        if (p) { xf = substr(rest, p + 1); gsub(/\|/, " ", xf) }
        pending_src = src
        pending_xf = xf
        have = 1
        next
    }
    /^[ \t]*\[Destination / {
        if (!have) next
        dest = $0
        sub(/^[ \t]*\[Destination /, "", dest)
        sub(/\][ \t]*$/, "", dest)
        line = pending_src "\t" pending_xf "\t" dest
        if (!seen[line]++) print line
        have = 0
    }
' "$LOG" > "$PLAN"

TOTAL=$(wc -l < "$PLAN" | tr -d '[:space:]')
RENDERED=0

if [ "$TOTAL" -gt 0 ]; then
    cat > "$FIG_DIR/render.sh" <<'RENDER'
#!/bin/sh
# Re-render the figures named by a plan of
#   <source> <TAB> <transforms> <TAB> <destination>
# (all paths relative to /work or absolute under /work).
set -u
set -f

plan=$1
rendered=0
skipped=0
tmp=/work/.figures/.render-$$.png
trap 'rm -f "$tmp"' EXIT HUP INT TERM

# Crop a page rendered at <dpi> by "<left> <bottom> <right> <top>" bp,
# as graphicx's trim does. An empty trim leaves the file alone.
trim_png() {
    [ -n "$3" ] || return 0
    geom=$(identify -format '%w %h' "$1" 2>/dev/null) || return 1
    # shellcheck disable=SC2086
    set -- "$1" "$2" $3 $geom
    crop=$(awk -v d="$2" -v l="$3" -v b="$4" -v r="$5" -v t="$6" \
        -v W="$7" -v H="$8" 'BEGIN {
            k = d / 72; L = int(l * k + 0.5); T = int(t * k + 0.5)
            w = W - L - int(r * k + 0.5); h = H - T - int(b * k + 0.5)
            if (w < 1 || h < 1) exit 1
            printf "%dx%d+%d+%d", w, h, L, T }') || return 1
    convert "$1" -crop "$crop" +repage "$1" >/dev/null 2>&1
}

while IFS='	' read -r src xf dest; do
    [ -n "${src:-}" ] || continue

    # Only no transform, scale/scale-to and trim (four bp values: left
    # bottom right top). Anything else (rotate, page selection, ...)
    # keeps LaTeXML's file.
    plain=1
    trim=
    want=0
    for tok in $xf; do
        if [ "$want" -gt 0 ]; then
            case $tok in
                *[!0-9eE.+-]*) plain=0; break ;;
            esac
            trim="$trim $tok"
            want=$((want - 1))
            continue
        fi
        case $tok in
            -|scale|scale-to) ;;
            trim) [ -z "$trim" ] || { plain=0; break; }; want=4 ;;
            *[!0-9eE.+-]*) plain=0; break ;;
        esac
    done
    [ "$want" -eq 0 ] || plain=0
    if [ "$plain" -ne 1 ]; then
        skipped=$((skipped + 1))
        continue
    fi

    srcpath=/work/$src
    destpath=$dest
    case "$destpath" in
        /work/out/*) ;;
        *) skipped=$((skipped + 1)); continue ;;
    esac
    if [ ! -f "$srcpath" ] || [ ! -f "$destpath" ]; then
        skipped=$((skipped + 1))
        continue
    fi

    srcext=${src##*.}
    srcext=$(printf '%s' "$srcext" | tr 'A-Z' 'a-z')
    destext=${dest##*.}
    destext=$(printf '%s' "$destext" | tr 'A-Z' 'a-z')

    case "$srcext" in
        pdf|eps|ps)
            # Bounding box in PostScript points, for choosing the DPI.
            bbox=$(gs -q -dBATCH -dNOPAUSE \
                -dFirstPage=1 -dLastPage=1 -sDEVICE=bbox "$srcpath" 2>&1 \
                | grep 'BoundingBox:' | tail -n 1)
            bbox=${bbox#*BoundingBox:}
            # shellcheck disable=SC2086
            set -- $bbox
            if [ "$#" -lt 4 ]; then
                skipped=$((skipped + 1))
                continue
            fi
            width_pt=$(awk -v x0="$1" -v x1="$3" \
                'BEGIN { printf "%.6f", x1 - x0 }')
            dest_w=$(identify -format '%w' "$destpath" 2>/dev/null) || dest_w=
            if [ -z "$dest_w" ] || [ "$dest_w" -lt 1 ]; then
                skipped=$((skipped + 1))
                continue
            fi
            target=$dest_w
            [ "$target" -lt 1400 ] && target=1400
            dpi=$(awk -v w="$width_pt" -v t="$target" '
                BEGIN {
                    if (w < 1) exit 1
                    d = t * 72 / w
                    if (d == int(d)) printf "%d", d
                    else printf "%d", int(d) + 1
                }') || dpi=
            if [ -z "$dpi" ]; then
                skipped=$((skipped + 1))
                continue
            fi
            crop=
            [ "$srcext" = eps ] && crop=-dEPSCrop
            if gs -q -dNOPAUSE -dBATCH -dFirstPage=1 -dLastPage=1 \
                    -sDEVICE=pngalpha -dTextAlphaBits=4 -dGraphicsAlphaBits=4 \
                    $crop -r"$dpi" -sOutputFile="$tmp" "$srcpath" \
                    >/dev/null 2>&1 \
                && [ -s "$tmp" ] \
                && trim_png "$tmp" "$dpi" "$trim" \
                && convert "$tmp" -resize "${target}x" "$destpath" \
                    >/dev/null 2>&1; then
                rendered=$((rendered + 1))
            else
                skipped=$((skipped + 1))
            fi
            rm -f "$tmp"
            ;;
        png|jpg|jpeg)
            # Reuse the original raster when it has more pixels than
            # LaTeXML kept, capped at 1400 px wide. A trimmed raster keeps
            # LaTeXML's crop.
            if [ -n "$trim" ]; then
                skipped=$((skipped + 1))
                continue
            fi
            src_w=$(identify -format '%w' "$srcpath" 2>/dev/null) || src_w=
            dest_w=$(identify -format '%w' "$destpath" 2>/dev/null) || dest_w=
            if [ -z "$src_w" ] || [ -z "$dest_w" ] \
                || [ "$src_w" -le "$dest_w" ]; then
                skipped=$((skipped + 1))
                continue
            fi
            new_w=$src_w
            [ "$new_w" -gt 1400 ] && new_w=1400
            if [ "$new_w" -ge "$src_w" ] && [ "$srcext" = "$destext" ]; then
                cp -f "$srcpath" "$destpath"
                rendered=$((rendered + 1))
            elif convert "$srcpath" -resize "${new_w}x" "$destpath" \
                    >/dev/null 2>&1; then
                rendered=$((rendered + 1))
            else
                skipped=$((skipped + 1))
            fi
            ;;
        *)
            skipped=$((skipped + 1))
            ;;
    esac
done < "$plan"

echo "RENDERED=$rendered"
echo "SKIPPED=$skipped"
RENDER

    set +e
    docker run --rm --network none \
        --user "$(id -u):$(id -g)" \
        -v "$WORK:/work" -w "/work/$MAIN_DIR" \
        --entrypoint /bin/sh \
        "$IMAGE" \
        /work/.figures/render.sh /work/.figures/plan.tsv \
        > "$FIG_DIR/render.log" 2>&1
    FIG_STATUS=$?
    set -e

    RENDERED=$(sed -n 's/^RENDERED=//p' "$FIG_DIR/render.log" | tail -n 1)
    case "$RENDERED" in ''|*[!0-9]*) RENDERED=0 ;; esac
    [ "$RENDERED" -gt "$TOTAL" ] && RENDERED=$TOTAL

    if [ "$FIG_STATUS" -ne 0 ]; then
        echo "figures: render step failed (docker exit $FIG_STATUS); kept LaTeXML images" >&2
        tail -n 10 "$FIG_DIR/render.log" >&2 || true
    fi
fi

echo "figures: re-rendered $RENDERED, skipped $((TOTAL - RENDERED))"

node "$REPO_DIR/extract.js" "$WORK/out" "$OUT_DIR"
cp "$LOG" "$OUT_DIR/latexml.log"

echo "✓ wrote $OUT_DIR/paper-content.json + assets/ + latexml.log"
