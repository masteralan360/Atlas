import { useRef } from 'react'
import { Input } from '@/ui/components'
import { isDemoOptionalModuleCode } from './demoConfig'

interface OptionalModuleCodesInputProps {
  id: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  invalidDescriptionId?: string
  invalid?: boolean
}

type CodeTokenSpan = {
  index: number
  value: string
  start: number
  end: number
}

function getTokenSpans(value: string): CodeTokenSpan[] {
  let offset = 0
  return value.split('-').map((token, index) => {
    const start = offset
    const end = start + token.length
    offset = end + 1
    return { index, value: token, start, end }
  })
}

function getTouchedValidTokenIndexes(
  value: string,
  start: number,
  end: number,
  operation: 'backward' | 'forward' | 'insert',
  includeInsertionAtEnd = false,
): number[] {
  return getTokenSpans(value)
    .filter((token) => {
      if (!isDemoOptionalModuleCode(token.value)) return false
      if (start < end) return start < token.end && end > token.start
      if (operation === 'backward') {
        const deletedCharacter = start - 1
        return deletedCharacter >= token.start && deletedCharacter < token.end
      }
      if (operation === 'forward') {
        return start >= token.start && start < token.end
      }
      return start >= token.start
        && (start < token.end || (includeInsertionAtEnd && start === token.end))
    })
    .map((token) => token.index)
}

function normalizeInput(value: string): string {
  return value
    .toUpperCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
}

