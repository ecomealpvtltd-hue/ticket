import { useEffect, useState } from 'preact/hooks';
import { Plus, Trash2 } from 'lucide-preact';
import { api, relativeTime, useApi, type ApiError } from '../lib.js';
import { Button, ErrorState, Notice, PageHeader, Section, Skeleton, useToast } from '../ui.js';
import { can, useMe, type Role } from '../main.js';
import type { TenantConfig, ContactOption } from '../../../shared/model.js';

type Tab = 'branding' | 'copy' | 'form' | 'team';

export function Settings() {
  const { me, refresh } = useMe();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('branding');
  const [cfg, setCfg] = useState<TenantConfig>(() => structuredClone(me.tenant.config));
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const isAdmin = can(me, 'admin');
  const dirty = JSON.stringify(cfg) !== JSON.stringify(me.tenant.config);

  function update<K extends keyof TenantConfig>(section: K, patch: Partial<TenantConfig[K]>) {
    setCfg((c) => ({ ...c, [section]: { ...(c[section] as object), ...patch } }));
  }

  async function save() {
    setSaving(true);
    setFieldErrors({});
    try {
      await api('/api/admin/settings', { method: 'PUT', body: { config: cfg } });
      await refresh();
      toast('success', 'Settings saved. The widget uses them immediately.');
    } catch (e) {
      const err = e as ApiError;
      if (err.fields) setFieldErrors(err.fields);
      toast('error', err.fields ? 'Some fields need attention.' : err.message);
    } finally {
      setSaving(false);
    }
  }

  const err = (path: string) => fieldErrors[`config.${path}`] ?? fieldErrors[path];
  const tabs: Array<[Tab, string]> = [['branding', 'Branding'], ['copy', 'Widget text'], ['form', 'Ticket form'], ['team', 'Team']];

  return (
    <div class="page">
      <PageHeader title="Settings" actions={tab !== 'team' && isAdmin ? (
        <>
          {dirty && <Button variant="ghost" onClick={() => setCfg(structuredClone(me.tenant.config))}>Discard</Button>}
          <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>Save changes</Button>
        </>
      ) : undefined} />
      <div class="tabs" role="tablist" aria-label="Settings sections">
        {tabs.map(([k, label]) => <button type="button" role="tab" aria-selected={tab === k} class={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {!isAdmin && tab !== 'team' && <Notice tone="info">Only admins and owners can change settings.</Notice>}

      <fieldset disabled={!isAdmin} class="fieldset">
        {tab === 'branding' && (
          <Section>
            <div class="grid-2">
              <Text label="Brand name" value={cfg.brand.name} onInput={(v) => update('brand', { name: v })} error={err('brand.name')} />
              <Text label="Logo URL" hint="Square image, https" value={cfg.brand.logoUrl ?? ''} onInput={(v) => update('brand', { logoUrl: v || undefined })} error={err('brand.logoUrl')} />
              <Select label="Appearance" value={cfg.theme.mode} options={[['light', 'Light'], ['dark', 'Dark']]} onChange={(v) => update('theme', { mode: v as 'light' | 'dark' })} />
              <Text label="Font (Google Fonts family)" hint="Leave empty for the system font" value={cfg.theme.fontFamily ?? ''} onInput={(v) => update('theme', { fontFamily: v || undefined, googleFont: v ? `${v.trim().replace(/ /g, '+')}:wght@400;500;600` : undefined })} error={err('theme.fontFamily')} />
              <Color label="Accent colour" value={cfg.theme.accent} onInput={(v) => update('theme', { accent: v })} error={err('theme.accent')} />
              <Color label="Text on accent" value={cfg.theme.accentText} onInput={(v) => update('theme', { accentText: v })} error={err('theme.accentText')} />
              <Color label="Background" optional value={cfg.theme.background ?? ''} onInput={(v) => update('theme', { background: v || undefined })} error={err('theme.background')} />
              <Color label="Text colour" optional value={cfg.theme.text ?? ''} onInput={(v) => update('theme', { text: v || undefined })} error={err('theme.text')} />
              <Text label="Launcher label" value={cfg.launcher.label} onInput={(v) => update('launcher', { label: v })} error={err('launcher.label')} />
              <Select label="Launcher position" value={cfg.launcher.position} options={[['right', 'Bottom right'], ['left', 'Bottom left']]} onChange={(v) => update('launcher', { position: v as 'left' | 'right' })} />
              <Text label="Timezone" hint="Used for dates in the dashboard and Sheet, e.g. Asia/Kolkata" value={cfg.timezone} onInput={(v) => setCfg({ ...cfg, timezone: v })} error={err('timezone')} />
            </div>
          </Section>
        )}

        {tab === 'copy' && (
          <>
            <Section title="Support home">
              <div class="grid-1">
                <Text label="Panel title" value={cfg.copy.title} onInput={(v) => update('copy', { title: v })} error={err('copy.title')} />
                <Text label="Heading" value={cfg.copy.heading} onInput={(v) => update('copy', { heading: v })} error={err('copy.heading')} />
                <Text label="Description" value={cfg.copy.description} onInput={(v) => update('copy', { description: v })} error={err('copy.description')} multiline />
                <Text label="Ticket button" value={cfg.copy.ticketCta} onInput={(v) => update('copy', { ticketCta: v })} error={err('copy.ticketCta')} />
                <Text label="Ticket button description" value={cfg.copy.ticketCtaDescription} onInput={(v) => update('copy', { ticketCtaDescription: v })} error={err('copy.ticketCtaDescription')} />
              </div>
            </Section>
            <Section title="Contact options" description="Shown above the ticket button. Up to 5.">
              <ContactEditor value={cfg.contactOptions} onChange={(v) => setCfg({ ...cfg, contactOptions: v })} />
            </Section>
            <Section title="Form and confirmation">
              <div class="grid-1">
                <Text label="Form heading" value={cfg.copy.formHeading} onInput={(v) => update('copy', { formHeading: v })} error={err('copy.formHeading')} />
                <Text label="Form description" value={cfg.copy.formDescription} onInput={(v) => update('copy', { formDescription: v })} error={err('copy.formDescription')} />
                <Text label="Confirmation heading" value={cfg.copy.successHeading} onInput={(v) => update('copy', { successHeading: v })} error={err('copy.successHeading')} />
                <Text label="Confirmation message" value={cfg.copy.successMessage} onInput={(v) => update('copy', { successMessage: v })} error={err('copy.successMessage')} multiline />
              </div>
            </Section>
          </>
        )}

        {tab === 'form' && (
          <>
            <Section title="Fields">
              <div class="grid-2">
                <Text label="Organisation field label" hint='For Ecomeal: "Restaurant name"' value={cfg.form.orgLabel} onInput={(v) => update('form', { orgLabel: v })} error={err('form.orgLabel')} />
                <Text label="Organisation placeholder" value={cfg.form.orgPlaceholder} onInput={(v) => update('form', { orgPlaceholder: v })} />
                <Text label="Issue field label" value={cfg.form.descriptionLabel} onInput={(v) => update('form', { descriptionLabel: v })} />
                <Select label="Default country code" value={cfg.form.defaultCountry} options={[['IN', 'India (+91)'], ['AE', 'UAE (+971)'], ['SG', 'Singapore (+65)'], ['GB', 'UK (+44)'], ['US', 'US (+1)']]} onChange={(v) => update('form', { defaultCountry: v })} />
              </div>
              <label class="check"><input type="checkbox" checked={cfg.form.allowAttachments} onChange={(e) => update('form', { allowAttachments: (e.target as HTMLInputElement).checked })} /> Allow attachments</label>
              <label class="check"><input type="checkbox" checked={cfg.form.showCategory} onChange={(e) => update('form', { showCategory: (e.target as HTMLInputElement).checked })} /> Ask customers to pick a topic (otherwise AI or your team sets it)</label>
              <label class="check"><input type="checkbox" checked={cfg.ai.enabled} onChange={(e) => update('ai', { enabled: (e.target as HTMLInputElement).checked })} /> AI triage for new tickets</label>
            </Section>
            <Section title="Categories" description="Used for filtering, AI triage and the optional topic picker.">
              <ListEditor value={cfg.categories} onChange={(v) => setCfg({ ...cfg, categories: v })} placeholder="New category" max={20} />
            </Section>
          </>
        )}
      </fieldset>

      {tab === 'team' && <Team />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Text(props: { label: string; value: string; onInput: (v: string) => void; hint?: string; error?: string; multiline?: boolean }) {
  const id = 'f-' + props.label.toLowerCase().replace(/[^a-z]+/g, '-');
  return (
    <div class="field">
      <label class="field-label" for={id}>{props.label}</label>
      {props.multiline
        ? <textarea id={id} class="input" rows={2} value={props.value} onInput={(e) => props.onInput((e.target as HTMLTextAreaElement).value)} aria-invalid={!!props.error} />
        : <input id={id} class="input" value={props.value} onInput={(e) => props.onInput((e.target as HTMLInputElement).value)} aria-invalid={!!props.error} />}
      {props.error ? <p class="field-error">{props.error}</p> : props.hint ? <p class="hint">{props.hint}</p> : null}
    </div>
  );
}

function Select(props: { label: string; value: string; options: Array<[string, string]>; onChange: (v: string) => void }) {
  const id = 's-' + props.label.toLowerCase().replace(/[^a-z]+/g, '-');
  return (
    <div class="field">
      <label class="field-label" for={id}>{props.label}</label>
      <select id={id} class="input" value={props.value} onChange={(e) => props.onChange((e.target as HTMLSelectElement).value)}>
        {props.options.map(([v, l]) => <option value={v}>{l}</option>)}
      </select>
    </div>
  );
}

function Color(props: { label: string; value: string; onInput: (v: string) => void; optional?: boolean; error?: string }) {
  const id = 'c-' + props.label.toLowerCase().replace(/[^a-z]+/g, '-');
  return (
    <div class="field">
      <label class="field-label" for={id}>{props.label}{props.optional && <span class="optional"> Optional</span>}</label>
      <div class="color">
        <input type="color" aria-label={`${props.label} picker`} value={/^#[0-9a-f]{6}$/i.test(props.value) ? props.value : '#ffffff'} onInput={(e) => props.onInput((e.target as HTMLInputElement).value.toUpperCase())} />
        <input id={id} class="input mono" value={props.value} placeholder={props.optional ? 'Default' : '#000000'} maxLength={7} onInput={(e) => props.onInput((e.target as HTMLInputElement).value)} aria-invalid={!!props.error} />
      </div>
      {props.error && <p class="field-error">{props.error}</p>}
    </div>
  );
}

function ListEditor({ value, onChange, placeholder, max }: { value: string[]; onChange: (v: string[]) => void; placeholder: string; max: number }) {
  const [draft, setDraft] = useState('');
  return (
    <>
      <ul class="chips">
        {value.map((v) => <li class="chip"><span>{v}</span><button type="button" class="chip-x" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}><Trash2 size={13} /></button></li>)}
      </ul>
      {value.length < max && (
        <form class="row" onSubmit={(e) => { e.preventDefault(); const d = draft.trim(); if (d && !value.includes(d)) onChange([...value, d.slice(0, 40)]); setDraft(''); }}>
          <label class="sr-only" for="list-new">{placeholder}</label>
          <input id="list-new" class="input" placeholder={placeholder} value={draft} maxLength={40} onInput={(e) => setDraft((e.target as HTMLInputElement).value)} />
          <Button type="submit"><Plus size={15} aria-hidden="true" />Add</Button>
        </form>
      )}
    </>
  );
}

function ContactEditor({ value, onChange }: { value: ContactOption[]; onChange: (v: ContactOption[]) => void }) {
  const set = (i: number, patch: Partial<ContactOption>) => onChange(value.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  return (
    <div class="contacts-edit">
      {value.map((o, i) => (
        <div class="contact-edit">
          <select class="input" aria-label="Type" value={o.type} onChange={(e) => set(i, { type: (e.target as HTMLSelectElement).value as ContactOption['type'] })}>
            <option value="email">Email</option><option value="phone">Phone</option><option value="link">Link</option>
          </select>
          <input class="input" aria-label="Label" placeholder="Label" value={o.label} onInput={(e) => set(i, { label: (e.target as HTMLInputElement).value })} />
          <input class="input" aria-label="Value" placeholder={o.type === 'email' ? 'support@company.com' : o.type === 'phone' ? '+919876543210' : 'https://help.company.com'} value={o.value} onInput={(e) => set(i, { value: (e.target as HTMLInputElement).value })} />
          <input class="input" aria-label="Description" placeholder="Short note (optional)" value={o.description ?? ''} onInput={(e) => set(i, { description: (e.target as HTMLInputElement).value || undefined })} />
          <button type="button" class="icon-btn" aria-label={`Remove ${o.label || 'contact option'}`} onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 size={15} /></button>
        </div>
      ))}
      {value.length < 5 && <Button size="sm" onClick={() => onChange([...value, { type: 'email', label: '', value: '' }])}><Plus size={14} aria-hidden="true" />Add contact option</Button>}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface Member { id: string; email: string; name: string | null; role: Role; status: 'active' | 'disabled'; createdAt: string; lastLoginAt: string | null }

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including keys and owners',
  admin: 'Settings, integrations and team',
  agent: 'Work on tickets',
  viewer: 'Read only',
};

function Team() {
  const { me } = useMe();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<{ members: Member[] }>('/api/admin/team');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('agent');
  const [busy, setBusy] = useState(false);
  const isAdmin = can(me, 'admin');
  const isOwner = can(me, 'owner');
  useEffect(() => {}, []);

  async function add(e: Event) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/admin/team', { method: 'POST', body: { email, role } });
      setEmail('');
      await reload(true);
      toast('success', `${email} added. They can sign in with Google now.`);
    } catch (err) { toast('error', (err as ApiError).message); } finally { setBusy(false); }
  }

  async function change(m: Member, patch: Partial<Pick<Member, 'role' | 'status'>>) {
    try {
      await api(`/api/admin/team/${m.id}`, { method: 'PATCH', body: patch });
      await reload(true);
      toast('success', patch.status === 'disabled' ? `${m.email} removed from the workspace.` : patch.status === 'active' ? `${m.email} restored.` : `Role updated.`);
    } catch (err) { toast('error', (err as ApiError).message); }
  }

  if (error) return <ErrorState message={error.message} onRetry={() => reload()} />;
  return (
    <Section title="Team" description="People sign in with their Google account. Only emails listed here can access this workspace.">
      {isAdmin && (
        <form class="row team-add" onSubmit={add}>
          <label class="sr-only" for="member-email">Email</label>
          <input id="member-email" type="email" class="input" placeholder="name@company.com" required value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
          <label class="sr-only" for="member-role">Role</label>
          <select id="member-role" class="input" value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value as Role)}>
            {(['agent', 'viewer', 'admin', ...(isOwner ? ['owner'] : [])] as Role[]).map((r) => <option value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}
          </select>
          <Button type="submit" variant="primary" loading={busy}>Add member</Button>
        </form>
      )}
      {loading && !data ? <Skeleton h={120} /> : (
        <ul class="members">
          {data?.members.map((m) => (
            <li class={`member ${m.status === 'disabled' ? 'disabled' : ''}`}>
              <div class="member-text">
                <span class="member-name">{m.name ?? m.email}{m.id === me.admin.id && <span class="you"> (you)</span>}</span>
                <span class="member-sub">{m.name ? `${m.email}, ` : ''}{m.status === 'disabled' ? 'removed' : m.lastLoginAt ? `last active ${relativeTime(m.lastLoginAt)}` : 'has not signed in yet'}</span>
              </div>
              {isAdmin && m.id !== me.admin.id && m.status === 'active' && (m.role !== 'owner' || isOwner) ? (
                <select class="input input-sm" aria-label={`Role for ${m.email}`} value={m.role} onChange={(e) => change(m, { role: (e.target as HTMLSelectElement).value as Role })} title={ROLE_HELP[m.role]}>
                  {(['viewer', 'agent', 'admin', ...(isOwner ? ['owner'] : [])] as Role[]).map((r) => <option value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}
                </select>
              ) : <span class="role-label" title={ROLE_HELP[m.role]}>{m.role[0].toUpperCase() + m.role.slice(1)}</span>}
              {isAdmin && m.id !== me.admin.id && (m.role !== 'owner' || isOwner) && (
                m.status === 'active'
                  ? <Button size="sm" variant="ghost" onClick={() => { if (confirm(`Remove ${m.email}? They will be signed out immediately.`)) change(m, { status: 'disabled' }); }}>Remove</Button>
                  : <Button size="sm" variant="ghost" onClick={() => change(m, { status: 'active' })}>Restore</Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
