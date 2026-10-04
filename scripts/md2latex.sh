#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  md2latex.sh [options] FILE.md [FILE.md ...]

Options:
  -o, --output FILE     Output .tex/.pdf path; valid with one input file
  -d, --out-dir DIR     Output directory; default is each input's directory
      --pdf             Also compile a PDF with XeLaTeX
      --no-toc          Do not generate a table of contents
  -h, --help            Show this help

Examples:
  md2latex.sh notes.md
  md2latex.sh --pdf --out-dir build docs/*.md
  md2latex.sh -o build/tutorial.tex tutorial.md
EOF
}

pdf=0
toc=1
output=""
out_dir=""
inputs=()

while (($#)); do
  case "$1" in
    --pdf) pdf=1; shift ;;
    --no-toc) toc=0; shift ;;
    -o|--output)
      (($# >= 2)) || { echo "error: --output requires a path" >&2; exit 2; }
      output="$2"; shift 2 ;;
    -d|--out-dir)
      (($# >= 2)) || { echo "error: --out-dir requires a directory" >&2; exit 2; }
      out_dir="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --) shift; inputs+=("$@"); break ;;
    -*) echo "error: unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) inputs+=("$1"); shift ;;
  esac
done

((${#inputs[@]})) || { usage >&2; exit 2; }
command -v pandoc >/dev/null 2>&1 || {
  echo "error: pandoc is required" >&2
  exit 127
}
filter="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/md2latex-images.lua"
[[ -f "$filter" ]] || {
  echo "error: missing Pandoc filter: $filter" >&2
  exit 1
}
if ((pdf)); then
  command -v xelatex >/dev/null 2>&1 || {
    echo "error: xelatex is required for --pdf" >&2
    exit 127
  }
fi
if [[ -n "$output" && ${#inputs[@]} -ne 1 ]]; then
  echo "error: --output is valid with exactly one input file" >&2
  exit 2
fi

for input in "${inputs[@]}"; do
  [[ -f "$input" ]] || { echo "error: file not found: $input" >&2; exit 1; }
  case "$input" in *.md|*.markdown) ;; *) echo "error: not a Markdown file: $input" >&2; exit 1 ;; esac

  base="${input##*/}"
  base="${base%.*}"
  if [[ -n "$output" ]]; then
    tex="$output"
  elif [[ -n "$out_dir" ]]; then
    tex="$out_dir/$base.tex"
  else
    tex="${input%.*}.tex"
  fi
  mkdir -p "$(dirname "$tex")"

  args=("$input" --from=markdown+tex_math_dollars+tex_math_single_backslash+raw_tex --standalone --pdf-engine=xelatex --lua-filter="$filter")
  ((toc)) && args+=(--toc)
  pandoc "${args[@]}" --to=latex --output="$tex"
  echo "created $tex"

  if ((pdf)); then
    pdf_path="${tex%.tex}.pdf"
    pandoc "${args[@]}" --to=pdf --output="$pdf_path"
    echo "created $pdf_path"
  fi
done
