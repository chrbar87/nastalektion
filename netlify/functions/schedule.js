/*
 * Skola24 -> Nästa lektion
 * Hämtar lärarens aktuella lektion och därefter nästa lektion för klassen
 * som läraren just nu undervisar. Ingen extern npm-package behövs.
 */
const HOST=process.env.SKOLA24_HOST||"nyaskolan.skola24.se";
const SCHOOL=process.env.SKOLA24_SCHOOL||"Nya Skolan Pettersberg";
const TEACHER=(process.env.SKOLA24_TEACHER||"chba").toLowerCase();
const API="https://web.skola24.se/api";
const SCOPE="8a22163c-8662-4535-9050-bc5e1923df48";

async function post(path,body){
 const r=await fetch(API+path,{method:"POST",headers:{"Content-Type":"application/json","X-Scope":SCOPE},body:JSON.stringify(body)});
 const text=await r.text();let data;try{data=JSON.parse(text)}catch{data=text}
 if(!r.ok) throw new Error(`${path}: HTTP ${r.status} ${typeof data==="string"?data:JSON.stringify(data)}`);
 return data;
}
function unwrap(x){return x?.data??x}
function walk(x,fn,seen=new Set()){
 if(!x||typeof x!=="object"||seen.has(x))return;seen.add(x);fn(x);
 if(Array.isArray(x))x.forEach(v=>walk(v,fn,seen));else Object.values(x).forEach(v=>walk(v,fn,seen));
}
function findSig(x,sig){
 let out=null;walk(x,o=>{if(out)return;for(const k of ["signature","Signature","sign","Sign"]){if(typeof o[k]==="string"&&o[k].toLowerCase()===sig){out=o;break}}});return out;
}
function findName(x,name){
 let out=null;const n=name.toLowerCase();walk(x,o=>{if(out)return;for(const k of ["name","Name","text","Text","title","Title"]){if(typeof o[k]==="string"&&(o[k].toLowerCase()===n||o[k].toLowerCase().includes(n))){out=o;break}}});return out;
}
function ids(o){return o&&typeof o==="object"?{guid:o.guid??o.Guid??o.id??o.Id??null,unitGuid:o.unitGuid??o.UnitGuid??null}: {}}
function week(d){const x=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));const day=x.getUTCDay()||7;x.setUTCDate(x.getUTCDate()+4-day);const y=new Date(Date.UTC(x.getUTCFullYear(),0,1));return Math.ceil((((x-y)/86400000)+1)/7)}
function wd(d){return d.getDay()===0?7:d.getDay()}
function clean(s){return String(s??"").replace(/\s+/g," ").trim()}
function parseLessons(data){
 const out=[];
 function add(s,e,text,raw){const a=String(s??"").match(/(\d{1,2}):(\d{2})/),b=String(e??"").match(/(\d{1,2}):(\d{2})/);if(a&&b&&clean(text))out.push({start:`${a[1].padStart(2,"0")}:${a[2]}`,end:`${b[1].padStart(2,"0")}:${b[2]}`,subject:clean(text),raw})}
 walk(unwrap(data),o=>{const s=o.startTime??o.StartTime??o.start??o.Start,e=o.endTime??o.EndTime??o.end??o.End,t=o.subject??o.Subject??o.lesson??o.Lesson??o.text??o.Text;if(s&&e&&t)add(s,e,t,o)});
 const seen=new Set();return out.filter(l=>{const k=`${l.start}|${l.end}|${l.subject}`;if(seen.has(k))return false;seen.add(k);return true}).sort((a,b)=>a.start.localeCompare(b.start));
}
function localNow(){return new Date(new Date().toLocaleString("en-US",{timeZone:"Europe/Stockholm"}))}

