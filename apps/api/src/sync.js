import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { userTransaction } from './db.js';
import { ApiError, data } from './errors.js';

const sequence = z.string().regex(/^(0|[1-9]\d{0,18})$/).refine((value) => BigInt(value) <= 9223372036854775807n);
const cursorSchema = z.object({ v: z.literal(1), userId: z.uuid(), generation: z.uuid(), after: sequence,
  high: sequence.nullable(), issuedAt: z.number().int().nonnegative() }).strict();
const expired = () => new ApiError(410, 'SYNC_CURSOR_EXPIRED', '同步位置已过期，请保留本机草稿并重新下载快照');
const invalid = () => new ApiError(400, 'SYNC_CURSOR_INVALID', '同步位置无效，请重新下载快照');
const retentionMs = 90 * 24 * 60 * 60 * 1000;

export function createSync(pool, auth, { now = Date.now, maxEventBytes = 2 * 1024 * 1024, maxPageBytes = 4 * 1024 * 1024 } = {}) {
  function pack(value) {
    const encoded = Buffer.from(JSON.stringify(cursorSchema.parse(value))).toString('base64url');
    return `${encoded}.${auth.digest(encoded, 'sync-cursor-v1')}`;
  }
  function unpack(raw, userId) {
    try {
      const parts = raw.split('.');
      if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0])) throw invalid();
      const expected = Buffer.from(auth.digest(parts[0], 'sync-cursor-v1'));
      const supplied = Buffer.from(parts[1]);
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw invalid();
      const value = cursorSchema.parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')));
      if (value.userId !== userId || value.issuedAt > now() + 300000 || value.high !== null && BigInt(value.after) > BigInt(value.high)) throw invalid();
      if (now() - value.issuedAt > retentionMs) throw expired();
      return value;
    } catch (error) { if (error instanceof ApiError) throw error; throw invalid(); }
  }
  // Used by the frozen snapshot producer; never accept a client-supplied baseline.
  function baseline(userId, generation, seq) {
    return pack({ v: 1, userId, generation, after: String(seq), high: null, issuedAt: now() });
  }
  async function changes(principal, query) {
    const { cursor, limit } = z.object({ cursor: z.string().min(1).max(2000), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(query);
    const position = unpack(cursor, principal.userId);
    return userTransaction(pool, principal.userId, principal.sessionId, async (client) => {
      const { rows: [state] } = await client.query('SELECT generation,last_seq FROM sync_state WHERE user_id=$1', [principal.userId]);
      if (!state || state.generation !== position.generation || BigInt(position.after) > BigInt(state.last_seq)
        || position.high !== null && BigInt(position.high) > BigInt(state.last_seq)) throw expired();
      const high = position.high ?? String(state.last_seq);
      let after = position.after, bytes = 0;
      const events = [];
      // Fetch bounded event bodies, not up to 100 multi-megabyte JSON documents.
      const { rows } = await client.query(`SELECT seq,octet_length(changes::text) AS size FROM sync_events
        WHERE user_id=$1 AND seq>$2 AND seq<=$3 ORDER BY seq LIMIT $4`, [principal.userId, after, high, limit]);
      for (const row of rows) {
        if (BigInt(row.seq) !== BigInt(after) + 1n) throw expired();
        if (row.size > maxEventBytes) {
          events.push({ seq: String(row.seq), type: 'resnapshot_required' }); after = String(row.seq); break;
        }
        if (events.length && bytes + row.size > maxPageBytes) break;
        const { rows: [event] } = await client.query('SELECT changes FROM sync_events WHERE user_id=$1 AND seq=$2', [principal.userId, row.seq]);
        if (!event) throw expired();
        events.push({ seq: String(row.seq), type: 'transaction', changes: event.changes });
        bytes += row.size; after = String(row.seq);
      }
      if (!events.length && BigInt(after) < BigInt(high)) throw expired();
      const hasMore = BigInt(after) < BigInt(high);
      return { events, hasMore, nextCursor: pack({ ...position, after, high: hasMore ? high : null, issuedAt: now() }), serverTime: new Date(now()).toISOString() };
    });
  }
  function mount(router) {
    router.get('/sync/changes', auth.requireAuth, async (req, res) => data(res, await changes(req.auth, req.query)));
  }
  return { mount, changes, baseline };
}
