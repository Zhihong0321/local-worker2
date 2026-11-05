export const meta={task:'KR-ablyads.com',want:'w1',tier:1,method:'static_list',input:'company name',fields:['name','phone','email','website','table','description'],canary:{found:'링크프라이스',not_found:'이상한 마케팅'},notes:'Reads both excellent and all official tables. Contact comparisons require other sources; this handler reports the published contacts and table membership.'};
const url='https://www.ablyads.com/agency_list';
const clean=s=>s.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const norm=s=>s.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
export default async function lookup(keyword){
 const base={records:[],source_url:url,excerpt:''};
 try{
 const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(30000)}); const h=await r.text();
 if(/cf-chl-|captcha|verify you are human/i.test(h))return {...base,status:'couldnt_check',reason:'blocked'};
 if(!r.ok)return {...base,status:'couldnt_check',reason:'http_error'};
 const tables=[...h.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
 if(tables.length!==2||!h.includes('전체 공식 대행사 리스트')||!h.includes('에이블리 우수 대행사'))return {...base,status:'couldnt_check',reason:'layout_changed'};
 const rows=tables.flatMap((t,i)=>[...t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].slice(1).map(row=>{
 const cells=[...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c=>c[1]); const values=cells.map(clean); const offset=i===0?1:0;
 return {name:values[0],description:i===0?values[1]:'',phone:values[1+offset],email:values[2+offset],website:cells[3+offset]?.match(/href="([^"]+)"/)?.[1]||'',table:i===0?'excellent':'all_official'};
 }));
 if(rows.length<2||rows.some(x=>!x.name||!x.email))return {...base,status:'couldnt_check',reason:'layout_changed'};
 if(!norm(String(keyword)))return {...base,status:'couldnt_check',reason:'other'};
 const records=rows.filter(x=>norm(x.name)===norm(String(keyword)));
 return {...base,status:records.length?'found':'not_found',reason:'',records,excerpt:records.map(x=>Object.values(x).join(' ')).join(' | ').slice(0,500)};
 }catch(e){return {...base,status:'couldnt_check',reason:e.name==='TimeoutError'?'timeout':'other'};}
}
