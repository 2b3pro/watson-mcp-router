declare module '@modelcontextprotocol/sdk/server/mcp.js' {
    import { z } from 'zod'; // Assuming zod is used for schemas

    export interface ToolOptions {
        title: string;
        description?: string;
        inputSchema: z.ZodObject<any> | z.ZodEffects<any>;
    }

    export interface ResourceOptions {
        title: string;
        description?: string;
        mimeType?: string;
    }

    export interface PromptOptions {
        title: string;
        description?: string;
        argsSchema: z.ZodObject<any> | z.ZodEffects<any>;
    }

    export class McpServer {
        constructor(options: { name: string; version: string; capabilities?: { tools?: Tool[]; resources?: Resource[]; prompts?: Prompt[] } });
        connect(transport: any): Promise<void>;
        getCapabilities(): { tools: Tool[]; resources: Resource[]; prompts?: Prompt[] };

        registerTool(toolName: string, options: ToolOptions, handler: (input: any) => Promise<any>): void;
        registerResource(name: string, uri: string, options: ResourceOptions, handler: (uri: any, params: any) => Promise<any>): void;
        registerResource(name: string, resourceTemplate: ResourceTemplate, options: ResourceOptions, handler: (uri: any, params: any) => Promise<any>): void;
        registerPrompt(promptName: string, options: PromptOptions, handler: (input: any) => Promise<any>): void;
    }

    export class ResourceTemplate {
        constructor(uriPattern: string, options: { list?: any; complete?: any });
    }

    export interface Tool {
        name: string;
        description?: string;
        inputSchema?: any; // This will actually be a zod schema in practice
        [key: string]: any; // Allow other properties like 'title'
    }

    export interface Resource {
        uri: string;
        type?: string;
        title?: string;
        description?: string;
        contents?: Array<{ uri: string; text: string }>;
        [key: string]: any;
    }

    export interface Prompt {
        name: string;
        description?: string;
        argsSchema?: any; // This will actually be a zod schema in practice
        [key: string]: any; // Allow other properties like 'title'
    }
}

declare module '@modelcontextprotocol/sdk/client/index.js' { // New module for Client
    export class Client {
        constructor(options: { name: string; version: string });
        connect(transport: any): Promise<void>;
        listTools(): Promise<{ tools: any[] }>;
        listResources(): Promise<{ resources: any[] }>;
        listPrompts(): Promise<{ prompts: any[] }>; // Added listPrompts
        getCapabilities(): { tools: any[]; resources: any[]; prompts?: any[] }; // Client also has getCapabilities
    }
}

declare module '@modelcontextprotocol/sdk/client/stdio.js' { // New module for StdioClientTransport
    export class StdioClientTransport {
        constructor(options: { command: string; args: string[] });
    }
}

declare module '@modelcontextprotocol/sdk/server/streamableHttp.js' {
    import { Request, Response } from 'express'; // Assuming express types
    export class StreamableHTTPServerTransport {
        sessionId?: string; // Add sessionId property
        onclose?: () => void; // Add onclose property
        constructor(options?: { sessionIdGenerator?: () => string, enableJsonResponse?: boolean, eventStore?: any, onsessioninitialized?: (sessionId: string) => void, onsessionclosed?: (sessionId?: string) => void, allowedHosts?: string[], allowedOrigins?: string[], enableDnsRebindingProtection?: boolean });
        handleRequest(req: Request, res: Response, parsedBody?: any): Promise<void>;
        listen(port: number, callback: () => void): void;
    }
}
