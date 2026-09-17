const axios = require("axios");

const HOST = process.env.SKOLA24_HOST || "nyaskolan.skola24.se";
const TEACHER = (process.env.SKOLA24_TEACHER || "chba").trim().toLowerCase();
const SCHOOL_GUID = process.env.SKOLA24_SCHOOL_GUID || "583628e7-c6a9-f705-8ec5-27821f4b84cf";
const API = "https://web.skola24.se/api";
const SCOPE = "8a22163c-8662-4535-9050-bc5e1923df48";
const headers = { "Content-Type": "application/json", "X-Scope": SCOPE };

async function post(path, body) {
  try {
    const r = await axios.post(API + path, body, { headers });
    return r.data;
  } catch (e) {
    throw new Error(`${path}: HTTP ${e.response?.status || "?"} ${typeof e.response?.data === "string" ? e.response.data : JSON.stringify(e.response?.data || e.message)}`);
  }
}

async function get(path, params) {
  try {
    const r = await axios.get(API + path, { params, headers });
    return r.data;
  } catch (e) {
    throw new Error(`${path}: HTTP ${e.response?.status || "?"} ${typeof e.response?.data === "string" ? e.response.data : JSON.stringify(e.response?.data || e.message)}`);
  }
}

function unwrap(x) { return x?.data ?? x; }
function walk(x, fn, seen = new Set()) {
  if (!x || typeof x !== "object" || seen.has(x)) return;
  seen.add(x); fn(x);
  if (Array.isArray(x)) x.forEach(v => walk(v, fn, seen));
  else Object.values(x).forEach(v => walk(v, fn, seen));
}
function week(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return Math.ceil((((x - y) / 86400000) + 1) / 7);
}
function wd(d) { return d.getDay() === 0 ? 7 : d.getDay(); }
function localNow() { return new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Stockholm" })); }
function clean(s) { return String(s ?? "").replace(/\s+/g, " ").trim(); }

function parseLessons(data) {
  const out = [];
  walk(data, o => {
    const s = o.startTime ?? o.StartTime ?? o.start ?? o.Start;
    const e = o.endTime ?? o.EndTime ?? o.end ?? o.End;
    const t = o.subject ?? o.Subject ?? o.lesson ?? o.Lesson ?? o.text ?? o.Text;
    if (!s || !e || !t) return;
    const a = String(s).match(/(\d{1,2}):(\d{2})/);
    const b = String(e).match(/(\d{1,2}):(\d{2})/);
    if (a && b) out.push({ start: `${a[1].padStart(2,"0")}:${a[2]}`, end: `${b[1].padStart(2,"0")}:${b[2]}`, subject: clean(t) });
  });
  const seen = new Set();
  return out.filter(l => { const k = `${l.start}|${l.end}|${l.subject}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a,b) => a.start.localeCompare(b.start));
}

async function main() {
  const keyR = await post("/get/timetable/render/key", {});
  const key = unwrap(keyR)?.key;
  if (!key) throw new Error("Skola24 gav inget renderKey.");

  // Fetch the actual selection list used by the timetable viewer. The render API
  // expects the encrypted GUID/schema ID, not the plain teacher signature.
  let selectionR = null;
  let teacherRecord = null;
  try {
    selectionR = await get("/../timetable/timetable-viewer/data/selection", {
      schoolGuid: SCHOOL_GUID,
      hostName: HOST
    });
    const data = unwrap(selectionR);
    const teachers = data?.teachers || data?.Teachers || [];
    teacherRecord = teachers.find(t => String(t.signature ?? t.Signature ?? "").trim().toLowerCase() === TEACHER) || null;
  } catch (e) {
    selectionR = { selectionLookupError: e.message };
  }

  const yearsR = await post("/get/active/school/years", {
    getTimetableViewerUnitsRequest: { hostName: HOST },
    checkSchoolYearsFeatures: false
  });
  const yearData = unwrap(yearsR);
  const activeYears = yearData?.activeSchoolYears || yearData?.ActiveSchoolYears || [];
  let schoolYear = activeYears[0]?.guid || activeYears[0]?.Guid || activeYears[0]?.schoolYear || activeYears[0]?.SchoolYear || null;

  const unitsR = await post("/services/skola24/get/timetable/viewer/units", {
    getTimetableViewerUnitsRequest: { hostName: HOST }
  });
  let unitGuid = SCHOOL_GUID;
  walk(unwrap(unitsR), o => {
    const g = o.guid ?? o.Guid ?? o.unitGuid ?? o.UnitGuid;
    const n = String(o.name ?? o.Name ?? "").toLowerCase();
    if (typeof g === "string" && /^[0-9a-f-]{36}$/i.test(g) && (n.includes("pettersberg") || n.includes("nya skolan"))) unitGuid = g;
    if (!schoolYear) schoolYear = o.schoolYear ?? o.SchoolYear ?? o.schoolYearGuid ?? o.SchoolYearGuid ?? null;
  });

  // The current Skola24 viewer can expose the teacher GUID as the schema ID.
  // Fall back to the configured signature only if the lookup is unavailable.
  const schemaId = teacherRecord?.guid || teacherRecord?.Guid || TEACHER;
  const encR = await post("/encrypt/signature", { signature: schemaId });
  const enc = unwrap(encR)?.signature ?? unwrap(encR)?.Signature;
  if (!enc) throw new Error(`Kunde inte kryptera schema-ID för läraren "${TEACHER}".`);
  if (!schoolYear) throw new Error(`Kunde inte identifiera aktivt läsår. Skola24-svar: ${JSON.stringify(yearsR).slice(0,2000)}`);

  const now = localNow();
  const renderBody = {
    renderKey: String(key),
    selection: String(enc),
    scheduleDay: wd(now),
    week: week(now),
    year: now.getFullYear(),
    host: HOST,
    unitGuid,
    schoolYear,
    startDate: null,
    endDate: null,
    blackAndWhite: false,
    width: 125,
    height: 550,
    selectionType: 4,
    showHeader: false,
    periodText: "",
    privateFreeTextMode: false,
    privateSelectionMode: null,
    customerKey: ""
  };

  const renderR = await post("/render/timetable", renderBody);
  const lessons = parseLessons(renderR);
  if (!lessons.length) throw new Error(`Skola24 returnerade inget tolkbart lektionsschema. Render-svar: ${JSON.stringify(renderR).slice(0,5000)}`);

  const mins = now.getHours() * 60 + now.getMinutes();
  const current = lessons.find(l => {
    const [a,b] = l.start.split(":").map(Number), [c,d] = l.end.split(":").map(Number);
    return mins >= a*60+b && mins < c*60+d;
  });
  const next = lessons.find(l => { const [a,b] = l.start.split(":").map(Number); return a*60+b > mins; });
  return {
    current: current ? { end: current.end, subject: current.subject } : null,
    next: next ? { subject: next.subject, start: next.start } : null,
    updated: now.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" }),
    diagnostic: { teacher: TEACHER, teacherFound: !!teacherRecord, teacherGuid: teacherRecord?.guid || null, unitGuid, schoolYear, lessonCount: lessons.length }
  };
}

exports.handler = async (event) => {
  try {
    // Temporary diagnostic mode: lets us inspect the selection endpoint without
    // exposing the complete teacher list publicly.
    if (event?.queryStringParameters?.debug === "1") {
      const r = await get("/../timetable/timetable-viewer/data/selection", { schoolGuid: SCHOOL_GUID, hostName: HOST });
      const teachers = unwrap(r)?.teachers || [];
      const match = teachers.find(t => String(t.signature ?? "").trim().toLowerCase() === TEACHER);
      return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ ok: true, teacherFound: !!match, teacher: match ? { guid: match.guid, signature: match.signature, firstName: match.firstName, lastName: match.lastName } : null, topLevelKeys: Object.keys(unwrap(r) || {}) }) };
    }
    return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(await main()) };
  } catch (e) {
    return { statusCode: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: e.message, stack: e.stack }) };
  }
};
