import { expect, test } from '@playwright/test';

import {
  expectSameEdge,
  expectShowcaseRoster,
  firstPillFrame,
  openShowcase,
  recordFirstPillFrame,
} from './showcase';

/**
 * The 390 px showcase suite (VS-082, spec §4).
 *
 * Every journey is both a screenshot baseline and a handful of structural
 * assertions, because a pixel baseline alone cannot say *what* changed: a pill
 * at the wrong x is a number, not a feeling.
 */

test.describe('showcase at 390 px', () => {
  test('roster', async ({ page }) => {
    await openShowcase(page, '/chat');
    await expectShowcaseRoster(page);

    // The showcase carries one Bot per runtime, so the backend chips exist.
    for (const label of ['Hermes', 'OpenCode', 'Claude Code', 'Codex']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
    }

    // The two header controls are one size: same box, same tap target. A gear
    // drawn at a different size from the menu is the kind of slop that reads as
    // "two different apps" (spec §4, fix 5).
    const menu = await page.getByRole('button', { name: 'Open navigation menu' }).boundingBox();
    const overflow = await page.getByRole('button', { name: 'Chat options' }).boundingBox();
    expect(menu).not.toBeNull();
    expect(overflow).not.toBeNull();
    expect(menu!.width).toBe(overflow!.width);
    expect(menu!.height).toBe(overflow!.height);
    expect(menu!.width).toBeGreaterThanOrEqual(40);

    await expect(page).toHaveScreenshot('roster.png');
  });

  test('settings: a switch reads as a control when it is off', async ({ page }) => {
    await openShowcase(page, '/chat');
    await expectShowcaseRoster(page);
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();

    // The showcase Gate is not synced, so the pref switch is drawn disabled —
    // the off track is what this screenshot is for (the token test pins the
    // 3:1 ratio for off, on and disabled alike).
    const toggle = page.getByRole('switch').first();
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await expect(page).toHaveScreenshot('settings-switch-off.png');
  });

  test('first run: onboarding', async ({ page }) => {
    await openShowcase(page, '/onboarding');
    await expect(page.getByText('Connect your PC').first()).toBeVisible();
    await expect(page).toHaveScreenshot('first-run.png');
  });

  test('tools: the pill is on the selected mode from its first frame', async ({ page }) => {
    await openShowcase(page, '/chat');
    await expectShowcaseRoster(page);

    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await recordFirstPillFrame(page);
    await page.getByRole('button', { name: 'Tools', exact: true }).first().click();

    // The screen opens on Commands (`terminal-screen.tsx:72` selects 'rpc').
    const first = await firstPillFrame(page);
    const rpc = await page.getByTestId('segment-rpc').boundingBox();
    expect(rpc).not.toBeNull();
    expectSameEdge(first.x, rpc!.x);

    await expect(page).toHaveScreenshot('tools-commands.png');
  });

  test('tools: a tap moves the one selection signal with its label', async ({ page }) => {
    await openShowcase(page, '/terminal');

    const pill = page.getByTestId('segmented-indicator');
    const shell = page.getByTestId('segment-shell');
    await expect(pill).toBeVisible();
    await shell.click();

    await expect
      .poll(async () => {
        const [p, s] = [await pill.boundingBox(), await shell.boundingBox()];
        return p && s ? Math.abs(p.x - s.x) : Number.POSITIVE_INFINITY;
      })
      .toBeLessThanOrEqual(2);
  });

  test('activity: the day ribbon carries its ticks', async ({ page }) => {
    await openShowcase(page, '/activity');

    // Five runs in the showcase, and the perspective scale's two ticks.
    await expect(page.getByText('6h', { exact: true })).toBeVisible();
    await expect(page.getByText('1h', { exact: true })).toBeVisible();

    await expect(page).toHaveScreenshot('activity.png');
  });

  test('bot chat: the header gains a surface once the thread scrolls under it', async ({ page }) => {
    await openShowcase(page, '/chat');
    await expectShowcaseRoster(page);

    await page.getByRole('button', { name: 'Aria, Chief of staff' }).click();
    await expect(page.getByText('Brief me on overnight activity across the fleet.').first()).toBeVisible();

    // A thread opens at its newest message, so "flat" is the top of the thread.
    const header = page.getByTestId('chat-header');
    await scrollThread(page, -1);
    await expect.poll(() => backgroundOf(header)).toBe('rgba(0, 0, 0, 0)');
    await expect(page).toHaveScreenshot('bot-chat-top.png');

    await scrollThread(page, 1);
    await expect.poll(() => backgroundOf(header)).not.toBe('rgba(0, 0, 0, 0)');
    await expect(page).toHaveScreenshot('bot-chat-scrolled.png');
  });
});

async function backgroundOf(locator: import('@playwright/test').Locator): Promise<string> {
  return locator.evaluate((node) => getComputedStyle(node as HTMLElement).backgroundColor);
}

async function scrollThread(page: import('@playwright/test').Page, direction: 1 | -1): Promise<void> {
  await page.mouse.move(195, 600);
  for (let i = 0; i < 10; i += 1) await page.mouse.wheel(0, direction * 500);
  await page.waitForTimeout(400);
}
