import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';

import { render, createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import { LayoutGrid, Inbox, Code2, Plug, Settings as SettingsIcon, LogOut, Menu, X, ChevronsUpDown } from 'lucide-preact';
import { api, navigate, onLinkClick, setTimezone, useLocation, type ApiError } from './lib.js';
import { ToastProvider, Skeleton } from './ui.js';
import type { TenantConfig } from '../../shared/model.js';
import { Login } from './pages/Login.js';
import { Overview } from './pages/Overview.js';
import { Tickets } from './pages/Tickets.js';
import { TicketDetail } from './pages/TicketDetail.js';
import { Widget } from './pages/Widget.js';
import { Integrations } from './pages/Integrations.js';
import { Settings } from './pages/Settings.js';

export type Role = 'owner' | 'admin' | 'agent' | 'viewer';
export interface Me {
  admin: { id: string; email: string; name: string | null; role: Role };
  tenant: { id: string; name: string; slug: string; ticketPrefix: string; config: TenantConfig };
  memberships: Array<{ tenantId: string; name: string; role: Role }>;
  platform: { googleConfigured: boolean; aiConfigured: boolean; baseUrl: string; appEnv: string };
}

const MeCtx = createContext<{ me: Me; refresh: () => Promise<void> }>(null as any);
export const useMe = () => useContext(MeCtx);
const RANK: Record<Role, number> = { viewer: 0, agent: 1, admin: 2, owner: 3 };
export const can = (me: Me, min: Role) => RANK[me.admin.role] >= RANK[min];

const NAV = [
  { href: '/admin', label: 'Overview', icon: LayoutGrid, match: (p: string) => p === '/admin' },
  { href: '/admin/tickets', label: 'Tickets', icon: Inbox, match: (p: string) => p.startsWith('/admin/tickets') },
  { href: '/admin/widget', label: 'Widget', icon: Code2, match: (p: string) => p.startsWith('/admin/widget') },
  { href: '/admin/integrations', label: 'Integrations', icon: Plug, match: (p: string) => p.startsWith('/admin/integrations') },
  { href: '/admin/settings', label: 'Settings', icon: SettingsIcon, match: (p: string) => p.startsWith('/admin/settings') },
];

function Sidebar({ me, pathname, open, onClose }: { me: Me; pathname: string; open: boolean; onClose: () => void }) {
  const [switching, setSwitching] = useState(false);
  const logo = me.tenant.config.brand.logoUrl;
  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    navigate('/admin/login', true);
  }
  async function switchTo(tenantId: string) {
    await api('/api/auth/switch', { method: 'POST', body: { tenantId } });
    location.href = '/admin';
  }
  return (
    <>
      {open && <div class="scrim" onClick={onClose} aria-hidden="true" />}
      <aside class={`sidebar ${open ? 'open' : ''}`} aria-label="Main">
        <div class="ws">
          {logo ? <img src={logo} alt="" class="ws-logo" width={28} height={28} /> : <span class="ws-logo ws-initial" aria-hidden="true">{me.tenant.name[0]}</span>}
          <div class="ws-text">
            <span class="ws-name">{me.tenant.name}</span>
            <span class="ws-sub">Support</span>
          </div>
          {me.memberships.length > 1 && (
            <button class="icon-btn" type="button" aria-label="Switch workspace" onClick={() => setSwitching((s) => !s)}><ChevronsUpDown size={16} /></button>
          )}
          <button class="icon-btn only-mobile" type="button" aria-label="Close menu" onClick={onClose}><X size={18} /></button>
        </div>
        {switching && (
          <ul class="ws-list">
            {me.memberships.map((m) => (
              <li><button type="button" class={m.tenantId === me.tenant.id ? 'current' : ''} onClick={() => switchTo(m.tenantId)}>{m.name}</button></li>
            ))}
          </ul>
        )}
        <nav class="nav">
          {NAV.map((n) => {
            const active = n.match(pathname);
            const Icon = n.icon;
            return (
              <a href={n.href} class={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClose}>
                <Icon size={17} strokeWidth={1.75} aria-hidden="true" />
                {n.label}
              </a>
            );
          })}
        </nav>
        <div class="me">
          <div class="me-text">
            <span class="me-name">{me.admin.name ?? me.admin.email.split('@')[0]}</span>
            <span class="me-email">{me.admin.email}</span>
          </div>
          <button class="icon-btn" type="button" onClick={logout} aria-label="Sign out" title="Sign out"><LogOut size={16} strokeWidth={1.75} /></button>
        </div>
      </aside>
    </>
  );
}

function Shell() {
  const { pathname } = useLocation();
  const [me, setMe] = useState<Me | null>(null);
  const [menu, setMenu] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function refresh() {
    try {
      const m = await api<Me>('/api/admin/me');
      setTimezone(m.tenant.config.timezone);
      setMe(m);
    } catch (e) {
      if ((e as ApiError).status !== 401) setFailed((e as ApiError).message);
    }
  }
  useEffect(() => { if (pathname !== '/admin/login') refresh(); }, [pathname === '/admin/login']);

  useEffect(() => {
    const t = pathname.startsWith('/admin/tickets/') ? pathname.split('/').pop() : NAV.find((n) => n.match(pathname))?.label;
    document.title = [t, me?.tenant.name ? `${me.tenant.name} Support` : 'Support'].filter(Boolean).join(' · ');
  }, [pathname, me]);

  if (pathname === '/admin/login') return <Login />;
  if (failed) return <div class="boot-error"><p>{failed}</p><button class="btn btn-secondary btn-md" onClick={() => location.reload()}>Reload</button></div>;
  if (!me) {
    return (
      <div class="layout">
        <aside class="sidebar"><div class="ws"><Skeleton w={28} h={28} /><Skeleton w={100} /></div></aside>
        <main class="main"><div class="page"><Skeleton w={180} h={28} /><div style={{ height: '24px' }} /><Skeleton h={120} /></div></main>
      </div>
    );
  }

  let page;
  const ticketMatch = /^\/admin\/tickets\/([^/]+)$/.exec(pathname);
  if (pathname === '/admin') page = <Overview />;
  else if (pathname === '/admin/tickets') page = <Tickets />;
  else if (ticketMatch) page = <TicketDetail key={ticketMatch[1]} ticketRef={decodeURIComponent(ticketMatch[1])} />;
  else if (pathname === '/admin/widget') page = <Widget />;
  else if (pathname === '/admin/integrations') page = <Integrations />;
  else if (pathname === '/admin/settings') page = <Settings />;
  else page = <div class="page"><h1 class="page-title">Page not found</h1><p><a href="/admin">Go to overview</a></p></div>;

  return (
    <MeCtx.Provider value={{ me, refresh }}>
      <a href="#main" class="skip">Skip to content</a>
      <div class="layout">
        <Sidebar me={me} pathname={pathname} open={menu} onClose={() => setMenu(false)} />
        <div class="topbar only-mobile">
          <button class="icon-btn" type="button" aria-label="Open menu" onClick={() => setMenu(true)}><Menu size={20} /></button>
          <span class="topbar-title">{me.tenant.name} Support</span>
        </div>
        <main class="main" id="main" tabIndex={-1}>{page}</main>
      </div>
    </MeCtx.Provider>
  );
}

function App() {
  return (
    <ToastProvider>
      <div onClick={(e) => onLinkClick(e as unknown as MouseEvent)}>
        <Shell />
      </div>
    </ToastProvider>
  );
}

render(<App />, document.getElementById('app')!);
