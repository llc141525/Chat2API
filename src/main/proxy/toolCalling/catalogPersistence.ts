import fs from 'fs'
import path from 'path'

import type { ToolCatalogSnapshot } from './types.ts'

export interface CatalogPersistenceStore {
  save(sessionId: string, snapshot: ToolCatalogSnapshot): void
  load(sessionId: string): ToolCatalogSnapshot | undefined
  delete(sessionId: string): void
  loadAll(): Map<string, ToolCatalogSnapshot>
}

interface PersistedFile {
  version: 1
  catalogs: Record<string, ToolCatalogSnapshot>
}

export function createFileCatalogPersistence(filePath: string): CatalogPersistenceStore {
  const dir = path.dirname(filePath)

  function readFile(): PersistedFile {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      return JSON.parse(raw)
    } catch {
      return { version: 1, catalogs: {} }
    }
  }

  function writeFile(data: PersistedFile): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const tmp = filePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmp, filePath)
  }

  return {
    save(sessionId: string, snapshot: ToolCatalogSnapshot) {
      const data = readFile()
      data.catalogs[sessionId] = snapshot
      writeFile(data)
    },

    load(sessionId: string): ToolCatalogSnapshot | undefined {
      const data = readFile()
      return data.catalogs[sessionId]
    },

    delete(sessionId: string) {
      const data = readFile()
      delete data.catalogs[sessionId]
      writeFile(data)
    },

    loadAll(): Map<string, ToolCatalogSnapshot> {
      const data = readFile()
      const map = new Map<string, ToolCatalogSnapshot>()
      for (const [sessionId, snapshot] of Object.entries(data.catalogs)) {
        map.set(sessionId, snapshot)
      }
      return map
    },
  }
}
