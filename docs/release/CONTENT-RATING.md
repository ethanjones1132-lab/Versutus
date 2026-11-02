# Content Rating — Versutus (Play open testing)

**Status:** DRAFT answer sheet prepared from current source on 2026-11-02.
**Not submitted.** No questionnaire has been completed in Play Console, no IARC rating has
been assigned, and no rating certificate exists. This is not legal advice or an approval.

This file covers the content-rating questionnaire only. Data collection is in
`docs/release/PLAY-DATA-SAFETY.md`; the user-facing policy is
`docs/release/PRIVACY.md`.

## 1. Sources and how to read this file

Primary documentation retrieved on 2026-11-02:

- Google Play, "Content Ratings" —
  <https://support.google.com/googleplay/android-developer/answer/9898843>
- Google Play, "Content rating requirements for apps, games, and the ads served on both"
  (includes the questionnaire steps and rating-authority descriptions) —
  <https://support.google.com/googleplay/android-developer/answer/9859655>
- Google Play, "Manage target audience and app content settings" (target age groups,
  Families policy, Restrict Minor Access) —
  <https://support.google.com/googleplay/android-developer/answer/9867159>
- Google Play, "Provide information for Google Play's Data safety section" (used only to
  keep content-rating and data-safety questions separate) —
  <https://support.google.com/googleplay/android-developer/answer/10787469>
- IARC ratings definitions — <https://www.globalratings.com/ratings-definitions/>

Play's public pages explain that the questionnaire is completed in Play Console, that
IARC authorities assign ratings from the answers, and that misrepresentation can lead to
removal or suspension (`.../answer/9898843`, `.../answer/9859655`). They do **not**
publish the current console's exact question wording or branch logic. Every answer below
is therefore marked as either **source-backed** (the technical fact is proved by code) or
**judgment/unverified** (the form classification or content decision is not settled here).

## 2. Verified technical profile

These facts are what the questionnaire is trying to describe. They are cited so Ethan can
answer the form without relying on the previous release-plan shorthand.

| Fact | Evidence |
|---|---|
| Versutus is a client for AI agent gateways. It holds no model credentials of its own, brokers nothing for anyone else, and is not a public relay. | `README.md:1-9`; `CONTEXT.md:3` |
| There are no user accounts, profiles, friend lists, feeds, or developer-hosted social features. A user saves a gateway URL/token and talks to agents on it. | `README.md:7`; `app.json:135-140`; `src/lib/gateway/storage.ts:8-9` |
| Chat surfaces display the user's own text and whatever the configured agent returns, rendered as markdown; the content is not curated or moderated by the developer. | `src/context/gateway-provider.tsx:4519-4617`; `src/components/chat/markdown/markdown-text.tsx:29-34` |
| A user can attach photos, camera images, and documents; this is optional and only happens on an explicit picker/capture action. | `src/components/chat/chat-screen.tsx:1435-1552` |
| A user can use voice: push-to-talk, or a hands-free call. Voice is optional; audio may be handled by the OS recogniser or sent to the user's Gate depending on the resolved engine. | `src/lib/voice/speech-recognition.ts:151-178`; `modules/handsfree-voice/android/.../HandsfreeGateMedia.kt:221-235`; `src/lib/voice/voice-engine-choice.ts:69-95` |
| No advertising SDK or ad-serving code is declared or imported. | `package.json:14-63` (no AdMob/ads package); no ad module under `src/` |
| No in-app purchase, billing, subscription, or digital-goods SDK is declared. | `package.json:14-63` (no billing/RevenueCat/StoreKit package) |
| No location permission is requested, and no code path transmits GPS/location. | `app.json:24-39`; `src/lib/gateway/candidates.ts:67-117` (LAN/manual hosts only) |
| No gambling, casino, lottery, or real-money mechanic exists. | `package.json:14-63`; the app is a chat/gateway client (`README.md:1-9`) |
| No alcohol, tobacco, drug, or horror content is authored into the shipped UI as a feature; the UI is a chat client. | `README.md:1-9`; `src/context/gateway-provider.tsx:4519-4617` (renders user/model content) |
| Links in model output are restricted to `http:`/`https:` and open in an `expo-web-browser` sheet, not a browser tab with an address bar. OAuth pages also use that sheet. | `src/components/chat/markdown/markdown-text.tsx:29-34`; `src/components/external-link.tsx:2`, `:18`; `src/components/gateway/oauth-progress-sheet.tsx:1`, `:31` |
| Push notification bodies are empty by default; titles and routing ids only, with an opt-in rich body. | `gate/core/push-tokens.mjs:10-16`; `gate/core/push-notifier.mjs:158-169` |
| The app collects no age and ships no age gate. | `app.json:24-39`; no age field in the settings/state read |

