import {
  nextSessionListLimit,
  SESSION_LIST_MAX,
  SESSION_LIST_PAGE_SIZE,
  sessionListMayHaveOlder,
} from '@/lib/gateway/session-list';

test('the first selector read asks for one page', () => {
  expect(SESSION_LIST_PAGE_SIZE).toBe(20);
});

test('show-older widens the window by one page', () => {
  expect(nextSessionListLimit(20)).toBe(40);
  expect(nextSessionListLimit(40)).toBe(60);
});

test('show-older never asks past the catalogue cap', () => {
  expect(SESSION_LIST_MAX).toBe(200);
  expect(nextSessionListLimit(200)).toBe(200);
  expect(nextSessionListLimit(190)).toBe(200);
  expect(nextSessionListLimit(1000)).toBe(200);
});

test('a nonsense limit restarts at one page instead of asking for nothing', () => {
  expect(nextSessionListLimit(0)).toBe(SESSION_LIST_PAGE_SIZE);
  expect(nextSessionListLimit(-5)).toBe(SESSION_LIST_PAGE_SIZE);
});

test('a full window may hide older threads', () => {
  expect(sessionListMayHaveOlder(20, 20)).toBe(true);
  expect(sessionListMayHaveOlder(40, 40)).toBe(true);
});

test('a short window means the catalogue is fully shown', () => {
  expect(sessionListMayHaveOlder(7, 20)).toBe(false);
  expect(sessionListMayHaveOlder(0, 20)).toBe(false);
  expect(sessionListMayHaveOlder(199, 200)).toBe(false);
});

test('at the cap there is nothing older left to ask for', () => {
  expect(sessionListMayHaveOlder(200, 200)).toBe(false);
  expect(sessionListMayHaveOlder(200, 1000)).toBe(false);
});
