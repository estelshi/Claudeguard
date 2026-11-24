import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { importVergeSubscription } from '../src/verge-import.mjs'

const sourceProfile = 'proxies: []\nrules: [MATCH,DIRECT]\n'
const sourceMerge = 'prepend: []\n'
const globalScript = 'function main(config) { return config }\n'
const generatedScript = 'const __previousClaudeMain = config => config; function main(config) { return __previousClaudeMain(config) }\n'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'claudeguard-verge-import-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const vergeDir = join(directory, 'verge')
  const backupDir = join(directory, 'backup')
  const profiles = join(vergeDir, 'profiles')
  const indexPath = join(vergeDir, 'profiles.yaml')
  await mkdir(profiles, { recursive: true })
  await mkdir(backupDir)
  await writeFile(join(profiles, 'source.yaml'), sourceProfile)
  await writeFile(join(profiles, 'merge.yaml'), sourceMerge)
  await writeFile(join(profiles, 'Script.js'), globalScript)
  const original = {
    current: 'Source',
    items: [
      { uid: 'OriginalMerge', type: 'merge', file: 'merge.yaml' },
      { uid: 'Source', type: 'remote', name: 'Existing subscription', file: 'source.yaml',
        url: 'https://example.invalid/subscription', option: { merge: 'OriginalMerge' } },
    ],
  }
  await writeFile(indexPath, dump(original))
  const settings = { relay: { confirmed: false, host: '192.0.2.42' }, expectedIP: '203.0.113.1' }
  return { profiles, indexPath, original, readIndex: async () => load(await readFile(indexPath, 'utf8')),
    input: { vergeDir, backupDir, settings, script: generatedScript, isRunning: async () => false } }
}

test('imports a separate local profile with its own script and keeps the current profile selected', async t => {
  const { input, profiles, original, readIndex } = await fixture(t)
  const result = await importVergeSubscription(input)
  assert.deepEqual(result, { name: 'ClaudeGuard（192.0.2.42）', updated: false })
  const registry = await readIndex()
  assert.equal(registry.current, original.current)
  assert.deepEqual(registry.items.slice(0, original.items.length), original.items)
  const profile = registry.items.find(item => item.name === result.name)
  assert.equal(profile.type, 'local')
  const script = registry.items.find(item => item.uid === profile.option.script)
  const merge = registry.items.find(item => item.uid === profile.option.merge)
  assert.notEqual(merge.uid, 'OriginalMerge')
  assert.equal(await readFile(join(profiles, profile.file), 'utf8'), sourceProfile)
  assert.equal(await readFile(join(profiles, script.file), 'utf8'), generatedScript)
  assert.equal(await readFile(join(profiles, merge.file), 'utf8'), sourceMerge)
  assert.equal(await readFile(join(profiles, 'Script.js'), 'utf8'), globalScript)
  assert.equal(await readFile(join(profiles, 'source.yaml'), 'utf8'), sourceProfile)
})

test('reimport updates the managed subscription without adding a duplicate or changing its selection', async t => {
  const { input, indexPath, readIndex } = await fixture(t)
  const first = await importVergeSubscription(input)
  const old = await readIndex()
  const profile = old.items.find(item => item.name === first.name)
  old.current = profile.uid
  await writeFile(indexPath, dump(old))
  assert.deepEqual(await importVergeSubscription(input), { ...first, updated: true })
  const next = await readIndex()
  assert.equal(next.current, profile.uid)
  assert.equal(next.items.filter(item => item.name === first.name).length, 1)
  assert.equal(next.items.some(item => item.uid === profile.option.script), false)
  assert.deepEqual(load(await readFile(join(input.backupDir, 'clash-verge-profiles.previous.yaml'), 'utf8')), old)
})

test('aborts when Verge restarts during import and removes the uncommitted files', async t => {
  const { input, profiles, original, readIndex } = await fixture(t)
  const originalFiles = await readdir(profiles)
  let calls = 0
  await assert.rejects(importVergeSubscription({ ...input, isRunning: async () => ++calls === 2 }), /系统托盘/)
  assert.deepEqual(await readdir(profiles), originalFiles)
  assert.deepEqual(await readIndex(), original)
})

test('leaves an unrelated subscription with the same name alone', async t => {
  const { input, original, indexPath, readIndex } = await fixture(t)
  original.items[1].name = 'ClaudeGuard（192.0.2.42）'
  await writeFile(indexPath, dump(original))
  await assert.rejects(importVergeSubscription(input), /已有同名订阅/)
  assert.deepEqual(await readIndex(), original)
})
