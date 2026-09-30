// Shared, dependency-free constants and helpers (safe to bundle into the widget).

// ---------------------------------------------------------------------------
// Phone numbers. India-first, but not India-only.
// ---------------------------------------------------------------------------

export interface Country { code: string; dial: string; name: string; min: number; max: number; pattern?: RegExp }

export const COUNTRIES: Country[] = [
  { code: 'IN', dial: '91', name: 'India', min: 10, max: 10, pattern: /^[6-9]\d{9}$/ },
  { code: 'AE', dial: '971', name: 'United Arab Emirates', min: 8, max: 9 },
  { code: 'SA', dial: '966', name: 'Saudi Arabia', min: 9, max: 9 },
  { code: 'SG', dial: '65', name: 'Singapore', min: 8, max: 8 },
  { code: 'GB', dial: '44', name: 'United Kingdom', min: 10, max: 10 },
  { code: 'US', dial: '1', name: 'United States', min: 10, max: 10 },
  { code: 'AU', dial: '61', name: 'Australia', min: 9, max: 9 },
  { code: 'NP', dial: '977', name: 'Nepal', min: 8, max: 10 },
  { code: 'LK', dial: '94', name: 'Sri Lanka', min: 9, max: 9 },
  { code: 'BD', dial: '880', name: 'Bangladesh', min: 10, max: 10 },
];

/** Returns E.164 (e.g. +919876543210) or null if invalid for the given country. */
export function normalizePhone(countryCode: string, national: string): string | null {
  const c = COUNTRIES.find((x) => x.code === countryCode);
  if (!c) return null;
  let digits = national.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) {
    if (!digits.startsWith('+' + c.dial)) return null;
    digits = digits.slice(1 + c.dial.length);
  } else if (digits.startsWith('00' + c.dial) && digits.length > c.max) {
    digits = digits.slice(2 + c.dial.length);
  } else if (digits.startsWith('0') && digits.length === c.max + 1) {
    digits = digits.slice(1); // trunk prefix, e.g. 09876543210
  } else if (digits.startsWith(c.dial) && digits.length === c.max + c.dial.length) {
    digits = digits.slice(c.dial.length); // 919876543210
  }
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length < c.min || digits.length > c.max) return null;
  if (c.pattern && !c.pattern.test(digits)) return null;
  return `+${c.dial}${digits}`;
}

export function formatPhone(e164: string): string {
  const c = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length).find((x) => e164.startsWith('+' + x.dial));
  if (!c) return e164;
  const rest = e164.slice(1 + c.dial.length);
  if (c.code === 'IN' && rest.length === 10) return `+91 ${rest.slice(0, 5)} ${rest.slice(5)}`;
  return `+${c.dial} ${rest}`;
}

// ---------------------------------------------------------------------------
// Ticket vocabulary
// ---------------------------------------------------------------------------

export const STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TicketStatus = (typeof STATUSES)[number];
export type TicketPriority = (typeof PRIORITIES)[number];

export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
};
export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** Raw bytes per file. Netlify Functions cap request bodies (~6 MB, base64-encoded), so we
 *  stay safely under it and downscale large images in the browser before upload. */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENTS = 3;
export const ACCEPTED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'csv', 'docx', 'xlsx'];
