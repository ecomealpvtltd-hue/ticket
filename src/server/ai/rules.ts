// Rule-based triage. Runs instantly inside ticket creation with no external service, so every
// ticket gets a category and a suggested priority even when AI is off. If AI is configured it
// may refine a rules-based category later; a category chosen by the customer or an agent is
// never overwritten.

import type { TicketPriority } from '../../shared/constants.js';

interface Bucket { category: string; aliases: string[]; keywords: RegExp }

// Keyword families for restaurant / B2B software support, including common Hinglish.
// The first matching family with the most hits wins. Tenants keep their own category names:
// a family only applies if the tenant has a category matching one of its aliases.
const BUCKETS: Bucket[] = [
  {
    category: 'Integration',
    aliases: ['integration', 'integrations', 'aggregator'],
    keywords: /\b(swiggy|zomato|ondc|magicpin|dunzo|zepto|aggregator|integration|api|webhook|sync(?:ing)?|menu sync|petpooja|posist|rista|tally|zoho|whatsapp|razorpay|paytm|phonepe|pine ?labs)\b/gi,
  },
  {
    category: 'Order issue',
    aliases: ['order issue', 'orders', 'order', 'order problem'],
    keywords: /\b(orders?|kot|kots|delivery|deliveries|rider|cancel(?:led|lation)?|refund(?:ed)?|wrong item|missing item|takeaway|dine[- ]?in|table|token|order nahi|order nhi)\b/gi,
  },
  {
    category: 'Billing',
    aliases: ['billing', 'payments', 'payment', 'invoice', 'invoices', 'accounts'],
    keywords: /\b(bill(?:ing)?|invoices?|gst|gstin|tax|payments?|paid|charged?|charges|subscription|plan|renewal|price|pricing|amount|upi|card|receipt|credit note|due|overcharg\w*|paisa|paise)\b/gi,
  },
  {
    category: 'Account',
    aliases: ['account', 'login', 'access', 'account access'],
    keywords: /\b(log ?in|log ?out|sign ?in|password|otp|account|access|user|users|staff login|permission|role|locked|blocked|email change|phone change)\b/gi,
  },
  {
    category: 'Hardware',
    aliases: ['hardware', 'device', 'devices', 'equipment'],
    keywords: /\b(printer|printing|print|thermal|paper roll|tablet|ipad|kds|display|screen|scanner|barcode|cash drawer|router|wifi|wi-fi|internet|device|hardware|battery|charger|keyboard|mouse|cable)\b/gi,
  },
  {
    category: 'Technical issue',
    aliases: ['technical issue', 'technical', 'bug', 'software', 'technical problem'],
    keywords: /\b(error|bug|crash(?:ed|es|ing)?|freez\w*|hang(?:s|ing)?|slow|not working|stopped|down|blank|loading|glitch|issue|problem|update|app|software|pos|kitchen display|stock|inventory|report|reports|data|band hai|kaam nahi|nahi chal|nhi chal|chal nahi)\b/gi,
  },
];

const URGENT = /\b(can'?t|cannot|unable to|not able to|no|zero)\s+(take|receive|accept|get|process|punch)\s+(any\s+)?(orders?|payments?)|\b(orders?|payments?)\s+(not\s+(coming|arriving|working|going)|stopped|band)|\b(complete(ly)?|full(y)?|total(ly)?)\s+(down|outage|stopped)|\boutage\b|\blosing\s+(customers|orders|money|sales|business)|\b(restaurant|kitchen|outlet|store|system|pos)\s+(is\s+)?(down|stopped|shut)|\bpeak hours?\b.*\b(down|stopped|not working)/i;
const HIGH = /\b(urgent|asap|immediately|emergency|critical|right now|jaldi|turant|not (working|printing|loading|opening|syncing|coming|showing|connecting|responding)|stopped|crash(?:ed|es|ing)?|down|failed|failing|wrong (amount|bill|charge)|double charged|overcharged|refund)\b/i;
const LOW = /\b(how (do|can|to)|question|query|request|feature|suggestion|would like|can you add|please add|change (my|the) (name|logo|email|phone)|information|info|demo|training|when will)\b/i;

export interface RuleTriage { category: string | null; priority: TicketPriority; reason: string }

function norm(s: string) { return s.trim().toLowerCase(); }

/** Map a family to the tenant's own category name, if the tenant has one for it. */
function tenantCategory(bucket: Bucket, categories: string[]): string | null {
  const names = new Map(categories.map((c) => [norm(c), c]));
  for (const a of [bucket.category, ...bucket.aliases]) {
    const hit = names.get(norm(a));
    if (hit) return hit;
  }
  return null;
}

export function classify(text: string, categories: string[]): RuleTriage {
  const t = text.slice(0, 5000);
  let best: { category: string; hits: number; words: string[] } | null = null;
  for (const b of BUCKETS) {
    const name = tenantCategory(b, categories);
    if (!name) continue;
    const matches = [...t.matchAll(b.keywords)].map((m) => m[0].toLowerCase());
    if (!matches.length) continue;
    // Order matters as a tie-break: more specific families (integrations, orders) come first.
    if (!best || matches.length > best.hits) best = { category: name, hits: matches.length, words: [...new Set(matches)].slice(0, 4) };
  }
  const other = categories.find((c) => norm(c) === 'other') ?? null;

  let priority: TicketPriority = 'medium';
  let why = 'No urgency signals found';
  if (URGENT.test(t)) { priority = 'urgent'; why = 'The customer cannot operate or is losing sales'; }
  else if (HIGH.test(t)) { priority = 'high'; why = 'Something is broken or money is wrong'; }
  else if (LOW.test(t)) { priority = 'low'; why = 'Reads like a question or request'; }

  const category = best?.category ?? other;
  const reason = best ? `Matched: ${best.words.join(', ')}. ${why}.` : `${why}.`;
  return { category, priority, reason };
}
