/**
 * JSON-RPC 2.0 and MCP protocol types.
 */

export interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  id?: string | number | null;
  params?: any;
}

export interface JsonRpcResponse {
  jsonrpc: string;
  id?: string | number | null;
  result?: any;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: any;
}

export interface ServerInfo {
  name: string;
  version: string;
}

export interface ServerCapabilities {
  tools: { listChanged: boolean };
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: ServerInfo;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: any;
}

export interface ToolsListResult {
  tools: ToolDefinition[];
}

export interface ToolCallParams {
  name: string;
  arguments?: any;
}

export interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

// Error codes
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

// Helpers
export function successResponse(id: any, result: any): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function errorResponse(id: any, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function toolResultText(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }] };
}

export function toolResultError(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }], isError: true };
}
