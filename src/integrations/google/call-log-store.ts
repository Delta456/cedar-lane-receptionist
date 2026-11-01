// CallLogStore backed by a Google Sheet with two tabs.
//
// Contacts: Phone, Name, First Seen, Last Call, Total Calls, Notes
// Calls:    Timestamp, Phone, Name, Intent, Summary, Outcome, Needs Human, Event ID
//
// Row 1 of each tab is the header. Values are written RAW so a phone number
// like "+14155550190" stays text, and nothing a caller says is run as a formula.
// Contacts are matched on digits only: if someone edits a phone cell by hand,
// Sheets turns "+41235646856" into the number 41235646856, and an exact match
// would then add a second row for the same caller.
import type { sheets_v4 } from 'googleapis';
import type { CallLogStore, CallRecord, Contact } from '../../services/ports.ts';

const CONTACTS = 'Contacts';
const CALLS = 'Calls';

export class GoogleSheetCallLogStore implements CallLogStore {
  private readonly api: sheets_v4.Sheets;
  private readonly spreadsheetId: string;

  constructor(api: sheets_v4.Sheets, spreadsheetId: string) {
    this.api = api;
    this.spreadsheetId = spreadsheetId;
  }

  async appendCall(call: CallRecord): Promise<void> {
    await this.append(CALLS, [
      call.timestamp,
      call.phone,
      call.name,
      call.intent,
      call.summary,
      call.outcome,
      call.needsHuman ? 'Yes' : 'No',
      call.eventId,
    ]);
  }

  async findContact(phone: string): Promise<Contact | null> {
    return (await this.readContacts()).find((c) => samePhone(c.contact.phone, phone))?.contact ?? null;
  }

  async saveContact(contact: Contact): Promise<void> {
    const values = [
      contact.phone,
      contact.name,
      contact.firstSeen,
      contact.lastCall,
      contact.totalCalls,
      contact.notes,
    ];
    const existing = (await this.readContacts()).find((c) => samePhone(c.contact.phone, contact.phone));
    if (!existing) {
      await this.append(CONTACTS, values);
      return;
    }
    await this.api.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${CONTACTS}!A${existing.row}:F${existing.row}`,
      valueInputOption: 'RAW',
      requestBody: { values: [values] },
    });
  }

  private async append(tab: string, row: (string | number)[]): Promise<void> {
    await this.api.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${tab}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
  }

  // Every contact with its 1-based sheet row.
  private async readContacts(): Promise<{ row: number; contact: Contact }[]> {
    const { data } = await this.api.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${CONTACTS}!A2:F`,
    });
    return (data.values ?? []).map((r: unknown[], i) => ({
      row: i + 2,
      contact: {
        phone: String(r[0] ?? ''),
        name: String(r[1] ?? ''),
        firstSeen: String(r[2] ?? ''),
        lastCall: String(r[3] ?? ''),
        totalCalls: Number(r[4] ?? 0) || 0,
        notes: String(r[5] ?? ''),
      },
    }));
  }
}

function samePhone(a: string, b: string): boolean {
  const digits = (phone: string) => phone.replace(/\D/g, '');
  return digits(a) !== '' && digits(a) === digits(b);
}
