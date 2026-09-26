import type { PublicBot } from '@/lib/gateway/bots';
import type { BotGroupRoom, GroupTranscriptEntry } from '@/lib/gateway/groups';
import type { ActivityRun } from '@/lib/gateway/runs';
import type { ApprovalRow } from '@/lib/gateway/approvals';
import type { ChatMessage, GatewayProfile, HermesSession } from '@/lib/gateway/types';

/**
 * Fixed fleet for the showcase provider. Every surface a design pass needs to
 * judge has something honest to draw: routable and unroutable Bots, a group
 * room, a transcript with tools and reasoning, runs in every state, and a
 * pending approval. Times are relative to the moment the module loads so the
 * day dividers and "2m ago" labels read like a live fleet.
 */

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;

export const SHOWCASE_GATEWAY: GatewayProfile = {
  id: 'showcase-gate',
  name: 'Atlas',
  url: 'https://atlas.showcase.invalid',
  kind: 'hermes',
  model: 'anthropic/claude-sonnet-5',
  createdAt: NOW - 90 * 24 * HOUR,
};

export const SHOWCASE_BOTS: PublicBot[] = [
  {
    id: 'aria',
    displayName: 'Aria',
    routable: true,
    description: 'Chief of staff. Reads the whole fleet and briefs you on what changed.',
    model: { default: 'claude-opus-5-5', provider: null },
  },
  {
    id: 'forge',
    displayName: 'Forge',
    routable: true,
    description: 'Engineering. Ships fixes against your repositories with review gates.',
    model: { default: 'gpt-5.5-codex', provider: null },
  },
  {
    id: 'ledger',
    displayName: 'Ledger',
    routable: true,
    description: 'Finance. Watches spend, budgets and invoices across every provider.',
    model: { default: 'claude-sonnet-5', provider: null },
  },
  {
    id: 'sentinel',
    displayName: 'Sentinel',
    routable: true,
    description: 'Security and operations. Audits access and pages you when it matters.',
    model: { default: 'gemini-3-pro', provider: null },
  },
  {
    id: 'muse',
    displayName: 'Muse',
    routable: true,
    description: 'Research and writing. Drafts memos, decks and briefs in your voice.',
    model: { default: 'claude-opus-5-5', provider: null },
  },
  {
    id: 'scout',
    displayName: 'Scout',
    routable: false,
    routingIssue: 'listen_key_missing',
    description: 'Market intelligence. Not routed yet — needs a listen key.',
  },
];

export const SHOWCASE_GROUPS: BotGroupRoom[] = [
  { id: 'launch-council', name: 'Launch Council', memberIds: ['aria', 'forge', 'ledger'] },
];

export const SHOWCASE_GROUP_HISTORY: GroupTranscriptEntry[] = [
  { id: 'g1', role: 'user', text: 'Are we ready to ship 2.4 on Thursday?', at: NOW - 3 * HOUR },
  {
    id: 'g2',
    role: 'bot',
    botId: 'forge',
    text: 'Code is ready. Two review threads left, both cosmetic. CI is green on the release branch.',
    at: NOW - 3 * HOUR + 2 * MIN,
  },
  {
    id: 'g3',
    role: 'bot',
    botId: 'ledger',
    text: 'Launch spend is inside budget at 71%. The inference burst for the demo day is pre-approved.',
    at: NOW - 3 * HOUR + 3 * MIN,
  },
  {
    id: 'g4',
    role: 'bot',
    botId: 'aria',
    text: 'Thursday holds. I will send the go/no-go note at 9:00 with both summaries attached.',
    at: NOW - 3 * HOUR + 4 * MIN,
  },
];

const ARIA_BRIEF = `Here's what moved overnight across **Atlas**.

## Needs you
- **Forge** wants approval to merge the payments retry fix into \`release/2.4\`.
- **Ledger** flagged that inference spend ran **18% above** the weekly pace on Tuesday.

## Handled
- Sentinel rotated two stale API keys and closed the audit ticket.
- Muse finished the Q4 board memo draft — it's in your inbox for review.
- Nightly routines all completed: 14 runs, 0 failures.

> The payments fix is the only thing blocking Thursday's release.

Want me to open Forge's approval, or pull Ledger's spend breakdown first?`;

