import type {
  ManagedToolSupportStatus,
  NormalizedToolResult,
  ProviderManagedTransport,
  ToolProtocolId,
} from './types.ts'
import { managedXmlProtocol } from './protocols/managedXml.ts'

export interface ProviderToolProfile {
  providerId: 'deepseek' | 'kimi' | 'glm' | 'qwen' | 'qwen-ai' | string
  managedSupport: boolean
  managedToolSupportStatus: ManagedToolSupportStatus
  supportsNativeTools: boolean
  preferredManagedProtocol: ToolProtocolId
  contractHeaderVersion: number
  availabilityDriftRetry: 'enabled' | 'disabled'
  managedPromptOwner: 'ToolCallingEngine'
  parseStreaming: boolean
  parseNonStreaming: boolean
  supportsIntentionalEmptyOutput: boolean
  preservesToolHistory: boolean
  managedTransport: ProviderManagedTransport
  providerRiskControlCaveats: string[]
  formatAssistantToolCalls(calls: Array<{ id: string; name: string; arguments: string }>): string
  formatToolResult(result: NormalizedToolResult): string
}

const chat2ApiXmlHistoryProfile: Omit<ProviderToolProfile, 'providerId' | 'managedToolSupportStatus' | 'managedTransport' | 'providerRiskControlCaveats'> = {
  managedSupport: true,
  supportsNativeTools: false,
  preferredManagedProtocol: 'managed_xml',
  contractHeaderVersion: 1,
  availabilityDriftRetry: 'enabled',
  managedPromptOwner: 'ToolCallingEngine',
  parseStreaming: true,
  parseNonStreaming: true,
  supportsIntentionalEmptyOutput: false,
  preservesToolHistory: true,
  formatAssistantToolCalls(calls) {
    return managedXmlProtocol.formatAssistantToolCalls(calls)
  },
  formatToolResult(result) {
    return managedXmlProtocol.formatToolResult(result)
  },
}

function managedProviderProfile(
  providerId: ProviderToolProfile['providerId'],
  status: ManagedToolSupportStatus,
  transport: ProviderManagedTransport,
  caveats: string[] = [],
): ProviderToolProfile {
  return {
    providerId,
    ...chat2ApiXmlHistoryProfile,
    managedToolSupportStatus: status,
    managedTransport: transport,
    providerRiskControlCaveats: [...caveats],
  }
}

const profiles: Record<string, ProviderToolProfile> = {
  deepseek: managedProviderProfile('deepseek', 'accepted', 'openai_chat_completions'),
  kimi: managedProviderProfile('kimi', 'experimental', 'grpc_web_stream'),
  glm: managedProviderProfile('glm', 'accepted', 'openai_chat_completions'),
  minimax: managedProviderProfile('minimax', 'experimental', 'polling_stream'),
  qwen: managedProviderProfile('qwen', 'accepted', 'openai_chat_completions'),
  'qwen-ai': managedProviderProfile('qwen-ai', 'accepted', 'openai_chat_completions'),
  zai: managedProviderProfile('zai', 'experimental', 'provider_chat_api', ['captcha_or_risk_control']),
}

export function getProviderToolProfile(providerId: string): ProviderToolProfile {
  return profiles[providerId] ?? {
    providerId,
    ...chat2ApiXmlHistoryProfile,
    managedToolSupportStatus: 'experimental',
    managedTransport: 'unknown',
    providerRiskControlCaveats: [],
  }
}
