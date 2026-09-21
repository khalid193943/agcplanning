import { NextResponse, type NextRequest } from 'next/server';
import { DbConfigError } from './db';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  createSessionToken,
  isHttps,
  verifySessionToken,
} from './session';

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function isAuthed(req: NextRequest): Promise<boolean> {
  return verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value);
}

export async function setSessionCookie(res: NextResponse, req: NextRequest): Promise<NextResponse> {
  res.cookies.set(SESSION_COOKIE, await createSessionToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps(req.url, req.headers.get('x-forwarded-proto')),
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}

/* Traduit une erreur serveur en réponse claire pour l'interface. */
export function dbErrorResponse(e: unknown): NextResponse {
  if (e instanceof DbConfigError) {
    return json({ ok: false, error: 'db_not_configured' }, 503);
  }
  const message = e instanceof Error ? e.message : String(e);
  console.error('[planning-agc] erreur base de données :', message);
  return json({ ok: false, error: 'db_error' }, 500);
}

export type PlanningState = {
  subjects: unknown[];
  teachers: unknown[];
  classes: unknown[];
  plan: Record<string, unknown>;
  currentClass?: string | null;
};

export function isValidState(s: unknown): s is PlanningState {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  return (
    Array.isArray(o.subjects) &&
    Array.isArray(o.teachers) &&
    Array.isArray(o.classes) &&
    !!o.plan &&
    typeof o.plan === 'object' &&
    !Array.isArray(o.plan)
  );
}
