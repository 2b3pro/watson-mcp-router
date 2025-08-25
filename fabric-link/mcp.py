import json
import sys
import requests
import os
import re

def json_parse(stream_content):
    try:
        # Assuming the stream content is a single JSON object or a series of JSON objects
        # We need to handle cases where multiple JSON objects are concatenated without delimiters
        # A simple approach for now is to try parsing the whole thing.
        # If it's a stream of individual JSON objects, we might need to split them first.
        # The user's request `final_result = json_parse(complete_stream)` suggests `complete_stream`
        # is expected to be parseable as a single JSON entity.

        # First, strip the "event: message\ndata: " prefix from each potential line
        cleaned_content = re.sub(r"(?m)^event: message\n^data: ", "", stream_content)

        parsed_data = json.loads(cleaned_content)
        # Assuming the structure is { "result": { "content": "..." } }
        if isinstance(parsed_data, dict) and "result" in parsed_data and "content" in parsed_data["result"]:
            content_value = parsed_data["result"]["content"]
            if isinstance(content_value, (list, dict)): # If it's a list or dict, convert to string
                return json.dumps(content_value, indent=2)
            else: # Otherwise, it's already a string or other primitive type
                return str(content_value) # Ensure it's explicitly a string
        else:
            # If the expected path is not found, return the full parsed data or handle as error
            return json.dumps(parsed_data, indent=2) # Return pretty-printed JSON if content not found
    except json.JSONDecodeError as e:
        sys.stderr.write(f"Error decoding JSON from stream: {e}\nContent: {stream_content}\n")
        return f"JSON Decode Error: {e}"
    except Exception as e:
        sys.stderr.write(f"An unexpected error occurred during JSON parsing: {e}\n")
        return f"Unexpected Error: {e}"


WATSON_MCP_ROUTER_URL = os.environ.get("WATSON_MCP_ROUTER_URL", "http://localhost:3000/mcp")
SESSION_ID_FILE = ".mcp_session_id" # File to store session ID

def _get_session_id():
    if os.path.exists(SESSION_ID_FILE):
        with open(SESSION_ID_FILE, "r") as f:
            sid = f.read().strip()
            # print(f"DEBUG: Loaded session_id from file: {sid}", file=sys.stderr)
            return sid
    # print("DEBUG: No session_id file found.", file=sys.stderr)
    return None

def _save_session_id(session_id):
    with open(SESSION_ID_FILE, "w") as f:
        f.write(session_id)
    # print(f"DEBUG: Saved new session_id to file: {session_id}", file=sys.stderr)

