export const meta={task:'KR-nedrug.mfds.go.kr',want:'w1',tier:2,method:'other',input:'company name',fields:['name','licence_type','licence_number','licence_date','detail_url'],canary:{found:'유한양행',not_found:'애드이피션시'}};
const base='https://nedrug.mfds.go.kr/pbp/CCBBA01/getList';let last=0;
const clean=s=>s.replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const norm=s=>s.normalize('NFKC').replace(/주식회사|\(주\)|㈜/g,'').replace(/[^\p{L}\p{N}]/gu,'').toLowerCase();
export default async function lookup(keyword){
 const q=String(keyword).normalize('NFKC').replace(/주식회사|\(주\)|㈜/g,'').trim();let source_url=base+'?'+new URLSearchParams({entpName:q,cobCode:'all',searchYn:'true'});
 const fail=(reason,excerpt='')=>({status:'couldnt_check',reason,records:[],source_url,excerpt:excerpt.slice(0,500)});
 try{
  if(!norm(q))return fail('other');
  async function get(url){await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-last))));last=Date.now();const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'},signal:AbortSignal.timeout(30000),redirect:'manual'});if(!r.ok)throw Error('http_error');const h=await r.text();if(/captcha|cf-chl-|verify you are human/i.test(h))throw Error('blocked');return h;}
  for(let page=1;page<=30;page++){
   const url=source_url+(page>1?'&page='+page:'');const h=await get(url);
   if(!h.includes('의약품 업체정보 테이블')||!h.includes('id="searchForm"'))return fail('layout_changed');
   const links=[...h.matchAll(/<a href="([^\"]*\/pbp\/CCBBA01\/getItem\?[^\"]*)"[^>]*>([^<]*)<\/a>/g)];
   const matches=links.filter(m=>norm(clean(m[2]))===norm(q));
   if(matches.length){
    const link=new URL(matches[0][1].replaceAll('&amp;','&'),'https://nedrug.mfds.go.kr').href;const d=await get(link);source_url=link;
    if(!d.includes('업허가번호')||!d.includes('의약품업체정보 테이블'))return fail('layout_changed');
    const field=label=>{const m=d.match(new RegExp('<th[^>]*>'+label+'<\\/th>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>'));return m?clean(m[1]):'';};
    const record={name:field('업체명'),licence_type:field('업종'),licence_number:field('업허가번호'),licence_date:field('업허가일자'),detail_url:link};
    if(norm(record.name)!==norm(q)||!record.licence_number)return fail('layout_changed');
    return {status:'found',reason:'',records:[record],source_url:link,excerpt:Object.values(record).join(' | ').slice(0,500)};
   }
   const pages=h.match(/id="totalPages" value="(\d+)"/);
   if(h.includes('검색 결과가 존재하지 않습니다.')||(pages&&page>=Number(pages[1])))return {status:'not_found',reason:'',records:[],source_url:url,excerpt:'No exact company-name match in the public NeDrug company licence register (all business categories). Separate clinical-trial and overseas-plant registers are outside this handler.'};
   if(!pages||!links.length)return fail('layout_changed');
  }return fail('other','More than 30 pages; absence not established.');
 }catch(e){return fail(e.name==='TimeoutError'?'timeout':['http_error','blocked'].includes(e.message)?e.message:'other',e.message);}
}
