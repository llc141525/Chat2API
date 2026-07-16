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
    return parseJsonPayload(rawPayload, parameterName, 'array', Array.isArray, { wrapSingletonObject: true })
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    const trimmed = rawPayload.trim()
    if (trimmed && !isNaN(Number(trimmed))) {
      return { ok: true, value: schema.type === 'integer' ? Math.floor(Number(trimmed)) : Number(trimmed) }
    }
    return { ok: true, value: rawPayload }
  }

  if (schema.type === 'boolean') {
    const lower = rawPayload.trim().toLowerCase()
    if (lower === 'true') return { ok: true, value: true }
    if (lower === 'false') return { ok: true, value: false }
    return { ok: true, value: rawPayload }
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
  options: { wrapSingletonObject?: boolean } = {},
): SchemaPayloadResult {
  try {
    const parsed = JSON.parse(rawPayload)
    if (matchesExpectedType(parsed)) {
      return { ok: true, value: parsed }
    }
    if (expectedType === 'array' && options.wrapSingletonObject && isJsonObject(parsed)) {
      return { ok: true, value: [parsed] }
    }
  } catch {
    if (expectedType === 'array' && options.wrapSingletonObject) {
      const recoveredArray = recoverJsonArrayPrefix(rawPayload)
      if (recoveredArray) {
        return { ok: true, value: recoveredArray }
      }

      const recoveredSequence = recoverJsonObjectSequencePrefix(rawPayload)
      if (recoveredSequence) {
        return { ok: true, value: recoveredSequence }
      }

      const recovered = recoverJsonObjectPrefix(rawPayload)
      if (recovered) {
        return { ok: true, value: [recovered] }
      }
    }
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

function recoverJsonObjectPrefix(rawPayload: string): Record<string, unknown> | null {
  const trimmed = rawPayload.trim()
  if (!trimmed.startsWith('{')) return null

  const objectEnd = findRecoverableObjectEnd(trimmed)
  if (objectEnd === -1) return null

  try {
    const suffix = trimmed[objectEnd] === '}' ? '' : '}'
    const recovered = JSON.parse(`${trimmed.slice(0, objectEnd + 1)}${suffix}`)
    return isJsonObject(recovered) ? recovered : null
  } catch {
    return null
  }
}

function recoverJsonArrayPrefix(rawPayload: string): unknown[] | null {
  const trimmed = rawPayload.trim()
  if (!trimmed.startsWith('[')) return null

  const arrayEnd = findRecoverableArrayPrefixEnd(trimmed)
  if (arrayEnd === -1) return null

  try {
    const recovered = JSON.parse(`${trimmed.slice(0, arrayEnd + 1)}]`)
    return Array.isArray(recovered) && recovered.length > 0 ? recovered : null
  } catch {
    return null
  }
}

function recoverJsonObjectSequencePrefix(rawPayload: string): Record<string, unknown>[] | null {
  const trimmed = rawPayload.trim()
  if (!trimmed.startsWith('{')) return null

  const ranges = findCompleteTopLevelObjectRanges(trimmed)
  if (ranges.length === 0) return null

  const last = ranges[ranges.length - 1]
  const tail = trimmed.slice(last.end + 1).trim()
  if (tail && !tail.startsWith(',')) return null

  const objects: Record<string, unknown>[] = []
  for (const range of ranges) {
    const prefix = trimmed.slice(0, range.start).trim()
    if (prefix && !prefix.endsWith(',')) return null

    try {
      const parsed = JSON.parse(trimmed.slice(range.start, range.end + 1))
      if (!isJsonObject(parsed)) return null
      objects.push(parsed)
    } catch {
      return null
    }
  }

  return objects.length > 0 ? objects : null
}

function findCompleteTopLevelObjectRanges(value: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let objectDepth = 0
  let arrayDepth = 0
  let objectStart = -1
  let inString = false
  let escaped = false

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\' && inString) {
      escaped = true
      continue
    }

    if (char === '"') {
      inString = !inString
      continue
    }

    if (inString) continue

    if (char === '{') {
      if (objectDepth === 0 && arrayDepth === 0) {
        objectStart = index
      }
      objectDepth += 1
      continue
    }

    if (char === '}') {
      objectDepth -= 1
      if (objectDepth === 0 && arrayDepth === 0 && objectStart !== -1) {
        ranges.push({ start: objectStart, end: index })
        objectStart = -1
      }
      continue
    }

    if (char === '[') {
      arrayDepth += 1
      continue
    }

    if (char === ']') {
      arrayDepth -= 1
    }
  }

  return ranges
}

function findRecoverableArrayPrefixEnd(value: string): number {
  let objectDepth = 0
  let arrayDepth = 0
  let inString = false
  let escaped = false
  let lastCompleteElementEnd = -1

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\' && inString) {
      escaped = true
      continue
    }

    if (char === '"') {
      inString = !inString
      continue
    }

    if (inString) continue

    if (char === '{') {
      objectDepth += 1
      continue
    }

    if (char === '}') {
      objectDepth -= 1
      if (objectDepth === 0 && arrayDepth === 1) {
        lastCompleteElementEnd = index
      }
      continue
    }

    if (char === '[') {
      arrayDepth += 1
      continue
    }

    if (char === ']') {
      arrayDepth -= 1
      if (arrayDepth === 0) {
        return -1
      }
    }
  }

  return lastCompleteElementEnd
}

function findRecoverableObjectEnd(value: string): number {
  let objectDepth = 0
  let arrayDepth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\' && inString) {
      escaped = true
      continue
    }

    if (char === '"') {
      inString = !inString
      continue
    }

    if (inString) continue

    if (char === '{') {
      objectDepth += 1
      continue
    }

    if (char === '}') {
      objectDepth -= 1
      if (objectDepth === 0 && arrayDepth === 0) {
        const tail = value.slice(index + 1).trim()
        if (/^[\]\},\s]*$/.test(tail)) {
          return index
        }
      }
      continue
    }

    if (char === '[') {
      arrayDepth += 1
      continue
    }

    if (char === ']') {
      arrayDepth -= 1
      if (objectDepth === 1 && arrayDepth === 0) {
        const tail = value.slice(index + 1).trim()
        if (tail === '' || tail === ',') {
          return index
        }
      }
    }
  }

  return -1
}
