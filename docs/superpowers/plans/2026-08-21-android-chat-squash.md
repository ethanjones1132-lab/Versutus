# Android chat squash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a Galaxy A54, chat chrome clears the status bar, the composer rides above the IME, bubbles keep a real width, the list does not corrupt under stream updates, live tool cards appear without a refresh, and bot-open failures show the Hermes body instead of a generic 500.

**Architecture:** All fixes stay in-repo. Android IME lift uses Reanimated `useAnimatedKeyboard` (already shipped) minus the bottom safe-area inset already applied by `Screen`. Status-bar overlap is the missing top safe edge on connected tab screens. Bubble width is a numeric max from window size, not a percentage of a shrink-to-fit parent. List corruption is duplicate history ids plus `removeClippedSubviews` on a streaming FlatList. Tool cards and 500 copy are parser/transport bugs. Bot open stops swallowing `getSessions` and paints the Bot surface immediately. Do **not** change the Hermes stream endpoint.

**Tech Stack:** Expo SDK 57, React Native 0.86, Reanimated 4.5.1, `react-native-safe-area-context` 5.7, Jest (`jest-expo`) for app pure layers, `node --test` for Gate. No new native modules. No `react-native-keyboard-controller`.

**Design:** Approved in conversation 2026-08-21 (keyboard option A). No separate spec file.

## Global Constraints

- Read https://docs.expo.dev/versions/v57.0.0/ before changing Expo UI, keyboard, or safe-area behavior. Android wins any real conflict with iOS/web.
- No new dependencies. Reanimated `useAnimatedKeyboard` is the IME API.
- Do not set `android.softwareKeyboardLayoutMode`. Manifest already has `adjustResize`; edge-to-edge ignores it. Padding is the fix.
- Do not switch Hermes `/v1/chat/completions` to `/api/sessions/{id}/chat/stream`.
- Do not add FlashList or rewrite markdown-on-stream.
- Do not change Bot Chat semantics (canonical title `Bot Chat`, roster landing).
- `AmbientCanvas` stays full-bleed (it already sits outside `SafeAreaView`).
- App logic: TDD. React chrome (`Screen` edges, FlatList prop, composer wiring) has no render harness in this repo — lock the math in helpers, then the JSX is a mechanical wrap. After each app task: `npx jest <file> --runInBand`. After JSX-only tasks: `npx tsc --noEmit`.
- Coverage ratchet only watches `src/lib/gateway/**/*.ts`. Put HTTP/stream/bot helpers there. Keyboard/bubble math may live under `src/lib/motion/` (existing pattern: `ambient-parallax.ts`).
- Work in `C:\Projects\Versutus` on `feat/hermes-bots-talk`. Commit messages explain *why* and name the failure they prevent.
- Release APK has `expo.modules.updates.ENABLED=false`. Device verification needs a debug reload or a new install; do not claim the Galaxy A54 is fixed from unit tests alone.

---

## File Structure

**New**

- `src/lib/motion/keyboard-lift.ts` — `composerKeyboardLift(keyboardHeight, bottomInset)`
- `__tests__/keyboard-lift-test.ts`
- `src/lib/motion/bubble-width.ts` — `bubbleMaxWidth(windowWidth, hasMonogram)`
- `__tests__/bubble-width-test.ts`
- `src/lib/gateway/http-error-body.ts` — `messageFromHttpErrorBody(errorText, status)`
- `src/lib/gateway/chat-stream-delta.ts` — `createChatStreamAcc`, `interpretChatStreamChunk`

**Modified**

- `src/components/chat/chat-composer.tsx` — Android IME padding via `useAnimatedKeyboard`
- `src/components/terminal/terminal-screen.tsx` — same lift; drop `edges={['bottom']}`
- `src/components/chat/chat-screen.tsx` — default Screen edges; no `removeClippedSubviews`; optimistic Bot surface
- `src/app/(tabs)/index.tsx` — default Screen edges
- `src/app/(tabs)/activity.tsx` — default Screen edges
- `src/app/dev/preview.tsx` — default Screen edges (lab must match the phone)
- `src/components/chat/message-bubble.tsx` — numeric `maxWidth` on `bubbleColumn`; stretch the row
- `src/lib/gateway/messages.ts` — unique history ids
- `__tests__/messages-test.ts`
- `src/lib/gateway/http-transport.ts` — use `messageFromHttpErrorBody`
- `src/lib/gateway/environment-client.ts` — same helper in `ensureOk`
- `__tests__/http-transport-test.ts`
- `src/lib/gateway/client.ts` — `streamChat` uses `interpretChatStreamChunk`
- `src/lib/gateway/manifest-client.ts` — same
- `__tests__/manifest-client-test.ts`
- `src/lib/gateway/bots.ts` — `loadBotChat` (list, then `ensureBotChat`, no swallow)
- `__tests__/bots-roster-test.ts`
- `src/context/gateway-provider.tsx` — `openBot` calls `loadBotChat`

