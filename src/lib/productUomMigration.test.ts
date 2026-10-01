import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const localDatabasePath = fileURLToPath(new URL('../../src/local-db/database.ts', import.meta.url))
const stageOnePath = fileURLToPath(new URL(
  '../../supabase/migrations/20260929180000_product_uoms_stage1_backfill.sql',
  import.meta.url,
))
const stageTwoPath = fileURLToPath(new URL(
  '../../supabase/migrations/20260930005105_product_uoms_transaction_validation.sql',
  import.meta.url,
))
const purchaseReceiptRoundingPath = fileURLToPath(new URL(
  '../../supabase/migrations/20261001130000_fix_purchase_received_quantity_rounding.sql',
  import.meta.url,
))
const stageOneSql = readFileSync(stageOnePath, 'utf8')
const stageTwoSql = readFileSync(stageTwoPath, 'utf8')
const purchaseReceiptRoundingSql = readFileSync(purchaseReceiptRoundingPath, 'utf8')
const localDatabaseSource = readFileSync(localDatabasePath, 'utf8')

describe('product UoM migration stages', () => {
  it('adds and backfills the product UoM model without dropping legacy data', () => {
    expect(stageOneSql).toContain('CREATE TABLE IF NOT EXISTS public.product_uoms')
    expect(stageOneSql).toContain('conversion.factor')
    expect(stageOneSql).toContain('relationship.parent_unit_ref')
    expect(stageOneSql).toContain('conversion.parent_price')
    expect(stageOneSql).toContain('WHERE NOT product.is_service')
    expect(stageOneSql).toContain('conversion.factor <> 1')
    expect(stageOneSql).toContain('product.price, product.cost_price, product.minimum_selling_price')
    expect(stageOneSql).toContain('ON CONFLICT (product_id, unit_ref) DO NOTHING')
    expect(stageOneSql).toContain('ADD COLUMN IF NOT EXISTS selling_uom_id')
    expect(stageOneSql).toContain('An active product must have exactly one active base UoM')
    expect(stageOneSql).not.toContain('SET uom_cost_price = cost_price')
    expect(stageOneSql).toContain('product_uoms_non_base_coefficient_not_one')
    expect(stageOneSql).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i)
    expect(stageOneSql).toContain('FROM public.product_unit_conversions')
    expect(stageOneSql).toContain('JOIN public.unit_relationships')
  })

  it('validates immutable transaction snapshots and converts Quick Order stock in base units', () => {
    expect(stageTwoSql).toContain('CREATE OR REPLACE FUNCTION public.validate_sale_item_unit_snapshot()')
    expect(stageTwoSql).toContain('NEW.inventory_quantity IS DISTINCT FROM round(NEW.quantity * NEW.unit_factor, 6)')
    expect(stageTwoSql).toContain('Order item inventory quantity must equal quantity times UoM coefficient')
    expect(stageTwoSql).toContain('v_required_quantity := round((')
    expect(stageTwoSql).toContain('IF v_product.is_service THEN')
    expect(stageTwoSql).toContain(') * v_unit_factor, 6);')
    expect(stageTwoSql).toContain("pending_item->>''unitFactor''")
    expect(stageTwoSql).toContain('v_original_cost_total / (v_required_quantity / v_unit_factor)')
    expect(stageTwoSql).not.toMatch(/RAISE EXCEPTION[^;]*quick_order_related_units_unsupported/i)
  })

  it('validates purchase receipts against separately rounded paid and free base quantities', () => {
    expect(purchaseReceiptRoundingSql).toContain('v_inventory_quantity, round(v_quantity * v_factor, 6)')
    expect(purchaseReceiptRoundingSql).toContain('+ v_free_inventory_quantity, 6)')
    expect(purchaseReceiptRoundingSql).toContain("new_expression text := 'round(v_received_quantity, 6) IS DISTINCT FROM round(COALESCE(v_inventory_quantity, round(v_quantity * v_factor, 6)) + v_free_inventory_quantity, 6)'")
  })

  it('allows renaming a custom base unit without reinterpreting its historical stock', () => {
    expect(stageOneSql).toContain("base_uom.unit_ref = 'custom:' || base_unit.id::text")
    expect(stageOneSql).toContain('lower(btrim(base_unit.code)) = lower(btrim(NEW.unit))')
    expect(stageOneSql).toContain("RAISE EXCEPTION 'product_uom_base_change_has_history'")
    expect(stageOneSql).toMatch(/FUNCTION public\.guard_product_base_uom_change\(\)[\s\S]*?SECURITY DEFINER/)
  })

  it('backfills only inventory products in IndexedDB and archives legacy coefficient-one conversions', () => {
    expect(localDatabaseSource).toContain('if (!product.workspaceId || !product.unit || product.isService) continue')
    expect(localDatabaseSource).toContain('if (!product || product.isService || !relationship || relationship.isDeleted) continue')
    expect(localDatabaseSource).toContain('isActive: conversion.factor !== 1 && !relationship.isArchived && !product.isDeleted')
  })
})
