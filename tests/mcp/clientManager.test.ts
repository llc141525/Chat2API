import test from 'node:test'
import assert from 'node:assert/strict'
import { McpClientManager } from '../../src/main/proxy/mcp/clientManager.ts'
import type { McpServerConfig } from '../../src/main/store/types.ts'

function makeConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: 'test-server',
    command: 'node',
    args: [],
    enabled: true,
    ...overrides,
  }
}

function createMockClientManager(): McpClientManager {
  const manager = new McpClientManager()
  const statusCallbacks: Array<(name: string, status: string) => void> = []
  const origOnStatus = manager.onStatusChange.bind(manager)
  manager.onStatusChange = (cb: any) => {
    statusCallbacks.push(cb)
    origOnStatus(cb)
  }

  manager.connectOverride = async (conn) => {
    conn.status = 'available'
    conn.client = {} as any
    conn.connectedAt = Date.now()
    conn.tools = []
    for (const cb of statusCallbacks) {
      try { cb(conn.serverName, conn.status as any) } catch { }
    }
  }
  return manager
}

test('startServer with disabled config is unavailable', async () => {
  const manager = new McpClientManager()
  await manager.startServer('disabled', makeConfig({ enabled: false }))
  assert.equal(manager.getServerStatus('disabled'), 'unavailable')
})

test('getAllTools returns empty array when no servers connected', () => {
  const manager = new McpClientManager()
  assert.deepEqual(manager.getAllTools(), [])
})

test('getServer returns undefined for unknown server', () => {
  const manager = new McpClientManager()
  assert.equal(manager.getServer('nonexistent'), undefined)
})

test('stopServer cleans up a server connection', async () => {
  const manager = createMockClientManager()
  await manager.startServer('test', makeConfig())
  assert.equal(manager.getServerStatus('test'), 'available')

  await manager.stopServer('test')
  assert.equal(manager.getServerStatus('test'), 'unavailable')
})

test('stopAll cleans up all server connections', async () => {
  const manager = createMockClientManager()
  await manager.startServer('s1', makeConfig({ name: 's1' }))
  await manager.startServer('s2', makeConfig({ name: 's2', enabled: false }))

  await manager.stopAll()
  assert.equal(manager.getServerStatus('s1'), 'unavailable')
  assert.equal(manager.getServerStatus('s2'), 'unavailable')
})

test('getCircuitState returns default state for unknown server', () => {
  const manager = new McpClientManager()
  const config = makeConfig({ circuitState: { open: false, failureCount: 0 } })
  const state = manager.getCircuitState(config)
  assert.equal(state?.open, false)
  assert.equal(state?.failureCount, 0)
})

test('duplicate startServer does not create a second connection', async () => {
  const manager = createMockClientManager()
  await manager.startServer('test', makeConfig())
  const countBefore = (manager as any).connections.size

  await manager.startServer('test', makeConfig())
  assert.equal((manager as any).connections.size, countBefore)
})

test('circuit breaker prevents reconnection after max failures', () => {
  const manager = new McpClientManager()
  const conn = {
    serverName: 'test',
    config: makeConfig(),
    status: 'circuitOpen' as const,
    client: null,
    transport: null,
    tools: [],
    circuitState: { open: true, openedAt: Date.now(), failureCount: 3, lastFailureAt: Date.now(), lastRecoveryAt: null },
    connectedAt: null,
  }

  const isOpen = (manager as any).isCircuitOpen(conn)
  assert.equal(isOpen, true)
})

test('circuit breaker resets after open duration expires', () => {
  const manager = new McpClientManager()
  const conn = {
    serverName: 'test',
    config: makeConfig(),
    status: 'circuitOpen' as const,
    client: null,
    transport: null,
    tools: [],
    circuitState: { open: true, openedAt: Date.now() - 300_001, failureCount: 3, lastFailureAt: Date.now(), lastRecoveryAt: null },
    connectedAt: null,
  }

  const isOpen = (manager as any).isCircuitOpen(conn)
  assert.equal(isOpen, false)
})

test('startServer marks circuitOpen when pre-configured circuit state', async () => {
  const manager = createMockClientManager()
  const config = makeConfig({
    circuitState: { open: true, openedAt: Date.now(), failureCount: 3, lastFailureAt: Date.now() },
  })
  await manager.startServer('circuit', config)
  assert.equal(manager.getServerStatus('circuit'), 'circuitOpen')
})

test('callTool returns error for unavailable server', async () => {
  const manager = new McpClientManager()
  const result = await manager.callTool({ serverName: 'nonexistent', toolName: 'test', arguments: {} })
  assert.equal(result.success, false)
  assert.ok(result.content[0].text?.includes('not available'))
})

test('getServerStatus returns unavailable for unknown server', () => {
  const manager = new McpClientManager()
  assert.equal(manager.getServerStatus('unknown'), 'unavailable')
})
