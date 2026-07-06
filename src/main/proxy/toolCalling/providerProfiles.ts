import type { NormalizedToolResult, ToolProtocolId } from './types.ts'
import { managedXmlProtocol } from './protocols/managedXml.ts'

export interface ProviderToolProfile {
  providerId: 'deepseek' | 'kimi' | 'glm' | 'qwen' | 'qwen-ai' | string
  managedSupport: boolean
  supportsNativeTools: boolean
  preferredManagedProtocol: ToolProtocolId
  contractHeaderVersion: number
  availabilityDriftRetry: 'enabled' | 'disabled'
  managedPromptOwner: 'ToolCallingEngine'
  parseStreaming: boolean
  parseNonStreaming: boolean
  supportsIntentionalEmptyOutput: boolean
  preservesToolHistory: boolean
  formatAssistantToolCalls(calls: Array<{ id: string; name: string; arguments: string }>): string
  formatToolResult(result: NormalizedToolResult): string
}

const chat2ApiXmlHistoryProfile: Omit<ProviderToolProfile, 'providerId'> = {
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

const profiles: Record<string, ProviderToolProfile> = {
  deepseek: {
    providerId: 'deepseek',
    ...chat2ApiXmlHistoryProfile,
  },
  kimi: {
    providerId: 'kimi',
    ...chat2ApiXmlHistoryProfile,
  },
  glm: {
    providerId: 'glm',
    ...chat2ApiXmlHistoryProfile,
  },
  qwen: {
    providerId: 'qwen',
    ...chat2ApiXmlHistoryProfile,
  },
  'qwen-ai': {
    providerId: 'qwen-ai',
    ...chat2ApiXmlHistoryProfile,
  },
}

export function getProviderToolProfile(providerId: string): ProviderToolProfile {
  return profiles[providerId] ?? {
    providerId,
    ...chat2ApiXmlHistoryProfile,
  }
}
