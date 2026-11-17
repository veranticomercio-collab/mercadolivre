-- Simulador de promoções (aplicado no projeto em 17/11/2026): views pearland_item_economics e
-- pearland_promotions_open (somente a leitura mais recente por anúncio) e log pearland_promotion_actions.
create table if not exists public.pearland_promotion_actions (
  id bigint generated always as identity primary key, created_at timestamptz not null default now(), user_id uuid,
  item_id text not null, promotion_id text, promotion_type text not null, deal_price numeric, stock integer,
  request_json jsonb, http_status integer, response_json jsonb
);
alter table public.pearland_promotion_actions enable row level security;
