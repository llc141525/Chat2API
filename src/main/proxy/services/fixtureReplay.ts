/**
 * Fixture Replay Harness — Node K1 (Plugin Phase 4)
 *
 * Allows provider parser behavior to be tested without live web calls.
 * Takes a plugin + fixture, creates a mock response, and replays it
 * through the plugin's parseNonStream or parseStream methods.
 *
 * Usage:
 *   import { replayStreamFixture, replayNonStreamFixture } from './fixtureReplay.ts'
 *   const events = await replayStreamFixture(qwenPlugin, myFixture)
 *   const result = await replayNonStreamFixture(qwenPlugin, myFixture)
 */

import { Readable } from 'node:stream'
import type { WebProviderPlugin } from '../plugins/WebProviderPlugin.ts'
import type {
  ProviderRuntimeResult,
  ProviderRuntimeEvent,
  ProviderWebResponse,
} from '../plugins/types.ts'

/**
 * A test fixture capturing raw provider response data along with
 * expected outcomes.
 *
 * Fixtures MUST NOT contain real credentials, tokens, or PII.
 */
export interface PluginFixture {
  /** Which plugin this fixture targets */
  pluginId: string
  /** Human-readable description */
  description: string
  /**
   * The raw response data.
   * - For stream fixtures: a string containing raw SSE event blocks
   * - For non-stream fixtures: a parsed JSON object
   */
  responseData: unknown
  /** Response headers (needed for content-encoding, etc.) */
  headers?: Record<string, string>
  /** Expected normalized output shape */
  expected: {
    /** Expected sessionId extracted from the response */
    sessionId?: string
    /** For streams: expected sequence of ProviderRuntimeEvent types */
    eventTypes?: string[]
    /** Text substrings expected in text_delta events */
    containsText?: string[]
    /** Expected HTTP status (non-stream only) */
    status?: number
  }
}

/**
 * Replay a non-stream fixture through a provider plugin.
 *
 * Creates a mock ProviderWebResponse from the fixture data and
 * calls plugin.parseNonStream(). No HTTP calls are made.
 */
export async function replayNonStreamFixture(
  plugin: WebProviderPlugin,
  fixture: PluginFixture,
): Promise<ProviderRuntimeResult> {
  const mockResponse: ProviderWebResponse = {
    status: fixture.expected.status ?? 200,
    headers: fixture.headers ?? {},
    data: fixture.responseData,
  }

  return plugin.parseNonStream(mockResponse)
}

/**
 * Replay a streaming fixture through a provider plugin.
 *
 * Creates a mock readable stream from the fixture's raw SSE text
 * and calls plugin.parseStream(). Returns all collected events.
 * No HTTP calls are made.
 */
export async function replayStreamFixture(
  plugin: WebProviderPlugin,
  fixture: PluginFixture,
): Promise<ProviderRuntimeEvent[]> {
  const rawData = fixture.responseData as string
  const stream = Readable.from([Buffer.from(rawData, 'utf-8')])

  const mockResponse = {
    data: stream,
    headers: fixture.headers ?? {},
  }

  const iterable = plugin.parseStream!(mockResponse)
  const events: ProviderRuntimeEvent[] = []
  for await (const event of iterable) {
    events.push(event)
  }
  return events
}
