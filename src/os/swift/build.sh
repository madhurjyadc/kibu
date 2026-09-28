#!/usr/bin/env bash
# Builds the macOS helper into resources/bin/kibu-helper.
set -euo pipefail
cd "$(dirname "$0")/../../.."
mkdir -p resources/bin
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
cat src/os/swift/Documents.swift src/os/swift/KibuHelper.swift > "$build_dir/main.swift"
swiftc -O -swift-version 5 -module-cache-path "$build_dir/module-cache" \
  -target arm64-apple-macosx14.0 \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics \
  -framework ScreenCaptureKit -framework UniformTypeIdentifiers -framework ImageIO -framework PDFKit -framework Vision \
  -o resources/bin/kibu-helper \
  "$build_dir/main.swift"
echo "built resources/bin/kibu-helper"
