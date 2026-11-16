-- Custo real de frete por envio (lido do ML) + agendamentos de frete e Ads do dia.
create table if not exists public.pearland_shipment_costs (
  shipment_id bigint primary key,
  logistic_type text,
  mode text,
  seller_cost numeric,
  seller_compensation numeric,
  receiver_cost numeric,
  list_cost numeric,
  shipment_status text,
  costs_json jsonb,
  shipment_json jsonb,
  final boolean not null default false,
  synced_at timestamptz not null default now()
);
comment on table public.pearland_shipment_costs is 'Custo real de frete por envio, lido de /shipments/{id} e /shipments/{id}/costs do Mercado Livre. seller_cost = valor cobrado do vendedor.';
alter table public.pearland_shipment_costs enable row level security;

-- Agendamentos (aplicados direto no projeto via cron.schedule):
-- pearland-shipping-costs-30min  '20,50 * * * *'  -> pearland-shipping-costs {"days":4}
-- mercadolivre-ads-today-hourly  '25 * * * *'     -> mercadolivre-ads-daily {"days_back":[0]}
