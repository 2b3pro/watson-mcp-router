# Changelog

## [Unreleased]

### Added
- Created a standard `.gitignore` file for common files and directories to ignore.
- Implemented registration of unified MCP tools, resources, and prompts from `ServerManager`.

### Fixed
- Corrected the handling of `inputSchema` and `argsSchema` for dynamically registered tools and prompts, ensuring they are properly converted to ZodRawShape for correct registration and visibility in external clients.
- Corrected McpServer initialization by removing direct `capabilities` passing in the constructor, ensuring dynamic registration of tools, resources, and prompts is properly reflected to clients.
- Resolved unmarshaling errors and type compatibility issues in tool and prompt handlers:
    - Fixed argument passing to `Client.callTool` to resolve original unmarshaling errors.
    - Implemented a workaround in `CustomStdioClientTransport` to handle `structuredContent: null` responses from child servers, preventing `ZodError` during response parsing.
    - Adjusted tool and prompt handler return formats to align with `McpServer`'s expected `messages` array structure, addressing associated TypeScript compilation errors.
- Fixed raw result return; misconfiguration of response message