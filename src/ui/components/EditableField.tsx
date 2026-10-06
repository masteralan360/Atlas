import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react'
import { resolveIsolatedTextDirection } from '@/lib/textDirection'

interface EditableFieldProps {
    value: string | number
    onChange: (value: string) => void
    type?: 'text' | 'number' | 'date' | 'textarea'
    className?: string
    display?: ((value: string) => ReactNode)
    placeholder?: string
    editable?: boolean
    inputClassName?: string
}

export function EditableField({
    value,
    onChange,
    type = 'text',
    className = '',
    display,
    placeholder = '',
    editable = true,
    inputClassName = '',
}: EditableFieldProps) {
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(String(value))
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        setDraft(String(value))
    }, [value])

    useEffect(() => {
        if (editing && inputRef.current) {
            inputRef.current.focus()
            inputRef.current.select()
        }
    }, [editing])

    const handleStart = useCallback(() => {
        if (!editable) return
        setDraft(String(value))
        setEditing(true)
    }, [editable, value])

    const handleFinish = useCallback(() => {
        const trimmed = draft.trim()
        if (trimmed !== String(value)) {
            onChange(trimmed)
        }
        setEditing(false)
    }, [draft, onChange, value])

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleFinish()
        } else if (e.key === 'Escape') {
            setDraft(String(value))
            setEditing(false)
        }
    }, [handleFinish, value])

    const handleBlur = useCallback(() => {
        handleFinish()
    }, [handleFinish])

    if (!editing) {
        return (
            <span
                dir={resolveIsolatedTextDirection(String(value) || placeholder)}
                className={editable ? `cursor-pointer hover:bg-blue-50 rounded px-0.5 -mx-0.5 transition-colors ${className}` : className}
                onClick={handleStart}
                title={editable ? 'Click to edit' : undefined}
            >
                {display ? display(String(value)) : value || placeholder || <span className="text-gray-300 italic">empty</span>}
            </span>
        )
    }

    if (type === 'textarea') {
        return (
            <textarea
                ref={inputRef as any}
                value={draft}
                dir={resolveIsolatedTextDirection(draft || placeholder)}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={handleBlur}
                onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                        setDraft(String(value))
                        setEditing(false)
                    }
                    // For textarea, Enter adds a newline, so no auto-finish on Enter.
                }}
                className={`border border-blue-400 rounded px-1 py-0.5 text-sm bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-300 w-full resize-none ${inputClassName || className}`}
                placeholder={placeholder}
                rows={3}
            />
        )
    }

    return (
        <input
            ref={inputRef}
            type={type}
            autoComplete="off"
            value={draft}
            dir={resolveIsolatedTextDirection(draft || placeholder)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className={`border border-blue-400 rounded px-1 py-0.5 text-sm bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-300 ${inputClassName || className}`}
            placeholder={placeholder}
        />
    )
}
