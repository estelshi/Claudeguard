import test from 'node:test'
import assert from 'node:assert/strict'
import { protectionIndicator, tintTaskbarBitmap } from '../src/taskbar.mjs'

test('taskbar and tray fail closed on a mismatched or expired status', () => {
  const state = {
    state: 'protected', prepared: true, enabled: true, manual: false, requireTun: true, tunEnabled: true,
    expectedIP: '198.51.100.7', last: { ip: '198.51.100.7' }, gateway: { open: true, expiresAt: 110 },
  }
  assert.equal(protectionIndicator(state, true, 100).key, 'protected')
  assert.equal(protectionIndicator(state, true, 110).key, 'blocked')
  assert.equal(protectionIndicator({ ...state, tunEnabled: false }, true, 100).key, 'blocked')
  assert.equal(protectionIndicator({ ...state, last: { ip: '198.51.100.8' } }, true, 100).key, 'blocked')
  assert.equal(protectionIndicator({ ...state, manual: true }, true, 100).key, 'blocked')
  assert.equal(protectionIndicator({ phase: 'verifying', state: 'blocked' }, true, 100).key, 'verifying')
  assert.equal(protectionIndicator({ phase: 'awaiting-rules' }, true, 100).key, 'unconfigured')
})

test('only Clawd changes color, with a neutral shield and premultiplied edges', () => {
  const input = Buffer.from([0, 0, 0, 0, 0, 0, 0, 255, 128, 128, 128, 128, 255, 255, 255, 255])
  assert.deepEqual([...tintTaskbarBitmap(input, [200, 100, 50])],
    [0, 0, 0, 0, 65, 57, 52, 255, 25, 50, 100, 128, 50, 100, 200, 255])
})
