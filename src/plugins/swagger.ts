import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

// Swagger UI is loaded from a CDN rather than via @fastify/swagger-ui: that plugin pulls in @fastify/static,
// which require()s an ESM-only package and crashes runtimes without require(esm) support (e.g. Vercel).
const SWAGGER_UI = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14';

const docsPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pipeline Mobile API</title>
  <link rel="stylesheet" href="${SWAGGER_UI}/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${SWAGGER_UI}/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.ui = SwaggerUIBundle({ url: '/docs/json', dom_id: '#swagger-ui', deepLinking: true });
  </script>
</body>
</html>`;

export default fp(async (app) => {
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: { title: 'Pipeline Mobile API', version: '1.0.0', description: 'Backend for the Pipeline mobile app.' },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
    transform: jsonSchemaTransform,
  });

  const hidden = { schema: { hide: true } } as const;
  app.get('/docs', hidden, async (_req, reply) => reply.type('text/html; charset=utf-8').send(docsPage));
  app.get('/docs/json', hidden, async () => app.swagger());
});
