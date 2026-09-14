import type { ComponentType } from 'react'

/**
 * Static, per-store presentation values. Keep these code-owned for V1; they
 * let a later template vary by slug without moving storefront layout into the
 * database.
 */
export type StorefrontTemplateOptions = Readonly<Record<string, string | number | boolean | null>>

/**
 * Code-owned switches that can be assigned to any storefront slug. Add new
 * rules here first, then implement their UI behavior in the relevant template.
 */
export const storefrontRuleKeys = [
    'hidePrice',
    'hideAddToCart',
    'hideCheckoutEmail',
    'hideFilters'
] as const

export type StorefrontRuleKey = typeof storefrontRuleKeys[number]

export type StorefrontRules = Readonly<Partial<Record<StorefrontRuleKey, boolean>>>

export type StorefrontTemplatePageProps = {
    slug: string
    options: StorefrontTemplateOptions
    rules: StorefrontRules
}

/**
 * A storefront template owns all public storefront surfaces. Business data and
 * operations continue to come from the shared marketplace hooks and API.
 */
export type StorefrontTemplate = {
    id: string
    label: string
    ShopPage: ComponentType<StorefrontTemplatePageProps>
    ContactPage: ComponentType<StorefrontTemplatePageProps>
}
