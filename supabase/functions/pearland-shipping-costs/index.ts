import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2";
// Lê o custo real de frete de cada envio no Mercado Livre e grava em pearland_shipment_costs.
const api="https://api.mercadolibre.com";
function db(){const k=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}").default;return createClient(Deno.env.get("SUPABASE_URL")!,k,{auth:{persistSession:false}})}
const num=(v:unknown)=>{const n=Number(v);return v===null||v===undefined||v===""||!Number.isFinite(n)?null:n};
const FINAL=["delivered","not_delivered","cancelled"];
Deno.serve(async(req)=>{
 if(req.method!=="POST")return Response.json({error:"method"},{status:405});
 const body=await req.json().catch(()=>({}));
 const days=Math.min(Math.max(Number(body?.days)||3,1),90);
 const max=Math.min(Math.max(Number(body?.max)||150,1),400);
 const sup=db();
 const {data:rows,error}=await sup.from("ml_oauth_tokens").select("*").limit(1);
 if(error||!rows?.length)return Response.json({error:"credentials unavailable"},{status:503});
 const t=rows[0];let token=t.access_token;
 if(new Date(t.expires_at).getTime()<Date.now()+120000){
  const r=await fetch(api+"/oauth/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",client_id:Deno.env.get("MELI_CLIENT_ID")||"",client_secret:Deno.env.get("MELI_CLIENT_SECRET")||"",refresh_token:t.refresh_token})});
  if(!r.ok)return Response.json({error:"oauth_refresh",http:r.status},{status:502});
  const j=await r.json();token=j.access_token;
  await sup.from("ml_oauth_tokens").update({access_token:j.access_token,refresh_token:j.refresh_token,expires_at:new Date(Date.now()+Number(j.expires_in||21600)*1000).toISOString(),updated_at:new Date().toISOString()}).eq("user_id",t.user_id);
 }
 const since=new Date(Date.now()-days*86400000).toISOString();
 const {data:orders,error:oe}=await sup.from("ml_orders_current").select("shipment_id").not("shipment_id","is",null).gte("date_created",since).order("date_created",{ascending:false}).limit(2000);
 if(oe)return Response.json({error:"orders"},{status:500});
 const ids=[...new Set((orders||[]).map(o=>String(o.shipment_id)))];
 const {data:done}=await sup.from("pearland_shipment_costs").select("shipment_id,final").in("shipment_id",ids.length?ids:["0"]);
 const finals=new Set((done||[]).filter(d=>d.final).map(d=>String(d.shipment_id)));
 const todo=ids.filter(id=>!finals.has(id)).slice(0,max);
 const get=async(path:string,extra:Record<string,string>={})=>{for(let a=0;a<3;a++){const r=await fetch(api+path,{headers:{Authorization:"Bearer "+token,...extra}});if(r.status===429||r.status>=500){await r.body?.cancel();await new Promise(x=>setTimeout(x,800*(a+1)));continue}return {status:r.status,data:await r.json().catch(()=>null)}}return {status:429,data:null}};
 let saved=0,failed=0;const errors:unknown[]=[];
 for(const id of todo){
  const [sh,co]=await Promise.all([get("/shipments/"+id,{"x-format-new":"true"}),get("/shipments/"+id+"/costs")]);
  if(sh.status!==200||co.status!==200){failed++;if(errors.length<5)errors.push({id,shipment:sh.status,costs:co.status,detail:co.data});continue}
  const s=sh.data||{},c=co.data||{};
  const senders=Array.isArray(c.senders)?c.senders:[];
  const me=senders.find((x:any)=>String(x.user_id)===String(t.user_id))||senders[0]||{};
  const status=s.status||null;
  const row={shipment_id:Number(id),logistic_type:s.logistic?.type||s.logistic_type||null,mode:s.logistic?.mode||s.mode||null,seller_cost:num(me.cost),seller_compensation:num(me.compensation),receiver_cost:num(c.receiver?.cost),list_cost:num(c.gross_amount),shipment_status:status,costs_json:c,shipment_json:{status,substatus:s.substatus||null,logistic:s.logistic||null,lead_time:s.lead_time?{cost:s.lead_time.cost,list_cost:s.lead_time.list_cost,cost_type:s.lead_time.cost_type}:null},final:FINAL.includes(status),synced_at:new Date().toISOString()};
  const {error:e}=await sup.from("pearland_shipment_costs").upsert(row,{onConflict:"shipment_id"});
  if(e){failed++;if(errors.length<5)errors.push({id,db:e.message})}else saved++;
 }
 return Response.json({ok:failed===0,checked:todo.length,saved,failed,errors,days,at:new Date().toISOString()},{status:failed&&!saved?502:200});
});
