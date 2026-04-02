use std::io::{self, BufRead, Write};

use serde_json::{json, Value};

use super::protocol::*;
use super::tools;

/// Run the MCP stdio server. Reads newline-delimited JSON-RPC from stdin,
/// writes responses to stdout. All diagnostics go to stderr.
pub fn run() -> ! {
    eprintln!("[specflow-mcp] Starting MCP server (stdio)...");

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut stdout = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[specflow-mcp] stdin read error: {}", e);
                break;
            }
        };

        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        // Parse JSON-RPC request
        let request: JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[specflow-mcp] Parse error: {}", e);
                let resp = JsonRpcResponse::error(None, PARSE_ERROR, format!("Parse error: {}", e));
                write_response(&mut stdout, &resp);
                continue;
            }
        };

        eprintln!("[specflow-mcp] method={} id={:?}", request.method, request.id);

        // Notifications (no id) get no response
        if request.id.is_none() {
            eprintln!("[specflow-mcp] Notification: {}", request.method);
            continue;
        }

        let response = handle_request(&request);
        write_response(&mut stdout, &response);
    }

    eprintln!("[specflow-mcp] stdin closed, shutting down.");
    std::process::exit(0);
}

fn write_response(stdout: &mut impl Write, response: &JsonRpcResponse) {
    let json = serde_json::to_string(response).unwrap();
    let _ = writeln!(stdout, "{}", json);
    let _ = stdout.flush();
}

fn handle_request(req: &JsonRpcRequest) -> JsonRpcResponse {
    match req.method.as_str() {
        "initialize" => handle_initialize(req),
        "ping" => JsonRpcResponse::success(req.id.clone(), json!({})),
        "tools/list" => handle_tools_list(req),
        "tools/call" => handle_tools_call(req),
        _ => JsonRpcResponse::error(
            req.id.clone(),
            METHOD_NOT_FOUND,
            format!("Method not found: {}", req.method),
        ),
    }
}

fn handle_initialize(req: &JsonRpcRequest) -> JsonRpcResponse {
    let result = InitializeResult {
        protocol_version: "2024-11-05".into(),
        capabilities: ServerCapabilities {
            tools: ToolsCapability {
                list_changed: false,
            },
        },
        server_info: ServerInfo {
            name: "specflow".into(),
            version: env!("CARGO_PKG_VERSION").into(),
        },
    };
    JsonRpcResponse::success(req.id.clone(), serde_json::to_value(result).unwrap())
}

fn handle_tools_list(req: &JsonRpcRequest) -> JsonRpcResponse {
    let defs = tools::tool_definitions();
    let result = ToolsListResult { tools: defs };
    JsonRpcResponse::success(req.id.clone(), serde_json::to_value(result).unwrap())
}

fn handle_tools_call(req: &JsonRpcRequest) -> JsonRpcResponse {
    let params = match &req.params {
        Some(p) => p,
        None => {
            return JsonRpcResponse::error(
                req.id.clone(),
                INVALID_PARAMS,
                "Missing params for tools/call",
            )
        }
    };

    let call_params: ToolCallParams = match serde_json::from_value(params.clone()) {
        Ok(p) => p,
        Err(e) => {
            return JsonRpcResponse::error(
                req.id.clone(),
                INVALID_PARAMS,
                format!("Invalid tool call params: {}", e),
            )
        }
    };

    let args = call_params.arguments.unwrap_or(Value::Object(Default::default()));
    eprintln!("[specflow-mcp] tools/call name={}", call_params.name);

    let result = tools::call_tool(&call_params.name, &args);
    JsonRpcResponse::success(req.id.clone(), serde_json::to_value(result).unwrap())
}

/// Register the MCP server with Claude Code.
pub fn register() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("Cannot find self: {}", e))?;
    let exe_str = exe.to_string_lossy();

    eprintln!("Registering specflow MCP server with Claude Code...");
    let status = std::process::Command::new("claude")
        .args(["mcp", "add", "specflow", "--", &exe_str, "mcp", "start"])
        .status()
        .map_err(|e| format!("Failed to run claude: {}", e))?;

    if status.success() {
        eprintln!("Registered successfully. Use 'claude' to verify.");
        Ok(())
    } else {
        Err("claude mcp add failed".into())
    }
}

/// Unregister the MCP server from Claude Code.
pub fn unregister() -> Result<(), String> {
    eprintln!("Unregistering specflow MCP server from Claude Code...");
    let status = std::process::Command::new("claude")
        .args(["mcp", "remove", "specflow"])
        .status()
        .map_err(|e| format!("Failed to run claude: {}", e))?;

    if status.success() {
        eprintln!("Unregistered successfully.");
        Ok(())
    } else {
        Err("claude mcp remove failed".into())
    }
}
