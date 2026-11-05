export const meta={"task":"KR-online.fliphtml5.com","want":"w1","tier":1,"method":"static_list","pdf":true,"input":"company name","fields":[],"canary":{"found":"제이엘무역","not_found":"한국동지무역(주)"}};
export default async function lookup(keyword){
 const source_url="https://online.fliphtml5.com/phwzi/soxx/files/download/fa2920650064fb7f933f7e3fecd94c73.pdf";
 const fail=(reason,excerpt)=>({status:'couldnt_check',reason,records:[],source_url,excerpt:String(excerpt).slice(0,500)});
 try{const r=await fetch(source_url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(25000)});if(!r.ok)return fail(r.status===403?'blocked':'http_error','HTTP '+r.status);const b=new Uint8Array(await r.arrayBuffer());if(new TextDecoder().decode(b.slice(0,5))!=='%PDF-')return fail('layout_changed','Expected PDF header missing');return fail('pdf',"2025/26 certified trading company directory, 396 pages. Company listings by product sector with contact details; name index near front. Delegate PDF reading; no name presence or absence asserted.");}catch(e){return fail(e.name==='TimeoutError'?'timeout':'other',e);}
}
