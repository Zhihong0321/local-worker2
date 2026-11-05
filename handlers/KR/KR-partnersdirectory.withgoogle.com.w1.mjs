export const meta={task:'KR-partnersdirectory.withgoogle.com',want:'w1',tier:2,method:'json_api',input:'company name',fields:['name','website','agency_id','premier','certifications','address','profile_url'],canary:{found:'애드이피션시',not_found:'이상한 마케팅'}};
const origin='https://partnersdirectory.withgoogle.com';let last=0;
const norm=s=>s.replace(/주식회사|\(주\)|㈜|\s|[()]/g,'').toLowerCase();
export default async function lookup(keyword){
 const query=new URLSearchParams({country_codes:'KR',company_name:keyword.replace(/\s/g,''),limit:'50',offset:'0'});let source_url=origin+'/api/v1/partners/filter/?'+query;
 const fail=(reason,excerpt='')=>({status:'couldnt_check',reason,records:[],source_url,excerpt:excerpt.slice(0,500)});
 try{const records=[];for(let offset=0;offset<500;offset+=50){query.set('offset',String(offset));source_url=origin+'/api/v1/partners/filter/?'+query;
  await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-last))));last=Date.now();const r=await fetch(source_url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(25000)});const text=await r.text();if(/captcha|cf-chl-|verify you are human/i.test(text))return fail('blocked');if(!r.ok)return fail('http_error',String(r.status));let d;try{d=JSON.parse(text);}catch{return fail('layout_changed');}if(!Array.isArray(d.data)||d.data.some(c=>typeof c.company_name!=='string'||!c.company_profile_agency_id))return fail('layout_changed');
  for(const c of d.data)if(norm(c.company_name)===norm(keyword)&&c.company_address__country_name_code==='KR')records.push({name:c.company_name,website:c.company_website_url,agency_id:c.company_profile_agency_id,premier:c.premier_enabled,certifications:['search','display','video','shopping','apps'].filter(k=>c['certified_in_'+k]),address:[c.company_address__administrative_area_name,c.company_address__locality_name,c.company_address__address_line].filter(Boolean).join(' '),profile_url:c.company_profile_url});
  if(d.data.length<50||records.length)return {status:records.length?'found':'not_found',reason:'',records,source_url,excerpt:records.length?JSON.stringify(records).slice(0,500):'Public Korean partner name filter returned no matching company.'};
 }return fail('other','Pagination limit reached');}catch(e){return fail(e.name==='TimeoutError'?'timeout':'http_error',String(e));}
}
