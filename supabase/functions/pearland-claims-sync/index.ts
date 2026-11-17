import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2";
// Reclamações e devoluções do ML: busca por vendedor + ids vindos das mediações dos pedidos. Somente leitura no ML.
const api="https://api.mercadolibre.com";
function db(){const k=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}").default;return createClient(Deno.env.get("SUPABASE_URL")!,k,{auth:{persistSession:false}})}
const num=(v:unknown)=>{const n=Number(v);return v==null||v===""||!Number.isFinite(n)?null:n};
Deno.serve(async(req)=>{
 if(req.method!=="POST")return Response.json({error:"method"},{status:405});
 const sup=db();
 const {data:rows,error}=await sup.from("ml_oauth_tokens").select("*").order("updated_at",{ascending:false}).limit(1);
 if(error||!rows?.length)return Response.json({error:"credentials unavailable"},{status:503});
 const t=rows[0];let token=t.access_token;
 if(new Date(t.expires_at).getTime()<Date.now()+120000){
  const r=await fetch(api+"/oauth/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",client_id:Deno.env.get("MELI_CLIENT_ID")||"",client_secret:Deno.env.get("MELI_CLIENT_SECRET")||"",refresh_token:t.refresh_token})});
  if(!r.ok)return Response.json({error:"oauth_refresh",http:r.status},{status:502});
  const j=await r.json();token=j.access_token;
  await sup.from("ml_oauth_tokens").update({access_token:j.access_token,refresh_token:j.refresh_token,expires_at:new Date(Date.now()+Number(j.expires_in||21600)*1000).toISOString(),updated_at:new Date().toISOString()}).eq("user_id",t.user_id);
 }
 const get=async(path:string)=>{for(let a=0;a<3;a++){const r=await fetch(api+path,{headers:{Authorization:"Bearer "+token}});if(r.status===429||r.status>=500){await r.body?.cancel();await new Promise(x=>setTimeout(x,800*(a+1)));continue}return {status:r.status,data:await r.json().catch(()=>null)}}return {status:429,data:null}};
 const ids=new Set<string>();const diag:any={};
 for(let offset=0;offset<1000;offset+=50){
  const r=await get("/post-purchase/v1/claims/search?player_role=respondent&player_user_id="+t.user_id+"&limit=50&offset="+offset+"&sort=date_created:desc");
  if(offset===0)diag.search=r.status;
  const list=Array.isArray(r.data?.data)?r.data.data:[];
  list.forEach((c:any)=>c?.id&&ids.add(String(c.id)));
  if(r.status!==200||list.length<50)break;
 }
 const {data:orders}=await sup.from("ml_orders_current").select("order_id,order_json").limit(5000);
 for(const o of orders||[])for(const m of (o.order_json?.mediations||[]))if(m?.id)ids.add(String(m.id));
 // Reclamações já encerradas e com devolução finalizada não precisam ser relidas.
 const {data:known}=await sup.from("ml_claims_current").select("claim_id,status,last_updated");
 const {data:knownRet}=await sup.from("pearland_returns").select("claim_id,status");
 const retDone=new Map((knownRet||[]).map(r=>[String(r.claim_id),r.status]));
 const skip=new Set((known||[]).filter(c=>c.status==="closed"&&(!retDone.has(String(c.claim_id))||["delivered","cancelled","expired","closed"].includes(String(retDone.get(String(c.claim_id)))))&&c.last_updated&&Date.now()-Date.parse(c.last_updated)>7*86400000).map(c=>String(c.claim_id)));
 diag.claim_ids=ids.size;diag.skipped=0;
 const {data:reasonRows}=await sup.from("pearland_claim_reasons").select("reason_id");
 const reasons=new Set((reasonRows||[]).map(r=>r.reason_id));
 let claims=0,returns=0,failed=0;const errors:any[]=[];
 for(const id of ids){
  if(skip.has(id)){diag.skipped++;continue}
  const c=await get("/post-purchase/v1/claims/"+id);
  if(c.status!==200||!c.data){failed++;if(errors.length<5)errors.push({id,http:c.status});continue}
  const x=c.data;const orderId=x.resource==="order"?num(x.resource_id):num(x.order_id);
  const {error:e}=await sup.from("ml_claims_current").upsert({claim_id:x.id,user_id:t.user_id,order_id:orderId,resource_id:x.resource_id!=null?String(x.resource_id):null,resource:x.resource??null,status:x.status??null,type:x.type??null,stage:x.stage??null,reason_id:x.reason_id??null,fulfilled:x.fulfilled??null,date_created:x.date_created??null,last_updated:x.last_updated??null,claim_json:x,synced_at:new Date().toISOString()},{onConflict:"claim_id"});
  if(e){failed++;errors.push({id,db:e.message});continue}claims++;
  if(x.reason_id&&!reasons.has(x.reason_id)){
   const rr=await get("/post-purchase/v1/claims/reasons/"+encodeURIComponent(x.reason_id));
   if(rr.status===200&&rr.data){await sup.from("pearland_claim_reasons").upsert({reason_id:x.reason_id,name:rr.data.name??null,detail:rr.data.detail??null,reason_json:rr.data,synced_at:new Date().toISOString()},{onConflict:"reason_id"});reasons.add(x.reason_id)}
  }
  const r=await get("/post-purchase/v2/claims/"+id+"/returns");
  if(r.status===200&&r.data){
   const rt=r.data;const sh=(Array.isArray(rt.shipments)?rt.shipments:[]).find((s:any)=>s.type==="return")||(rt.shipments||[])[0]||null;
   let returnCost:number|null=null,costsJson:any=null;
   if(sh?.shipment_id){
    const co=await get("/shipments/"+sh.shipment_id+"/costs");
    if(co.status===200&&co.data){costsJson=co.data;
     const parts=[...(Array.isArray(co.data.senders)?co.data.senders:[]),co.data.receiver].filter(Boolean);
     const mine=parts.filter((p:any)=>String(p.user_id)===String(t.user_id));
     returnCost=mine.length?mine.reduce((n:number,p:any)=>n+Number(p.cost||0),0):0;
    }
   }
   const {error:e2}=await sup.from("pearland_returns").upsert({claim_id:x.id,order_id:orderId,return_id:num(rt.id),status:rt.status??null,subtype:rt.subtype??null,refund_at:rt.refund_at??null,shipment_status:sh?.status??null,return_shipment_id:num(sh?.shipment_id),return_cost:returnCost,return_costs_json:costsJson,return_json:rt,synced_at:new Date().toISOString()},{onConflict:"claim_id"});
   if(!e2)returns++;
  }
 }
 return Response.json({ok:failed===0,claims,returns,failed,errors,diag,at:new Date().toISOString()});
});
