// Entry point: `npm start`.
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { createHttpServer } from './server/http-server.ts';

const app = createApp();
const { server, endOpenCalls } = createHttpServer({
  createConversation: app.createConversation,
  pagePath: fileURLToPath(new URL('./channels/chat/page.html', import.meta.url)),
  logger: app.logger,
  vapiSecret: app.env.vapiSecret,
});

server.listen(app.env.port, () => {
  app.logger.info('listening', {
    url: `http://localhost:${app.env.port}`,
    model: app.env.llm.model,
    voice: app.env.vapiSecret ? 'enabled' : 'disabled (set VAPI_SECRET)',
  });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.logger.info('shutting_down', { signal });
    // Log any calls still open before exiting, so none are lost.
    endOpenCalls().finally(() => server.close(() => process.exit(0)));
  });
}
