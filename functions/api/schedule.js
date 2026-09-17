const HOST_DEFAULT = "nyaskolan.skola24.se";
const TEACHER_DEFAULT = "chba";
const SCHOOL_YEAR_DEFAULT = "9c24264e-fe91-47c3-a223-8d1467506772";
const SCHEMA_ID_DEFAULT = "7589e35f-75c2-fa1e-a309-52f01c270561";
const UNIT_GUID_DEFAULT = "1a00a81e-e3bc-ff24-8f17-478715901211";
const API = "https://web.skola24.se/api";
const SCOPE = "8a22163c-8662-4535-9050-bc5e1923df48";
const PARSER_VERSION = "cf-v1-box-diagnostics";

function getEnv(env, name, fallback) { return env?.[name] ?? fallback; }
function headers(host) {
  return { "Content-Type":"application/json", "X-Scope":SCOPE, "Accept":"application/json, text/plain, */*", "Referer":`https://web.skola24.se/timetable/timetable-viewer/${host}/Nya%20Skolan%20Pettersberg/`, "Origin":"https://web.skola24.se" };
}
async function post(path, body, host) {
  const r = await fetch(API + path, { method:"POST", headers:headers(host), body:JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}
function unwrap(x) { return x?.data ?? x; }
function week(d) { const x=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())); const day=x.getUTCDay()||7; x.setUTCDate(x.getUTCDate()+4-day); const y=new Date(Date.UTC(x.getUTCFullYear(),0,1)); return Math.ceil((((x-y)/86400000)+1)/7); }
function localNow() { return new Date(new Date().toLocaleString("en-US",{timeZone:"Europe/Stockholm"})); }
function clean(s) { return String(s??"").replace(/\s+/g," ").trim(); }
function encodeGuid(guid) { return btoa(String(guid)).replace(/=+$/g,""); }
function walk(x,fn,seen=new Set()) { if(!x||typeof x!=="object"||seen.has(x))return; seen.add(x); fn(x); if(Array.isArray(x))x.forEach(v=>walk(v,fn,seen)); else Object.values(x).forEach(v=>walk(v,fn,seen)); }
function numberOf(o,names) { for(const name of names){const n=Number(o?.[name]);if(Number.isFinite(n))return n;} return null; }
function timeFromY(y) { const mins=Math.round(8*60+((y-29)*60/47)); const rounded=Math.max(0,Math.min(1439,mins)); return `${String(Math.floor(rounded/60)).padStart(2,"0")}:${String(rounded%60).padStart(2,"0")}`; }
function minutes(hhmm) { const m=String(hhmm).match(/^(\d{1,2}):(\d{2})$/); return m?Number(m[1])*60+Number(m[2]):null; }
function dayFromX(x) { const centers=[72,222,361,503,651]; let best=0,distance=Infinity; centers.forEach((c,i)=>{const d=Math.abs(x-c);if(d<distance){distance=d;best=i;}});return best; }
function parseLessonText(texts) {
  const values=texts.sort((a,b)=>a.y-b.y||a.x-b.x).map(t=>clean(t.text)).filter(Boolean); if(!values.length)return{subject:"",className:"",values:[]};
  let subject=values[0],className=""; if(values.length>=2&&/^Årskurs\b/i.test(values[1]))className=values[1];
  if(values.length===1){const compact=values[0].match(/^(.*?)\s+(Årskurs\s+[^\s]+)(?:\s+Sal\s+.*)?$/i);if(compact){subject=clean(compact[1]);className=clean(compact[2]);}}
  return{subject,className,values};
}
function parseLessons(renderR) {
  const data=unwrap(renderR)||{},textList=Array.isArray(data.textList)?data.textList:[],boxList=Array.isArray(data.boxList)?data.boxList:[],textByParent=new Map(),diagnosticBoxes=[];
  for(const t of textList){if(t?.type!=="Lesson"||t?.parentId==null)continue;if(!textByParent.has(t.parentId))textByParent.set(t.parentId,[]);textByParent.get(t.parentId).push(t);}
  const out=[];
  for(const[parentId,texts]of textByParent){const box=boxList.find(b=>String(b.id)===String(parentId));if(!box)continue;const y=numberOf(box,["y","top","Y"]),height=numberOf(box,["height","h","Height","H"]),x=numberOf(box,["x","left","X"]);if(y==null||height==null||x==null||height<=0)continue;const parsed=parseLessonText(texts),start=timeFromY(y),end=timeFromY(y+height);diagnosticBoxes.push({parentId,x:Math.round(x*100)/100,y:Math.round(y*100)/100,height:Math.round(height*100)/100,start,end,values:parsed.values});if(minutes(end)<=minutes(start))continue;if(!parsed.subject||/^(Lunch|Uppdragstid)$/i.test(parsed.subject))continue;out.push({day:dayFromX(x),start,end,subject:parsed.subject,className:parsed.className,x,y});}
  walk(data,o=>{if(!o||typeof o!=="object")return;const start=o.startTime??o.StartTime,end=o.endTime??o.EndTime,subject=o.subject??o.Subject;if(!start||!end||!subject)return;const a=String(start).match(/(\d{1,2}):(\d{2})/),b=String(end).match(/(\d{1,2}):(\d{2})/);if(!a||!b)return;out.push({day:Number(o.day??o.dayIndex??0),start:`${a[1].padStart(2,"0")}:${a[2]}`,end:`${b[1].padStart(2,"0")}:${b[2]}`,subject:clean(subject),className:clean(o.className??o.group??o.groupName??""),x:0,y:0});});
  const seen=new Set();const lessons=out.filter(l=>{const key=`${l.day}|${l.start}|${l.end}|${l.subject}|${l.className}`;if(seen.has(key))return false;seen.add(key);return true;}).sort((a,b)=>a.day-b.day||a.start.localeCompare(b.start));return{lessons,diagnosticBoxes};
}
async function main(env) {
  const HOST=getEnv(env,"SKOLA24_HOST",HOST_DEFAULT),TEACHER=String(getEnv(env,"SKOLA24_TEACHER",TEACHER_DEFAULT)).trim().toLowerCase(),SCHOOL_YEAR=getEnv(env,"SKOLA24_SCHOOL_YEAR",SCHOOL_YEAR_DEFAULT),SCHEMA_ID=getEnv(env,"SKOLA24_SCHEMA_ID",SCHEMA_ID_DEFAULT),UNIT_GUID=getEnv(env,"SKOLA24_UNIT_GUID",UNIT_GUID_DEFAULT);
  const keyR=await post("/get/timetable/render/key",{},HOST),key=unwrap(keyR)?.key;if(!key)throw new Error("Skola24 gav inget renderKey.");
  const selection=getEnv(env,"SKOLA24_SELECTION",encodeGuid(SCHEMA_ID)),unitGuid=getEnv(env,"SKOLA24_UNIT_GUID_ENCODED",encodeGuid(UNIT_GUID)),now=localNow(),today=now.getDay()===0?6:now.getDay()-1;
  const renderBody={blackAndWhite:false,customerKey:"",endDate:null,height:550,host:HOST,periodText:"",personalTimetable:false,privateFreeTextMode:null,privateSelectionMode:false,renderKey:String(key),scheduleDay:0,schoolYear:SCHOOL_YEAR,selection,selectionType:7,showHeader:false,startDate:null,unitGuid,week:week(now),width:813,year:now.getFullYear()};
  const parsed=parseLessons(await post("/render/timetable",renderBody,HOST)),todayLessons=parsed.lessons.filter(l=>l.day===today).sort((a,b)=>a.start.localeCompare(b.start)),nowMinutes=now.getHours()*60+now.getMinutes();
  const current=todayLessons.find(l=>{const s=minutes(l.start),e=minutes(l.end);return s!=null&&e!=null&&nowMinutes>=s&&nowMinutes<e;});let next=null;if(current?.className)next=todayLessons.find(l=>minutes(l.start)>nowMinutes&&l.className===current.className);if(!next)next=todayLessons.find(l=>minutes(l.start)>nowMinutes);
  return{current:current?{end:current.end,subject:current.subject,className:current.className}:null,next:next?{subject:next.subject,start:next.start}:null,updated:now.toLocaleTimeString("sv-SE",{hour:"2-digit",minute:"2-digit"}),diagnostic:{parserVersion:PARSER_VERSION,teacher:TEACHER,schemaId:SCHEMA_ID,unitGuid,schoolYear:SCHOOL_YEAR,selectionType:7,totalLessons:parsed.lessons.length,todayLessons:todayLessons.length,currentClass:current?.className||null,todayLessonsDetail:todayLessons.map(l=>({start:l.start,end:l.end,subject:l.subject,className:l.className})),lessonBoxesToday:parsed.diagnosticBoxes.filter(b=>dayFromX(b.x)===today)}};
}
export async function onRequest(context){try{return new Response(JSON.stringify(await main(context.env)),{status:200,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Access-Control-Allow-Origin":"*"}});}catch(e){return new Response(JSON.stringify({error:e?.message||String(e),stack:e?.stack||null}),{status:500,headers:{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":"*"}});}}
