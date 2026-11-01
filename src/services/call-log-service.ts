// Logs each call and keeps one contact per caller, keyed by normalised phone
// number, so returning callers can be recognised.
import { DateTime } from 'luxon';
import { type ShopConfig, shop } from '../config/shop.ts';
import { normalizePhone } from '../domain/phone.ts';
import { createLogger, type Logger } from '../lib/logger.ts';
import { SerialQueue } from '../lib/serial-queue.ts';
import type { CallLogStore, Contact } from './ports.ts';

export type CallLog = {
  // May be missing if the caller hung up before giving a number.
  phone?: string | undefined;
  name?: string | undefined;
  intent: string;
  summary: string;
  outcome: string;
  needsHuman: boolean;
  eventId?: string | undefined;
};

export type LogCallResult = {
  ok: true;
  phone: string | null;
  contactUpdated: boolean;
  contactError?: string;
};

export type CallLogServiceDeps = {
  store: CallLogStore;
  config?: ShopConfig;
  now?: () => DateTime;
  logger?: Logger;
};

export class CallLogService {
  private readonly store: CallLogStore;
  private readonly config: ShopConfig;
  private readonly now: () => DateTime;
  private readonly log: Logger;
  // Serialises read-modify-write on contacts, so call counts stay accurate.
  private readonly writes = new SerialQueue();

  constructor({ store, config = shop, now = () => DateTime.now(), logger = createLogger() }: CallLogServiceDeps) {
    this.store = store;
    this.config = config;
    this.now = now;
    this.log = logger;
  }

  async lookupContact(phoneInput: string): Promise<Contact | null> {
    const phone = normalizePhone(phoneInput);
    return phone ? this.store.findContact(phone) : null;
  }

  // Saves the caller's contact as soon as they book, so the shop sees them in
  // the Sheet during the call rather than only after it. This counts the
  // call; pass the phone to logCall as contactSaved so it isn't counted
  // twice. Never throws: on failure it returns null, and logCall saves the
  // contact as usual at the end of the call.
  async saveContact(phoneInput: string, name: string): Promise<string | null> {
    const phone = normalizePhone(phoneInput);
    if (!phone) {
      return null;
    }
    return this.writes.run(async () => {
      try {
        await this.updateContact(phone, name.trim(), this.timestamp(), true);
        return phone;
      } catch (err) {
        this.log.error('contact_update_failed', { err });
        return null;
      }
    });
  }

  // Call once per call, at the end, so Total Calls counts calls and not tool
  // invocations. Once the call row is written the call counts as logged: a
  // failure updating the contact is reported, not thrown, so a retry can't
  // add a second call row. contactSaved is the phone saveContact already
  // counted this call for, if any.
  async logCall(
    log: CallLog,
    { contactSaved }: { contactSaved?: string | null | undefined } = {},
  ): Promise<LogCallResult> {
    return this.writes.run(async () => {
      const timestamp = this.timestamp();
      const phone = log.phone ? normalizePhone(log.phone) : null;
      const name = log.name?.trim() ?? '';

      await this.store.appendCall({
        timestamp,
        // Keep what the caller said if it wasn't a valid number.
        phone: phone ?? log.phone ?? '',
        name,
        intent: log.intent,
        summary: log.summary,
        outcome: log.outcome,
        needsHuman: log.needsHuman,
        eventId: log.eventId ?? '',
      });

      if (!phone) {
        return { ok: true, phone, contactUpdated: false };
      }
      try {
        await this.updateContact(phone, name, timestamp, phone !== contactSaved);
        return { ok: true, phone, contactUpdated: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error('contact_update_failed', { err });
        return { ok: true, phone, contactUpdated: false, contactError: message };
      }
    });
  }

  private timestamp(): string {
    return this.now().setZone(this.config.timezone).toFormat('yyyy-MM-dd HH:mm');
  }

  // countCall is false when this call was already counted (see saveContact).
  private async updateContact(phone: string, name: string, timestamp: string, countCall: boolean): Promise<void> {
    const existing = await this.store.findContact(phone);
    await this.store.saveContact(
      existing
        ? // A new name replaces the old one; an unknown name keeps it.
          {
            ...existing,
            name: name || existing.name,
            lastCall: timestamp,
            totalCalls: existing.totalCalls + (countCall ? 1 : 0),
          }
        : { phone, name, firstSeen: timestamp, lastCall: timestamp, totalCalls: 1, notes: '' },
    );
  }
}
