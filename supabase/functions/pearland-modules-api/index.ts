import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2.57.0";
// Módulos do ERP (conciliação, promoções, alertas). Mesmo login e lista de acesso do painel.
const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const headers={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,POST,OPTIONS","cache-control":"no-store"};
const reply=(v:unknown,s=200)=>Response.json(v,{status:s,headers});
const ML="https://api.mercadolibre.com";
const num=(v:unknown)=>{const n=Number(v);return v==null||v===""||!Number.isFinite(n)?null:n};
// Tipos em que o ML define o preço (aceita-se a oferta pelo ref_id) x tipos em que o vendedor informa o preço.
const OFFER_TYPES=["SMART","SMART_LIGHTNING","PRICE_MATCHING","PRICE_MATCHING_MELI_ALL","UNHEALTHY_STOCK","MARKETPLACE_CAMPAIGN","VOLUME"];
const PRICE_TYPES=["DEAL","DOD","LIGHTNING","SELLER_CAMPAIGN"];
// Alerta marcado como lido fica oculto por 7 dias (ou até mudar de situação, pois a chave muda).
const ACK_DAYS=7;
async function mlToken(){
 const {data:rows}=await db.from("ml_oauth_tokens").select("*").order("updated_at",{ascending:false}).limit(1);
 const t=rows?.[0];if(!t)throw Error("ml_connection_unavailable");
 if(new Date(t.expires_at).getTime()>Date.now()+120000)return t.access_token as string;
 const r=await fetch(ML+"/oauth/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",client_id:Deno.env.get("MELI_CLIENT_ID")||"",client_secret:Deno.env.get("MELI_CLIENT_SECRET")||"",refresh_token:t.refresh_token})});
 if(!r.ok)throw Error("ml_token_refresh_failed");
 const j=await r.json();
 await db.from("ml_oauth_tokens").update({access_token:j.access_token,refresh_token:j.refresh_token,expires_at:new Date(Date.now()+Number(j.expires_in||21600)*1000).toISOString(),updated_at:new Date().toISOString()}).eq("user_id",t.user_id);
 return j.access_token as string;
}
async function refreshItemPromotions(token:string,itemId:string){
 const r=await fetch(ML+"/seller-promotions/items/"+encodeURIComponent(itemId)+"?app_version=v2",{headers:{Authorization:"Bearer "+token}});
 if(!r.ok)return;
 const rows=await r.json().catch(()=>[]);if(!Array.isArray(rows))return;
 const now=new Date().toISOString();
 const up=rows.map((p:any,i:number)=>({item_id:itemId,promotion_id:String(p.id??p.promotion_id??p.ref_id??`${p.type||"PROMO"}-${p.status||"unknown"}-${i}`),promotion_type:p.type??null,status:p.status??null,start_date:p.start_date??null,finish_date:p.finish_date??null,original_price:num(p.original_price),offer_price:num(p.price??p.deal_price??p.offer_price),promotion_json:p,synced_at:now}));
 if(up.length)await db.from("ml_promotions_current").upsert(up,{onConflict:"item_id,promotion_id"});
}
Deno.serve(async req=>{
 if(req.method==="OPTIONS")return new Response(null,{headers});
 const jwt=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");
 const {data:{user},error}=await db.auth.getUser(jwt);
 if(error||!user)return reply({error:"login_required"},401);
 const {data:allowed}=await db.from("pearland_dashboard_users").select("user_id").eq("user_id",user.id).maybeSingle();
 if(!allowed)return reply({error:"access_not_granted"},403);
 const url=new URL(req.url);
 const module=url.searchParams.get("module")||"";
 if(module==="alert_acks"){
  if(req.method==="GET"){
   const since=new Date(Date.now()-ACK_DAYS*86400000).toISOString();
   const {data,error:e}=await db.from("pearland_alert_acks").select("alert_key,acked_at").gte("acked_at",since).limit(2000);
   if(e)return reply({error:"acks_unavailable"},503);
   return reply({acks:data||[]});
  }
  const body=await req.json().catch(()=>null);
  const keys=Array.isArray(body?.keys)?body.keys.map((k:unknown)=>String(k).slice(0,300)).filter(Boolean).slice(0,500):[];
  if(!keys.length)return reply({error:"invalid_request"},400);
  if(body.undo){const {error:e}=await db.from("pearland_alert_acks").delete().in("alert_key",keys);return e?reply({error:"save_failed"},500):reply({ok:true});}
  const now=new Date().toISOString();
  const {error:e}=await db.from("pearland_alert_acks").upsert(keys.map((k:string)=>({alert_key:k,acked_at:now,acked_by:user.id})),{onConflict:"alert_key"});
  return e?reply({error:"save_failed"},500):reply({ok:true});
 }
 if(req.method==="GET"&&module==="reconciliation"){
  const since=new Date(Date.now()-120*86400000).toISOString();
  const [{data:rows,error:e},{data:last}]=await Promise.all([
   db.from("pearland_reconciliation").select("*").gte("order_date",since).order("order_date",{ascending:false}).limit(3000),
   db.from("pearland_payments").select("synced_at").order("synced_at",{ascending:false}).limit(1)
  ]);
  if(e)return reply({error:"reconciliation_unavailable"},503);
  return reply({rows:rows||[],synced_at:last?.[0]?.synced_at||null});
 }
 if(req.method==="GET"&&module==="promotions"){
  const [{data:promos,error:e1},{data:econ,error:e2},{data:actions}]=await Promise.all([
   db.from("pearland_promotions_open").select("*").limit(3000),
   db.from("pearland_item_economics").select("*").limit(3000),
   db.from("pearland_promotion_actions").select("created_at,item_id,promotion_id,promotion_type,deal_price,http_status").order("created_at",{ascending:false}).limit(50)
  ]);
  if(e1||e2)return reply({error:"promotions_unavailable"},503);
  return reply({promotions:promos||[],economics:econ||[],actions:actions||[]});
 }
 if(req.method==="POST"&&module==="promotions"){
  const body=await req.json().catch(()=>null);
  if(body?.action!=="accept")return reply({error:"invalid_request"},400);
  const itemId=String(body.item_id||""),promotionId=String(body.promotion_id||"");
  const {data:promo}=await db.from("pearland_promotions_open").select("*").eq("item_id",itemId).eq("promotion_id",promotionId).maybeSingle();
  if(!promo)return reply({error:"promotion_not_found"},404);
  if(promo.status!=="candidate")return reply({error:"promotion_not_open_for_acceptance"},409);
  const type=String(promo.promotion_type);
  const payload:any={promotion_type:type};
  if(!String(promo.promotion_id).includes("-started-")&&!String(promo.promotion_id).includes("-candidate-"))payload.promotion_id=promo.promotion_id;
  const stock=body.stock==null||body.stock===""?null:Number(body.stock);
  if(stock!==null){if(!Number.isInteger(stock)||stock<1||stock>100000)return reply({error:"invalid_stock"},400);payload.stock=stock;}
  let dealPrice:number|null=null;
  if(OFFER_TYPES.includes(type)){
   if(!promo.ref_id)return reply({error:"offer_reference_missing"},422);
   payload.offer_id=promo.ref_id;dealPrice=num(promo.offer_price);
  }else if(PRICE_TYPES.includes(type)){
   dealPrice=Number(body.deal_price);
   if(!Number.isFinite(dealPrice)||dealPrice<=0)return reply({error:"invalid_price"},400);
   if(promo.max_price!=null&&dealPrice>Number(promo.max_price)+0.001)return reply({error:"price_above_max",max:promo.max_price},400);
   if(promo.min_price!=null&&dealPrice<Number(promo.min_price)-0.001)return reply({error:"price_below_min",min:promo.min_price},400);
   payload.deal_price=Math.round(dealPrice*100)/100;
  }else return reply({error:"type_not_supported",type},422);
  let token:string;try{token=await mlToken()}catch(e){return reply({error:String((e as Error).message)},503)}
  const r=await fetch(ML+"/seller-promotions/items/"+encodeURIComponent(itemId)+"?app_version=v2",{method:"POST",headers:{Authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(payload)});
  const resp=await r.json().catch(()=>null);
  await db.from("pearland_promotion_actions").insert({user_id:user.id,item_id:itemId,promotion_id:promo.promotion_id,promotion_type:type,deal_price:dealPrice,stock,request_json:payload,http_status:r.status,response_json:resp});
  if(!r.ok)return reply({error:"ml_rejected",http:r.status,message:resp?.message||resp?.error||null,cause:resp?.cause||null},422);
  await refreshItemPromotions(token,itemId);
  return reply({ok:true,response:resp});
 }
 return reply({error:"unknown_module"},400);
});
