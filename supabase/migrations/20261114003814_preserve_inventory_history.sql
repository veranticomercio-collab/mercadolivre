-- Keep listing IDs as the durable inventory identity, including listings
-- that are only present in previously imported paid orders.
create function public.pearland_keep_order_items_in_stock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'paid' then
    insert into public.ml_items_current (
      item_id, user_id, title, status, available_quantity, item_json, synced_at
    )
    select i.item_id, new.user_id, coalesce(nullif(i.title, ''), i.item_id),
           'historical', 0, '{}'::jsonb, coalesce(new.synced_at, now())
    from unnest(new.item_ids, new.item_titles) as i(item_id, title)
    where nullif(i.item_id, '') is not null
    on conflict (item_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger pearland_keep_order_items_in_stock
after insert or update of status, item_ids, item_titles on public.ml_orders_current
for each row execute function public.pearland_keep_order_items_in_stock();

insert into public.ml_items_current (
  item_id, user_id, title, status, available_quantity, item_json, synced_at
)
select distinct on (i.item_id)
       i.item_id, o.user_id, coalesce(nullif(i.title, ''), i.item_id),
       'historical', 0, '{}'::jsonb, coalesce(o.synced_at, now())
from public.ml_orders_current o
cross join lateral unnest(o.item_ids, o.item_titles) as i(item_id, title)
where o.status = 'paid' and nullif(i.item_id, '') is not null
order by i.item_id, o.date_created desc nulls last, o.order_id desc
on conflict (item_id) do nothing;

create function public.pearland_prevent_inventory_removal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Os produtos devem permanecer no histórico do estoque.'
    using errcode = '23514';
end;
$$;

create trigger pearland_prevent_inventory_removal
before delete or truncate on public.ml_items_current
for each statement execute function public.pearland_prevent_inventory_removal();

create view public.pearland_inventory_history with (security_invoker = true) as
with paid_sales as (
  select i.item_id, sum(coalesce(i.quantity, 1)) as recorded_units
  from public.ml_orders_current o
  cross join lateral unnest(o.item_ids, o.quantities) as i(item_id, quantity)
  where o.status = 'paid' and nullif(i.item_id, '') is not null
  group by i.item_id
)
select m.item_id, coalesce(nullif(m.title, ''), m.item_id) as title, m.status,
       case when m.status in ('historical', 'closed', 'deleted', 'inactive')
            then 0 else coalesce(m.available_quantity, 0) end as available_quantity,
       m.price, m.synced_at,
       coalesce(m.item_json #>> '{pictures,0,secure_url}',
                m.item_json #>> '{pictures,0,url}',
                m.item_json ->> 'thumbnail') as thumbnail,
       m.sold_quantity, coalesce(s.recorded_units, 0) as recorded_units
from public.ml_items_current m
left join paid_sales s on s.item_id = m.item_id;

revoke all on public.pearland_inventory_history from public, anon, authenticated;
grant select on public.pearland_inventory_history to service_role;
revoke execute on function public.pearland_keep_order_items_in_stock() from public, anon, authenticated;
revoke execute on function public.pearland_prevent_inventory_removal() from public, anon, authenticated;
