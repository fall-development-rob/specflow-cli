/**
 * MCP stdio JSON-RPC 2.0 server.
 * Reads newline-delimited JSON from stdin, writes responses to stdout.
 * All diagnostics go to stderr.
 */

import * as readline from 'readline';
import {
  JsonRpcRequest,
  JsonRpcResponse,
  successResponse,
  errorResponse,
  PARSE_ERROR,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
} from './protocol';
import { toolDefinitions, callTool } from './tools';

const VERSION = require('../../package.json').version;

export function run(): void {
  process.stderr.write('[specflow-mcp] Starting MCP server (stdio)...\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: undefined,
    terminal: false,
  });

  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed);
    } catch (e: any) {
      process.stderr.write(`[specflow-mcp] Parse error: ${e.message}\n`);
      writeResponse(errorResponse(null, PARSE_ERROR, `Parse error: ${e.message}`));
      return;
    }

    process.stderr.write(`[specflow-mcp] method=${request.method} id=${JSON.stringify(request.id)}\n`);

    // Notifications (no id) get no response
    if (request.id === undefined || request.id === null) {
      process.stderr.write(`[specflow-mcp] Notification: ${request.method}\n`);
      return;
    }

    const response = handleRequest(request);
    writeResponse(response);
  });

  rl.on('close', () => {
    process.stderr.write('[specflow-mcp] stdin closed, shutting down.\n');
    process.exit(0);
  });
}

function writeResponse(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + '\n');
}

function handleRequest(req: JsonRpcRequest): JsonRpcResponse {
  switch (req.method) {
    case 'initialize':
      return handleInitialize(req);
    case 'ping':
      return successResponse(req.id, {});
    case 'tools/list':
      return handleToolsList(req);
    case 'tools/call':
      return handleToolsCall(req);
    default:
      return errorResponse(req.id, METHOD_NOT_FOUND, `Method not found: ${req.method}`);
  }
}

function handleInitialize(req: JsonRpcRequest): JsonRpcResponse {
  return successResponse(req.id, {
    protocolVersion: '2024-11-05',
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'specflow', version: VERSION },
  });
}

function handleToolsList(req: JsonRpcRequest): JsonRpcResponse {
  return successResponse(req.id, { tools: toolDefinitions() });
}

function handleToolsCall(req: JsonRpcRequest): JsonRpcResponse {
  const params = req.params;
  if (!params) {
    return errorResponse(req.id, INVALID_PARAMS, 'Missing params for tools/call');
  }

  const name = params.name;
  if (!name) {
    return errorResponse(req.id, INVALID_PARAMS, 'Missing tool name');
  }

  const args = params.arguments || {};
  process.stderr.write(`[specflow-mcp] tools/call name=${name}\n`);

  const result = callTool(name, args);
  return successResponse(req.id, result);
}

/**
 * Register the MCP server with Claude Code.
 */
export function register(): void {
  const { execSync } = require('child_process');
  process.stderr.write('Registering specflow MCP server with Claude Code...\n');
  try {
    execSync('claude mcp add specflow -- specflow mcp start', { stdio: 'inherit' });
    process.stderr.write('Registered successfully. Use "claude" to verify.\n');
  } catch {
    process.stderr.write('claude mcp add failed\n');
    process.exit(1);
  }
}

/**
 * Unregister the MCP server from Claude Code.
 */
export function unregister(): void {
  const { execSync } = require('child_process');
  process.stderr.write('Unregistering specflow MCP server from Claude Code...\n');
  try {
    execSync('claude mcp remove specflow', { stdio: 'inherit' });
    process.stderr.write('Unregistered successfully.\n');
  } catch {
    process.stderr.write('claude mcp remove failed\n');
    process.exit(1);
  }
}
