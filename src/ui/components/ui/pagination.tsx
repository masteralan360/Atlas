import * as React from "react"
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import { ButtonProps, buttonVariants } from "@/ui/components/button"

const Pagination = ({ className, ...props }: React.ComponentProps<"nav">) => (
    <nav
        role="navigation"
        aria-label="pagination"
        className={cn("mx-auto flex w-full justify-center", className)}
        {...props}
    />
)
Pagination.displayName = "Pagination"

const PaginationContent = React.forwardRef<
    HTMLUListElement,
    React.ComponentProps<"ul">
>(({ className, ...props }, ref) => (
    <ul
        ref={ref}
        className={cn("flex flex-row items-center gap-1", className)}
        {...props}
    />
))
PaginationContent.displayName = "PaginationContent"

const PaginationItem = React.forwardRef<
    HTMLLIElement,
    React.ComponentProps<"li">
>(({ className, ...props }, ref) => (
    <li ref={ref} className={cn("", className)} {...props} />
))
PaginationItem.displayName = "PaginationItem"

type PaginationLinkProps = {
    isActive?: boolean
} & Pick<ButtonProps, "size"> &
    React.ComponentProps<"a">

const PaginationLink = ({
    className,
    isActive,
    size = "icon",
    ...props
}: PaginationLinkProps) => (
    <a
        aria-current={isActive ? "page" : undefined}
        className={cn(
            buttonVariants({
                variant: isActive ? "outline" : "ghost",
                size,
            }),
            className
        )}
        {...props}
    />
)
PaginationLink.displayName = "PaginationLink"

const PaginationPrevious = ({
    className,
    ...props
}: React.ComponentProps<typeof PaginationLink>) => {
    const { t } = useTranslation()
    return (
        <PaginationLink
            aria-label={t("common.pagination.previous")}
            size="default"
            className={cn("h-10 w-10 justify-center gap-0 px-0 sm:w-auto sm:justify-start sm:gap-1 sm:px-2.5", className)}
            {...props}
        >
            <ChevronLeft className="h-5 w-5 rtl:rotate-180 sm:h-4 sm:w-4" />
            <span className="hidden sm:inline">{t("common.pagination.previous")}</span>
        </PaginationLink>
    )
}
PaginationPrevious.displayName = "PaginationPrevious"

const PaginationNext = ({
    className,
    ...props
}: React.ComponentProps<typeof PaginationLink>) => {
    const { t } = useTranslation()
    return (
        <PaginationLink
            aria-label={t("common.pagination.next")}
            size="default"
            className={cn("h-10 w-10 justify-center gap-0 px-0 sm:w-auto sm:justify-start sm:gap-1 sm:px-2.5", className)}
            {...props}
        >
            <span className="hidden sm:inline">{t("common.pagination.next")}</span>
            <ChevronRight className="h-5 w-5 rtl:rotate-180 sm:h-4 sm:w-4" />
        </PaginationLink>
    )
}
PaginationNext.displayName = "PaginationNext"

const PaginationEllipsis = ({
    className,
    ...props
}: React.ComponentProps<"span">) => {
    const { t } = useTranslation()
    return (
        <span
            aria-hidden
            className={cn("flex h-9 w-9 items-center justify-center", className)}
            {...props}
        >
            <MoreHorizontal className="h-4 w-4" />
            <span className="sr-only">{t("common.pagination.more")}</span>
        </span>
    )
}
PaginationEllipsis.displayName = "PaginationEllipsis"

export {
    Pagination,
    PaginationContent,
    PaginationEllipsis,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
}
