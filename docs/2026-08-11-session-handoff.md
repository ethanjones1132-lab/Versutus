# Session Handoff — Versutus Gate build-out, deploy & connection recovery

Date: 2026-08-11
Branch: `master` (clean tree, **58 commits unpushed** — `origin/master` is still at `15d0f59`)

---

## 1. Where things stand right now

**Working, verified end to end:** the Android app on the phone sends a message through
`https://ethanspc.tail3a1a8a.ts.net` using the `API_SERVER_KEY` from
`%LOCALAPPDATA%\hermes\.env`, and Hermes answers. This was confirmed live, not inferred.

**Verification state on `master` (all re-run after the dependency upgrade):**

| Check | Result |
|---|---|
| App tests (Jest) | 69 passed / 13 suites |
| Gate tests (`node --test`) | 71 passed |
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |
| `npm run smoke:portal` | ALL PASS |
| `npm run smoke:live` (real Hermes) | All live checks passed |
| Secrets tracked in git | none |

**Deployed artifact:** `android/app/build/outputs/apk/release/app-release.apk`
(114 MB, `com.versutus.app` v1.0.0, targetSdk 36). Installed and running on the phone.

---

## 2. What was built (three plans, all merged to `master`)

### Plan 1 — Versutus Gate foundation (12 tasks)
`docs/superpowers/plans/2026-08-10-versutus-gate-foundation.md`

Extracted `HttpTransport` and `ConnectionMonitor` out of `HermesGatewayClient` so both it
and the new `ManifestClient` share one copy of the reconnect policy (two-strike health
threshold, jittered backoff, header sanitization). Then built the Gate itself: provider
config validation, provider loader with failure isolation, manifest builder, bearer token
store, OpenAI-compatible flavor, HTTP server, scaffold CLI.

### Plan 2a — chat proxy, Anthropic flavor, pairing (11 tasks)
`docs/superpowers/plans/2026-08-10-versutus-gate-chat-and-pairing.md`

The Gate could advertise providers but had **no chat route at all** — the OpenAI flavor was
written and tested but never wired to an endpoint. This plan added the chat proxy with
normalized SSE streaming, the Anthropic Messages API flavor (proving the flavor abstraction
holds for a non-OpenAI dialect), and the signed Ed25519 pairing flow from spec §8.

Also fixed two defects found by reading the *delivered* Plan 1 code rather than the plan text:
the token store was writing to the OS temp directory instead of the Gate root, and the
provider scaffold/prompt never mentioned `capabilities` despite the manifest builder reading it.

### Plan 2b — ManifestClient, provider child sync, live parity (11 tasks)
`docs/superpowers/plans/2026-08-11-versutus-gate-manifest-client.md`
Written this session, implemented by Grok on `feat/manifest-client-provider-sync`, reviewed and merged.

`createClientForKind('custom', …)` previously fell through to `HermesGatewayClient` as a
stopgap. It now returns a real `ManifestClient` that resolves every route from the gateway's
advertised `endpoints` and fails with a named error for anything the manifest doesn't declare.
Provider child profiles now materialize one app-side gateway per advertised provider.

---

## 3. Known issues and landmines

### 3.1 Hermes goes silently deaf — `WinError 64` (unfixed, will recur)
**This is the one most likely to bite you again.**

At 12:19:57 today the API server's listening socket died:

```
OSError: [WinError 64] The specified network name is no longer available
socket: <asyncio.TransportSocket fd=1416, laddr=('0.0.0.0', 8642)>
Accept failed on a socket
```

A Windows network-interface event killed aiohttp's accept loop. **The process stayed alive
and `hermes gateway status` still reported "running"** — but nothing was listening on 8642.
Everything downstream then failed in confusing ways: Tailscale Serve returned `502`, the
tailnet IP refused connections, and the app reported DNS/reachability errors that had nothing
to do with the real cause.

- **Symptom to recognize:** `netstat -ano | grep ":8642"` returns nothing while
  `hermes gateway status` claims the gateway is running.
