export const meta={task:'MY-goldenbullaward.com',want:'w1',tier:2,method:'static_list',input:'company name',fields:['name','year','category','profile_url'],canary:{found:'AA AVIATION SDN BHD',not_found:'O2O Digital'}};
const clean=s=>s.replace(/<[^>]*>/g,' ').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)).replace(/&#x([a-f\d]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
const norm=s=>clean(s).toUpperCase().replace(/\b(?:SDN|BHD|BERHAD|SENDIRIAN)\b/g,'').replace(/[^A-Z0-9]/g,'');
let last=0;
export default async function lookup(keyword){
 let source_url='https://goldenbullaward.com/winners/my-hall-of-fame/malaysia-2026/';
 const fail=(reason,excerpt='')=>({status:'couldnt_check',reason,records:[],source_url,excerpt:excerpt.slice(0,500)});
 try{
  const records=[];
  for(const year of [2026,2025]){
   source_url=`https://goldenbullaward.com/winners/my-hall-of-fame/malaysia-${year}/`;
   await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-last))));last=Date.now();
   const r=await fetch(source_url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(25000)});
   if(!r.ok)return fail(r.status===403?'blocked':'http_error',`HTTP ${r.status}`);
   const s=await r.text();if(/cf-chl-|captcha|Just a moment/i.test(s))return fail('blocked');
   const cards=s.split(/<div class="photo_box\s*">/).slice(1);
   const parsed=[];
   for(const c of cards){
    const href=c.match(/<a\b[^>]*href="([^"]+)"/)?.[1];const d=c.match(/<div class="desc">([\s\S]*?)<\/div>/)?.[1];
    if(!href||!d)continue;
    const u=new URL(href,source_url),parts=u.pathname.split('/').filter(Boolean);
    if(!u.pathname.includes(`/malaysia-${year}/`)||parts.length<5)continue;
    const category=parts[3].replace(/-my-20\d\d$/,'').replace(/-/g,' ');
    parsed.push({name:clean(d),year,category,profile_url:u.href});
   }
   if(!s.includes('Hall of Fame')||parsed.length<30)return fail('layout_changed','Expected annual winner cards missing');
   records.push(...parsed.filter(x=>norm(x.name)===norm(keyword)));
  }
  const unique=[...new Map(records.map(x=>[x.profile_url,x])).values()];
  return {status:unique.length?'found':'not_found',reason:'',records:unique,source_url:unique[0]?.profile_url||source_url,excerpt:unique.length?JSON.stringify(unique).slice(0,500):'No exact normalized company name in complete Malaysia 2025 and 2026 annual Hall of Fame lists.'};
 }catch(e){return fail(e.name==='TimeoutError'?'timeout':'other',String(e));}
}
