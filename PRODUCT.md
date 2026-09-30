# Product

## What it is

Support infrastructure a company adds to its website with one line of code: a branded support
panel for its customers, a ticket dashboard for its team, and automatic copies of every ticket in
its own Google Sheet and Drive. Ecomeal is the first company using it; every other company gets
the same product with its own brand, key, data, team and Google account.

## Users

| Who | What they do |
|---|---|
| **Customer** (e.g. restaurant staff) | Opens support on the company's site, sees contact options, raises a ticket in under a minute, gets a ticket ID. |
| **Agent** | Finds and works tickets: changes status and priority, adds internal notes, opens attachments. |
| **Admin** | Brand, copy, form, categories, allowed domains, Google connection, team. |
| **Owner** | Everything an admin does, plus widget keys and owners. |
| **Platform operator** (us) | Adds companies (tenant files), runs deploys. |

## Customer flow

1. Clicks **Support** (bottom corner) on the company's website.
2. Sees the company's support panel: heading, short description, contact options (email, phone,
   links), and **Raise a ticket**.
3. Fills name, phone (country code preselected, India by default), restaurant name and what went
   wrong; optionally attaches up to 3 files (uploaded immediately, with progress).
4. Submits and gets **Ticket submitted** with a copyable ticket ID, e.g. `ECM-000123`.

If the network fails, the form keeps everything and says so. If the panel is closed by accident,
the draft is restored when it reopens.

## Agent flow

1. Signs in with Google at `/admin`.
2. **Overview**: open, in progress, resolved, total (real counts), and the tickets needing attention.
3. **Tickets**: search by ticket ID, name, phone, restaurant or text; filter by status and priority;
   sort by newest, oldest, priority or recent activity. Phones get a card layout.
4. **Ticket**: issue, attachments (image previews, downloads, Drive links), timeline, internal
   notes, status, priority, category, customer details and history, sync state per integration.
   When AI is on: a one-line summary and a suggested priority the agent can apply with one click.

Status: Open → In progress → Resolved → Closed (any transition allowed, all recorded).
Priority: Low, Medium, High, Urgent.

## Admin flow (onboarding a company)

1. Operator adds `tenants/<company>.json` (brand, prefix, domains) and the first owner's email.
2. Owner signs in → **Settings**: brand name, logo, colours, font, launcher label/position,
   panel text, contact options, form labels, categories, timezone, team.
3. **Integrations → Connect Google**: folder and spreadsheet are created in their Drive.
4. **Widget**: copy the snippet, see a live preview, manage allowed domains and keys. The page
   shows "Waiting for installation" and switches to "Installed" once the widget loads on their site.

## Integration flow

Ticket saved → response to the customer → copies made in the background:
Drive folder `ECM-000123/` with attachments → Sheet row (updated on every change) → AI summary.
Each shows as Synced, Pending, Retrying, Waiting for Google or Failed on the ticket, and failures
are listed under Integrations with a Retry button.

## Principles

- The ticket is never lost: the database commit is the only thing between the customer and success.
- Integrations and AI are copies and suggestions, never the source of truth.
- The panel belongs to the company: their name, colours and words; no platform branding by default.
- No fake data: every number on screen comes from real tickets.

## Roadmap

| Next | Why |
|---|---|
| Email notification to the support team on new/urgent tickets | Fastest win for response time. |
| Customer-facing "track my ticket" by ID + phone | Fewer "any update?" calls. |
| Agent assignment and "mine" view | Needed once the team grows past 3–4 agents. |
| Platform console for creating tenants in the UI | Self-serve onboarding without a deploy. |
| WhatsApp notifications (see WHATSAPP.md) | Restaurants live on WhatsApp. |
| SLA timers, CSAT after resolution | Enterprise requirements. |
| Knowledge base + AI answer before ticket | Deflect repeat questions. |
| Webhooks, public API, SSO, billing and usage metering | Selling to larger companies. |
