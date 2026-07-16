import type { McpServerConfig, McpServerStatus } from '../../store/types.ts'

export interface McpServerConnection {
  serverName: string
  config: McpServerConfig
  status: McpServerStatus
  client: import('@modelcontextprotocol/sdk/client/index.js').Client | null
  transport: import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport | null
  tools: McpToolDefinition[]
  circuitState: {
    open: boolean
    openedAt: number | null
    failureCount: number
    lastFailureAt: number | null
    lastRecoveryAt: number | null
  }
  connectedAt: number | null
}

export interface McpToolDefinition {
  serverName: string
  name: string
  originalName: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface McpToolCallResult {
  serverName: string
  toolName: string
  success: boolean
  content: McpToolCallContent[]
  isError?: boolean
}

export interface McpToolCallContent {
  type: 'text' | 'image' | 'audio' | 'resource'
  text?: string
  data?: string
  mimeType?: string
}

export interface McpToolCallRequest {
  serverName: string
  toolName: string
  arguments: Record<string, unknown>
}

export const MCP_TOOL_PREFIX = 'mcp__'
export const MCP_TOOL_SEPARATOR = '__'

export const CIRCUIT_BREAKER = {
  MAX_FAILURES: 3,
  WINDOW_MS: 60_000,
  OPEN_DURATION_MS: 300_000,
} as const

export const RECOVERY_BACKOFF = {
  INITIAL_DELAY_MS: 1000,
  MAX_DELAY_MS: 16_000,
  MAX_ATTEMPTS: 5,
} as const

export function buildMcpToolName(serverName: string, originalToolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}${MCP_TOOL_SEPARATOR}${originalToolName}`
}

export function parseMcpToolName(fullName: string): { serverName: string; toolName: string } | null {
  if (!fullName.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = fullName.slice(MCP_TOOL_PREFIX.length)
  const sepIndex = rest.indexOf(MCP_TOOL_SEPARATOR)
  if (sepIndex === -1) return null
  return {
    serverName: rest.slice(0, sepIndex),
    toolName: rest.slice(sepIndex + MCP_TOOL_SEPARATOR.length),
  }
}
