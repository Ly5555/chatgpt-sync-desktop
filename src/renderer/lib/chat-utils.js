// Extract plain text from OpenClaw chat message blocks.
export function extractMessageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const texts = blocks
    .filter((block) => block?.type === 'text' && typeof block?.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)

  if (texts.length > 0) {
    return texts.join('\n\n')
  }

  if (typeof message?.text === 'string' && message.text.trim()) {
    return message.text.trim()
  }

  return ''
}

// Gateway may return a canonical session key that wraps the requested one.
export function sessionKeyMatches(expected, actual) {
  const expectedKey = String(expected || '').trim()
  const actualKey = String(actual || '').trim()

  if (!expectedKey || !actualKey) return false
  if (expectedKey === actualKey) return true
  if (actualKey.endsWith(`:${expectedKey}`)) return true

  return false
}

