/**
 * Node K2 — Plugin Registry Tests
 *
 * Verifies all 9 provider plugins exist and are registered.
 * Uses source-code analysis (no dynamic imports) since many
 * adapter files depend on Electron and lack ESM `.ts` extensions.
 *
 * Run: node --test tests/providers/plugin-registry.test.ts
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'

const PLUGIN_CLASSES: Record<string, string> = {
  qwen: 'QwenProviderPlugin',
  glm: 'GLMProviderPlugin',
  deepseek: 'DeepSeekProviderPlugin',
  kimi: 'KimiProviderPlugin',
  minimax: 'MiniMaxProviderPlugin',
  mimo: 'MimoProviderPlugin',
  perplexity: 'PerplexityProviderPlugin',
  'qwen-ai': 'QwenAiProviderPlugin',
  zai: 'ZaiProviderPlugin',
}

// ── File existence ───────────────────────────────────────────────────

test('all 9 plugin files exist on disk', () => {
  for (const [id, className] of Object.entries(PLUGIN_CLASSES)) {
    const filePath = `src/main/proxy/plugins/${className}.ts`
    assert.ok(fs.existsSync(filePath), `${className}.ts must exist for provider '${id}'`)
  }
})

// ── Registry source analysis ────────────────────────────────────────

test('registry.ts imports and registers all 9 plugins', () => {
  const src = fs.readFileSync('src/main/proxy/plugins/registry.ts', 'utf-8')

  for (const className of Object.values(PLUGIN_CLASSES)) {
    assert.ok(
      src.includes(className),
      `registry.ts must reference ${className}`
    )
  }
})

test('registry.ts eagerly imports Node-safe plugins and lazily references the rest', () => {
  const src = fs.readFileSync('src/main/proxy/plugins/registry.ts', 'utf-8')

  for (const name of ['QwenProviderPlugin', 'GLMProviderPlugin']) {
    assert.ok(
      src.includes(`from './${name}.ts'`),
      `registry.ts must eagerly import ${name}`
    )
  }

  for (const name of ['DeepSeekProviderPlugin', 'KimiProviderPlugin', 'MiniMaxProviderPlugin',
    'MimoProviderPlugin', 'PerplexityProviderPlugin', 'QwenAiProviderPlugin', 'ZaiProviderPlugin']) {
    assert.ok(
      src.includes(`./${name}.ts`),
      `registry.ts must lazily reference ${name}`
    )
  }
})

test('registry.ts registerAll function registers qwen and glm eagerly', () => {
  const src = fs.readFileSync('src/main/proxy/plugins/registry.ts', 'utf-8')
  const registerAllBody = src.match(/function registerAll\(\): void \{([\s\S]*?)\n\}/)?.[1] ?? ''
  const registrations = (registerAllBody.match(/registerPlugin\(\w+\)/g) || [])
  assert.equal(registrations.length, 2, 'expected 2 eager registerPlugin calls in registerAll')
})

test('getPluginForProvider is exported as async function', () => {
  const src = fs.readFileSync('src/main/proxy/plugins/registry.ts', 'utf-8')
  assert.ok(
    src.includes('export async function getPluginForProvider'),
    'must export async getPluginForProvider'
  )
})

test('getAllPlugins returns all registered plugins', () => {
  const src = fs.readFileSync('src/main/proxy/plugins/registry.ts', 'utf-8')
  assert.ok(src.includes('export function getAllPlugins'), 'must export getAllPlugins')
})

test('registry imports in Node and exposes Qwen plus GLM plugins', async () => {
  const registry = await import('../../src/main/proxy/plugins/registry.ts')
  const allPlugins = registry.getAllPlugins()
  const ids = allPlugins.map((plugin: { id: string }) => plugin.id).sort()

  assert.ok(ids.includes('qwen'), 'registry must expose qwen plugin')
  assert.ok(ids.includes('glm'), 'registry must expose glm plugin')
  assert.equal(registry.getPluginForProviderSync({ id: 'qwen' })?.id, 'qwen')
  assert.equal(registry.getPluginForProviderSync({ id: 'glm' })?.id, 'glm')
})

test('registry resolves the hyphenated qwen-ai provider id', async () => {
  const registry = await import('../../src/main/proxy/plugins/registry.ts')
  assert.equal((await registry.getPluginForProvider({ id: 'qwen-ai' }))?.id, 'qwen-ai')
})

test('GLM plugin exposes stream parsing for the web SSE endpoint', () => {
  const src = fs.readFileSync('src/main/proxy/plugins/GLMProviderPlugin.ts', 'utf-8')

  assert.match(src, /parseStream\(input: ProviderRuntimeStreamInput\)/)
  assert.match(src, /return glmStreamToProviderEvents\(input\)/)
  assert.match(src, /responseType: 'stream'/)
  assert.match(src, /backend-api\/assistant\/stream/)
})

test('GLM plugin reuses adapter token refresh before provider requests', () => {
  const pluginSource = fs.readFileSync('src/main/proxy/plugins/GLMProviderPlugin.ts', 'utf-8')
  const adapterSource = fs.readFileSync('src/main/proxy/adapters/glm.ts', 'utf-8')

  assert.match(pluginSource, /await adapter\.acquireToken\(\)/)
  assert.doesNotMatch(pluginSource, /credentials\.refresh_token\s*\|\|\s*''/)
  assert.match(adapterSource, /async acquireToken\(\): Promise<string>/)
})

test('GLM plugin builds provider prompts from RequestAssembly tool manifests', () => {
  const pluginSource = fs.readFileSync('src/main/proxy/plugins/GLMProviderPlugin.ts', 'utf-8')
  const adapterSource = fs.readFileSync('src/main/proxy/adapters/glm.ts', 'utf-8')

  assert.match(pluginSource, /buildGLMAssemblyPromptMessagesForTest/)
  assert.match(pluginSource, /input\.assembly/)
  assert.doesNotMatch(pluginSource, /buildGLMPromptMessagesForTest/)
  assert.match(adapterSource, /export function buildGLMAssemblyPromptMessagesForTest/)
  assert.match(adapterSource, /assembly\.toolManifest\.renderedPrompt/)
})

// ── Plugin file content checks ──────────────────────────────────────

test('each plugin file implements WebProviderPlugin', () => {
  for (const className of Object.values(PLUGIN_CLASSES)) {
    const src = fs.readFileSync(`src/main/proxy/plugins/${className}.ts`, 'utf-8')
    assert.ok(
      src.includes('WebProviderPlugin'),
      `${className} must reference WebProviderPlugin interface`
    )
    assert.ok(
      src.includes('id:'),
      `${className} must have id field`
    )
    assert.ok(
      src.includes('version:'),
      `${className} must have version field`
    )
    assert.ok(
      src.includes('matches('),
      `${className} must have matches method`
    )
    assert.ok(
      src.includes('capabilities:'),
      `${className} must have capabilities`
    )
    assert.ok(
      src.includes('buildRequest'),
      `${className} must have buildRequest`
    )
    assert.ok(
      src.includes('parseNonStream'),
      `${className} must have parseNonStream`
    )
  }
})

test('each plugin file has session id extraction in parseNonStream', () => {
  for (const className of Object.values(PLUGIN_CLASSES)) {
    const src = fs.readFileSync(`src/main/proxy/plugins/${className}.ts`, 'utf-8')
    assert.ok(
      src.includes('sessionId') || src.includes('session_id'),
      `${className} parseNonStream should reference session id`
    )
  }
})

// ── Plugin-registry directory integrity ─────────────────────────────

test('all files in plugins/ directory are accounted for', () => {
  const dir = 'src/main/proxy/plugins'
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'))
  const expected = ['WebProviderPlugin.ts', 'types.ts', 'registry.ts', ...Object.values(PLUGIN_CLASSES).map(c => `${c}.ts`)]
  for (const file of files) {
    assert.ok(
      expected.includes(file),
      `Unexpected file in plugins/: ${file}`
    )
  }
  assert.equal(files.length, expected.length, `Expected ${expected.length} files in plugins/, found ${files.length}`)
})
