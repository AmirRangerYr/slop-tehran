#!/bin/sh
cd "$(dirname "$0")"
echo "Slop Tehran: http://localhost:8000/  (Ctrl+C to stop)"
(xdg-open http://localhost:8000/ || open http://localhost:8000/) >/dev/null 2>&1 &
python3 -m http.server 8000
