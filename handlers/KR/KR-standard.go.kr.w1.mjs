export const meta={task:'KR-standard.go.kr',want:'w1',tier:1,method:'url_template',input:'company name',fields:['name','standard','product','certifying_body','certificate_number','certification_date','remarks','listing'],canary:{found:'우일전자',not_found:'애드이피션시'}};
let last=0;const clean=s=>s.replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();const norm=s=>s.replace(/주식회사|유한회사|\(주\)|㈜|\s|[()]/g,'').toLowerCase();
export default async function lookup(keyword){
 const source_url='https://www.ksnara.or.kr/web_basic/certified_vendor/products/list.asp?'+new URLSearchParams({pagen:'281',SearchCompanyName:norm(keyword),ipage_size:'50'});
 const fail=(reason,excerpt='')=>({status:'couldnt_check',reason,records:[],source_url,excerpt:excerpt.slice(0,500)});
 try{await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-last))));last=Date.now();const r=await fetch(source_url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(25000)});const html=await r.text();if(/captcha|cf-chl-|verify you are human/i.test(html))return fail('blocked');if(!r.ok)return fail('http_error',String(r.status));
 const count=html.match(/총 검색건수\s*:\s*<strong>([\d,]+)<\/strong>/);if(!count||!html.includes('제품인증업체 검색 리스트')||!html.includes('tb_company_name')||!html.includes('tb_standard_number'))return fail('layout_changed');
 const total=Number(count[1].replace(/,/g,''));const rows=[];
 for(const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)){const cells={};for(const c of row[1].matchAll(/<td class="(tb_[^"]+)"[^>]*>([\s\S]*?)<\/td>/g))cells[c[1]]=clean(c[2]);if(cells.tb_company_name){if(!cells.tb_standard_number||!cells.tb_certification_number)return fail('layout_changed');rows.push(cells);}}
 if(total===0&&!html.includes('검색 결과가 없습니다.'))return fail('layout_changed');if(total>0&&!rows.length)return fail('layout_changed');
 const records=rows.filter(c=>norm(c.tb_company_name)===norm(keyword)).map(c=>({name:c.tb_company_name,standard:c.tb_standard_number,product:c.tb_standard_name,certifying_body:c.tb_certification,certificate_number:c.tb_certification_number,certification_date:c.tb_certification_date,remarks:c.tb_uniqueness,listing:'제품인증업체'}));
 if(!records.length&&total>rows.length)return fail('other','Additional result pages exist; absence not established');
 return {status:records.length?'found':'not_found',reason:'',records,source_url,excerpt:records.length?JSON.stringify(records).slice(0,500):'총 검색건수: '+total+'; no matching company in complete results.'};
 }catch(e){return fail(e.name==='TimeoutError'?'timeout':'http_error',String(e));}
}
