export const meta={task:'KR-zipdoc.co.kr',want:'w1',tier:2,method:'json_api',input:'company name',fields:['name','partner_id','address','specialty','introduction','profile_url'],canary:{found:'동산인테리어',not_found:'은민에스엔디'}};
let last=0;const norm=s=>s.replace(/주식회사|유한회사|\(주\)|㈜|\s|[()]/g,'').toLowerCase();
export default async function lookup(keyword){
 let source_url='https://zipdoc.co.kr/newacs/search?'+new URLSearchParams({category:'2',keyword:norm(keyword),page:'0',pageSize:'100'});
 const fail=(reason,excerpt='')=>({status:'couldnt_check',reason,records:[],source_url,excerpt:excerpt.slice(0,500)});
 try{for(let page=0;page<20;page++){const u=new URL(source_url);u.searchParams.set('page',String(page));source_url=u.href;
 await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-last))));last=Date.now();const r=await fetch(source_url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(25000)});const text=await r.text();if(/captcha|cf-chl-|verify you are human/i.test(text))return fail('blocked');if(r.status===401||r.status===403)return fail('blocked','HTTP '+r.status);if(!r.ok)return fail('http_error',String(r.status));
 let d;try{d=JSON.parse(text);}catch{return fail('layout_changed');}if(!Array.isArray(d.list)||d.list.some(c=>typeof c.name!=='string'||!Number.isFinite(+c.id)))return fail('layout_changed');
 const records=d.list.filter(c=>norm(c.name)===norm(keyword)).map(c=>({name:c.name,partner_id:c.id,address:c.address,specialty:c.part,introduction:c.introMessage,profile_url:'https://zipdoc.co.kr/partner/'+c.id}));
 if(records.length||d.list.length<100)return {status:records.length?'found':'not_found',reason:'',records,source_url,excerpt:records.length?JSON.stringify(records).slice(0,500):'Public expert search returned '+d.list.length+' records; complete pages inspected with no exact company match.'};
 }return fail('other','Pagination limit reached');}catch(e){return fail(e.name==='TimeoutError'?'timeout':'http_error',String(e));}
}
