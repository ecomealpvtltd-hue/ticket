import { describe, it, expect } from 'vitest';
import { classify } from '../src/server/ai/rules.js';
import { withTenant } from '../src/server/db.js';
import { admin, createTestTenant, embedToken, submitTicket, validTicket } from './helpers.js';

const ECOMEAL = ['Technical issue', 'Order issue', 'Billing', 'Account', 'Integration', 'Hardware', 'Other'];

describe('rules-based triage (no AI needed)', () => {
  const cases: Array<[string, string, string]> = [
    ['Swiggy orders not coming since 7 PM, tablet says sync failed', 'Integration', 'urgent'],
    ['Zomato menu sync is not updating prices', 'Integration', 'medium'],
    ['Kitchen printer stopped printing KOTs after lunch', 'Hardware', 'high'],
    ['We were double charged on this month’s invoice, please refund', 'Billing', 'high'],
    ['Please add our GST number to invoices', 'Billing', 'low'],
    ['Staff cannot log in, OTP never arrives', 'Account', 'medium'],
    ['Wrong item delivered and customer asking for refund on order 4821', 'Order issue', 'high'],
    ['App crashes when I open reports', 'Technical issue', 'high'],
    ['POS is down, cannot take any orders, losing customers', 'Technical issue', 'urgent'],
    ['How do I change my restaurant logo?', 'Other', 'low'],
    ['system band hai, order nahi aa raha', 'Order issue', 'medium'],
  ];
  for (const [text, category, priority] of cases) {
    it(`"${text.slice(0, 40)}…" → ${category}, ${priority}`, () => {
      const r = classify(text, ECOMEAL);
      expect(r.category).toBe(category);
      expect(r.priority).toBe(priority);
    });
  }

  it("uses the tenant's own category names and falls back to Other", () => {
    expect(classify('printer broken', ['Devices', 'Payments', 'Other']).category).toBe('Devices');
    expect(classify('printer broken', ['Payments', 'Misc']).category).toBe(null);
    expect(classify('hello there', ECOMEAL).category).toBe('Other');
  });

  it('new tickets are bucketed automatically, and the team can override', async () => {
    const t = await createTestTenant({ config: { categories: ECOMEAL } });
    const { data } = await submitTicket(t, await embedToken(t), validTicket({ description: 'Kitchen printer is not printing KOTs since morning' }));
    const d = (await admin(t, 'GET', `/api/admin/tickets/${data.ticket.number}`)).data;
    expect(d.category).toBe('Hardware');
    expect(d.categorySource).toBe('rules');
    expect(d.ai.priority).toBe('high');
    expect(d.priority).toBe('medium'); // suggestion only; a person decides
    const after = (await admin(t, 'PATCH', `/api/admin/tickets/${d.id}`, { category: 'Technical issue' })).data;
    expect(after.categorySource).toBe('agent');
    const row = await withTenant(t.id, async (db) => (await db.query(`SELECT category FROM tickets WHERE id = $1`, [d.id])).rows[0]);
    expect(row.category).toBe('Technical issue');
  });

  it("a customer's chosen topic is kept", async () => {
    const t = await createTestTenant({ config: { categories: ECOMEAL } });
    const { data } = await submitTicket(t, await embedToken(t), validTicket({ category: 'Billing', description: 'Printer is broken and also a question' }));
    const d = (await admin(t, 'GET', `/api/admin/tickets/${data.ticket.number}`)).data;
    expect(d.category).toBe('Billing');
    expect(d.categorySource).toBe('customer');
  });
});
