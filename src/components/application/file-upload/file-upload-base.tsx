import type { ChangeEvent, ComponentProps, ComponentPropsWithRef, DragEvent } from 'react'
import { useId, useRef, useState } from 'react'
import type { FileIcon } from '@untitledui/file-icons'
import { FileIcon as FileTypeIcon } from '@untitledui/file-icons'
import { CheckCircle, Trash01, UploadCloud02, XCircle } from '@untitledui/icons'
import { AnimatePresence, motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { Button } from '@/ui/components/button'
import { Progress } from '@/ui/components/ui/progress'

export const getReadableFileSize = (bytes: number) => {
    if (bytes === 0) return '0 KB'

    const suffixes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
    const index = Math.floor(Math.log(bytes) / Math.log(1024))

    return `${Math.floor(bytes / Math.pow(1024, index))} ${suffixes[index]}`
}

interface FileUploadDropZoneProps {
    className?: string
    hint?: string
    isDisabled?: boolean
    accept?: string
    allowsMultiple?: boolean
    maxSize?: number
    onDropFiles?: (files: FileList) => void
    onDropUnacceptedFiles?: (files: FileList) => void
    onSizeLimitExceed?: (files: FileList) => void
}

export const FileUploadDropZone = ({
    className,
    hint,
    isDisabled,
    accept,
    allowsMultiple = true,
    maxSize,
    onDropFiles,
    onDropUnacceptedFiles,
    onSizeLimitExceed,
}: FileUploadDropZoneProps) => {
    const id = useId()
    const inputRef = useRef<HTMLInputElement>(null)
    const [isInvalid, setIsInvalid] = useState(false)
    const [isDraggingOver, setIsDraggingOver] = useState(false)

    const isFileTypeAccepted = (file: File): boolean => {
        if (!accept) return true

        const acceptedTypes = accept.split(',').map((type) => type.trim())

        return acceptedTypes.some((acceptedType) => {
            if (acceptedType.startsWith('.')) {
                const extension = `.${file.name.split('.').pop()?.toLowerCase()}`
                return extension === acceptedType.toLowerCase()
            }

            if (acceptedType.endsWith('/*')) {
                const typePrefix = acceptedType.split('/')[0]
                return file.type.startsWith(`${typePrefix}/`)
            }

            return file.type === acceptedType
        })
    }

    const resetInput = () => {
        if (inputRef.current) {
            inputRef.current.value = ''
        }
    }

    const processFiles = (files: File[]) => {
        setIsInvalid(false)

        const acceptedFiles: File[] = []
        const unacceptedFiles: File[] = []
        const oversizedFiles: File[] = []
        const filesToProcess = allowsMultiple ? files : files.slice(0, 1)

        filesToProcess.forEach((file) => {
            if (maxSize && file.size > maxSize) {
                oversizedFiles.push(file)
                return
            }

            if (isFileTypeAccepted(file)) {
                acceptedFiles.push(file)
                return
            }

            unacceptedFiles.push(file)
        })

        if (oversizedFiles.length > 0 && onSizeLimitExceed) {
            const transfer = new DataTransfer()
            oversizedFiles.forEach((file) => transfer.items.add(file))
            setIsInvalid(true)
            onSizeLimitExceed(transfer.files)
        }

        if (acceptedFiles.length > 0 && onDropFiles) {
            const transfer = new DataTransfer()
            acceptedFiles.forEach((file) => transfer.items.add(file))
            onDropFiles(transfer.files)
        }

        if (unacceptedFiles.length > 0 && onDropUnacceptedFiles) {
            const transfer = new DataTransfer()
            unacceptedFiles.forEach((file) => transfer.items.add(file))
            setIsInvalid(true)
            onDropUnacceptedFiles(transfer.files)
        }

        resetInput()
    }

    const handleDragIn = (event: DragEvent<HTMLDivElement>) => {
        if (isDisabled) return
        event.preventDefault()
        event.stopPropagation()
        setIsDraggingOver(true)
    }

    const handleDragOut = (event: DragEvent<HTMLDivElement>) => {
        if (isDisabled) return
        event.preventDefault()
        event.stopPropagation()
        setIsDraggingOver(false)
    }

    const handleDrop = (event: DragEvent<HTMLDivElement>) => {
        if (isDisabled) return
        handleDragOut(event)
        processFiles(Array.from(event.dataTransfer.files))
    }

    return (
        <div
            data-dropzone
            onDragOver={handleDragIn}
            onDragEnter={handleDragIn}
            onDragLeave={handleDragOut}
            onDragEnd={handleDragOut}
            onDrop={handleDrop}
            className={cn(
                'relative flex flex-col items-center gap-4 rounded-[1.75rem] border-2 border-dashed px-6 py-8 text-center transition-all duration-200',
                isDraggingOver ? 'border-primary bg-primary/10 shadow-lg shadow-primary/10' : 'border-border/70 bg-muted/20',
                isDisabled && 'cursor-not-allowed opacity-60',
                className,
            )}
        >
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border/70 bg-background shadow-sm">
                <UploadCloud02 className="h-7 w-7 text-primary" />
            </div>

            <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-center gap-2 text-sm font-medium">
                    <input
                        ref={inputRef}
                        id={id}
                        type="file"
                        className="sr-only"
                        disabled={isDisabled}
                        accept={accept}
                        multiple={allowsMultiple}
                        onChange={(event: ChangeEvent<HTMLInputElement>) => processFiles(Array.from(event.target.files || []))}
                    />
                    <button
                        type="button"
                        onClick={() => inputRef.current?.click()}
                        disabled={isDisabled}
                        className="font-semibold text-primary transition-colors hover:text-primary/80 disabled:cursor-not-allowed disabled:text-muted-foreground"
                    >
                        Click to upload
                    </button>
                    <span className="text-muted-foreground">or drag and drop</span>
                </div>
                <p className={cn('text-xs text-muted-foreground', isInvalid && 'text-destructive')}>
                    {hint || 'PDF only, maximum 2 MB'}
                </p>
            </div>
        </div>
    )
}

export interface FileListItemProps {
    name: string
    size: number
    progress: number
    failed?: boolean
    type?: ComponentProps<typeof FileIcon>['type']
    className?: string
    fileIconVariant?: ComponentProps<typeof FileTypeIcon>['variant']
    onDelete?: () => void
    onRetry?: () => void
}

export const FileListItemProgressBar = ({
    name,
    size,
    progress,
    failed,
    type,
    fileIconVariant,
    onDelete,
    onRetry,
    className,
}: FileListItemProps) => {
    const isComplete = progress >= 100
    const isPending = progress <= 0 && !failed && !isComplete

    return (
        <motion.li
            layout="position"
            className={cn(
                'relative flex items-start gap-3 rounded-2xl border border-border/70 bg-card/70 p-4 shadow-sm',
                failed && 'border-destructive/40',
                className,
            )}
        >
            <FileTypeIcon
                className="h-10 w-10 shrink-0"
                type={type ?? 'empty'}
                theme="light"
                variant={fileIconVariant ?? 'default'}
            />

            <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">{name}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span>{getReadableFileSize(size)}</span>
                            <span className="h-1 w-1 rounded-full bg-border" />
                            {isComplete && (
                                <span className="inline-flex items-center gap-1 font-medium text-emerald-600">
                                    <CheckCircle className="h-4 w-4" />
                                    Complete
                                </span>
                            )}
                            {isPending && (
                                <span className="inline-flex items-center gap-1 font-medium text-amber-600">
                                    <UploadCloud02 className="h-4 w-4" />
                                    Ready to upload
                                </span>
                            )}
                            {!isPending && !isComplete && !failed && (
                                <span className="inline-flex items-center gap-1 font-medium text-primary">
                                    <UploadCloud02 className="h-4 w-4" />
                                    Uploading...
                                </span>
                            )}
                            {failed && (
                                <span className="inline-flex items-center gap-1 font-medium text-destructive">
                                    <XCircle className="h-4 w-4" />
                                    Failed
                                </span>
                            )}
                        </div>
                    </div>

                    {onDelete && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            allowViewer={true}
                            className="h-8 w-8 rounded-xl text-muted-foreground hover:text-destructive"
                            onClick={onDelete}
                        >
                            <Trash01 className="h-4 w-4" />
                        </Button>
                    )}
                </div>

                {!failed && !isPending && (
                    <div className="mt-3">
                        <Progress value={Math.max(0, Math.min(progress, 100))} />
                    </div>
                )}

                {failed && onRetry && (
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        allowViewer={true}
                        onClick={onRetry}
                        className="mt-3"
                    >
                        Try again
                    </Button>
                )}
            </div>
        </motion.li>
    )
}

export const FileListItemProgressFill = (props: FileListItemProps) => {
    return <FileListItemProgressBar {...props} />
}

const FileUploadRoot = (props: ComponentPropsWithRef<'div'>) => (
    <div {...props} className={cn('flex flex-col gap-4', props.className)}>
        {props.children}
    </div>
)

const FileUploadList = (props: ComponentPropsWithRef<'ul'>) => (
    <ul {...props} className={cn('flex flex-col gap-3', props.className)}>
        <AnimatePresence initial={false}>{props.children}</AnimatePresence>
    </ul>
)

export const FileUpload = {
    Root: FileUploadRoot,
    List: FileUploadList,
    DropZone: FileUploadDropZone,
    ListItemProgressBar: FileListItemProgressBar,
    ListItemProgressFill: FileListItemProgressFill,
}
