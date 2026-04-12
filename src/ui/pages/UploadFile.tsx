import { useMemo, useState, type FormEvent } from 'react'
import { Search, Eye, Trash2, FileUp, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { FileUpload } from '@/components/application/file-upload/file-upload-base'
import { useAuth } from '@/auth'
import { createInvoice, deleteInvoice, type Invoice } from '@/local-db'
import { generateId, formatDateTime } from '@/lib/utils'
import { r2Service } from '@/services/r2Service'
import { useWorkspace } from '@/workspace'
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Input,
    Label,
    Button,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    useToast,
    DeleteConfirmationModal,
} from '@/ui/components'

const MAX_UPLOAD_SIZE_BYTES = 2 * 1024 * 1024

function isPdfFile(file: File) {
    return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}

function getBaseName(fileName: string) {
    return fileName.replace(/\.pdf$/i, '').trim()
}

function sanitizeStorageSegment(value: string) {
    return value
        .trim()
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'document'
}

interface UploadFilesTabProps {
    invoices: Invoice[]
    onPreview: (invoice: Invoice) => void
}

export function UploadFilesTab({ invoices, onPreview }: UploadFilesTabProps) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { user } = useAuth()
    const { activeWorkspace, features } = useWorkspace()
    const [documentName, setDocumentName] = useState('')
    const [selectedFile, setSelectedFile] = useState<File | null>(null)
    const [uploadProgress, setUploadProgress] = useState(0)
    const [isUploading, setIsUploading] = useState(false)
    const [search, setSearch] = useState('')
    const [deleteTarget, setDeleteTarget] = useState<Invoice | null>(null)
    const [isDeleting, setIsDeleting] = useState(false)

    const uploadRecords = useMemo(
        () => invoices
            .filter((invoice) => invoice.origin === 'upload' && !invoice.isDeleted)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
        [invoices],
    )

    const filteredUploadRecords = useMemo(() => {
        const normalizedSearch = search.trim().toLowerCase()
        if (!normalizedSearch) return uploadRecords

        return uploadRecords.filter((invoice) => {
            const createdBy = invoice.createdByName || invoice.createdBy || ''
            return (
                invoice.invoiceid.toLowerCase().includes(normalizedSearch)
                || createdBy.toLowerCase().includes(normalizedSearch)
            )
        })
    }, [search, uploadRecords])

    const canDelete = user?.role === 'admin'

    const handleFileSelected = (file: File | null) => {
        if (!file) return

        if (!isPdfFile(file)) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: t('uploadFile.pdfOnly', { defaultValue: 'Only PDF files are allowed.' }),
                variant: 'destructive',
            })
            return
        }

        if (file.size > MAX_UPLOAD_SIZE_BYTES) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: t('uploadFile.maxSizeError', { defaultValue: 'The selected file exceeds the 2 MB limit.' }),
                variant: 'destructive',
            })
            return
        }

        setSelectedFile(file)
        setUploadProgress(0)
        setDocumentName((current) => current.trim() || getBaseName(file.name))
    }

    const resetForm = () => {
        setDocumentName('')
        setSelectedFile(null)
        setUploadProgress(0)
    }

    const handleUpload = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()

        if (!user || !activeWorkspace?.id) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: t('uploadFile.workspaceMissing', { defaultValue: 'Workspace context is missing.' }),
                variant: 'destructive',
            })
            return
        }

        const trimmedName = documentName.trim()
        if (!trimmedName) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: t('uploadFile.nameRequired', { defaultValue: 'Name is required.' }),
                variant: 'destructive',
            })
            return
        }

        if (!selectedFile) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: t('uploadFile.selectFile', { defaultValue: 'Please select a PDF file to upload.' }),
                variant: 'destructive',
            })
            return
        }

        if (!isPdfFile(selectedFile)) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: t('uploadFile.pdfOnly', { defaultValue: 'Only PDF files are allowed.' }),
                variant: 'destructive',
            })
            return
        }

        if (selectedFile.size > MAX_UPLOAD_SIZE_BYTES) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: t('uploadFile.maxSizeError', { defaultValue: 'The selected file exceeds the 2 MB limit.' }),
                variant: 'destructive',
            })
            return
        }

        if (!navigator.onLine) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: t('uploadFile.mustBeOnline', { defaultValue: 'You must be online to upload files to R2 storage.' }),
                variant: 'destructive',
            })
            return
        }

        if (!r2Service.isConfigured()) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: t('uploadFile.r2NotConfigured', { defaultValue: 'R2 storage is not configured on this device.' }),
                variant: 'destructive',
            })
            return
        }

        const invoiceId = generateId()
        const storagePath = `${activeWorkspace.id}/uploads/${invoiceId}-${sanitizeStorageSegment(trimmedName)}.pdf`
        let uploaded = false

        setIsUploading(true)
        setUploadProgress(15)

        try {
            await r2Service.upload(storagePath, selectedFile, 'application/pdf')
            uploaded = true
            setUploadProgress(78)

            await createInvoice(activeWorkspace.id, {
                invoiceid: trimmedName,
                totalAmount: 0,
                settlementCurrency: features.default_currency || 'usd',
                origin: 'upload',
                createdBy: user.id,
                createdByName: user.name,
                cashierName: user.name,
                printFormat: 'a4',
                r2PathA4: storagePath,
            }, invoiceId)

            setUploadProgress(100)
            toast({
                title: t('uploadFile.uploadComplete', { defaultValue: 'Upload complete' }),
                description: t('uploadFile.uploadSavedDescription', { defaultValue: '"{{name}}" was saved to workspace uploads.', name: trimmedName }),
            })

            resetForm()
        } catch (error) {
            if (uploaded) {
                await r2Service.delete(storagePath).catch((cleanupError) => {
                    console.error('[UploadFilesTab] Failed to clean up orphaned upload:', cleanupError)
                })
            }

            console.error('[UploadFilesTab] Upload failed:', error)
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error instanceof Error ? error.message : t('uploadFile.uploadFailed', { defaultValue: 'Failed to upload the PDF file.' }),
                variant: 'destructive',
            })
        } finally {
            setIsUploading(false)
            window.setTimeout(() => {
                setUploadProgress((current) => current >= 100 ? 0 : current)
            }, 500)
        }
    }

    const handleDelete = async () => {
        if (!deleteTarget) return

        if (!canDelete) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: t('uploadFile.onlyAdmins', { defaultValue: 'Only admins can delete uploaded files.' }),
                variant: 'destructive',
            })
            return
        }

        if (deleteTarget.r2PathA4 && !navigator.onLine) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: t('uploadFile.mustBeOnlineDelete', { defaultValue: 'You must be online to delete files from R2 storage.' }),
                variant: 'destructive',
            })
            return
        }

        setIsDeleting(true)

        try {
            if (deleteTarget.r2PathA4) {
                await r2Service.delete(deleteTarget.r2PathA4)
            }

            await deleteInvoice(deleteTarget.id)
            toast({
                title: t('uploadFile.fileDeleted', { defaultValue: 'File deleted' }),
                description: t('uploadFile.fileDeletedDescription', { defaultValue: '"{{name}}" was removed from uploads.', name: deleteTarget.invoiceid }),
            })
            setDeleteTarget(null)
        } catch (error) {
            console.error('[UploadFilesTab] Delete failed:', error)
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error instanceof Error ? error.message : t('uploadFile.deleteFailed', { defaultValue: 'Failed to delete the uploaded file.' }),
                variant: 'destructive',
            })
        } finally {
            setIsDeleting(false)
        }
    }

    return (
        <div className="space-y-6">
            <Card className="overflow-hidden rounded-[2rem] border-border/60 bg-card/50 shadow-sm backdrop-blur-md">
                <CardHeader className="border-b border-border/50 bg-muted/20">
                    <CardTitle className="flex items-center gap-3 text-lg font-black">
                        <div className="rounded-2xl bg-primary/10 p-2.5">
                            <FileUp className="h-5 w-5 text-primary" />
                        </div>
                        {t('uploadFile.title', { defaultValue: 'Upload Files' })}
                    </CardTitle>
                    <p className="text-sm text-muted-foreground">
                        {t('uploadFile.subtitle', { defaultValue: 'Upload PDF files to workspace R2 storage and track them from the invoices module.' })}
                    </p>
                </CardHeader>
                <CardContent className="space-y-6 p-6">
                    {!r2Service.isConfigured() && (
                        <div className="flex items-start gap-3 rounded-2xl border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
                            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
                            <p>{t('uploadFile.r2NotConfiguredDesc', { defaultValue: 'R2 storage is not configured on this device. Uploads will stay blocked until the worker URL and auth token are available.' })}</p>
                        </div>
                    )}

                    <form className="space-y-6" onSubmit={handleUpload}>
                        <div className="space-y-2">
                            <Label htmlFor="upload-file-name">{t('uploadFile.name', { defaultValue: 'Name' })}</Label>
                            <Input
                                id="upload-file-name"
                                allowViewer={true}
                                value={documentName}
                                onChange={(event) => setDocumentName(event.target.value)}
                                placeholder={t('uploadFile.namePlaceholder', { defaultValue: 'Enter a document name' })}
                                disabled={isUploading}
                            />
                        </div>

                        <FileUpload.Root>
                            <FileUpload.DropZone
                                accept=".pdf,application/pdf"
                                allowsMultiple={false}
                                maxSize={MAX_UPLOAD_SIZE_BYTES}
                                isDisabled={isUploading}
                                hint={t('uploadFile.dropHint', { defaultValue: 'PDF files only. Maximum file size is 2 MB.' })}
                                onDropFiles={(files) => handleFileSelected(files[0] ?? null)}
                                onDropUnacceptedFiles={() => {
                                    toast({
                                        title: t('common.error', { defaultValue: 'Error' }),
                                        description: t('uploadFile.pdfOnly', { defaultValue: 'Only PDF files are allowed.' }),
                                        variant: 'destructive',
                                    })
                                }}
                                onSizeLimitExceed={() => {
                                    toast({
                                        title: t('common.error', { defaultValue: 'Error' }),
                                        description: t('uploadFile.maxSizeError', { defaultValue: 'The selected file exceeds the 2 MB limit.' }),
                                        variant: 'destructive',
                                    })
                                }}
                            />

                            {selectedFile && (
                                <FileUpload.List>
                                    <FileUpload.ListItemProgressBar
                                        name={selectedFile.name}
                                        size={selectedFile.size}
                                        type="pdf"
                                        progress={isUploading ? uploadProgress : 0}
                                        onDelete={isUploading ? undefined : () => {
                                            setSelectedFile(null)
                                            setUploadProgress(0)
                                        }}
                                    />
                                </FileUpload.List>
                            )}
                        </FileUpload.Root>

                        <div className="flex flex-wrap items-center justify-end gap-3">
                            <Button
                                type="button"
                                variant="ghost"
                                allowViewer={true}
                                disabled={isUploading || (!selectedFile && !documentName)}
                                onClick={resetForm}
                            >
                                {t('uploadFile.clear', { defaultValue: 'Clear' })}
                            </Button>
                            <Button
                                type="submit"
                                allowViewer={true}
                                disabled={isUploading || !selectedFile || !documentName.trim() || !r2Service.isConfigured()}
                            >
                                {isUploading ? t('uploadFile.uploading', { defaultValue: 'Uploading...' }) : t('uploadFile.uploadPdf', { defaultValue: 'Upload PDF' })}
                            </Button>
                        </div>
                    </form>
                </CardContent>
            </Card>

            <Card className="overflow-hidden rounded-[2rem] border-border/60 shadow-sm">
                <CardHeader className="border-b border-border/50 bg-muted/20">
                    <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                        <div>
                            <CardTitle className="text-lg font-black">{t('uploadFile.uploadedFiles', { defaultValue: 'Uploaded Files' })}</CardTitle>
                            <p className="mt-1 text-sm text-muted-foreground">
                                {t('uploadFile.filesCount', { count: uploadRecords.length, defaultValue: '{{count}} file stored in workspace uploads.' })}
                            </p>
                        </div>

                        <div className="relative w-full max-w-md">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                allowViewer={true}
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder={t('uploadFile.searchPlaceholder', { defaultValue: 'Search uploaded files' })}
                                className="pl-10"
                            />
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="p-0">
                    {filteredUploadRecords.length === 0 ? (
                        <div className="flex flex-col items-center justify-center gap-3 py-14 text-center text-muted-foreground">
                            <FileUp className="h-12 w-12 opacity-20" />
                            <div>
                                <p className="font-semibold text-foreground">
                                    {uploadRecords.length === 0 
                                        ? t('uploadFile.noFiles', { defaultValue: 'No uploaded files yet' }) 
                                        : t('uploadFile.noMatch', { defaultValue: 'No files match your search' })}
                                </p>
                                <p className="mt-1 text-sm text-muted-foreground">
                                    {t('uploadFile.dragHint', { defaultValue: 'Drag a PDF into the uploader above to create the first record.' })}
                                </p>
                            </div>
                        </div>
                    ) : (
                        <Table>
                            <TableHeader className="bg-muted/10">
                                <TableRow className="hover:bg-transparent">
                                    <TableHead className="py-4">{t('uploadFile.created', { defaultValue: 'Created' })}</TableHead>
                                    <TableHead>{t('uploadFile.name', { defaultValue: 'Name' })}</TableHead>
                                    <TableHead>{t('uploadFile.uploadedBy', { defaultValue: 'Uploaded By' })}</TableHead>
                                    <TableHead className="text-right pr-6">{t('common.actions', { defaultValue: 'Actions' })}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filteredUploadRecords.map((invoice) => (
                                    <TableRow key={invoice.id} className="group transition-colors hover:bg-muted/30">
                                        <TableCell className="text-xs font-medium text-muted-foreground">
                                            {formatDateTime(invoice.createdAt)}
                                        </TableCell>
                                        <TableCell className="font-semibold text-foreground">
                                            {invoice.invoiceid}
                                        </TableCell>
                                        <TableCell className="text-sm text-muted-foreground">
                                            {invoice.createdByName || invoice.createdBy || t('uploadFile.unknown', { defaultValue: 'Unknown' })}
                                        </TableCell>
                                        <TableCell className="pr-6">
                                            <div className="flex justify-end gap-2">
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    allowViewer={true}
                                                    className="rounded-xl"
                                                    onClick={() => onPreview(invoice)}
                                                >
                                                    <Eye className="h-4 w-4" />
                                                    {t('uploadFile.preview', { defaultValue: 'Preview' })}
                                                </Button>
                                                {canDelete && (
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="sm"
                                                        className="rounded-xl text-destructive hover:text-destructive"
                                                        onClick={() => setDeleteTarget(invoice)}
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                        {t('common.delete', { defaultValue: 'Delete' })}
                                                    </Button>
                                                )}
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>

            <DeleteConfirmationModal
                isOpen={!!deleteTarget}
                onClose={() => {
                    if (!isDeleting) {
                        setDeleteTarget(null)
                    }
                }}
                onConfirm={() => {
                    void handleDelete()
                }}
                isLoading={isDeleting}
                title={t('uploadFile.deleteTitle', { defaultValue: 'Delete Uploaded File' })}
                description={deleteTarget ? t('uploadFile.deleteDescription', { defaultValue: 'This will permanently remove "{{name}}" from R2 storage and the invoices table.', name: deleteTarget.invoiceid }) : undefined}
                itemName={deleteTarget?.invoiceid}
            />
        </div>
    )
}
