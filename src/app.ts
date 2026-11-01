// Composition root: builds the real dependencies from the environment and
// wires them together. Everything else takes its dependencies as arguments.
import { Conversation } from './agent/conversation.ts';
import type { Services } from './agent/tools.ts';
import { type Env, loadEnv } from './config/env.ts';
import { shop } from './config/shop.ts';
import { GoogleCalendarStore } from './integrations/google/calendar-store.ts';
import { GoogleSheetCallLogStore } from './integrations/google/call-log-store.ts';
import { createGoogleClients } from './integrations/google/client.ts';
import { createLlmClient } from './integrations/llm/client.ts';
import { createLogger, type Logger } from './lib/logger.ts';
import type { CreateConversation } from './server/sessions.ts';
import { BookingService } from './services/booking-service.ts';
import { CallLogService } from './services/call-log-service.ts';

export type App = {
  env: Env;
  logger: Logger;
  services: Services;
  createConversation: CreateConversation;
};

export function createApp(env: Env = loadEnv()): App {
  const logger = createLogger({ fields: { service: 'cedar-lane-receptionist' } });
  const google = createGoogleClients();
  const services: Services = {
    bookings: new BookingService({ calendar: new GoogleCalendarStore(google.calendar, env.calendarId, shop) }),
    callLog: new CallLogService({ store: new GoogleSheetCallLogStore(google.sheets, env.sheetId), logger }),
  };
  const llm = createLlmClient({ baseURL: env.llm.baseURL, apiKey: env.llm.apiKey });
  return {
    env,
    logger,
    services,
    createConversation: (options) =>
      new Conversation({
        llm,
        model: env.llm.model,
        services,
        logger,
        channel: options?.channel,
        callerPhone: options?.callerPhone ?? null,
      }),
  };
}
