// Componentes do design system ORKA: contagiro de desempenho e card de decisão.
// O sistema orienta, a pessoa decide: nada aqui executa ação sem clique de aprovação.
import{useEffect,useState}from"react";

export type Faixa={atencao:number;excelente:number};
// Metas padrão (em % da receita). Abaixo de "atencao" = vermelho; a partir de "excelente" = azul.
export const METAS:{contribuicao:Faixa;resultado:Faixa}={
 contribuicao:{atencao:15,excelente:20},
 resultado:{atencao:5,excelente:12},
};

export type Estado="atencao"|"saudavel"|"excelente";
export const estadoLabel:Record<Estado,string>={atencao:"Atenção",saudavel:"Saudável",excelente:"Excelente"};
const pctBR=(n:number,d=1)=>n.toFixed(d).replace(".",",");

export function avaliar(valor:number,f:Faixa){
 const span=f.excelente-f.atencao;const unit=span/0.35;
 const lo=f.atencao-unit*0.35;
 const p=Math.min(1,Math.max(0,(valor-lo)/unit));
 const estado:Estado=valor<f.atencao?"atencao":valor<f.excelente?"saudavel":"excelente";
 const cenario=estado==="atencao"?"Para chegar ao verde, faltam "+pctBR(f.atencao-valor)+" pontos."
  :estado==="saudavel"?"Para chegar ao azul, faltam "+pctBR(f.excelente-valor)+" pontos."
  :"Acima da meta em "+pctBR(valor-f.excelente)+" pontos.";
 return{p,estado,cenario};
}

function pt(cx:number,cy:number,r:number,p:number){const a=p*Math.PI;return[+(cx-r*Math.cos(a)).toFixed(1),+(cy-r*Math.sin(a)).toFixed(1)]}
function arco(cx:number,cy:number,r:number,p1:number,p2:number){const[x1,y1]=pt(cx,cy,r,p1),[x2,y2]=pt(cx,cy,r,p2);return`M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`}

function useAgulha(p:number){
 const alvo=-(1-p)*180;const[rot,setRot]=useState(-180);
 useEffect(()=>{const t=requestAnimationFrame(()=>setRot(alvo));return()=>cancelAnimationFrame(t)},[alvo]);
 return rot;
}

/** Contagiro de meia volta. mini=true para listas e cards. */
export function Contagiro({p,mini=false,label}:{p:number;mini?:boolean;label:string}){
 const rot=useAgulha(p);
 const[w,h,cx,cy,r,sw,tick]=mini?[100,60,50,52,40,5,35]:[480,280,240,240,200,12,176];
 const g=mini?0.012:0.006;
 const s=mini?0.2:1;
 return <svg className={mini?"contagiro mini":"contagiro"} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
  <path d={arco(cx,cy,r,0,0.35-g)} fill="none" stroke="var(--orka-atencao)" strokeWidth={sw}/>
  <path d={arco(cx,cy,r,0.35+g,0.7-g)} fill="none" stroke="var(--orka-saudavel)" strokeWidth={sw}/>
  <path d={arco(cx,cy,r,0.7+g,1)} fill="none" stroke="var(--orka-excelente)" strokeWidth={sw}/>
  {!mini&&<path d={arco(cx,cy,tick,0,1)} fill="none" stroke="var(--orka-linha-forte)" strokeWidth={8} strokeDasharray="1.2 26.4"/>}
  <g className="contagiro-agulha" style={{transform:`rotate(${rot}deg)`,transformOrigin:`${cx}px ${cy}px`}}>
   <g transform={`translate(${cx} ${cy}) scale(${s}) translate(-240 -240)`}>
    <polygon points="420,240 280,231 222,240" fill="var(--orka-gelo)"/>
    <polygon points="420,240 280,249 222,240" fill="var(--orka-faceta)"/>
    <circle cx="240" cy="240" r="12" fill="var(--orka-abismo)" stroke="var(--orka-gelo)" strokeWidth={mini?6:1.5}/>
    <circle cx="240" cy="240" r="3" fill="var(--orka-gelo)"/>
   </g>
  </g>
 </svg>;
}

/** Mostrador completo: contagiro + valor + status escrito + frase de cenário (+ "Ver cenários" no vermelho). */
export function Desempenho({titulo,valor,faixa,detalhe,onCenarios}:{titulo:string;valor:number|null;faixa:Faixa;detalhe?:string;onCenarios?:()=>void}){
 if(valor==null||!isFinite(valor))return <article className="desempenho"><span className="desempenho-titulo">{titulo}</span><p className="muted">Sem receita no período para avaliar.</p></article>;
 const a=avaliar(valor,faixa);
 return <article className="desempenho">
  <span className="desempenho-titulo">{titulo}</span>
  <Contagiro p={a.p} label={titulo+": "+pctBR(valor)+"%, "+estadoLabel[a.estado]}/>
  <div className="desempenho-leitura">
   <strong>{pctBR(valor)}%</strong>
   <span className={"estado estado-"+a.estado}>{estadoLabel[a.estado]}</span>
  </div>
  <p className="desempenho-cenario">{a.cenario}</p>
  <small className="desempenho-faixa">Faixa saudável: {pctBR(faixa.atencao,0)}% a {pctBR(faixa.excelente,0)}% · azul a partir de {pctBR(faixa.excelente,0)}%{detalhe?" · "+detalhe:""}</small>
  {a.estado==="atencao"&&onCenarios&&<button className="orka-secundario" onClick={onCenarios}>Ver cenários</button>}
 </article>;
}

/** Leitura compacta: mini contagiro + status escrito. */
export function MiniDesempenho({valor,faixa,titulo}:{valor:number|null;faixa:Faixa;titulo:string}){
 if(valor==null||!isFinite(valor))return null;
 const a=avaliar(valor,faixa);
 return <span className="mini-desempenho"><Contagiro mini p={a.p} label={titulo+": "+estadoLabel[a.estado]}/><span className={"estado estado-"+a.estado}>{estadoLabel[a.estado]}</span></span>;
}

/** Card de decisão: fundo claro, pergunta, cenário e Aprovar · Ajustar · Recusar. */
export function CardDecisao({pergunta,linhas,onAprovar,onAjustar,onRecusar,ocupado,nota}:{pergunta:string;linhas:[string,string][];onAprovar:()=>void;onAjustar:()=>void;onRecusar:()=>void;ocupado?:boolean;nota?:string}){
 return <section className="card-decisao" role="dialog" aria-label={pergunta}>
  <span className="card-decisao-rotulo">Decisão aguardando você</span>
  <h3>{pergunta}</h3>
  <dl>{linhas.map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
  <div className="card-decisao-acoes">
   <button className="aprovar" disabled={ocupado} onClick={onAprovar}>{ocupado?"Enviando...":"Aprovar"}</button>
   <button className="ajustar" disabled={ocupado} onClick={onAjustar}>Ajustar</button>
   <button className="recusar" disabled={ocupado} onClick={onRecusar}>Recusar</button>
  </div>
  <small>{nota||"Nada é feito sem a sua aprovação."}</small>
 </section>;
}
