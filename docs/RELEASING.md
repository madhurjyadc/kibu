# Releasing Kibu

Today Kibu is installed from source (`npm run app`, see the README). This
file is for later, when you want to publish signed builds for people who
will not build it themselves.

A public build has to be signed with an Apple Developer ID and notarized by
Apple. Without both, macOS refuses to open a downloaded copy, and every update
would make users grant Accessibility again. This file is the whole procedure.

## One-time setup

1. **Join the Apple Developer Program** (paid, per year) at
   <https://developer.apple.com/programs/>.
2. **Create a "Developer ID Application" certificate** in Xcode
   (Settings → Accounts → Manage Certificates → + → Developer ID Application)
   so it lands in your login keychain. Check it is there:

   ```bash
   security find-identity -v -p codesigning
   # 1) ABCDEF… "Developer ID Application: Your Name (TEAMID1234)"
   ```

3. **Make an app-specific password** for notarization at
   <https://account.apple.com> → Sign-In and Security → App-Specific Passwords.
4. **Make a GitHub token** with `contents: write` on the repository, for
   uploading release files.

Keep these in your shell for release runs only; never commit them:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="TEAMID1234"
export GH_TOKEN="github_pat_…"
```

## Each release

1. Bump `"version"` in `package.json` (updates only install when the version
   goes up).
2. Check everything still passes:

   ```bash
   npm test && npm run typecheck && npm run test:ui
   ```

3. Build, sign, notarize and upload a **draft** GitHub release:

   ```bash
   npm run release
   ```

   This compiles the Swift helper, builds the app, signs everything in the
   bundle (the helper included) with the hardened runtime, sends it to Apple
   for notarization, and uploads `Kibu-<version>-arm64.dmg`, the `.zip` and
   `latest-mac.yml` to a draft release.
4. **Try the draft before publishing it.** Download the `.dmg` from the draft
   on a Mac that has never run Kibu, open it, and check that:
   - it opens without a Gatekeeper warning;
   - the tour opens by itself, and ⌥Space opens the panel afterwards;
   - Accessibility is requested and, once granted, survives a relaunch;
   - a file task (organize a test folder) works and undoes;
   - a web task opens the separate browser (it uses the installed Chrome).
5. Publish the draft on GitHub. Installed copies pick the update up within six
   hours, and it applies the next time Kibu quits.

To build locally without publishing, use `npm run dist`; the result is in
`dist/`. To test packaging without a certificate:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --dir -c.mac.notarize=false
open dist/mac-arm64/Kibu.app
```

That copy is unsigned: fine on the Mac that built it, not something to share.

## What is in the bundle

- `electron-builder.yml` — the packaging configuration.
- `build/icon.icns` — the app icon, made from Kibu's idle sprite with
  `npm run app-icon`.
- `build/entitlements.mac.plist` — the hardened-runtime exceptions Electron
  needs, plus Apple Events for scripting Calendar, Reminders, Notes, Mail,
  Finder and browsers.
- `resources/bin/kibu-helper` — the Swift helper, built for Apple silicon only.
  Intel Macs are not supported; `LSMinimumSystemVersion` is 14.0.
