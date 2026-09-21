import type { NextRequest } from 'next/server';
import { query, withLockedTx } from '@/lib/db';
import { dbErrorResponse, isAuthed, isValidState, json, setSessionCookie } from '@/lib/api';
import { readLegacyBlob } from '@/lib/legacy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ID = 'agc';
const MAX_BYTES = 4_000_000; // bien au-delà d'un planning scolaire
const AUTO_SNAPSHOT_MINUTES = 10;
const HISTORY_KEEP = 300;

type Row = { data: unknown; rev: string | number; updated_at?: Date };

/* ---------------------------------------------------------------
   GET  /api/planning          -> planning complet
   GET  /api/planning?probe=1  -> numéro de révision seul (veille)
   --------------------------------------------------------------- */
export async function GET(req: NextRequest) {
  if (!(await isAuthed(req))) return json({ ok: false, error: 'unauthorized' }, 401);

  try {
    if (req.nextUrl.searchParams.get('probe')) {
      const rows = await query<Row>('SELECT rev FROM agc_planning WHERE id = $1', [ID]);
      return json({ ok: true, rev: rows.length ? Number(rows[0].rev) : 0 });
    }

    let rows = await query<Row>('SELECT data, rev, updated_at FROM agc_planning WHERE id = $1', [ID]);

    // Premier démarrage : reprise éventuelle de l'ancienne version
    if (!rows.length) {
      const legacy = await readLegacyBlob();
      if (legacy) {
        await withLockedTx(async (c) => {
          const again = await c.query('SELECT 1 FROM agc_planning WHERE id = $1', [ID]);
          if (again.rowCount) return; // un autre appel a déjà importé
          await c.query(
            'INSERT INTO agc_planning (id, data, rev, updated_at) VALUES ($1, $2::json, 1, now())',
            [ID, JSON.stringify(legacy)],
          );
          await c.query(
            "INSERT INTO agc_planning_history (data, rev, note) VALUES ($1::json, 1, 'Import depuis l''ancienne version')",
            [JSON.stringify(legacy)],
          );
        });
        rows = await query<Row>('SELECT data, rev, updated_at FROM agc_planning WHERE id = $1', [ID]);
      }
    }

    const res = json({
      ok: true,
      data: rows.length ? rows[0].data : null,
      rev: rows.length ? Number(rows[0].rev) : 0,
      updatedAt: rows.length && rows[0].updated_at ? rows[0].updated_at : null,
    });
    return setSessionCookie(res, req);
  } catch (e) {
    return dbErrorResponse(e);
  }
}

/* ---------------------------------------------------------------
   PUT /api/planning   { state, baseRev, checkpoint? }
   - refuse l'écriture si quelqu'un a enregistré entre-temps (409)
   - garde une copie de l'état précédent dans l'historique :
       * avant toute action confirmée (checkpoint)
       * sinon au plus toutes les 10 minutes
   --------------------------------------------------------------- */
export async function PUT(req: NextRequest) {
  if (!(await isAuthed(req))) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: { state?: unknown; baseRev?: unknown; checkpoint?: unknown };
  try {
    const raw = await req.text();
    if (raw.length > MAX_BYTES) return json({ ok: false, error: 'too_large' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }

  if (!isValidState(body.state)) return json({ ok: false, error: 'bad_payload' }, 400);
  const baseRev = Number(body.baseRev ?? 0);
  if (!Number.isFinite(baseRev) || baseRev < 0) return json({ ok: false, error: 'bad_rev' }, 400);
  const checkpoint =
    typeof body.checkpoint === 'string' && body.checkpoint.trim() ? body.checkpoint.trim().slice(0, 160) : null;
  const payload = JSON.stringify(body.state);

  try {
    const result = await withLockedTx(async (c) => {
      const cur = await c.query<Row>('SELECT data, rev FROM agc_planning WHERE id = $1', [ID]);
      const current = cur.rows[0];
      const currentRev = current ? Number(current.rev) : 0;

      if (currentRev !== baseRev) {
        return { conflict: true as const, data: current ? current.data : null, rev: currentRev };
      }

      if (current) {
        let snapshot = !!checkpoint;
        if (!snapshot) {
          const last = await c.query<{ recent: boolean }>(
            `SELECT saved_at > now() - interval '${AUTO_SNAPSHOT_MINUTES} minutes' AS recent
               FROM agc_planning_history ORDER BY id DESC LIMIT 1`,
          );
          snapshot = !last.rows.length || !last.rows[0].recent;
        }
        if (snapshot) {
          await c.query('INSERT INTO agc_planning_history (data, rev, note) VALUES ($1::json, $2, $3)', [
            JSON.stringify(current.data),
            currentRev,
            checkpoint || 'Sauvegarde automatique',
          ]);
          await c.query(
            `DELETE FROM agc_planning_history
              WHERE id NOT IN (SELECT id FROM agc_planning_history ORDER BY id DESC LIMIT ${HISTORY_KEEP})`,
          );
        }
      }

      const newRev = currentRev + 1;
      await c.query(
        `INSERT INTO agc_planning (id, data, rev, updated_at) VALUES ($1, $2::json, $3, now())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, rev = EXCLUDED.rev, updated_at = now()`,
        [ID, payload, newRev],
      );
      return { conflict: false as const, rev: newRev };
    });

    if (result.conflict) {
      return json({ ok: false, conflict: true, data: result.data, rev: result.rev }, 409);
    }
    return setSessionCookie(json({ ok: true, rev: result.rev }), req);
  } catch (e) {
    return dbErrorResponse(e);
  }
}
