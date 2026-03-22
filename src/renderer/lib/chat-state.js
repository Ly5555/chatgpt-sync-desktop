import { extractMessageText } from './chat-utils'

export function mapHistoryMessages(historyMessages) {
  return historyMessages
    .map((message, index) => ({
      id: `history-${index}`,
      role: message?.role === 'assistant' ? 'assistant' : 'user',
      text: extractMessageText(message),
      error: ''
    }))
    .filter((message) => message.text)
}

export function createOptimisticUserMessage(text) {
  return {
    id: `user-${Date.now()}`,
    role: 'user',
    text,
    error: ''
  }
}

export function markMessageError(messages, messageId, errorText) {
  return messages.map((message) => (
    message.id === messageId
      ? { ...message, error: errorText || '发送失败' }
      : message
  ))
}

// Merge gateway delta/final payloads into a stable assistant bubble per run.
export function mergeAssistantMessage(messages, payload) {
  const assistantText = extractMessageText(payload?.message)
  if (!assistantText) return messages

  const nextId = `assistant-${payload.runId}`
  const exists = messages.find((message) => message.id === nextId)
  if (exists) {
    return messages.map((message) => (
      message.id === nextId
        ? { ...message, text: assistantText, error: '' }
        : message
    ))
  }

  return [...messages, {
    id: nextId,
    role: 'assistant',
    text: assistantText,
    error: ''
  }]
}
