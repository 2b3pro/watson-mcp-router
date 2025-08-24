import { ChildProcess, spawn } from 'child_process';
import { readFileSync } from 'fs';
import * as stream from 'stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
// We are not importing RegisteredTool, RegisteredResource, RegisteredPrompt from sdk/server/mcp.js here,
// as the client.listX() methods return slightly different structures.
// Instead, we define interfaces that match what client.listX() actually returns.

// Define interfaces that match the actual response structure from client.listTools()
interface ClientToolResponse {
    name: string;
    title?: string;
    description?: string;
    inputSchema?: object; // Changed from any to object
    outputSchema?: object; // Changed from any to object
}

// Define interfaces that match the actual response structure from client.listResources()
interface ClientResourceResponse {
    uri: string;
    name?: string;
    title?: string;
    description?: string;
    mimeType?: string;
}

// Define interfaces that match the actual response structure from client.listPrompts()
interface ClientPromptResponse {
    name: string;
    title?: string;
    description?: string;
    argsSchema?: object; // Changed from any to object
}

interface McpServerConfig {
    autoApprove?: string[];
    disabled?: boolean;
    timeout?: number;
    type: 'stdio';
    command: string;
    args: string[];
    env?: { [key: string]: string };
    cwd?: string;
}

interface McpRouterConfig {
    mcpServers: { [key: string]: McpServerConfig };
}

// Custom ITransport implementation for child process stdio for Client
class CustomStdioClientTransport {
    private _input: NodeJS.ReadableStream;
    private _output: NodeJS.WritableStream;
    private _onmessageCallback: ((message: any) => void) | undefined;
    private _oncloseCallback: (() => void) | undefined;
    private _onerrorCallback: ((error: Error) => void) | undefined;
    private _buffer: string = ''; // Buffer to accumulate incoming data

    constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
        this._input = input;
        this._output = output;

        this._input.on('data', (data) => {
            this._buffer += data.toString(); // Append incoming data to the buffer
            console.log(`[CustomStdioClientTransport] Received raw data from child, buffer size: ${this._buffer.length}`);

            let newlineIndex: number;
            // Process the buffer line by line
            while ((newlineIndex = this._buffer.indexOf('\n')) !== -1) {
                const line = this._buffer.substring(0, newlineIndex).trim();
                this._buffer = this._buffer.substring(newlineIndex + 1); // Remove the processed line from the buffer

                if (line.length === 0) {
                    continue; // Skip empty lines
                }

                console.log(`[CustomStdioClientTransport] Processing line from buffer: ${line}`);
                try {
                    const message = JSON.parse(line);
                    console.log(`[CustomStdioClientTransport] Parsed message from child: ${JSON.stringify(message)}`);

                    // Correct structuredContent: null to {} if present in a result message
                    if (message && message.jsonrpc === "2.0" && message.result && message.result.structuredContent === null) {
                        console.log(`[CustomStdioClientTransport] Correcting structuredContent: null to {}.`);
                        message.result.structuredContent = {};
                    }

                    if (this._onmessageCallback) {
                        this._onmessageCallback(message);
                    }
                } catch (e) {
                    console.error(`[CustomStdioClientTransport] Error parsing line from child: "${line}"`, e);
                    if (this._onerrorCallback) {
                        this._onerrorCallback(new Error(`Failed to parse message from child process: "${line}"`));
                    }
                }
            }
        });
        this._input.on('close', () => {
            console.log('[CustomStdioClientTransport] Child input stream closed.');
            if (this._oncloseCallback) {
                this._oncloseCallback();
            }
        });
        this._input.on('error', (err) => {
            console.error('[CustomStdioClientTransport] Child input stream error:', err);
            if (this._onerrorCallback) {
                this._onerrorCallback(err);
            }
        });
    }

    public async connect(): Promise<void> {
        console.log('[CustomStdioClientTransport] Connecting...');
        return Promise.resolve();
    }

    public send(message: any): Promise<void> {
        const messageString = JSON.stringify(message);
        console.log(`[CustomStdioClientTransport] Sending message to child: ${messageString}`);
        return new Promise((resolve, reject) => {
            // Ensure the stream is writable before attempting to write
            if (!this._output.writable) {
                const error = new Error('[CustomStdioClientTransport] Child stdin stream is not writable.');
                console.error(error.message);
                return reject(error);
            }

            const canWrite = this._output.write(messageString + '\n');

            if (!canWrite) {
                // Buffer is full, wait for 'drain' event
                this._output.once('drain', () => {
                    console.log(`[CustomStdioClientTransport] Drain event received for message: ${messageString}`);
                    resolve();
                });
            } else {
                // Write was successful immediately
                resolve();
            }
        });
    }

    public set onmessage(cb: (message: any) => void) {
        this._onmessageCallback = cb;
    }

    public set onclose(cb: () => void) {
        this._oncloseCallback = cb;
    }

    public set onerror(cb: (error: Error) => void) {
        this._onerrorCallback = cb;
    }

    public async start(): Promise<void> {
        return Promise.resolve();
    }

    public async close(): Promise<void> {
        (this._input as stream.Readable).destroy();
        this._output.end();
        return Promise.resolve();
    }
}

