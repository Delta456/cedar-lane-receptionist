import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DateTime } from 'luxon';
import { shop } from '../../src/config/shop.ts';
import { CallLogService } from '../../src/services/call-log-service.ts';
import { FakeCallLogStore } from '../support/fake-stores.ts';

let store: FakeCallLogStore;
let callLog: CallLogService;
const SARA = '415-555-0190';
const call = { intent: 'booking', summary: 'Booked a detail.', outcome: 'Booked', needsHuman: false };

beforeEach(() => {
  store = new FakeCallLogStore();
  const now = () => DateTime.fromISO('2026-10-31T12:00', { zone: shop.timezone });
  callLog = new CallLogService({ store, now });
});

test('one contact per caller, however the number was written', async () => {
  await callLog.logCall({ ...call, phone: '415-555-0190', name: 'Sara' });
  await callLog.logCall({ ...call, phone: 'four one five five five five oh one ninety' });

  assert.equal(store.calls.length, 2);
  assert.equal(store.contacts.size, 1);
  const sara = await callLog.lookupContact('(415) 555-0190');
  assert.equal(sara?.totalCalls, 2);
  // The second call didn't give a name, so the first one is kept.
  assert.equal(sara?.name, 'Sara');
  assert.equal(sara?.firstSeen, '2026-10-31 12:00');
});

test('an invalid number is logged as given, without a contact', async () => {
  const result = await callLog.logCall({ ...call, phone: '555-01' });
  assert.equal(result.phone, null);
  assert.equal(result.contactUpdated, false);
  assert.equal(store.calls[0]?.phone, '555-01');
  assert.equal(store.contacts.size, 0);
});

test('a contact failure is reported, not thrown, once the call is logged', async () => {
  store.failSaveContact = true;
  const result = await callLog.logCall({ ...call, phone: '415-555-0190', name: 'Sara' });
  assert.equal(result.ok, true);
  assert.equal(result.contactUpdated, false);
  assert.equal(result.contactError, 'sheet unavailable');
  assert.equal(store.calls.length, 1);
});

test('a contact saved at booking time is not counted again when the call is logged', async () => {
  const saved = await callLog.saveContact('415-555-0190', 'Sara');
  assert.equal(saved, '+14155550190');
  assert.equal((await callLog.lookupContact(SARA))?.totalCalls, 1);
  assert.equal(store.calls.length, 0);

  await callLog.logCall({ ...call, phone: SARA, name: 'Sara' }, { contactSaved: saved });
  assert.equal((await callLog.lookupContact(SARA))?.totalCalls, 1);
  assert.equal(store.calls.length, 1);

  // The next call counts as usual.
  await callLog.logCall({ ...call, phone: SARA });
  assert.equal((await callLog.lookupContact(SARA))?.totalCalls, 2);
});

test('saving a contact at booking time never throws', async () => {
  store.failSaveContact = true;
  assert.equal(await callLog.saveContact(SARA, 'Sara'), null);
  assert.equal(await callLog.saveContact('555-01', 'Sara'), null);
});
