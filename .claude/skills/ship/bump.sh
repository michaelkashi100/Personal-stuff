#!/usr/bin/env bash
# Raises the build number (start screen + offline cache name) and prints the new number.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
cur=$(grep -o 'class="build">build [0-9]*' index.html | grep -o '[0-9]*$')
next=$((cur + 1))
sed -i "s/class=\"build\">build [0-9]*[^<]*</class=\"build\">build $next</" index.html
sed -i "s/timeline-v[0-9]*/timeline-v$next/" sw.js
grep -q "build $next<" index.html && grep -q "timeline-v$next'" sw.js
echo "$next"