// Define interfaces that represent the *metadata* needed for registration, plus serverName
export interface UnifiedToolMetadata {
    name: string; // The unified name (serverName_originalName)
    title?: string; // Optional title
    description?: string;
    inputSchema?: object; // Changed from any to object
    serverName: string; // The name of the server this tool came from
    originalToolName: string; // The tool's name on its original server
}

export interface UnifiedResourceMetadata {
    name?: string; // The unified name (serverName_originalName) - optional as resource might only have URI
    uri: string; // The unified URI (serverName_originalUri)
    title?: string;
    description?: string;
    mimeType?: string;
    serverName: string;
    originalResourceUri: string; // The resource's URI on its original server
}

export interface UnifiedPromptMetadata {
    name: string; // The unified name (serverName_originalName)
    title?: string;
    description?: string;
    argsSchema?: object; // Changed from any to object
    serverName: string;
    originalPromptName: string; // The prompt's name on its original server
}

export class ServerManager {
    private config: McpRouterConfig | null = null;
    // Explicitly add 'name' to the Client type in spawnedServers
    private spawnedServers: Map<string, { process: ChildProcess; client: Client & { name: string } }> = new Map();
    private unifiedTools: UnifiedToolMetadata[] = [];
    private unifiedResources: UnifiedResourceMetadata[] = [];
    private unifiedPrompts: UnifiedPromptMetadata[] = [];
    private configPath: string;

    constructor(configPath: string) {
        this.configPath = configPath;
    }

    public async loadConfig(): Promise<void> {
        try {
            const configContent = readFileSync(this.configPath, 'utf-8');
            this.config = JSON.parse(configContent);
            console.log('Configuration loaded successfully.');
        } catch (error) {
            console.error('Failed to load configuration:', error);
            throw error;
        }
    }