What this profile does **not** prove: that no arbitrary mature content can ever appear.
The app deliberately displays unmoderated text and model output from a server the user
controls. That is the central content-rating judgment below.

## 3. Draft answers by questionnaire theme

The theme names are a working checklist, not verified console wording. Where the technical
fact is proved, the answer is a draft Ethan can accept; where the classification depends on
IARC's interpretation, the status says so.

| Questionnaire theme | Draft technical answer | Basis | Status |
|---|---|---|---|
| App or game | **App** (a chat/gateway client; no gameplay loop, score, levels, or game engine) | `README.md:1-9`; `CONTEXT.md:3` | Source-backed; console category wording unverified |
| Contains ads | **No** — no advertising SDK, no ad-serving code | `package.json:14-63`; no ad module under `src/` | Source-backed |
| In-app purchases / digital goods | **No** — no billing or purchase path | `package.json:14-63`; no purchase code in the tree read | Source-backed |
| Gambling (real or simulated) | **No** — no gambling mechanic or real-money play | `README.md:1-9`; `package.json:14-63` | Source-backed |
| Shares the user's location | **No** — no location permission or transmission | `app.json:24-39`; `src/lib/gateway/candidates.ts:67-117` | Source-backed |
| Unrestricted web access | **No** — no address bar or open browser surface; links open an `expo-web-browser` sheet and model links are limited to http/https | `src/components/chat/markdown/markdown-text.tsx:29-34`; `src/components/external-link.tsx:2`, `:18` | Technical fact source-backed; IARC treatment of link-outs unverified |
| User-to-user interaction / social features | **No app-level accounts, discovery, feeds, friend lists, or developer-hosted messaging.** A user talks to agents on a gateway they configure; there is no other user to find in the app. | `README.md:7`; `app.json:135-140`; `src/lib/gateway/storage.ts:8-9` | Technical fact source-backed; whether IARC treats AI chat as "interaction" unverified |
| User-generated content hosted by the developer | **No developer-hosted UGC.** The app renders the user's own messages and the agent's replies from the user's gateway; it does not publish them to a developer service or to other users. | `README.md:7`; `src/context/gateway-provider.tsx:4519-4617` | Technical fact source-backed; IARC classification unverified |
| Violence (including cartoon/fantasy/realistic) | **No developer-authored violent content in the shipped UI.** Model output can contain anything; whether that is "app content" is the unresolved question. | `README.md:1-9`; `src/context/gateway-provider.tsx:4519-4617` | Judgment required |
| Sexuality / nudity | **No developer-authored sexual or nude content in the shipped UI.** Model output can contain anything. | `README.md:1-9`; `src/context/gateway-provider.tsx:4519-4617` | Judgment required |
| Profanity / strong language | **No developer-authored profanity in the shipped UI.** Model output can contain anything. | `README.md:1-9`; `src/context/gateway-provider.tsx:4519-4617` | Judgment required |
| Controlled substances (drugs, alcohol, tobacco) | **No developer-authored substance content in the shipped UI.** Model output can contain anything. | `README.md:1-9`; `src/context/gateway-provider.tsx:4519-4617` | Judgment required |
| Horror / fear | **No developer-authored horror content in the shipped UI.** Model output can contain anything. | `README.md:1-9`; `src/context/gateway-provider.tsx:4519-4617` | Judgment required |
| Crude humor / mature themes | **No developer-authored crude or mature content in the shipped UI.** Model output can contain anything. | `README.md:1-9`; `src/context/gateway-provider.tsx:4519-4617` | Judgment required |
| Does the app let users communicate with strangers? | **No app-level stranger discovery or messaging.** The only endpoint is the gateway the user configures; if that gateway is shared with other people, that is outside the app's social surface. | `app.json:135-140`; `src/lib/gateway/storage.ts:8-9` | Technical fact source-backed; console branch unverified |
| Does the app show personal information to other users? | **No app-level profile or sharing surface.** Messages/attachments go to the configured gateway, not to an in-app audience. Data-safety recipients are in `PLAY-DATA-SAFETY.md`. | `src/context/gateway-provider.tsx:4519-4617` | Source-backed; form wording unverified |

