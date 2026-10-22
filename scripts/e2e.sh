#!/bin/bash
# Browser end-to-end tests: real Chromium, real wasm engine, fake speech APIs.
cd /home/swiphy/test/voice-chess || exit 1

npx playwright test 2>&1 | tail -60
