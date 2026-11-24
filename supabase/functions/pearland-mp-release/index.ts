import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2";
// Relatório de liberações do Mercado Pago: extrato oficial (entradas, saídas, saques) e saldo disponível.
// Ações: config (cria a configuração uma vez), generate (pede um relatório), fetch (importa o mais recente pronto),
// billing (faturas do ML), cycle (fetch + billing + generate).
const ML="https://api.mercadolibre.com",MP="https://api.mercadopago.com";
function db(){const k=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}").default;return createClient(Deno.env.get("SUPABASE_URL")!,k,{auth:{persistSession:false}})}
const COLUMNS=["DATE","SOURCE_ID","EXTERNAL_REFERENCE","RECORD_TYPE","DESCRIPTION","NET_CREDIT_AMOUNT","NET_DEBIT_AMOUNT","GROSS_AMOUNT","MP_FEE_AMOUNT","FINANCING_FEE_AMOUNT","SHIPPING_FEE_AMOUNT","TAXES_AMOUNT","COUPON_AMOUNT","PAYMENT_METHOD","ORDER_ID","SHIPPING_ID","PACK_ID"];
const num=(v:unknown)=>{if(v==null||v==="")return null;const n=Number(String(v).replace(/\s/g,""));return Number.isFinite(n)?n:null};
async function token(sup:any){
 const {data:rows}=await sup.from("ml_oauth_tokens").select("*").order("updated_at",{ascending:false}).limit(1);
 const t=rows?.[0];if(!t)throw Error("no_token");
 if(new Date(t.expires_at).getTime()>Date.now()+120000)return {tok:t.access_token as string,uid:t.user_id};
 const r=await fetch(ML+"/oauth/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",client_id:Deno.env.get("MELI_CLIENT_ID")||"",client_secret:Deno.env.get("MELI_CLIENT_SECRET")||"",refresh_token:t.refresh_token})});
 if(!r.ok)throw Error("refresh_failed");const j=await r.json();
 await sup.from("ml_oauth_tokens").update({access_token:j.access_token,refresh_token:j.refresh_token,expires_at:new Date(Date.now()+Number(j.expires_in||21600)*1000).toISOString(),updated_at:new Date().toISOString()}).eq("user_id",t.user_id);
 return {tok:j.access_token as string,uid:t.user_id};
}
function parseCsv(text:string){
 const firstLine=text.split(/\r?\n/)[0]||"";const sep=(firstLine.match(/;/g)||[]).length>(firstLine.match(/,/g)||[]).length?";":",";
 const rows:string[][]=[];let row:string[]=[],cell="",q=false;
 for(let i=0;i<text.length;i++){const c=text[i];
  if(q){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++}else q=false}else cell+=c;continue}
  if(c==='"'){q=true;continue}
  if(c===sep){row.push(cell);cell="";continue}
  if(c==="\n"||c==="\r"){if(c==="\r"&&text[i+1]==="\n")i++;row.push(cell);cell="";if(row.some(x=>x!==""))rows.push(row);row=[];continue}
  cell+=c;}
 if(cell!==""||row.length){row.push(cell);if(row.some(x=>x!==""))rows.push(row)}
 return rows;
}
async function doConfig(tok:string,uid:any){
 const g=await fetch(MP+"/v1/account/release_report/config",{headers:{Authorization:"Bearer "+tok}});
 if(g.ok)return {existing:true,config:await g.json()};
 // A frequência só vale se o agendamento automático do MP for ligado (não ligamos: o ERP pede os relatórios).
 const body={file_name_prefix:"pearland-release-"+uid,include_withdrawal_at_end:true,execute_after_withdrawal:false,check_available_balance:true,display_timezone:"GMT-03",report_translation:"en",notification_email_list:[],frequency:{hour:0,type:"monthly",value:1},columns:COLUMNS.map(key=>({key}))};
 const r=await fetch(MP+"/v1/account/release_report/config",{method:"POST",headers:{Authorization:"Bearer "+tok,"content-type":"application/json",accept:"application/json"},body:JSON.stringify(body)});
 return {existing:false,http:r.status,config:await r.json().catch(()=>null)};
}
async function doGenerate(tok:string,days:number){
 const end=new Date(Date.now()-60000);const begin=new Date(end.getTime()-days*86400000);begin.setUTCHours(3,0,0,0);
 const iso=(d:Date)=>d.toISOString().replace(/\.\d{3}Z$/,"Z");
 const r=await fetch(MP+"/v1/account/release_report",{method:"POST",headers:{Authorization:"Bearer "+tok,"content-type":"application/json",accept:"application/json"},body:JSON.stringify({begin_date:iso(begin),end_date:iso(end)})});
 return {http:r.status,body:await r.text().then(t=>t.slice(0,400)),begin:iso(begin),end:iso(end)};
}
async function doFetch(sup:any,tok:string){
 const l=await fetch(MP+"/v1/account/release_report/list",{headers:{Authorization:"Bearer "+tok}});
 if(!l.ok)return {error:"list_failed",http:l.status};
 const list=await l.json();if(!Array.isArray(list)||!list.length)return {imported:false,reason:"no_reports",count:0};
 const ready=list.filter((x:any)=>x.file_name&&(!x.status||["processed","enabled"].includes(x.status))).sort((a:any,b:any)=>String(b.date_created||b.generation_date||b.last_modified||"").localeCompare(String(a.date_created||a.generation_date||a.last_modified||"")));
 const latest=ready[0];if(!latest)return {imported:false,reason:"none_ready",sample:list.slice(0,2)};
 const {data:done}=await sup.from("pearland_mp_release_files").select("file_name").eq("file_name",latest.file_name).maybeSingle();
 if(done)return {imported:false,reason:"already_imported",file:latest.file_name};
 const d=await fetch(MP+"/v1/account/release_report/"+encodeURIComponent(latest.file_name),{headers:{Authorization:"Bearer "+tok}});
 if(!d.ok)return {error:"download_failed",http:d.status,file:latest.file_name};
 const csv=await d.text();const rows=parseCsv(csv.replace(/^﻿/,""));if(rows.length<1)return {error:"empty_file"};
 const head=rows[0].map(h=>h.trim().toUpperCase().replace(/\s+/g,"_"));
 const idx=(k:string)=>head.indexOf(k);
 const pick=(r:string[],k:string)=>{const i=idx(k);return i>=0?(r[i]??"").trim():""};
 const recs=rows.slice(1).map((r,n)=>({file_name:latest.file_name,line_no:n+1,release_date:pick(r,"DATE")||null,source_id:pick(r,"SOURCE_ID")||null,external_reference:pick(r,"EXTERNAL_REFERENCE")||null,record_type:pick(r,"RECORD_TYPE")||null,description:pick(r,"DESCRIPTION")||null,net_credit:num(pick(r,"NET_CREDIT_AMOUNT")),net_debit:num(pick(r,"NET_DEBIT_AMOUNT")),gross_amount:num(pick(r,"GROSS_AMOUNT")),mp_fee:num(pick(r,"MP_FEE_AMOUNT")),financing_fee:num(pick(r,"FINANCING_FEE_AMOUNT")),shipping_fee:num(pick(r,"SHIPPING_FEE_AMOUNT")),taxes:num(pick(r,"TAXES_AMOUNT")),coupon:num(pick(r,"COUPON_AMOUNT")),payment_method:pick(r,"PAYMENT_METHOD")||null,order_id:pick(r,"ORDER_ID")||null,shipping_id:pick(r,"SHIPPING_ID")||null,pack_id:pick(r,"PACK_ID")||null,raw:Object.fromEntries(head.map((h,i)=>[h,r[i]??""]))}));
 const net=(x:any)=>Number(x.net_credit||0)-Number(x.net_debit||0);
 const initialRow=recs.find(x=>(x.record_type||"").toLowerCase()==="initial_available_balance");
 const initial=initialRow?net(initialRow):0;
 const moves=recs.filter(x=>(x.record_type||"").toLowerCase()==="release");
 const final=Math.round((initial+moves.reduce((n,x)=>n+net(x),0))*100)/100;
 const validDate=(v:string|null)=>v&&!Number.isNaN(Date.parse(v))?v:null;
 recs.forEach(x=>x.release_date=validDate(x.release_date));
 const {error:e1}=await sup.from("pearland_mp_release_files").upsert({file_name:latest.file_name,begin_date:latest.begin_date||null,end_date:latest.end_date||null,status:latest.status||null,initial_balance:initial,final_balance:final,rows_count:recs.length,processed_at:new Date().toISOString(),raw_meta:latest},{onConflict:"file_name"});
 if(e1)return {error:"db_file",detail:e1.message};
 for(let i=0;i<recs.length;i+=500){const {error:e2}=await sup.from("pearland_mp_release_rows").upsert(recs.slice(i,i+500),{onConflict:"file_name,line_no"});if(e2)return {error:"db_rows",detail:e2.message}}
 // Posição do saldo = momento em que o MP gerou o relatório (o end_date vem arredondado para o fim do dia).
 const gen=latest.generation_date||latest.date_created||null;const asOf=gen&&!Number.isNaN(Date.parse(gen))&&Date.parse(gen)<Date.now()?new Date(gen).toISOString():new Date().toISOString();
 await sup.from("pearland_mp_balance").upsert({as_of:asOf,available_balance:final,file_name:latest.file_name},{onConflict:"as_of"});
 // Mantém só os 10 arquivos mais recentes para não acumular linhas repetidas.
 const {data:old}=await sup.from("pearland_mp_release_files").select("file_name").order("processed_at",{ascending:false}).range(10,200);
 if(old?.length)await sup.from("pearland_mp_release_files").delete().in("file_name",old.map((o:any)=>o.file_name));
 return {imported:true,file:latest.file_name,rows:recs.length,initial,final,headers:head,types:[...new Set(recs.map(r=>r.record_type))]};
}
async function doBilling(sup:any,tok:string){
 const r=await fetch(ML+"/billing/integration/monthly/periods?group=ML&document_type=BILL&limit=6",{headers:{Authorization:"Bearer "+tok}});
 if(!r.ok)return {error:"billing_failed",http:r.status};
 const j=await r.json();const list=Array.isArray(j.results)?j.results:[];
 const up=list.map((p:any)=>({period_key:String(p.key),date_from:p.period?.date_from||null,date_to:p.period?.date_to||null,amount:num(p.amount),unpaid_amount:num(p.unpaid_amount),period_status:p.period_status||null,raw:p,synced_at:new Date().toISOString()}));
 if(up.length){const {error:e}=await sup.from("pearland_ml_billing").upsert(up,{onConflict:"period_key"});if(e)return {error:"db_billing",detail:e.message}}
 return {periods:up.length};
}
Deno.serve(async(req)=>{
 if(req.method!=="POST")return Response.json({error:"method"},{status:405});
 const body=await req.json().catch(()=>({}));const action=String(body?.action||"cycle");
 const sup=db();let t;try{t=await token(sup)}catch(e){return Response.json({error:String((e as Error).message)},{status:503})}
 const out:any={action};
 try{
  if(action==="config")out.config=await doConfig(t.tok,t.uid);
  if(action==="generate")out.generate=await doGenerate(t.tok,Number(body?.days)||30);
  if(action==="fetch"||action==="cycle")out.fetch=await doFetch(sup,t.tok);
  if(action==="billing"||action==="cycle")out.billing=await doBilling(sup,t.tok);
  if(action==="cycle")out.generate=await doGenerate(t.tok,30);
 }catch(e){out.error=String((e as Error).message)}
 return Response.json(out);
});
