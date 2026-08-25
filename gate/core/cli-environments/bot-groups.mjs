import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export function groupSessionTitle(name) {
  return `Group: ${name}`;
}

export function validateGroup({ name, memberIds }) {
  if (!name || !String(name).trim()) return { ok: false, error: 'name required' };
  const unique = [...new Set(memberIds ?? [])];
  if (unique.length < 2) return { ok: false, error: 'need at least 2 bots' };
  if (unique.length > 6) return { ok: false, error: 'at most 6 bots' };
  return { ok: true, memberIds: unique, name: String(name).trim() };
}

export function planGroupRounds({ memberIds, mentionedIds = [], maxRounds = 3, maxMessages = 10 }) {
  const mentioned = mentionedIds.filter((id) => memberIds.includes(id));
  const active = mentioned.length > 0 ? mentioned : memberIds;
  const steps = [];
  for (let round = 0; round < maxRounds && steps.length < maxMessages; round += 1) {
    for (const botId of active) {
      if (steps.length >= maxMessages) break;
      steps.push({ botId });
    }
  }
  return steps;
}

/** Oldest entries beyond this are dropped — a transcript is recent truth, not an archive. */
export const MAX_GROUP_HISTORY = 200;

function makeEntryId() {
  return randomBytes(6).toString('hex');
}

/**
 * The transcript record of one room send: the operator's line followed by
 * each reply in arrival order. A silent round still keeps the user's line —
 * "nobody answered" is part of the room's history too.
 */
export function transcriptEntriesForSend({ text, replies = [], makeId = makeEntryId, now = Date.now() } = {}) {
  const entries = [{ id: makeId(), role: 'user', text: String(text ?? ''), at: now }];
  for (const reply of replies) {
    entries.push({
      id: makeId(),
      role: 'bot',
      botId: String(reply.botId ?? ''),
      text: String(reply.text ?? ''),
      at: now,
    });
  }
  return entries;
}

export function createBotGroupStore(gateHome) {
  const file = join(gateHome, 'bot-groups.json');

  async function read() {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      // Rooms written before transcripts existed keep working: the transcript
      // map materialises on first append.
      if (!parsed.transcripts) parsed.transcripts = {};
      return parsed;
    } catch {
      return { groups: [], transcripts: {} };
    }
  }

  async function write(data) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  }

  return {
    async list() {
      return (await read()).groups;
    },
    async create({ name, memberIds }) {
      const checked = validateGroup({ name, memberIds });
      if (!checked.ok) {
        const error = new Error(checked.error);
        error.code = 'invalid_group';
        error.status = 400;
        throw error;
      }
      const group = {
        id: randomBytes(8).toString('hex'),
        name: checked.name,
        memberIds: checked.memberIds,
      };
      const data = await read();
      data.groups.push(group);
      await write(data);
      return group;
    },
    async get(id) {
      return (await read()).groups.find((group) => group.id === id) ?? null;
    },
    async rename(id, name) {
      const trimmed = String(name ?? '').trim();
      if (!trimmed) {
        const error = new Error('name required');
        error.code = 'invalid_group';
        error.status = 400;
        throw error;
      }
      const data = await read();
      const group = data.groups.find((entry) => entry.id === id);
      if (!group) {
        const error = new Error('group not found');
        error.code = 'unknown_group';
        error.status = 404;
        throw error;
      }
      group.name = trimmed;
      await write(data);
      return group;
    },
    async leave(id, memberId) {
      const data = await read();
      const group = data.groups.find((entry) => entry.id === id);
      if (!group) {
        const error = new Error('group not found');
        error.code = 'unknown_group';
        error.status = 404;
        throw error;
      }
      if (!group.memberIds.includes(memberId)) {
        const error = new Error('member not in group');
        error.code = 'unknown_member';
        error.status = 404;
        throw error;
      }
      if (group.memberIds.length <= 2) {
        const error = new Error('a room needs at least 2 members');
        error.code = 'too_few_members';
        error.status = 400;
        throw error;
      }
      group.memberIds = group.memberIds.filter((entry) => entry !== memberId);
      await write(data);
      return group;
    },
    async appendMessages(id, entries) {
      if (!Array.isArray(entries) || entries.length === 0) return 0;
      const data = await read();
      const group = data.groups.find((entry) => entry.id === id);
      if (!group) {
        const error = new Error('group not found');
        error.code = 'unknown_group';
        error.status = 404;
        throw error;
      }
      const room = data.transcripts[id] ?? (data.transcripts[id] = []);
      room.push(...entries);
      if (room.length > MAX_GROUP_HISTORY) room.splice(0, room.length - MAX_GROUP_HISTORY);
      await write(data);
      return room.length;
    },
    async history(id) {
      const data = await read();
      const group = data.groups.find((entry) => entry.id === id);
      if (!group) {
        const error = new Error('group not found');
        error.code = 'unknown_group';
        error.status = 404;
        throw error;
      }
      return data.transcripts[id] ?? [];
    },
    async delete(id) {
      const data = await read();
      const group = data.groups.find((entry) => entry.id === id);
      if (!group) {
        const error = new Error('group not found');
        error.code = 'unknown_group';
        error.status = 404;
        throw error;
      }
      // Disbanding removes the room AND its stored transcript: a disbanded
      // room must not resurface with its history the next time the phone
      // lists rooms. The transcript map key is cleaned with the group.
      data.groups = data.groups.filter((entry) => entry.id !== id);
      delete data.transcripts[id];
      await write(data);
      return { ok: true };
    },
  };
}
