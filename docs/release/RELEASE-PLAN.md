# Release Plan — Versutus (VS-003)

Last updated: 2026-10-16 · App version 1.0.0 · Expo SDK 57 · branch in use for this work

This is the operator runbook for taking the current tree to **Play open testing** and a **GitHub release**. It is documentation only: it does not change app code, config, CI, secrets, or tests. Every action on a store or console (Play Console, EAS, GitHub Releases, APNs/FCM credential consoles) is owned by **Ethan** personally; engineering steps that touch only the repo may be prepared by any agent, but the release decision and publish click remain Ethan's.

## 0. Source of truth for "done"

- Repository root of this worktree only. Never build or tag from another checkout.
- `app.json` — version `1.0.0`, package `com.versutus.app`, bundle `com.versutus.app`, Expo owner `jonesinsrc`, EAS project `52545800-300a-4bbc-a2b9-7e412d9c217e` (`app.json:3,20,23,130,133`).
- `eas.json` — `production` builds an Android app bundle (`eas.json:20-24`).
- `docs/release/PRIVACY.md` — privacy policy text to host publicly.
- `docs/release/PLAY-DATA-SAFETY.md` — answers pasted into Play Console.

**Gate:** `npm run verify` must exit 0 before any build. If it is red, stop; do not upload a build. Also run `npm run smoke:portal` (README verification section).

## 1. Preconditions (engineering)

| Step | Owner | Exit criteria |
|---|---|---|
| 1.1 `npm run verify` green on the release commit | Engineering | `verify:config`, `tsc --noEmit`, lint, Jest + coverage ratchet, gate tests all pass |
| 1.2 `npm run smoke:portal` green | Engineering | portal seam passes |
| 1.3 `git status` clean; work on this branch only | Engineering | no uncommitted edits outside `docs/release/` |
| 1.4 Confirm `app.json` extra.gatewayHosts is `[]` | Engineering | `scripts/verify-config.mts` (host leak check) passes — `app.json:126-128` |
| 1.5 Pick the release tag, e.g. `v1.0.0`, matching `app.json` version `1.0.0` | Ethan | one tag, one version |

## 2. Privacy policy: host `docs/release/PRIVACY.md`

Play requires a publicly reachable privacy-policy URL. The policy text lives in `docs/release/PRIVACY.md`; this repository ships no hosting surface, so the policy must be published before submission.