    public async spawnServers(): Promise<void> {
        if (!this.config) {
            throw new Error('Configuration not loaded. Call loadConfig() first.');
        }

        for (const serverName in this.config.mcpServers) {
            const serverConfig = this.config.mcpServers[serverName];
            if (serverConfig.disabled) {
                console.log(`Server ${serverName} is disabled, skipping.`);
                continue;
            }

            console.log(`Spawning server: ${serverName}`);
            try {
                const childProcess = spawn(serverConfig.command, serverConfig.args, {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env: { ...process.env, ...serverConfig.env },
                    cwd: serverConfig.cwd,
                });

                const client = new Client({
                    name: serverName,
                    version: "1.0.0",
                }) as Client & { name: string }; // Cast immediately after creation

                childProcess.stderr.on('data', (data) => {
                    console.error(`[${serverName} STDERR]: ${data.toString()}`);
                });

                childProcess.on('close', (code) => {
                    console.log(`Server ${serverName} exited with code ${code}`);
                    this.spawnedServers.delete(serverName);
                    this.rebuildUnifiedCollections();
                });

                this.spawnedServers.set(serverName, { process: childProcess, client });

                const customStdioTransport = new CustomStdioClientTransport(childProcess.stdout, childProcess.stdin);
                await client.connect(customStdioTransport);

                // Get tools and resources from the connected client
                let tools: ClientToolResponse[] = [];
                let resources: ClientResourceResponse[] = [];
                let prompts: ClientPromptResponse[] = [];

                try {
                    const response = await client.listTools();
                    tools = Array.isArray(response.tools) ? response.tools as ClientToolResponse[] : [];
                    console.log(`[${serverName}] Received tools:`, tools);
                    if (!Array.isArray(tools)) {
                        console.warn(`[${serverName}] client.listTools() did not return an array. Received:`, response);
                    }
                } catch (toolError) {
                    console.error(`[${serverName}] Error listing tools:`, toolError);
                }

                try {
                    const response = await client.listResources();
                    resources = Array.isArray(response.resources) ? response.resources as ClientResourceResponse[] : [];
                    console.log(`[${serverName}] Received resources:`, resources);
                    if (!Array.isArray(resources)) {
                        console.warn(`[${serverName}] client.listResources() did not return an array. Received:`, response);
                    }
                } catch (resourceError) {
                    console.error(`[${serverName}] Error listing resources:`, resourceError);
                }

                try {
                    const response = await client.listPrompts();
                    prompts = Array.isArray(response.prompts) ? response.prompts as ClientPromptResponse[] : [];
                    console.log(`[${serverName}] Received prompts:`, prompts);
                    if (!Array.isArray(prompts)) {
                        console.warn(`[${serverName}] client.listPrompts() did not return an array. Received:`, response);
                    }
                } catch (promptError) {
                    console.error(`[${serverName}] Error listing prompts:`, promptError);
                }

                tools.forEach((tool: ClientToolResponse) => {
                    this.unifiedTools.push({
                        name: `${serverName}_${tool.name}`,
                        title: tool.title || `${serverName}_${tool.name}`,
                        description: tool.description,
                        inputSchema: tool.inputSchema ? JSON.parse(JSON.stringify(tool.inputSchema)) : undefined, // Apply deep clone
                        serverName: serverName,
                        originalToolName: tool.name
                    });
                });
                resources.forEach((resource: ClientResourceResponse) => {
                    this.unifiedResources.push({
                        name: resource.name || undefined,
                        uri: `${serverName}_${resource.uri}`,
                        title: resource.title || `${serverName}_${resource.uri}`,
                        description: resource.description,
                        mimeType: resource.mimeType,
                        serverName: serverName,
                        originalResourceUri: resource.uri
                    });
                });

                prompts.forEach((prompt: ClientPromptResponse) => {
                    this.unifiedPrompts.push({
                        name: `${serverName}_${prompt.name}`,
                        title: prompt.title || `${serverName}_${prompt.name}`,
                        description: prompt.description,
                        argsSchema: prompt.argsSchema ? JSON.parse(JSON.stringify(prompt.argsSchema)) : undefined, // Apply deep clone
                        serverName: serverName,
                        originalPromptName: prompt.name
                    });
                });

                console.log(`Server ${serverName} spawned and capabilities loaded.`);
            } catch (error) {
                console.error(`Failed to spawn server ${serverName}:`, error);
            }
        }
        console.log('All configured servers processed.');
    }

