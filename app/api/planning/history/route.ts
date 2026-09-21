import type { NextRequest } from 'next/server';
import { query, withLockedTx } from '@/lib/db';
import { dbErrorResponse, isAuthed, json } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ID = 'agc';

type HistRow = {
  id: string;
  rev: string;
  note: string | null;
  saved_at: Date;
  classes: number;
  teachers: number;
  subjects: number;
};

/* GET /api/planning/history -> les 60 dernières versions enregistrées */
export async function GET(req: NextRequest) {
  if (!(await isAuthed(req))) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    const rows = await query<HistRow>(
      `SELECT id, rev, note, saved_at,
              json_array_length(COALESCE(data->'classes',  '[]'::json)) AS classes,
              json_array_length(COALESCE(data->'teachers', '[]'::json)) AS teachers,
              json_array_length(COALESCE(data->'subjects', '[]'::json)) AS subjects
         FROM agc_planning_history
        ORDER BY id DESC
        LIMIT 60`,
    );
    return json({
      ok: true,
      versions: rows.map((r) => ({
        id: Number(r.id),
        rev: Number(r.rev),
        note: r.note,
        savedAt: r.saved_at,
        classes: Number(r.classes),
        teachers: Number(r.teachers),
        subjects: Number(r.subjects),
      })),
    });
  } catch (e) {
    return dbErrorResponse(e);
  }
}

/* POST /api/planning/history { id } -> restaure une version.
   L'état actuel est d'abord mis de côté : la restauration est réversible. */
export async function POST(req: NextRequest) {
  if (!(await isAuthed(req))) return json({ ok: false, error: 'unauthorized' }, 401);

  let id: number;
  try {
    id = Number((await req.json())?.id);
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }
  if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: 'bad_id' }, 400);

  try {
    const result = await withLockedTx(async (c) => {
      const snap = await c.query<{ data: unknown }>('SELECT data FROM agc_planning_history WHERE id = $1', [id]);
      if (!snap.rowCount) return null;

      const cur = await c.query<{ data: unknown; rev: string }>(
        'SELECT data, rev FROM agc_planning WHERE id = $1',
        [ID],
      );
      const currentRev = cur.rowCount ? Number(cur.rows[0].rev) : 0;
      if (cur.rowCount) {
        await c.query(
          "INSERT INTO agc_planning_history (data, rev, note) VALUES ($1::json, $2, 'Avant restauration')",
          [JSON.stringify(cur.rows[0].data), currentRev],
        );
      }

      const newRev = currentRev + 1;
      await c.query(
        `INSERT INTO agc_planning (id, data, rev, updated_at) VALUES ($1, $2::json, $3, now())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, rev = EXCLUDED.rev, updated_at = now()`,
        [ID, JSON.stringify(snap.rows[0].data), newRev],
      );
      return { data: snap.rows[0].data, rev: newRev };
    });

    if (!result) return json({ ok: false, error: 'not_found' }, 404);
    return json({ ok: true, data: result.data, rev: result.rev });
  } catch (e) {
    return dbErrorResponse(e);
  }
}
