# Fabric-Link for Watson MCP Router

A bridge utility that enables [Fabric AI](https://github.com/danielmiessler/fabric) to interact with MCP servers managed by Watson MCP Router.

## Overview

Since Fabric AI doesn't natively support MCP tool calling or schema definitions, this utility provides a workaround by:

1. Accepting Fabric AI's markdown output via stdin
2. Extracting JSON-RPC 2.0 compliant requests from code blocks
3. Forwarding these requests to the appropriate MCP servers via Watson MCP Router

## How It Works

```
Fabric AI → Markdown Output → fabric-link → Watson MCP Router → Child MCP Servers
```

The `mcp.py` script acts as an MCP client that parses structured JSON from Fabric AI's markdown responses and routes them to the correct MCP server tools.

## Usage

### Prerequisites

- Python 3.8+
- Watson MCP Router running with configured child servers
- Fabric AI installed and configured

### Installation

```bash
cd fabric-link
pip install -r requirements.txt  # or use pyproject.toml
```

### Running

```bash
# Pipe Fabric AI output to fabric-link
fabric --pattern analyze_domains "example.com google.com" | python mcp.py
```

## Configuration for Fabric AI

### System Instructions

Add these instructions to your Fabric AI patterns to ensure proper JSON output:

```
Return a valid JSON object based on the user's query. Generate a random UUID for the request ID.

The JSON must be wrapped in a markdown code block and follow JSON-RPC 2.0 format.
```

### JSON Template

Fabric AI should output JSON in this format:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "<server_name>_<tool_name>",
    "arguments": {
      "<param1>": "<value1>",
      "<param2>": "<value2>"
    }
  },
  "id": "<uuid>"
}
```

### Tool Naming Convention

Tool names must follow Watson MCP Router's naming pattern:
```
<mcp_server_alias>_<original_tool_name>
```

**Examples:**
- `who-dat-mcp_get_whois_multi` (from `who-dat-mcp` server's `get_whois_multi` tool)
- `weather_get_forecast` (from `weather` server's `get_forecast` tool)
- `database_query_users` (from `database` server's `query_users` tool)

## Example Workflow

### 1. Fabric AI Pattern Output

```markdown
Based on your request to analyze domains, here's the MCP call:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "who-dat-mcp_get_whois_multi",
    "arguments": {
      "domains": ["example.com", "google.com", "github.com"]
    }
  },
  "id": "550e8400-e29b-41d4-a716-446655440000"
}
```

This will retrieve WHOIS information for the specified domains.
```

### 2. fabric-link Processing

The `mcp.py` script:
1. Parses the markdown input
2. Extracts the JSON code block
3. Validates the JSON-RPC format
4. Forwards the request to Watson MCP Router
5. Returns the response

### 3. MCP Server Execution

Watson MCP Router:
1. Receives the JSON-RPC request
2. Routes to the `who-dat-mcp` server
3. Calls the `get_whois_multi` tool
4. Returns the WHOIS data

## Supported Methods

Currently supports:
- `tools/call` - Execute MCP server tools

Future support planned for:
- `resources/read` - Access MCP server resources
- `prompts/get` - Retrieve MCP server prompts

## Error Handling

The script handles common errors:
- Invalid JSON format in markdown
- Missing required JSON-RPC fields
- Unknown tool names
- MCP server communication failures

## Development

### Project Structure

```
fabric-link/
├── mcp.py           # Main bridge script
├── pyproject.toml   # Python project configuration
└── README.md        # This file
```

### Testing

```bash
# Test with sample JSON
echo '```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "test_tool",
    "arguments": {}
  },
  "id": "test-123"
}
```' | python mcp.py
```

## Troubleshooting

**JSON not extracted from markdown**
- Ensure JSON is wrapped in proper markdown code blocks
- Verify JSON syntax is valid

**Tool not found errors**
- Check that the MCP server is configured in Watson MCP Router
- Verify tool name follows the `<server>_<tool>` convention
- Confirm the target MCP server is running

**Connection issues**
- Ensure Watson MCP Router is running on the expected port
- Check network connectivity between fabric-link and the router

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test with various Fabric AI patterns
5. Submit a pull request

## Related Projects

- [Watson MCP Router](../) - The main MCP proxy server
- [Fabric AI](https://github.com/danielmiessler/fabric) - AI-powered content processing
- [Model Context Protocol](https://modelcontextprotocol.io/) - The underlying protocol
