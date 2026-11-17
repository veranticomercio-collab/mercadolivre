-- Conciliação com o Mercado Pago (aplicado no projeto em 17/11/2026).
create table if not exists public.pearland_payments (
  payment_id bigint primary key, order_id bigint, status text, status_detail text, date_approved timestamptz,
  money_release_date timestamptz, money_release_status text, transaction_amount numeric, total_paid numeric,
  net_received numeric, refunded numeric, ml_fee numeric, mp_fee numeric, shipping_charge numeric, coupon_ml numeric,
  other_charges numeric, charges_json jsonb, final boolean not null default false, synced_at timestamptz not null default now()
);
create index if not exists pearland_payments_order_idx on public.pearland_payments(order_id);
create index if not exists pearland_payments_release_idx on public.pearland_payments(money_release_date);
alter table public.pearland_payments enable row level security;
-- Views pearland_payments_overview (por pagamento) e pearland_reconciliation (por pacote) — ver definição no projeto.
-- cron: pearland-payments-sync-hourly '40 * * * *' {"days":75}
