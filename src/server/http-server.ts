// The HTTP server. It holds the calls in progress (sessions.ts) and hands
// each request to a channel: the chat page (Phase 1, channels/chat) or phone
// calls through Vapi (Phase 2, channels/voice).
import { createServer, type Server } from 'node:http';
import { createChatRoutes } from '../channels/chat/routes.ts';
import { createVoiceRoutes } from '../channels/voice/routes.ts';
import type { Logger } from '../lib/logger.ts';
import { HttpError, type Route, sendJson } from './http.ts';
import { type CreateConversation, Sessions } from './sessions.ts';

export type HttpServerDeps = {
  createConversation: CreateConversation;
  // Absolute path to the chat page.
  pagePath: string;
  // The secret in the Vapi URLs. Without it the voice routes don't exist, so
  // nobody can reach the agent's booking tools through them.
  vapiSecret?: string | undefined;
  logger: Logger;
  // How often to end idle calls and retry failed ends. Tests shorten it.
  sweepIntervalMs?: number | undefined;
};

export type HttpServer = {
  server: Server;
  // Ends (and so logs) every call still open, e.g. before shutting down.
  endOpenCalls(): Promise<void>;
};

export function createHttpServer({
  createConversation,
  pagePath,
  vapiSecret,
  logger,
  sweepIntervalMs,
}: HttpServerDeps): HttpServer {
  const sessions = new Sessions({ logger, sweepIntervalMs });
  const routes: Route[] = [createChatRoutes({ sessions, createConversation, pagePath, logger })];
  if (vapiSecret) {
    routes.push(createVoiceRoutes({ sessions, createConversation, secret: vapiSecret, logger }));
  }

  const server = createServer((req, res) => {
    const started = performance.now();
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    res.on('finish', () => {
      logger.info('request', {
        method: req.method,
        // The voice routes' paths contain the secret, so it's left out.
        path: path.startsWith('/vapi/') ? '/vapi/…' : path,
        status: res.statusCode,
        latencyMs: Math.round(performance.now() - started),
      });
    });
    handle()
      .then((handled) => {
        if (!handled) throw new HttpError(404, 'not found');
      })
      .catch((err: unknown) => {
        if (err instanceof HttpError) {
          sendJson(res, err.status, { error: err.message });
          return;
        }
        logger.error('request_failed', { err });
        sendJson(res, 500, { error: 'internal error' });
      });

    async function handle(): Promise<boolean> {
      for (const route of routes) {
        if (await route(req, res, path)) {
          return true;
        }
      }
      return false;
    }
  });

  return { server, endOpenCalls: () => sessions.endAll() };
}
