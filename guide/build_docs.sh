#!/bin/zsh
# Writes docs/: the Field Guide and the explainer as complete, standalone HTML pages (the sources in
# guide/ are body-first, as claude.ai artifacts take them), with their screenshots and the walkthrough
# video beside them. Open docs/index.html from a clone, or serve docs/ with GitHub Pages.
set -eu
cd "$(dirname "$0")/.."
rm -rf docs && mkdir -p docs/v2
wrap() {
  {
    printf '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n'
    printf '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    cat "$1"
  } > "$2"
}
wrap guide/kane-qe-guide.html docs/index.html
wrap guide/explainer.html docs/explainer.html
cp guide/kane-qe-v2-tour.mp4 docs/
cp guide/v2/*.png docs/v2/
touch docs/.nojekyll
echo "docs/: $(ls docs | tr '\n' ' ')"
