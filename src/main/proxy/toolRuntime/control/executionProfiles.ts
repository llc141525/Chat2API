import type { ToolExecutionProfile, ToolExecutionProfileSettings } from './types.ts'

export const TOOL_EXECUTION_PROFILE_IDS = [
  'disabled_passthrough',
  'native_passthrough',
  'managed_buffered_structural',
] as const satisfies readonly ToolExecutionProfile[]

export const TOOL_EXECUTION_PROFILES = Object.freeze({
  disabled_passthrough: Object.freeze({
    mode: 'disabled',
    streamGateMode: 'pass_through',
    parseMode: 'none',
    repairMode: 'disabled',
    historyFormat: 'openai_native',
  }),
  native_passthrough: Object.freeze({
    mode: 'native',
    streamGateMode: 'pass_through',
    parseMode: 'none',
    repairMode: 'disabled',
    historyFormat: 'openai_native',
  }),
  managed_buffered_structural: Object.freeze({
    mode: 'managed',
    streamGateMode: 'full_buffer',
    parseMode: 'selected_protocol_only',
    repairMode: 'deterministic_structural_repair',
    historyFormat: 'managed_protocol',
  }),
} satisfies Record<ToolExecutionProfile, ToolExecutionProfileSettings>)

const profileIds = new Set<string>(TOOL_EXECUTION_PROFILE_IDS)

export function isToolExecutionProfile(value: string): value is ToolExecutionProfile {
  return profileIds.has(value)
}

export function getExecutionProfileSettings(
  profile: ToolExecutionProfile,
): ToolExecutionProfileSettings {
  return { ...TOOL_EXECUTION_PROFILES[profile] }
}