**Not modified**

- `android/app/src/main/AndroidManifest.xml` (`adjustResize` stays)
- `app.json` (no `softwareKeyboardLayoutMode`, no keyboard-controller plugin)
- `gate/core/cli-environments/backends/hermes.mjs` stream endpoint
- Bot Chat title / roster ADRs

---

### Task 1: Keyboard lift math

**Files:**
- Create: `src/lib/motion/keyboard-lift.ts`
- Test: `__tests__/keyboard-lift-test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `composerKeyboardLift(keyboardHeight: number, bottomInset: number): number`

The composer already lives inside `Screen`'s bottom-edged `SafeAreaView`. IME height is measured from the physical bottom of the screen, so it includes the nav-bar inset we already padded. Lift is `max(0, keyboardHeight - bottomInset)`. Closed keyboard → 0.

- [ ] **Step 1: Write the failing tests**

```ts
import { composerKeyboardLift } from '@/lib/motion/keyboard-lift';

test('closed keyboard does not lift', () => {
  expect(composerKeyboardLift(0, 24)).toBe(0);
  expect(composerKeyboardLift(-10, 24)).toBe(0);
});

test('open keyboard subtracts the bottom inset already applied by Screen', () => {
  expect(composerKeyboardLift(320, 24)).toBe(296);
});

test('keyboard shorter than the inset does not go negative', () => {
  expect(composerKeyboardLift(16, 24)).toBe(0);
});

