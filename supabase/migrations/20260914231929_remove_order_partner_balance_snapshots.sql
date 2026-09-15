begin;

drop trigger if exists sales_orders_partner_balance_snapshot_immutable
  on crm.sales_orders;
drop trigger if exists purchase_orders_partner_balance_snapshot_immutable
  on crm.purchase_orders;
drop function if exists crm.prevent_order_partner_balance_snapshot_change();

alter table crm.sales_orders
  drop column if exists partner_balance_snapshot;
alter table crm.purchase_orders
  drop column if exists partner_balance_snapshot;

commit;
