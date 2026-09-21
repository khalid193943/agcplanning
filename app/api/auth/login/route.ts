import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { json, setSessionCookie } from '@/lib/api';
import { adminPassword, checkCredentials } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ATTEMPTS = 8;          // tentatives échouées tolérées...
const WINDOW_MINUTES = 15;       // ...sur cette durée, par adresse IP

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') || 'local';
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* POST /api/auth/login { username, password } */
export async function POST(req: NextRequest) {
  if (!adminPassword()) return json({ ok: false, error: 'admin_not_configured' }, 503);

  let username = '';
  let password = '';
  try {
    const b = await req.json();
    username = String(b?.username ?? '');
    password = String(b?.password ?? '');
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }

  const ip = clientIp(req);

  // Protection contre les essais en série (ignorée si la base est indisponible)
  try {
    const rows = await query<{ n: string }>(
      `SELECT count(*) AS n FROM agc_login_attempts
        WHERE ip = $1 AND at > now() - interval '${WINDOW_MINUTES} minutes'`,
      [ip],
    );
    if (Number(rows[0]?.n || 0) >= MAX_ATTEMPTS) {
      return json({ ok: false, error: 'too_many_attempts', retryMinutes: WINDOW_MINUTES }, 429);
    }
  } catch {
    /* base indisponible : on n'empêche pas la connexion pour autant */
  }

  if (!(await checkCredentials(username, password))) {
    try {
      await query('INSERT INTO agc_login_attempts (ip) VALUES ($1)', [ip]);
      await query("DELETE FROM agc_login_attempts WHERE at < now() - interval '1 day'");
    } catch {
      /* ignoré */
    }
    await pause(600);
    return json({ ok: false, error: 'invalid_credentials' }, 401);
  }

  try {
    await query('DELETE FROM agc_login_attempts WHERE ip = $1', [ip]);
  } catch {
    /* ignoré */
  }
  return setSessionCookie(json({ ok: true }), req);
}
