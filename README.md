# Support Platform

An embeddable customer support and ticketing platform. A company adds one script tag to its
website; its customers get a branded support panel where they can raise a ticket with
attachments; the company's team works the tickets in a dashboard; every ticket is copied to the
company's own Google Sheet and Drive. Ecomeal is the first company (tenant) on it.

- **Widget** — `widget.js`, one script tag, works on any website.
- **Dashboard** — `/admin`, Google sign-in, tickets, notes, timeline, settings.
- **Integrations** — Google Sheets + Drive per tenant, optional AI triage (Claude).
- **Multi-tenant** — every company is a row of configuration, not a code change.

Everything runs on **one Netlify site** plus **one Postgres database** plus **Google APIs**.

---

## 1. How it fits together

```
Customer website ──<script src=".../widget.js" data-key="pk_live_…">
      │  launcher button (Shadow DOM)       support panel (iframe, our domain)
      ▼                                                │
  GET /api/widget/config                    POST /api/widget/uploads  (files → Netlify Blobs)
                                            POST /api/widget/tickets  (one DB transaction)
                                                       │
                                            Postgres ◄─┘  ← source of truth
                                                       │  outbox (integration_jobs)
                                 ┌─────────────────────┼─────────────────────┐
                                 ▼                     ▼                     ▼
                           Google Sheet           Google Drive           AI triage
                       (retries every 5 min via the scheduled "sync" function)
```

Full detail: [ARCHITECTURE.md](ARCHITECTURE.md). Product flows: [PRODUCT.md](PRODUCT.md).
Test results: [QA_REPORT.md](QA_REPORT.md). WhatsApp plan: [WHATSAPP.md](WHATSAPP.md).

---

## 2. Deploy (first time, about 30 minutes)

You need: this GitHub repository, a Netlify account, and a Google Workspace admin login.

### Step 1 — Netlify site
1. Netlify → **Add new site → Import an existing project → GitHub** → pick this repository.
2. Leave build settings as detected (they come from `netlify.toml`). Click **Deploy**.
   The first deploy will fail with a list of missing settings. That is expected.

### Step 2 — Database (pick one)
- **Netlify Database** (simplest, needs a credit-based Netlify plan): site → **Database** →
  enable it. Nothing else to configure; the app finds it automatically.
- **Neon** (free tier works on any Netlify plan): create a project at neon.tech, copy the
  *pooled* connection string, and set it as `DATABASE_URL` in step 3.

The app creates its own tables on first use. No manual SQL.

### Step 3 — Environment variables
Netlify → **Site configuration → Environment variables**. Add:

| Name | Value |
|---|---|
| `PUBLIC_BASE_URL` | `https://support.ecomeal.in` |
| `SESSION_SECRET` | a random string, 40+ characters (use a password generator) |
| `ENCRYPTION_KEY` | a *different* random string, 40+ characters. **Never change it later.** |
| `BOOTSTRAP_OWNER_EMAILS` | your Google Workspace email, e.g. `you@ecomeal.in` |
| `DATABASE_URL` | only if you chose Neon |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from step 5 |
| `ANTHROPIC_API_KEY` | optional, turns on AI triage |

Then **Deploys → Trigger deploy**. The build now passes.

### Step 4 — Domain
Netlify → **Domain management → Add a domain** → `support.ecomeal.in`. At your DNS provider add
the CNAME record Netlify shows. HTTPS is issued automatically.