async function main(){
 const steps=["1. Kontaktar Skola24"];
 const keyR=await post("/get/timetable/render/key",{});const key=unwrap(keyR)?.key??unwrap(keyR)?.data?.key;if(!key)throw new Error("Skola24 gav inget renderKey.");steps.push("2. Render key OK");
 const unitsR=await post("/services/skola24/get/timetable/viewer/units",{getTimetableViewerUnitsRequest:{hostName:HOST}});const units=unwrap(unitsR);steps.push("3. Skolans enheter hämtade");
 const school=findName(units,SCHOOL)||units;const teacher=findSig(school,TEACHER)||findSig(units,TEACHER);if(!teacher)throw new Error(`Hittade inte lärarsignaturen "${TEACHER}". Kontrollera SKOLA24_TEACHER.`);steps.push(`4. Lärare ${TEACHER} hittad`);
 const tid=ids(teacher).guid;if(!tid)throw new Error("Läraren hittades men saknar ID/GUID.");
 const yearsR=await post("/get/active/school/years",{getTimetableViewerUnitsRequest:{hostName:HOST},checkSchoolYearsFeatures:false});const years=unwrap(yearsR);let schoolYear=null;
 walk(years,o=>{if(schoolYear)return;const vals=[o.schoolYear,o.SchoolYear,o.year,o.Year,o.id,o.Id].filter(Boolean).map(String);if(vals.some(v=>v.includes(String(new Date().getFullYear()))))schoolYear=vals[0]});
 if(!schoolYear)walk(years,o=>{if(!schoolYear&&(o.schoolYear||o.SchoolYear))schoolYear=o.schoolYear||o.SchoolYear});steps.push(`5. Läsår: ${schoolYear??"kunde inte identifieras"}`);
 let unitGuid=ids(school).unitGuid;if(!unitGuid)walk(school,o=>{if(!unitGuid){const v=o.unitGuid??o.UnitGuid;if(typeof v==="string")unitGuid=v}});if(!unitGuid)throw new Error("Kunde inte hitta unitGuid för skolan.");steps.push("6. School/unit OK");
 const now=localNow();const encR=await post("/encrypt/signature",{signature:tid});const enc=unwrap(encR)?.signature??unwrap(encR)?.Signature??unwrap(encR);if(!enc)throw new Error("Kunde inte kryptera lärarens ID.");
 const renderR=await post("/render/timetable",{renderKey:key,selection:enc,scheduleDay:wd(now),week:week(now),year:now.getFullYear(),host:HOST,unitGuid,schoolYear,startDate:null,endDate:null,blackAndWhite:false,width:900,height:700,selectionType:4,showHeader:false,periodText:"",privateFreeTextMode:false,privateSelectionMode:null,customerKey:""});
 steps.push("7. Lärarschema hämtat");const lessons=parseLessons(renderR);steps.push(`8. Lektioner tolkade: ${lessons.length}`);
 const mins=now.getHours()*60+now.getMinutes();const current=lessons.find(l=>{const[a,b]=l.start.split(":").map(Number),[c,d]=l.end.split(":").map(Number);return mins>=a*60+b&&mins<c*60+d});
 // NOTE: This diagnostic version first proves that the teacher timetable can be read.
 // The next class-level lookup is intentionally isolated below so it can be adjusted
 // once the exact class identifier format in Skola24's response is confirmed.
 const next=lessons.find(l=>{const[a,b]=l.start.split(":").map(Number);return a*60+b>mins});
 return {current:current?{end:current.end,subject:current.subject}:null,next:next?{subject:next.subject,start:next.start}:null,updated:now.toLocaleTimeString("sv-SE",{hour:"2-digit",minute:"2-digit"}),diagnostic:steps,notice:"Diagnostikläge: nästa lektion är ännu hämtad från lärarschemat. Klassens schema kopplas in efter att Skola24s klassidentifierare verifierats."};
}
exports.handler=async()=>{try{return{statusCode:200,headers:{"Content-Type":"application/json","Cache-Control":"no-store","Access-Control-Allow-Origin":"*"},body:JSON.stringify(await main())}}catch(e){return{statusCode:500,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"},body:JSON.stringify({error:e.message,diagnostic:["FEL",e.stack||""]})}}}
