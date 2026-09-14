# HANDOFF — Versutus: durable Gate · PC voice on GPU · true push

Written 2026-09-13 ~13:20 (America/New_York) by Claude (Opus 5) for a Hermes agent. Ethan owns and
operates this machine. **Verified** means a command showed it today; everything else is a plan.

Ethan's three asks, in his words:
1. "push registration is never wired up: is this global? true push notification are next priority"
2. "Install the models for the PC to power voice chat."
3. "Completely fix the gate and make it durable please"

Do them in this order: **A (Gate) → B (voice GPU) → C (push)**. Voice and push both need a running Gate.

---

## 0. Rules for this job

- **Never leave the fleet broken.** The Versutus Gate must be up and verified when you stop.
  Hermes (`127.0.0.1:8642`, v0.21.2, healthy) runs Ethan's unattended crons and Discord.
  - Do **not** restart Hermes.
  - Do **not** edit Hermes `config.yaml` or any profile `.env`.
  - Do **not** rotate any key: the Gate authenticates to Hermes with the default profile's key.
- **Never print secrets.**
  - `C:\Projects\Versutus\gate\.tokens.json` holds the Gate bootstrap token.
  - `gate start` prints `Token: …` to stdout.
  - Read it into a variable, never echo it, and redact it in any log you write.
- **Evidence before claims.** Every "done" needs the command output that proves it.
  - `npm run verify` does not compile Kotlin or link Android resources.
  - An APK needs a real `assembleRelease`.
- **Credentials are Ethan's.** Don't create Firebase or Expo accounts, and don't handle passwords.
  Ask him for the items listed in Task C.
- **Git:**
  - Do the work in the dev worktree `C:\Users\ethan\.codex\worktrees\bee6\Versutus`, on branch
    `fix/gate-service-and-voice-gpu`. It was created at `c2d9015` and has no changes yet.
  - Match the repo's commit style (`fix(gate): …`, `feat(voice): …`). Don't push to origin.
  - `C:\Projects\Versutus` (master) is the checkout the Gate runs from. Only fast-forward it to
    verified commits, and never switch branches there.
- **Ethan's preferences:**
  - Deliver features, fixes and optimizations. Refactoring alone doesn't count as a deliverable.
  - Phone builds include every in-flight branch.
  - No purchased API credits for voice.
- **Shell:** the host runs Windows PowerShell 5.1.
  - There is no `&&`.
  - Run an exe in the current folder as `.\x.exe`.
  - Avoid `2>&1` on native exes.
  - Paths over 260 characters break some tools, such as `git commit -F`.

---

## 1. State right now (verified)

