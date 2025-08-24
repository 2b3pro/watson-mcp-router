# Changelog

## [Unreleased]

### Added
- Created a standard `.gitignore` file for common files and directories to ignore.
- Implemented registration of unified MCP tools, resources, and prompts from `ServerManager`.

### Fixed
- Corrected the handling of `inputSchema` and `argsSchema` for dynamically registered tools and prompts, ensuring they are properly converted to ZodRawShape for correct registration and visibility in external clients.
- Corrected McpServer initialization by removing direct `capabilities` passing in the constructor, ensuring dynamic registration of tools, resources, and prompts is properly reflected to clients.
