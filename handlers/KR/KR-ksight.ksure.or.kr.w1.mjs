export const meta={task:'KR-ksight.ksure.or.kr',want:'w1',tier:2,method:'json_api',input:'company name as indexed; country defaults to 대한민국',fields:['name','buyer_id','country','industry','products'],canary:{found:'Toshiba Samsung Storage Technology Korea Corporation',not_found:'세무법인 혜움'}};
let last=0;
export default async function lookup(keyword){
 const url='https://ksight.ksure.or.kr/api/rsrch/selectBuyerList';const out=(status,reason,records,excerpt)=>({status,reason,records,source_url:url,excerpt:excerpt.slice(0,500)});
 try{
  await new Promise(r=>setTimeout(r,Math.max(0,last+1100-Date.now())));last=Date.now();
  const r=await fetch(url,{method:'POST',headers:{'user-agent':'Mozilla/5.0','content-type':'application/json'},body:JSON.stringify({KOR_NM:'대한민국',TRGTPSNNM:keyword,PAGE_NO:1,BIZTYP1CDID:'',PROD1NM:'',COMPSCALE:'',INSUUSEYN:'',EVALGRDYN:'',ZZIM_YN:'',HS_CD:''}),signal:AbortSignal.timeout(30000)});const t=await r.text();
  if(r.status===401||r.status===403||/captcha|cf-chl-|로그인.*필요/i.test(t))return out('couldnt_check','blocked',[],t);
  if(!r.ok)return out('couldnt_check','http_error',[],String(r.status));
  let j;try{j=JSON.parse(t);}catch{return out('couldnt_check','layout_changed',[],t);}
  if(!Array.isArray(j.selectBuyerList)||!Number.isInteger(j.PageVO?.totalCount))return out('couldnt_check','layout_changed',[],t);
  if(j.PageVO.totalCount===0&&j.selectBuyerList.length===0)return out('not_found','',[],'Valid buyer search response: zero 대한민국 records for '+keyword);
  if(!j.selectBuyerList.length||j.selectBuyerList.some(x=>typeof x.trgtpsnNm!=='string'||!x.trgtpsnNo))return out('couldnt_check','layout_changed',[],t);
  const records=j.selectBuyerList.map(x=>({name:x.trgtpsnNm,buyer_id:x.trgtpsnNo,country:'대한민국',industry:x.biztyp1CdNm,products:x.prod1Nm}));
  return out('found','',records,JSON.stringify(records));
 }catch(e){return out('couldnt_check',e.name==='TimeoutError'?'timeout':'other',[],String(e));}
}
