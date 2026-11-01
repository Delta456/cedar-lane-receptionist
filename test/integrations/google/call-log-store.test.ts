import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { sheets_v4 } from 'googleapis';
import { GoogleSheetCallLogStore } from '../../../src/integrations/google/call-log-store.ts';

// Just enough of the Sheets API for the Contacts tab: rows after the header,
// as Sheets returns them (a phone cell edited by hand comes back as digits).
function fakeSheets(rows: unknown[][]) {
  const writes: { kind: 'append' | 'update'; range: string; values: unknown[] }[] = [];
  const api = {
    spreadsheets: {
      values: {
        get: async () => ({ data: { values: rows } }),
        append: async ({ range, requestBody }: { range: string; requestBody: { values: unknown[][] } }) => {
          writes.push({ kind: 'append', range, values: requestBody.values[0] ?? [] });
        },
        update: async ({ range, requestBody }: { range: string; requestBody: { values: unknown[][] } }) => {
          writes.push({ kind: 'update', range, values: requestBody.values[0] ?? [] });
        },
      },
    },
  };
  return { api: api as unknown as sheets_v4.Sheets, writes };
}

const contact = {
  phone: '+41235646856',
  name: 'Sara',
  firstSeen: '2026-11-01 11:57',
  lastCall: '2026-11-01 12:05',
  totalCalls: 3,
  notes: '',
};

test('a phone cell Sheets turned into a number still matches its caller', async () => {
  const { api, writes } = fakeSheets([['41235646856', 'Sara', '2026-11-01 11:57', '2026-11-01 12:02', '2', '']]);
  const store = new GoogleSheetCallLogStore(api, 'sheet');
  assert.equal((await store.findContact('+41235646856'))?.totalCalls, 2);

  await store.saveContact(contact);
  assert.deepEqual(
    writes.map((w) => [w.kind, w.range]),
    [['update', 'Contacts!A2:F2']],
  );
});

test('a new caller gets a new row', async () => {
  const { api, writes } = fakeSheets([['+14155550190', 'John', '', '', '1', '']]);
  await new GoogleSheetCallLogStore(api, 'sheet').saveContact(contact);
  assert.equal(writes[0]?.kind, 'append');
  assert.equal(writes[0]?.values[0], '+41235646856');
});
