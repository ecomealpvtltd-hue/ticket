import { createContext, type ComponentChildren } from 'preact';
import { useContext, useState, useCallback } from 'preact/hooks';
import { Check, Copy, Loader2, AlertTriangle, CircleCheck, X } from 'lucide-preact';
import { PRIORITY_LABEL, STATUS_LABEL, type TicketPriority, type TicketStatus } from '../../shared/constants.js';

export function Button(props: {
  children: ComponentChildren;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  type?: 'button' | 'submit';
  disabled?: boolean;
  loading?: boolean;
  onClick?: (e: MouseEvent) => void;
  href?: string;
  class?: string;
  title?: string;
  'aria-label'?: string;
}) {
  const cls = `btn btn-${props.variant ?? 'secondary'} btn-${props.size ?? 'md'} ${props.class ?? ''}`;
  if (props.href) return <a class={cls} href={props.href} title={props.title}>{props.children}</a>;
  return (
    <button type={props.type ?? 'button'} class={cls} disabled={props.disabled || props.loading} onClick={props.onClick}
      aria-busy={props.loading} title={props.title} aria-label={props['aria-label']}>
      {props.loading && <Loader2 class="spin" size={15} strokeWidth={2} aria-hidden="true" />}
      {props.children}
    </button>
  );
}

export function StatusBadge({ status }: { status: TicketStatus }) {
  return <span class={`status status-${status}`}><span class="status-dot" aria-hidden="true" />{STATUS_LABEL[status]}</span>;
}

/** Priority as a four-step bar glyph: readable at a glance, colour is secondary. */
export function PriorityMark({ priority, label = true }: { priority: TicketPriority; label?: boolean }) {
  const level = { low: 1, medium: 2, high: 3, urgent: 4 }[priority];
  return (
    <span class={`prio prio-${priority}`} title={`${PRIORITY_LABEL[priority]} priority`}>
      <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <rect x={i * 3.6} y={9 - i * 3} width="2.4" height={3 + i * 3} rx="0.8" class={i < level ? 'on' : 'off'} />
        ))}
      </svg>
      {label ? <span>{PRIORITY_LABEL[priority]}</span> : <span class="sr-only">{PRIORITY_LABEL[priority]} priority</span>}
    </span>
  );
}

export function Skeleton({ w = '100%', h = 14, class: c = '' }: { w?: string | number; h?: number; class?: string }) {
  return <span class={`skeleton ${c}`} style={{ width: typeof w === 'number' ? `${w}px` : w, height: `${h}px` }} aria-hidden="true" />;
}

export function Empty({ title, children, action }: { title: string; children?: ComponentChildren; action?: ComponentChildren }) {
  return (
    <div class="empty">
      <p class="empty-title">{title}</p>
      {children && <p class="empty-text">{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div class="empty" role="alert">
      <p class="empty-title">Couldn't load this</p>
      <p class="empty-text">{message}</p>
      {onRetry && <Button onClick={() => onRetry()}>Try again</Button>}
    </div>
  );
}

export function Notice({ tone = 'info', children, action }: { tone?: 'info' | 'warn' | 'error' | 'success'; children: ComponentChildren; action?: ComponentChildren }) {
  const Icon = tone === 'success' ? CircleCheck : AlertTriangle;
  return (
    <div class={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {tone !== 'info' && <Icon size={16} strokeWidth={2} aria-hidden="true" />}
      <div class="notice-body">{children}</div>
      {action}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button size="sm" onClick={async () => {
      try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
      setDone(true);
      setTimeout(() => setDone(false), 1800);
    }}>
      {done ? <Check size={15} strokeWidth={2} aria-hidden="true" /> : <Copy size={15} strokeWidth={1.75} aria-hidden="true" />}
      {done ? 'Copied' : label}
    </Button>
  );
}

export function Section({ title, description, actions, children, class: c = '' }: { title?: string; description?: ComponentChildren; actions?: ComponentChildren; children: ComponentChildren; class?: string }) {
  return (
    <section class={`section ${c}`}>
      {(title || actions) && (
        <header class="section-hd">
          <div>
            {title && <h2 class="section-title">{title}</h2>}
            {description && <p class="section-desc">{description}</p>}
          </div>
          {actions && <div class="section-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, description, actions, back }: { title: ComponentChildren; description?: ComponentChildren; actions?: ComponentChildren; back?: ComponentChildren }) {
  return (
    <header class="page-hd">
      {back}
      <div class="page-hd-row">
        <div class="page-hd-text">
          <h1 class="page-title">{title}</h1>
          {description && <p class="page-desc">{description}</p>}
        </div>
        {actions && <div class="page-actions">{actions}</div>}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

interface Toast { id: number; tone: 'success' | 'error'; text: string }
const ToastCtx = createContext<(tone: Toast['tone'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ComponentChildren }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div class="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div class={`toast toast-${t.tone}`} key={t.id} role={t.tone === 'error' ? 'alert' : 'status'}>
            {t.tone === 'success' ? <CircleCheck size={16} strokeWidth={2} aria-hidden="true" /> : <AlertTriangle size={16} strokeWidth={2} aria-hidden="true" />}
            <span>{t.text}</span>
            <button class="toast-x" type="button" aria-label="Dismiss" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}><X size={14} /></button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
