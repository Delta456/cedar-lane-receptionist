// Checks that the service account can reach the Calendar and the Sheet,
// without changing either: `npm run smoke`.
import { DateTime } from 'luxon';
import { loadEnv } from '../config/env.ts';
import { shop } from '../config/shop.ts';
import { GoogleCalendarStore } from '../integrations/google/calendar-store.ts';
import { createGoogleClients } from '../integrations/google/client.ts';

const env = loadEnv();
const google = createGoogleClients();
const now = DateTime.now().setZone(shop.timezone);

// 1. The events you added by hand should show up here.
const events = await new GoogleCalendarStore(google.calendar, env.calendarId, shop).listEvents(
  now,
  now.plus({ days: 7 }),
);
console.log(`Events in the next 7 days: ${events.length}`);
for (const e of events) {
  console.log(`  ${e.start.toFormat('ccc LLL d, h:mm a')} -> ${e.end.toFormat('h:mm a')}  ${e.summary}`);
}

// 2. Both tabs should exist and have their header rows.
for (const tab of ['Contacts', 'Calls']) {
  const { data } = await google.sheets.spreadsheets.values.get({ spreadsheetId: env.sheetId, range: `${tab}!1:1` });
  console.log(`${tab} headers: ${(data.values?.[0] ?? []).join(', ') || '(none)'}`);
}
