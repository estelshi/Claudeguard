import { mkdir, readFile, rename as fsRename, rm, writeFile, lstat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

// Windows Defender, the search indexer and backup tools briefly lock a file they are reading.
// A rename onto that file fails with EPERM / EBUSY / EACCES; a short retry usually succeeds.
export const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES'])
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function atomicJSON(path, value, { rename = fsRename, attempts = 6, backoffMs = 40 } = {}) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' })
  try {
    for (let attempt = 1; ; attempt++) {
      try { await rename(temporary, path); return }
      catch (error) {
        if (!RETRYABLE_RENAME.has(error.code) || attempt >= attempts) throw error
        await pause(backoffMs * attempt)
      }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error('本机数据无法读取，原文件已保留。')
  }
}

// 外观（浅色 / 深色）单独存在 appearance.json，与守护配置分开；默认浅色。
// preferences.json（0.1 版的主题设置）仍留在磁盘上、不再读取，避免旧值突然把界面切成深色。
export const THEMES = ['light', 'dark']
export const THEME_CHROME = {
  light: { background: '#f4f4f7', symbol: '#16181d' },
  dark: { background: '#0b0c0f', symbol: '#e8e9ec' },
}
export async function readTheme(directory) {
  try {
    const value = await readJSON(join(directory, 'appearance.json'), null)
    return THEMES.includes(value?.theme) ? value.theme : 'light'
  } catch { return 'light' }
}
export async function writeTheme(directory, theme) {
  if (!THEMES.includes(theme)) throw new Error('外观设置无效')
  await atomicJSON(join(directory, 'appearance.json'), { theme })
  return theme
}

export async function ensureDataDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('数据目录必须为真实文件夹')
  return directory
}
