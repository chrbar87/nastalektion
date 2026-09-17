const axios = require("axios");

const HOST = process.env.SKOLA24_HOST || "nyaskolan.skola24.se";
const TEACHER = (process.env.SKOLA24_TEACHER || "chba").trim().toLowerCase();
const SCHOOL_YEAR = process.env.SKOLA24_SCHOOL_YEAR || "9c24264e-fe91-47c3-a223-8d1467506772";
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

function unwrap(x) {
  return x?.data ?? x;
}

function week(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return Math.ceil((((x - y) / 86400000) + 1) / 7);
}

function localNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Stockholm" }));
}

function clean(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function encodeGuid(guid) {
  return Buffer.from(String(guid)).toString("base64").replace(/=+$/g, "");
}

function walk(x, fn, seen = new Set()) {
  if (!x || typeof x !== "object" || seen.has(x)) return;
  seen.add(x);
  fn(x);
  if (Array.isArray(x)) x.forEach(v => walk(v, fn, seen));
  else Object.values(x).forEach(v => walk(v, fn, seen));
}

function numberOf(o, names) {
  for (const name of names) {
    const n = Number(o?.[name]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function timeFromY(y) {
  // In Skola24's current render, 08:00 is y=29 and 09:00 is y=76.
  // That gives 47 px per hour.
  const minutes = Math.round((8 * 60) + ((y - 29) * 60 / 47));
  const rounded = Math.max(0, Math.min(24 * 60 - 1, minutes));
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function minutes(hhmm) {
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function dayFromX(x) {
  // The current five-day render has column centers roughly at these x positions.
  const centers = [72, 222, 361, 503, 651];
  let best = 0;
  let distance = Infinity;
  centers.forEach((c, i) => {
    const d = Math.abs(x - c);
    if (d < distance) {
      distance = d;
      best = i;
    }
  });
  return best;
}

function parseLessonText(texts) {
  const values = texts
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map(t => clean(t.text))
    .filter(Boolean);

  if (!values.length) return { subject: "", className: "" };

  let subject = values[0];
  let className = "";

  // Normal teacher timetable cells usually contain:
  // Matematik / Årskurs 9 / Sal 32
  if (values.length >= 2 && /^Årskurs\b/i.test(values[1])) {
    className = values[1];
  }

  // Some compact cells contain everything on one line.
  if (values.length === 1) {
    const compact = values[0].match(/^(.*?)\s+(Årskurs\s+[^\s]+)(?:\s+Sal\s+.*)?$/i);
    if (compact) {
      subject = clean(compact[1]);
      className = clean(compact[2]);
    }
  }

  return { subject, className };
}

function parseLessons(renderR, now) {
  const data = unwrap(renderR) || {};
  const textList = Array.isArray(data.textList) ? data.textList : [];
  const boxList = Array.isArray(data.boxList) ? data.boxList : [];

  // Each Lesson text object points at its containing lesson box through parentId.
  const textByParent = new Map();
  for (const t of textList) {
    if (t?.type !== "Lesson" || t?.parentId == null) continue;
    if (!textByParent.has(t.parentId)) textByParent.set(t.parentId, []);
    textByParent.get(t.parentId).push(t);
  }

  const boxes = boxList.filter(b => b && (b.type === "Lesson" || b.type === "LessonBox" || b.parentId != null));
  const out = [];

  for (const [parentId, texts] of textByParent) {
    const box = boxList.find(b => String(b.id) === String(parentId));
    if (!box) continue;

    const y = numberOf(box, ["y", "top", "Y"]);
    const height = numberOf(box, ["height", "h", "Height", "H"]);
    const x = numberOf(box, ["x", "left", "X"]);
    if (y == null || height == null || x == null || height <= 0) continue;

    const start = timeFromY(y);
    const end = timeFromY(y + height);
    if (minutes(end) <= minutes(start)) continue;

    const { subject, className } = parseLessonText(texts);
    if (!subject || /^(Lunch|Uppdragstid)$/i.test(subject)) continue;

    out.push({
      day: dayFromX(x),
      start,
      end,
      subject,
      className,
      x,
      y
    });
  }

  // Fallback: if boxList uses a slightly different shape, try lessonInfo.
  walk(data, o => {
    if (!o || typeof o !== "object") return;
    const start = o.startTime ?? o.StartTime;
    const end = o.endTime ?? o.EndTime;
    const subject = o.subject ?? o.Subject;
    if (!start || !end || !subject) return;
    const a = String(start).match(/(\d{1,2}):(\d{2})/);
    const b = String(end).match(/(\d{1,2}):(\d{2})/);
    if (!a || !b) return;
    out.push({
      day: Number(o.day ?? o.dayIndex ?? 0),
      start: `${a[1].padStart(2, "0")}:${a[2]}`,
      end: `${b[1].padStart(2, "0")}:${b[2]}`,
      subject: clean(subject),
      className: clean(o.className ?? o.group ?? o.groupName ?? ""),
      x: 0,
      y: 0
    });
  });

  const seen = new Set();
  return out
    .filter(l => {
      const key = `${l.day}|${l.start}|${l.end}|${l.subject}|${l.className}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
}

async function main() {
  const keyR = await post("/get/timetable/render/key", {});
  const key = unwrap(keyR)?.key;
  if (!key) throw new Error("Skola24 gav inget renderKey.");

  const selection = process.env.SKOLA24_SELECTION || encodeGuid(SCHEMA_ID);
  const unitGuid = process.env.SKOLA24_UNIT_GUID_ENCODED || encodeGuid(UNIT_GUID);
  const now = localNow();
  const today = now.getDay() === 0 ? 6 : now.getDay() - 1;

  // This body mirrors the request captured from the live Skola24 viewer.
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
    schoolYear: SCHOOL_YEAR,
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
  const lessons = parseLessons(renderR, now);
  const todayLessons = lessons.filter(l => l.day === today).sort((a, b) => a.start.localeCompare(b.start));
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const current = todayLessons.find(l => {
    const s = minutes(l.start);
    const e = minutes(l.end);
    return s != null && e != null && nowMinutes >= s && nowMinutes < e;
  });

  // The next lesson should belong to the class Christopher is currently teaching.
  // If no lesson is active, fall back to the teacher's next lesson today.
  let next = null;
  if (current?.className) {
    next = todayLessons.find(l => minutes(l.start) > nowMinutes && l.className === current.className);
  }
  if (!next) {
    next = todayLessons.find(l => minutes(l.start) > nowMinutes);
  }

  return {
    current: current ? {
      end: current.end,
      subject: current.subject,
      className: current.className
    } : null,
    next: next ? {
      subject: next.subject,
      start: next.start
    } : null,
    updated: now.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" }),
    diagnostic: {
      teacher: TEACHER,
      schemaId: SCHEMA_ID,
      unitGuid,
      schoolYear: SCHOOL_YEAR,
      selectionType: 7,
      totalLessons: lessons.length,
      todayLessons: todayLessons.length,
      currentClass: current?.className || null
    }
  };
}

exports.handler = async () => {
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
