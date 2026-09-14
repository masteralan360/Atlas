import { barbadosStorefrontTemplate } from './barbados/BarbadosStorefrontTemplate'
import { genericStorefrontTemplate } from './generic/GenericStorefrontTemplate'
import { posStorefrontTemplate } from './pos/PosStorefrontTemplate'
import type { StorefrontRules, StorefrontTemplate, StorefrontTemplateOptions } from './types'

export {
    getEffectiveStorefrontRules,
    getWorkspaceStorefrontRules,
    workspaceStorefrontRules
} from './rules'

export const DEFAULT_STOREFRONT_TEMPLATE_ID = 'generic' as const

/**
 * Add a new code-owned storefront design here. Each design supplies every
 * public storefront page, while shared hooks and APIs preserve commerce logic.
 */
export const storefrontTemplates = {
    barbados: barbadosStorefrontTemplate,
    generic: genericStorefrontTemplate,
    pos: posStorefrontTemplate
} satisfies Record<string, StorefrontTemplate>

export type StorefrontTemplateId = keyof typeof storefrontTemplates

export type StorefrontTemplateAssignment = {
    templateId: StorefrontTemplateId
    options?: StorefrontTemplateOptions
    rules?: StorefrontRules
}

/**
 * V1 storefront source of truth. Add lower-case store slugs here. Each entry
 * can choose a template plus simple presentation rules, for example:
 *
 * 'acme-baghdad': {
 *     templateId: 'generic',
 *     rules: { hidePrice: true, hideAddToCart: true }
 * }
 * 
 * 
 */
export const storefrontTemplateAssignments: Readonly<Record<string, StorefrontTemplateAssignment>> = {
    'k1-paint': {
        templateId: 'generic',
        rules: { hidePrice: true, hideAddToCart: true }
    },
    barbados: { templateId: 'barbados' },
    shayan: { templateId: 'pos' },
    'shayan-jumla': { templateId: 'pos' }
}

export type ResolvedStorefrontTemplate = {
    template: StorefrontTemplate
    options: StorefrontTemplateOptions
    rules: StorefrontRules
}

function normalizeStoreSlug(slug: string) {
    return slug.trim().toLowerCase()
}

/**
 * Resolves a URL slug entirely from code. Unknown or unassigned slugs always
 * render the current generic storefront to preserve existing public URLs.
 */
export function getStorefrontTemplateForSlug(slug: string): ResolvedStorefrontTemplate {
    const assignment = storefrontTemplateAssignments[normalizeStoreSlug(slug)]
    const template = assignment
        ? storefrontTemplates[assignment.templateId]
        : storefrontTemplates[DEFAULT_STOREFRONT_TEMPLATE_ID]

    return {
        template,
        options: assignment?.options ?? {},
        rules: assignment?.rules ?? {}
    }
}
