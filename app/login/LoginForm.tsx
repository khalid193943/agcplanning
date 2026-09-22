'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

type Health = { db: 'ok' | 'missing' | 'error'; admin: 'ok' | 'missing' };

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Identifiant ou mot de passe incorrect.',
  too_many_attempts: 'Trop de tentatives. Réessayez dans 15 minutes.',
  admin_not_configured: "Le mot de passe administrateur n'est pas encore configuré sur le serveur.",
  network: 'Connexion au serveur impossible. Vérifiez votre accès à Internet.',
};

export default function LoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shake, setShake] = useState(0);
  const [health, setHealth] = useState<Health | null>(null);
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    userRef.current?.focus();
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => r.json())
      .then((h: Health) => setHealth(h))
      .catch(() => setHealth(null));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (r.ok) {
        window.location.replace('/'); // rechargement complet de l'application
        return;
      }
      const j = await r.json().catch(() => ({}));
      setError(MESSAGES[j.error as string] || 'Connexion refusée.');
      setShake((n) => n + 1);
      setPassword('');
    } catch {
      setError(MESSAGES.network);
    } finally {
      setBusy(false);
    }
  }

  const setupIssue =
    health && (health.db !== 'ok' || health.admin !== 'ok')
      ? [
          health.db === 'missing' && 'Base de données non reliée (variable DATABASE_URL absente).',
          health.db === 'error' && 'Base de données injoignable (DATABASE_URL incorrecte ?).',
          health.admin === 'missing' && 'Mot de passe administrateur non défini (variable ADMIN_PASSWORD).',
        ].filter(Boolean)
      : [];

  return (
    <main className="lg-wrap">
      <form key={shake} className={`lg-card${shake ? ' lg-shake' : ''}`} onSubmit={onSubmit} noValidate>
        <img className="lg-crest" src="/brand/logo.webp" alt="Académie Georges Claude" width={124} height={124} />
        <h1>Planning AGC</h1>
        <p className="lg-sub">Académie Georges Claude — El Jadida</p>

        {setupIssue.length > 0 && (
          <div className="lg-setup" role="status">
            <strong>Configuration incomplète</strong>
            <ul>
              {setupIssue.map((m) => (
                <li key={m as string}>{m}</li>
              ))}
            </ul>
          </div>
        )}

        <label className="lg-label" htmlFor="lg-user">
          Identifiant
        </label>
        <input
          ref={userRef}
          id="lg-user"
          className="lg-input"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />

        <label className="lg-label" htmlFor="lg-pass">
          Mot de passe
        </label>
        <div className="lg-pass">
          <input
            id="lg-pass"
            className="lg-input"
            type={showPass ? 'text' : 'password'}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button
            type="button"
            className="lg-eye"
            onClick={() => setShowPass((v) => !v)}
            aria-label={showPass ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
          >
            {showPass ? 'Masquer' : 'Afficher'}
          </button>
        </div>

        <button className="lg-btn" type="submit" disabled={busy || !username || !password}>
          {busy ? 'Vérification…' : 'Se connecter'}
        </button>

        {error && (
          <p className="lg-err" role="alert">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}
