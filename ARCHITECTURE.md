# Architecture

## 1. System overview

| Layer | Choice | Why |
|---|---|---|
| Hosting, API, jobs | **Netlify**: static files, Functions (API + embed page), Scheduled Function (sync every 5 min) | Founder already uses it; one deploy target; no servers. |
| Database | **Postgres** via Netlify Database (`NETLIFY_DB_URL`) or any Postgres such as Neon (`DATABASE_URL`) | Real relational data, row-level security for tenant isolation, one provider. Plain `pg` driver so the provider is swappable. |
| File storage | **Netlify Blobs** | Built into Netlify, no extra account. Files are the system of record; Drive gets a copy. |
| Admin auth | **Sign in with Google** + server-side sessions | Google OAuth is needed for Drive/Sheets anyway, so no extra identity service and no passwords to store. |
| Widget | **Loader script** (7 KB) → **Shadow DOM** launcher → **iframe** panel on our origin | Full CSS/JS isolation from the host site, and the browser can enforce the tenant's allowed domains. |
| Frontend | **Preact** + one hand-built design system, Lucide icons | Small bundles (panel ≈ 6 KB gz of app code), no UI framework lock-in. |
| AI | **Claude Haiku 4.5** behind an `AIProvider` interface, background job only | Cheap, fast; failure never affects tickets. |

Services required: Netlify, one Postgres, Google Cloud project (free), optionally Anthropic.

## 2. Request and data flow

```
┌──────────────── customer website (ecomeal.in) ────────────────┐
│ <script src="https://support.ecomeal.in/widget.js" data-key>  │
│   ├─ GET /api/widget/config?key=pk_…   (Origin/Referer checked)│
│   ├─ launcher button in a closed Shadow DOM                   │
│   └─ <iframe src="/embed/pk_…">  ← CSP frame-ancestors = tenant's allowed domains
└───────────────────────────────────────────────────────────────┘
              │ same-origin requests from the iframe, carrying:
              │   X-Widget-Key (publishable) + X-Embed-Token (HMAC, 12 h)
              ▼
   Netlify Function "api"  (/api/*)
     1. ensureReady(): apply pending migrations, create repo-defined tenants (once per instance)
     2. resolve key → tenant (active, key not revoked)
     3. same-origin check (Origin, else Sec-Fetch-Site), embed token check
     4. rate limits (IP, tenant, phone hash) — Postgres counters
     5. validation (Zod), phone → E.164
     6. ONE transaction, as role support_app with app.tenant_id set:
          customer upsert → ticket number (atomic counter) → ticket
          → link uploads → timeline events → outbox rows (integration_jobs)
     7. 201 { ticket: { number: "ECM-000123" } }       ← customer sees success here
     8. after the response (waitUntil): run this ticket's jobs
              │
              ▼
   integration_jobs (outbox)          Netlify Scheduled Function "sync" (*/5 * * * *)
     drive_upload  → Drive: Attachments/<date>/ECM-000123.png     picks up anything due, retries with backoff
     sheet_sync    → upsert Sheet row by ID      1m, 5m, 15m, 1h, 3h, 6h, 12h … then "failed"
     ai_triage     → category, priority hint, summary        (manual retry in dashboard)
```

**The database is the source of truth.** Google, AI and future WhatsApp only ever receive
copies. If any of them is down, tickets are still created, shown and worked.

## 3. Database

Postgres, 11 tables (`db/migrations/001_init.sql`):

| Table | Purpose |
|---|---|
| `tenants` | Company, ticket prefix + counter, `config` JSONB (brand, theme, copy, form, categories, timezone), allowed origins |
| `widget_keys` | Publishable keys, revocation, last seen origin/time (drives "Installed") |
| `admins`, `admin_sessions` | Team members per tenant with role; server-side sessions (token hashed with SHA-256) |
| `customers` | One per phone number per tenant |
| `tickets` | Snapshot of customer details + issue, status, priority, category, duplicate link, AI fields, meta |
| `attachments` | Metadata + blob key + Drive file id/link; `ticket_id` NULL until the ticket is submitted |
| `ticket_events` | Timeline and audit trail (created, status/priority/category changes, notes, AI, duplicate) |
| `integrations` | Per-tenant Google connection: encrypted credentials, folder/sheet ids |
| `integration_jobs` | Outbox with attempts, backoff, lease (`locked_until`), last error |
| `rate_limits` | Fixed-window counters |

Ticket numbers: `UPDATE tenants SET ticket_seq = ticket_seq + 1 … RETURNING` inside the ticket
transaction, formatted `PREFIX-000123`; unique per tenant and gap-free on success. Internally
every row has a UUID.

