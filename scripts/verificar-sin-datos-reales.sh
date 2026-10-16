#!/usr/bin/env bash
# Falla si el repositorio contiene archivos que suelen traer datos de clientes (hojas exportadas, volcados, claves).
set -euo pipefail
mal=$(git ls-files | grep -Ei '\.(csv|xlsx?|ods|sql\.gz|dump|bak|pem|key|p12)$' | grep -v '^test/fixtures/' || true)
if [ -n "$mal" ]; then echo "Archivos que NO deben versionarse (posibles datos reales o secretos):"; echo "$mal"; exit 1; fi
if git ls-files | xargs grep -lEI '(DATA_KEY|OWNER_TOKEN|SESSION_SECRET)=[0-9A-Za-z+/_-]{16,}' 2>/dev/null | grep -v -e '^\.env\.example$' -e '^docs/' -e '^README.md$'; then echo "Parece haber un secreto escrito en el código."; exit 1; fi
echo "OK: sin archivos de datos ni secretos versionados."
