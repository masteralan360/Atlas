import { db } from './database'

export interface NotebookDocument {
    title: string
    content: string
    updatedAt: string
}

const NOTEBOOK_DOCUMENT_PREFIX = 'notebook_document'
const NOTEBOOK_STARTER_MARKERS = [
    'Extensive Preset: JSON-First Feature Showcase',
    'Use the toolbar, floating toolbar, slash commands (/), and command palette (Ctrl/Cmd+Shift+P) to explore the full preset.'
]

export function getNotebookStorageKey(params: { workspaceId?: string; userId?: string }) {
    const workspaceId = params.workspaceId || 'global'
    const userId = params.userId || 'anonymous'

    return `${NOTEBOOK_DOCUMENT_PREFIX}:${workspaceId}:${userId}`
}

export async function getNotebookDocument(key: string): Promise<NotebookDocument | null> {
    const setting = await db.app_settings.get(key)

    if (!setting?.value) {
        return null
    }

    try {
        const parsed = JSON.parse(setting.value) as Partial<NotebookDocument>

        if (typeof parsed.content !== 'string') {
            return null
        }

        return {
            title: typeof parsed.title === 'string' ? parsed.title : '',
            content: parsed.content,
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
        }
    } catch (error) {
        console.warn('[Notebook] Failed to parse saved notebook document:', error)
        return null
    }
}

export async function saveNotebookDocument(key: string, document: NotebookDocument): Promise<void> {
    await db.app_settings.put({
        key,
        value: JSON.stringify(document)
    })
}

export function isNotebookStarterContent(content: string | null | undefined): boolean {
    if (typeof content !== 'string' || content.trim().length === 0) {
        return false
    }

    return NOTEBOOK_STARTER_MARKERS.every((marker) => content.includes(marker))
}
