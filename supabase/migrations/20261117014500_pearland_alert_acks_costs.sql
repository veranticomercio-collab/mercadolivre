-- Alertas lidos (aplicado no projeto em 17/11/2026).
create table if not exists public.pearland_alert_acks (alert_key text primary key, acked_at timestamptz not null default now(), acked_by uuid);
alter table public.pearland_alert_acks enable row level security;
-- Dados: custo inicial de cada produto passou a valer desde 2026-01-01 (mesmo custo desde o começo;
-- só o Laser Tag mudou, em 12/11), conforme decisão do usuário em 16/11/2026.
