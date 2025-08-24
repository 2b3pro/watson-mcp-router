import express from 'express';
import {
    McpServer,
    RegisteredTool,
    RegisteredResource,
    RegisteredPrompt
} from '@modelcontextprotocol/sdk/server/mcp.js'; // Removed ToolResponse as it's not exported
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { ServerManager, UnifiedToolMetadata, UnifiedResourceMetadata, UnifiedPromptMetadata } from './serverManager'; // Import unified metadata types
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
    serverManager.getUnifiedTools().forEach((toolMetadata: UnifiedToolMetadata) => {
        // Create a proxy handler
        const proxyHandler = async (args: any): Promise<any> => { // Changed return type from ToolResponse to any
            console.log(`[MCP Router] Invoking tool: ${toolMetadata.name}`);
            console.log(`[MCP Router] Tool metadata: ${JSON.stringify(toolMetadata, null, 2)}`);
            console.log(`[MCP Router] Tool arguments: ${JSON.stringify(args, null, 2)}`);

            const serverEntry = serverManager.getSpawnedServer(toolMetadata.serverName);
            if (!serverEntry) {
                console.error(`[MCP Router] Server '${toolMetadata.serverName}' not found or not running.`);
                throw new Error(`Server '${toolMetadata.serverName}' not found or not running.`);
            }
            try {
                // Construct the payload for the child server's tool call
                const toolCallPayload = {
                    name: toolMetadata.originalToolName, // The tool's original name on the child server
                    arguments: args.arguments || {} // The arguments for the tool
                };

                // Call the tool on the specific child server's client
                // @ts-ignore - Ignoring type error due to SDK type definition mismatch for callTool's arguments
                const rawResult = await serverEntry.client.callTool(toolCallPayload);

                console.log(`[MCP Router] Tool '${toolMetadata.name}' call successful. Raw result: ${JSON.stringify(rawResult, null, 2)}`);

                // Wrap the raw result into a ToolResponse structure
                const content = [{
                    type: "text",
                    text: JSON.stringify(rawResult, null, 2)
                }];

                return {
                    content: content,
                    _meta: {} // Optionally include any meta information if available/relevant
                };
            } catch (error: any) {
                console.error(`[MCP Router] Error calling tool '${toolMetadata.originalToolName}' on server '${toolMetadata.serverName}':`, error);
                // Return an error response
                return {
                    content: [{
                        type: "text",
                        text: `Error: ${error.message || 'Unknown error'}`
                    }],
                    isError: true,
                    _meta: {} // Optionally include error details in meta
                };
            }
        };

        // Convert raw JSON inputSchema to a Zod-compatible shape
        let zodInputShape: { [key: string]: z.ZodTypeAny } | undefined;
        if (toolMetadata.inputSchema) {
            // Check if it's an empty object schema
            if (Object.keys(toolMetadata.inputSchema).length === 0 && toolMetadata.inputSchema.constructor === Object) {
                zodInputShape = {}; // Represent z.object({}) as an empty shape
            } else {
                // For complex schemas, use a generic catch-all.
                // A more robust solution requires a full JSON Schema to Zod converter library that outputs ZodRawShape.
                console.warn(`[MCP Router] Complex inputSchema found for tool ${toolMetadata.name}. Providing z.any().shape. Schema:`, JSON.stringify(toolMetadata.inputSchema));
                // This means inputSchema will effectively be undefined for actual validation,
                // but it satisfies the type requirement for ZodRawShape.
                zodInputShape = undefined; // Represents z.any().shape
            }
        }

        mcpServer.registerTool(toolMetadata.name, { // Use toolMetadata.name for registration
            title: toolMetadata.title,
            description: toolMetadata.description,
            inputSchema: zodInputShape // Pass the Zod-compatible shape
        }, proxyHandler);
    });

    serverManager.getUnifiedResources().forEach((resourceMetadata: UnifiedResourceMetadata) => {
        const resourceHandler = async () => {
            console.log(`[MCP Router] Reading resource: ${resourceMetadata.uri}`);
            console.log(`[MCP Router] Resource metadata: ${JSON.stringify(resourceMetadata, null, 2)}`);

            const serverEntry = serverManager.getSpawnedServer(resourceMetadata.serverName);
            if (!serverEntry) {
                console.error(`[MCP Router] Server '${resourceMetadata.serverName}' not found or not running.`);
                throw new Error(`Server '${resourceMetadata.serverName}' not found or not running.`);
            }
            try {
                // Call the resource on the specific child server's client using its original URI
                // @ts-ignore - Ignoring type error due to SDK type definition mismatch for readResource's first argument
                const rawResult = await serverEntry.client.readResource(resourceMetadata.originalResourceUri);
                console.log(`[MCP Router] Resource '${resourceMetadata.uri}' read successful. Raw result: ${JSON.stringify(rawResult, null, 2)}`);
                // Assuming rawResult is the content directly
                return rawResult;
            } catch (error: any) {
                console.error(`[MCP Router] Error reading resource '${resourceMetadata.originalResourceUri}' on server '${resourceMetadata.serverName}':`, error);
                throw new Error(`Failed to read resource: ${error.message || 'Unknown error'}`);
            }
        };

        mcpServer.registerResource(resourceMetadata.uri, resourceMetadata.originalResourceUri, { // Pass originalResourceUri as template/uri
            title: resourceMetadata.title,
            description: resourceMetadata.description,
            mimeType: resourceMetadata.mimeType
        }, resourceHandler);
    });

    serverManager.getUnifiedPrompts().forEach((promptMetadata: UnifiedPromptMetadata) => {
        const promptHandler = async (args: any) => {
            console.log(`[MCP Router] Executing prompt: ${promptMetadata.name}`);
            console.log(`[MCP Router] Prompt metadata: ${JSON.stringify(promptMetadata, null, 2)}`);
            console.log(`[MCP Router] Prompt arguments: ${JSON.stringify(args, null, 2)}`);

            const serverEntry = serverManager.getSpawnedServer(promptMetadata.serverName);
            if (!serverEntry) {
                console.error(`[MCP Router] Server '${promptMetadata.serverName}' not found or not running.`);
                throw new Error(`Server '${promptMetadata.serverName}' not found or not running.`);
            }
            try {
                // Call the prompt on the specific child server's client using its original name
                // @ts-ignore - Ignoring type error due to SDK type definition mismatch for executePrompt
                const rawResult = await serverEntry.client.executePrompt(promptMetadata.originalPromptName, args); // Reverted to executePrompt and added ts-ignore
                console.log(`[MCP Router] Prompt '${promptMetadata.name}' execution successful. Raw result: ${JSON.stringify(rawResult, null, 2)}`);
                // Assuming rawResult is the content directly
                return rawResult;
            } catch (error: any) {
                console.error(`[MCP Router] Error executing prompt '${promptMetadata.originalPromptName}' on server '${promptMetadata.serverName}':`, error);
                throw new Error(`Failed to execute prompt: ${error.message || 'Unknown error'}`);
            }
        };

        mcpServer.registerPrompt(promptMetadata.name, { // Use promptMetadata.name for registration
            title: promptMetadata.title,
            description: promptMetadata.description,
            argsSchema: promptMetadata.argsSchema
        }, promptHandler);
    });

    // Handle POST requests for client-to-server communication
    app.post('/mcp', async (req, res) => {
        console.log(`[MCP Router] Received POST request to /mcp. Body: ${JSON.stringify(req.body, null, 2)}`);
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
        try {
            await transport.handleRequest(req, res, req.body);
        } catch (error: any) {
            console.error(`[MCP Router] Error handling request in transport:`, error);
            res.status(500).json({
                jsonrpc: '2.0',
                error: {
                    code: -32003, // Internal error code
                    message: `Internal server error: ${error.message || 'Unknown error during request handling.'}`,
                },
                id: req.body.id || null,
            });
        }
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