| Step | Owner | Action |
|---|---|---|
| 2.1 Publish `docs/release/PRIVACY.md` to a stable HTTPS URL (GitHub Pages or the repository's raw view of the default branch). | Ethan (console/repo admin) | URL recorded here and pasted into Play Console in step 5.2 |
| 2.2 If the URL changes, update any in-app "privacy policy" link and the store listing. | Ethan | single source of truth remains `docs/release/PRIVACY.md` |

Candidate URL shape (fill in the real repo path once confirmed — repo remote is not available from this worktree, so mark `(? ) verify`):

`https://<hosted>/docs/release/PRIVACY.md` — `(?) verify` final host/path.

## 3. Store-side assets and metadata (Ethan)

All entries in this section are Play Console actions owned by Ethan.

| Step | Owner | Action / notes |
|---|---|---|
| 3.1 Store listing copy, screenshots (phone, 7″/10″ tablet if required), feature graphic, icon 512×512 | Ethan | Versutus is portrait, dark-only; screenshots from `npm run android`/`npm run ios` builds |
| 3.2 Content rating questionnaire | Ethan | App communicates with a user-controlled gateway; not a social/UGC app in the Play sense; mark "no user-generated content hosted by developer" |
| 3.3 Target audience and ads declaration | Ethan | not primarily child-directed; no in-app ads; `targetSdk`/permissions reviewed against current Play policy |
| 3.4 App signing / upload key | Ethan | EAS-managed signing preferred (`eas.json` appVersionSource `remote`); if a local key is used it must be backed up by Ethan outside this repo (never commit) |
| 3.5 Data Safety declaration (from `docs/release/PLAY-DATA-SAFETY.md`) | Ethan | paste the answers table; cite `PLAY-DATA-SAFETY.md` |
| 3.6 Privacy policy URL (from step 2) | Ethan | `(? ) verify` URL |

## 4. Build the release artifact

| Step | Owner | Command / action |
|---|---|---|
| 4.1 Sanity-check release config locally | Engineering | `npx expo config --type public` spot-check; `scripts/verify-config.mts` already covers hosts |
| 4.2 Build production AAB on EAS | Ethan (EAS account `jonesinsrc`) | `eas build --profile production --platform android` (`eas.json:20-24`, output `app-bundle`) |
| 4.3 Alternatively, direct prebuild (offline / no EAS quota) | Ethan / Engineering | `npx expo prebuild --platform android --clean` then `cd android && ./gradlew.bat assembleRelease --no-daemon` (README, "Android APK without EAS"); produces `android/app/build/outputs/apk/release/app-release.apk`. For Play you need the `.aab`, so prefer EAS or `bundleRelease` |
| 4.4 Download the artifact and record its SHA-256 (for the GitHub release) | Ethan | store the hash in the release notes |

## 5. Play open testing

| Step | Owner | Action |
|---|---|---|
| 5.1 Create the open-testing track release in Play Console and upload the AAB | Ethan | `Release` → `Open testing` → `Create new release` |
| 5.2 Paste privacy policy URL and complete Data Safety (steps 2, 3.5–3.6) | Ethan | blockers if missing |
| 5.3 Set tester access: open testing allows any Play Store user with the link | Ethan | copy the open-testing link; share with testers |
| 5.4 Internal / closed track smoke install on a real device before promoting | Ethan | install the release build on at least one Android device; exercise gateway add, chat, notifications, voice dictation, push-to-talk |
| 5.5 Submit for review | Ethan | wait for policy review; address any rejection by editing console entries only (no code change unless required) |
| 5.6 After approval, promote open-testing build to production when the soak period is clean | Ethan | separate go/no-go; not part of this plan's commit |

## 6. GitHub release (after the Play build is accepted)

| Step | Owner | Action |
|---|---|---|
| 6.1 Create and push the tag `v1.0.0` on the release commit | Ethan | `git tag v1.0.0 <commit> && git push origin v1.0.0` |
| 6.2 Draft release notes from shipped scope: client for AI agent gateways, voice (push-to-talk + hands-free call), true push via Gate relay, widgets, deep links. Pull from `README.md` and the ADR list | Ethan / Engineering | no secrets, no private gateway hosts |
| 6.3 Attach the Android artifact (`app-release.apk` or `.aab`) and its SHA-256 | Ethan | GitHub Releases UI or `gh release create v1.0.0 <asset> --title ... --notes-file ...` |
| 6.4 Optional: attach a web export built with `npm run export:web` (served via `npm run serve:web`) | Ethan / Engineering | web build is static output; document that the web client still requires a reachable gateway |
| 6.5 Mark the release as pre-release if any physical-device acceptance item in `FUTURE-ITEMS.md` is still open (widget placement, hands-free call three-turn soak) | Ethan | see `FUTURE-ITEMS.md` §4 and §Android widget/hands-free acceptance |

## 7. Verification evidence to save with the release (Ethan)

- `npm run verify` output + `npm run smoke:portal` output.
- EAS build number and artifact SHA-256.
- Play Console review decision + open-testing opt-in URL.
- GitHub release URL.

## 8. Rollback

- If a release build misbehaves: roll the open-testing track back to the previous AAB in Play Console (Ethan).
- If the privacy-policy or data-safety answers change, republish `docs/release/PRIVACY.md`/`PLAY-DATA-SAFETY.md` and update the Play entry; the in-repo docs remain the source of truth.
- Do not edit `app.json`, `eas.json`, CI, or secrets as part of a rollback; producing a fixed build means a new version (`1.0.1`) and a new tag.

## Appendix A — permissions that drive the data-safety and reviewer story

From `app.json:25-31, 82-89, 10-19`:

| Permission / plist | Why it exists |
|---|---|
| `RECORD_AUDIO` (Android), `NSMicrophoneUsageDescription` | push-to-talk dictation and hands-free call (`src/lib/voice/speech-recognition.ts`, `modules/handsfree-voice`) |
| `POST_NOTIFICATIONS` | local + relayed push notifications (`src/lib/notifications/local.ts`, `src/lib/notifications/push-registration.ts`) |
| `FOREGROUND_SERVICE*` | hands-free call foreground service (`modules/handsfree-voice/android/.../AndroidManifest.xml`) |
| `expo-image-picker` photo/camera/mic strings | image/file attachments (`src/components/chat/chat-screen.tsx:1374-1420`) |
| `NSSpeechRecognitionUsageDescription` | speech recognition |
| `NSFaceIDUsageDescription`, `UIBackgroundModes: audio` | app lock; hands-free call audio |
| `usesCleartextTraffic: true` (Android) | trusted-LAN gateway connections — see `audit-bugs-architecture.md` P0-1; recommended gateway transport is HTTPS/WSS |
| `versutus://add`, `versutus://chat` deep links | discovery and shortcut entry |

## Appendix B — outstanding device-held acceptance (may affect "pre-release" tagging)

- Android widget placement/update on a real device (`FUTURE-ITEMS.md` §Android home-screen widget).
- Hands-free call three-turn soak, foreground/background/screen-locked, on physical Android 13+ and iOS (`FUTURE-ITEMS.md` §Hands-free background voice chat).
- Device exercise of camera/photo/file attachments (`FUTURE-ITEMS.md` §P1 remaining).

These are acceptance gaps, not build blockers; Ethan decides whether to tag `v1.0.0` as pre-release.

---

*Companion docs: `docs/release/PRIVACY.md`, `docs/release/PLAY-DATA-SAFETY.md`.*