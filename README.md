# Watson MCP Router

A centralized proxy server for the Model Context Protocol (MCP) that aggregates multiple MCP servers into a unified interface.

## Overview

Watson MCP Router acts as a single entry point for multiple MCP servers, consolidating their tools, resources, and prompts under one unified API. This simplifies client integration by eliminating the need to manage connections to multiple individual MCP servers.

## Key Features

- **Unified Interface**: Aggregates capabilities from multiple child MCP servers
- **Automatic Discovery**: Dynamically discovers and exposes all child server capabilities
- **Namespace Isolation**: Prefixes capabilities with server names to prevent conflicts
- **Flexible Configuration**: Supports custom commands, environments, and working directories
- **Built-in Monitoring**: Provides server statistics via special resource endpoint
- **Graceful Lifecycle**: Manages child processes with proper startup and shutdown

## Quick Start

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Installation

```bash
git clone https://github.com/2b3pro/watson-mcp-router.git
cd watson-mcp-router
npm install
```

### Configuration

Create `watson_mcprouter_config.json` in the project root:

```json
{
  "mcpServers": {
    "weather": {
      "type": "stdio",
      "command": "node",
      "args": ["./servers/weather/index.js"]
    },
    "database": {
      "type": "stdio", 
      "command": "python",
      "args": ["-u", "./servers/db/main.py"],
      "env": {
        "DB_URL": "postgresql://localhost:5432/mydb"
      },
      "cwd": "./servers/db"
    }
  }
}
```

### Running

```bash
npm start
```

The router starts on port 3000 and exposes the MCP endpoint at `/mcp`.

## Configuration Reference

### Server Configuration

Each server in `mcpServers` supports these properties:

| Property | Required | Description |
|----------|----------|-------------|
| `type` | ✓ | Transport type (currently only `"stdio"`) |
| `command` | ✓ | Executable command (e.g., `"node"`, `"python"`) |
| `args` | ✓ | Array of command arguments |
| `env` | | Environment variables for the child process |
| `cwd` | | Working directory for the child process |
| `disabled` | | Set to `true` to skip this server (default: `false`) |

### Example Configuration

```json
{
  "mcpServers": {
    "file-manager": {
      "type": "stdio",
      "command": "node",
      "args": ["./dist/file-server.js"],
      "env": {
        "LOG_LEVEL": "debug"
      },
      "cwd": "/opt/file-server"
    },
    "api-client": {
      "type": "stdio",
      "command": "./bin/api-server",
      "args": ["--config", "production.json"],
      "disabled": false
    },
    "legacy-server": {
      "type": "stdio",
      "command": "python",
      "args": ["legacy.py"],
      "disabled": true
    }
  }
}
```

## Usage

### Capability Naming

Child server capabilities are automatically prefixed with their server alias:

- **Tools**: `weather_get_forecast` (from `weather` server's `get_forecast` tool)
- **Resources**: `database_users://active` (from `database` server's `users://active` resource)
- **Prompts**: `file-manager_organize` (from `file-manager` server's `organize` prompt)

### Server Statistics

Access router statistics via the special resource:

```
stats://mcp-router-server
```

Returns information about active servers, total capabilities, and system status.

### Client Integration

Connect your MCP client to:
```
http://localhost:3000/mcp
```

All child server capabilities will be available through this single endpoint.

## Docker Support

### Build Image

```bash
docker build -t watson-mcp-router .
```

### Run Container

```bash
docker run -p 3000:3000 -v $(pwd)/watson_mcprouter_config.json:/app/watson_mcprouter_config.json watson-mcp-router
```

## Development

### Project Structure

```
src/
├── index.ts          # Main application and MCP protocol handling
├── serverManager.ts  # Child server lifecycle management
└── types/           # TypeScript type definitions
```

### Key Components

- **ServerManager**: Handles spawning, communication, and capability aggregation
- **MCP Protocol Handler**: Converts between HTTP and MCP protocol messages
- **Schema Converter**: Transforms JSON schemas to Zod for validation

### Building

```bash
npm run build
```

### Testing

```bash
npm test
```

## Troubleshooting

### Common Issues

**Child servers not starting**
- Verify command paths and arguments in configuration
- Check that required dependencies are installed
- Review server logs for startup errors

**Capabilities not appearing**
- Ensure child servers implement MCP protocol correctly
- Check for naming conflicts between servers
- Verify servers are not disabled in configuration

**Connection issues**
- Confirm router is running on expected port
- Check firewall settings if accessing remotely
- Verify MCP client is connecting to correct endpoint

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Related Projects

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
