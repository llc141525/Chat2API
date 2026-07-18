type GateTask<T> = () => Promise<T>

type GateOptions = {
  minIntervalMs: number
  rateLimitBackoffMs: number
}

const chains = new Map<string, Promise<void>>()
const nextAllowedAt = new Map<string, number>()

export async function runThroughProviderRequestGate<T>(
  key: string,
  options: GateOptions,
  task: GateTask<T>,
  getStatus: (result: T) => number,
): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.then(() => current)
  chains.set(key, queued)

  await previous
  try {
    const waitMs = Math.max(0, (nextAllowedAt.get(key) ?? 0) - Date.now())
    if (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs))
    }

    const result = await task()
    const status = getStatus(result)
    nextAllowedAt.set(
      key,
      Date.now() + (status === 429 ? options.rateLimitBackoffMs : options.minIntervalMs),
    )
    return result
  } finally {
    release()
    if (chains.get(key) === queued) {
      chains.delete(key)
    }
  }
}

/**
 * A streamed provider response is not fully committed when its HTTP headers
 * arrive. Start the next same-account request only after the stream settles.
 */
export function markProviderRequestStreamFinished(key: string, options: GateOptions): void {
  const next = Date.now() + options.minIntervalMs
  nextAllowedAt.set(key, Math.max(nextAllowedAt.get(key) ?? 0, next))
}

export function resetProviderRequestGatesForTest(): void {
  chains.clear()
  nextAllowedAt.clear()
}
