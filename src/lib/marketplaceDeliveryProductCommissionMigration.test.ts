import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationSql = readFileSync(
  new URL('../../supabase/migrations/20260915024040_add_marketplace_delivery_product_commissions.sql', import.meta.url),
  'utf8',
)

describe('marketplace delivery product commission migration', () => {
  it('adds a server-derived, product-only delivery assignment source', () => {
    expect(migrationSql).toContain("'marketplace_delivery_product'")
    expect(migrationSql).toContain("PERFORM set_config('atlas.ensuring_marketplace_delivery_product_commission', 'on', true)")
    expect(migrationSql).toContain("NEW.assignment_source = ''marketplace_delivery_product''")
    expect(migrationSql).toContain("OR v_marketplace_order.status <> 'delivered'")
    expect(migrationSql).toContain('v_marketplace_order.delivered_by IS NULL')
    expect(migrationSql).toContain('agent.linked_user_id = v_marketplace_order.delivered_by')
  })

  it('requires a qualifying rule, without requiring the marketplace buyer to have paid', () => {
    expect(migrationSql).toContain("active_rule.recipient_scope = 'all_assigned'")
    expect(migrationSql).toContain('FROM crm.product_commission_rule_agents AS recipient')
    const helperStart = migrationSql.indexOf('CREATE OR REPLACE FUNCTION private.ensure_marketplace_delivery_product_commission_assignment')
    const helperEnd = migrationSql.indexOf('-- Insert the new derived assignment', helperStart)
    const helperSql = migrationSql.slice(helperStart, helperEnd)
    expect(helperSql).not.toContain('v_order.is_paid')
    expect(helperSql).not.toContain("v_order.payment_status = 'paid'")
  })

  it('excludes delivery assignments from whole-order plans and reconciles while delivery commits', () => {
    expect(migrationSql).toContain("NOT IN (''order_creator_product'', ''marketplace_delivery_product'')")
    expect(migrationSql).toContain('private.ensure_marketplace_delivery_product_commission_assignment(p_order_id)')
    expect(migrationSql).toContain('PERFORM public.reconcile_sales_agent_commission(v_sales_order_id, NULL)')
    expect(migrationSql).toContain("v_return_anchor text := E'  RETURN jsonb_build_object(\\n'")
    expect(migrationSql).toContain('strpos(reverse(v_definition), reverse(v_return_anchor))')
    expect(migrationSql).toContain('workspace.plan::text')
    expect(migrationSql).toContain("''sales_agent_commissions''")
  })
})
