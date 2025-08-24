import express from 'express';
import {
    McpServer,
    ResourceTemplate
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'; // Need this for session management
import { randomUUID } from 'node:crypto'; // For sessionIdGenerator
import { ServerManager } from './serverManager';
import path from 'path';
import { readFileSync } from 'fs';
import { z } from "zod"; // Import zod for schema validation

const configPath = path.join(__dirname, '..', 'watson_mcprouter_config.json');
const serverManager = new ServerManager(configPath);

async function main() {
    // Temporarily disable server spawning for barebones setup
    await serverManager.loadConfig();
    await serverManager.spawnServers();


    const app = express();
    app.use(express.json());

    // Map to store transports by session ID for stateful operation
    const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

    const packageJsonPath = path.join(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const routerVersion = packageJson.version;

    const mcpServer = new McpServer({
        name: "watson-mcprouter",
        version: routerVersion,
        capabilities: {
            tools: serverManager.getUnifiedTools(),
            resources: serverManager.getUnifiedResources(),
            prompts: serverManager.getUnifiedPrompts(),
        }
    });

    // Register tools, resources, and prompts from serverManager
    serverManager.getUnifiedTools().forEach((tool: any) => {
        mcpServer.registerTool(tool.name, {
            title: tool.title || tool.name, // Use title if available, otherwise name
            description: tool.description,
            inputSchema: tool.inputSchema
        }, tool.handler);
    });

    serverManager.getUnifiedResources().forEach((resource: any) => {
        mcpServer.registerResource(resource.name, resource.template, {
            title: resource.title || resource.name, // Use title if available, otherwise name
            description: resource.description,
            mimeType: resource.type
        }, resource.handler);
    });

    serverManager.getUnifiedPrompts().forEach((prompt: any) => {
        mcpServer.registerPrompt(prompt.name, {
            title: prompt.title || prompt.name, // Use title if available, otherwise name
            description: prompt.description,
            argsSchema: prompt.argsSchema
        }, prompt.handler);
    });

    // Handle POST requests for client-to-server communication
    app.post('/mcp', async (req, res) => {
        // Check for existing session ID
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports[sessionId]) {
            // Reuse existing transport
            transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            // New initialization request
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (newSessionId) => {
                    // Store the transport by session ID
                    transports[newSessionId] = transport;
                },
            });

            // Clean up transport when closed
            transport.onclose = () => { // Assuming onclose exists
                if (transport.sessionId) { // Assuming sessionId exists on transport
                    delete transports[transport.sessionId];
                }
            };

            // Connect to the MCP server
            await mcpServer.connect(transport);
        } else {
            // Invalid request
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Bad Request: No valid session ID provided',
                },
                id: null,
            });
            return;
        }

        // Handle the request
        await transport.handleRequest(req, res, req.body);
    });

    // Reusable handler for GET and DELETE requests
    const handleSessionRequest = async (req: express.Request, res: express.Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (!sessionId || !transports[sessionId]) {
            res.status(400).send('Invalid or missing session ID');
            return;
        }

        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
    };

    // Handle GET requests for server-to-client notifications via SSE
    app.get('/mcp', handleSessionRequest);

    // Handle DELETE requests for session termination
    app.delete('/mcp', handleSessionRequest);

    app.listen(3000, () => {
        console.log('MCP Router listening on port 3000');
    });
}

main().then(() => {
    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log('SIGINT received. Shutting down servers...');
        await serverManager.stopAllServers();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('SIGTERM received. Shutting down servers...');
        await serverManager.stopAllServers();
        process.exit(0);
    });
}).catch(async (err) => {
    console.error("Unhandled error in main:", err);
    await serverManager.stopAllServers(); // Ensure child processes are stopped on main error
    process.exit(1);
});

process.on('uncaughtException', async (err) => {
    console.error('Caught unhandled exception:', err);
    // Ensure child processes are stopped on unhandled exception
    await serverManager.stopAllServers();
    process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('Caught unhandled promise rejection:', reason, promise);
    // Ensure child processes are stopped on unhandled rejection
    await serverManager.stopAllServers();
    process.exit(1);
});
