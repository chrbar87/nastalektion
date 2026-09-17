const HOST=process.env.SKOLA24_HOST||"nyaskolan.skola24.se";
const SCHOOL=process.env.SKOLA24_SCHOOL||"Nya Skolan Pettersberg";
const TEACHER=(process.env.SKOLA24_TEACHER||"chba").toLowerCase();
const SCHOOL_GUID=process.env.SKOLA24_SCHOOL_GUID||"583628e7-c6a9-f705-8ec5-27821f4b84cf";
const API="https://web.skola24.se/api";
const SCOPE="8a22163c-8662-4535-9050-bc5e1923df48";

async function post(path,body){
 const r=await fetch(API+path,{method:"POST",headers:{"Content-Type":"application/json","X-Scope":SCOPE,"User-Agent":"Mozilla/5.0","Origin":"https://web.skola24.se","Referer":"https://web.skola24.se/"},body:JSON.stringify(body)});
 const text=await r.text();let data;try{data=JSON.parse(text)}catch{data=text}
 if(!r.ok) throw new Error(`${path}: HTTP ${r.status} ${typeof data==="string"?data:JSON.stringify(data)}`);
 return data;
}
async function get(path){
 const r=await fetch(path,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json, text/plain, */*","Referer":"https://web.skola24.se/timetable/timetable-viewer/"}});
 const text=await r.text();let data;try{data=JSON.parse(text)}catch{data=text}
 if(!r.ok) throw new Error(`${path}: HTTP ${r.status} ${typeof data==="string"?data:JSON.stringify(data)}`);
 return data;
}
function unwrap(x){return x?.data??x}
function walk(x,fn,seen=new Set()){if(!x||typeof x!=="object"||seen.has(x))return;seen.add(x);fn(x);if(Array.isArray(x))x.forEach(v=>walk(v,fn,seen));else Object.values(x).forEach(v=>walk(v,fn,seen))}
function week(d){const x=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));const day=x.getUTCDay()||7;x.setUTCDate(x.getUTCDate()+4-day);const y=new Date(Date.UTC(x.getUTCFullYear(),0,1));return Math.ceil((((x-y)/86400000)+1)/7)}
function wd(d){return d.getDay()===0?7:d.getDay()}
function clean(s){return String(s??"").replace(/\s+/g," ").trim()}
function localNow(){return new Date(new Date().toLocaleString("en-US",{timeZone:"Europe/Stockholm"}))}
function parseLessons(data){const out=[];walk(unwrap(data),o=>{const s=o.startTime??o.StartTime??o.start??o.Start,e=o.endTime??o.EndTime??o.end??o.End,t=o.subject??o.Subject??o.lesson??o.Lesson??o.text??o.Text;if(s&&e&&t){const a=String(s).match(/(\d{1,2}):(\d{2})/),b=String(e).match(/(\d{1,2}):(\d{2})/);if(a&&b)out.push({start:`${a[1].padStart(2,"0")}:${a[2]}`,end:`${b[1].padStart(2,"0")}:${b[2]}`,subject:clean(t),raw:o})}});const seen=new Set();return out.filter(l=>{const k=`${l.start}|${l.end}|${l.subject}`;if(seen.has(k))return false;seen.add(k);return true}).sort((a,b)=>a.start.localeCompare(b.start))}

async function main(){
 const keyR=await post("/get/timetable/render/key",{});const key=unwrap(keyR)?.key;if(!key)throw new Error("Skola24 gav inget renderKey.");
 // Skola24's public timetable viewer exposes the school GUID in the selection URL.
 // For this school it is 583628e7-c6a9-f705-8ec5-27821f4b84cf.
 const schoolGuid=SCHOOL_GUID;
 const encodedSchoolGuid=Buffer.from(schoolGuid).toString("base64").replace(/=+$/,'');
 const selectionUrl=`https://web.skola24.se/timetable/timetable-viewer/data/selection?schoolGuid=${encodeURIComponent(encodedSchoolGuid)}&hostName=${encodeURIComponent(HOST)}`;
 let selection;
 try{selection=unwrap(await get(selectionUrl));}
 catch(e){throw new Error(`Kunde inte hämta Skola24s urvalsdata. ${e.message}. School GUID=${schoolGuid}`)}
 const teachers=selection?.teachers||selection?.Teachers||[];
 const teacher=teachers.find(t=>String(t.signature??t.Signature??"").toLowerCase()===TEACHER);
 if(!teacher)throw new Error(`Hittade inte lärarsignaturen "${TEACHER}" i Skola24s lärarlista (${teachers.length} lärare hämtades).`);
 const tid=teacher.guid??teacher.Guid??teacher.id??teacher.Id;if(!tid)throw new Error("Läraren hittades men saknar GUID.");
 const years=unwrap(await post("/get/active/school/years",{getTimetableViewerUnitsRequest:{hostName:HOST},checkSchoolYearsFeatures:false}));let schoolYear=null;walk(years,o=>{if(!schoolYear){const v=o.schoolYear??o.SchoolYear;if(v)schoolYear=v}});if(!schoolYear)throw new Error("Kunde inte identifiera aktivt läsår.");
 const now=localNow();
 const encR=await post("/encrypt/signature",{signature:tid});const enc=unwrap(encR)?.signature??unwrap(encR)?.Signature??unwrap(encR);if(!enc)throw new Error("Kunde inte kryptera lärarens GUID.");
 const renderR=await post("/render/timetable",{renderKey:key,selection:enc,scheduleDay:wd(now),week:week(now),year:now.getFullYear(),host:HOST,unitGuid:schoolGuid,schoolYear,startDate:null,endDate:null,blackAndWhite:false,width:900,height:700,selectionType:4,showHeader:false,periodText:"",privateFreeTextMode:false,privateSelectionMode:null,customerKey:""});
 const lessons=parseLessons(renderR);const mins=now.getHours()*60+now.getMinutes();
 const current=lessons.find(l=>{const[a,b]=l.start.split(":").map(Number),[c,d]=l.end.split(":").map(Number);return mins>=a*60+b&&mins<c*60+d});
 const next=lessons.find(l=>{const[a,b]=l.start.split(":").map(Number);return a*60+b>mins});
 return {current:current?{end:current.end,subject:current.subject}:null,next:next?{subject:next.subject,start:next.start}:null,updated:now.toLocaleTimeString("sv-SE",{hour:"2-digit",minute:"2-digit"}),diagnostic:{schoolGuid,teacher:TEACHER,teacherGuid:tid,teacherCount:teachers.length,lessonCount:lessons.length}};
}
exports.handler=async()=>{try{return{statusCode:200,headers:{"Content-Type":"application/json","Cache-Control":"no-store","Access-Control-Allow-Origin":"*"},body:JSON.stringify(await main())}}catch(e){return{statusCode:500,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"},body:JSON.stringify({error:e.message,stack:e.stack})}}};