import { useEffect, useState } from 'preact/hooks';
import { Plus, Trash2, RefreshCw } from 'lucide-preact';
import { api, relativeTime, useApi, type ApiError } from '../lib.js';
import { Button, CopyButton, ErrorState, Notice, PageHeader, Section, Skeleton, useToast } from '../ui.js';
import { can, useMe } from '../main.js';

interface WidgetData {
  baseUrl: string;
  allowedOrigins: string[];
  keys: Array<{ id: string; publicKey: string; label: string; createdAt: string; revokedAt: string | null; lastSeenAt: string | null; lastSeenOrigin: string | null }>;
}

export function Widget() {
  const { me } = useMe();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<WidgetData>('/api/admin/widget');
  const [origins, setOrigins] = useState<string[]>([]);
  const [newOrigin, setNewOrigin] = useState('');
  const [originError, setOriginError] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

  useEffect(() => { if (data) setOrigins(data.allowedOrigins); }, [data]);
  // Poll while waiting for the first installation so the status flips without a refresh.
  const active = data?.keys.filter((k) => !k.revokedAt) ?? [];
  const seen = active.some((k) => k.lastSeenAt);
  useEffect(() => {
    if (!data || seen) return;
    const t = setInterval(() => reload(true), 10_000);
    return () => clearInterval(t);
  }, [data, seen]);

  if (error) return <div class="page"><PageHeader title="Widget" /><ErrorState message={error.message} onRetry={() => reload()} /></div>;

  const key = active[0];
  const snippet = key ? `<script src="${data!.baseUrl}/widget.js" data-key="${key.publicKey}" async></script>` : '';
  const isAdmin = can(me, 'admin');
  const isOwner = can(me, 'owner');
  const dirty = data && JSON.stringify(origins) !== JSON.stringify(data.allowedOrigins);

  function addOrigin(e: Event) {
    e.preventDefault();
    let v = newOrigin.trim().toLowerCase().replace(/\/+$/, '');
    if (!v) return;
    if (!/^https?:\/\//.test(v)) v = `https://${v}`;
    if (!/^https?:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/.test(v)) { setOriginError('Enter a domain like ecomeal.in or *.ecomeal.in'); return; }
    if (!origins.includes(v)) setOrigins([...origins, v]);
    setNewOrigin('');
    setOriginError('');
  }

  async function saveOrigins() {
    setSaving(true);
    try {
      await api('/api/admin/widget/origins', { method: 'PUT', body: { origins } });
      await reload(true);
      setPreviewKey((k) => k + 1);
      toast('success', 'Allowed domains saved.');
    } catch (e) {
      toast('error', (e as ApiError).message);
    } finally {
      setSaving(false);
    }
  }

  async function createKey() {
    try {
      await api('/api/admin/widget/keys', { method: 'POST' });
      await reload(true);
      toast('success', 'New key created. Update your snippet, then revoke the old key.');
    } catch (e) { toast('error', (e as ApiError).message); }
  }

  async function revokeKey(id: string) {
    if (!confirm('Revoke this key? Any website still using it will stop showing the support widget.')) return;
    try {
      await api(`/api/admin/widget/keys/${id}/revoke`, { method: 'POST' });
      await reload(true);
      toast('success', 'Key revoked.');
    } catch (e) { toast('error', (e as ApiError).message); }
  }

  return (
    <div class="page">
      <PageHeader title="Widget" description="Add support to your website or app with one line of code." />

      <Section title="Install" description="Paste this before the closing </body> tag on every page where support should be available.">
        {loading && !data ? <Skeleton h={64} /> : key ? (
          <>
            <div class="code">
              <pre><code>{snippet}</code></pre>
              <CopyButton text={snippet} label="Copy code" />
            </div>
            <div class={`install-status ${seen ? 'ok' : ''}`} role="status">
              <span class="pulse" aria-hidden="true" />
              {seen ? (
                <span>Installed. Last seen on <b>{active.find((k) => k.lastSeenAt)?.lastSeenOrigin ?? 'your site'}</b> {relativeTime(active.find((k) => k.lastSeenAt)?.lastSeenAt)}.</span>
              ) : (
                <span>Waiting for installation. This updates automatically once the widget loads on an allowed domain.</span>
              )}
            </div>
            <details class="details">
              <summary>Open support from your own button</summary>
              <p>Add <code>data-launcher="hidden"</code> to the script tag to hide the floating button, then call <code>SupportWidget.open()</code> from any element, for example <code>&lt;button onclick="SupportWidget.open()"&gt;Help&lt;/button&gt;</code>.</p>
            </details>
          </>
        ) : <Notice tone="warn">No active widget key. {isOwner ? 'Create one below.' : 'Ask an owner to create one.'}</Notice>}
      </Section>

      <Section title="Allowed domains" description="The widget only appears on these sites. Browsers enforce this, so a copied snippet won't work anywhere else.">
        <ul class="chips">
          {origins.map((o) => (
            <li class="chip">
              <span>{o}</span>
              {isAdmin && <button type="button" class="chip-x" aria-label={`Remove ${o}`} onClick={() => setOrigins(origins.filter((x) => x !== o))}><Trash2 size={13} /></button>}
            </li>
          ))}
          {origins.length === 0 && <li class="muted">No domains yet. The widget won't appear anywhere until you add one.</li>}
        </ul>
        {isAdmin && (
          <form class="row" onSubmit={addOrigin}>
            <label class="sr-only" for="origin">Domain</label>
            <input id="origin" class="input" placeholder="ecomeal.in or *.ecomeal.in" value={newOrigin} onInput={(e) => setNewOrigin((e.target as HTMLInputElement).value)} />
            <Button type="submit"><Plus size={15} aria-hidden="true" />Add</Button>
            {dirty && <Button variant="primary" onClick={saveOrigins} loading={saving}>Save domains</Button>}
          </form>
        )}
        {originError && <p class="field-error">{originError}</p>}
      </Section>

      <Section title="Preview" description="This is what customers see. It reflects saved settings."
        actions={<Button size="sm" onClick={() => setPreviewKey((k) => k + 1)}><RefreshCw size={14} aria-hidden="true" />Reload</Button>}>
        {key && <div class="preview"><iframe key={previewKey} title="Widget preview" src={`${data!.baseUrl}/embed/${key.publicKey}`} /></div>}
      </Section>

      <Section title="Keys" description="Widget keys are public by design: they identify your workspace but cannot read any data. Rotate a key by creating a new one, updating your snippet, then revoking the old one."
        actions={isOwner ? <Button size="sm" onClick={createKey}><Plus size={14} aria-hidden="true" />New key</Button> : undefined}>
        <ul class="keys">
          {data?.keys.map((k) => (
            <li class={`key ${k.revokedAt ? 'revoked' : ''}`}>
              <code class="mono">{k.publicKey}</code>
              <span class="key-meta">{k.revokedAt ? `Revoked ${relativeTime(k.revokedAt)}` : k.lastSeenAt ? `Last seen ${relativeTime(k.lastSeenAt)}` : 'Not seen yet'}</span>
              {!k.revokedAt && isOwner && active.length > 1 && <Button size="sm" variant="ghost" onClick={() => revokeKey(k.id)}>Revoke</Button>}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
