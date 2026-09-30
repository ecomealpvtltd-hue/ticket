import { useEffect, useState } from 'preact/hooks';
import { LogIn } from 'lucide-preact';
import { api, useLocation } from '../lib.js';
import { Button, Notice } from '../ui.js';

const ERRORS: Record<string, string> = {
  no_access: "This Google account isn't a member of any support workspace. Ask an owner to add you under Settings.",
  unverified: 'Your Google account email is not verified.',
  cancelled: 'Sign-in was cancelled.',
  failed: "Sign-in didn't complete. Please try again.",
  google_not_configured: 'Google sign-in is not configured on this server yet. See the README (Google setup).',
};

export function Login() {
  const { search } = useLocation();
  const [cfg, setCfg] = useState<{ google: boolean; devLogin: boolean } | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [devError, setDevError] = useState('');
  const next = search.get('next') ?? '/admin';
  const error = search.get('error');

  useEffect(() => {
    api<{ google: boolean; devLogin: boolean }>('/api/auth/config').then(setCfg).catch(() => setCfg({ google: true, devLogin: false }));
  }, []);

  async function devLogin(e: Event) {
    e.preventDefault();
    setBusy(true);
    setDevError('');
    try {
      await api('/api/auth/dev-login', { method: 'POST', body: { email } });
      location.href = next.startsWith('/admin') ? next : '/admin';
    } catch (err: any) {
      setDevError(err.message);
      setBusy(false);
    }
  }

  return (
    <main class="login" id="main">
      <div class="login-card">
        <h1 class="login-title">Sign in to Support</h1>
        <p class="login-desc">Use the Google account your team added to the support workspace.</p>
        {error && <Notice tone="error">{ERRORS[error] ?? ERRORS.failed}</Notice>}
        <Button variant="primary" class="login-btn" href={`/api/auth/google/start?next=${encodeURIComponent(next)}`}>
          <LogIn size={16} strokeWidth={2} aria-hidden="true" />
          Continue with Google
        </Button>
        {cfg?.devLogin && (
          <form class="dev-login" onSubmit={devLogin}>
            <p class="dev-label">Local development sign-in</p>
            <div class="row">
              <label class="sr-only" for="dev-email">Email</label>
              <input id="dev-email" type="email" class="input" placeholder="dev@ecomeal.in" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} required />
              <Button type="submit" loading={busy}>Sign in</Button>
            </div>
            {devError && <p class="field-error">{devError}</p>}
          </form>
        )}
      </div>
      <p class="login-foot">Access is limited to members added by a workspace owner.</p>
    </main>
  );
}
