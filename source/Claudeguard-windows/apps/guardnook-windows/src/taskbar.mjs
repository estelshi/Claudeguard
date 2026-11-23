export function protectionIndicator(status, configured, now = Date.now()) {
  const protectedNow = configured && status?.state === 'protected' && status.enabled === true
    && status.manual !== true && status.prepared === true && Boolean(status.expectedIP)
    && status.last?.ip === status.expectedIP && status.gateway?.open === true
    && status.gateway.expiresAt > now && (status.requireTun !== true || status.tunEnabled === true)
  if (protectedNow) return { key: 'protected', label: '保护中', color: [35, 195, 112] }
  if (status?.phase === 'verifying' && !status.manual) return { key: 'verifying', label: '正在验证固定出口', color: [220, 151, 52] }
  if (!configured || status?.phase === 'awaiting-rules') return { key: 'unconfigured', label: configured ? '待导入守护规则' : '尚未配置', color: [139, 146, 158] }
  return { key: 'blocked', label: 'Claude 尚未放行', color: [241, 72, 77] }
}

// The black shield stays neutral. The white Clawd silhouette carries the state color.
// Electron bitmaps store pre-multiplied BGRA pixels on Windows.
export function tintTaskbarBitmap(bitmap, [red, green, blue]) {
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    const clawd = bitmap[offset] / 255
    const shield = bitmap[offset + 3] / 255 - clawd
    bitmap[offset] = Math.round(blue * clawd + 65 * shield)
    bitmap[offset + 1] = Math.round(green * clawd + 57 * shield)
    bitmap[offset + 2] = Math.round(red * clawd + 52 * shield)
  }
  return bitmap
}

// The tray menu depends on the indicator AND on whether a config exists:
// 「重新验证」 must become available right after the first save, even if the
// indicator stays grey (unconfigured -> awaiting rules).
export const trayMenuKey = (indicator, configured) => `${indicator.key}|${configured ? 'configured' : 'empty'}`

export function trayMenuItems(indicator, configured, { open, inspect, block, quit } = {}) {
  return [
    { label: indicator.label, enabled: false },
    { type: 'separator' },
    { label: '打开 ClaudeGuard', click: open },
    { label: '重新验证', enabled: Boolean(configured), click: inspect },
    { label: '立即阻断 Claude', enabled: indicator.key === 'protected', click: block },
    { type: 'separator' }, { label: '退出 ClaudeGuard', click: quit },
  ]
}
