import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerConfig } from '../../store/types.ts'
import type {
  McpServerConnection,
  McpToolDefinition,
  McpToolCallRequest,
  McpToolCallResult,
} from './types.ts'
import {
  CIRCUIT_BREAKER,
  RECOVERY_BACKOFF,
} from './types.ts'

type ServerStatusCallback = (serverName: string, status: McpServerConnection['status']) => void

export class McpClientManager {
  protected transportFactory: ((config: McpServerConfig) => Transport) | null = null
  protected connectOverride: ((conn: McpServerConnection) => Promise<void>) | null = null
  private connections = new Map<string, McpServerConnection>()
  private recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private statusCallbacks: ServerStatusCallback[] = []

  onStatusChange(cb: ServerStatusCallback): void {
    this.statusCallbacks.push(cb)
  }

  private notifyStatus(serverName: string, status: McpServerConnection['status']): void {
    for (const cb of this.statusCallbacks) {
      try {
        cb(serverName, status)
      } catch { }
    }
  }

  async startServer(name: string, config: McpServerConfig): Promise<void> {
    const existing = this.connections.get(name)
    if (existing && (existing.status === 'available' || existing.status === 'reconnecting')) {
      return
    }

    const conn: McpServerConnection = {
      serverName: name,
      config,
      status: config.enabled ? 'reconnecting' : 'unavailable',
      client: null,
      transport: null,
      tools: [],
      circuitState: {
        open: config.circuitState?.open ?? false,
        openedAt: config.circuitState?.openedAt ?? null,
        failureCount: config.circuitState?.failureCount ?? 0,
        lastFailureAt: config.circuitState?.lastFailureAt ?? null,
        lastRecoveryAt: null,
      },
      connectedAt: null,
    }

    this.connections.set(name, conn)

    if (!config.enabled) {
      conn.status = 'unavailable'
      this.notifyStatus(name, 'unavailable')
      return
    }

    if (this.isCircuitOpen(conn)) {
      conn.status = 'circuitOpen'
      this.notifyStatus(name, 'circuitOpen')
      return
    }

    await this.connectServer(conn, 0)
  }

  private isCircuitOpen(conn: McpServerConnection): boolean {
    if (!conn.circuitState.open) return false
    const openedAt = conn.circuitState.openedAt
    if (!openedAt) return false
    if (Date.now() - openedAt >= CIRCUIT_BREAKER.OPEN_DURATION_MS) {
      conn.circuitState.open = false
      conn.circuitState.failureCount = 0
      return false
    }
    return true
  }

  private async connectServer(conn: McpServerConnection, attempt: number): Promise<void> {
    if (this.connectOverride) {
      await this.connectOverride(conn)
      return
    }

    const { command, args, env } = conn.config

    let transport: Transport | null = null
    let client: Client | null = null

    try {
      if (this.transportFactory) {
        transport = this.transportFactory(conn.config)
      } else {
        transport = new StdioClientTransport({ command, args, env, stderr: 'pipe' })
      }
      client = new Client(
        { name: 'chat2api', version: '1.4.0' },
        { capabilities: {} },
      )

      const closePromise = new Promise<void>((resolve) => {
        const origClose = transport!.close.bind(transport!)
        transport!.close = async () => {
          await origClose()
          resolve()
        }
      })

      transport.onclose = () => {
        this.handleTransportClose(conn, client)
      }

      transport.onerror = (error: Error) => {
        console.error(`[McpClientManager] Transport error for ${conn.serverName}:`, error.message)
        this.handleTransportClose(conn, client)
      }

      await client.connect(transport)

      conn.client = client
      conn.transport = transport
      conn.status = 'available'
      conn.connectedAt = Date.now()
      conn.circuitState.failureCount = 0
      conn.circuitState.lastRecoveryAt = Date.now()

      try {
        const result = await client.listTools()
        conn.tools = (result.tools || []).map(t => ({
          serverName: conn.serverName,
          name: t.name,
          originalName: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
        }))
      } catch (error) {
        console.error(`[McpClientManager] Failed to list tools for ${conn.serverName}:`, error)
        conn.tools = []
      }

      this.notifyStatus(conn.serverName, 'available')
      console.log(`[McpClientManager] Server ${conn.serverName} connected with ${conn.tools.length} tools`)
    } catch (error) {
      await this.cleanupTransport(client, transport)
      await this.handleConnectionFailure(conn, attempt, error)
    }
  }

  private handleTransportClose(conn: McpServerConnection, client: Client | null): void {
    if (conn.status === 'available') {
      console.log(`[McpClientManager] Server ${conn.serverName} disconnected unexpectedly`)
      conn.status = 'unavailable'
      conn.client = null
      conn.transport = null
      conn.connectedAt = null
      this.notifyStatus(conn.serverName, 'unavailable')
      this.scheduleRecovery(conn)
    }
  }

  private scheduleRecovery(conn: McpServerConnection): void {
    const existingTimer = this.recoveryTimers.get(conn.serverName)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    const attempt = conn.circuitState.failureCount
    if (attempt >= RECOVERY_BACKOFF.MAX_ATTEMPTS) {
      console.error(`[McpClientManager] Server ${conn.serverName} exceeded max recovery attempts`)
      return
    }

    const delay = Math.min(
      RECOVERY_BACKOFF.INITIAL_DELAY_MS * Math.pow(2, attempt),
      RECOVERY_BACKOFF.MAX_DELAY_MS,
    )

    console.log(`[McpClientManager] Scheduling recovery for ${conn.serverName} in ${delay}ms (attempt ${attempt + 1})`)

    const timer = setTimeout(async () => {
      this.recoveryTimers.delete(conn.serverName)
      conn.status = 'reconnecting'
      this.notifyStatus(conn.serverName, 'reconnecting')
      await this.connectServer(conn, attempt + 1)
    }, delay)

    this.recoveryTimers.set(conn.serverName, timer)
  }