    private rebuildUnifiedCollections(): void {
        this.unifiedTools = [];
        this.unifiedResources = [];
        this.unifiedPrompts = [];
        this.spawnedServers.forEach(({ client }) => {
            // Re-fetch capabilities from the client, as the collection might have changed
            // after a child process exited.
            // Note: client.getCapabilities() might return static capabilities of the client
            // itself if it's not designed to fetch from the remote after initialization.
            // Using listTools, listResources, and listPrompts is safer for dynamic capabilities.
            client.listTools().then(response => {
                const rebuiltTools = Array.isArray(response.tools) ? response.tools as ClientToolResponse[] : [];
                rebuiltTools.forEach((tool: ClientToolResponse) => {
                    this.unifiedTools.push({
                        name: `${client.name}_${tool.name}`, // client.name is now explicitly typed
                        title: tool.title || `${client.name}_${tool.name}`,
                        description: tool.description,
                        inputSchema: tool.inputSchema ? JSON.parse(JSON.stringify(tool.inputSchema)) : undefined, // Apply deep clone
                        serverName: client.name, // client.name is now explicitly typed
                        originalToolName: tool.name
                    });
                });
                if (!Array.isArray(response.tools)) {
                    console.warn(`Rebuild: client.listTools() did not return an array. Received:`, response);
                }
            }).catch(error => {
                console.error("Error rebuilding unified tools:", error);
            });

            client.listResources().then(response => {
                const rebuiltResources = Array.isArray(response.resources) ? response.resources as ClientResourceResponse[] : [];
                rebuiltResources.forEach((resource: ClientResourceResponse) => {
                    this.unifiedResources.push({
                        name: resource.name || undefined,
                        uri: `${client.name}_${resource.uri}`, // client.name is now explicitly typed
                        title: resource.title || `${client.name}_${resource.uri}`,
                        description: resource.description,
                        mimeType: resource.mimeType,
                        serverName: client.name, // client.name is now explicitly typed
                        originalResourceUri: resource.uri
                    });
                });
                if (!Array.isArray(response.resources)) {
                    console.warn(`Rebuild: client.listResources() did not return an array. Received:`, response);
                }
            }).catch(error => {
                console.error("Error rebuilding unified resources:", error);
            });

            client.listPrompts().then(response => {
                const rebuiltPrompts = Array.isArray(response.prompts) ? response.prompts as ClientPromptResponse[] : [];
                rebuiltPrompts.forEach((prompt: ClientPromptResponse) => {
                    this.unifiedPrompts.push({
                        name: `${client.name}_${prompt.name}`, // client.name is now explicitly typed
                        title: prompt.title || `${client.name}_${prompt.name}`,
                        description: prompt.description,
                        argsSchema: prompt.argsSchema ? JSON.parse(JSON.stringify(prompt.argsSchema)) : undefined, // Apply deep clone
                        serverName: client.name, // client.name is now explicitly typed
                        originalPromptName: prompt.name
                    });
                });
                if (!Array.isArray(response.prompts)) {
                    console.warn(`Rebuild: client.listPrompts() did not return an array. Received:`, response);
                }
            }).catch(error => {
                console.error("Error rebuilding unified prompts:", error);
            });
        });
    }

    public getUnifiedTools(): UnifiedToolMetadata[] {
        return this.unifiedTools;
    }

    public getUnifiedResources(): UnifiedResourceMetadata[] {
        return this.unifiedResources;
    }

    public getUnifiedPrompts(): UnifiedPromptMetadata[] {
        return this.unifiedPrompts;
    }

    public getSpawnedServer(serverName: string): { process: ChildProcess; client: Client } | undefined {
        return this.spawnedServers.get(serverName);
    }

    public async stopAllServers(): Promise<void> {
        for (const [serverName, { process }] of this.spawnedServers.entries()) {
            console.log(`Stopping server: ${serverName}`);
            process.kill();
        }
        this.spawnedServers.clear();
        this.unifiedTools = [];
        this.unifiedResources = [];
        this.unifiedPrompts = [];
    }
}