export function OptionalModuleCodesInput({
  id,
  value,
  onChange,
  placeholder,
  invalidDescriptionId,
  invalid = false,
}: OptionalModuleCodesInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  const commitAtCaret = (nextValue: string, caret: number) => {
    onChange(nextValue)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      const position = Math.min(caret, nextValue.length)
      inputRef.current?.setSelectionRange(position, position)
    })
  }

  const removeOrReplaceTokens = (indexes: number[], replacement: string[] = []) => {
    if (!indexes.length) return
    const tokens = value.split('-')
    const removed = new Set(indexes)
    const firstIndex = Math.min(...indexes)
    const retainedBefore = tokens
      .slice(0, firstIndex)
      .filter((_, index) => !removed.has(index))
    const nextTokens = tokens.filter((_, index) => !removed.has(index))
    const insertionIndex = retainedBefore.length
    nextTokens.splice(insertionIndex, 0, ...replacement)
    const nextValue = normalizeInput(nextTokens.join('-'))
    const caretTokens = nextTokens.slice(0, insertionIndex + replacement.length)
    commitAtCaret(nextValue, caretTokens.join('-').length)
  }

  const insertSeparator = (input: HTMLInputElement) => {
    const start = input.selectionStart ?? value.length
    const end = input.selectionEnd ?? start
    const affected = getTouchedValidTokenIndexes(value, start, end, 'insert')
    if (affected.length) {
      removeOrReplaceTokens(affected)
      return
    }

    const nextValue = normalizeInput(`${value.slice(0, start)}-${value.slice(end)}`)
    const caret = normalizeInput(`${value.slice(0, start)}-`).length
    commitAtCaret(nextValue, caret)
  }

  const handleBeforeInput = (event: React.FormEvent<HTMLInputElement>) => {
    const nativeEvent = event.nativeEvent as InputEvent
    const input = event.currentTarget
    const start = input.selectionStart ?? value.length
    const end = input.selectionEnd ?? start

    if (nativeEvent.inputType === 'deleteContentBackward' || nativeEvent.inputType === 'deleteWordBackward') {
      const affected = getTouchedValidTokenIndexes(value, start, end, 'backward')
      if (affected.length) {
        event.preventDefault()
        removeOrReplaceTokens(affected)
      }
      return
    }

    if (nativeEvent.inputType === 'deleteContentForward' || nativeEvent.inputType === 'deleteWordForward') {
      const affected = getTouchedValidTokenIndexes(value, start, end, 'forward')
      if (affected.length) {
        event.preventDefault()
        removeOrReplaceTokens(affected)
      }
      return
    }

    if (!nativeEvent.inputType.startsWith('insert') || nativeEvent.data === null) return
    if (/^[a-z]+$/i.test(nativeEvent.data)) {
      const affected = getTouchedValidTokenIndexes(value, start, end, 'insert', true)
      if (affected.length) {
        event.preventDefault()
        removeOrReplaceTokens(affected, [nativeEvent.data.toUpperCase()])
      }
      return
    }

    if (/^[\s-]+$/.test(nativeEvent.data)) {
      event.preventDefault()
      insertSeparator(input)
      return
    }

    event.preventDefault()
  }

  return (
    <Input
      ref={inputRef}
      id={id}
      type="text"
      inputMode="text"
      autoComplete="off"
      spellCheck={false}
      value={value}
      placeholder={placeholder}
      aria-invalid={invalid}
      aria-describedby={invalidDescriptionId}
      className="h-12 rounded-xl bg-white text-gray-900 placeholder:text-gray-400 dark:bg-slate-900 dark:text-white dark:placeholder:text-slate-500"
      onBeforeInput={handleBeforeInput}
      onKeyDown={(event) => {
        const input = event.currentTarget
        const start = input.selectionStart ?? value.length
        const end = input.selectionEnd ?? start

        if (event.key === ' ' || event.key === '-') {
          event.preventDefault()
          insertSeparator(input)
          return
        }

        if (event.key === 'Backspace' || event.key === 'Delete') {
          const operation = event.key === 'Backspace' ? 'backward' : 'forward'
          const affected = getTouchedValidTokenIndexes(value, start, end, operation)
          if (affected.length) {
            event.preventDefault()
            removeOrReplaceTokens(affected)
          }
          return
        }

        if (/^[a-z]$/i.test(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
          const affected = getTouchedValidTokenIndexes(value, start, end, 'insert', true)
          if (affected.length) {
            event.preventDefault()
            removeOrReplaceTokens(affected, [event.key.toUpperCase()])
          }
          return
        }

        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault()
        }
      }}
      onChange={(event) => {
        const nextValue = event.currentTarget.value
        if (!/^[a-z\s-]*$/i.test(nextValue)) {
          event.currentTarget.value = value
          return
        }

        const caret = event.currentTarget.selectionStart ?? nextValue.length
        const normalized = normalizeInput(nextValue)
        onChange(normalized)
        if (normalized !== nextValue) {
          requestAnimationFrame(() => inputRef.current?.setSelectionRange(Math.min(caret, normalized.length), Math.min(caret, normalized.length)))
        }
      }}
      onPaste={(event) => {
        event.preventDefault()
        const pasted = event.clipboardData.getData('text')
        if (!pasted) return
        if (!/^[a-z\s-]*$/i.test(pasted)) return

        const input = event.currentTarget
        const start = input.selectionStart ?? value.length
        const end = input.selectionEnd ?? start
        const startsWithSeparator = /^[\s-]/.test(pasted)
        const affected = getTouchedValidTokenIndexes(value, start, end, 'insert', !startsWithSeparator)
        if (affected.length) {
          const pastedTokens = pasted.toUpperCase().split(/[-\s]+/).filter(Boolean)
          removeOrReplaceTokens(affected, pastedTokens)
          return
        }

        const nextValue = normalizeInput(`${value.slice(0, start)}${pasted}${value.slice(end)}`)
        const caret = normalizeInput(`${value.slice(0, start)}${pasted}`).length
        commitAtCaret(nextValue, caret)
      }}
      onCut={(event) => {
        const input = event.currentTarget
        const start = input.selectionStart ?? value.length
        const end = input.selectionEnd ?? start
        if (start === end) return
        const affected = getTouchedValidTokenIndexes(value, start, end, 'insert')
        if (affected.length) {
          event.preventDefault()
          removeOrReplaceTokens(affected)
        }
      }}
    />
  )
}
