import { ChildProcess, spawn } from 'child_process';
import { readFileSync } from 'fs';
import * as stream from 'stream';
import { Tool, Resource, Prompt } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
// StdioClientTransport is not directly used for spawning here, but CustomStdioClientTransport implements its interface.
// import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

    constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
        this._input = input;
        this._output = output;

        this._input.on('data', (data) => {
            try {
                // MCP messages are usually newline-delimited JSON
                const messages = data.toString().split('\n').filter(Boolean);
                messages.forEach((msg: string) => { // Explicitly type msg as string
                    const message = JSON.parse(msg);
                    if (this._onmessageCallback) {
                        this._onmessageCallback(message);
                    }
                });
            } catch (e) {
                if (this._onerrorCallback) {
                    this._onerrorCallback(new Error(`Failed to parse message from child process: ${data.toString()}`));
                }
            }
        });
        this._input.on('close', () => {
            if (this._oncloseCallback) {
                this._oncloseCallback();
            }
        });
        this._input.on('error', (err) => {
            if (this._onerrorCallback) {
                this._onerrorCallback(err);
            }
        });
    }

    public async connect(): Promise<void> {
        return Promise.resolve();
    }

    public send(message: any): Promise<void> {
        return new Promise((resolve, reject) => {
            this._output.write(JSON.stringify(message) + '\n', (err) => {
                if (err) {
                    return reject(err);
                }
                resolve();
            });
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

export class ServerManager {
    private config: McpRouterConfig | null = null;
    private spawnedServers: Map<string, { process: ChildProcess; client: Client }> = new Map();
    private unifiedTools: Tool[] = [];
    private unifiedResources: Resource[] = [];
    private unifiedPrompts: Prompt[] = [];
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
                });

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
                let tools: Tool[] = [];
                let resources: Resource[] = [];
                let prompts: Prompt[] = [];

                try {
                    const response = await client.listTools();
                    tools = Array.isArray(response.tools) ? response.tools : [];
                    console.log(`[${serverName}] Received tools:`, tools);
                    if (!Array.isArray(tools)) {
                        console.warn(`[${serverName}] client.listTools() did not return an array. Received:`, response);
                    }
                } catch (toolError) {
                    console.error(`[${serverName}] Error listing tools:`, toolError);
                }

                try {
                    const response = await client.listResources();
                    resources = Array.isArray(response.resources) ? response.resources : [];
                    console.log(`[${serverName}] Received resources:`, resources);
                    if (!Array.isArray(resources)) {
                        console.warn(`[${serverName}] client.listResources() did not return an array. Received:`, response);
                    }
                } catch (resourceError) {
                    console.error(`[${serverName}] Error listing resources:`, resourceError);
                }

                try {
                    const response = await client.listPrompts();
                    prompts = Array.isArray(response.prompts) ? response.prompts : [];
                    console.log(`[${serverName}] Received prompts:`, prompts);
                    if (!Array.isArray(prompts)) {
                        console.warn(`[${serverName}] client.listPrompts() did not return an array. Received:`, response);
                    }
                } catch (promptError) {
                    console.error(`[${serverName}] Error listing prompts:`, promptError);
                }

                tools.forEach(tool => {
                    tool.name = `${serverName}_${tool.name}`;
                    this.unifiedTools.push(tool);
                });
                resources.forEach(resource => {
                    resource.uri = `${serverName}_${resource.uri}`;
                    this.unifiedResources.push(resource);
                });

                prompts.forEach(prompt => {
                    prompt.name = `${serverName}_${prompt.name}`;
                    this.unifiedPrompts.push(prompt);
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
                const rebuiltTools = Array.isArray(response.tools) ? response.tools : [];
                rebuiltTools.forEach(tool => {
                    this.unifiedTools.push(tool);
                });
                if (!Array.isArray(response.tools)) {
                    console.warn(`Rebuild: client.listTools() did not return an array. Received:`, response);
                }
            }).catch(error => {
                console.error("Error rebuilding unified tools:", error);
            });

            client.listResources().then(response => {
                const rebuiltResources = Array.isArray(response.resources) ? response.resources : [];
                rebuiltResources.forEach(resource => {
                    this.unifiedResources.push(resource);
                });
                if (!Array.isArray(response.resources)) {
                    console.warn(`Rebuild: client.listResources() did not return an array. Received:`, response);
                }
            }).catch(error => {
                console.error("Error rebuilding unified resources:", error);
            });

            client.listPrompts().then(response => {
                const rebuiltPrompts = Array.isArray(response.prompts) ? response.prompts : [];
                rebuiltPrompts.forEach(prompt => {
                    this.unifiedPrompts.push(prompt);
                });
                if (!Array.isArray(response.prompts)) {
                    console.warn(`Rebuild: client.listPrompts() did not return an array. Received:`, response);
                }
            }).catch(error => {
                console.error("Error rebuilding unified prompts:", error);
            });
        });
    }

    public getUnifiedTools(): Tool[] {
        return this.unifiedTools;
    }

    public getUnifiedResources(): Resource[] {
        return this.unifiedResources;
    }

    public getUnifiedPrompts(): Prompt[] {
        return this.unifiedPrompts;
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
