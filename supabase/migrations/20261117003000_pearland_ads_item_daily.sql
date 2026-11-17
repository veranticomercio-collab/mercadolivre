-- Ads por anúncio e dia (só a leitura mais recente de cada dia). Grupos FAMILY ligados pelo family_id.
create or replace view public.pearland_ads_item_daily with (security_invoker = true) as
with latest as (
  select metric_date, max(synced_at) as last_sync from public.ml_ads_adgroups_daily group by metric_date
), mapped as (
  select a.metric_date, a.cost, a.total_amount, a.units_quantity, a.clicks,
    case when a.item_id is not null then array[a.item_id]
         else coalesce((select array_agg(m.item_id order by m.item_id) from public.ml_items_current m
                        where m.item_json->>'family_id' = a.adgroup_json->>'ad_group_external_id'), array[null::text])
    end as items
  from public.ml_ads_adgroups_daily a
  join latest l on l.metric_date = a.metric_date and a.synced_at >= l.last_sync - interval '15 minutes'
)
select metric_date, i.item_id,
  round(sum(coalesce(cost,0)/cardinality(items)),2) as cost,
  round(sum(coalesce(total_amount,0)/cardinality(items)),2) as ads_amount,
  round(sum(coalesce(units_quantity,0)::numeric/cardinality(items)),2) as ads_units,
  round(sum(coalesce(clicks,0)::numeric/cardinality(items)),2) as clicks
from mapped cross join lateral unnest(items) as i(item_id)
group by metric_date, i.item_id;
