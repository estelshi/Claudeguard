import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
await rm(join(root, 'staged'), { recursive: true, force: true })
await mkdir(join(root, 'staged/Licenses'), { recursive: true })
await cp(join(root, '../../packages/guard-core'), join(root, 'staged/GuardCore'), { recursive: true, filter: path => !/\.test\.mjs$|README\.md$|[\\/](?:fixtures|TestSupport)$/.test(path) })
await cp(join(root, '../../LICENSE'), join(root, 'staged/Licenses/GuardNook-MIT.txt'))
console.log('Staged current GuardNook service; tests, fixtures and personal settings excluded.')