### Step 5 — Google (sign-in + Sheets + Drive)
In [Google Cloud Console](https://console.cloud.google.com), signed in with your Workspace account:
1. Create a project, e.g. "Ecomeal Support".
2. **APIs & Services → Library**: enable **Google Drive API** and **Google Sheets API**.
3. **OAuth consent screen**: User type **Internal** (Workspace only, no Google review needed).
   App name "Ecomeal Support", support email, then add scopes `openid`, `email`, `profile`,
   `.../auth/drive.file`.
4. **Credentials → Create credentials → OAuth client ID → Web application**. Add these
   *Authorised redirect URIs*:
   - `https://support.ecomeal.in/api/auth/google/callback`
   - `https://support.ecomeal.in/api/integrations/google/callback`
5. Copy the client ID and secret into Netlify (step 3) and redeploy.

> **Internal** means only `@ecomeal.in` accounts can sign in or connect. When you onboard other
> companies, switch the consent screen to **External** and submit it for verification. The app
> only uses `drive.file` (access to files it creates), which keeps that review light.

### Step 6 — First sign-in and connect Google
1. Open `https://support.ecomeal.in/admin` → **Continue with Google** with the email you put in
   `BOOTSTRAP_OWNER_EMAILS`.
2. **Integrations → Connect Google** → allow access. The app creates a Drive folder
   "Ecomeal Support" with a spreadsheet "Ecomeal Support — Tickets" inside it.
3. **Widget** → copy the snippet.

### Step 7 — Install the widget
Paste the snippet before `</body>` on ecomeal.in (and any other site listed under
**Widget → Allowed domains**):

```html
<script src="https://support.ecomeal.in/widget.js" data-key="pk_live_…" async></script>
```

The Widget page flips to **Installed** once it loads on your site.

---

## 3. Run locally (for development)

Requires Node 22+. Nothing else: Postgres runs embedded.

```bash
npm install
npm run dev
```

- Dashboard: http://localhost:8888/admin — use the **Local development sign-in** with `dev@ecomeal.in`
- Demo customer website with the widget: http://localhost:8899 (hostile CSS) and http://localhost:8899/clean.html

Local development sign-in exists only when `APP_ENV=development` **and** the request is to
localhost; it is impossible to enable on a deployed site.

---

## 4. Everyday tasks

**Add a team member** — Settings → Team → email + role. They sign in with Google.
Roles: Owner (everything), Admin (settings, integrations, team), Agent (work tickets), Viewer (read only).

**Change branding or text** — Settings. Changes are live immediately; no deploy.

**Allow another domain** — Widget → Allowed domains (e.g. `https://*.ecomeal.in`).

**Rotate a widget key** — Widget → Keys → New key, update the snippet on your site, then revoke the old key.

**A ticket didn't reach the Sheet** — Integrations → Sync failures → Retry. The ticket itself is
always safe in the database; only the copy failed.

---

## 5. Add a new company (tenant)

1. Copy `tenants/ecomeal.json` to `tenants/<slug>.json`. Change `slug`, `name`,
   `ticketPrefix` (2–6 capital letters, e.g. `XYZ`), `allowedOrigins`, and the `config` block
   (brand, colours, copy, contact options, categories).
2. Commit and push. On the next request after deploy, the tenant and its widget key are created.
3. Add the first owner: set `BOOTSTRAP_OWNER_EMAILS` to include their email (owners are only
   added to tenants that have none), or add them yourself from a workspace you both belong to.
4. They sign in, connect their own Google account, and copy their snippet from **Widget**.

Tenant files are **create-only**: once created, the tenant's settings live in the database and
are edited in the dashboard. Editing the JSON later does not overwrite them.

---

## 6. Testing

```bash
npm test          # 57 backend tests on a real Postgres (tenant isolation, security, failures)
npm run typecheck
npm run qa        # starts nothing; run `npm run dev` first. Drives a real browser through the
                  # widget and dashboard at desktop, tablet and phone sizes; screenshots in /var/tmp/qa
```

---

## 7. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Deploy fails with "missing required settings" | Add the listed variables (step 3), redeploy. |
| Widget doesn't appear; browser console says "not in the widget's allowed domains" | Add the site under Widget → Allowed domains. |
| Widget button appears, panel is blank | The page's domain is not allowed (the browser blocks framing). Same fix as above. |
| "This Google account isn't a member…" at sign-in | Add the email under Settings → Team, or check `BOOTSTRAP_OWNER_EMAILS` for a new workspace. |
| Integrations shows "Needs reconnecting" | Google access was revoked or expired. Click **Reconnect Google**; waiting tickets sync automatically. |
| Sheet or Drive missing a ticket | Integrations → Sync failures → Retry. |
| Google stopped working after changing `ENCRYPTION_KEY` | Stored credentials can't be decrypted. Reconnect Google. |
| `/api/health` returns 500 | Database unreachable: check Netlify Database is enabled or `DATABASE_URL` is right. |

Function logs: Netlify → **Logs → Functions** (`api`, `embed`, `sync`). Logs never contain full
phone numbers, emails or ticket text.
