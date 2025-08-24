# Watson MCP Router

The Watson MCP Router is a Model Context Protocol (MCP) server designed to act as a centralized proxy for multiple other MCP servers. It simplifies interaction with a diverse set of MCP services by consolidating their capabilities (tools, resources, and prompts) under a single entry point. This allows MCP clients, such as an AI agent, to seamlessly access functionalities from various backend MCP servers as if they were part of a single, unified system.

## Features

*   **Unified Capability Aggregation**: Automatically discovers and aggregates tools, resources, and prompts from multiple configured child MCP servers.
*   **Dynamic Capability Exposure**: Exposes all aggregated capabilities through its own MCP interface, simplifying client-side integration.
*   **Unique Naming Convention**: Unified capabilities are automatically prefixed with their originating server's name (e.g., `serverName_toolName`, `serverName_resourceUri`) to ensure uniqueness and traceability.
*   **Standard I/O Communication**: Communicates with child MCP servers via standard input/output (stdio), providing a robust and widely compatible transport mechanism.
*   **Flexible Child Server Configuration**: Child servers can be configured with custom commands, arguments, environment variables, and working directories, allowing for diverse deployment scenarios.
*   **Graceful Shutdown**: Manages the lifecycle of spawned child processes, ensuring proper shutdown upon termination of the router.
*   **Built-in Server Statistics**: Provides a special `server-stats` resource (`stats://mcp-router-server`) that offers insights into the number of active servers, tools, resources, and prompts managed by the router.

## Installation

To set up the Watson MCP Router, follow these steps:

1.  **Prerequisites**: Ensure you have Node.js (v18 or higher recommended) and npm (or yarn) installed on your system.

2.  **Clone the Repository**:
    ```bash
    git clone https://github.com/your-repo/watson-mcp-router.git
    cd watson-mcp-router
    ```
    *(Note: Replace `https://github.com/your-repo/watson-mcp-router.git` with the actual repository URL if it's hosted elsewhere.)*

3.  **Install Dependencies**:
    ```bash
    npm install
    # or
    yarn install
    ```

## Dockerization

To build and run the Watson MCP Router using Docker:

1.  **Build the Docker Image**:
    Navigate to the project's root directory in your terminal and run:
    ```bash
    docker build -t watson-mcp-router .
    ```

2.  **Run the Docker Container**:
    To run the Docker container, exposing port 3000 (assuming your application listens on this port):
    ```bash
    docker run -p 3000:3000 watson-mcp-router
    ```
    You can adjust the port mapping (`-p 3000:3000`) if your application listens on a different port or if you want to map it to a different host port.

## Configuration

The Watson MCP Router uses a `watson_mcprouter_config.json` file at the root of the project to define the child MCP servers it should manage.

### `watson_mcprouter_config.json` Structure

```json
{
  "mcpServers": {
    "server_alias_1": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/your/server1/index.js"],
      "env": {
        "DEBUG": "true"
      },
      "cwd": "/path/to/your/server1",
      "disabled": false
    },
    "server_alias_2": {
      "type": "stdio",
      "command": "python",
      "args": ["-u", "/path/to/your/server2/main.py"],
      "disabled": false
    },
    "disabled_server_example": {
      "type": "stdio",
      "command": "echo",
      "args": ["This server is disabled"],
      "disabled": true
    }
  }
}
```

### Configuration Properties:

*   **`mcpServers`**: An object where each key is a unique alias for a child MCP server, and its value is an object defining that server's configuration.
    *   **`type` (required)**: The communication transport type. Currently, only `"stdio"` is supported.
    *   **`command` (required)**: The executable command to run the child server (e.g., `"node"`, `"python"`, `"./my-mcp-server"`).
    *   **`args` (required)**: An array of string arguments to pass to the `command`.
    *   **`env` (optional)**: An object of environment variables to set for the child process. These will be merged with the router's current environment variables.
    *   **`cwd` (optional)**: The current working directory for the child process. If not specified, the router's working directory will be used.
    *   **`disabled` (optional)**: A boolean indicating whether to disable spawning this server. Defaults to `false`.

## Usage

1.  **Create `watson_mcprouter_config.json`**: Before running, create or modify the `watson_mcprouter_config.json` file in the root directory of the project to specify your child MCP servers. Refer to the "Configuration" section above for details.

2.  **Start the Router**:
    ```bash
    npm start
    # or
    yarn start
    ```
    The router will start an Express server and listen for incoming MCP requests, typically on port `3000`. You will see console output indicating which child servers are being spawned and their capabilities loaded.

3.  **Interact with an MCP Client**:
    Connect your MCP client (e.g., Cline, or any other application supporting the Model Context Protocol) to the router's `/mcp` endpoint (e.g., `http://localhost:3000/mcp`).

    When using tools, resources, or prompts provided by the child servers, remember that their original names/URIs will be prefixed with the `server_alias` you defined in `watson_mcprouter_config.json`.

    *   **Example Tool Call**: If `server_alias_1` provides a tool named `my_tool`, you would call `server_alias_1_my_tool` through the router.
    *   **Example Resource Access**: If `server_alias_2` provides a resource at `resource://data`, you would access `server_alias_2_resource://data`.

4.  **Access Server Statistics**:
    You can retrieve statistics about the router itself by accessing the special resource `stats://mcp-router-server`. This resource provides information such as the number of active child servers, aggregated tools, resources, and prompts.

## Development

*   The main application logic resides in `src/index.ts`.
*   The `ServerManager` class in `src/serverManager.ts` handles the spawning, communication, and aggregation of child MCP server capabilities.
*   The `convertJsonSchemaToZod` function in `src/index.ts` is used to convert JSON schemas to Zod schemas for validation purposes.
