# Android production build — EAS App Bundle

Status: configuration in place; no build has been run from this document. This page
is the operator runbook for producing the Google Play artifact (VS-010). It changes
nothing at runtime: `eas.json` already carries the profile and submit entry it
describes, and `scripts/verify-config.mts` fails the build if either drifts.

Read [`RELEASE-PLAN.md`](RELEASE-PLAN.md) before starting. That document owns the
whole release (store listing, privacy policy, Play tracks, GitHub release); this one
covers only the Android build and its submission.

Every account action below is **Ethan's**: the EAS account, the upload keystore, the
Play service account and the Play Console. No credential value, keystore path or
service-account key value belongs in this repository or in `eas.json`.

## 1. What the repository already configures

| Thing | Value | Where |
|---|---|---|
| Production build type | Android App Bundle (`app-bundle`), the format Play accepts | `eas.json:20-24` |
| Submit target | Play track `internal` | `eas.json:26-33` |
| Submit release status | `draft` — an upload waits for a human in Play Console | `eas.json:26-33` |
| Version source | `remote` — EAS stores the Android `versionCode` | `eas.json:4` |
| Preview / development | unchanged, still `apk` for device testing | `eas.json:7-19` |
| App identity | `com.versutus.app`, version `1.0.0` | `app.json:25`, `app.json:4` |
| EAS project | project id and owner | `app.json:139`, `app.json:142` |
| Config guard | three checks below | `scripts/verify-config.mts:509-567` |

`eas.json` is a 34-line file containing no credentials, no keystore path and no
service-account path. Keep it that way.

The guard in `scripts/verify-config.mts:509-567` is what stops the profile quietly
becoming dangerous. It asserts:

- `eas-production-build-type` — `build.production.android.buildType` is `app-bundle`;
- `eas-submit-play-track` — `submit.production.android.track` is `internal`, so a
  routine submit can never target the production track;
- `eas-submit-release-status` — `submit.production.android.releaseStatus` is
  `draft`, so even an internal upload needs a deliberate promotion click.

Any edit to `eas.json` must keep those three statements true, or `npm run
verify:config` exits non-zero. `npm run verify` runs that check first
(`package.json:83`).

Only `preview` build scripts exist in `package.json:100-101`; there is no
`build:android:production` script. Run the EAS commands directly, as below —
that also keeps the production step deliberate rather than a one-liner.

## 2. What must exist before the first production build

All of it is outside this repository; none of it is created by the build command.

1. **EAS CLI, authenticated as the project owner.** `eas-cli` is not a dependency
   of this repo (`package.json:64-74`), so install it once and log in:

   ```bash
   npm install --global eas-cli
   eas login
   eas whoami          # must print the account that owns the EAS project
   ```

   The project id and owner are `app.json:139` and `app.json:142`; a different
   account cannot build it.

2. **An Android upload keystore, held by EAS.** Signing is EAS-managed remote
   credentials (`RELEASE-PLAN.md:53`, `READINESS-AUDIT-2026-10-31.md:54-57`). Set
   it up once:

   ```bash
   eas credentials --platform android
   # → production → Android Keystore → generate/upload
   ```

   The keystore file, its alias and its passwords stay with EAS and with Ethan.
   Never add them to `eas.json`, never commit them, never paste them into a doc.
   The generated native tree is not in the repo at all (`/android` is gitignored,
   `.gitignore:57`); a local `android/` build therefore signs with whatever the
   generated project has, not with the Play key (`READINESS-AUDIT-2026-10-31.md:54-57`,
   `:127-129`).

3. **The app exists in Play Console** under `com.versutus.app` (`app.json:25`),
   with an internal testing track available. Creating the app is a Play Console
   step; `eas submit` cannot invent it.

4. **A Google Play service account key, assigned to this app in EAS.** Only needed
   for `eas submit`; a manual upload in Play Console does not use it. Create the
   key in Google Cloud, grant it Play Developer API access, then assign it:

   ```bash
   eas credentials --platform android
   # → production → Google Service Account → set up key for Play Store submissions
   #   → path: <path-to-play-service-account-key.json>
   ```

   The same key can be uploaded from the EAS dashboard (Credentials → Android →
   Google service account key for EAS Submit). Either way the JSON file lives
   outside this repository and is never referenced by path inside `eas.json`. The
   `google-services.json` tracked in this repo (`app.json:26`) is the Firebase
   *client* config for push — it is not the Play service account key and must not
   be confused with it.

5. **A green repository, on the release commit.**

   ```bash
   npm run verify        # verify:config, tsc, lint, Jest + coverage, gate tests
   npm run smoke:portal
   git status            # clean; no edits outside docs/release/
   ```

   These are the release-plan preconditions (`RELEASE-PLAN.md:19`, `:25-27`). A red
   `verify` means stop; do not upload a build.

6. **Store-side items that block promotion, not the build.** The privacy-policy URL
   is not published, Data Safety answer A4 is open, and the store listing assets
   are not in the repo (`READINESS-AUDIT-2026-10-31.md:44-53`). The AAB can be
   built and uploaded as a draft without them; Play will not let it be promoted
   until they are done.

## 3. Commands an operator runs

In order, from the root of the release worktree only (`RELEASE-PLAN.md:13`).

```bash
# 3.1 The gate.
npm run verify
npm run verify:config          # the EAS-specific guard, also inside verify
npm run smoke:portal
```

```bash
# 3.2 Confirm which identity is building.
eas whoami
```

```bash
# 3.3 Build the Play artifact. This produces an .aab, not an APK.
eas build --platform android --profile production
```

