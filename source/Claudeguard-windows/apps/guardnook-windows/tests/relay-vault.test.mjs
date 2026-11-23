import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRelayVault } from '../src/relay-vault.mjs'

test('relay vault writes only the encrypted envelope and rejects a plaintext backend', async t => {
  const root = await mkdtemp(join(tmpdir(), 'guardnook-share-vault-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const id = '0123456789abcdef0123456789abcdef'
  const credentials = { username: 'private-username', password: 'private-quote-":"password' }
  const marker = Buffer.from('encrypted from OS')
  const vault = createRelayVault(root, {
    isEncryptionAvailable: () => true,
    encryptString(value) { assert.deepEqual(JSON.parse(value), credentials); return marker },
    decryptString(value) { assert.deepEqual(value, marker); return JSON.stringify(credentials) },
  })
  await vault.save(id, credentials)
  const disk = await readFile(join(root, `relay-secret-${id}.json`), 'utf8')
  assert.ok(!disk.includes(credentials.username) && !disk.includes(credentials.password))
  assert.deepEqual(await vault.load(id), credentials)
  const insecure = createRelayVault(root, {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text',
  })
  await assert.rejects(insecure.save(id, credentials), /unavailable/)
  assert.equal(await insecure.load(id), null)
})
