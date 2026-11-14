import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2.57.0";
const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const headers={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,POST,OPTIONS","cache-control":"no-store"};
const reply=(v:unknown,s=200)=>Response.json(v,{status:s,headers});

async function loadInventory(){
 const pageSize=500;
 const inventory=[];
 for(let offset=0;;offset+=pageSize){
  const {data,error}=await db.from("pearland_inventory_history").select("*")
   .order("title").order("item_id").range(offset,offset+pageSize-1);
  if(error)return {data:null,error};
  inventory.push(...data);
  if(data.length<pageSize)return {data:inventory,error:null};
 }
}
Deno.serve(async req=>{
 if(req.method==="OPTIONS")return new Response(null,{headers});
 if(!["GET","POST"].includes(req.method))return reply({error:"method"},405);
 const jwt=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");
 const {data:{user},error}=await db.auth.getUser(jwt);
 if(error||!user)return reply({error:"login_required"},401);
 const {data:allowed}=await db.from("pearland_dashboard_users").select("user_id").eq("user_id",user.id).maybeSingle();
 if(!allowed)return reply({error:"access_not_granted"},403);
 if(req.method==="POST"){
  const body=await req.json().catch(()=>null);
  if(!body)return reply({error:"invalid_request"},400);
  if(body.action==="lookup_competitor"){
   const raw=String(body.url||"").trim().slice(0,1500);
   let u:URL;try{u=new URL(raw)}catch{return reply({error:"invalid_url"},400)}
   if(!/(^|\\.)mercadolivre\\.com\\.br$|(^|\\.)mercadolibre\\.com$/.test(u.hostname))return reply({error:"invalid_domain"},400);
   const match=(u.pathname+u.search).match(/(?:MLB[-_]?|item_id=MLB)(\\d{7,15})/i);
   if(!match)return reply({error:"item_id_not_found_use_full_link"},400);
   const itemId="MLB"+match[1];
   const {data:tokens}=await db.from("ml_oauth_tokens").select("access_token").limit(1);
   const token=tokens?.[0]?.access_token;
   if(!token)return reply({error:"ml_connection_unavailable"},503);
   const request=async(path:string)=>{const res=await fetch("https://api.mercadolibre.com"+path,{headers:{Authorization:"Bearer "+token},signal:AbortSignal.timeout(9000)});return {status:res.status,data:await res.json().catch(()=>null)}};
   try{
    const item=await request("/items/"+itemId);
    if(item.status!==200)return reply({error:"ml_listing_unavailable",http:item.status},422);
    const it=item.data||{};
    const cat=it.category_id?await request("/categories/"+encodeURIComponent(it.category_id)):null;
    const dims=it.shipping?.dimensions||it.dimensions||null;
    const fee=it.listing_type_id&&Number(it.price)>0?await request("/sites/MLB/listing_prices?price="+encodeURIComponent(String(it.price))+"&listing_type_id="+encodeURIComponent(it.listing_type_id)+"&category_id="+encodeURIComponent(it.category_id||"")):null;
    const feeObj=Array.isArray(fee?.data)?fee?.data[0]:fee?.data;
    return reply({item_id:itemId,title:it.title||"",category_id:it.category_id||null,category_name:cat?.status===200?cat.data?.name:null,price:it.price||null,listing_type:it.listing_type_id||null,shipping_dimensions:dims,shipping_mode:it.shipping?.mode||null,free_shipping:it.shipping?.free_shipping??null,fee_amount:fee?.status===200&&Number.isFinite(Number(feeObj?.sale_fee_amount))?Number(feeObj.sale_fee_amount):null,fee_source:fee?.status===200?"mercado_livre_api":"unavailable"});
   }catch{return reply({error:"ml_lookup_failed"},502)}
  }
  if(body.action==="save_pricing_category"){
   const name=String(body.name||"").trim().slice(0,90),fee=body.fee_pct;
   if(!name||typeof fee!=="number"||!Number.isFinite(fee)||fee<0||fee>100)return reply({error:"invalid_category"},400);
   const {error:e}=await db.from("pearland_pricing_categories").upsert({name,fee_pct:fee},{onConflict:"name"});
   return e?reply({error:"save_failed"},500):reply({ok:true});
  }
  if(body.action==="save_shipping_band"){
   const name=String(body.name||"").trim(),amount=body.estimated_cost;
   if(!["Mínimo","Leve","Médio","Pesado","Superpesado"].includes(name)||typeof amount!=="number"||!Number.isFinite(amount)||amount<0||amount>100000)return reply({error:"invalid_shipping"},400);
   const {error:e}=await db.from("pearland_shipping_bands").update({estimated_cost:amount}).eq("name",name);
   return e?reply({error:"save_failed"},500):reply({ok:true});
  }
  if(body.action==="save_item_pricing_category"){
   const item_id=String(body.item_id||""),category_id=Number(body.category_id);
   if(!item_id||!Number.isInteger(category_id))return reply({error:"invalid_request"},400);
   const [{data:item},{data:category}]=await Promise.all([db.from("ml_items_current").select("item_id").eq("item_id",item_id).maybeSingle(),db.from("pearland_pricing_categories").select("id").eq("id",category_id).maybeSingle()]);
   if(!item||!category)return reply({error:"unknown_item_or_category"},404);
   const {error:e}=await db.from("pearland_item_pricing_categories").upsert({item_id,category_id},{onConflict:"item_id"});
   return e?reply({error:"save_failed"},500):reply({ok:true});
  }
  if(body.action==="save_expense"){
   const category=String(body.category||"").trim().slice(0,90),effective_date=body.effective_date,amount=body.monthly_amount;
   const today=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
   if(!category||typeof effective_date!=="string"||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(effective_date)||Number.isNaN(Date.parse(effective_date+"T12:00:00Z"))||effective_date<today||typeof amount!=="number"||!Number.isFinite(amount)||amount<0||amount>10000000)return reply({error:"invalid_expense"},400);
   const {error:e}=await db.from("pearland_operating_expenses").upsert({category,effective_date,monthly_amount:amount,created_by:user.id},{onConflict:"category,effective_date"});
   return e?reply({error:"save_failed"},500):reply({ok:true});
  }
  if(body.action==="save_tax"||body.action==="save_cost"){
   const effective=body.effective_date;
   if(typeof effective!=="string"||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(effective)||Number.isNaN(Date.parse(effective+"T12:00:00Z")))return reply({error:"invalid_date"},400);
   const today=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
   if(effective<today)return reply({error:"past_date_not_allowed"},400);
   const amount=body.action==="save_tax"?body.tax_pct:body.unit_cost;
   if(typeof amount!=="number"||!Number.isFinite(amount)||amount<0||amount>(body.action==="save_tax"?100:1000000))return reply({error:"invalid_values"},400);
   if(body.action==="save_tax"){
    const {error:e}=await db.from("pearland_financial_rates").upsert({effective_date:effective,tax_pct:amount,created_by:user.id},{onConflict:"effective_date"});
    return e?reply({error:"save_failed"},500):reply({ok:true});
   }
   if(typeof body.item_id!=="string")return reply({error:"invalid_request"},400);
   const {data:exists}=await db.from("ml_items_current").select("item_id").eq("item_id",body.item_id).maybeSingle();
   if(!exists)return reply({error:"unknown_item"},404);
   const {error:e}=await db.from("pearland_sku_cost_history").upsert({item_id:body.item_id,effective_date:effective,unit_cost:amount,created_by:user.id},{onConflict:"item_id,effective_date"});
   if(e)return reply({error:"save_failed"},500);
   if(effective===today)await db.from("pearland_sku_settings").upsert({item_id:body.item_id,unit_cost:amount,updated_by:user.id,updated_at:new Date().toISOString()},{onConflict:"item_id"});
   return reply({ok:true});
  }
  if(body.action!=="save_sku"||typeof body.item_id!=="string")return reply({error:"invalid_request"},400);
  const {data:existing}=await db.from("ml_items_current").select("item_id").eq("item_id",body.item_id).maybeSingle();
  if(!existing)return reply({error:"unknown_item"},404);
  const n=(v:unknown,max:number,integer=false)=>v===null||v===""?null:typeof v==="number"&&Number.isFinite(v)&&v>=0&&v<=max&&(!integer||Number.isInteger(v))?v:undefined;
  const cost=n(body.unit_cost,1000000),lead=n(body.lead_days,180,true),safety=n(body.safety_days,90,true),physical=n(body.physical_count,1000000,true);
  if([cost,lead,safety,physical].some(v=>v===undefined)||lead===null||safety===null)return reply({error:"invalid_values"},400);
  const {error:e}=await db.from("pearland_sku_settings").upsert({item_id:body.item_id,lead_days:lead,safety_days:safety,physical_count:physical,physical_counted_at:physical===null?null:new Date().toISOString(),updated_by:user.id,updated_at:new Date().toISOString()},{onConflict:"item_id"});
  
  return e?reply({error:"save_failed"},500):reply({ok:true});
 }
 const {data:orders,error:oe}=await db.from("ml_orders_current").select("order_id,shipment_id,date_created,status,item_ids,item_titles,quantities,paid_amount,order_json,synced_at").order("date_created",{ascending:false}).limit(1000);
 if(oe)return reply({error:"orders_unavailable"},503);
 const shipments=[...new Set((orders||[]).map(o=>o.shipment_id).filter(Boolean))];
 const [{data:jobs},{data:queue},{data:items,error:inventoryError},{data:settings},{data:shipStatuses}]=await Promise.all([
  db.from("pearland_print_jobs").select("shipment_id,status,spooled_at,confirmed_at,created_at").in("shipment_id",shipments.length?shipments:[0]),
  db.from("ml_fulfillment_queue").select("shipment_id,invoice_status,processing_status").in("shipment_id",shipments.length?shipments:[0]),
  loadInventory(),
  db.from("pearland_sku_settings").select("item_id,unit_cost,lead_days,safety_days,physical_count,physical_counted_at"),
  db.from("pearland_shipment_status").select("shipment_id,status,substatus,dispatched_at,first_observed_dispatched_at,schedule_json")
 ]);
 if(inventoryError)return reply({error:"inventory_unavailable"},503);
 const jm=new Map((jobs||[]).map(j=>[String(j.shipment_id),j]));
 const qm=new Map((queue||[]).map(q=>[String(q.shipment_id),q]));
 const sm=new Map((shipStatuses||[]).map(x=>[String(x.shipment_id),x]));
 const [{data:taxRates},{data:costHistory},{data:financial},{data:ads},{data:expenses},{data:pricingCategories},{data:shippingBands},{data:itemPricingCategories}]=await Promise.all([
  db.from("pearland_financial_rates").select("effective_date,tax_pct").order("effective_date"),
  db.from("pearland_sku_cost_history").select("item_id,effective_date,unit_cost").order("effective_date"),
  db.from("ml_order_financial_observed").select("order_id,item_id,quantity,sale_fee_reported,sale_fee_if_per_unit,shipping_cost_raw").limit(5000),
  db.from("ml_ads_campaigns_daily").select("metric_date,cost,clicks,total_amount").order("metric_date",{ascending:false}).limit(3000),
  db.from("pearland_operating_expenses").select("category,effective_date,monthly_amount").order("effective_date"),
  db.from("pearland_pricing_categories").select("id,name,fee_pct").order("name"),
  db.from("pearland_shipping_bands").select("name,min_weight_kg,max_weight_kg,estimated_cost,sort_order").order("sort_order"),
  db.from("pearland_item_pricing_categories").select("item_id,category_id")
 ]);
 const fm=new Map<string,any[]>();
 for(const f of financial||[]){const k=String(f.order_id);fm.set(k,[...(fm.get(k)||[]),f]);}
 const rows=(orders||[]).map(o=>{
  const buyer=o.order_json?.buyer||{},shipment=o.order_json?.shipping||{};
  const name=[buyer.first_name,buyer.last_name].filter(v=>typeof v==="string").join(" ");
  const j=jm.get(String(o.shipment_id)),q=qm.get(String(o.shipment_id));
  return {order_id:String(o.order_id),shipment_id:o.shipment_id?String(o.shipment_id):null,date_created:o.date_created,status:o.status,buyer_name:name||null,buyer_nickname:buyer.nickname||null,items:(o.item_titles||[]).map((title:string,i:number)=>({title,item_id:String(o.item_ids?.[i]||""),quantity:Number(o.quantities?.[i]||1)})),paid_amount:Number(o.paid_amount||0),invoice_status:q?.invoice_status||"unknown",print_status:j?.status||"not_queued",printed_at:j?.confirmed_at||j?.spooled_at||null,shipment_status:sm.get(String(o.shipment_id))?.status||shipment.status||null,shipment_substatus:sm.get(String(o.shipment_id))?.substatus||null,dispatched_at:sm.get(String(o.shipment_id))?.dispatched_at||null,first_observed_dispatched_at:sm.get(String(o.shipment_id))?.first_observed_dispatched_at||null,label_release_date:sm.get(String(o.shipment_id))?.schedule_json?.shipping_option?.buffering?.date||null,order_synced_at:o.synced_at,financial_lines:fm.get(String(o.order_id))||[]};
 });
 return reply({updated_at:new Date().toISOString(),orders:rows,inventory:items,sku_settings:settings||[],tax_rates:taxRates||[],cost_history:costHistory||[],ads_daily:ads||[],operating_expenses:expenses||[],pricing_categories:pricingCategories||[],shipping_bands:shippingBands||[],item_pricing_categories:itemPricingCategories||[]});
});
