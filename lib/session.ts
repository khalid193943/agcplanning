/* =================================================================
   Session administrateur
   Un seul compte. Le mot de passe vit dans la variable ADMIN_PASSWORD,
   jamais dans le code. La session est un cookie signé (HMAC-SHA256),
   illisible et infalsifiable côté navigateur.
   ================================================================= */

export const SESSION_COOKIE = 'agc_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 jours, prolongés à chaque utilisation

export function adminUser(): string {
  return (process.env.ADMIN_USER || 'adminagc').trim().toLowerCase();
}

export function adminPassword(): string | null {
  const p = process.env.ADMIN_PASSWORD;
  return p && p.length > 0 ? p : null;
}

function secret(): string {
  // Changer le mot de passe invalide automatiquement toutes les sessions ouvertes.
  return (
    process.env.SESSION_SECRET ||
    `agc|${process.env.ADMIN_PASSWORD || ''}|${process.env.DATABASE_URL || process.env.POSTGRES_URL || ''}`
  );
}

const enc = new TextEncoder();

function toB64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmac(data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

async function sha256(data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(data)));
}

export async function createSessionToken(): Promise<string> {
  const payload = toB64url(
    enc.encode(JSON.stringify({ u: adminUser(), exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE })),
  );
  return `${payload}.${toB64url(await hmac(payload))}`;
}

export async function verifySessionToken(token: string | null | undefined): Promise<boolean> {
  if (!token || !adminPassword()) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;

  let given: Uint8Array;
  try {
    given = new Uint8Array(Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
  if (!sameBytes(await hmac(payload), given)) return false;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u?: string; exp?: number };
    return data.u === adminUser() && typeof data.exp === 'number' && data.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

/* Comparaison à durée constante : on compare des empreintes de même longueur. */
export async function checkCredentials(user: string, pass: string): Promise<boolean> {
  const expected = adminPassword();
  if (!expected) return false;
  const given = await sha256(`${String(user).trim().toLowerCase()}\u0000${String(pass)}`);
  const good = await sha256(`${adminUser()}\u0000${expected}`);
  return sameBytes(given, good);
}

export function isHttps(url: string, forwardedProto: string | null): boolean {
  if (forwardedProto) return forwardedProto.split(',')[0].trim() === 'https';
  return url.startsWith('https:');
}
