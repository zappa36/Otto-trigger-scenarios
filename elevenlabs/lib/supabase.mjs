/*
 * Supabase over plain REST, the way scripts/tune_triggers.py reads it:
 * the anon key in both headers (apikey + bearer), PostgREST's own query
 * syntax on the URL, the kit's project as the default. The pilot
 * policies let the anon key read every table — and make the loop's two
 * writes: update messages (stamping the agent version onto a grade)
 * and add agent_runs (a suite run, published for the dashboard).
 */

/* The kit's Supabase project — the same pair config.js and
 * scripts/tune_triggers.py carry. The publishable (anon) key is public
 * by design; RLS is the protection. */
export const DEFAULT_URL = 'https://lgyycoxsqrnhawzlqxlq.supabase.co';
export const DEFAULT_KEY = 'sb_publishable_UhActVk58ukgC6On1z9yuw_IbsMeWJf';

export function supabase({ url = DEFAULT_URL, key = DEFAULT_KEY, http }) {
  const base = String(url).replace(/\/+$/, '');
  const headers = { apikey: key, Authorization: 'Bearer ' + key };
  const rows = res => (Array.isArray(res) ? res : []);

  return {
    /* select / filter / order / limit go straight through as PostgREST
     * query params, e.g. { select: 'id,title', via: 'eq.elevenlabs', order: 'created_at.desc', limit: 1000 } */
    select: async (table, query = {}) =>
      rows(await http.send({ method: 'GET', base, path: `/rest/v1/${table}`, query, headers })),
    /* PATCH with the representation back, so a policy that matched no
     * row shows up as an empty list rather than a silent success — the
     * same tell dashboard.js reads (msgPolicyHint) */
    patch: async (table, filter, body) =>
      rows(await http.send({
        method: 'PATCH', base, path: `/rest/v1/${table}`, query: filter, body,
        headers: { ...headers, Prefer: 'return=representation' },
      })),
    /* POST with the representation back, the way backend.js inserts
     * (saveNote, insertRun): the body is a list of rows, the reply the
     * rows as stored — id and created_at filled in by the database,
     * which is how the caller learns the id. A table the schema does
     * not have yet is a 404 (PGRST205) from PostgREST, and the caller
     * says what to run. */
    insert: async (table, body) =>
      rows(await http.send({
        method: 'POST', base, path: `/rest/v1/${table}`, body: Array.isArray(body) ? body : [body],
        headers: { ...headers, Prefer: 'return=representation' },
      })),
  };
}

/* The agent debriefs, newest first. A database still on an older
 * schema has no conversation_id column and PostgREST rejects the whole
 * select — that is reported, not fatal: the loop then has field
 * conversations but nothing to join them to. */
export async function agentMessages(db, { limit = 1000 } = {}) {
  try {
    return await db.select('messages', {
      select: 'id,destination_id,context,transcript,title,category,via,convo,conversation_id,grade,created_at',
      conversation_id: 'not.is.null',
      order: 'created_at.desc',
      limit,
    });
  } catch (e) {
    if (/conversation_id|grade|convo|column/i.test(String(e.message))) {
      throw new Error('the messages table has no conversation_id / grade column yet — re-run supabase/schema.sql (' + e.message.slice(0, 120) + ')');
    }
    throw e;
  }
}

export const scenarioRows = db => db.select('scenarios', {
  select: 'id,num,title,learns,version,destination_id',
  order: 'num.asc.nullslast',
});

/* The designer's "not a problem" list — findings the dashboard's RUNS
 * tab raised and the designer ruled fine by design, with their reason.
 * The proposer gets them as decisions it must not touch. A project
 * whose schema.sql predates the table answers 404 (PGRST205): that is
 * null here — "no list yet", which the caller reports — not a failure
 * of the command. */
export async function acceptedFindings(db) {
  try {
    return await db.select('accepted_findings', { select: 'key,title,note,decided_at', order: 'decided_at.desc' });
  } catch (e) {
    if (e.status === 404 || /PGRST205|accepted_findings/i.test(String(e.message))) return null;
    throw e;
  }
}
