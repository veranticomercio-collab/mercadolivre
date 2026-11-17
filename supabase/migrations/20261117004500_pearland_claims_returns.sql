-- Devoluções, motivos de reclamação e visão consolidada (aplicado no projeto em 17/11/2026).
create table if not exists public.pearland_returns (
  claim_id bigint primary key, order_id bigint, return_id bigint, status text, subtype text, refund_at text,
  shipment_status text, return_shipment_id bigint, return_cost numeric, return_costs_json jsonb, return_json jsonb,
  synced_at timestamptz not null default now()
);
alter table public.pearland_returns enable row level security;
create table if not exists public.pearland_claim_reasons (reason_id text primary key, name text, detail text, reason_json jsonb, synced_at timestamptz not null default now());
alter table public.pearland_claim_reasons enable row level security;
create or replace view public.pearland_claims_overview with (security_invoker = true) as
select c.claim_id, c.order_id, c.type, c.stage, c.status, c.reason_id,
  coalesce(rs.detail, rs.name, c.reason_id) as reason_label, rs.name as reason_code,
  c.date_created, c.last_updated,
  c.claim_json->'resolution'->>'reason' as resolution, c.claim_json->'resolution'->'benefited' as benefited,
  o.status as order_status, o.total_amount, o.item_ids, o.item_titles, o.quantities, o.shipment_id,
  o.order_json->'payments'->0->>'status' as payment_status,
  nullif(o.order_json->'payments'->0->>'transaction_amount_refunded','')::numeric as refunded_amount,
  sc.seller_cost as outbound_shipping_cost, sc.shipment_status as outbound_shipment_status,
  r.status as return_status, r.subtype as return_subtype, r.return_cost, r.shipment_status as return_shipment_status
from public.ml_claims_current c
left join public.ml_orders_current o on o.order_id = c.order_id
left join public.pearland_returns r on r.claim_id = c.claim_id
left join public.pearland_claim_reasons rs on rs.reason_id = c.reason_id
left join public.pearland_shipment_costs sc on sc.shipment_id = o.shipment_id;
-- cron: pearland-claims-sync-hourly '10 * * * *'
