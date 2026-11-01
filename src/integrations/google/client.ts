// Authenticated Google API clients. GoogleAuth reads the service account key
// from GOOGLE_APPLICATION_CREDENTIALS.
import { type calendar_v3, google, type sheets_v4 } from 'googleapis';

export type GoogleClients = {
  calendar: calendar_v3.Calendar;
  sheets: sheets_v4.Sheets;
};

export function createGoogleClients(): GoogleClients {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/spreadsheets'],
  });
  return {
    calendar: google.calendar({ version: 'v3', auth }),
    sheets: google.sheets({ version: 'v4', auth }),
  };
}

// Google API errors carry the HTTP status as `code`.
export function isNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 404 || code === 410;
}
