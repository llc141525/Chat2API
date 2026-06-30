import type { ToolProtocolId } from '../../../toolCalling/types.ts'
import type { StructureProtocolAdapter } from './ProtocolAdapter.ts'
import { managedXmlStructureAdapter } from './managedXmlStructure.ts'

const adapters: Partial<Record<ToolProtocolId, StructureProtocolAdapter>> = {
  managed_xml: managedXmlStructureAdapter,
}

export function getStructureProtocolAdapter(protocol: ToolProtocolId): StructureProtocolAdapter {
  const adapter = adapters[protocol]
  if (!adapter) {
    throw new Error(`Unsupported structure protocol: ${protocol}`)
  }

  return adapter
}
