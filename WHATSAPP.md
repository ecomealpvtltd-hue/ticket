# WhatsApp: assessment and plan

**Status: NOT IMPLEMENTED.** There is no WhatsApp code in V1, by design. This document is the
plan for adding it.

## What Meta's platform requires (as of October 2026)

- **WhatsApp Business Platform (Cloud API)**, hosted by Meta. Needs a Meta Business account
  (business verification recommended), a phone number dedicated to the API (it can't stay on
  the WhatsApp Business app at the same time), and a display name approved by Meta.
- **Templates**: any message a business starts, or sends more than 24 hours after the customer
  last wrote, must use a pre-approved template (e.g. *utility*: "Your support ticket {{1}} has
  been created. We'll update you here."). Free-form replies are allowed only inside the
  24-hour customer service window.
- **Pricing**: per delivered template message since July 2025. Utility templates sent inside an
  open customer service window are free; outside it they are charged. India billing moved to INR
  on 1 January 2026. Rates change periodically: check Meta's rate card before launch.
- **Webhooks** deliver incoming messages and delivery/read receipts; they must be verified with
  the app secret signature.

Sources: Meta, [Pricing on the WhatsApp Business Platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing).

## Recommended phases

1. **Notify on ticket created (utility template)** — "Ticket ECM-000123 received". Requires the
   customer's consent at submission (add an opt-in checkbox to the form; store it on the ticket).
2. **Status updates** — a template when a ticket is resolved.
3. **Two-way** — incoming messages attach to the customer's open ticket as customer replies
   (needs a `ticket_messages` table and an inbox view).
4. **WhatsApp as an intake channel** — a new ticket from an inbound message, optionally with AI
   answering first from a knowledge base.

## How it plugs in

- A `WhatsAppProvider` implementing `NotificationProvider` (`src/server/notifications`), called
  from the job queue as a new job kind `whatsapp_notify`, so failures retry and never affect tickets.
- Per-tenant settings in `integrations` (`provider = 'whatsapp'`): phone number id, WABA id,
  encrypted access token, approved template names.
- A webhook function `/api/integrations/whatsapp/webhook` with signature verification, mapping
  the receiving phone number id to a tenant.

## Business decisions needed before building

- Which number sends messages (a new support number vs moving an existing one to the API).
- Whether Ecomeal uses Meta directly or a Business Solution Provider (easier onboarding, adds a
  per-message markup).
- Customer consent wording on the form.
