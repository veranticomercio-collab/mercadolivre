-- Frete efetivo por envio: cobrado no pagamento do Mercado Pago quando existe, senão o informado no envio.
create or replace view public.pearland_shipping_effective with (security_invoker = true) as
with charged as (
  select o.shipment_id, sum(coalesce(p.shipping_charge,0)) as charged
  from public.pearland_payments p join public.ml_orders_current o on o.order_id = p.order_id
  where o.shipment_id is not null and p.status in ('approved','in_mediation')
  group by o.shipment_id
)
select sc.shipment_id,
  case when c.charged > 0 then c.charged else sc.seller_cost end as seller_cost,
  sc.seller_cost as estimated_cost, c.charged as charged_cost,
  case when c.charged > 0 then 'cobrado' else 'estimado' end as source,
  sc.shipment_status, sc.logistic_type
from public.pearland_shipment_costs sc left join charged c on c.shipment_id = sc.shipment_id;
