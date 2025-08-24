import express from 'express';
import {
    McpServer,
    RegisteredTool,
    RegisteredResource,
    RegisteredPrompt
} from '@modelcontextprotocol/sdk/server/mcp.js'; // Removed ToolResponse as it's not exported
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'; // Removed ContentPart import
import { randomUUID } from 'node:crypto';
import { ServerManager, UnifiedToolMetadata, UnifiedResourceMetadata, UnifiedPromptMetadata } from './serverManager'; // Import unified metadata types
import path from 'path';
import { readFileSync } from 'fs';
import { z } from "zod";

function convertJsonSchemaToZod(jsonSchema: any): z.ZodRawShape | undefined {
    if (!jsonSchema || typeof jsonSchema !== 'object' || jsonSchema.type !== 'object' || !jsonSchema.properties) {
        return undefined;
    }

    const shape: z.ZodRawShape = {};
    for (const key in jsonSchema.properties) {
        const prop = jsonSchema.properties[key];
        if (prop.type === 'string') {
            shape[key] = z.string();
        } else if (prop.type === 'number' || prop.type === 'integer') {
            shape[key] = z.number();
        } else if (prop.type === 'boolean') {
            shape[key] = z.boolean();
        } else if (prop.type === 'array') {
            shape[key] = z.array(z.any()); // Basic array handling
        } else {
            shape[key] = z.any(); // Fallback for unsupported types
        }
    }
    return shape; // Return the raw shape
}

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
                // Call the tool on the specific child server's client
                const rawResult = await serverEntry.client.callTool({
                    name: toolMetadata.originalToolName,
                    arguments: args,
                });

                console.log(`[MCP Router] Tool '${toolMetadata.name}' call successful. Raw result: ${JSON.stringify(rawResult, null, 2)}`);

                // Wrap the raw result (which is a ToolResponse) into the expected message format
                return rawResult;
            } catch (error: any) {
                console.error(`[MCP Router] Error calling tool '${toolMetadata.originalToolName}' on server '${toolMetadata.serverName}':`, error);
                // Return an error response in the unified message format
                return `Error: ${error.message || 'Unknown error'}` as any;
            }
        };

        console.log(`[MCP Router] Registering tool: ${toolMetadata.name} with input schema: ${JSON.stringify(toolMetadata.inputSchema, null, 2)}`)

        mcpServer.registerTool(toolMetadata.name, { // Use toolMetadata.name for registration
            title: toolMetadata.title,
            description: toolMetadata.description,
            inputSchema: toolMetadata.inputSchema ? convertJsonSchemaToZod(toolMetadata.inputSchema) : undefined
        }, proxyHandler);

        // Testing an addition tool
        mcpServer.registerTool("add",
            {
                title: "Addition Tool",
                description: "Add two numbers",
                inputSchema: { a: z.number(), b: z.number() }
            },
            async ({ a, b }) => ({
                content: [{ type: "text", text: String(a + b) }]
            })
        );

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
                const rawResult = await serverEntry.client.readResource({
                    uri: resourceMetadata.originalResourceUri
                });
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
                const rawResult = await serverEntry.client.callTool({ // Changed to callTool
                    name: promptMetadata.originalPromptName,
                    arguments: args
                });
                console.log(`[MCP Router] Prompt '${promptMetadata.name}' execution successful. Raw result: ${JSON.stringify(rawResult, null, 2)}`);
                // Wrap the raw result (which is a ToolResponse from callTool for prompts) into the expected message format
                return {
                    messages: [{
                        content: (rawResult.content as any[])[0] as any, // Cast rawResult.content to any[] then its first element to any
                        role: "assistant"
                    } as any], // Cast the entire message object to any
                    _meta: rawResult._meta || {}
                };
            } catch (error: any) {
                throw new Error(`Failed to execute prompt: ${error.message || 'Unknown error'}`);
            }
        };

        mcpServer.registerPrompt(promptMetadata.name, { // Use promptMetadata.name for registration
            title: promptMetadata.title,
            description: promptMetadata.description,
            argsSchema: promptMetadata.argsSchema ? convertJsonSchemaToZod(promptMetadata.argsSchema) : undefined
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
                    message: `Internal server error: ${error.message || 'Unknown error'}`,
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
