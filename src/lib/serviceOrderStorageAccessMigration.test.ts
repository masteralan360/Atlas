import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationSql = readFileSync(
    new URL('../../supabase/migrations/20260918090000_skip_service_lines_in_order_storage_access.sql', import.meta.url),
    'utf8'
)

describe('service order storage-access migration', () => {
    it('checks whether the product is a service before casting an order-line storage value to UUID', () => {
        expect(migrationSql).toContain("SELECT COALESCE(product.is_service, false)")
        expect(migrationSql).toContain('IF COALESCE(item_is_service, false) THEN')
        expect(migrationSql).toContain("item_storage_value = '__atlas_services__'")
        expect(migrationSql.indexOf('IF COALESCE(item_is_service, false) THEN'))
            .toBeLessThan(migrationSql.indexOf("NULLIF(item_storage_value, '')::uuid"))
    })
})
