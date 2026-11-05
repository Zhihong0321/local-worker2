export const meta={task:'MY-mcp.cidb.gov.my',want:'w1',tier:2,method:'other',input:'exact legal name; four supplied brands resolved using their official websites',fields:['name','grade','state','phone','specializations','profile_url','profile_text'],canary:{found:'DEZENO SDN. BHD.',not_found:'O2O ECOMMERCE SDN BHD'}};
const aliases={'Dezeno':'DEZENO SDN. BHD.','YYC Advisors':'YYC HOLDINGS SDN BHD','Kingdom Digital':'KINGDOM DIGITAL SOLUTIONS SDN. BHD.','O2O Digital':'O2O ECOMMERCE SDN BHD'};
let last=0;const clean=s=>s.replace(/<script[\s\S]*?<\/script>/g,' ').replace(/<[^>]*>/g,' ').replace(/&nbsp;?/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();const norm=s=>s.toUpperCase().replace(/[\s.,()]/g,'');
export default async function lookup(keyword){
 const legal=aliases[keyword]||keyword;let source='https://mcp.cidb.gov.my/MCP/ContractorSearch?ComName='+encodeURIComponent(legal)+'&PageSize=100&CtPage=1';
 const out=(status,reason,records,excerpt)=>({status,reason,records,source_url:source,excerpt:excerpt.slice(0,500)});
 async function get(url){await new Promise(r=>setTimeout(r,Math.max(0,last+1100-Date.now())));last=Date.now();const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(30000)});const t=await r.text();if(r.status===401||r.status===403||/cf-chl-|challenge-platform|verify you are human|captcha/i.test(t))throw Error('blocked');if(!r.ok)throw Error('http_error:'+r.status);return t;}
 try{
  if(keyword==='DNE Logistics')return out('couldnt_check','other',[],'Exact legal name/BRN not verified: official website failed TLS certificate validation. No brand-name search made.');
  if(/^\d{12}$/.test(legal))return out('couldnt_check','other',[],'The observed field is CIDB Reg No, not verified as SSM BRN; provide exact legal name.');
  const t=await get(source);const count=clean(t).match(/Total Records:\s*([\d,]+)/);const tbody=t.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1];
  if(!count||tbody===undefined||!t.includes('Contractor Name')||!t.includes('Grade'))return out('couldnt_check','layout_changed',[],clean(t));
  const total=Number(count[1].replace(/,/g,''));const matches=[];
  for(const tr of tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)){const cells=[...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(x=>clean(x[1]));const args=tr[1].match(/popview\('[^']*','([^']*)'\)/);if(cells.length>=4&&norm(cells[0])===norm(legal)&&args)matches.push({name:cells[0],grade:cells[1],state:cells[2],phone:cells[3],id:args[1]});}
  if(!matches.length){if(total>100)return out('couldnt_check','other',[],'More than 100 candidate rows; absence cannot be inferred');if(total===0||[...tbody.matchAll(/<tr\b/gi)].length===total)return out('not_found','',[],'Complete legal-name search returned '+total+' candidate(s), none matching '+legal);return out('couldnt_check','layout_changed',[],'Result row count mismatch');}
  const records=[];for(const item of matches){source='https://cims.cidb.gov.my/smis/regcontractor/reglocalsearch_view.vbhtml?search=P&comSSMNo='+encodeURIComponent(item.id);const d=await get(source);const text=clean(d);if(!text.includes('CONTRACTOR PROFILE REGISTERED WITH CIDB')||!text.includes(item.name)||!text.includes('Registration Grade And Category'))return out('couldnt_check','layout_changed',[],text);delete item.id;records.push({...item,specializations:[...new Set(text.match(/\b(?:B|CE|E|M|F)\d{2}\b/g)||[])],profile_url:source,profile_text:text});}
  return out('found','',records,JSON.stringify(records));
 }catch(e){return out('couldnt_check',e.message==='blocked'?'blocked':e.message.startsWith('http_error')?'http_error':e.name==='TimeoutError'?'timeout':'other',[],String(e));}
}
