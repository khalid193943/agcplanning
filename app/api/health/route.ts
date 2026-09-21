import { databaseUrl, ensureSchema } from '@/lib/db';
import { json } from '@/lib/api';
import { adminPassword } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* État de la configuration, affiché sur l'écran de connexion
   pour guider l'installation. Ne révèle aucun secret. */
export async function GET() {
  let db: 'ok' | 'missing' | 'error' = 'missing';
  if (databaseUrl()) {
    try {
      await ensureSchema();
      db = 'ok';
    } catch {
      db = 'error';
    }
  }
  return json({ ok: db === 'ok' && !!adminPassword(), db, admin: adminPassword() ? 'ok' : 'missing' });
}