test('non-finite values lift nothing', () => {
  expect(composerKeyboardLift(Number.NaN, 24)).toBe(0);
  expect(composerKeyboardLift(320, Number.NaN)).toBe(320);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/keyboard-lift-test.ts --runInBand`

Expected: FAIL — `Cannot find module '@/lib/motion/keyboard-lift'`

- [ ] **Step 3: Write minimal implementation**

```ts
/** IME lift for a composer already inside a bottom-safe Screen. */
export function composerKeyboardLift(keyboardHeight: number, bottomInset: number): number {
  if (!Number.isFinite(keyboardHeight) || keyboardHeight <= 0) return 0;
  const inset = Number.isFinite(bottomInset) && bottomInset > 0 ? bottomInset : 0;
  return Math.max(0, keyboardHeight - inset);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/keyboard-lift-test.ts --runInBand`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/motion/keyboard-lift.ts __tests__/keyboard-lift-test.ts
git commit -m "$(cat <<'EOF'
fix(app): lift chat composer by IME height minus the bottom inset

Android 15 edge-to-edge ignores adjustResize, and KeyboardAvoidingView
was explicitly disabled on Android, so the composer sat under the keyboard.
EOF
)"
```

---

### Task 2: Wire Android IME padding on chat and terminal composers

**Files:**
- Modify: `src/components/chat/chat-composer.tsx`
- Modify: `src/components/terminal/terminal-screen.tsx` (the `KeyboardAvoidingView` around the shell input, ~287–317)

**Interfaces:**
- Consumes: `composerKeyboardLift(height, inset)` from Task 1
- Produces: Android composers translate with IME; iOS keeps `KeyboardAvoidingView behavior="padding"`

No new native module. Call `useAnimatedKeyboard` unconditionally (hooks). Apply padding only on Android so iOS is not double-padded.

- [ ] **Step 1: Confirm Expo / Reanimated keyboard API**

Read https://docs.expo.dev/versions/v57.0.0/ and Reanimated 4.5 `useAnimatedKeyboard` options. On edge-to-edge Android pass:

```ts
useAnimatedKeyboard({
  isStatusBarTranslucentAndroid: true,
  isNavigationBarTranslucentAndroid: true,
})
```

If the installed Reanimated types omit those flags, call `useAnimatedKeyboard()` with no args rather than inventing options.

- [ ] **Step 2: There is no render-test seam — skip a fake composer test**

Do not mount `ChatComposer` in Jest. The lift math is Task 1.

- [ ] **Step 3: Wrap the chat dock**

In `chat-composer.tsx`:

- Import `useAnimatedKeyboard`, `useAnimatedStyle` from `react-native-reanimated` (file already imports `Animated`).
- Import `useSafeAreaInsets` from `react-native-safe-area-context`.
- Import `composerKeyboardLift` from `@/lib/motion/keyboard-lift`.
- Keep the outer `KeyboardAvoidingView` with `behavior={Platform.OS === 'ios' ? 'padding' : undefined}` and `keyboardVerticalOffset={72}`.
- Inside it, wrap `View style={styles.dock}` with:

```tsx
const keyboard = useAnimatedKeyboard({
  isStatusBarTranslucentAndroid: true,
  isNavigationBarTranslucentAndroid: true,
});
const insets = useSafeAreaInsets();
const liftStyle = useAnimatedStyle(() => ({
  paddingBottom:
    Platform.OS === 'android'
      ? composerKeyboardLift(keyboard.height.value, insets.bottom)
      : 0,
}));

return (
  <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={72}>
    <Animated.View style={liftStyle}>
      <View style={styles.dock}>{/* existing dock */}</View>
    </Animated.View>
  </KeyboardAvoidingView>
);
```

Do not set Android KAV `behavior` to `'padding'` or `'height'`.

- [ ] **Step 4: Same lift on the terminal shell input**

Replace the terminal `KeyboardAvoidingView` (~287) with the same pattern: iOS padding KAV, inner `Animated.View` using `composerKeyboardLift` on Android only. Extracting a tiny `KeyboardLift` component is allowed if it avoids duplicating the hook block; keep it in `src/components/ui/` only if both call sites would otherwise copy >15 lines. Prefer a local `ComposerKeyboardLift` in `src/components/layout/` only if you extract — do not put hooks in `src/lib/`.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/chat-composer.tsx src/components/terminal/terminal-screen.tsx
git commit -m "$(cat <<'EOF'
fix(app): pad Android composers with Reanimated IME height

The Galaxy A54 keyboard covered the chat input because Android KAV
behavior was undefined and edge-to-edge does not resize the window.
EOF
)"
```

---

### Task 3: Status bar — include the top safe edge

**Files:**
- Modify: `src/app/(tabs)/index.tsx` (~51)
- Modify: `src/app/(tabs)/activity.tsx` (~72)
- Modify: `src/components/chat/chat-screen.tsx` (~291, connected branch only)
- Modify: `src/components/terminal/terminal-screen.tsx` (~221, connected branch only)
- Modify: `src/app/dev/preview.tsx` (~54)

**Interfaces:**
- Consumes: `Screen` default `edges = ['top', 'bottom']` in `src/components/ui/Screen.tsx`
- Produces: connected tab chrome sits below the status bar; `AmbientCanvas` still full-bleed

Empty/disconnected chat and terminal already use `<Screen>` with default edges. Do not add `paddingTop: insets.top` to `ChatHeader` / `ScreenHeader` — that would double-pad once the Screen edge is restored.

- [ ] **Step 1: No unit-test seam — assert the default in Screen if missing**

`Screen.tsx` already defaults `edges = ['top', 'bottom']`. Do not change `Screen.tsx`.

- [ ] **Step 2: Remove the override**

Replace every connected-surface:

```tsx
<Screen edges={['bottom']} parallaxY={parallaxY}>
```

with:

```tsx
<Screen parallaxY={parallaxY}>
```

Preview has no parallax:

```tsx
<Screen>
```

Leave disconnected chat/terminal `<Screen>` as they are.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`

Expected: PASS. `grep` the tree for `edges={['bottom']}` — zero hits.

- [ ] **Step 4: Commit**

```bash
git add src/app/(tabs)/index.tsx src/app/(tabs)/activity.tsx src/components/chat/chat-screen.tsx src/components/terminal/terminal-screen.tsx src/app/dev/preview.tsx
git commit -m "$(cat <<'EOF'
fix(app): include the top safe edge on connected tab screens

edges={['bottom']} skipped the status-bar inset, so headers sat under
the Galaxy A54 notification shade on Expo 57 edge-to-edge Android.
EOF
)"
```

---

### Task 4: Numeric bubble max width

**Files:**
- Create: `src/lib/motion/bubble-width.ts`
- Test: `__tests__/bubble-width-test.ts`
- Modify: `src/components/chat/message-bubble.tsx`

**Interfaces:**
- Consumes: window width from `useWindowDimensions`
- Produces: `bubbleMaxWidth(windowWidth: number, hasMonogram: boolean): number`

`maxWidth: '85%'` on `bubblePress` is a percentage of `bubbleColumn`, which is shrink-to-fit (`flexShrink: 1`, `minWidth: 0`, no width). Yoga resolves that cyclic percentage to a sliver (~10 characters) on first layout of a new session.

The row must stretch to the list width. `bubbleColumn` gets a numeric `maxWidth`. Monogram (26) + row gap (`Spacing.two` = 8) is subtracted for assistant bubbles.

- [ ] **Step 1: Write the failing tests**

```ts
import { Spacing } from '@/constants/tokens';
import { bubbleMaxWidth } from '@/lib/motion/bubble-width';

test('user bubbles cap at 85% of the window', () => {
  expect(bubbleMaxWidth(400, false)).toBe(Math.round(400 * 0.85));
});

test('assistant bubbles leave room for the monogram and row gap', () => {
  expect(bubbleMaxWidth(400, true)).toBe(Math.round(400 * 0.85) - (26 + Spacing.two));
});

test('tiny widths still leave a readable column', () => {
  expect(bubbleMaxWidth(80, true)).toBeGreaterThanOrEqual(120);
});

test('non-finite widths fall back to 120', () => {
  expect(bubbleMaxWidth(Number.NaN, false)).toBe(120);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/bubble-width-test.ts --runInBand`

Expected: FAIL — module missing

- [ ] **Step 3: Write minimal implementation**

```ts
import { Spacing } from '@/constants/tokens';

const MONOGRAM = 26;
const MIN_BUBBLE = 120;

export function bubbleMaxWidth(windowWidth: number, hasMonogram: boolean): number {
  if (!Number.isFinite(windowWidth) || windowWidth <= 0) return MIN_BUBBLE;
  const cap = Math.round(windowWidth * 0.85);
  const gutter = hasMonogram ? MONOGRAM + Spacing.two : 0;
  return Math.max(MIN_BUBBLE, cap - gutter);
}
```

- [ ] **Step 4: Run tests**

Run: `npx jest __tests__/bubble-width-test.ts --runInBand`

Expected: PASS

- [ ] **Step 5: Apply in MessageBubble**

```tsx
import { useWindowDimensions } from 'react-native';
import { bubbleMaxWidth } from '@/lib/motion/bubble-width';

const { width: windowWidth } = useWindowDimensions();
const hasMonogram = !isUser && !!identity;
const columnMaxWidth = bubbleMaxWidth(windowWidth, hasMonogram);
```

Style changes in `message-bubble.tsx`:

```ts
row: {
  flexDirection: 'row',
  alignItems: 'flex-end',
  alignSelf: 'stretch',
  width: '100%',
  gap: Spacing.two,
},
bubbleColumn: {
  flexShrink: 1,
  minWidth: 0,
  gap: Spacing.half,
},
bubblePress: {
  // no maxWidth — the column owns the cap
},
```

Pass `style={[styles.bubbleColumn, isUser ? styles.bubbleColumnUser : styles.bubbleColumnAssistant, { maxWidth: columnMaxWidth }]}`.

- [ ] **Step 6: Typecheck + tests**

Run: `npx jest __tests__/bubble-width-test.ts --runInBand ; npx tsc --noEmit`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/motion/bubble-width.ts __tests__/bubble-width-test.ts src/components/chat/message-bubble.tsx
git commit -m "$(cat <<'EOF'
fix(app): cap chat bubbles with a numeric max width

Percent maxWidth on a shrink-to-fit column collapsed new-session
bubbles to ~10 characters until a reload remeasured the parent.
EOF
)"
```

---

### Task 5: Unique history ids and stop clipping the stream

**Files:**
- Modify: `src/lib/gateway/messages.ts` (`historyToChatMessages`)
- Modify: `__tests__/messages-test.ts`
- Modify: `src/components/chat/chat-screen.tsx` (`removeClippedSubviews` on the messages `FlatList`)

**Interfaces:**
- Consumes: `createMessageId` already in `messages.ts`
- Produces: history rows never share `` `${role}-${timestamp}` ``; streaming FlatList does not clip cells whose height changes every token

- [ ] **Step 1: Write the failing tests**

Add to `__tests__/messages-test.ts`:

```ts
test('two history turns with the same timestamp still get unique ids', () => {
  const messages = historyToChatMessages([
    { role: 'user', content: 'a', timestamp: 1 },
    { role: 'assistant', content: 'b', timestamp: 1 },
    { role: 'user', content: 'c', timestamp: 1 },
  ]);
  const ids = messages.map((message) => message.id);
  expect(new Set(ids).size).toBe(3);
  expect(ids.some((id) => id === 'user-1' || id === 'assistant-1')).toBe(false);
});

test('preserves an explicit OpenClaw id', () => {
  const messages = historyToChatMessages([
    { role: 'user', content: 'a', timestamp: 1, __openclaw: { id: 'oc-99' } },
  ]);
  expect(messages[0].id).toBe('oc-99');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/messages-test.ts --runInBand`

Expected: FAIL — both same-timestamp messages id `user-1` / `assistant-1`

- [ ] **Step 3: Fix `historyToChatMessages`**

Replace the id assignment:

```ts
const explicitId =
  typeof message.__openclaw?.id === 'string' && message.__openclaw.id
    ? message.__openclaw.id
    : typeof (message as { id?: unknown }).id === 'string' && (message as { id: string }).id
      ? (message as { id: string }).id
      : undefined;
const id = explicitId ?? createMessageId(role);
```

Do not use `` `${role}-${message.timestamp ?? result.length}` ``.

- [ ] **Step 4: Run tests**

Run: `npx jest __tests__/messages-test.ts --runInBand`

Expected: PASS

- [ ] **Step 5: Remove `removeClippedSubviews` from the chat FlatList**

In `chat-screen.tsx` around line 398, delete the `removeClippedSubviews` prop (bare boolean). Do not set it to `false` unless a later platform requires the explicit disable — omitting it uses RN's safer default for a variable-height streaming list.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/gateway/messages.ts __tests__/messages-test.ts src/components/chat/chat-screen.tsx
git commit -m "$(cat <<'EOF'
fix(app): unique history ids and stop clipping streaming rows

Same-timestamp fallback ids collided under fast turns, and
removeClippedSubviews mis-measured cells whose height grew every token.
EOF
)"
```

---

### Task 6: Surface the Hermes body on gate 500s

**Files:**
- Create: `src/lib/gateway/http-error-body.ts`
- Modify: `src/lib/gateway/http-transport.ts`
- Modify: `src/lib/gateway/environment-client.ts` (`ensureOk`)
- Modify: `__tests__/http-transport-test.ts`

**Interfaces:**
- Consumes: raw HTTP error text + status
- Produces: `messageFromHttpErrorBody(errorText: string, status: number): string`

Gate 500 JSON is `{ error: 'Internal Server Error', message: 'hermes: …' }`. Today transport uses `parsed?.error?.message || parsed?.error`, so a string `error` wins and the Hermes body is dropped. Prefer a string `message` field first. Keep `{ error: { message } }` working for 401s.

- [ ] **Step 1: Write the failing tests**

Add to `__tests__/http-transport-test.ts` (import the helper):

```ts
import { messageFromHttpErrorBody } from '@/lib/gateway/http-error-body';

test('prefers JSON message when error is the generic HTTP phrase', () => {
  expect(
    messageFromHttpErrorBody(
      JSON.stringify({
        error: 'Internal Server Error',
        message: 'hermes: An internal server error has occurred',
      }),
      500,
    ),
  ).toBe('hermes: An internal server error has occurred');
});

test('still reads nested error.message', () => {
  expect(
    messageFromHttpErrorBody(JSON.stringify({ error: { message: 'Invalid API key' } }), 401),
  ).toBe('Invalid API key');
});

test('falls back to a string error when message is absent', () => {
  expect(messageFromHttpErrorBody(JSON.stringify({ error: 'nope' }), 404)).toBe('nope');
});

test('non-JSON bodies stay as text', () => {
  expect(messageFromHttpErrorBody('An internal server error has occurred', 500)).toBe(
    'An internal server error has occurred',
  );
});
```

Also add an `HttpTransport` case: mock fetch 500 with `{ error: 'Internal Server Error', message: 'hermes: boom' }` and `expect(request).rejects.toMatchObject({ message: 'hermes: boom', status: 500 })`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/http-transport-test.ts --runInBand`

Expected: FAIL — helper missing; existing 401 test still passes

- [ ] **Step 3: Implement the helper**

```ts
export function messageFromHttpErrorBody(errorText: string, status: number): string {
  const fallback = errorText || `HTTP ${status}`;
  try {
    const parsed = JSON.parse(errorText) as { message?: unknown; error?: unknown };
    if (typeof parsed?.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
    const nested = parsed?.error as { message?: unknown } | string | undefined;
    if (nested && typeof nested === 'object' && typeof nested.message === 'string' && nested.message.trim()) {
      return nested.message.trim();
    }
    if (typeof parsed?.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }
  } catch {
    // not JSON
  }
  return fallback;
}
```

In `http-transport.ts` `request()`, replace the parse block with:

```ts
message = messageFromHttpErrorBody(errorText, response.status);
```

In `environment-client.ts` `ensureOk`, same call (pass `response.status`).

- [ ] **Step 4: Run tests**

Run: `npx jest __tests__/http-transport-test.ts --runInBand`

Expected: PASS (including the original 401/404 cases)

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/http-error-body.ts src/lib/gateway/http-transport.ts src/lib/gateway/environment-client.ts __tests__/http-transport-test.ts
git commit -m "$(cat <<'EOF'
fix(app): prefer JSON message over a string error field

Gate 500s are { error: 'Internal Server Error', message: 'hermes: …' }.
Reading error first hid the Hermes body on the Chat tab.
EOF
)"
```

---

### Task 7: Live tool-call stream parser

**Files:**
- Create: `src/lib/gateway/chat-stream-delta.ts`
- Test: `__tests__/chat-stream-delta-test.ts` (new) **and** extend `__tests__/manifest-client-test.ts`
- Modify: `src/lib/gateway/client.ts` (`streamChat`)
- Modify: `src/lib/gateway/manifest-client.ts` (`streamChat`)

**Interfaces:**
- Consumes: one parsed SSE JSON object + accumulator maps
- Produces:
  - `createChatStreamAcc(): { toolNames: Map<number, string>; toolArgs: Map<number, string> }`
  - `interpretChatStreamChunk(chunk: unknown, acc): { text?: string; toolCalls: ChatToolCall[]; streamError?: string }`

Today both clients only fire `onToolCall` when a delta has `function.name`. Argument-only fragments and `name` at the top of the tool object are ignored. History reload still shows cards via `extractToolCalls` — that is the “cards appear after refresh” bug.

- [ ] **Step 1: Write the failing tests**

```ts
import { createChatStreamAcc, interpretChatStreamChunk } from '@/lib/gateway/chat-stream-delta';

test('accumulates a split OpenAI tool name then arguments', () => {
  const acc = createChatStreamAcc();
  const first = interpretChatStreamChunk(
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'web_' } }] } }] },
    acc,
  );
  const second = interpretChatStreamChunk(
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'search', arguments: '{"q"' } }] } }] },
    acc,
  );
  const third = interpretChatStreamChunk(
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }] } }] },
    acc,
  );
  expect(first.toolCalls[0]).toEqual({ name: 'web_', status: 'running', detail: undefined });
  expect(second.toolCalls[0]).toEqual({ name: 'web_search', status: 'running', detail: '{"q"' });
  expect(third.toolCalls[0]).toEqual({
    name: 'web_search',
    status: 'running',
    detail: '{"q":"x"}',
  });
});

test('accepts a top-level name on the tool object', () => {
  const acc = createChatStreamAcc();
  const result = interpretChatStreamChunk(
    { choices: [{ delta: { tool_calls: [{ index: 0, name: 'read_file' }] } }] },
    acc,
  );
  expect(result.toolCalls[0].name).toBe('read_file');
});

test('forwards text deltas and error frames', () => {
  const acc = createChatStreamAcc();
  expect(
    interpretChatStreamChunk({ choices: [{ delta: { content: 'Hi' } }] }, acc).text,
  ).toBe('Hi');
  expect(
    interpretChatStreamChunk(
      { error: { message: 'opencode: Insufficient balance.', code: 'backend_error' } },
      acc,
    ).streamError,
  ).toMatch(/Insufficient balance/);
});

test('argument-only fragment with no name yet emits nothing', () => {
  const acc = createChatStreamAcc();
  const result = interpretChatStreamChunk(
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{' } }] } }] },
    acc,
  );
  expect(result.toolCalls).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/chat-stream-delta-test.ts --runInBand`

Expected: FAIL — module missing

- [ ] **Step 3: Implement `interpretChatStreamChunk`**

Keep it in `src/lib/gateway/chat-stream-delta.ts`. Use `ChatToolCall` from `./types`. Do not import React. Mirror error-frame copy already used in `manifest-client.ts` (`The gateway reported a failed turn (${code})` when message is absent).

Then replace the duplicated parse loop in both `streamChat` methods with:

```ts
const acc = createChatStreamAcc();
await this.transport.streamSSE(response, (data) => {
  try {
    const chunk = JSON.parse(data);
    const interpreted = interpretChatStreamChunk(chunk, acc);
    if (interpreted.streamError) {
      streamError = interpreted.streamError;
      return;
    }
    if (interpreted.text) {
      fullText += interpreted.text;
      onDelta(interpreted.text);
    }
    if (options?.onToolCall) {
      for (const tool of interpreted.toolCalls) options.onToolCall(tool);
    }
  } catch {
    // ignore malformed chunks
  }
}, signal);
```

- [ ] **Step 4: Integration lock on ManifestClient**

In `__tests__/manifest-client-test.ts` add a test that a stream of `tool_calls` name then arguments invokes `onToolCall` with the assembled name (same SSE `ReadableStream` pattern as the existing content test).

- [ ] **Step 5: Run tests**

Run: `npx jest __tests__/chat-stream-delta-test.ts __tests__/manifest-client-test.ts --runInBand`

Expected: PASS. Existing content + error-frame tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/gateway/chat-stream-delta.ts src/lib/gateway/client.ts src/lib/gateway/manifest-client.ts __tests__/chat-stream-delta-test.ts __tests__/manifest-client-test.ts
git commit -m "$(cat <<'EOF'
fix(app): assemble live tool-call cards from streamed fragments

Cards only appeared after refresh because the SSE parser ignored
argument-only deltas and any tool object that set name outside function.
EOF
)"
```

---

### Task 8: Bot open — do not swallow failures, paint the surface immediately

**Files:**
- Modify: `src/lib/gateway/bots.ts`
- Modify: `__tests__/bots-roster-test.ts`
- Modify: `src/context/gateway-provider.tsx` (`openBot`)
- Modify: `src/components/chat/chat-screen.tsx` (`onSelectBot`)

**Interfaces:**
- Consumes: `ensureBotChat`
- Produces: `loadBotChat(list, create): Promise<T>` — **no** catch around `list`

`openBot` currently `getSessions(200).catch(() => [])`, so a Hermes 500 looks like “no sessions” and then `createSession` 500s too. The roster also waits for `openBot` before `setSurface`, which is the 10–15s blank.

- [ ] **Step 1: Write the failing tests**

Add to `__tests__/bots-roster-test.ts`:

```ts
import { BOT_CHAT_TITLE, loadBotChat } from '@/lib/gateway/bots';

test('loadBotChat does not swallow a list failure', async () => {
  await expect(
    loadBotChat(
      async () => {
        throw new Error('hermes: An internal server error has occurred');
      },
      async (title) => ({ id: 'new', title }),
    ),
  ).rejects.toThrow(/internal server error/i);
});

test('loadBotChat reuses Bot Chat when list succeeds', async () => {
  const created: string[] = [];
  const session = await loadBotChat(
    async () => [{ id: 's2', title: BOT_CHAT_TITLE }],
    async (title) => {
      created.push(title);
      return { id: 'new', title };
    },
  );
  expect(session.id).toBe('s2');
  expect(created).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/bots-roster-test.ts --runInBand`

Expected: FAIL — `loadBotChat` is not exported

- [ ] **Step 3: Implement `loadBotChat`**

In `bots.ts`:

```ts
export async function loadBotChat<T extends { title?: string | null }>(
  list: () => Promise<T[]>,
  create: (title: string) => Promise<T>,
): Promise<T> {
  const sessions = await list();
  return ensureBotChat(sessions, create);
}
```

No `.catch`. No default `[]`.

- [ ] **Step 4: Run tests**

Run: `npx jest __tests__/bots-roster-test.ts --runInBand`

Expected: PASS

- [ ] **Step 5: Use it in `openBot`**

Replace `getSessions(200).catch(() => [])` + `ensureBotChat` with one `loadBotChat` call. Do not list sessions twice on the open path.

```ts
const chat = await loadBotChat(
  () => client.getSessions(200),
  (title) => client.createSession!(title),
);
sessionIdRef.current = chat.id;
client.setSessionId(chat.id);
setCurrentSessionId(chat.id);
setSessionList((prev) => (prev.some((session) => session.id === chat.id) ? prev : [chat, ...prev]));
if (activeGateway) void reloadHistoryFor(activeGateway);
```

Keep the existing `catch` that clears `botId` and sets `lastError`, then rethrows. After success, a non-blocking `client.getSessions(200).then(setSessionList)` is optional and must not gate the surface.

- [ ] **Step 6: Optimistic surface on the roster tap**

In `chat-screen.tsx` `onSelectBot`:

```tsx
onSelectBot={(bot) => {
  setSurface({ kind: 'bot', botId: bot.id });
  void openBot(bot.id).catch(() => {
    setSurface({ kind: 'roster' });
  });
}}
```

`historyLoading` already drives `ChatSkeleton`. Do not add a new spinner. Failed open returns to the roster; `lastError` from `openBot` already renders `ErrorCard`.

- [ ] **Step 7: Tests + typecheck**

Run: `npx jest __tests__/bots-roster-test.ts --runInBand ; npx tsc --noEmit`

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/lib/gateway/bots.ts __tests__/bots-roster-test.ts src/context/gateway-provider.tsx src/components/chat/chat-screen.tsx
git commit -m "$(cat <<'EOF'
fix(app): fail bot open on list errors and show the surface immediately

Swallowing getSessions turned a Hermes 500 into a second createSession,
and the roster waited on both hops before painting Bot Chat.
EOF
)"
```

---

### Task 9: Verify the squash

**Files:** none new

- [ ] **Step 1: Full app + gate verify**

Run: `npm run verify`

Expected: `tsc`, lint, jest coverage + ratchet, gate tests all pass.

- [ ] **Step 2: Device pass (required to close UI tasks)**

On the Galaxy A54 debug build (or a fresh install — OTA updates are disabled):

1. Open Chat. Header and home chrome sit below the status bar / clock.
2. Focus the composer. The input and send control sit fully above the IME; typed text is visible.
3. New Bot Chat: user and assistant bubbles wrap at ~85% width, not ~10 characters. Reload does not change width.
4. A long / fast stream does not overlap or clip bubbles.
5. Mid-turn tool use shows `ToolCallCard`s before refresh.
6. A broken bot still shows the Hermes/gate message, not a silent stall. A healthy bot shows Bot Chat without waiting for history.

If (5) still only appears after refresh, capture one SSE log from `/v1/chat/completions` — that is the Hermes-endpoint follow-up, **not** in this plan.

- [ ] **Step 3: No extra commit unless verify forced a ratchet update**

If `coverage-ratchet` writes `coverage-baseline.json`, commit that with `chore: ratchet coverage after chat squash helpers`.

---

## Self-review

**Spec coverage (approved design → task):**

| Design item | Task |
|---|---|
| Reanimated IME pad, minus bottom inset | 1, 2 |
| Terminal composer same treatment | 2 |
| Default Screen top+bottom edges, canvas full-bleed | 3 |
| Numeric 85% bubble width | 4 |
| Unique history ids | 5 |
| Disable streaming `removeClippedSubviews` | 5 |
| Prefer JSON `message` on 500 | 6 |
| Live tool-call fragment parser | 7 |
| No Hermes endpoint swap | (non-goal, Task 7 keeps completions) |
| Don't swallow `getSessions`; optimistic Bot surface | 8 |
| Device verification | 9 |

**Placeholder scan:** none. **Type consistency:** `composerKeyboardLift`, `bubbleMaxWidth`, `messageFromHttpErrorBody`, `interpretChatStreamChunk`, `loadBotChat` names match across tasks.
