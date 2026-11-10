import { expect, type Page } from '@playwright/test';

/**
 * The showcase reads relative times ("2m ago", the day dividers) and a greeting
 * that changes with the clock, so a screenshot only repeats if the clock does.
 * Fixed at a Tuesday evening, when the showcase fleet was written.
 *
 * The clock is *shifted*, not frozen: every read returns the epoch plus however
 * long the page has been open. A frozen `Date` looks harmless and is not — Expo
 * web's font loader never settles its faces under it, so `document.fonts.ready`
 * hangs and Playwright's screenshot assertion times out waiting for fonts that
 * were already on screen.
 */
export const SHOWCASE_EPOCH = new Date(2026, 10, 10, 19, 5, 0).getTime();

export async function openShowcase(page: Page, route: string): Promise<void> {
  await page.addInitScript(
    ({ epoch }) => {
      try {
        window.localStorage.setItem('versutus:showcase', '1');
      } catch {
        // storage denied: the live app renders instead and the first missing
        // element is the failure, which is the useful signal anyway
      }
      const RealDate = Date;
      const shift = epoch - RealDate.now();
      class ShiftedDate extends RealDate {
        constructor(...args: ConstructorParameters<typeof Date>) {
          // @ts-expect-error spreading a constructor tuple is fine here
          super(...(args.length === 0 ? [RealDate.now() + shift] : args));
        }
        static now(): number {
          return RealDate.now() + shift;
        }
      }
      window.Date = ShiftedDate as DateConstructor;
    },
    { epoch: SHOWCASE_EPOCH },
  );
  await page.goto(route, { waitUntil: 'commit', timeout: 180_000 });
  // The dev server server-renders some routes slowly (Settings can take a
  // minute on a loaded box before it answers), so the first paint is waited for
  // by content, not by a network milestone.
  await page.waitForFunction(() => document.body?.innerText.trim().length > 40, undefined, {
    timeout: 180_000,
  });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Wait for the showcase roster: the proof the demo provider is serving. */
export async function expectShowcaseRoster(page: Page): Promise<void> {
  await expect(page.getByText('Your team').first()).toBeVisible({ timeout: 120_000 });
}

/**
 * Open the drawer and go to a destination by its drawer label, the way a thumb
 * reaches it — not by URL. Tab screens mount on first visit, which is exactly
 * the moment the segmented pill used to slide in from the wrong segment.
 */
export async function openFromDrawer(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: label, exact: true }).first().click();
}

/**
 * Record the first rectangle the segmented pill ever has. A pill that animates
 * in from the first segment looks correct a second later, so the assertion has
 * to see frame zero: a MutationObserver catches the element the moment React
 * inserts it, before any transition can be sampled.
 */
export async function recordFirstPillFrame(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __firstPill: { x: number; width: number } | null }).__firstPill = null;
    const observer = new MutationObserver(() => {
      const pill = document.querySelector('[data-testid="segmented-indicator"]');
      if (!pill) return;
      const box = pill.getBoundingClientRect();
      (window as unknown as { __firstPill: { x: number; width: number } | null }).__firstPill = {
        x: box.x,
        width: box.width,
      };
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

export async function firstPillFrame(page: Page): Promise<{ x: number; width: number }> {
  await page.waitForFunction(
    () => (window as unknown as { __firstPill: unknown }).__firstPill !== null,
    undefined,
    { timeout: 20_000 },
  );
  return page.evaluate(
    () => (window as unknown as { __firstPill: { x: number; width: number } }).__firstPill,
  );
}

/** Assert two boxes share an edge within a couple of pixels. */
export function expectSameEdge(actual: number, expected: number, tolerance = 2): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}
