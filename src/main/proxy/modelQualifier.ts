export interface QualifiedModelRef {
  providerId?: string
  model: string
}

export function splitProviderQualifiedModel(
  requestedModel: string,
  providerIds: Iterable<string>,
): QualifiedModelRef {
  const separatorIndex = requestedModel.indexOf('/')
  if (separatorIndex <= 0 || separatorIndex >= requestedModel.length - 1) {
    return { model: requestedModel }
  }

  const requestedProviderId = requestedModel.slice(0, separatorIndex).trim().toLowerCase()
  const unqualifiedModel = requestedModel.slice(separatorIndex + 1).trim()
  if (!requestedProviderId || !unqualifiedModel) {
    return { model: requestedModel }
  }

  for (const providerId of providerIds) {
    if (providerId.toLowerCase() === requestedProviderId) {
      return {
        providerId,
        model: unqualifiedModel,
      }
    }
  }

  return { model: requestedModel }
}
