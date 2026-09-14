import { describe, expect, it, vi } from 'vitest'

vi.mock('./generic/GenericStorefrontTemplate', () => ({
    genericStorefrontTemplate: {
        id: 'generic',
        label: 'Generic storefront',
        ShopPage: () => null,
        ContactPage: () => null
    }
}))

vi.mock('./barbados/BarbadosStorefrontTemplate', () => ({
    barbadosStorefrontTemplate: {
        id: 'barbados',
        label: 'Barbados menu',
        ShopPage: () => null,
        ContactPage: () => null
    }
}))

vi.mock('./pos/PosStorefrontTemplate', () => ({
    posStorefrontTemplate: {
        id: 'pos',
        label: 'POS storefront',
        ShopPage: () => null,
        ContactPage: () => null
    }
}))

import {
    DEFAULT_STOREFRONT_TEMPLATE_ID,
    getEffectiveStorefrontRules,
    getStorefrontTemplateForSlug,
    getWorkspaceStorefrontRules,
    storefrontTemplates
} from './registry'

describe('getStorefrontTemplateForSlug', () => {
    it('uses the generic template for an unassigned slug', () => {
        const resolved = getStorefrontTemplateForSlug('new-store')

        expect(resolved.template).toBe(storefrontTemplates[DEFAULT_STOREFRONT_TEMPLATE_ID])
        expect(resolved.options).toEqual({})
        expect(resolved.rules).toEqual({})
    })

    it('normalizes an unassigned slug before falling back', () => {
        const resolved = getStorefrontTemplateForSlug('  NEW-STORE  ')

        expect(resolved.template.id).toBe(DEFAULT_STOREFRONT_TEMPLATE_ID)
    })

    it('selects the Barbados menu template for its hard-coded storefront slug', () => {
        const resolved = getStorefrontTemplateForSlug('  BARBADOS ')

        expect(resolved.template.id).toBe('barbados')
        expect(resolved.options).toEqual({})
        expect(resolved.rules).toEqual({})
    })

    it('selects the POS storefront template for the shayan slug', () => {
        const resolved = getStorefrontTemplateForSlug(' shayan ')

        expect(resolved.template.id).toBe('pos')
        expect(resolved.options).toEqual({})
        expect(resolved.rules).toEqual({})
    })

    it('selects the POS storefront template for the shayan-jumla slug', () => {
        const resolved = getStorefrontTemplateForSlug(' shayan-jumla ')

        expect(resolved.template.id).toBe('pos')
        expect(resolved.options).toEqual({})
        expect(resolved.rules).toEqual({})
    })

    it('resolves hard-coded storefront rules for a slug', () => {
        const resolved = getStorefrontTemplateForSlug('K1-PAINT')

        expect(resolved.template.id).toBe('generic')
        expect(resolved.rules).toEqual({ hidePrice: true, hideAddToCart: true })
    })

    it('applies the custom checkout and layout rules only to the configured workspace', () => {
        expect(getWorkspaceStorefrontRules('0B342F6C-BCDC-45A9-BCDA-9D21360FF3C9')).toEqual({
            hideCheckoutEmail: true,
            hideFilters: true
        })
        expect(getWorkspaceStorefrontRules('another-workspace')).toEqual({})
    })

    it('keeps assigned storefront rules while adding the workspace-specific rules', () => {
        expect(getEffectiveStorefrontRules(
            { hidePrice: true },
            '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'
        )).toEqual({
            hidePrice: true,
            hideCheckoutEmail: true,
            hideFilters: true
        })
    })
})