  private async handleConnectionFailure(conn: McpServerConnection, attempt: number, error: unknown): Promise<void> {
    conn.circuitState.failureCount++
    conn.circuitState.lastFailureAt = Date.now()

    if (conn.circuitState.failureCount >= CIRCUIT_BREAKER.MAX_FAILURES) {
      conn.circuitState.open = true
      conn.circuitState.openedAt = Date.now()
      conn.status = 'circuitOpen'
      this.notifyStatus(conn.serverName, 'circuitOpen')
      console.error(
        `[McpClientManager] Circuit breaker opened for ${conn.serverName} after ${conn.circuitState.failureCount} failures`,
      )
      return
    }

    if (attempt < RECOVERY_BACKOFF.MAX_ATTEMPTS) {
      this.scheduleRecovery(conn)
    } else {
      conn.status = 'unavailable'
      this.notifyStatus(conn.serverName, 'unavailable')
    }
  }

  private async cleanupTransport(client: Client | null, transport: Transport | null): Promise<void> {
    try {
      if (client) await client.close()
    } catch { }
    try {
      if (transport) await transport.close()
    } catch { }
  }

  async stopServer(name: string): Promise<void> {
    const timer = this.recoveryTimers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.recoveryTimers.delete(name)
    }

    const conn = this.connections.get(name)
    if (!conn) return

    conn.status = 'unavailable'
    this.notifyStatus(name, 'unavailable')

    await this.cleanupTransport(conn.client, conn.transport)
    conn.client = null
    conn.transport = null
    conn.tools = []
    conn.connectedAt = null
  }

  async stopAll(): Promise<void> {
    const names = Array.from(this.connections.keys())
    await Promise.all(names.map(name => this.stopServer(name)))
  }

  getServer(name: string): McpServerConnection | undefined {
    const conn = this.connections.get(name)
    if (!conn) return undefined
    if (conn.status === 'available' && conn.client) return conn
    return undefined
  }

  getAllTools(): McpToolDefinition[] {
    const results: McpToolDefinition[] = []
    for (const conn of this.connections.values()) {
      if (conn.status !== 'available') continue
      for (const tool of conn.tools) {
        results.push(tool)
      }
    }
    return results
  }

  async refreshTools(serverName?: string): Promise<void> {
    const targets = serverName
      ? [this.connections.get(serverName)].filter(Boolean) as McpServerConnection[]
      : Array.from(this.connections.values())

    await Promise.all(
      targets.filter(c => c.status === 'available' && c.client).map(async (conn) => {
        try {
          const result = await conn.client!.listTools()
          conn.tools = (result.tools || []).map(t => ({
            serverName: conn.serverName,
            name: t.name,
            originalName: t.name,
            description: t.description,
            inputSchema: t.inputSchema as Record<string, unknown>,
          }))
        } catch (error) {
          console.error(`[McpClientManager] Failed to refresh tools for ${conn.serverName}:`, error)
        }
      }),
    )
  }

  async callTool(request: McpToolCallRequest): Promise<McpToolCallResult> {
    const conn = this.connections.get(request.serverName)
    if (!conn || conn.status !== 'available' || !conn.client) {
      return {
        serverName: request.serverName,
        toolName: request.toolName,
        success: false,
        content: [{ type: 'text', text: `Server ${request.serverName} is not available` }],
        isError: true,
      }
    }

    try {
      const result = await conn.client.callTool({
        name: request.toolName,
        arguments: request.arguments,
      })

      const content = Array.isArray(result.content)
        ? result.content.map((c: any) => ({
          type: c.type as 'text' | 'image' | 'audio' | 'resource',
          text: c.text,
          data: c.data,
          mimeType: c.mimeType,
        }))
        : [{ type: 'text' as const, text: JSON.stringify(result.content) }]

      return {
        serverName: request.serverName,
        toolName: request.toolName,
        success: true,
        content,
        isError: result.isError,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`[McpClientManager] Tool call failed on ${request.serverName}/${request.toolName}:`, errorMessage)

      this.handleTransportClose(conn, conn.client)

      return {
        serverName: request.serverName,
        toolName: request.toolName,
        success: false,
        content: [{ type: 'text', text: `Tool execution error: ${errorMessage}` }],
        isError: true,
      }
    }
  }

  getCircuitState(config: McpServerConfig): McpServerConfig['circuitState'] {
    const conn = this.connections.get(config.name)
    if (!conn) return config.circuitState
    return {
      open: conn.circuitState.open,
      openedAt: conn.circuitState.openedAt ?? undefined,
      failureCount: conn.circuitState.failureCount,
      lastFailureAt: conn.circuitState.lastFailureAt ?? undefined,
    }
  }

  getServerStatus(name: string): McpServerConnection['status'] {
    return this.connections.get(name)?.status ?? 'unavailable'
  }
}

export const mcpClientManager = new McpClientManager()
