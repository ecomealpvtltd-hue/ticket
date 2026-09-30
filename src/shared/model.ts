// Tenant configuration: everything that makes one tenant's support experience look and read
// differently from another's. Stored as JSONB on the tenant row and validated here, so a new
// tenant gets sensible defaults for anything it does not set.

import { z } from 'zod';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour like #1A2B3C');
const httpsUrl = z.string().url().refine((u) => /^https:\/\//.test(u) || /^http:\/\/localhost[:/]/.test(u), 'Must be an https URL');

export const contactOptionSchema = z.object({
  type: z.enum(['email', 'phone', 'link']),
  label: z.string().min(1).max(60),
  value: z.string().min(1).max(300),
  description: z.string().max(120).optional(),
});

export const tenantConfigSchema = z.object({
  brand: z.object({
    name: z.string().min(1).max(80).default('Support'),
    logoUrl: httpsUrl.optional(),
    websiteUrl: httpsUrl.optional(),
  }).prefault({}),
  theme: z.object({
    mode: z.enum(['light', 'dark']).default('light'),
    accent: hex.default('#111827'),
    accentText: hex.default('#FFFFFF'),
    background: hex.optional(),
    surface: hex.optional(),
    text: hex.optional(),
    fontFamily: z.string().max(60).regex(/^[A-Za-z0-9 ]*$/).optional(),
    /** Google Fonts family spec, e.g. "Instrument+Sans:wght@400;500;600" */
    googleFont: z.string().max(120).regex(/^[A-Za-z0-9+:;@,.]*$/).optional(),
  }).prefault({}),
  launcher: z.object({
    label: z.string().min(1).max(24).default('Support'),
    position: z.enum(['right', 'left']).default('right'),
    offsetX: z.number().int().min(0).max(120).default(20),
    offsetY: z.number().int().min(0).max(120).default(20),
  }).prefault({}),
  copy: z.object({
    title: z.string().max(60).default('Support'),
    heading: z.string().max(80).default('How can we help?'),
    description: z.string().max(240).default("We're here to help you resolve your issue quickly."),
    ticketCta: z.string().max(40).default('Raise a ticket'),
    ticketCtaDescription: z.string().max(140).default("Tell us what went wrong. You'll get a ticket ID to track it."),
    formHeading: z.string().max(60).default('Raise a ticket'),
    formDescription: z.string().max(200).default("Tell us what happened and we'll help you resolve it."),
    successHeading: z.string().max(60).default('Ticket submitted'),
    successMessage: z.string().max(240).default('Your support request has been received. Our team will review it and get back to you.'),
  }).prefault({}),
  contactOptions: z.array(contactOptionSchema).max(5).default([]),
  form: z.object({
    orgLabel: z.string().max(40).default('Company name'),
    orgPlaceholder: z.string().max(60).default(''),
    descriptionLabel: z.string().max(60).default('What went wrong?'),
    descriptionPlaceholder: z.string().max(160).default('Describe the issue. Include what you were doing and when it started.'),
    defaultCountry: z.string().length(2).default('IN'),
    showCategory: z.boolean().default(false),
    allowAttachments: z.boolean().default(true),
  }).prefault({}),
  categories: z.array(z.string().min(1).max(40)).max(20).default(['Technical issue', 'Billing', 'Account', 'Other']),
  timezone: z.string().max(60).default('UTC'),
  poweredBy: z.boolean().default(false),
  ai: z.object({ enabled: z.boolean().default(true) }).prefault({}),
});

export type TenantConfig = z.infer<typeof tenantConfigSchema>;
export type ContactOption = z.infer<typeof contactOptionSchema>;

export function parseTenantConfig(raw: unknown): TenantConfig {
  return tenantConfigSchema.parse(raw ?? {});
}

/** Safe fallback when a stored config is somehow invalid: never break a live widget. */
export function parseTenantConfigLenient(raw: unknown): TenantConfig {
  const r = tenantConfigSchema.safeParse(raw ?? {});
  return r.success ? r.data : tenantConfigSchema.parse({});
}

export * from './constants.js';
