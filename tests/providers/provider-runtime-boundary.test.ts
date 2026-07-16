import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

test('ProviderRuntime imports without loading forwarder or provider adapter graph', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'chat2api-runtime-boundary-'))
  const loaderPath = join(tempDir, 'block-forwarder-loader.mjs')
  const runtimeUrl = pathToFileURL(resolve('src/main/proxy/services/ProviderRuntime.ts')).href

  writeFileSync(loaderPath, `
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context)
  const normalized = result.url.replace(/\\\\/g, '/')
  if (normalized.endsWith('/src/main/proxy/forwarder.ts') || normalized.includes('/src/main/proxy/adapters/')) {
    throw new Error('ProviderRuntime boundary violation: ' + normalized)
  }
  return result
}
`)

  try {
    const result = spawnSync(
      process.execPath,
      [
        '--loader',
        pathToFileURL(loaderPath).href,
        '--input-type=module',
        '--eval',
        `const mod = await import(${JSON.stringify(runtimeUrl)});
         const runtime = new mod.ProviderRuntime();
         if (typeof runtime.readSessionState !== 'function' || typeof runtime.writeSessionState !== 'function') {
           throw new Error('ProviderRuntime API missing');
         }`,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    )

    assert.equal(
      result.status,
      0,
      `ProviderRuntime import should not resolve forwarder/adapters\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
