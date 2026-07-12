export type SchemaPayloadResult =
  | { ok: true; value: unknown }
  | { ok: false; detail: string }

export function parseParameterPayloadForSchema(
  rawPayload: string,
  schema: unknown,
  parameterName: string,
): SchemaPayloadResult {
  if (!isRecord(schema)) {
    return { ok: true, value: rawPayload }
  }

  if (schema.type === 'object') {
    return parseJsonPayload(rawPayload, parameterName, 'object', isJsonObject)
  }

  if (schema.type === 'array') {
    return parseJsonPayload(rawPayload, parameterName, 'array', Array.isArray)
  }

  return { ok: true, value: rawPayload }
}

export function schemaRequiresComplexPayload(schema: unknown): boolean {
  return isRecord(schema) && (schema.type === 'object' || schema.type === 'array')
}

function parseJsonPayload(
  rawPayload: string,
  parameterName: string,
  expectedType: 'object' | 'array',
  matchesExpectedType: (value: unknown) => boolean,
): SchemaPayloadResult {
  try {
    const parsed = JSON.parse(rawPayload)
    if (matchesExpectedType(parsed)) {
      return { ok: true, value: parsed }
    }
  } catch {
    // handled below
  }

  return {
    ok: false,
    detail: `Parameter ${parameterName} must contain valid JSON ${expectedType} payload`,
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