const FORGE_REPLY = `The retry storm comes from the webhook handler re-queuing on **every** 5xx, including the ones Stripe already marked as terminal.

\`\`\`ts
if (event.attempt >= MAX_ATTEMPTS || isTerminal(event.status)) {
  await deadLetter.put(event);
  return;
}
await queue.retry(event, backoff(event.attempt));
\`\`\`

I've opened the fix on \`fix/webhook-terminal-retries\` with a regression test. It needs your approval to merge.`;

function turn(
  id: string,
  role: ChatMessage['role'],
  text: string,
  minutesAgo: number,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { id, role, text, timestamp: NOW - minutesAgo * MIN, ...extra };
}

export const SHOWCASE_TRANSCRIPTS: Record<string, ChatMessage[]> = {
  aria: [
    turn('a0', 'user', 'Morning. What did I miss yesterday?', 26 * 60),
    turn(
      'a0r',
      'assistant',
      'A quiet day. Ledger closed September under budget and Forge merged the search latency fix. Nothing needs you.',
      26 * 60 - 1,
    ),
    turn('a1', 'user', 'Brief me on overnight activity across the fleet.', 6),
    turn('a2', 'assistant', ARIA_BRIEF, 5, {
      toolCalls: [
        { name: 'fleet.status', status: 'complete', durationMs: 640, detail: '6 Bots · 5 routable' },
        { name: 'cron.runs', status: 'complete', durationMs: 1210, detail: '14 runs since 18:00' },
        { name: 'approvals.pending', status: 'complete', durationMs: 180, detail: '1 pending' },
      ],
      reasoning:
        'Group by what needs the operator versus what was handled. Lead with the blocking approval, keep the handled list short.',
    }),
  ],
  forge: [
    turn('f1', 'user', 'Why are payment webhooks retrying so much?', 42),
    turn('f2', 'assistant', FORGE_REPLY, 40, {
      toolCalls: [
        { name: 'repo.search', status: 'complete', durationMs: 930, detail: 'webhooks/handler.ts' },
        { name: 'logs.query', status: 'complete', durationMs: 2140, detail: '3,412 retries in 24h' },
      ],
    }),
  ],
  ledger: [
    turn('l1', 'user', 'How are we tracking against this month’s budget?', 180),
    turn(
      'l2',
      'assistant',
      'You are at **$4,182** of **$6,500** with nine days left — 64% of budget at 70% of the month. On pace to land around **$5,900**.',
      178,
    ),
  ],
  chat: [],
};

export const SHOWCASE_REPLIES: Record<string, string> = {
  aria:
    "Done. I've opened Forge's approval for the payments fix and queued Ledger's spend breakdown for when you're back. Anything else before your 10:00?",
  forge:
    'Merged behind the review gate. CI is running on `release/2.4` now — I will ping you if anything goes red.',
  ledger:
    'Tuesday’s overage traces to a long-context research run on Muse: 41% of the day’s tokens. Want me to cap Muse at $40/day?',
  sentinel: 'All clear. No new access grants in the last 24 hours and every key is inside its rotation window.',
  muse: 'Here is a tighter opening for the memo: “We grew revenue 38% while holding burn flat — the plan works.”',
  chat: 'Happy to help. Ask about the fleet, spend, or anything your Bots are working on.',
};

function session(
  id: string,
  title: string,
  preview: string,
  minutesAgo: number,
  messages: number,
  cost: number,
): HermesSession {
  const at = (NOW - minutesAgo * MIN) / 1000;
  return {
    id,
    source: 'api',
    user_id: null,
    model: 'anthropic/claude-sonnet-5',
    title,
    started_at: at - 600,
    ended_at: null,
    end_reason: null,
    message_count: messages,
    tool_call_count: Math.round(messages / 3),
    input_tokens: messages * 2400,
    output_tokens: messages * 640,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    estimated_cost_usd: cost,
    actual_cost_usd: cost,
    api_call_count: messages,
    parent_session_id: null,
    last_active: at,
    preview,
    has_system_prompt: true,
    has_model_config: true,
  };
}

