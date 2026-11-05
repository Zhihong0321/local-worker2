export const meta={"task":"MY-myehalal.halal.gov.my","want":"w2","tier":1,"method":"static_list","pdf":true,"input":"company name","fields":[],"canary":{"found":"Dezeno","not_found":"YYC Advisors"}};
export default async function lookup(keyword){
 const source_url="https://myehalal.halal.gov.my/myihab/v1/system/_cms/view_gambar.php?files=20261006_doc_754496.pdf";
 const fail=(reason,excerpt)=>({status:'couldnt_check',reason,records:[],source_url,excerpt:String(excerpt).slice(0,500)});
 try{const r=await fetch(source_url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(25000)});if(!r.ok)return fail(r.status===403?'blocked':'http_error','HTTP '+r.status);const b=new Uint8Array(await r.arrayBuffer());if(new TextDecoder().decode(b.slice(0,5))!=='%PDF-')return fail('layout_changed','Expected PDF header missing');return fail('pdf',"Australia recognised foreign halal certification bodies: three-page official recognition list. Read certifier names and scopes in PDF. Other country PDFs listed in submission notes must be checked as appropriate.");}catch(e){return fail(e.name==='TimeoutError'?'timeout':'other',e);}
}