| Thing | State |
|---|---|
| Master checkout `C:\Projects\Versutus` | Fast-forwarded `a155d25 → c2d9015`: voice sprint + widget sprint + shortcut-label fix, 673 files. 432 commits ahead of `origin/master`, not pushed. A stale 0-byte `.git\index.lock` from 2026-09-10 was removed first. |
| Gate | **Interim, NOT durable**, and gone at the next reboot. Details below the table. |
| Why the Gate was down | Ethan restarted the PC at 2026-09-12 23:51:59 (System event 1074), and nothing starts or supervises the Gate. `gate service install` is a stub: `handleService` in `gate/cli.mjs` only prints "Would install…". `gate/core/service/windows-task.mjs` builds XML that is never registered. |
| Phone | APK `versutus-everything-c2d9015` Taildropped to `ethans-a54` (same code as master; whether it's installed is unknown). |
| Voice models | `node gate\cli.mjs voice install` finished with exit 0 in 373 s. It created the venv `%LOCALAPPDATA%\Versutus\Gate\voice\venv` (Python 3.12.13, 38 packages) and installed 8 SHA-256-verified models into `…\voice\models`: the Kokoro onnx model and voices, Smart Turn v3.2, and faster-whisper large-v3-turbo (`whisper\*`, including the 1.6 GB `model.bin`). **The GPU path is broken** — see Task B. |
| Push | No remote push exists anywhere. See Task C. |
| OpenClaw | The `OpenClaw Gateway` and `OpenClaw Gateway (versutus)` tasks last exited with 0xC000013A (console closed). Nothing listens on 18789, yet `tailscale serve` maps `https://ethanspc.tail3a1a8a.ts.net/` → `http://127.0.0.1:18789`. Not part of this job: tell Ethan, don't change it. |

Interim Gate details:
- pid **40452**, running `node gate/cli.mjs start` from `C:\Projects\Versutus`, started detached and
  hidden at about 13:06.
- `http://127.0.0.1:8760/.well-known/gateway.json` returns 200.
- `node gate\cli.mjs doctor` is all ok: DPAPI usable; the claude, codex, hermes and opencode records
  are valid; 1 bot-group room.
- `pair list` shows 2 paired operator devices (Ethan's phones) and 3 stale pending
  `signoff-rehearsal-*` requests from 08-25.
- Logs are in `%LOCALAPPDATA%\Versutus\Gate\logs\`:
  - `interim-gate.out.log` **contains the token line — delete it after cutover**;
  - `interim-gate.err.log` is empty.

Host facts:

| Item | Value |
|---|---|
| User | `ETHANSPC\ethan` |
| node | `C:\Program Files\nodejs\node.exe` v24.14.0 |
| uv | `C:\Users\ethan\AppData\Local\hermes\bin\uv.exe` 0.12.13 |
| GPU | RTX 4060 8 GB, driver 610.47 |
| Disk | C: has 43 GB free |
| Firewall | inbound rule "Versutus Gate 8760" exists (any profile) |
| Network | Tailscale interface is Private; PC tailnet IP 100.95.137.83; phone is `ethans-a54` |

---

## 2. Task A — make the Gate a durable, supervised Windows service (do this first)

### Facts that constrain the design (verified)

- **Gate state lives in the code folder, not in Gate home.**
  - In the code folder: `C:\Projects\Versutus\gate\.tokens.json`, `.device-tokens.json`,
    `.pairing.json`, `.env` and `registry\` (see `gate/core/server.mjs:371,395,622`).
  - The worktrees have none of these files. The service must run from `C:\Projects\Versutus`, or the
    phone has to re-pair.
  - Gate home (`%LOCALAPPDATA%\Versutus\Gate`) holds config, DPAPI credentials, voice,
    `push-tokens.json` and `gate.lock`.
- **The credential vault is per-user DPAPI.** The task must run as `ETHANSPC\ethan` with
  `InteractiveToken`. S4U can't decrypt DPAPI, and a test already refuses SYSTEM.
- **A visible console window gets closed by hand.** That's how the Hermes and OpenClaw tasks died
  (0xC000013A). Launch the Gate without a window.
- **Two Task Scheduler defaults must be overridden.** The time limit is 72 h (`Hermes_Gateway` still
  has it), and priority 7 is below normal.
- **`instance-lock.mjs` trusts a lock whenever its pid exists.** Windows reuses pids after a reboot,
  so a lock written before the boot can block every start. Today's lock named pid 36604, which was
  dead, so it didn't bite this time.
- **`ws` is the Gate's only external npm dependency**, and it's already installed in master's
  `node_modules`.

### Implement

Work test-first in bee6. Use `npm run test:gate` while iterating and `npm run verify` before committing.

1. **Instance lock** (`gate/core/service/instance-lock.mjs`).
   - New signature: `acquireInstanceLock(dir, { name = 'gate.lock', bootTimeMs } = {})`, with the
     default `bootTimeMs = Date.now() - os.uptime() * 1000`.
   - A lock whose `at` is earlier than boot is stale, even if its pid is alive.
   - Add that case to `gate/__tests__/instance-lock-recovery.test.mjs`: write
     `{pid: process.pid, at: <before boot>}` and expect the acquire to succeed.
2. **Start exit codes and supervised shutdown.**
   - In `gate/core/cli-helpers.mjs`, add `startFailureExitCode(error)`. It returns `75` for
     `EADDRINUSE` or for a message starting `Gate instance lock`, and `1` otherwise. Test it.
   - `handleStart` in `cli.mjs` uses it.
   - When `process.send` exists (the Gate was spawned with IPC), handle a `{type:'shutdown'}` message
     and a `disconnect` the same way: `await gate.close()` with a 15 s cap, then `process.exit(0)`.
3. **Rotating log** (new `gate/core/service/rotating-log.mjs`).
   - Appends to `<gateHome>\logs\gate.log` and rotates at 10 MB, keeping 5 (`gate.log.1…5`).
   - Prefixes every line with an ISO timestamp and its source, and splits partial chunks into lines.
   - Replaces `^Token: .*` with `Token: [redacted]`.
   - Unit-test it against a temp folder.
4. **Supervisor** (new `gate/core/service/supervisor.mjs`). Keep it pure logic. Inject `spawnGate`,
   `probe`, `killTree`, `schedule`/`cancel`, `now`, `writeState` and `log`.
   - **Restart:** spawn the Gate. When it exits, restart after `[1s,2s,5s,10s,30s,60s]` backoff; reset
     the backoff once it has stayed up 10 minutes. Exit code 75 means someone else holds the port or
     lock, so wait 60 s.
   - **Health:** after a 90 s grace period, probe the manifest every 30 s with a 10 s timeout. After 4
     failures in a row, `killTree`, then restart as normal.
   - **`requestRestart()` / `stop()`:** send IPC `{type:'shutdown'}` and tree-kill after 10 s. Then
     respawn (restart) or exit (stop).
   - **State:** write
     `{status, supervisorPid, childPid, childStartedAt, restarts, lastExit{code,signal,at}, lastHealthyAt, codeRoot, gitHead}`
     on every transition.
   - **Tests** (fake timers and children):
     - restart with backoff;
     - backoff reset after 10 minutes up;
     - exit code 75 handling;
     - unhealthy kill;
     - a graceful stop never respawns.
5. **Task definition** (rewrite `gate/core/service/windows-task.mjs`).
   - Update `gate/__tests__/windows-service.test.mjs`, which pins the old `executable`/`command` shape.
   - Emit valid Task Scheduler XML: `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
     with every value XML-escaped.
   - Write it as UTF-16LE with a BOM: `Buffer.from('\ufeff' + xml, 'utf16le')`.
   - **Principal:** `UserId ETHANSPC\ethan`, `LogonType InteractiveToken`, `RunLevel LeastPrivilege`.
   - **Triggers:**
     - `LogonTrigger` for that user;
     - `TimeTrigger` with `Repetition Interval PT5M` and no duration. It revives a dead supervisor
       within 5 minutes.
   - **Settings:**
     - `MultipleInstancesPolicy IgnoreNew`, `ExecutionTimeLimit PT0S`, `Priority 5`;
     - `RestartOnFailure` every `PT1M`, up to 999 times;
     - `DisallowStartIfOnBatteries false`, `StopIfGoingOnBatteries false`;
     - `StartWhenAvailable true`, `AllowHardTerminate true`.
   - **Action:**
     - Command: `C:\Windows\System32\conhost.exe`.
     - Arguments: `--headless "C:\Program Files\nodejs\node.exe" "C:\Projects\Versutus\gate\cli.mjs" service run`.
     - `WorkingDirectory C:\Projects\Versutus`.
   - `--headless` is undocumented but widely used. Verify that no window appears. If one does, fall
     back to a hidden launcher and record why.
6. **CLI.** Make `handleService` real: call `schtasks` through `execFileSync` and keep the XML at
   `<gateHome>\service\VersutusGate.xml`.
   - **`install`:**
     - write the XML;
     - run `schtasks /Create /TN VersutusGate /XML <file> /F`, then `/Run`;
     - print the code root and git HEAD.
   - **`run`** (the supervisor):
     - Spawn `process.execPath [cli.mjs, 'start']` with cwd at the repo root,
       `stdio ['ignore','pipe','pipe','ipc']` and `windowsHide: true`.
     - Probe with `probeLocalGate` from `gate/core/service/diagnostics.mjs`, plus
       `AbortSignal.timeout(10000)`.
     - `killTree` is `taskkill /PID <pid> /T /F`.
     - Keep a single instance with `acquireInstanceLock(<gateHome>\service, {name:'supervisor.lock'})`.
     - Write state to `<gateHome>\service\supervisor.json`.
     - Every 2 s, check `<gateHome>\service\control.json` for `{action:'restart'|'stop'}`.
   - **`stop`:**
     - Run `schtasks /Change /TN VersutusGate /DISABLE` first. **Otherwise the 5-minute trigger
       restarts it.**
     - Write a `stop` control request and wait up to 20 s.
     - Then run `schtasks /End` and tree-kill any pid still named in `supervisor.json`.
     - Wait for port 8760 to close.
   - **`start`:** `/Change /ENABLE`, then `/Run`.
   - **`restart`:** write a `restart` control request.
   - **`uninstall`:** stop, then `/Delete /F`.
   - **`status`:**
     - report `schtasks /Query /TN VersutusGate /V /FO LIST` (state, last run and result);
     - report `supervisor.json` and a manifest probe;
     - exit 1 when not healthy.
   - Update the `help` text.
7. Get `npm run verify` green in bee6, then commit on `fix/gate-service-and-voice-gpu`.

### Cutover (keep downtime to seconds)

1. Check that `.git\index.lock` is absent and the tree is clean, then run
   `git -C C:\Projects\Versutus merge --ff-only fix/gate-service-and-voice-gpu`.
2. Confirm pid 40452 is `node` with `gate/cli.mjs start` in its command line, then run
   `Stop-Process -Id 40452`. The hard kill leaves `gate.lock` naming a dead pid, which lock recovery
   reclaims.
3. From `C:\Projects\Versutus`, run `node gate\cli.mjs service install`.
4. Delete `interim-gate.out.log` (it holds the token) and `interim-gate.err.log`.

### Acceptance (each must pass, with output)

- **Task:** `schtasks /Query /TN VersutusGate /V /FO LIST` shows Ready or Running, with the logon and
  5-minute triggers.
- **Processes:** conhost → node `service run` → node `start`.
- **No window:** the task's `conhost.exe` has `MainWindowHandle` 0, and no new `WindowsTerminal` or
  `OpenConsole` process appeared.
- **Health:**
  - the manifest returns 200;
  - `node gate\cli.mjs doctor` exits 0;
  - `pair list` still shows the 2 paired devices.
- **Bots:** `/v1/bots` returns `{object:'list', data:[{id, displayName, routable, routingIssue, …}]}`.
  - Count the `routable` rows.
  - A lone `default` bot means the Hermes home resolved wrong (see
    `gate/core/cli-environments/adapters/hermes.mjs`).
  - Today's first rows (default, anvil, counsel) were routable.
- **Crash recovery:**
  - Kill the Gate child: it's back within seconds, and the restart is logged in `gate.log`.
  - Kill the supervisor tree: it's back within 5 minutes through the time trigger.
- **Stop and start:** after `service stop` the Gate is still stopped 5 minutes later, and
  `service start` brings it back.
- **Logs:** `gate.log` contains no token.
- **Final check:** `node gate\cli.mjs service status` exits 0.
- **Ask Ethan:**
  - to confirm his phone connects;
  - after his next reboot, `service status` should show the Gate came back at logon.

Authenticated probe that never echoes the token:
```powershell
$t = (Get-Content C:\Projects\Versutus\gate\.tokens.json -Raw | ConvertFrom-Json).token
$h = @{ Authorization = "Bearer $t" }
$bots = (Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:8760/v1/bots -Headers $h).Content | ConvertFrom-Json
"bots $(@($bots.data).Count), routable $(@($bots.data | Where-Object routable).Count)"
```
The device-only RPCs (`voice.capabilities`, `approvals.pending`, `notifications.*`) answer the
bootstrap token with 403 `pairing_required`. That's expected; on the host, use
`node gate\cli.mjs voice status` instead.

---

## 3. Task B — make PC voice actually run on the GPU

### Verified problem

- **Missing packages.** `gate/voice-worker/requirements.lock` doesn't include `nvidia-cublas-cu12`
  or `nvidia-cudnn-cu12`.
- **DLLs in the venv.** ctranslate2 4.8.2 ships only `ctranslate2.dll`, `cudnn64_9.dll` and
  `libiomp5md.dll`.
  - `cublas64_12.dll`, `cublasLt64_12.dll`, `cudnn_ops64_9.dll` and `cudnn_cnn64_9.dll` can't be
    loaded from anywhere, and `CUDA_PATH` isn't set.
  - `ctranslate2.get_cuda_device_count()` returns 1, but that call never loads cuBLAS.
- **What the spike found** (`docs/plans/voice-spikes/s2-findings.md`):
  - the GPU path works only with those two wheels installed;
  - without them, ctranslate2 can fail even on CPU.
- **The worker half-handles it.**
  - `_register_cuda_dlls` (`gate/voice-worker/versutus_voice/server.py:260`) already registers
    `site-packages\nvidia\*\bin`.
  - `load_whisper` (`server.py:298`) **silently falls back to CPU** on any CUDA error, so a broken GPU
    looks like slow voice rather than an error.

### Steps

1. **Red first.** Run this script with no try/except, so the real error shows.
   - Python: `C:\Users\ethan\AppData\Local\Versutus\Gate\voice\venv\Scripts\python.exe`.
   - Working folder: `C:\Users\ethan\.codex\worktrees\bee6\Versutus\gate\voice-worker`.
   ```python
   import time, pathlib, numpy as np
   from versutus_voice.server import _register_cuda_dlls, load_kokoro
   _register_cuda_dlls()
   from faster_whisper import WhisperModel
   models = pathlib.Path(r"C:\Users\ethan\AppData\Local\Versutus\Gate\voice\models")
   t = time.time(); m = WhisperModel(str(models / "whisper"), device="cuda", compute_type="int8_float16"); print("cuda load s", round(time.time() - t, 1))
   k = load_kokoro(models)
   s, rate = k.create("Versutus voice check on this PC.", voice="af_sarah", speed=1.0, lang="en-us")
   a = np.interp(np.linspace(0, len(s) - 1, int(len(s) * 16000 / rate)), np.arange(len(s)), s).astype(np.float32)
   t = time.time(); segs, _ = m.transcribe(a, beam_size=5); print(repr("".join(x.text for x in segs).strip()), "final ms", round((time.time() - t) * 1000))
   ```
2. **Add the CUDA packages.**
   - Add `nvidia-cublas-cu12` and `nvidia-cudnn-cu12` to `gate/voice-worker/requirements.in`. Use
     cuDNN 9 on CUDA 12, which is what ctranslate2 4.8.x is built for.
   - Regenerate the lock from the repo root with the command in the lock's header:
     `uv pip compile --python 3.12 gate/voice-worker/requirements.in -o gate/voice-worker/requirements.lock`.
   - Pin the resolved versions in `requirements.in`, like the other top-level pins. Expect more than
     1 GB of wheels from PyPI.
3. **Reinstall.** Run `node gate\cli.mjs voice install`. It's idempotent: the models are already
   verified, so only the new wheels install.
4. **Green.** Re-run the script from step 1.
   - Expect the CUDA load to take a few seconds, the sentence to come back correct, and a final
     transcription of about 400–500 ms (the spike measured 424 ms p50).
   - Then `node gate\cli.mjs voice doctor` should be all ok, with CUDA showing VRAM.
   - And `node gate\cli.mjs voice status` should show `engines.local.state: "ready"`.
5. **Worthwhile fix while you're here: make the CPU fallback visible.**
   - Log or emit which device Whisper loaded on.
   - Have `voice doctor` actually load Whisper on CUDA; today it only runs `nvidia-smi`.
   - Test with the worker's pytest suite (`npm run test:voice-worker`). Add `-p no:cacheprovider`, for
     example in `gate/voice-worker/pytest.ini`: a pytest cache created from an elevated shell became
     unreadable in the voice worktree and broke release builds.
6. **Ship.** Run `npm run verify`, commit, fast-forward master, then `node gate\cli.mjs service restart`.
7. **End-to-end test needs Ethan.** He starts a hands-free call from the phone with Settings → Voice →
   "This PC — local voice".
   - Codex voice is disabled on purpose: a ChatGPT login can't do realtime
     (`gate/core/voice/runtime.mjs:197`).
   - Kokoro on CPU misses its 300 ms target (476 ms p50). onnxruntime-gpu or a warm start can fix that
     later; it isn't a blocker.

---

## 4. Task C — true push notifications (Ethan's next priority)

### Answer to Ethan's question: yes, it's global

No remote push exists anywhere in the app; the widget was just one casualty. Today there are only local
notifications (`src/lib/notifications/local.ts`, `routine-sync.ts`, `weekly-report.ts`). They fire only
while the app is alive and connected.

The verified gaps:
1. **The app never registers.** `syncPushRegistration` (`src/lib/notifications/push-registration.ts:100`)
   has no production caller; only `__tests__/push-registration-test.ts` calls it.
2. **The Android app has no Firebase.** There's no `google-services.json` and no
   `android.googleServicesFile` in `app.json`. `Notifications.getExpoPushTokenAsync` therefore can't
   produce a token on Android; the code swallows the error and returns null.
3. **The Gate never sends on events.**
   - `gate/core/server.mjs:396-398` wires `push-rpc.mjs`
     (`notifications.register/deregister/preferences.get/preferences.set/test`) and `push-send.mjs`
     (Expo Push API, `https://exp.host/--/api/v2/push/send`), with
     `PushTokenStore(<gateHome>\push-tokens.json)`.
   - But `createPushNotifier` (`gate/core/push-notifier.mjs`) is never created, so no run, approval,
     routine or reply ever triggers a push.
4. **The widget companion is wrong.**
   - `widgetCompanion` in `push-notifier.mjs` hard-codes `connected: true`,
     `work: 'No runs in flight'` and `approvalsPending: 0`.
   - It ignores the privacy/richBody preference.
   - Nothing in the app ever sets `widgetUpdates: true`.

The spec is "Solution A — True push notifications" in `FUTURE-ITEMS.md`:
- A1: credentials;
- A2: token lifecycle;
- A3: token registry;
- A5/A6: per-device toggle and preferences.

### Ethan must provide these (you can't)

- **A Firebase project** with an Android app for package `com.versutus.app`, and its
  `google-services.json`.
  - It goes at the repo root.
  - It isn't git-ignored today. Google doesn't treat it as a secret, but ask Ethan whether to commit
    it.
- **An FCM V1 service-account key**, uploaded to the Expo/EAS project
  `52545800-300a-4bbc-a2b9-7e412d9c217e` (owner `jonesinsrc`) under Credentials → Android → FCM V1.

### Implement (test-first)

- **App:**
  - `app.json` → `android.googleServicesFile: "./google-services.json"`.
  - Call `syncPushRegistration(client)` once per successful connect or pairing, without blocking the
    connection (it already swallows failures).
  - Ask for notification permission from a user action (a Settings toggle), not at launch.
  - Build Settings → Notifications on `notifications.preferences.set`:
    - an enable toggle;
    - rich body;
    - quiet hours;
    - a per-Bot filter;
    - widget updates;
    - a "Send test" button that calls `notifications.test`.
  - Deregister on unpair and when a gateway profile is removed.
- **Gate:**
  - In `server.mjs`, create `createPushNotifier({ tokens: pushTokens, send: pushSend.send })`.
  - Call `notify(event)` from the real event sources:
    - run finished or failed: `trigger:'run'`;
    - approval requested: `'approval'`;
    - Bot reply finished: `'final-response'` with a `sessionId` (cron sessions map to routines);
    - routine finished: `'routine'`.
  - Test with a fake `send`.
  - Handle receipts and dead tokens (`removeByToken` already exists).
- **Widget companion:**
  - Build it from the Gate's real state: connection, runs in flight, pending approvals, newest result.
  - Honor privacy and richBody.
- **Build and ship:**
  - `app.json` changes, so prebuild is required. Then build the release APK and Taildrop it (recipe in
    §6).
  - Verify on the phone with the app killed: run a routine or trigger an approval, and the notification
    arrives.
  - Tapping it routes correctly (the response listener in `_layout.tsx`).

---

## 5. Known defects and backlog (not in scope unless Ethan asks)

- **Widget:**
  - Bot rows show raw ids (`PublicBot.displayName` vs label).
  - `WidgetConfigureActivity` crashes on a widget id it doesn't own, and it calls `runBlocking` on the
    main thread.
- **Unscoped app RPCs.** App RPCs carry no Bot scope, while the REST helpers do. For named Bots this
  breaks:
  - the thread tap (`session.restore`);
  - Activity-tab job Add, Run now and Pause.
  - Filed in `C:\Projects\Versutus\.sprint-hermes\REMEDIATION.md`, with repros in
    `.sprint-hermes\repro\`.
- **Unreadable pytest cache.** `C:\Users\ethan\.codex\worktrees\voice\Versutus\gate\voice-worker\.pytest_cache`
  is unreadable (ACL). Ethan must delete it from an elevated shell.
- **Stale pairing requests.** 3 pending `signoff-rehearsal-*` requests from 08-25. Harmless; clear
  them only with Ethan's OK.
- **Gate state in the code folder.** Moving it to Gate home with a copy-migration would make the Gate
  more durable later. Not required for this job.

---

## 6. Reference

**Gate CLI** (run from `C:\Projects\Versutus`):
- `node gate\cli.mjs start`
- `node gate\cli.mjs doctor`
- `node gate\cli.mjs pair list`
- `node gate\cli.mjs voice install|doctor|status`
- `node gate\cli.mjs service …`

**Android release and Taildrop** (run in the worktree you built in):
```powershell
$env:CI = '1'; npx expo prebuild --platform android --clean
Set-Content android\local.properties 'sdk.dir=C\:\\Users\\ethan\\AppData\\Local\\Android\\Sdk' -Encoding ascii
cd android; .\gradlew.bat assembleRelease     # ~8 min; APK at android\app\build\outputs\apk\release\app-release.apk
tailscale file cp <renamed.apk> ethans-a54:    # ~10 min over the DERP relay
```
Two gotchas:
- A shortcut label, or any other resource a config plugin writes, must be an `@string/` reference, or
  `processReleaseResources` fails.
- An unreadable folder anywhere in the repo breaks `createBundleReleaseJsAndAssets`.

**Key paths:**
- **Gate code:**
  - `gate/cli.mjs`, `gate/core/server.mjs`, `gate/core/cli-helpers.mjs`;
  - `gate/core/service/{windows-task,instance-lock,doctor,diagnostics}.mjs`;
  - `gate/core/voice/{runtime.mjs,engines/local-engine.mjs}`;
  - `gate/core/push-{rpc,send,notifier,tokens}.mjs`.
- **Voice worker:** `gate/voice-worker/{requirements.in,requirements.lock,models.lock.json,pytest.ini,versutus_voice/server.py}`.
- **App push:** `src/lib/notifications/{push-registration,local,routine-sync,weekly-report}.ts` and
  `src/app/_layout.tsx`.
- **Gate home:** `C:\Users\ethan\AppData\Local\Versutus\Gate`, which holds `config\`,
  `credentials\*.dpapi`, `voice\`, `push-tokens.json`, `gate.lock` and `logs\`.
- **Plans:** `docs/plans/2026-09-12-realtime-voice-plan.md`,
  `docs/plans/voice-spikes/{DECISIONS,s2-findings}.md` and `FUTURE-ITEMS.md`.
- **Existing scheduled tasks** (for reference): `Hermes_Gateway`, `Hermes_Gateway_Watchdog` (logon
  trigger plus every PT3M) and `OpenClaw Gateway (versutus)`.

**Report back to Ethan** with:
- what changed (commits);
- the acceptance outputs above;
- anything you couldn't verify;
- what you need from him: Firebase `google-services.json`, the FCM V1 key in EAS, and a phone test.