export const SHOWCASE_SESSIONS: HermesSession[] = [
  session('s-brief', 'Overnight fleet brief', 'Here’s what moved overnight across Atlas.', 5, 6, 0.42),
  session('s-webhooks', 'Payment webhook retries', 'The retry storm comes from the webhook handler…', 40, 12, 1.87),
  session('s-budget', 'September budget check', 'You are at $4,182 of $6,500 with nine days left.', 178, 4, 0.18),
  session('s-memo', 'Q4 board memo', 'Draft two tightens the opening and moves the ask up.', 26 * 60, 22, 3.05),
  session('s-keys', 'Key rotation audit', 'Two stale keys rotated, audit ticket closed.', 2 * 24 * 60, 8, 0.64),
  session('s-hiring', 'Hiring plan for platform team', 'Three roles, staggered across Q4 and Q1.', 4 * 24 * 60, 15, 1.12),
];

export const SHOWCASE_RUNS: ActivityRun[] = [
  {
    id: 'run-merge',
    prompt: 'Merge fix/webhook-terminal-retries into release/2.4',
    status: 'waiting-approval',
    startedAt: NOW - 38 * MIN,
    events: [
      { type: 'tool', preview: 'git.diff · 3 files, +42 −9', timestamp: NOW - 38 * MIN },
      { type: 'tool', preview: 'ci.run · 212 tests passed', timestamp: NOW - 36 * MIN },
      { type: 'approval', preview: 'Waiting for your approval to merge', timestamp: NOW - 35 * MIN },
    ],
    botId: 'forge',
    gatewayId: SHOWCASE_GATEWAY.id,
  },
  {
    id: 'run-spend',
    prompt: 'Build the weekly spend breakdown by provider',
    status: 'running',
    startedAt: NOW - 3 * MIN,
    events: [{ type: 'tool', preview: 'spend.query · 7 providers', timestamp: NOW - 2 * MIN }],
    botId: 'ledger',
    gatewayId: SHOWCASE_GATEWAY.id,
  },
  {
    id: 'run-keys',
    prompt: 'Rotate API keys older than 90 days',
    status: 'complete',
    startedAt: NOW - 9 * HOUR,
    finishedAt: NOW - 9 * HOUR + 4 * MIN,
    summary: 'Rotated 2 keys and closed SEC-214.',
    events: [],
    botId: 'sentinel',
    gatewayId: SHOWCASE_GATEWAY.id,
  },
  {
    id: 'run-memo',
    prompt: 'Draft the Q4 board memo from the planning notes',
    status: 'complete',
    startedAt: NOW - 20 * HOUR,
    finishedAt: NOW - 19 * HOUR,
    summary: 'Draft two is in your inbox.',
    events: [],
    botId: 'muse',
    gatewayId: SHOWCASE_GATEWAY.id,
  },
  {
    id: 'run-scrape',
    prompt: 'Refresh competitor pricing pages',
    status: 'failed',
    startedAt: NOW - 30 * HOUR,
    finishedAt: NOW - 30 * HOUR + 2 * MIN,
    summary: 'Scout has no listen key, so the run could not be routed.',
    events: [],
    botId: 'scout',
    gatewayId: SHOWCASE_GATEWAY.id,
  },
];

export const SHOWCASE_APPROVALS: ApprovalRow[] = [
  {
    approvalId: 'appr-merge',
    cls: 'workspace_write',
    runId: 'run-merge',
    botId: 'forge',
    operation: 'git.merge',
    summary: 'Merge fix/webhook-terminal-retries into release/2.4',
    createdAt: new Date(NOW - 35 * MIN).toISOString(),
  },
];

export const SHOWCASE_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'anthropic', providerId: 'anthropic' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'anthropic', providerId: 'anthropic' },
  { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai', providerId: 'openai' },
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro', provider: 'google', providerId: 'google' },
];