The "no developer-authored" answers above are a **source-review finding**, not a proof
over every string in the bundle: the shipped UI is a technical chat client, and the only
free-form content it renders is the user's own text and the configured agent's output.
That distinction is exactly what the judgment below turns on.

### The one sentence Ethan should not skip

The app's own UI is a technical chat client with no ads, purchases, gambling, location
sharing, or social graph. But it **deliberately displays unmoderated model output** from a
server the user controls. If IARC treats that output as content supplied by the app, the
app may need mature-content descriptors even though the developer authored none of it. If
IARC treats it as user-provided content from a private server, the answer may be "no
developer-hosted mature content." This draft cannot choose between those readings; that is
the ship-packet decision.

## 4. Target audience and product judgments for Ethan

These are not source facts and must not be filled in by an agent. Each one changes the
Console answers and possibly Play policy obligations.

1. **Target age group.** The app requires a gateway URL/token and is a power-user agent
   client; it has no child-oriented characters, stories, or gameplay. But it can display
   arbitrary model output and accepts photos/voice. Choose the age group(s) honestly from
   Play's 13-15, 16-17, and 18+ groups. Play's target-audience page explains that selecting
   any group including children triggers Families policy obligations, and that selecting
   only 18+ allows the Restrict Minor Access feature
   (<https://support.google.com/googleplay/android-developer/answer/9867159>, retrieved
   2026-11-02).
2. **Is the app "designed for children"?** The source gives no child-specific content or
   age collection, but the product is not aimed at children. Ethan declares this; the
   listing assets and copy must match it.
3. **Does unmoderated model output count as app content?** Decide the position before
   answering the violence/sex/profanity/substances/horror branches. If the answer is "the
   app can show it", plan for the corresponding descriptors or add a content policy/filter
   before claiming otherwise. That is a product decision, not a docs fix.
4. **Does the AI chat count as "user interaction" or "user-generated content"?** There are
   no other users in the app, but a reviewer may see a chat surface and ask. Decide the
   honest answer and be ready to explain the user-controlled gateway.
5. **Do external browser links count as unrestricted web access?** There is no address bar
   or open browsing surface; links open an `expo-web-browser` sheet
   (`src/components/external-link.tsx:18`). Ethan decides how to answer if the console
   asks.
6. **App category/subcategory.** Tools/Productivity/Communication are plausible; the
   console's category list is the authority, and this affects discovery, not the technical
   answers.
7. **IARC contact email.** The questionnaire asks for an email used for IARC
   correspondence (`.../answer/9859655`). No email is stored in this repo; do not invent
   one. Ethan supplies it.
8. **Whether to add an age gate or content filter.** If the target audience includes
   minors, Play's Families requirements apply. If the app is adult-only, Restrict Minor
   Access is available. Either is a product/legal choice.
9. **Store listing copy and screenshots.** They must not suggest a child audience if the
   target age is adult, and must not imply content moderation the app does not perform
   (`README.md:1-9`; Play metadata policy is separate).
10. **Final questionnaire submission and any IARC follow-up.** Only Ethan can operate the
    Console, accept the calculated ratings, or appeal them. This file does not do that.

## 5. Explicitly unverified form interpretations

Do not treat these as settled:

- The exact IARC questionnaire branches, wording, and order for the current Console. The
  public Help Center describes the process and the authorities but does not enumerate the
  live form; the theme table above is a checklist, not a transcript.
- Whether an AI chat client with a user-supplied gateway is "user interaction", "UGC", or
  neither for IARC purposes.
- Whether a link-out browser sheet is "unrestricted web access".
- Whether arbitrary model output is attributed to the app or to the user/server that
  produced it.
- Whether the app's ability to connect to a shared gateway creates a "communication with
  other users" feature in IARC's view.
- The ratings any authority will actually assign. Those are generated by the Console from
  Ethan's answers and can be overridden by a rating authority
  (`.../answer/9859655`).
- Whether any AI-specific content question exists in the current questionnaire. No such
  wording was verified on the public pages retrieved.

## 6. What this file does not establish

- No content rating, IARC certificate, age rating, or legal approval has been obtained.
- No Play Console account, questionnaire, email, or submission was created or touched.
- No contact address, hosted privacy-policy URL, testing completion, or account fact is
  asserted.
- No claim is made that the app is "safe for all ages", "child-friendly", or free of
  mature content in every possible model response.
- No runtime, native, test, CI, or store configuration was changed for this document.
