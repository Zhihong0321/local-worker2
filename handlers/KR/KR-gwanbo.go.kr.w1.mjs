export const meta={"task":"KR-gwanbo.go.kr","want":"w1","tier":2,"method":"json_api","input":"company name","fields":["name","title","date","category","gazette_number","document_url"],"canary":{"found":"삼성전자","not_found":"제이엘무역"}};
let last=0;
const clean=s=>String(s||'').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&');
export default async function lookup(keyword){
 let source_url='https://www.gwanbo.go.kr/SearchRestApi.jsp';
 const fail=(reason,excerpt='')=>({status:'couldnt_check',reason,records:[],source_url,excerpt:excerpt.slice(0,500)});
 try{
  const term=keyword.replace(/[-_!@#$%^&*()~+|\[\]{}:;'"\\,?<>=>`]/g,' ').trim().replace(/\s+/g,' AND ');
  if(term.length<2)return fail('other','At least two characters required');
  const query=`(unstored_field_subject:(${term}) OR unstored_field_desc:(${term})) AND keyword_category_order:(@@ORDER_NUM)`;
  source_url+='?'+new URLSearchParams({mode:'keyword',index:'gwanbo',query,pQuery_tmp:keyword,pageNo:'1',listSize:'5',sort:''});
  await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-last))));last=Date.now();
  const r=await fetch(source_url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(25000)});
  if(!r.ok)return fail(r.status===403?'blocked':'http_error',`HTTP ${r.status}`);
  const text=await r.text();if(/captcha|cloudflare|access denied/i.test(text))return fail('blocked');
  let j;try{j=JSON.parse(text);}catch{return fail('layout_changed',text);}
  if(!Array.isArray(j.data)||j.data.length<10||!j.data.every(x=>typeof x.category_name==='string'&&Number.isFinite(Number(x.count))))return fail('layout_changed');
  const total=j.data.reduce((n,x)=>n+Number(x.count),0);
  const rows=j.data.flatMap(x=>x.list||[]);
  if(total>0&&!rows.length)return fail('layout_changed');
  if(rows.some(x=>!x.stored_field_subject||!x.keyword_field_regdate||!x.stored_field_url))return fail('layout_changed');
  const records=rows.map(x=>({name:keyword,title:clean(x.stored_field_subject),date:x.keyword_field_regdate,category:x.stored_category_name,gazette_number:x.stored_ebook_no,document_url:new URL(x.stored_pdf_file_path||x.stored_field_url,source_url).href}));
  return {status:total?'found':'not_found',reason:'',records,source_url,excerpt:`Full text gazette search: ${total} indexed notices. ${records.map(x=>x.title).join('; ')}`.slice(0,500)};
 }catch(e){return fail(e.name==='TimeoutError'?'timeout':'other',String(e));}
}

