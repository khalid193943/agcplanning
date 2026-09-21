import { Pool, type PoolClient } from 'pg';

/* =================================================================
   Accès à la base PostgreSQL
   Sur Vercel, la base Neon fournit automatiquement DATABASE_URL.
   Les tables sont créées au premier appel : aucune commande SQL
   n'est à lancer à la main.
   ================================================================= */

export class DbConfigError extends Error {
  constructor() {
    super('DATABASE_URL non configurée');
    this.name = 'DbConfigError';
  }
}

type G = { __agcPool?: Pool; __agcSchema?: Promise<void> };
const g = globalThis as unknown as G;

export function databaseUrl(): string | null {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || null;
}

export function getPool(): Pool {
  const url = databaseUrl();
  if (!url) throw new DbConfigError();
  if (!g.__agcPool) {
    g.__agcPool = new Pool({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    // Une connexion inactive coupée par le serveur ne doit pas faire tomber l'application
    g.__agcPool.on('error', () => {});
  }
  return g.__agcPool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agc_planning (
  id          text PRIMARY KEY,
  data        json NOT NULL,
  rev         bigint NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agc_planning_history (
  id        bigserial PRIMARY KEY,
  data      json NOT NULL,
  rev       bigint NOT NULL,
  note      text,
  saved_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agc_login_attempts (
  ip  text NOT NULL,
  at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agc_login_attempts_ip_at ON agc_login_attempts (ip, at);
`;

export function ensureSchema(): Promise<void> {
  if (!g.__agcSchema) {
    g.__agcSchema = getPool()
      .query(SCHEMA)
      .then(() => undefined)
      .catch((e) => {
        g.__agcSchema = undefined; // on retentera au prochain appel
        throw e;
      });
  }
  return g.__agcSchema;
}

/* Si la base a été réinitialisée pendant que le site tourne, les tables
   sont recréées automatiquement et l'opération est relancée une fois. */
function isMissingTable(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === '42P01';
}

async function selfHealing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    g.__agcSchema = undefined;
    return run();
  }
}

/* Transaction avec verrou applicatif : les écritures sont traitées
   une par une, jamais en parallèle. */
export function withLockedTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return selfHealing(() => runLockedTx(fn));
}

async function runLockedTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(424242)');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connexion déjà perdue */
    }
    throw e;
  } finally {
    client.release();
  }
}

export function query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return selfHealing(async () => {
    await ensureSchema();
    const r = await getPool().query(text, params);
    return r.rows as T[];
  });
}
