#!/usr/bin/env bash
# Builds the macOS helper into resources/bin/kibu-helper.
set -euo pipefail
cd "$(dirname "$0")/../../.."
mkdir -p resources/bin
swiftc -O -swift-version 5 \
  -target arm64-apple-macosx14.0 \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics \
  -framework ScreenCaptureKit -framework UniformTypeIdentifiers -framework ImageIO \
  -o resources/bin/kibu-helper \
  src/os/swift/KibuHelper.swift
echo "built resources/bin/kibu-helper"
