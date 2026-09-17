const axios = require("axios");

const HOST = process.env.SKOLA24_HOST || "nyaskolan.skola24.se";
const TEACHER = (process.env.SKOLA24_TEACHER || "chba").trim();
const SCHOOL_GUID = process.env.SKOLA24_SCHOOL_GUID || "583628e7-c6a9-f705-8ec5-27821f4b84cf";
const API = "https://web.skola24.se/api";
const SCOPE = "8a22163c-8662-4535-9050-bc5e1923df48";

const headers = {
  "Content-Type": "application/json",
  "X-Scope": SCOPE,
};

async function post(path, body) {
  try {
    const response = await axios.post(API + path, body, { headers });
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data;
    throw new Error(
      `${path}: HTTP ${status || "?"} ${typeof data === "string" ? data : JSON.stringify(data || error.message)}`,
    );
  }
}

function unwrap(x) {
  return x?.data ?? x;
}

function walk(x, fn, seen = new Set()) {
  if (!x || typeof x !== "object" || seen.has(x)) return;
  seen.add(x);
  fn(x);
  if (Array.isArray(x)) x.forEach((v) => walk(v, fn, seen));
  else Object.values(x).forEach((v) => walk(v, fn, seen));
}

function week(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return Math.ceil((((x - y) / 86400000) + 1) / 7);
}

function wd(d) {
  return d.getDay() === 0 ? 7 : d.getDay();
}

function clean(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function localNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Stockholm" }));
}

function parseLessons(data) {
  const out = [];
  walk(unwrap(data), (o) => {
    const s = o.startTime ?? o.StartTime ?? o.start ?? o.Start;
    const e = o.endTime ?? o.EndTime ?? o.end ?? o.End;
    const t = o.subject ?? o.Subject ?? o.lesson ?? o.Lesson ?? o.text ?? o.Text;
    if (!s || !e || !t) return;

    const a = String(s).match(/(\d{1,2}):(\d{2})/);
    const b = String(e).match(/(\d{1,2}):(\d{2})/);
    if (a && b) {
      out.push({
        start: `${a[1].padStart(2, "0")}:${a[2]}`,
        end: `${b[1].padStart(2, "0")}:${b[2]}`,
        subject: clean(t),
        raw: o,
      });
    }
  });

  const seen = new Set();
  return out
    .filter((l) => {
      const k = `${l.start}|${l.end}|${l.subject}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

async function main() {
  // 1. Render key
  const keyR = await post("/get/timetable/render/key", {});
  const key = unwrap(keyR)?.key;
  if (!key) throw new Error("Skola24 gav inget renderKey.");

  // 2. School/unit GUID
  const unitsR = await post("/services/skola24/get/timetable/viewer/units", {
    getTimetableViewerUnitsRequest: { hostName: HOST },
  });
  const units = unwrap(unitsR);
  let unitGuid = SCHOOL_GUID;

  walk(units, (o) => {
    const g = o.guid ?? o.Guid ?? o.unitGuid ?? o.UnitGuid;
    if (typeof g !== "string" || !/^[0-9a-f-]{36}$/i.test(g)) return;
    const n = String(o.name ?? o.Name ?? "").toLowerCase();
    if (n.includes("pettersberg") || n.includes("nya skolan")) unitGuid = g;
  });

  // 3. Active school year.
  // Skola24 returns data.activeSchoolYears[0].guid. This is the shape used
  // by a working public Skola24 integration, so do not search recursively
  // for a property named "schoolYear" here.
  const yearsR = await post("/get/active/school/years", {
    hostName: HOST,
    checkSchoolYearsFeatures: false,
  });

  const activeYears = unwrap(yearsR)?.activeSchoolYears;
  const schoolYear = Array.isArray(activeYears)
    ? (activeYears[0]?.guid ?? activeYears[0]?.Guid)
    : null;

  if (!schoolYear) {
    throw new Error(
      `Kunde inte identifiera aktivt läsår. Skola24s svar: ${JSON.stringify(yearsR).slice(0, 1000)}`,
    );
  }

  // 4. Encrypt teacher signature.
  const encR = await post("/encrypt/signature", { signature: TEACHER });
  const enc = unwrap(encR)?.signature ?? unwrap(encR)?.Signature;
  if (!enc) throw new Error(`Kunde inte kryptera lärarsignaturen "${TEACHER}".`);

  // 5. Render the teacher timetable.
  const now = localNow();
  const renderR = await post("/render/timetable", {
    renderKey: key,
    selection: enc,
    scheduleDay: wd(now),
    week: week(now),
    year: now.getFullYear(),
    host: HOST,
    unitGuid,
    schoolYear,
    startDate: null,
    endDate: null,
    blackAndWhite: false,
    width: 900,
    height: 700,
    selectionType: 4,
    showHeader: false,
    periodText: "",
    privateFreeTextMode: false,
    privateSelectionMode: null,
    customerKey: "",
  });

  const lessons = parseLessons(renderR);
  if (!lessons.length) {
    const validation = unwrap(renderR)?.validation;
    if (validation?.length) {
      throw new Error(`Skola24 kunde inte rendera lärarschemat: ${JSON.stringify(validation)}`);
    }
    throw new Error("Skola24 returnerade inget tolkbart lektionsschema.");
  }

  const mins = now.getHours() * 60 + now.getMinutes();
  const current = lessons.find((l) => {
    const [a, b] = l.start.split(":").map(Number);
    const [c, d] = l.end.split(":").map(Number);
    return mins >= a * 60 + b && mins < c * 60 + d;
  });
  const next = lessons.find((l) => {
    const [a, b] = l.start.split(":").map(Number);
    return a * 60 + b > mins;
  });

  return {
    current: current ? { end: current.end, subject: current.subject } : null,
    next: next ? { subject: next.subject, start: next.start } : null,
    updated: now.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" }),
    diagnostic: {
      teacher: TEACHER,
      unitGuid,
      schoolYear,
      lessonCount: lessons.length,
    },
  };
}

exports.handler = async () => {
  try {
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(await main()),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: e.message, stack: e.stack }),
    };
  }
};
