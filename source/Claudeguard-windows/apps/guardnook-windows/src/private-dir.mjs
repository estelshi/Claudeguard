// Restrict the data directory to the current Windows user and SYSTEM.
// Runs icacls only when the directory is first created or the marker from an earlier
// successful run is missing. Any failure is logged and startup continues: the folder
// still sits under the user's own %APPDATA%, which is private by default.
import { mkdir, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const ACL_MARKER = '.acl-v1'
const defaultExec = promisify(execFile)

export async function privateDirectory(directory, { platform = process.platform, exec = defaultExec, log = console.warn } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (platform !== 'win32') return { applied: false, reason: 'not-windows' }
  const marker = join(directory, ACL_MARKER)
  try { await access(marker); return { applied: false, reason: 'already-applied' } } catch { /* first run or earlier failure */ }
  try {
    const { stdout } = await exec('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 5000 })
    const sid = String(stdout).match(/S-1-\d+(?:-\d+)+/)?.[0]
    if (!sid) throw new Error('no SID in whoami output')
    await exec('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, timeout: 5000 })
    await writeFile(marker, new Date().toISOString(), { mode: 0o600 })
    return { applied: true }
  } catch (error) {
    log?.(`ClaudeGuard: 无法收紧数据目录权限，继续启动（${error?.message || error}）`)
    return { applied: false, reason: 'failed' }
  }
}
