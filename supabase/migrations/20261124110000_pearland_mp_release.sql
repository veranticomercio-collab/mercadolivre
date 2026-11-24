-- Saldo e extrato do Mercado Pago pelo relatório de liberações + faturas do ML (aplicado em 24/11/2026).
create table if not exists public.pearland_mp_release_files (
  file_name text primary key, begin_date timestamptz, end_date timestamptz, status text,
  initial_balance numeric, final_balance numeric, rows_count integer, processed_at timestamptz, raw_meta jsonb
);
create table if not exists public.pearland_mp_release_rows (
  id bigint generated always as identity primary key,
  file_name text not null references public.pearland_mp_release_files(file_name) on delete cascade,
  line_no integer not null, release_date timestamptz, source_id text, external_reference text, record_type text, description text,
  net_credit numeric, net_debit numeric, gross_amount numeric, mp_fee numeric, financing_fee numeric, shipping_fee numeric,
  taxes numeric, coupon numeric, payment_method text, order_id text, shipping_id text, pack_id text, raw jsonb,
  unique (file_name, line_no)
);
create index if not exists pearland_mp_release_rows_date on public.pearland_mp_release_rows(release_date);
create table if not exists public.pearland_mp_balance (as_of timestamptz primary key, available_balance numeric not null, file_name text, source text not null default 'release_report');
create table if not exists public.pearland_ml_billing (period_key text primary key, date_from date, date_to date, amount numeric, unpaid_amount numeric, period_status text, raw jsonb, synced_at timestamptz not null default now());
alter table public.pearland_mp_release_files enable row level security;
alter table public.pearland_mp_release_rows enable row level security;
alter table public.pearland_mp_balance enable row level security;
alter table public.pearland_ml_billing enable row level security;
-- crons: pearland-mp-release-cycle-3h '5 */3 * * *' {"action":"cycle"}; pearland-mp-release-fetch-hourly '35 * * * *' {"action":"fetch"}
-- Configuração única na conta MP: POST /v1/account/release_report/config (feita via action "config"; agendamento automático do MP desligado).
