# Versutus UI Polish Loop Plan

**Objective**: Iteratively polish the UI to fully embody the luxury mobile design system (deep black surfaces, champagne gold accents, restrained glass, compact layouts, precise interactions).

**Design System Reference** (from Luxury Mobile UI Rules):
- Deep black surfaces (#030304, #0A0908, #070607), champagne gold accents (#D6B76A, #F0D690), warm secondary text.
- Restrained glass with subtle borders/highlights.
- Prefer: compact rows, bottom sheets, segmented controls, command cards, dense status pills.
- Home: state-first.
- Chat: action-first.
- Use haptics for: connect, command complete, confirmation, denial, destructive warnings.
- Exact verbs: “Approve device,” “Stop channel,” “Apply model,” “Restore session.”
- Error cards: include cause, affected target, next action.
- Platform parity with native fallbacks where needed.
- Animations via reanimated with Motion tokens.
- Consistent padding, radius, typography from tokens.

**Loop Structure**: 3 full iterations. Each loop is a complete pass (audit → implement → validate). Loops increase in depth:
- **Loop 1**: Foundation & consistency (structural).
- **Loop 2**: Interactions & experience (behavioral).
- **Loop 3**: Final refinement & parity (polish + edge cases).

After each loop:
- Run `npx tsc --noEmit`
- Manual review in chat, home, gateway screens.
- Check haptics, sheets, cards on Android focus.
- Update this plan with findings.

**Key Areas to Polish** (applies to all loops, prioritized per loop):
- Sheets: Confirmation, ModelPicker, SessionSelector, Pairing, CommandLog, ModePicker.
- Command surfaces: MessageBubble (command cards), ChatComposer, slash suggestions.
- Home/Dashboard: GatewayCapabilities, HomeStatusCard, repair cards.
- Gateway components: CompactGatewayList, etc.
- Shared: ui/ primitives, GlassSurface, PressableScale, error/empty states.
- Global: Haptics, exact verbs, error formatting, compact density, animations, Android specifics.

---

## LOOP 1: Foundation (Structural Consistency)

**Goals**:
- Extract reusable BaseSheet component to eliminate duplication.
- Standardize all sheets to luxury rules (headers, padding, colors, GlassSurface variant="hero").
- Basic haptics on key actions.
- Ensure error cards have cause/target/next action.
- Fix obvious inconsistencies (spacing, borders, typography).

**Tasks**:
1. Audit all sheets and cards (read files, note dupe styles).
2. Create `src/components/ui/BaseSheet.tsx` (or in chat/ if scoped) with:
   - Animated slide (translateY from bottom or top as appropriate).
   - GlassSurface wrapper.
   - Standard header (eyebrow + close).
   - Props for title, onClose, children.
3. Refactor all sheets to use BaseSheet.
4. Apply consistent styles:
   - Use tokens.Spacing, Radius, Palette.
   - Header: mono eyebrow in accentWarm, flex row justify-between.
   - Content padding: Spacing.three.
   - Risk/danger badges using accentWarm or status colors.
5. Add basic haptics (import * as Haptics from 'expo-haptics'):
   - On open/close for sheets.
   - On button presses for primary actions.
6. Update error/empty states (MessageBubble, ChatEmptyState, etc.):
   - Ensure format includes cause, target, next action.
7. Validate: tsc, quick manual check of sheets in chat.

**Deliverables**:
- BaseSheet extracted.
- All sheets use it + luxury tokens.
- Haptics on main interactions.
- No duplicate sheet styles.

**Validation**:
- Run tsc.
- Open /chat, trigger model picker, confirmation, session selector.
- Check Home for capability chips.

---

## LOOP 2: Interactions (Behavioral Polish)

**Goals**:
- Full haptics integration (per rules).
- Animations and motion consistency.
- Compact layouts, better density.
- Exact verbs everywhere.
- Improve command cards and composer.
- Cross-sheet consistency (e.g., all use same close behavior, risk presentation).

**Tasks**:
1. Audit interactions: where is haptics missing? (buttons in sheets, composer send, command taps).
2. Add haptics:
   - impactAsync(Light) for taps.
   - notificationAsync for success/error/confirm.
   - On dangerous confirm/deny.
3. Enhance animations:
   - Consistent use of Motion tokens.
   - Add spring or better easing where needed.
   - Fade/slide for list items in pickers/selectors.
4. Compact & density:
   - Reduce padding in cards/pills where appropriate.
   - Use dense status pills.
   - Segmented controls if missing (e.g., in pickers).
5. Exact verbs:
   - Scan all labels: change "Close" → context specific if needed, "Confirm" → "Apply model", etc.
   - Update in sheets, buttons, errors.
6. Polish command surfaces:
   - MessageBubble command cards: better status, duration display, retry/cancel buttons with haptics.
   - Composer: improve suggestion palette density, add haptics on select.
7. Update Home/Dashboard cards for consistency with new sheets.
8. Add subtle feedback (e.g., loading in pickers).

**Deliverables**:
- Haptics on all major actions.
- Consistent motion.
- Verb-perfect UI text.
- Improved cards/pickers.

**Validation**:
- tsc.
- Full flow test: open chat → /model set (picker) → select → confirmation sheet → confirm.
- Test dangerous commands from palette.
- Check session switch and channel commands.
- Android emulator focus.

---

## LOOP 3: Final Pass (Refinement & Parity)

**Goals**:
- Android/iOS parity (use .android.tsx where needed).
- Edge cases & error handling.
- Performance (flatlists, animations).
- Full audit against luxury rules.
- Polish remaining surfaces (terminal, onboarding, gateway list).
- Documentation of final state.

**Tasks**:
1. Platform-specific:
   - Review sheets for bottom sheet behavior (Android may need different animation or modal).
   - Terminal mode picker, command chips.
   - Ensure GlassSurface fallbacks.
2. Edge cases:
   - Empty states in pickers/selectors.
   - Long content scrolling in sheets.
   - Error states in confirmation (e.g., preview fails).
   - No active gateway flows.
3. Performance:
   - Memoize lists in pickers.
   - Optimize re-renders in chat (FlatList keyExtractor, etc.).
4. Full audit:
   - Grep for hardcoded colors, old blues (#208AEF remnants?).
   - Check all text for exact verbs and clarity.
   - Error cards everywhere.
5. Remaining polish:
   - Gateway list, capabilities pills.
   - Composer actions.
   - Add subtle gradients or AmbientCanvas usage where fits.
6. Validation & sign-off:
   - Full tsc.
   - Build Android if possible.
   - Manual test all major flows.
   - Update plan with "completed" notes.

**Deliverables**:
- Platform parity.
- Robust edges.
- Complete luxury adherence.
- Clean, polished app.

**Validation**:
- tsc + lint if available.
- Comprehensive manual test.
- Perhaps generate preview screenshots.

---

## Execution Notes

- **Order**: Always start each loop with audit (use grep/read_file on key files).
- **Tools**: Use search_replace for edits. After each loop run validation.
- **Dependencies**: expo-haptics already in package.json.
- **Risks**: Avoid breaking functionality (especially command execution, confirmation flow). Test with --yolo or direct sends.
- **Tracking**: Use todo list for sub-tasks per loop.
- **3x Execution**: Run the full 3 loops sequentially. After Loop 3, the UI should feel premium and consistent.

**Success Criteria (after 3 loops)**:
- All sheets feel like one system.
- Haptics feel intentional and luxurious.
- Text is precise and on-brand.
- Layouts are compact yet readable.
- Errors guide the user.
- Android experience matches or gracefully differs from iOS.

Start with Loop 1 audit now.

## Execution Log

**Loop 1 - Foundation (Completed in this session)**
- Created this plan and todo tracking.
- Extracted `BaseSheet` (src/components/ui/BaseSheet.tsx) for all custom glass sheets. Supports position (top/bottom), closeLabel for exact verbs, consistent animation.
- Refactored sheets to use BaseSheet (eliminated massive dupe code for overlay/animation/surface):
  - ConfirmationSheet: haptics (impact + success), "Dismiss" verb.
  - ModelPickerSheet: haptics on model select, "Done" verb.
  - SessionSelectorSheet: haptics on select, "Done" verb.
  - PairingSheet: uses top position, "Dismiss", kept custom handle.
- Added haptics across:
  - All sheet actions and selects.
  - Composer: send/stop, refresh/reconnect, suggestion taps.
  - Message bubbles: retry/cancel.
- Standardized verbs with closeLabel prop.
- Enhanced error states per rules:
  - Chat empty state and lastError banner now use "Cause: ... Affected: ... Next: ..." format.
- All changes pass `npx tsc --noEmit`.
- Duplicated sheet styles greatly reduced.

Ready for Loop 2 when requested.

**Loop 2 - Interactions (Completed previously)**
- Full haptics on gateway dashboard, cards, pairing copy, composer palette.
- Verb refinements ("Reconnect gateway", "Retry connection", "Connect to gateway").
- Compact density + fadeIn animations on pickers/selectors.
- Confirmation uses success haptic + structured notes.
- BaseSheet + all sheets verified.
- tsc clean. Android focus.

**Loop 3 - Final Refinement & Parity (Completed)**
- Platform parity:
  - Added backdrop tap-to-close + haptic on BaseSheet for better Android/iOS sheet feel.
  - Polished TerminalModePicker (haptics in fallback), CommandChip (haptics), CommandLogSheet (haptics + "Dismiss" header, native bottom sheet kept for parity).
  - GlassSurface fallbacks verified across .android/.ios/.web.
- Edge cases:
  - Empty state in ModelPickerSheet ("No models...").
  - SessionSelector already had no-sessions fallback.
  - Structured error format applied to Terminal error banner.
  - No-gateway flows covered via ChatEmptyState + Home.
  - Long scroll handled in lists (FlatList + BottomSheetScrollView).
- Performance:
  - useCallback + renderItem extraction + removeClippedSubviews on model/session FlatLists.
  - Existing keyExtractors and chat FlatList preserved.
- Full audit:
  - No #208AEF or old blue remnants (fixed dev preview chip blue border, capabilities experimental color).
  - Verbs audited and improved: "Connect", "Remove", "Dismiss", "Retry terminal", etc.
  - Error cards: cause/target/next-action present in chat banners, empty states, terminal.
- Remaining polish:
  - Gateway list: "Connect"/"Reconnect", "Remove" verbs + warning haptic on delete.
  - GatewayCapabilities pills: uses tokens (no hardcodes).
  - Composer + dashboard actions already haptics + compact.
  - AmbientCanvas usage via Screen remains appropriate (no over-use).
- Validation:
  - `npx tsc --noEmit` clean (multiple runs).
  - All sheets, terminal, home, chat surfaces reviewed.
  - No new primary screens; action-first Chat / state-first Home preserved.
  - Luxury rules: deep black, champagne accents, compact, haptics, exact verbs followed.

All 3 loops complete. UI is polished, consistent, and ready.