## 4. API

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /widget.js` | public | Loader |
| `GET /embed/:key` | public; framing limited by CSP | Panel HTML with tenant boot data |
| `GET /api/widget/config?key=` | publishable key + origin | Launcher config |
| `POST /api/widget/uploads` | key + embed token + same-origin | One file (≤ 4 MB), type sniffed from bytes |
| `POST /api/widget/tickets` | key + embed token + same-origin | Create ticket |
| `GET /api/auth/config` | public | Which sign-in options exist |
| `GET /api/auth/google/start`, `/callback` | — | Admin sign-in |
| `POST /api/auth/logout`, `/switch` | session | Sign out, switch workspace |
| `GET /api/admin/me`, `/overview` | session | Current user/tenant, real metrics |
| `GET /api/admin/tickets?q&status&priority&sort&page` | session | Search and filter |
| `GET /api/admin/tickets/:number-or-id` | session | Detail, attachments, timeline, sync state |
| `PATCH /api/admin/tickets/:id` | agent+ | Status, priority, category (events + Sheet update) |
| `POST /api/admin/tickets/:id/notes` | agent+ | Internal note |
| `GET /api/admin/attachments/:id` | session | Download (or `?inline=1` image preview) |
| `POST /api/admin/jobs/:id/retry` | agent+ | Retry a failed sync |
| `GET /api/admin/widget`, `PUT /origins`, `POST /keys`, `POST /keys/:id/revoke` | session / admin / owner | Install, domains, keys |
| `GET /api/admin/integrations`, `POST /google/disconnect` | session / admin | Status, failures |
| `GET /api/integrations/google/start`, `/callback` | admin | Tenant connects Google |
| `PUT /api/admin/settings` | admin | Tenant config (validated) |
| `GET/POST /api/admin/team`, `PATCH /team/:id` | session / admin | Members and roles |
| `GET /api/health` | public | Database reachable |

Errors are always `{ error: { code, message, fields? } }` with safe messages.

## 5. Widget

- **Loader** (`src/client/widget/loader.ts`, esbuild IIFE, ~7 KB): async, reads `data-key`,
  fetches config, renders a launcher in a **closed Shadow DOM** on a custom element whose host
  styles are pinned with `!important` inline styles, so host CSS cannot restyle, hide or move it.
  Creates the iframe on first open (warmed when the page is idle). Exposes
  `SupportWidget.open()/close()/toggle()`; `data-launcher="hidden"` supports custom triggers.
  Communicates with the iframe via `postMessage`, checking both origin and source window.
- **Panel** (`src/client/embed`): Preact app inside the iframe. Home (tenant copy, contact
  options, "Raise a ticket") → form → success. Uploads start as soon as a file is picked (with
  progress, retry for transient failures, client-side downscaling of large photos). The draft is
  kept in `sessionStorage`; last-used contact details in `localStorage` (both optional).
- **Mobile**: under 600 px the panel is full-screen (`100dvh`, safe-area aware) and inputs use
  16 px text so iOS doesn't zoom.
- **Accessibility**: focus moves into the panel on open and back to the launcher on close; Tab is
  trapped inside; Escape closes; labelled fields; errors announced; status region for success.

## 6. Authentication and authorisation

- Google OAuth (authorisation code flow) with a signed `state` bound to an HttpOnly nonce cookie.
  The `id_token` comes directly from Google's token endpoint; audience, issuer, expiry and
  `email_verified` are checked. Access is granted only if the email is an active member.
- Sessions: 32-byte random token in an HttpOnly, Secure, SameSite=Lax cookie (`__Host-` prefix
  in production); only its SHA-256 hash is stored; 14-day expiry; server-side revocation on
  logout, member removal, or workspace switch.
- CSRF: mutations require `X-Requested-With: fetch` (cannot be sent cross-site without a CORS
  preflight we never allow) and a same-origin request (Origin, else Sec-Fetch-Site).
- Roles: `viewer < agent < admin < owner`, enforced on every endpoint. A workspace cannot lose
  its last owner.

## 7. Tenant isolation

Two independent walls:

1. **Application**: tenant comes only from the server side (session or resolved widget key),
   never from request input. Every query filters by it.
2. **Database**: row-level security on every tenant table, `FORCE`d. All request work runs in
   `withTenant(id)`, which opens a transaction, switches to the restricted role `support_app`
   (`SET LOCAL ROLE`, no `BYPASSRLS`) and sets `app.tenant_id`. A query that forgets its
   `WHERE tenant_id` still only sees that tenant's rows; inserting a row for another tenant
   fails. A transaction with no tenant bound sees nothing. Cross-tenant "system" access exists
   only for key lookup, sign-in lookup, sessions, the job queue and rate limits.

Tested: `tests/isolation.test.ts` (list, detail by number and id, patch, notes, attachment
download, overview counts, raw SQL without WHERE, cross-tenant insert, unbound transaction).

## 8. Publishable keys and domain lock

`pk_live_…` keys are public by design. They can only (a) fetch branding and (b) create tickets.
They never read data. Protection against misuse:

- **Browser-enforced domain lock**: the panel is served with
  `Content-Security-Policy: frame-ancestors <tenant's allowed domains> 'self'`. On any other site
  the browser refuses to render it.