Do not pass `--auto-submit`. Submission is a separate, deliberate step (3.6), and
`--auto-submit` would chain it invisibly.

When the build finishes, EAS prints the build page. To find and inspect it later:

```bash
eas build:list --platform android --limit 1
eas build:view <build-id>
```

```bash
# 3.4 Download the .aab from the build page (the artifact URL needs your EAS login).
#     Save it outside the repo, with the version and versionCode in the name, e.g.
#     versutus-1.0.0-<version-code>.aab
```

```bash
# 3.5 Record the hash that goes into the release evidence (RELEASE-PLAN.md:64, :119).
Get-FileHash .\versutus-1.0.0-<version-code>.aab -Algorithm SHA256
# macOS/Linux: sha256sum versutus-1.0.0-<version-code>.aab
```

```bash
# 3.6 Optional: upload through EAS. The submit.production profile pins the
#     internal track and a draft release, so this never publishes to users.
eas submit --platform android --profile production
```

This step needs the service account from 2.4 and the app from 2.3. If either is
missing, upload the `.aab` by hand instead: Play Console → your app → **Test and
release** → **Testing** → **Internal testing** → **Create new release** (the manual
path in `RELEASE-PLAN.md:70`). The result is the same draft release.

```bash
# 3.7 Confirm the upload, in Play Console: Internal testing shows a draft release
#     carrying the versionCode of the artifact built in 3.3. Complete the release
#     there, add testers, and run the pre-launch report before promoting.
```

Nothing after 3.7 is part of the build. Promotion to open testing or production is
a Play Console decision (`RELEASE-PLAN.md:73-75`), and the GitHub release is a
separate procedure (`RELEASE-PLAN.md` §6).

## 4. Version numbers

- The user-facing version is `app.json:4` (`1.0.0`). It changes only when Ethan
  decides a new user-visible release is being cut; the build command does not
  touch it.
- The developer-facing `versionCode` is **not** in `app.json` (its `android` block,
  `app.json:24-47`, has no `versionCode`). `eas.json:4` sets
  `cli.appVersionSource` to `remote`, so EAS stores and supplies the number.
- The `production` profile does **not** set `autoIncrement`, so EAS does not raise
  the `versionCode` for you between builds. Play refuses a `versionCode` it has
  already accepted for the app, so before a second upload either set the next
  remote value explicitly:

  ```bash
  eas build:version:set
  # → platform: Android → versionCode: <next number>
  ```

  or make a deliberate config decision to add `"autoIncrement": true` to
  `build.production` in `eas.json`. This document does not make that change.
  Reference: <https://docs.expo.dev/build-reference/app-versions/>.

## 5. What this build does not do

- It does not submit anything to Play. `eas submit` (3.6) or a manual Console
  upload does that; the EAS path lands on the internal track as a draft
  (`eas.json:26-33`), and the manual path is placed by hand.
- It does not promote a release. Open testing or production is a human action in
  Play Console.
- It does not create credentials. No keystore is generated, no service account is
  created or uploaded, and no credential value is written into the repo.
- It does not put a keystore path, keystore password, service-account path or
  invented store id into `eas.json`.
- It does not bump `versionName` (`app.json:4`) or the remote `versionCode`
  (§4).
- It does not produce a sideloadable APK. `app-bundle` is store-only; the `preview`
  and `development` profiles still build APKs (`eas.json:7-19`) and
  `README.md:164-172` covers the direct prebuild APK for local testing.
- It does not make the local Gradle path a release path. `./gradlew.bat assembleRelease`
  in a generated `android/` tree uses the debug signing config and must not be
  uploaded (`READINESS-AUDIT-2026-10-31.md:54-57`, `:127-129`).
- It does not run tests, device acceptance or the Play pre-launch report. Those are
  `npm run verify`, the physical-device list (`READINESS-AUDIT-2026-10-31.md:58-60`)
  and the Play Console pre-launch report (`:61-63`).
- It does not host the privacy policy, complete Data Safety, write release notes or
  tag a GitHub release (`READINESS-AUDIT-2026-10-31.md:44-49`;
  `RELEASE-PLAN.md` §2, §6).

## 6. Changing this configuration

- `npm run verify:config` must stay green. The three checks read the exact strings
  `app-bundle`, `internal` and `draft` (`scripts/verify-config.mts:537-566`); a
  "helpful" retarget of the submit profile to production fails the build.
- `preview` and `development` stay APK profiles (`eas.json:7-19`). Local device
  testing depends on them.
- Credentials belong in EAS credentials or the operator's environment, never in
  `eas.json` and never in this page.

## Sources

Files opened and confirmed for this page (line numbers as of 2026-11-02):

- `eas.json` — build profile, submit profile, version source.
- `app.json` — version, Android package, Firebase client config, EAS project id, owner.
- `package.json` — scripts, dependency list (no `eas-cli`), preview build scripts.
- `.gitignore` — `/android` is not tracked.
- `scripts/verify-config.mts` — the EAS production/submit guard.
- `README.md` — the local APK path and the short EAS production note.
- `docs/release/RELEASE-PLAN.md` — preconditions, build step, manual upload, promotion,
  evidence, GitHub release.
- `docs/release/READINESS-AUDIT-2026-10-31.md` — signing note, open store blockers,
  device acceptance, pre-launch report.
- <https://docs.expo.dev/build-reference/app-versions/> — remote version source and
  `autoIncrement` behaviour.
- <https://docs.expo.dev/submit/android/> — prerequisites, service account key,
  `eas submit` and the internal-track draft behaviour.
