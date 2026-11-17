import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import{createClient}from"npm:@supabase/supabase-js@2.57.0";
const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
// Busca no ML todos os anúncios do vendedor (ativos e pausados) para cadastrar anúncios novos automaticamente.
async function discoverItemIds(userId:string|number,token:string):Promise<{ids:string[];ok:boolean}>{
 const found=new Set<string>();let ok=true;
 for(const status of ["active","paused","under_review"]){
  let scrollId:string|null=null;
  for(let page=0;page<50;page++){
   const qs=new URLSearchParams({search_type:"scan",limit:"100",status});if(scrollId)qs.set("scroll_id",scrollId);
   const r=await fetch("https://api.mercadolibre.com/users/"+userId+"/items/search?"+qs,{headers:{authorization:"Bearer "+token}});
   if(!r.ok){ok=false;await r.body?.cancel();break}
   const j=await r.json();const res:string[]=Array.isArray(j.results)?j.results:[];
   res.forEach(id=>found.add(id));scrollId=j.scroll_id||null;
   if(!res.length||!scrollId)break;
  }
 }
 return {ids:[...found],ok};
}
Deno.serve(async req=>{
 if(req.method!=="POST")return Response.json({error:"method"},{status:405});
 try{
 const{data:rows,error}=await db.from("ml_oauth_tokens").select("*").order("updated_at",{ascending:false}).limit(1);
 if(error||!rows?.length)throw Error("ML token unavailable");
 let t=rows[0];
 if(new Date(t.expires_at).getTime()<Date.now()+300000){
 const res=await fetch("https://api.mercadolibre.com/oauth/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",client_id:Deno.env.get("MELI_CLIENT_ID")!,client_secret:Deno.env.get("MELI_CLIENT_SECRET")!,refresh_token:t.refresh_token})});
 if(!res.ok)throw Error("ML token refresh failed");
 const d=await res.json();const expires_at=new Date(Date.now()+Number(d.expires_in||21600)*1000).toISOString();
 const{error:e}=await db.from("ml_oauth_tokens").update({access_token:d.access_token,refresh_token:d.refresh_token,expires_at,expires_in:d.expires_in,updated_at:new Date().toISOString()}).eq("user_id",t.user_id);
 if(e)throw e;t={...t,access_token:d.access_token};
 }
 const{data:items,error:ie}=await db.from("ml_items_current").select("item_id").limit(5000);
 if(ie)throw ie;
 const known=new Set((items||[]).map(x=>x.item_id));
 const discovery=await discoverItemIds(t.user_id,t.access_token);
 const newIds=discovery.ids.filter(id=>!known.has(id));
 const allIds=[...known,...newIds];
 let saved=0,failed=0;
 for(let i=0;i<allIds.length;i+=20){
 const ids=allIds.slice(i,i+20);
 const res=await fetch("https://api.mercadolibre.com/items?ids="+ids.map(encodeURIComponent).join(","),{headers:{authorization:"Bearer "+t.access_token}});
 if(!res.ok){failed+=ids.length;continue}
 const arr=await res.json();
 const updates=(Array.isArray(arr)?arr:[]).filter((x:any)=>x.code===200&&x.body?.id).map((x:any)=>({item_id:x.body.id,user_id:t.user_id,title:x.body.title,status:x.body.status,price:x.body.price,currency_id:x.body.currency_id,available_quantity:x.body.available_quantity,sold_quantity:x.body.sold_quantity,listing_type_id:x.body.listing_type_id,category_id:x.body.category_id,catalog_listing:x.body.catalog_listing||false,user_product_id:x.body.user_product_id||null,permalink:x.body.permalink||null,date_created:x.body.date_created||null,last_updated:x.body.last_updated||null,item_json:x.body,synced_at:new Date().toISOString()}));
 if(updates.length){const{error:e}=await db.from("ml_items_current").upsert(updates,{onConflict:"item_id"});if(e){failed+=updates.length;console.error(e)}else saved+=updates.length}
 failed+=ids.length-updates.length;
 }
 const since=new Date(Date.now()-35*86400000).toISOString();
 const{data:recent}=await db.from("ml_orders_current").select("shipment_id").gte("date_created",since).not("shipment_id","is",null).limit(500);
 const {data:previousShipments}=await db.from("pearland_shipment_status").select("shipment_id,dispatched_at,first_observed_dispatched_at").not("shipment_id","is",null);const previousMap=new Map((previousShipments||[]).map((x:any)=>[String(x.shipment_id),x]));
 const shipmentIds=[...new Set((recent||[]).map((x:any)=>x.shipment_id))];
 let shipmentSaved=0;
 for(let i=0;i<shipmentIds.length;i+=8){
 const batch=shipmentIds.slice(i,i+8);
 const results=await Promise.all(batch.map(async id=>{try{const r=await fetch("https://api.mercadolibre.com/shipments/"+id,{headers:{authorization:"Bearer "+t.access_token}});if(!r.ok)return null;const j=await r.json();const prev:any=previousMap.get(String(id));const dispatched=["shipped","delivered","not_delivered","returned"].includes(j.status)||j.substatus==="dropped_off";const eventDate=j.status_history?.date_shipped||null;const parsed=eventDate&&!Number.isNaN(Date.parse(eventDate))?new Date(eventDate).toISOString():null;return{shipment_id:id,status:j.status||null,substatus:j.substatus||null,schedule_json:{shipping_option:j.shipping_option||null,buffering:j.buffering||null,lead_time:j.lead_time||null,estimated_delivery:j.estimated_delivery||null,logistic_type:j.logistic_type||null},dispatched_at:prev?.dispatched_at||parsed,first_observed_dispatched_at:prev?.first_observed_dispatched_at||(dispatched?new Date().toISOString():null),synced_at:new Date().toISOString()}}catch{return null}}));
 const valid=results.filter(Boolean);if(valid.length){const{error:e}=await db.from("pearland_shipment_status").upsert(valid,{onConflict:"shipment_id"});if(!e)shipmentSaved+=valid.length}
 }
 return Response.json({ok:failed===0,saved,failed,new_items:newIds,discovery_ok:discovery.ok,shipmentSaved,at:new Date().toISOString()});
 }catch(e){console.error(e);return Response.json({ok:false,error:String(e)},{status:500})}
});
