export const LOGS_PAGE_SIZE_OPTIONS = [5, 10, 20, 50, 100]
export const DEFAULT_LOGS_PAGE_SIZE = 20

export function getLogsPageSize(storedValue: string | null) {
    const pageSize = Number(storedValue)
    return LOGS_PAGE_SIZE_OPTIONS.includes(pageSize) ? pageSize : DEFAULT_LOGS_PAGE_SIZE
}

export function paginateLogRecords<T>(records: T[], requestedPage: number, pageSize: number) {
    const totalPages = Math.max(1, Math.ceil(records.length / pageSize))
    const currentPage = Math.min(Math.max(1, requestedPage), totalPages)
    const start = (currentPage - 1) * pageSize

    return {
        currentPage,
        records: records.slice(start, start + pageSize),
    }
}
