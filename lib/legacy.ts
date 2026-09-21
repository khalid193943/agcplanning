import { isValidState, type PlanningState } from './api';

/* =================================================================
   Reprise de l'ancienne version
   La version précédente enregistrait le planning dans Vercel Blob
   (fichier planning-agc/data.json). Au tout premier démarrage, si la
   base est vide et que ce fichier existe, il est importé une fois.
   En cas de problème, l'import est simplement ignoré.
   ================================================================= */

const LEGACY_PATH = 'planning-agc/data.json';

export async function readLegacyBlob(): Promise<PlanningState | null> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  try {
    const { head } = await import('@vercel/blob');
    const meta = await head(LEGACY_PATH);
    const sep = meta.url.includes('?') ? '&' : '?';
    const r = await fetch(`${meta.url}${sep}cache=0&_=${Date.now()}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!r.ok) return null;
    const doc = (await r.json()) as { state?: unknown };
    return isValidState(doc?.state) ? doc.state : null;
  } catch {
    return null;
  }
}
