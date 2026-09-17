const axios = require("axios");

const HOST = process.env.SKOLA24_HOST || "nyaskolan.skola24.se";
const TEACHER = (process.env.SKOLA24_TEACHER || "chba").trim().toLowerCase();
const SCHOOL_GUID = process.env.SKOLA24_SCHOOL_GUID || "583628e7-c6a9-f705-8ec5-27821f4b84cf";
const SCHOOL_YEAR = process.env.SKOLA24_SCHOOL_YEAR || "9c24264e-fe91-47c3-a223-8d1467506772";
// Confirmed from the live Skola24 viewer request for teacher chba.
const SCHEMA_ID = process.env.SKOLA24_SCHEMA_ID || "7589e35f-75c2-fa1e-a309-52f01c270561";
const UNIT_GUID = process.env.SKOLA24_UNIT_GUID || "1a00a81e-e3bc-ff24-8f17-478715901211";
const API = "https://web.skola24.se/api";
const SCOPE = "8a22163c-8662-4535-9050-bc5e1923df48";
const headers = {
  "Content-Type": "application/json",
  "X-Scope": SCOPE,
  "Accept": "application/json, text/plain, */*",
  "Referer": `https://web.skola24.se/timetable/timetable-viewer/${HOST}/Nya%20Skolan%20Pettersberg/`,
  "Origin": "https://web.skola24.se"
};

async function post(path, body) {
  try {
    const r = await axios.post(API + path, body, { headers });
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
function localNow() { return new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Stockholm" })); }
function clean(s) { return String(s ?? "").replace(/\s+/g, " ").trim(); }
function encodeGuid(guid) { return Buffer.from(String(guid)).toString("base64").replace(/=+$/g, ""); }

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

  // The live viewer request confirmed that selection is the base64-encoded
  // teacher schema GUID. No call to the blocked /data/selection endpoint is needed.
  const selection = process.env.SKOLA24_SELECTION || encodeGuid(SCHEMA_ID);
  const unitGuid = process.env.SKOLA24_UNIT_GUID_ENCODED || encodeGuid(UNIT_GUID);
  const schoolYear = SCHOOL_YEAR;
  const now = localNow();

  // Match the payload captured from the current Skola24 web viewer.
  const renderBody = {
    blackAndWhite: false,
    customerKey: "",
    endDate: null,
    height: 550,
    host: HOST,
    periodText: "",
    personalTimetable: false,
    privateFreeTextMode: null,
    privateSelectionMode: false,
    renderKey: String(key),
    scheduleDay: 0,
    schoolYear,
    selection,
    selectionType: 7,
    showHeader: false,
    startDate: null,
    unitGuid,
    week: week(now),
    width: 813,
    year: now.getFullYear()
  };

  const renderR = await post("/render/timetable", renderBody);
  const lessons = parseLessons(renderR);
  if (!lessons.length) {
    throw new Error(`Skola24 accepterade schemavalet men inget lektionsschema kunde tolkas. Render-svar: ${JSON.stringify(renderR).slice(0,8000)}`);
  }

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
    diagnostic: {
      teacher: TEACHER,
      schemaId: SCHEMA_ID,
      unitGuid,
      schoolYear,
      selectionType: 7,
      lessonCount: lessons.length
    }
  };
}

exports.handler = async (event) => {
  try {
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify(await main())
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({ error: e.message, stack: e.stack })
    };
  }
};