- **Fix:** `hermes gateway restart` (took ~5s, restored all three access paths).
- **Root cause is in Hermes, not the Versutus app.** No client-side reconnect logic can
  recover from a server whose listener is gone. Worth a watchdog or an aiohttp accept-loop
  retry upstream.

### 3.2 Diagnostic lesson: check the server before believing the client
Considerable time was lost treating this as a phone/DNS/driver problem because the app's
error text pointed outward (`UnknownHostException`, `HTTP 502`). The decisive evidence came
from three commands on the PC:

```bash
netstat -ano | grep ":8642"                                   # nothing listening
curl -s -o /dev/null -w "%{http_code}" https://ethanspc.tail3a1a8a.ts.net/health   # 502
tail -40 "$LOCALAPPDATA/hermes/logs/gateway.log"              # the real story
```

`gateway.log` also showed the app's API key being rejected for ~8 minutes straight
(`API server rejected invalid API key … user_agent='okhttp/4.9.2'`) — a second, independent
problem that was invisible from the phone. **Check `gateway.log` and `errors.log` first next time.**

### 3.3 EAS cloud build quota exhausted
Free-tier Android builds are used up for the month; resets **2026-09-01**.
`npm run build:android:preview` will fail until then or until the plan is upgraded.

### 3.4 `eas build --local` does not work on Windows
Errors with "Unsupported platform, macOS or Linux is required to build apps for Android".
The `build:android:preview:local` script in `package.json` is therefore **dead on this machine**.
Use the direct path instead (see §4).

### 3.5 ADB never worked — phone only ever enumerates as MTP
Despite installing Samsung's official signed USB driver (v1.9.5.0) and toggling USB debugging,
Windows only ever exposed the phone as `MS_COMP_MTP`; no ADB interface appeared and
`adb devices` stayed empty throughout. **No logcat access.** APK delivery went via Google Drive
instead. If you need device logs later, this is still unsolved.

### 3.6 APK signature mismatch on install
Local Gradle builds sign with the project's **debug keystore**; prior EAS cloud builds signed
with **Expo's managed key**. Android refuses to update across differing signatures and reports
only the useless "App not installed". **You must uninstall the existing app before installing a
locally-built APK.** Mixing the two build paths will keep hitting this.

### 3.7 Disk space
The build failed once at 5.2 GB free. `npm cache clean --force` recovered ~10 GB
(the cache alone was 9.97 GB). Currently ~17 GB free. Native Android builds need real headroom.

---

## 4. How to rebuild the APK on this machine

The EAS paths are both unavailable (§3.3, §3.4). Build directly:

```bash
export ANDROID_HOME="/c/Users/ethan/AppData/Local/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="C:\Program Files\Java\jdk-21.0.10"
cd /c/Projects/Versutus
npx expo prebuild --platform android --clean
cd android && ./gradlew.bat assembleRelease --no-daemon
```

Output lands at `android/app/build/outputs/apk/release/app-release.apk` (~8 min).
`android/` is gitignored and regenerated by prebuild — never edit it by hand.

**Environment installed this session** (not in git, machine-local):
- Android SDK at `C:\Users\ethan\AppData\Local\Android\Sdk` — cmdline-tools, platform-tools,
  build-tools 35 + 36, platforms 35 + 36, NDK 27.1.12297006. Licenses accepted.
- `JAVA_HOME` is **not** set persistently — export it per shell as above, or set it permanently.
- Samsung USB driver v1.9.5.0 (installed, did not fix ADB — see §3.5).

---

## 5. Dependency upgrade (commit `423bcde`)

`expo prebuild` flagged the project as behind its own template, which turned out to be the
actual cause of a Gradle build failure: Gradle 9.3.1 (pinned by the SDK 57 template) removed
`JvmVendorSpec.IBM_SEMERU`, which the older react-native-gradle-plugin still referenced.

Moved forward together:

| Package | From | To |
|---|---|---|
| `expo` | ~56.0.19 | ~57.0.7 (resolves 57.0.12) |
| `react-native` | 0.85.3 | 0.86.0 (resolves 0.86.2) |
| `react-native-reanimated` | 4.3.1 | 4.5.1 |
| `react-native-worklets` | 0.8.3 | 0.10.1 |
| `jest-expo` | ~56.0.5 | ~57.0.4 |
| `eslint-config-expo` | ~56.0.4 | ~57.0.1 |

The reanimated/worklets and jest-expo bumps were forced peer-dependency consequences, not
optional. Full verification re-run after the upgrade — all green (see §1).

---

## 6. Outstanding work

### 6.1 Nothing is pushed
58 commits sit on local `master` only. `origin/master` is still at `15d0f59`.
**Decide whether to push.** Everything is verified locally but has never left this machine.

### 6.2 The Gate has never actually served a real conversation
This is the biggest gap. The Gate is fully built and unit-tested (71 tests) but:
- **No providers are configured** — `gate/providers/` contains only `.gitkeep`.
- **No `gate/.env`** exists, so no provider API key is present.
- **The Gate is not running** (nothing on port 8760).

Every chat-path test runs against a *stub* upstream. The manual live-acceptance step
(Plan 2a, Task 10 Step 4) has **never been performed**. Until it is, "the Gate can serve a
conversation" is asserted, not demonstrated.

To close it:
```bash
cd gate
echo "OPENAI_API_KEY=sk-..." >> .env        # or any provider you hold a key for
node cli.mjs add smoketest --flavor openai
# edit gate/providers/smoketest/provider.mjs — real baseUrl, apiKeyEnv, model id
node --env-file=.env cli.mjs start
# then POST to /p/smoketest/v1/chat/completions with the token it prints
```

### 6.3 Plan 2b's acceptance gate is unmet
`smoke:live` was generalized to run against any conforming gateway, but has only ever run
against **Hermes**. The comparison run — the actual evidence the manifest abstraction is real
rather than asserted — needs a live Gate:
```bash
npm run smoke:live -- http://127.0.0.1:8642   # Hermes  (passes today)
npm run smoke:live -- http://127.0.0.1:8760   # the Gate (never run)
```

### 6.4 Provider child sync unverified against a real Gate
Plan 2b Task 5 Step 3 (child profiles appearing/disappearing in the app as providers are
added/removed on the Gate) was never manually verified — same blocker as §6.2.

### 6.5 Hermes `WinError 64` resilience
See §3.1. Needs an upstream fix or a watchdog; currently requires a manual
`hermes gateway restart` whenever it recurs.

---

## 7. Quick reference

**Gateway URLs (all verified 200 as of this writing):**
- `http://127.0.0.1:8642` — local
- `http://100.95.137.83:8642` — tailnet IP (Hermes binds `0.0.0.0`, so this works)
- `https://ethanspc.tail3a1a8a.ts.net` — Tailscale Serve → `127.0.0.1:8642` ✅ *this is the one in use*

**API key:** `API_SERVER_KEY` in `C:\Users\ethan\AppData\Local\hermes\.env`
(64 chars, no quotes, single entry). A wrong/truncated paste here produces
"invalid API key" in `gateway.log` while the app shows only a generic connection failure.

**Health check triage, in order:**
```bash
netstat -ano | grep ":8642"                                    # is anything listening?
curl -s http://127.0.0.1:8642/health                           # is Hermes answering?
curl -s -o /dev/null -w "%{http_code}" https://ethanspc.tail3a1a8a.ts.net/health   # is Serve proxying?
tail -40 "$LOCALAPPDATA/hermes/logs/gateway.log"               # what is it actually saying?
"$LOCALAPPDATA/hermes/hermes-agent/venv/Scripts/hermes.exe" gateway restart        # the usual fix
```

**Tailscale:** `tailscale status` / `tailscale serve status`
(PC `ethanspc` 100.95.137.83, phone `ethans-a54` 100.81.238.109).
