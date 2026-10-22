#!/bin/bash
# Full verification: typecheck, unit tests, production build, dist inspection.
cd /home/swiphy/test/voice-chess || exit 1

echo "=================== TYPECHECK ==================="
npx tsc --noEmit 2>&1 | head -40
echo "tsc exit: ${PIPESTATUS[0]}"

echo "=================== UNIT TESTS ==================="
npx vitest run 2>&1 | tail -45

echo "=================== BUILD ==================="
npm run build 2>&1 | tail -20

echo "=================== DIST ==================="
ls -la dist/ 2>&1
echo "--- dist/engine ---"
ls -la dist/engine/ 2>&1
echo "--- index.html asset refs ---"
grep -oE '(src|href)="[^"]*"' dist/index.html 2>&1
echo "--- dist assets ---"
ls -la dist/assets/ 2>&1
