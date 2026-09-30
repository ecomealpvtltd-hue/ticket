// Structured, PII-conscious logging. One JSON line per event.
// Never pass raw phone numbers, emails, descriptions or file contents to these functions;
// use maskPhone() / maskEmail() when an identifier is genuinely useful for debugging.

type Fields = Record<string, unknown>;

function emit(level: 'info' | 'warn' | 'error', event: string, fields: Fields = {}) {
  const line = JSON.stringify({ level, event, t: new Date().toISOString(), ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

let silent = false;
export function setLogSilent(v: boolean) { silent = v; }

export const log = {
  info: (event: string, fields?: Fields) => { if (!silent) emit('info', event, fields); },
  warn: (event: string, fields?: Fields) => { if (!silent) emit('warn', event, fields); },
  error: (event: string, fields?: Fields) => { if (!silent) emit('error', event, fields); },
};

export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `${phone.startsWith('+') ? '+' : ''}${digits.slice(0, 2)}••••••${digits.slice(-3)}`;
}

export function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  return `${user.slice(0, 2)}***@${domain}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  return String(err).slice(0, 500);
}
