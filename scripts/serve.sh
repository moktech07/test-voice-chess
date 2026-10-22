#!/bin/bash
# Serve the production build on the LAN so a phone on the same Wi-Fi can reach it.
cd /home/swiphy/test/voice-chess || exit 1

echo "Building..."
npm run build > /dev/null 2>&1 || { echo "build failed"; exit 1; }

echo
echo "Serving dist/ on the LAN. Open the URL below on your phone:"
echo
npx vite preview --host --port 4173 --strictPort dist 2>&1
