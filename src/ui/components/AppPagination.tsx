import React from 'react'
import {
    Pagination,
    PaginationContent,
    PaginationEllipsis,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
} from './ui/pagination'

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from './select'
import { UiAccessGate } from '@/context/UiAccessContext'
import { useTranslation } from 'react-i18next'

interface AppPaginationProps {
    currentPage: number
    totalCount: number
    pageSize: number
    pageCount?: number
    onPageChange: (page: number) => void
    onPageSizeChange?: (pageSize: number) => void
    pageSizeOptions?: number[]
    className?: string
}

export const AppPagination: React.FC<AppPaginationProps> = ({
    currentPage,
    totalCount,
    pageSize,
    pageCount,
    onPageChange,
    onPageSizeChange,
    pageSizeOptions = [5, 10, 20, 50, 100],
    className
}) => {
    const { t } = useTranslation()
    const totalPages = pageCount ?? Math.ceil(totalCount / pageSize)

    // Only hide if there's no data AND no selector
    if (totalCount === 0 && !onPageSizeChange) return null
    // If only one page AND no selector, hide
    if (totalPages <= 1 && !onPageSizeChange) return null

    const renderPageItems = () => {
        const items = []
        const siblingCount = 1 // Number of pages either side of current page

        // Determine range of pages to show
        let startPage = Math.max(1, currentPage - siblingCount)
        let endPage = Math.min(totalPages, currentPage + siblingCount)

        // Always show page 1
        if (startPage > 1) {
            items.push(
                <PaginationItem key={1}>
                    <PaginationLink onClick={() => onPageChange(1)}>1</PaginationLink>
                </PaginationItem>
            )
            if (startPage > 2) {
                items.push(
                    <PaginationItem key="ellipsis-start">
                        <PaginationEllipsis />
                    </PaginationItem>
                )
            }
        }

        // Main range
        for (let i = startPage; i <= endPage; i++) {
            items.push(
                <PaginationItem key={i}>
                    <PaginationLink
                        isActive={currentPage === i}
                        onClick={() => onPageChange(i)}
                        className="cursor-pointer"
                    >
                        {i}
                    </PaginationLink>
                </PaginationItem>
            )
        }

        // Always show last page
        if (endPage < totalPages) {
            if (endPage < totalPages - 1) {
                items.push(
                    <PaginationItem key="ellipsis-end">
                        <PaginationEllipsis />
                    </PaginationItem>
                )
            }
            items.push(
                <PaginationItem key={totalPages}>
                    <PaginationLink onClick={() => onPageChange(totalPages)}>{totalPages}</PaginationLink>
                </PaginationItem>
            )
        }

        return items
    }

    return (
        <Pagination className={className}>
            <PaginationContent className="flex-wrap gap-y-2">
                {onPageSizeChange && (
                    <PaginationItem className="list-none">
                        <UiAccessGate>
                            <div className="flex items-center gap-2 me-2">
                                <span className="text-xs text-muted-foreground whitespace-nowrap">
                                    {t('common.rowsPerPage') || 'Rows per page'}:
                                </span>
                                <Select
                                    value={String(pageSize)}
                                    onValueChange={(val) => onPageSizeChange(Number(val))}
                                >
                                    <SelectTrigger className="h-8 w-[70px] text-xs">
                                        <SelectValue placeholder={pageSize} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {pageSizeOptions.map((option) => (
                                            <SelectItem key={option} value={String(option)} className="text-xs">
                                                {option}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        </UiAccessGate>
                    </PaginationItem>
                )}

                {totalPages > 1 && (
                    <div className="flex items-center">
                        <PaginationItem>
                            <PaginationPrevious
                                onClick={() => currentPage > 1 && onPageChange(currentPage - 1)}
                                className={currentPage <= 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                            />
                        </PaginationItem>

                        {renderPageItems()}

                        <PaginationItem>
                            <PaginationNext
                                onClick={() => currentPage < totalPages && onPageChange(currentPage + 1)}
                                className={currentPage >= totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
                            />
                        </PaginationItem>
                    </div>
                )}
            </PaginationContent>
        </Pagination>
    )
}