def main():
    session_id = _get_session_id() # Load session_id at the start

    # --- Initialization Logic ---
    if session_id is None:
        # print("DEBUG: No session_id found. Attempting initial 'initialize' request.", file=sys.stderr)
        initialize_message = {
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18", # As per MCP spec
                "clientInfo": {
                    "name": "FabricLinkClient",
                    "version": "1.0.0"
                },
                "capabilities": {
                    "roots": {
                        "listChanged": True
                    },
                    "sampling": {}, # Added as per MCP spec
                    "elicitation": {} # Added as per MCP spec
                }
            },
            "id": 0 # A common ID for initialization
        }
        # Explicitly encode JSON and set Content-Type
        init_data = json.dumps(initialize_message)
        init_headers = {
            "Content-Type": "application/json",
            "MCP-Protocol-Version": "2025-06-18", # Add protocol version header
            "Accept": "application/json; text/event-stream"
        }
        try:
            # print("DEBUG: initialize_message, init_headers",init_data, init_headers)
            init_response = requests.post(WATSON_MCP_ROUTER_URL, data=init_data, headers=init_headers) # Use data= and init_data
            init_response.raise_for_status()
            new_session_id = init_response.headers.get("mcp-session-id")
            if new_session_id:
                _save_session_id(new_session_id)
                session_id = new_session_id
                # print(f"DEBUG: Successfully initialized and saved session_id: {session_id}", file=sys.stderr)
            else:
                print("WARNING: No mcp-session-id received in initial 'initialize' response.", file=sys.stderr)
            # Output the initialize response to stdout
            sys.stdout.write(init_response.text + "\n")
            sys.stdout.flush()
            # print(f"DEBUG: Initial 'initialize' response sent to stdout. Response: {init_response.text}", file=sys.stderr) # Added for clarity
        except requests.exceptions.RequestException as e:
            error_message = {
                "jsonrpc": "2.0",
                "error": {
                    "code": -32003, # Internal error
                    "message": f"Initial HTTP Request failed during 'initialize': {e}",
                },
                "id": initialize_message.get("id", None)
            }
            sys.stdout.write(json.dumps(error_message) + "\n")
            sys.stdout.flush()
            print(f"Error: Initial 'initialize' HTTP request failed: {e}", file=sys.stderr)
            return # Critical error, cannot proceed without initialization
        except Exception as e:
            error_message = {
                "jsonrpc": "2.0",
                "error": {
                    "code": -32000, # Server error
                    "message": f"An unexpected error occurred during initial 'initialize': {e}",
                },
                "id": initialize_message.get("id", None)
            }
            sys.stdout.write(json.dumps(error_message) + "\n")
            sys.stdout.flush()
            print(f"Error: An unexpected error occurred during initial 'initialize': {e}", file=sys.stderr)
            return # Critical error, cannot proceed without initialization
    # else:
        # print(f"DEBUG: Session_id already exists: {session_id}. Skipping initial 'initialize'.", file=sys.stderr)

    # --- End Initialization Logic ---

    # Read the actual command input from stdin
    full_input = sys.stdin.read()

    message = None
    json_content = None

    # Try to find content between ```json ... ```
    json_match = re.search(r"```json\s*(.*?)\s*```", full_input, re.DOTALL)

    if json_match:
        json_content = json_match.group(1)
        try:
            # Attempt to parse the extracted JSON content
            message = json.loads(json_content)
        except json.JSONDecodeError:
            error_message = {
                "jsonrpc": "2.0",
                "error": {
                    "code": -32700, # Parse error
                    "message": f"Error: Could not decode JSON from extracted content: {json_content.strip()}",
                },
                "id": None
            }
            sys.stdout.write(json.dumps(error_message) + "\n")
            sys.stdout.flush()
            print(f"Error: Could not decode JSON from extracted content: {json_content.strip()}", file=sys.stderr)
            return # Exit if the extracted content is not valid JSON
    elif full_input.strip() == "":
        # If no input is provided after initialization, the script just exits after handling initialization.
        # This is expected if the script is run without any piped input.
        # print("DEBUG: No further input received after initialization. Exiting.", file=sys.stderr)
        return
    else:
        error_message = {
            "jsonrpc": "2.0",
            "error": {
                "code": -32700, # Parse error
                "message": "Error: Could not find JSON content within ```json ... ``` block or empty input.",
            },
            "id": None
        }
        sys.stdout.write(json.dumps(error_message) + "\n")
        sys.stdout.flush()
        print("Error: Could not find JSON content within ```json ... ``` block or empty input.", file=sys.stderr)
        return # Exit if the expected format is not found

    # If we reached here, 'message' contains a valid JSON-RPC request (not an 'initialize' from empty input)
    headers = {
        "Content-Type": "application/json", # Ensures JSON-RPC requests are sent with correct content type
        "MCP-Protocol-Version": "2025-06-18", # Add protocol version header
        "Accept": "application/json; text/event-stream"
    }
    if session_id:
        headers["mcp-session-id"] = session_id
    else:
        # This case should ideally not happen if initialization was successful.
        # If it does, it means we couldn't get a session_id, so we can't send a request that requires it.
        error_message = {
            "jsonrpc": "2.0",
            "error": {
                "code": -32003, # Internal error
                "message": "Session ID not available after initialization attempt.",
            },
            "id": message.get("id", None)
        }
        sys.stdout.write(json.dumps(error_message) + "\n")
        sys.stdout.flush()
        print("Error: Session ID not available. Cannot send request.", file=sys.stderr)
        return


    try:
        # Check if it's an initialize request (this check is now for *subsequent* initialize requests, which shouldn't happen often)
        is_initialize_request = (
            isinstance(message, dict) and
            message.get("method") == "initialize"
        )

        # if is_initialize_request:
            # print("DEBUG: Received a *subsequent* 'initialize' request. This should ideally be handled by initial handshake.", file=sys.stderr)
            # If a subsequent initialize request is received, we might still want to update the session ID if it's different.
            # However, the primary initialization is handled above. For now, we'll just send it as a normal request.

        # Send the request with the constructed headers
        # print(f"DEBUG: Sending message: {message} with headers: {headers}", file=sys.stderr)
        response = requests.post(WATSON_MCP_ROUTER_URL, data=json.dumps(message), headers=headers) # Use data= and json.dumps(message)

        response.raise_for_status() # Raise an HTTPError for bad responses (4xx or 5xx)

        # If it was a subsequent initialize request, try to capture and save the session_id
        if is_initialize_request: # This covers cases where another initialize request comes in after the first implicit one
            new_session_id = response.headers.get("mcp-session-id")
            if new_session_id and new_session_id != session_id: # Only update if it's a *new* session ID
                _save_session_id(new_session_id) # Save the new session ID
                session_id = new_session_id
                # print(f"DEBUG: Updated session_id from subsequent 'initialize': {session_id}", file=sys.stderr)
            # elif new_session_id == session_id:
                # print("DEBUG: Subsequent 'initialize' received same session_id. No update needed.", file=sys.stderr)
            else:
                print("WARNING: No mcp-session-id received in subsequent 'initialize' response.", file=sys.stderr)
        # else:
            # print("DEBUG: Not an 'initialize' request, skipping session_id capture.", file=sys.stderr)

        content_type = response.headers.get("Content-Type")

        if content_type == "text/event-stream":
            full_stream_content = []
            for line in response.iter_lines():
                if line: # Filter out keep-alive new lines
                    full_stream_content.append(line.decode("utf-8"))

            # Join all lines to form the complete stream content
            complete_stream = "\n".join(full_stream_content)

            final_result = json_parse(complete_stream)

            sys.stdout.write(final_result + "\n")
            sys.stdout.flush()
        else:
            # Output the raw response text to stdout
            sys.stdout.write(response.text + "\n")
            sys.stdout.flush()

    except requests.exceptions.RequestException as e:
        error_message = {
            "jsonrpc": "2.0",
            "error": {
                "code": -32003, # Internal error
                "message": f"HTTP Request failed: {e}",
            },
            "id": message.get("id", None)
        }
        sys.stdout.write(json.dumps(error_message) + "\n")
        sys.stdout.flush()
        print(f"Error: HTTP request failed: {e}", file=sys.stderr)
    except Exception as e:
        error_message = {
            "jsonrpc": "2.0",
            "error": {
                "code": -32000, # Server error
                "message": f"An unexpected error occurred: {e}",
            },
            "id": message.get("id", None)
        }
        sys.stdout.write(json.dumps(error_message) + "\n")
        sys.stdout.flush()
        print(f"Error: An unexpected error occurred: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