- Config requests check Origin (or Referer when the browser omits Origin on same-site requests).
- Ticket and upload calls must come from our own iframe (same-origin + a 12-hour HMAC embed token).
- Rate limits per IP (10 tickets / 10 min), per phone (6 / hour), per tenant (500 / hour);
  honeypot field; submissions faster than 3 s are refused.
- Keys can be rotated (create new → update snippet → revoke old).

No secret ever reaches a browser: database URL, session secret, encryption key, Google client
secret, tenant Google tokens and the Anthropic key exist only in Netlify environment variables
or encrypted in the database.

## 9. Storage and files

Uploads go to Netlify Blobs under `<tenant>/<yyyy-mm>/<random>.<ext>`. The file type is decided
from its bytes (PNG, JPEG, WebP, GIF, PDF, DOCX, XLSX, plain text/CSV); executables, HTML, SVG
and archives are refused. File names are sanitised. Downloads require a session, are tenant
scoped and served with `Content-Disposition`, `nosniff` and a sandboxing CSP. Unclaimed uploads
are deleted after 24 hours. The 4 MB per-file limit comes from Netlify's function request size;
larger files would need direct-to-storage uploads (future).

## 10. Google integration

- Each tenant connects its own Google account from Integrations (OAuth, offline access).
- Scope: **`drive.file` only**. The app can create and edit files it created, and nothing else in
  the tenant's Drive. It creates `"<Brand> Support"` folder → `"<Brand> Support — Tickets"`
  spreadsheet (tab "Tickets", bold frozen header) and an `Attachments` folder with one sub-folder
  per day (`2026-10-01`, tenant timezone). Files are named after the ticket (`ECM-000123.png`,
  `ECM-000123-2.pdf`); the customer's original file name is kept in the file's Drive description.
- Rows are written with `valueInputOption=RAW` so customer text is never evaluated as a formula.
  Rows are matched by ticket ID, so status changes update the same row.
- Refresh tokens are encrypted with AES-256-GCM. If Google access is revoked (`invalid_grant`)
  the integration turns to "Needs reconnecting" and jobs wait (status `blocked`) instead of
  failing; reconnecting resumes them. Reconnecting reuses the existing folder and sheet.
- Tickets created before Google is connected are synced when it is connected.

## 11. AI

`src/server/ai`: `AIProvider` interface; `ClaudeProvider` (Messages API with a forced tool call
for structured output, 15 s timeout, 3 attempts). Before sending, phone numbers and emails are
redacted; the customer's name, phone and restaurant are never sent. The model's suggestion
fills `ai_category`, `ai_priority`, `ai_summary`, `ai_reason`; it sets the category only if none
was chosen, and **never changes priority** — the dashboard offers a one-click "Set priority to X".
If `ANTHROPIC_API_KEY` is unset, AI is off and no job is queued.

## 12. Notifications

`src/server/notifications`: `NotificationService` fans out to providers; each failure is isolated.
V1 ships only a structured-log provider. Email and WhatsApp plug in here (see WHATSAPP.md).

## 13. Deployment and environments

One Netlify site from one repository. `npm run build:netlify` validates required settings
(clear failure messages), bundles migrations and tenant definitions into the functions, builds
the dashboard, panel and loader. No database access at build time; the app migrates itself on
the first request after a deploy (advisory-locked).

Environments: `APP_ENV` (`production` by default, `staging`, `development`). Each environment
has its own database and therefore its own Google connection, so development data can never
reach a production Sheet. Keys are prefixed `pk_live_` or `pk_test_` by environment.

## 14. Scaling and cost

| Stage | What changes |
|---|---|
| 1–10 tenants | Nothing. Netlify free/starter credits, Neon free tier or Netlify Database usage-based. Google APIs free. AI ≈ a fraction of a rupee per ticket on Haiku. |
| 10–100 | Paid Netlify tier for function volume; add trigram index for search; email notifications. |
| 100–1,000 | Direct-to-storage uploads; per-tenant Google app verification (External consent); background worker for heavy syncs; error monitoring. |
| 1,000+ | Partition `tickets`/`ticket_events` by tenant; read replica for dashboards; dedicated queue if job volume outgrows the 5-minute scheduler. |

Nothing in the data model needs to change for these steps.

Known limits of V1: the scheduled retry runs every 5 minutes (not instant); `context.waitUntil`
runs the first attempt right after the response when the platform supports it, otherwise the
scheduler picks it up; search uses `ILIKE`, fine for tens of thousands of tickets per tenant.

## 15. Future WhatsApp and AI

See WHATSAPP.md. For AI, the next layers (knowledge base answers before a ticket, routing,
reply drafts) sit behind the same `AIProvider` interface and run on the same job queue; the
ticket path stays AI-free.
