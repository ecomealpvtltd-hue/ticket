// Notifications are an extension point, not a V1 dependency. Providers (email, WhatsApp, SMS)
// plug in here and are called from background work, never from the ticket transaction.

import { log } from '../log.js';

export type NotificationEvent =
  | { type: 'ticket.created'; tenantSlug: string; ticketNumber: string; priority: string }
  | { type: 'ticket.status_changed'; tenantSlug: string; ticketNumber: string; status: string };

export interface NotificationProvider {
  readonly name: string;
  send(event: NotificationEvent): Promise<void>;
}

/** Default provider: a structured log line (no personal data). */
class LogProvider implements NotificationProvider {
  readonly name = 'log';
  async send(event: NotificationEvent) {
    log.info('notify', { ...event });
  }
}

const providers: NotificationProvider[] = [new LogProvider()];

export function registerNotificationProvider(p: NotificationProvider) {
  providers.push(p);
}

/** Fan out to every provider; one provider failing never affects another or the caller. */
export async function notify(event: NotificationEvent) {
  await Promise.all(
    providers.map((p) =>
      p.send(event).catch((err) => log.warn('notify.provider_failed', { provider: p.name, type: event.type, message: String(err?.message ?? err) })),
    ),
  );
}
