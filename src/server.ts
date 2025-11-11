import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { config } from 'dotenv';
import express, { type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BaseOryOptions, OryProvider } from '@ory/mcp-oauth-provider';

// Load environment variables
config();

// Validate required environment variables
const oryHydraAdminUrl = process.env.ORY_HYDRA_ADMIN_URL;
const oryHydraPublicUrl = process.env.ORY_HYDRA_PUBLIC_URL;
if (!oryHydraAdminUrl || !oryHydraPublicUrl) {
throw new Error('ORY_HYDRA_ADMIN_URL and ORY_HYDRA_PUBLIC_URL must be set');
}

const mcpBaseUrl = process.env.MCP_BASE_URL;
if (!mcpBaseUrl) {
  throw new Error('MCP_BASE_URL must be set');
}

const serviceDocumentationUrl = process.env.SERVICE_DOCUMENTATION_URL;
if (!serviceDocumentationUrl) {
  throw new Error('SERVICE_DOCUMENTATION_URL must be set');
}

const getServer = () => {
  const server = new McpServer(
    {
      name: 'ory-mpc-example',
      version: '1.0.0',
      description: 'This is an example MPC server that uses Ory for authentication.',
    },
    { capabilities: { logging: {} } }
  );

    server.tool(
    'helloWorld',
    'simply return a string called Hello World <name> where parameter is the name of who to say hello world to',
    {
      name: z.string(),
    },
    async ({ name }) => {
      return {
        content: [
          {
            type: 'text',
            text: `Hello World ${name}`,
          },
        ],
      }
    }
  );
  return server;
};


const transports: Record<string, StreamableHTTPServerTransport | SSEServerTransport> = {};

const app = express();
app.use(express.json());

const baseOryOptions: BaseOryOptions = {
  endpoints: {
    authorizationUrl: `${oryHydraPublicUrl}/oauth2/auth`,
    tokenUrl: `${oryHydraPublicUrl}/oauth2/token`,
    revocationUrl: `${oryHydraPublicUrl}/oauth2/revoke`,
    registrationUrl: `${oryHydraPublicUrl}/oauth2/register`,
  },
  providerType: 'hydra',
  hydraAdminUrl: oryHydraAdminUrl,
};

const proxyProvider = new OryProvider({
  ...baseOryOptions,
});

app.use(
  mcpAuthRouter({
    provider: proxyProvider,
    issuerUrl: new URL(oryHydraPublicUrl),
    baseUrl: new URL(mcpBaseUrl),
    serviceDocumentationUrl: new URL(serviceDocumentationUrl),
  })
);

const bearerAuthMiddleware = requireBearerAuth({
  verifier: proxyProvider,
  requiredScopes: ["openid", "offline", "offline_access"],
});

//=============================================================================
// STREAMABLE HTTP TRANSPORT (PROTOCOL VERSION 2025-03-26)
//=============================================================================

// Handle mcp post requests
app.post('/mcp', bearerAuthMiddleware, async (req: Request, res: Response) => {
  const server = getServer();
  try {
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      console.log('Request closed');
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

app.get('/mcp', bearerAuthMiddleware, async (req: Request, res: Response) => {
  console.log('Received GET MCP request');
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed.',
      },
      id: null,
    })
  );
});

app.delete('/mcp', bearerAuthMiddleware, async (req: Request, res: Response) => {
  console.log('Received DELETE MCP request');
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed.',
      },
      id: null,
    })
  );
});

//=============================================================================
// DEPRECATED HTTP+SSE TRANSPORT (PROTOCOL VERSION 2024-11-05)
//=============================================================================

app.get('/sse', bearerAuthMiddleware, async (req: Request, res: Response) => {
  console.log('Received GET request to /sse (deprecated SSE transport)');
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;
  res.on('close', () => {
    delete transports[transport.sessionId];
  });
  const server = getServer();
  await server.connect(transport);
});

app.post('/messages', bearerAuthMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  let transport: SSEServerTransport;
  const existingTransport = transports[sessionId];
  if (existingTransport instanceof SSEServerTransport) {
    // Reuse existing transport
    transport = existingTransport;
  } else {
    // Transport exists but is not a SSEServerTransport (could be StreamableHTTPServerTransport)
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: Session exists but uses a different transport protocol',
      },
      id: null,
    });
    return;
  }
  if (transport) {
    await transport.handlePostMessage(req, res, req.body);
  } else {
    res.status(400).send('No transport found for sessionId');
  }
});

const port = process.env.PORT || 3000;
const host = process.env.HOST || "localhost"

app.listen(port as number, host, () => {
  console.log(`Backwards compatible MCP server listening on port ${port}`);
  console.log(`
==============================================
SUPPORTED TRANSPORT OPTIONS:

1. Streamable Http(Protocol version: 2025-03-26)
   Endpoint: /mcp
   Methods: GET, POST, DELETE
   Usage:
     - Initialize with POST to /mcp
     - Establish SSE stream with GET to /mcp
     - Send requests with POST to /mcp
     - Terminate session with DELETE to /mcp

2. Http + SSE (Protocol version: 2024-11-05)
   Endpoints: /sse (GET) and /messages (POST)
   Usage:
     - Establish SSE stream with GET to /sse
     - Send requests with POST to /messages?sessionId=<id>
==============================================
`);
});

// Handle server shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');

  // Close all active transports to properly clean up resources
  for (const sessionId in transports) {
    try {
      console.log(`Closing transport for session ${sessionId}`);
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch (error) {
      console.error(`Error closing transport for session ${sessionId}:`, error);
    }
  }
  console.log('Server shutdown complete');
  process.exit(0);
});
