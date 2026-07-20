/**
 * Wait for a provider stream's first semantic event before exposing it to a
 * downstream client. This makes a no-first-byte upstream stall retryable while
 * no client-visible output has been written yet.
 */
export async function primeProviderStreamEvents<T>(
  events: AsyncIterable<T>,
  timeoutMs: number,
  onTimeout?: () => void,
  isReady: (event: T) => boolean = () => true,
): Promise<{ events: AsyncIterable<T> } | { error: Error }> {
  const iterator = events[Symbol.asyncIterator]()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ timedOut: true }>(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
  })

  const buffered: T[] = []
  while (true) {
    const next = await Promise.race([
      iterator.next().then(result => ({ result })),
      timeout,
    ])

    if ('timedOut' in next) {
      if (timer) clearTimeout(timer)
      onTimeout?.()
      void iterator.return?.()
      return { error: new Error(`Provider stream produced no deliverable event within ${timeoutMs}ms`) }
    }

    if (next.result.done) {
      if (timer) clearTimeout(timer)
      return {
        error: new Error('Provider stream closed without a deliverable event'),
      }
    }
    buffered.push(next.result.value)
    if (isReady(next.result.value)) {
      if (timer) clearTimeout(timer)
      break
    }
  }

  async function* replay(): AsyncIterable<T> {
    yield* buffered
    while (true) {
      const next = await iterator.next()
      if (next.done) return
      yield next.value
    }
  }

  return { events: replay() }
}
