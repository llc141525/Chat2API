/**
 * renderer.ts — Phase 3c
 *
 * Pure rendering logic for Perplexity provider.
 * Takes a CleanedRequest (already filtered, truncated, and delta-selected)
 * and produces the Perplexity-specific HTTP request body + headers.
 *
 * Perplexity uses Electron's net API for HTTP calls.
 */

import type { CleanedRequest } from '../../core/requestCleaner.ts'

// ── Types ───────────────────────────────────────────────────────────

export interface RenderPerplexityRequestInput {
  model: string
  originalModel?: string
  sessionId: string
  reqId: string
}

export interface PerplexityWebRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: Record<string, unknown>
  sessionId: string
  reqId: string
}

// ── Constants ───────────────────────────────────────────────────────

const PERPLEXITY_BASE = 'https://www.perplexity.ai'
const QUERY_ENDPOINT = `${PERPLEXITY_BASE}/rest/sse/perplexity_ask`

// ── Public API ──────────────────────────────────────────────────────

/**
 * Build the Perplexity web request (URL, headers, body) for a streaming call.
 *
 * @param cleaned     — CleanedRequest from requestCleaner.ts
 * @param input       — RenderPerplexityRequestInput with session/request metadata
 * @param cookieToken — Session token / cookie value (acquired by the caller)
 * @returns PerplexityWebRequest ready for the transport layer
 */
export function renderPerplexityRequest(
  cleaned: CleanedRequest,
  input: RenderPerplexityRequestInput,
  cookieToken: string,
): PerplexityWebRequest {
  const { model, sessionId, reqId } = input

  // Extract query from cleaned request
  const query = extractQuery(cleaned)

  // Map model name
  const mappedModel = mapPerplexityModel(model)

  // Build request data
  const requestData = buildRequestData(query, mappedModel)

  return {
    url: QUERY_ENDPOINT,
    method: 'POST',
    headers: {
      'Accept': 'text/event-stream',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/json',
      'Cookie': `__Secure-next-auth.session-token=${cookieToken}`,
      'Origin': PERPLEXITY_BASE,
      'Sec-Ch-Ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      'x-perplexity-request-reason': 'perplexity-query-state-provider',
      'x-request-id': reqId,
      'Referer': `${PERPLEXITY_BASE}/`,
    },
    body: requestData,
    sessionId,
    reqId,
  }
}

// ── Query extraction ────────────────────────────────────────────────

function extractQuery(cleaned: CleanedRequest): string {
  // Append tool contract text if available (managed by ToolCallingEngine)
  const tcText = cleaned.toolContractText
  // Extract system prompt if present
  let systemPrompt = ''
  for (const msg of cleaned.messages) {
    if (msg.role === 'system') {
      const content = extractTextContent(msg.content as any)
      if (content) {
        systemPrompt = content
      }
      break
    }
  }

  // Build conversation history from non-system messages
  const conversationParts: string[] = []
  for (const msg of cleaned.messages) {
    if (msg.role === 'system') continue

    let content = extractTextContent(msg.content as any)
    if (content) {
      const roleLabel = msg.role === 'user' ? 'User' : 'Assistant'
      conversationParts.push(`[${roleLabel}]: ${content}`)
    }
  }

  const conversationHistory = conversationParts.join('\n\n')

  let result: string
  if (systemPrompt && conversationHistory) {
    result = `${systemPrompt}\n\n---\n\n${conversationHistory}`
  } else {
    result = conversationHistory || systemPrompt
  }

  if (tcText) {
    result = `${result}\n\n${tcText}`
  }

  return result
}

// ── Model mapping ───────────────────────────────────────────────────

function mapPerplexityModel(model: string): string {
  const directMappings: Record<string, string> = {
    'Auto': 'turbo',
    'Turbo': 'turbo',
    'PPLX-Pro': 'pplx_pro',
    'GPT-5': 'gpt5',
    'Gemini-2.5-Pro': 'gemini25pro',
    'Claude-Sonnet-4': 'claude4sonnet',
    'Claude-Opus-4': 'claude4opus',
    'Nemotron': 'nemotron',
  }

  if (directMappings[model]) {
    return directMappings[model]
  }

  const modelLower = model.toLowerCase()

  const legacyMappings: Record<string, string> = {
    'gpt-5': 'gpt5',
    'gemini-2.5-pro': 'gemini25pro',
    'claude-sonnet-4': 'claude4sonnet',
    'claude-opus-4': 'claude4opus',
    'nemotron': 'nemotron',
  }

  if (legacyMappings[modelLower]) {
    return legacyMappings[modelLower]
  }

  if (modelLower.includes('turbo')) return 'turbo'
  if (modelLower.includes('gpt5') || modelLower.includes('gpt-5')) return 'gpt5'
  if (modelLower.includes('pplx')) return 'pplx_pro'
  if (modelLower.includes('gemini')) return 'gemini25pro'
  if (modelLower.includes('claude')) {
    if (modelLower.includes('opus')) return 'claude4opus'
    if (modelLower.includes('sonnet')) return 'claude4sonnet'
    return 'claude4sonnet'
  }
  if (modelLower.includes('nemotron')) return 'nemotron'

  return 'turbo'
}

// ── Request data building ───────────────────────────────────────────

function buildRequestData(
  query: string,
  model: string,
): Record<string, unknown> {
  const frontendUuid = uuid()

  const baseParams: Record<string, unknown> = {
    attachments: [],
    language: 'en-US',
    timezone: 'America/Los_Angeles',
    search_focus: 'internet',
    sources: ['web'],
    search_recency_filter: null,
    frontend_uuid: frontendUuid,
    mode: 'copilot',
    model_preference: model,
    is_related_query: false,
    is_sponsored: false,
    frontend_context_uuid: uuid(),
    prompt_source: 'user',
    query_source: 'home',
    is_incognito: false,
    time_from_first_type: 18361,
    local_search_enabled: false,
    use_schematized_api: true,
    send_back_text_in_streaming_api: false,
    supported_block_use_cases: [
      'answer_modes', 'media_items', 'knowledge_cards',
      'inline_entity_cards', 'place_widgets', 'finance_widgets',
      'prediction_market_widgets', 'sports_widgets',
      'flight_status_widgets', 'news_widgets', 'shopping_widgets',
      'jobs_widgets', 'search_result_widgets', 'inline_images',
      'inline_assets', 'placeholder_cards', 'diff_blocks',
      'inline_knowledge_cards', 'entity_group_v2',
      'refinement_filters', 'canvas_mode', 'maps_preview',
      'answer_tabs', 'price_comparison_widgets', 'preserve_latex',
      'generic_onboarding_widgets', 'in_context_suggestions',
      'inline_claims',
    ],
    client_coordinates: null,
    mentions: [],
    dsl_query: query,
    skip_search_enabled: true,
    is_nav_suggestions_disabled: false,
    source: 'default',
    always_search_override: false,
    override_no_search: false,
    should_ask_for_mcp_tool_confirmation: true,
    browser_agent_allow_once_from_toggle: false,
    force_enable_browser_agent: false,
    supported_features: ['browser_agent_permission_banner_v1.1'],
    version: '2.18',
  }

  return {
    params: baseParams,
    query_str: query,
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function extractTextContent(content: string | any[] | null | undefined): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((item: any) => item.type === 'text')
      .map((item: any) => item.text || '')
      .join('\n')
  }
  return ''
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
