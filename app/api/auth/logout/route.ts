import type { NextRequest } from 'next/server';
import { json } from '@/lib/api';
import { SESSION_COOKIE, isHttps } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* POST /api/auth/logout */
export async function POST(req: NextRequest) {
  const res = json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps(req.url, req.headers.get('x-forwarded-proto')),
    path: '/',
    maxAge: 0,
  });
  return res;
}
