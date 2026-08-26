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

export function createBotGroupStore(gateHome, { listBotIds } = {}) {
  const file = join(gateHome, 'bot-groups.json');

  // Membership writes trust the caller's ids only as far as the roster
  // confirms them. When the Gate wires a roster resolver, every id a create
  // or an add names must be a bot this Gate can actually address — a typo'd
  // id dies here, at the door, instead of surviving until the room's first
  // message fails wholesale with "unknown bot". Without a resolver nothing
  // changes: verification is claimed only when it actually ran.
  async function assertKnownMembers(requestedIds) {
    if (typeof listBotIds !== 'function') return;
    let known;
    try {
      known = new Set(await listBotIds());
    } catch (cause) {
      const error = new Error(`cannot verify group members: ${cause?.message ?? cause}`);
      error.code = 'roster_unavailable';
      error.status = 502;
      throw error;
    }
    const unknown = requestedIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      const error = new Error(`unknown bot${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
      error.code = 'unknown_member';
      error.status = 400;
      throw error;
    }
  }

  // Every mutating operation below is a read-modify-write of ONE json file.
  // Two overlapping operations interleave their read and write halves and the
  // file ends up as whichever wrote last: an append landing after its room was
  // disbanded resurrects the disbanded room wholesale, transcript included,
  // and concurrent appends of the same room silently drop messages. The Gate
  // is single-process (the instance lock already guarantees one Gate per
  // home), so mutations are queued to run strictly one at a time. Reads stay
  // unqueued; they never write back what they read.
  let mutationTail = Promise.resolve();
  function serialized(mutation) {
    const run = mutationTail.then(mutation);
    mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

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

  const store = {
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
      // The door check: no room is ever persisted naming a bot this Gate
      // cannot address.
      await assertKnownMembers(checked.memberIds);
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
    async addMembers(id, memberIds) {
      // Append semantics: ids already in the room are skipped, so a retry of
      // an interrupted add cannot double-book a member. An add that names no
      // NEW member is refused rather than silently returning "success" —
      // the caller asked for a change and got none.
      const requested = Array.isArray(memberIds) ? memberIds : [];
      if (!requested.every((memberId) => typeof memberId === 'string' && memberId.trim())) {
        const error = new Error('memberIds must be non-empty strings');
        error.code = 'invalid_group';
        error.status = 400;
        throw error;
      }
      const fresh = [...new Set(requested.map((memberId) => memberId.trim()))];
      const data = await read();
      const group = data.groups.find((entry) => entry.id === id);
      if (!group) {
        const error = new Error('group not found');
        error.code = 'unknown_group';
        error.status = 404;
        throw error;
      }
      // The whole room must stay addressable, not just the newcomers: an
      // add to a room already carrying a dead id would bless the broken
      // roster by association. The refusal names the dead id so the operator
      // can remove it (leave) instead of meeting it on first send.
      await assertKnownMembers([...group.memberIds, ...fresh]);
      const additions = fresh.filter((memberId) => !group.memberIds.includes(memberId));
      if (additions.length === 0) {
        const error = new Error('every named member is already in the room');
        error.code = 'no_new_members';
        error.status = 400;
        throw error;
      }
      if (group.memberIds.length + additions.length > 6) {
        const error = new Error('at most 6 bots per room');
        error.code = 'too_many_members';
        error.status = 400;
        throw error;
      }
      group.memberIds.push(...additions);
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
      // The two-member floor keeps a room a conversation. But a member no bot
      // on the roster answers to is not a participant, and counting one toward
      // the floor is what stranded legacy two-member rooms carrying a dead id:
      // add refused unknown_member for the whole room, leave refused
      // too_few_members here, and disbanding (transcript deleted) was the only
      // exit. When the resolver confirms the leaver is dead, the floor does not
      // apply — evicting a ghost removes zero addressable participants. With no
      // resolver, or a resolver that fails, the plain length rule stands:
      // leaving must never become harder than before (create/add fail loud on
      // an unreadable roster because they grow a room; leave is how an operator
      // escapes one).
      let evicting = false;
      if (typeof listBotIds === 'function') {
        try {
          const known = new Set(await listBotIds());
          evicting = !known.has(memberId);
        } catch {
          evicting = false;
        }
      }
      if (!evicting && group.memberIds.length <= 2) {
        const error = new Error('a room needs at least 2 members; disband instead');
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

  // Reads pass through untouched; every read-modify-write goes through the
  // queue so its read half can never straddle another operation's write.
  return {
    ...store,
    create: (payload) => serialized(() => store.create(payload)),
    rename: (id, name) => serialized(() => store.rename(id, name)),
    addMembers: (id, memberIds) => serialized(() => store.addMembers(id, memberIds)),
    leave: (id, memberId) => serialized(() => store.leave(id, memberId)),
    appendMessages: (id, entries) => serialized(() => store.appendMessages(id, entries)),
    delete: (id) => serialized(() => store.delete(id)),
  };
}
