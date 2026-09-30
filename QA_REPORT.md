# QA report — V1

Date: 1 October 2026. Environment: local build (real Postgres 18, real browser: headless Chromium),
the same code that deploys to Netlify. Functions were also bundled with Netlify's own bundler
(`zip-it-and-ship-it`) and the bundled API function was executed against the database.

**PASS** means tested and working. **PASS (simulated)** means the real code path ran against a
faithful stand-in (e.g. a fake Google API) because the real service can't be reached from the
build environment. **BLOCKED** means it needs your accounts and will be verified on the live
deployment. Nothing is marked PASS on the strength of reading code.

## Summary

| Area | Status | Evidence |
|---|---|---|
| Widget loads async, doesn't block the page | PASS | Browser QA; `async` script, 7 KB (3 KB gzipped) |
| Widget unaffected by hostile host CSS | PASS | Demo page with Comic Sans, `!important` button/iframe/svg rules: widget identical |
| Tenant branding (colours, font, logo, copy) | PASS | Ecomeal config renders; changes in Settings apply without deploy |
| Open/close, Escape, focus return, focus trap | PASS | Browser QA |
| Desktop 1440, tablet 768, phone 390/375, small 320 | PASS | Screenshots at each size, overflow check |
| Ticket form validation (client + server) | PASS | 4 field errors shown, focus moves to first; server rejects same cases |
| Indian phone formats, invalid numbers rejected | PASS | Tests: `+91 98765 43210`, `09876543210`, `919876543210`, `98765-43210` accepted; short/invalid rejected |
| Attachments: upload, progress, remove, retry | PASS | Browser QA + tests |
| Attachments: bad types (exe, html, svg, zip, disguised) and >4 MB rejected | PASS | Tests |
| Ticket submission → `ECM-000001…` | PASS | Browser QA + tests; 12 concurrent submissions got 12 unique sequential numbers |
| Success screen, copyable ID | PASS | Browser QA |
| Network failure keeps the form data | PASS | Browser QA (request aborted), banner shown, data intact, resubmit works |
| Submitting / loading states | PASS | Screenshot while request held open |
| Domain lock (other sites can't show the panel) | PASS | Browser refused to frame the embed from an unlisted origin (CSP `frame-ancestors`) |
| Unknown / revoked key | PASS | Tests (404/401); loader logs one warning, no errors |
| Tenant isolation | PASS | 8 tests: list, search, detail by number and by id, patch, notes, attachment download, overview counts, raw SQL without WHERE, cross-tenant insert, unbound transaction |
| Admin sign-in with Google (flow logic) | PASS (simulated) | Tests: listed admin gets a session; unknown email refused; forged state refused; no open redirect |
| Admin sign-in with real Google | BLOCKED | Needs your Google OAuth client |
| Sessions, logout revocation, removed member signed out | PASS | Tests |
| CSRF protection on admin changes | PASS | Tests: missing header or foreign origin → 403 |
| Roles (viewer read-only, last owner protected) | PASS | Tests |
| Dashboard: overview, list, search, filter, sort, detail | PASS | Browser QA desktop/laptop/phone |
| Status, priority, notes, timeline, persistence after reload | PASS | Browser QA + tests |
| Attachment previews and downloads in dashboard | PASS | Browser QA |
| Widget page: snippet, "Installed" detection, preview, domains, keys | PASS | Browser QA ("Installed" flipped after the demo site loaded the widget) |
| Settings and team | PASS | Browser QA + tests |
| Google Sheets sync (create sheet, append, update same row, RAW values) | PASS (simulated) | Tests against fake Google API |
| Google Drive (folder per ticket, uploads, links in Sheet) | PASS (simulated) | Tests against fake Google API |
| Real Google Sheets / Drive | BLOCKED | Needs your Google Cloud project; verify on live site |
| Google failure never loses a ticket; retries; manual retry | PASS (simulated) | Tests: Sheets returning 500 → ticket 201, retries, "failed" after max, retry recovers |
| Google access revoked → sync pauses, reconnect resumes | PASS (simulated) | Tests |
| AI triage (fields, timeline, no auto-priority, PII redaction) | PASS (simulated) | Tests with stand-in provider |
| AI failure never affects the ticket | PASS | Tests |
| Real Claude API call | BLOCKED | Needs `ANTHROPIC_API_KEY` |
| Storage outage during upload | PASS | Test: clean 503, nothing half-saved |
| Database outage | PASS | Test: safe 500 message, no internal details; recovers when DB returns |
| No secrets in browser code | PASS | Built assets scanned; only help text naming variables, no values |
| Logs without personal data | PASS | Phone/email masked; ticket text never logged |
| Netlify function bundling | PASS | Bundled with Netlify's bundler; bundled API answered against the database |
| Deployed on Netlify at support.ecomeal.in | BLOCKED | Needs your GitHub repo and Netlify site |
| Scheduled sync every 5 minutes on Netlify | BLOCKED | Recognised by the bundler (`*/5 * * * *`); runs once deployed |
| WhatsApp | NOT DONE (by design) | See WHATSAPP.md |

Automated tests: **57 passing** (`npm test`). Browser QA: **67 screenshots, 0 issues** on the
final run (`npm run qa`).

## Definition of Done (your 30 steps)

| # | Step | Status |
|---|---|---|
| 1 | Deploy the platform | BLOCKED (your GitHub + Netlify) |
| 2 | Create Ecomeal as a tenant | PASS (automatic on first request) |
| 3 | Widget key generated | PASS |
| 4 | Paste one script into a website | PASS (demo site) |
| 5–8 | See widget, open, Ecomeal branding, Raise a ticket | PASS |
| 9–11 | Name, phone, restaurant, problem, screenshot, submit | PASS |
| 12 | Receive `ECM-XXXXXX` | PASS |
| 13–21 | Dashboard: see, open, customer, attachment, priority, status, note, timeline | PASS |
| 22 | Ticket in Google Sheets | PASS (simulated); live: BLOCKED |
| 23 | Attachment in Google Drive | PASS (simulated); live: BLOCKED |
| 24–25 | Refresh, data persists | PASS |
| 26 | Other tenant can't access Ecomeal data | PASS |
| 27–28 | Mobile and desktop | PASS |
| 29 | Integration failure doesn't destroy tickets | PASS |
| 30 | No secrets exposed in browser | PASS |

## Visual review notes (fixed during QA)

- Contact list hover area overflowed the panel by 8 px → hairlines realigned to the text column.
- Phone number wrapped across lines on the success screen and ticket sidebar → kept on one line.
- Admin name showed the company name (column name clash in the session query) → fixed.
- "Waiting for Google" counted sync jobs, not tickets → now counts tickets.
- Timeline events written in the same transaction could appear out of order → ordered by clock time.
- Retry button showed for files that can never succeed (wrong type) → only for transient failures.
- Mobile ticket page showed side panels before the issue → reordered: controls, issue, attachments, customer, timeline.
- Images appeared twice on the ticket page → one tile with open, Drive and download actions.

## Known limitations (not defects)

- Attachments up to 4 MB each (Netlify function request size). Larger photos are downscaled in
  the browser; larger PDFs are refused with a clear message.
- Retries run every 5 minutes; the first attempt runs right after submission.
- Search is substring matching, fine to tens of thousands of tickets per company.
- New companies are added with a file in the repository (no self-serve sign-up screen yet).
