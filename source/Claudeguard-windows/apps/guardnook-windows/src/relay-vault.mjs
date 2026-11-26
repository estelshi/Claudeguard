import { join } from 'node:path'
import { readdir, rm } from 'node:fs/promises'
import { atomicJSON, readJSON } from './storage.mjs'

const NAME = /^relay-secret-([a-f0-9]{32})\.json$/

export function createRelayVault(directory, safeStorage) {
  const file = id => {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid relay credential reference')
    return join(directory, `relay-secret-${id}.json`)
  }
  const available = () => safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
  return {
    async load(id) {
      if (!available()) return null
      const value = await readJSON(file(id), null)
      if (!value?.encrypted) return null
      const { username, password } = JSON.parse(safeStorage.decryptString(Buffer.from(value.encrypted, 'base64')))
      return typeof username === 'string' && typeof password === 'string' ? { username, password } : null
    },
    async save(id, { username, password }) {
      if (!available()) throw new Error('OS credential encryption is unavailable')
      const encrypted = safeStorage.encryptString(JSON.stringify({ username, password })).toString('base64')
      await atomicJSON(file(id), { version: 1, encrypted })
    },
    async remove(id) {
      await rm(file(id), { force: true })
    },
    // Delete every stored relay secret except the one the current config references.
    async prune(keepId = null) {
      let names = []
      try { names = await readdir(directory) } catch { return [] }
      const removed = []
      for (const name of names) {
        const id = NAME.exec(name)?.[1]
        if (!id || id === keepId) continue
        await rm(join(directory, name), { force: true }).then(() => removed.push(id)).catch(() => {})
      }
      return removed
    },
  }
}
