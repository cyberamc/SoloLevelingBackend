const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const db = new Database(path.join(__dirname, "system.db"));
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // parse login form posts

// ─── Web Page Auth (protects /bookkeeping and /notepad only; APIs stay open) ────
const AUTH_PASSWORD = process.env.SL_PASSWORD || "changeme";
const AUTH_SECRET = process.env.SL_SECRET || "sl-default-secret-change-me";

function makeAuthToken() {
  return crypto.createHmac("sha256", AUTH_SECRET).update("sl-authed").digest("hex");
}
function isValidToken(token) {
  if (!token) return false;
  const expected = makeAuthToken();
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(";").map(c => c.trim()).find(c => c.startsWith(name + "="));
  return match ? decodeURIComponent(match.split("=").slice(1).join("=")) : null;
}
function requireAuth(req, res, next) {
  if (isValidToken(getCookie(req, "sl_auth"))) return next();
  return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
}

app.get("/login", (req, res) => {
  const next = (req.query.next || "/bookkeeping").toString().replace(/"/g, "");
  const err = req.query.err ? '<div class="err">Incorrect password</div>' : '';
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Login</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a1a; color: #ddd; font-family: -apple-system, sans-serif; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { background: #12122a; border: 1px solid #2a2a3a; border-radius: 12px; padding: 32px; width: 320px; }
  h1 { color: #fff; font-size: 20px; margin-bottom: 6px; }
  .sub { color: #888; font-size: 13px; margin-bottom: 20px; }
  input { width: 100%; background: #0e0e1e; border: 1px solid #2a2a3a; border-radius: 8px; color: #fff; font-size: 15px; padding: 10px 12px; margin-bottom: 12px; }
  button { width: 100%; background: #7b8cde; border: none; border-radius: 8px; color: #fff; font-size: 15px; font-weight: bold; padding: 10px; cursor: pointer; }
  .err { color: #CF6679; font-size: 13px; margin-bottom: 12px; }
</style></head>
<body>
  <form class="card" method="POST" action="/login">
    <h1>Solo Leveling</h1>
    <div class="sub">Enter password to continue</div>
    ${err}
    <input type="hidden" name="next" value="${next}">
    <input type="password" name="password" placeholder="Password" autofocus>
    <button type="submit">Log In</button>
  </form>
</body></html>`);
});

app.post("/login", (req, res) => {
  const { password, next } = req.body;
  if (password === AUTH_PASSWORD) {
    const token = makeAuthToken();
    res.setHeader("Set-Cookie", `sl_auth=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    const dest = (next || "/bookkeeping").toString();
    return res.redirect(dest.startsWith("/") ? dest : "/bookkeeping");
  }
  return res.redirect("/login?err=1&next=" + encodeURIComponent(next || "/bookkeeping"));
});

app.get("/logout", (req, res) => {
  res.setHeader("Set-Cookie", "sl_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  res.redirect("/login");
});

// ─── Hevy Config ──────────────────────────────────────────────────────────────
const HEVY_API_KEY = "d4b36ead-42d1-4916-9055-3ddb36d123f1";
const KG_TO_LBS = 2.20462;

// ─── Player / Level Logic ─────────────────────────────────────────────────────
function calculateTotalXpForLevel(level) {
  return 100 * level * (level + 1) / 2;
}

function calculateLevelFromXp(xp) {
  let level = 1;
  while (calculateTotalXpForLevel(level + 1) <= xp) level++;
  return level;
}

function calculateRank(level) {
  if (level >= 50) return 'S';
  if (level >= 30) return 'A';
  if (level >= 20) return 'B';
  if (level >= 10) return 'C';
  if (level >= 5) return 'D';
  return 'E';
}

function getPlayer() {
  let player = db.prepare("SELECT * FROM player WHERE id = 1").get();
  if (!player) {
    db.prepare("INSERT INTO player (id, name, level, xp, rank, nofap_streak) VALUES (1, 'HUNTER', 1, 0, 'E', 0)").run();
  }
  player = db.prepare("SELECT * FROM player WHERE id = 1").get();
  const level = calculateLevelFromXp(player.xp);
  const nextLevelXp = calculateTotalXpForLevel(level + 1);
  const currentLevelXp = level === 1 ? 0 : calculateTotalXpForLevel(level);
  return {
    id: player.id,
    name: player.name,
    level: level,
    xp: player.xp,
    xpInCurrentLevel: player.xp - currentLevelXp,
    xpNeededForLevel: nextLevelXp - currentLevelXp,
    totalXp: player.xp,
    totalXpNeeded: nextLevelXp,
    rank: calculateRank(level),
    gold: player.gold,
    nofapStreak: player.nofap_streak || 0
  };
}

// ─── Quest Generation ─────────────────────────────────────────────────────────
// ─── Going-Out Protocol (temp hungover routine for Sat/Sun) ────────────────────
function initProtocol() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS protocol_routines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_type TEXT NOT NULL,          -- 'SAT' or 'SUN'
      title TEXT NOT NULL,
      time TEXT NOT NULL,
      optional INTEGER NOT NULL DEFAULT 0,
      required INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `).run();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS protocol_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      armed_date TEXT
    )
  `).run();
  if (!db.prepare("SELECT id FROM protocol_state WHERE id = 1").get()) {
    db.prepare("INSERT INTO protocol_state (id, armed_date) VALUES (1, NULL)").run();
  }
  // Sentinel weekly_quest_template row: protocol-injected required quests must reference
  // a real template id (weekly_quests.template_id is NOT NULL + FK). This hidden row
  // (weekday -1) satisfies the constraint and is excluded from normal generation.
  let sentinel = db.prepare("SELECT id FROM weekly_quest_templates WHERE title = '__PROTOCOL_SENTINEL__'").get();
  if (!sentinel) {
    db.prepare("INSERT INTO weekly_quest_templates (title, weekday, category, xp_reward, gold_reward, optional, time) VALUES ('__PROTOCOL_SENTINEL__', -1, 'STR', 0, 0, 1, NULL)").run();
  }
  // Seed routines once (only if empty)
  const count = db.prepare("SELECT COUNT(*) AS c FROM protocol_routines").get().c;
  if (count === 0) {
    const ins = db.prepare("INSERT INTO protocol_routines (day_type, title, time, optional, required, sort_order) VALUES (?, ?, ?, 0, ?, ?)");
    const SAT = [
      ["Wake Up","7:00 AM",0],["Turn Off Front & Back Yard Light","7:15 AM",0],["Put Toby In Backyard","7:15 AM",0],
      ["Add Ice To Water Jug","7:15 AM",0],["Do Towels & Clothes Laundry","7:20 AM",0],["Turn On Air Humidifier","7:25 AM",0],
      ["Make Pre-Workout","7:25 AM",0],["Make Protein Shake","7:30 AM",0],["Vape & Play Rivals","7:35 AM",0],
      ["Shower","8:05 AM",0],["Organize Quarters","8:30 AM",0],["Prepare Tomorrow's Clothes","8:35 AM",0],
      ["Walk Toby","8:40 AM",0],["Feed Toby","8:55 AM",0],["Feed Luna","9:00 AM",0],["Prepare Dinner Soda","9:05 AM",0],
      ["Prepare Food Supply","9:10 AM",1],["Meditate","9:30 AM",0],["Study","9:35 AM",0],
      ["Turn Off Air Humidifier","10:35 AM",0],["Make Breakfast","10:35 AM",0],["Make Dinner","4:00 PM",0],
      ["Make Dessert","7:00 PM",0],["Complete Daily Hydration","8:00 PM",0],["Take Evening Supplements","8:30 PM",0],
      ["Prepare Tomorrow's Hydration","8:35 PM",0],["Prepare Tomorrow's Soda","8:40 PM",0],
      ["Turn On Front & Back Yard Light","9:00 PM",0],["Walk Toby","9:00 PM",0],["You Didn't Fap Today","9:20 PM",0]
    ];
    const SUN = [
      ["Wake Up","7:00 AM",0],["Turn Off Front & Back Yard Light","7:15 AM",0],["Put Toby In Backyard","7:15 AM",0],
      ["Add Ice To Water Jug","7:15 AM",0],["Do Sheets & Blankets Laundry","7:20 AM",0],["Turn On Air Humidifier","7:25 AM",0],
      ["Make Protein Shake","7:25 AM",0],["Vape & Play Rivals","7:30 AM",0],["Shower","8:00 AM",0],
      ["Organize Quarters","8:30 AM",0],["Walk Toby","8:35 AM",0],["Take Out Trash","8:35 AM",1],
      ["Prepare Dinner Soda","8:50 AM",0],["Meditate","8:55 AM",0],["Clean Toby's Feeding Station & Refill Water","9:00 AM",1],
      ["Deep Clean Toby","9:10 AM",1],["Brush Toby","9:20 AM",0],["Brush Toby's Teeth","9:25 AM",1],
      ["Feed Toby","9:30 AM",0],["Prepare Weekly Supplements","9:35 AM",1],["Prepare Pre-Workout","9:55 AM",0],
      ["Prepare Tomorrow's Clothes","10:00 AM",0],["Feed Luna","10:00 AM",0],["Clean Volcano","10:05 AM",1],
      ["Study","10:10 AM",0],["Turn Off Air Humidifier","10:40 AM",0],["Make Breakfast","10:40 AM",0],
      ["Make Dinner","4:00 PM",0],["Make Dessert","7:00 PM",0],["Complete Daily Hydration","8:00 PM",0],
      ["Take Evening Supplements","8:30 PM",0],["Prepare Tomorrow's Hydration","8:35 PM",0],
      ["Prepare Tomorrow's Soda","8:40 PM",0],["Turn On Front & Back Yard Light","9:00 PM",0],
      ["Walk Toby","9:00 PM",0],["Prepare Water Supply","9:15 PM",0],["You Didn't Fap Today","9:20 PM",0]
    ];
    SAT.forEach((r, i) => ins.run("SAT", r[0], r[1], r[2], i + 1));
    SUN.forEach((r, i) => ins.run("SUN", r[0], r[1], r[2], i + 1));
    console.log("Protocol routines seeded");
  }
}
initProtocol();

// Cached lookup of the sentinel template id used by protocol-injected weekly quests.
let _protocolSentinelId = null;
function PROTOCOL_SENTINEL_ID() {
  if (_protocolSentinelId === null) {
    const row = db.prepare("SELECT id FROM weekly_quest_templates WHERE title = '__PROTOCOL_SENTINEL__'").get();
    _protocolSentinelId = row ? row.id : -1;
  }
  return _protocolSentinelId;
}

// Returns 'SAT'|'SUN' if the protocol is armed for today (and today is Sat/Sun), else null.
function protocolActiveDayType() {
  const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
  const st = db.prepare("SELECT armed_date FROM protocol_state WHERE id = 1").get();
  if (!st || !st.armed_date) return null;
  if (st.armed_date !== today) return null;
  const wd = db.prepare("SELECT CAST(strftime('%w', ?) AS INTEGER) AS w").get(today).w;
  if (wd === 6) return "SAT";
  if (wd === 0) return "SUN";
  return null;
}

function generateDailyQuests() {
  const today = db.prepare("SELECT date('now', 'localtime') as today").get().today;
  db.prepare("DELETE FROM quests WHERE type = 'daily' AND created_date < ?").run(today);
  const existing = db.prepare("SELECT COUNT(*) as count FROM quests WHERE created_date = ? AND type = 'daily'").get(today);
  if (existing.count === 0) {
    const protoDay = protocolActiveDayType();
    if (protoDay) {
      // Going-Out Protocol active: daily quests come from the temp routine (non-required rows)
      const protoRows = db.prepare("SELECT * FROM protocol_routines WHERE day_type = ? AND required = 0 ORDER BY sort_order").all(protoDay);
      const pins = db.prepare("INSERT INTO quests (title, type, category, xp_reward, created_date, optional, important) VALUES (?, 'daily', 'STR', 0, ?, 0, 0)");
      protoRows.forEach(r => pins.run(r.title + " @ " + r.time, today));
      console.log("Protocol daily quests generated (" + protoDay + ") for " + today);
      return;
    }
    const dayResult = db.prepare("SELECT CAST(strftime('%w', ?) AS INTEGER) as dayOfWeek").get(today);
    const dayOfWeek = dayResult.dayOfWeek;
    const isDeliveryDay = dayOfWeek === 2 || dayOfWeek === 3;
    let templates;
    if (isDeliveryDay) {
      templates = db.prepare("SELECT * FROM daily_quest_templates WHERE (tuesday_time IS NOT NULL OR wednesday_time IS NOT NULL) AND time IS NULL").all();
    } else {
      templates = db.prepare("SELECT * FROM daily_quest_templates WHERE time IS NOT NULL AND tuesday_time IS NULL AND wednesday_time IS NULL AND weekday = ?").all(dayOfWeek);
    }
    const insert = db.prepare("INSERT INTO quests (title, type, category, xp_reward, created_date, optional, important) VALUES (?, 'daily', ?, ?, ?, ?, ?)");
    templates.forEach(t => {
      let time = null;
      if (dayOfWeek === 2 && t.tuesday_time) time = t.tuesday_time;
      else if (dayOfWeek === 3 && t.wednesday_time) time = t.wednesday_time;
      else if (t.time) time = t.time;
      if (time) {
        insert.run(t.title + " @ " + time, t.category, t.xp_reward, today, t.optional, t.important || 0);
      }
    });
    console.log("Daily quests generated for " + today);
  }
}

function generateWeeklyQuests() {
  const today = db.prepare("SELECT date('now', 'localtime') as today").get().today;
  const todayWeekday = db.prepare("SELECT CAST(strftime('%w', 'now', 'localtime') AS INTEGER) as dayOfWeek").get().dayOfWeek;
  const protoDay = protocolActiveDayType();
  if (protoDay) {
    // Protocol active: required quests for today come from the temp routine, replacing
    // the normal weekly quests for this weekday. Clear only the NORMAL weeklies for today
    // (template_id != 0); protocol quests use template_id 0 and are preserved with their
    // completion state across refreshes.
    // Remove the NORMAL weekly quests for today's weekday. These persist across the week
    // with their original created_date, so the delete must NOT be scoped to created_date —
    // otherwise they survive alongside the protocol's required quests (causing duplicates).
    db.prepare("DELETE FROM weekly_quests WHERE weekday = ? AND template_id != ?").run(todayWeekday, PROTOCOL_SENTINEL_ID());
    const protoReq = db.prepare("SELECT * FROM protocol_routines WHERE day_type = ? AND required = 1 ORDER BY sort_order").all(protoDay);
    const pins = db.prepare("INSERT INTO weekly_quests (template_id, title, weekday, category, xp_reward, created_date, optional) VALUES (?, ?, ?, 'STR', 0, ?, 0)");
    protoReq.forEach(r => {
      const qt = r.title + " @ " + r.time;
      const exists = db.prepare("SELECT COUNT(*) as count FROM weekly_quests WHERE title = ? AND weekday = ? AND created_date = ?").get(qt, todayWeekday, today);
      if (exists.count === 0) pins.run(PROTOCOL_SENTINEL_ID(), qt, todayWeekday, today);
    });
    return;
  }
  // Normal path: purge any leftover protocol-injected weeklies so they don't bleed into
  // normal days via the weekday reset logic below.
  db.prepare("DELETE FROM weekly_quests WHERE template_id = ?").run(PROTOCOL_SENTINEL_ID());
  const templates = db.prepare("SELECT * FROM weekly_quest_templates WHERE title != '__PROTOCOL_SENTINEL__'").all();
  const insert = db.prepare("INSERT INTO weekly_quests (template_id, title, weekday, category, xp_reward, created_date, optional, monthly) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  // Day-of-month today (1-31) and whether today is the FIRST occurrence of its weekday
  // this calendar month (true when day-of-month <= 7).
  const domToday = parseInt(today.slice(8, 10), 10);
  const isFirstWeekdayOfMonth = domToday <= 7;
  templates.forEach(t => {
    const questTitle = t.time ? t.title + " @ " + t.time : t.title;
    // Monthly quests only generate on the first occurrence of their weekday in the month,
    // and only when that day is actually today's weekday.
    if (t.monthly) {
      if (t.weekday !== todayWeekday) return;
      if (!isFirstWeekdayOfMonth) return;
    }
    // Dedupe on title+weekday (NOT template_id): a template rebuild assigns new
    // template_ids, so matching on template_id would wrongly re-insert an existing
    // task and create duplicates. Title+weekday is the task's real identity for the day.
    const exists = db.prepare("SELECT COUNT(*) as count FROM weekly_quests WHERE title = ? AND weekday = ?").get(questTitle, t.weekday);
    if (exists.count === 0) {
      insert.run(t.id, questTitle, t.weekday, t.category, t.xp_reward, today, t.optional, t.monthly || 0);
    }
  });
  // Weekly reset: monthly quests are excluded — they should not reappear on later weeks
  // of the same month, and their once-a-month lifecycle is handled separately below.
  const resetResult = db.prepare("UPDATE weekly_quests SET completed = 0, created_date = ? WHERE weekday = ? AND created_date < ? AND monthly = 0")
    .run(today, todayWeekday, today);
  if (resetResult.changes > 0) {
    console.log("Reset " + resetResult.changes + " weekly quests for weekday " + todayWeekday);
  }
  // Monthly lifecycle: remove monthly quest rows created in a previous calendar month so
  // they regenerate fresh on the first occurrence of their weekday next month. (strftime
  // '%Y-%m' compares year-month; anything older than the current month is purged.)
  db.prepare("DELETE FROM weekly_quests WHERE monthly = 1 AND strftime('%Y-%m', created_date) < strftime('%Y-%m', ?)").run(today);
}

function checkAndUpdateStreak() {
  const today = db.prepare("SELECT date('now', 'localtime') as today").get().today;
  const yesterday = db.prepare("SELECT date('now', 'localtime', '-1 day') as yesterday").get().yesterday;
  const yesterdayWeekday = db.prepare("SELECT CAST(strftime('%w', 'now', 'localtime', '-1 day') AS INTEGER) as dow").get().dow;

  // Get all daily quests from yesterday
  const yesterdayQuests = db.prepare("SELECT * FROM quests WHERE created_date = ? AND type = 'daily'").all(yesterday);
  // Get all required (weekly) quests for yesterday's weekday
  const yesterdayRequired = db.prepare("SELECT * FROM weekly_quests WHERE weekday = ? AND optional = 0").all(yesterdayWeekday);

  const allDailyDone = yesterdayQuests.length > 0 && yesterdayQuests.every(q => q.completed === 1);
  const allRequiredDone = yesterdayRequired.length === 0 || yesterdayRequired.every(q => q.completed === 1);

  if (allDailyDone && allRequiredDone) {
    db.prepare("UPDATE player SET nofap_streak = nofap_streak + 1 WHERE id = 1").run();
    console.log("Streak incremented — all tasks completed yesterday");
  } else {
    db.prepare("UPDATE player SET nofap_streak = 0 WHERE id = 1").run();
    console.log("Streak reset — tasks not fully completed yesterday");
  }
}

function startMidnightScheduler() {
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) {
      console.log("Midnight reset triggered at " + now.toISOString());
      checkAndUpdateStreak();
      generateDailyQuests();
      generateWeeklyQuests();
    }
  }, 1000);
}

startMidnightScheduler();

// ─── Hevy Helpers ─────────────────────────────────────────────────────────────
function hevyGet(apiPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.hevyapp.com",
      path: apiPath,
      headers: { "api-key": HEVY_API_KEY }
    };
    https.get(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

function epley1RM(weightLbs, reps) {
  if (!reps || reps <= 0) return 0;
  if (reps === 1) return weightLbs;
  return Math.round(weightLbs * (1 + reps / 30));
}

// Standards for 35-year-old male at 191 lbs [beginner, novice, intermediate, advanced, elite] in lbs 1RM
const STRENGTH_STANDARDS = {
  "Bench Press (Barbell)":                      [96,  143, 191, 239, 287],
  "Squat (Barbell)":                            [143, 239, 287, 382, 478],
  "Deadlift (Barbell)":                         [191, 287, 334, 430, 525],
  "Overhead Press (Barbell)":                   [67,  96,  124, 162, 210],
  "Bent Over Row (Barbell)":                    [86,  124, 172, 229, 300],
  "Romanian Deadlift":                          [120, 182, 258, 354, 460],
  "Incline Bench Press (Barbell)":              [84,  120, 167, 229, 300],
  "Supine Press":                               [96,  143, 191, 239, 287],
  "Shoulder Press (Dumbbell)":                  [44,  66,  88,  110, 132],
  "Incline Bench Press (Dumbbell)":             [44,  66,  88,  110, 132],
  "Skullcrusher (Barbell)":                     [44,  66,  88,  110, 132],
  "Triceps Pushdown":                           [33,  55,  77,  99,  121],
  "Triceps Overhead Extension":                 [44,  66,  88,  110, 132],
  "Lean-Back Lat Pulldown":                     [77,  121, 165, 209, 253],
  "Lat Pulldown (Band)":                        [77,  121, 165, 209, 253],
  "Chest Supported Incline Row (Dumbbell)":     [55,  88,  121, 154, 187],
  "Bent Over Row (Smith Machine)":              [86,  124, 172, 229, 300],
  "Hammer Curl (Cable)":                        [33,  55,  77,  99,  121],
  "Single Arm Preacher Curl":                   [22,  44,  66,  88,  110],
  "Bayesian Cable Curl":                        [22,  44,  66,  88,  110],
  "Hack Squat (Machine)":                       [121, 198, 275, 352, 440],
  "Split Squat (Smith Machine)":                [55,  99,  143, 187, 231],
  "Lunge (Dumbbell)":                           [44,  77,  110, 143, 176],
  "Lying Leg Curl (Machine)":                   [77,  121, 165, 209, 253],
  "Seated Leg Curl (Machine)":                  [77,  121, 165, 209, 253],
  "Leg Extension (Machine)":                    [99,  154, 209, 264, 319],
  "Back Extension (Weighted Hyperextension)":   [33,  55,  88,  121, 154],
  "Calf Press (Machine)":                       [165, 253, 341, 429, 517],
  "Calf Extension (Machine)":                   [165, 253, 341, 429, 517],
  "Hip Abduction (Machine)":                    [77,  121, 165, 209, 253],
  "Ab Crunch (Machine)":                        [55,  99,  143, 187, 231],
  "Low-To-High Cable Crossover":                [22,  33,  44,  66,  88],
  "Single Arm Lateral Raise (Cable)":           [11,  22,  33,  44,  55],
  "Single Arm Rear Delt Flye (Cable)":          [11,  22,  33,  44,  55],
  "Paused Shrug-In (Cable)":                    [99,  154, 209, 264, 319],
};

function getStrengthInfo(title, oneRM) {
  const s = STRENGTH_STANDARDS[title];
  if (!s) return null;
  const tiers = [
    { label: "Beginner",     lo: 0,    hi: s[0], pLo: 0,  pHi: 15 },
    { label: "Novice",       lo: s[0], hi: s[1], pLo: 15, pHi: 30 },
    { label: "Intermediate", lo: s[1], hi: s[2], pLo: 30, pHi: 50 },
    { label: "Advanced",     lo: s[2], hi: s[3], pLo: 50, pHi: 70 },
    { label: "Elite",        lo: s[3], hi: s[4], pLo: 70, pHi: 90 },
  ];
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (oneRM <= t.hi || i === tiers.length - 1) {
      const range = t.hi - t.lo;
      const frac = range > 0 ? Math.min(1, (oneRM - t.lo) / range) : 1;
      const percentile = Math.round(t.pLo + frac * (t.pHi - t.pLo));
      return { level: t.label, percentile };
    }
  }
  return { level: "Elite", percentile: 90 };
}

// ─── Quest Endpoints ──────────────────────────────────────────────────────────
app.get("/api/player", (req, res) => {
  res.json(getPlayer());
});

app.get("/api/quests", (req, res) => {
  // Auto-disarm: clear protocol once its armed date is in the past.
  db.prepare("UPDATE protocol_state SET armed_date = NULL WHERE armed_date IS NOT NULL AND armed_date < date('now','localtime')").run();
  generateDailyQuests();
  generateWeeklyQuests();
  const today = db.prepare("SELECT date('now', 'localtime') as today").get().today;
  const daily = db.prepare("SELECT * FROM quests WHERE created_date = ? AND type = 'daily' ORDER BY id").all(today);
  const weekly = db.prepare("SELECT * FROM weekly_quests ORDER BY weekday, optional, completed").all();
  const req_weekly = weekly.filter(q => !q.optional);
  // Protocol state for the main Tasks screen: activeToday = recovery routine is live now;
  // armedDay = armed for an upcoming day (banner). Both derived from armed_date.
  const protoToday = protocolActiveDayType(); // 'SAT'|'SUN'|null when armed_date == today
  const protoState = db.prepare("SELECT armed_date FROM protocol_state WHERE id = 1").get();
  let armedDay = null;
  if (protoState && protoState.armed_date) {
    const awd = db.prepare("SELECT CAST(strftime('%w', ?) AS INTEGER) AS w").get(protoState.armed_date).w;
    armedDay = awd === 6 ? "SAT" : (awd === 0 ? "SUN" : null);
  }
  res.json({
    dailyQuests: daily,
    weeklyQuests: weekly,
    dailiesCompleted: daily.filter(q => q.completed && !q.optional).length,
    totalDailies: daily.filter(q => !q.optional).length,
    weekliesCompleted: req_weekly.filter(q => q.completed).length,
    hasWeeklyQuests: req_weekly.length > 0,
    protocol: {
      activeToday: protoToday,                       // 'SAT'|'SUN'|null — recovery routine live today
      armedDay: armedDay,                            // 'SAT'|'SUN'|null — armed target
      armedDate: protoState ? protoState.armed_date : null
    }
  });
});

// ─── Going-Out Protocol API ────────────────────────────────────────────────────
// GET state: whether armed and for what date/day; plus which day_type arming now would target.
app.get("/api/protocol", (req, res) => {
  const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
  const todayWd = db.prepare("SELECT CAST(strftime('%w', ?) AS INTEGER) AS w").get(today).w;
  const st = db.prepare("SELECT armed_date FROM protocol_state WHERE id = 1").get();
  // Arming is only allowed Fri (5) or Sat (6) night, targeting tomorrow (Sat or Sun).
  let armable = null;
  if (todayWd === 5) armable = "SAT";
  else if (todayWd === 6) armable = "SUN";
  // Resolve armed state to a day label if still in the future/today.
  let armedDay = null;
  if (st && st.armed_date) {
    const awd = db.prepare("SELECT CAST(strftime('%w', ?) AS INTEGER) AS w").get(st.armed_date).w;
    armedDay = awd === 6 ? "SAT" : (awd === 0 ? "SUN" : null);
  }
  res.json({ armedDate: st ? st.armed_date : null, armedDay, armable, today });
});

// POST arm: arms the protocol for tomorrow. Only valid Fri->Sat or Sat->Sun.
app.post("/api/protocol/arm", (req, res) => {
  const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
  const todayWd = db.prepare("SELECT CAST(strftime('%w', ?) AS INTEGER) AS w").get(today).w;
  if (todayWd !== 5 && todayWd !== 6) {
    return res.status(400).json({ error: "Protocol can only be armed on Friday or Saturday night." });
  }
  const tomorrow = db.prepare("SELECT date('now','localtime','+1 day') AS d").get().d;
  db.prepare("UPDATE protocol_state SET armed_date = ? WHERE id = 1").run(tomorrow);
  const twd = db.prepare("SELECT CAST(strftime('%w', ?) AS INTEGER) AS w").get(tomorrow).w;
  res.json({ success: true, armedDate: tomorrow, armedDay: twd === 6 ? "SAT" : "SUN" });
});

// POST disarm: clears the armed state.
app.post("/api/protocol/disarm", (req, res) => {
  db.prepare("UPDATE protocol_state SET armed_date = NULL WHERE id = 1").run();
  res.json({ success: true });
});

app.get("/api/weekly-quests/all", (req, res) => {
  generateWeeklyQuests();
  const todayWeekday = db.prepare("SELECT CAST(strftime('%w', 'now', 'localtime') AS INTEGER) as dayOfWeek").get().dayOfWeek;
  const all = db.prepare("SELECT wq.* FROM weekly_quests wq ORDER BY wq.weekday, wq.optional, wq.completed").all();
  const withOverdue = all.map(q => ({
    ...q,
    isOverdue: q.completed === 0 && q.optional === 0 && q.weekday !== todayWeekday ? 1 : 0
  }));
  res.json(withOverdue);
});

// Read-only: full routine for a given weekday (0=Sun..6=Sat) from templates.
// Returns daily + required(weekly) quests merged, sorted by time. Does not touch live quests.
app.get("/api/routine/:weekday", (req, res) => {
  const wd = parseInt(req.params.weekday, 10);
  if (isNaN(wd) || wd < 0 || wd > 6) return res.status(400).json({ error: "weekday must be 0-6" });

  // Daily templates for this day
  let dailyTemplates;
  if (wd === 2 || wd === 3) {
    // Delivery days: templates that have tuesday_time/wednesday_time set
    const col = wd === 2 ? 'tuesday_time' : 'wednesday_time';
    dailyTemplates = db.prepare(
      `SELECT * FROM daily_quest_templates WHERE ${col} IS NOT NULL AND time IS NULL`
    ).all().map(t => ({ ...t, _time: wd === 2 ? t.tuesday_time : t.wednesday_time }));
  } else {
    dailyTemplates = db.prepare(
      "SELECT * FROM daily_quest_templates WHERE time IS NOT NULL AND tuesday_time IS NULL AND wednesday_time IS NULL AND weekday = ?"
    ).all(wd).map(t => ({ ...t, _time: t.time }));
  }

  const daily = dailyTemplates.map(t => ({
    id: t.id,
    title: t.title,
    time: t._time,
    category: t.category,
    xp_reward: t.xp_reward,
    optional: t.optional,
    important: t.important || 0,
    kind: 'daily'
  }));

  // Required (weekly) templates for this day
  const weeklyTemplates = db.prepare(
    "SELECT * FROM weekly_quest_templates WHERE weekday = ?"
  ).all(wd);
  const required = weeklyTemplates.map(t => ({
    id: t.id,
    title: t.title,
    time: t.time,
    category: t.category,
    xp_reward: t.xp_reward,
    optional: t.optional,
    monthly: t.monthly || 0,
    kind: 'required'
  }));

  // Merge and sort by time (parse "6 AM" / "9:15 AM" to minutes)
  const toMinutes = (s) => {
    if (!s) return 9999;
    const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
    if (!m) return 9999;
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3].toUpperCase();
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return h * 60 + min;
  };
  const all = [...daily, ...required].sort((a, b) => toMinutes(a.time) - toMinutes(b.time));

  res.json({
    weekday: wd,
    dailyCount: daily.filter(q => !q.optional).length,
    requiredCount: required.filter(q => !q.optional).length,
    quests: all
  });
});

app.post("/api/quests/:id/complete", (req, res) => {
  const quest = db.prepare("SELECT * FROM quests WHERE id = ?").get(req.params.id);
  db.prepare("UPDATE quests SET completed = 1 WHERE id = ?").run(req.params.id);
  db.prepare("UPDATE player SET xp = xp + ? WHERE id = 1").run(quest.xp_reward);
  res.json({ success: true, xpGained: quest.xp_reward });
});

app.post("/api/quests/:id/uncomplete", (req, res) => {
  const quest = db.prepare("SELECT * FROM quests WHERE id = ?").get(req.params.id);
  db.prepare("UPDATE quests SET completed = 0 WHERE id = ?").run(req.params.id);
  db.prepare("UPDATE player SET xp = xp - ? WHERE id = 1").run(quest.xp_reward);
  res.json({ success: true, xpLost: quest.xp_reward });
});

app.post("/api/weekly-quests/:id/complete", (req, res) => {
  const quest = db.prepare("SELECT * FROM weekly_quests WHERE id = ?").get(req.params.id);
  db.prepare("UPDATE weekly_quests SET completed = 1 WHERE id = ?").run(req.params.id);
  db.prepare("UPDATE player SET xp = xp + ? WHERE id = 1").run(quest.xp_reward);
  res.json({ success: true, xpGained: quest.xp_reward });
});

app.post("/api/weekly-quests/:id/uncomplete", (req, res) => {
  const quest = db.prepare("SELECT * FROM weekly_quests WHERE id = ?").get(req.params.id);
  db.prepare("UPDATE weekly_quests SET completed = 0 WHERE id = ?").run(req.params.id);
  db.prepare("UPDATE player SET xp = xp - ? WHERE id = 1").run(quest.xp_reward);
  res.json({ success: true, xpLost: quest.xp_reward });
});

// ─── Gym Helpers ──────────────────────────────────────────────────────────────
async function buildExerciseMap() {
  const [p1, p2] = await Promise.all([
    hevyGet("/v1/workouts?page=1&pageSize=10"),
    hevyGet("/v1/workouts?page=2&pageSize=10"),
  ]);
  const workouts = [...(p1.workouts || []), ...(p2.workouts || [])];
  const map = {};
  for (const w of workouts) {
    const date = (w.start_time || "").split("T")[0];
    for (const ex of (w.exercises || [])) {
      const id = ex.exercise_template_id;
      if (!id) continue;
      const normalSets = (ex.sets || []).filter(s => s.type === "normal" && s.weight_kg > 0 && s.reps > 0);
      if (!normalSets.length) continue;
      const bestSet = normalSets.reduce((b, s) =>
        epley1RM(s.weight_kg * KG_TO_LBS, s.reps) > epley1RM(b.weight_kg * KG_TO_LBS, b.reps) ? s : b
      );
      const weightLbs = Math.round(bestSet.weight_kg * KG_TO_LBS);
      if (!map[id]) map[id] = { title: ex.title, sessions: [] };
      map[id].sessions.push({ date, weightLbs, reps: bestSet.reps });
    }
  }
  return { map, workouts };
}

function buildExerciseStats(id, fallbackTitle, exerciseMap) {
  const data = exerciseMap[id];
  const title = (data && data.title) || fallbackTitle;
  if (!data || !data.sessions.length) return {
    exercise_template_id: id, title,
    session_count: 0, best_weight_lbs: 0, best_reps: 0, estimated_1rm_lbs: 0,
    is_plateaued: false, sessions_at_current_weight: 0, last_pr_date: "",
    recent_gain_lbs: 0, strength_level: null, strength_percentile: null,
  };
  const { sessions } = data;
  const best = sessions.reduce((b, s) => s.weightLbs > b.weightLbs ? s : b);
  const oneRM = epley1RM(best.weightLbs, best.reps);
  const strength = getStrengthInfo(title, oneRM);
  const currentMax = sessions[0].weightLbs;
  let sessionsAtCurrentWeight = 0;
  for (const s of sessions) {
    if (s.weightLbs >= currentMax) sessionsAtCurrentWeight++;
    else break;
  }
  let lastPrDate = sessions[0].date;
  for (let i = 0; i < sessions.length - 1; i++) {
    if (sessions[i].weightLbs > sessions[i + 1].weightLbs) { lastPrDate = sessions[i].date; break; }
  }
  return {
    exercise_template_id: id, title,
    session_count: sessions.length, best_weight_lbs: best.weightLbs, best_reps: best.reps,
    estimated_1rm_lbs: oneRM, is_plateaued: sessionsAtCurrentWeight >= 3,
    sessions_at_current_weight: sessionsAtCurrentWeight, last_pr_date: lastPrDate,
    recent_gain_lbs: sessions.length >= 2 ? sessions[0].weightLbs - sessions[1].weightLbs : 0,
    strength_level: strength ? strength.level : null,
    strength_percentile: strength ? strength.percentile : null,
  };
}

// ─── Gym Endpoints ────────────────────────────────────────────────────────────
app.get("/api/gym/summary", async (req, res) => {
  try {
    const { map: exerciseMap } = await buildExerciseMap();
    const results = Object.keys(exerciseMap)
      .map(id => buildExerciseStats(id, exerciseMap[id].title, exerciseMap))
      .sort((a, b) => b.session_count - a.session_count);
    res.json(results);
  } catch (e) {
    console.error("Hevy /summary error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/gym/routines", async (req, res) => {
  try {
    const [{ map: exerciseMap, workouts }, r1, r2, r3, r4, r5, r6] = await Promise.all([
      buildExerciseMap(),
      hevyGet("/v1/routines?page=1&pageSize=10"),
      hevyGet("/v1/routines?page=2&pageSize=10"),
      hevyGet("/v1/routines?page=3&pageSize=10"),
      hevyGet("/v1/routines?page=4&pageSize=10"),
      hevyGet("/v1/routines?page=5&pageSize=10"),
      hevyGet("/v1/routines?page=6&pageSize=10"),
    ]);
    const routines = [
      ...(r1.routines || []), ...(r2.routines || []), ...(r3.routines || []),
      ...(r4.routines || []), ...(r5.routines || []), ...(r6.routines || []),
    ];
    let currentWeek = 0;
    for (const w of workouts.slice(0, 5)) {
      const m = (w.title || "").match(/Week\s+(\d+)/i);
      if (m) { currentWeek = parseInt(m[1]); break; }
    }
    const result = routines
      .filter(r => {
        if (currentWeek > 0) {
          const m = (r.title || "").match(/Week\s+(\d+)/i);
          return m ? parseInt(m[1]) === currentWeek : false;
        }
        return recentRoutineIds.has(r.id);
      })
      .map(r => ({
        routine_id: r.id,
        title: r.title,
        exercises: (r.exercises || []).map(ex =>
          buildExerciseStats(ex.exercise_template_id, ex.title, exerciseMap)
        ),
      }));
    res.json(result);
  } catch (e) {
    console.error("Hevy /routines error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/gym/history/:exerciseId", async (req, res) => {
  try {
    const data = await hevyGet("/v1/exercise_history/" + req.params.exerciseId + "?page=1&pageSize=10");
    const history = (data.exercise_history || []).map(entry => {
      const sets = (entry.sets || []).filter(s => s.weight_kg > 0 && s.reps > 0);
      if (!sets.length) return null;
      const best = sets.reduce((b, s) =>
        epley1RM(s.weight_kg * KG_TO_LBS, s.reps) > epley1RM(b.weight_kg * KG_TO_LBS, b.reps) ? s : b
      );
      const weightLbs = Math.round(best.weight_kg * KG_TO_LBS);
      return {
        date: entry.workout_date || "",
        weight_lbs: weightLbs,
        reps: best.reps,
        estimated_1rm_lbs: epley1RM(weightLbs, best.reps),
      };
    }).filter(Boolean);
    res.json(history);
  } catch (e) {
    console.error("Hevy /history error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Notepad (single shared scratchpad) ───────────────────────────────────────
function initNotepad() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS notepad (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      content TEXT NOT NULL DEFAULT ''
    )
  `).run();
  const row = db.prepare("SELECT id FROM notepad WHERE id = 1").get();
  if (!row) {
    db.prepare("INSERT INTO notepad (id, content) VALUES (1, '')").run();
  }
}
initNotepad();

app.get("/api/notepad", (req, res) => {
  const row = db.prepare("SELECT content FROM notepad WHERE id = 1").get();
  res.json({ content: row ? row.content : '' });
});

app.patch("/api/notepad", (req, res) => {
  const { content } = req.body;
  db.prepare("UPDATE notepad SET content = ? WHERE id = 1").run(content ?? '');
  res.json({ success: true });
});

// ─── NoFap Notepad (separate single shared scratchpad) ─────────────────────────
function initNofapNotepad() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS nofap_notepad (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      content TEXT NOT NULL DEFAULT ''
    )
  `).run();
  const row = db.prepare("SELECT id FROM nofap_notepad WHERE id = 1").get();
  if (!row) {
    db.prepare("INSERT INTO nofap_notepad (id, content) VALUES (1, '')").run();
  }
}
initNofapNotepad();

app.get("/api/nofap-notepad", (req, res) => {
  const row = db.prepare("SELECT content FROM nofap_notepad WHERE id = 1").get();
  res.json({ content: row ? row.content : '' });
});

app.patch("/api/nofap-notepad", (req, res) => {
  const { content } = req.body;
  db.prepare("UPDATE nofap_notepad SET content = ? WHERE id = 1").run(content ?? '');
  res.json({ success: true });
});

// ─── Side Tasks (separate single shared scratchpad) ────────────────────────────
function initSideTasks() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS side_tasks (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      content TEXT NOT NULL DEFAULT ''
    )
  `).run();
  const row = db.prepare("SELECT id FROM side_tasks WHERE id = 1").get();
  if (!row) {
    db.prepare("INSERT INTO side_tasks (id, content) VALUES (1, '')").run();
  }
}
initSideTasks();

app.get("/api/side-tasks", (req, res) => {
  const row = db.prepare("SELECT content FROM side_tasks WHERE id = 1").get();
  res.json({ content: row ? row.content : '' });
});

app.patch("/api/side-tasks", (req, res) => {
  const { content } = req.body;
  db.prepare("UPDATE side_tasks SET content = ? WHERE id = 1").run(content ?? '');
  res.json({ success: true });
});

// ─── Food Inventory ───────────────────────────────────────────────────────────
function initFoodInventory() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS food_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 3
    )
  `).run();
  const count = db.prepare("SELECT COUNT(*) as count FROM food_inventory").get();
  if (count.count === 0) {
    const insert = db.prepare("INSERT INTO food_inventory (name, source, level) VALUES (?, ?, 3)");
    const items = [
      ["Member's Mark Natural Pecan Halves, 32 oz.", "Sam's Club"],
      ["Member's Mark 80/20 Ground Beef Roll, Vacuum Pack", "Sam's Club"],
      ["Member's Mark Boneless and Skinless Chicken Breast", "Sam's Club"],
      ["Member's Mark USDA Choice Angus Beef Sirloin Tip Steak, Thin Sliced", "Sam's Club"],
      ["Fresh Large Grade AA Eggs 5 dozen", "Sam's Club"],
      ["Multi Bell Sweet Peppers, 6 ct.", "Sam's Club"],
      ["Yellow Onions, 10 lbs.", "Sam's Club"],
      ["Member's Mark Minced Garlic, 48 oz.", "Sam's Club"],
      ["Member's Mark Mexican Style Finely Shredded Cheese 2 pk.", "Sam's Club"],
      ["Member's Mark Pure Olive Oil, 101 fl. oz.", "Sam's Club"],
      ["Member's Mark Unsalted Sweet Cream Butter Sticks, 4 oz., 16 ct.", "Sam's Club"],
      ["Hershey's Cocoa 100% Cacao Natural Unsweetened, 23 oz.", "Sam's Club"],
      ["Member's Mark Thyme Leaves, 8.25 oz.", "Sam's Club"],
      ["Whole White Mushrooms 24 oz.", "Sam's Club"],
      ["Member's Mark 91% Isopropyl Alcohol, 32 fl. oz., 2 pk.", "Sam's Club"],
      ["Member's Mark Restaurant Coarse Black Pepper, 18 oz.", "Sam's Club"],
      ["Member's Mark Mediterranean Sea Salt Grinder, 14.9 oz.", "Sam's Club"],
      ["Member's Mark Himalayan Pink Salt, 38 oz.", "Sam's Club"],
      ["Swerve Ultimate Sugar Replacement Sweetener", "Amazon"],
    ];
    items.forEach(([name, source]) => insert.run(name, source));
    console.log("Food inventory seeded with " + items.length + " items");
  }
}

// ─── Household Inventory ──────────────────────────────────────────────────────
function initHouseholdInventory() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS household_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 3
    )
  `).run();
  const count = db.prepare("SELECT COUNT(*) as count FROM household_inventory").get();
  if (count.count === 0) {
    const insert = db.prepare("INSERT INTO household_inventory (name, level) VALUES (?, 3)");
    const items = [
      "NIVEA MEN Maximum Hydration Body Lotion",
      "Nutricost Electrolyte Complex Powder (120 Servings)",
      "Protein Powder (4 LBS)",
      "Blue Buffalo Dry Adult Dog Food 4.15 lb Bag",
      "Body Wash",
      "OxiClean Odor Blasters & Stain Remover",
      "Tide Pods (112 Pods)",
      "Kleenex (8 Pack)",
      "Brawny Tear-A-Square Paper Towels (12 Rolls)",
      "Dove Men Deodorant (4 Pack)",
      "Dryer Sheets",
      "JOHNNY B. Mode Professional Hair Styling Gel 64 Oz",
      "Pantene Shampoo and Conditioner Set",
      "Scotch-Brite Zero Scratch Scrub Sponges (6 Pack)",
      "Philips G2 Toothbrush Heads (5 Pack)",
      "The Pink Stuff Spray (3 Pack)",
      "GLAD Drawstring Trash Bags (140 Count)",
      "Q-Tips (2 Pack)",
      "Hefty Small Trash Bags 4 Gallon (52 Count)",
      "Toilet Paper",
      "Blue Buffalo Wet Dog Food 12.5 Oz (12 Pack)",
      "Pup-Peroni Dog Treats, Prime Rib Flavor, 38 Oz Bag",
      "Dawn Platinum Plus PowerSuds Liquid Dish Soap, 51.5 oz. Refill",
      "Hand Soaps (6 Pack)",
    ];
    items.forEach(name => insert.run(name));
    console.log("Household inventory seeded with " + items.length + " items");
  }
}

initFoodInventory();
initHouseholdInventory();

app.get("/api/food-inventory", (req, res) => {
  const items = db.prepare("SELECT * FROM food_inventory ORDER BY level ASC, name ASC").all();
  res.json(items);
});

app.patch("/api/food-inventory/:id", (req, res) => {
  const { level } = req.body;
  if (level === undefined || level < 0 || level > 3) {
    return res.status(400).json({ error: "level must be 0-3" });
  }
  db.prepare("UPDATE food_inventory SET level = ? WHERE id = ?").run(level, req.params.id);
  const item = db.prepare("SELECT * FROM food_inventory WHERE id = ?").get(req.params.id);
  res.json(item);
});

app.get("/api/household-inventory", (req, res) => {
  const items = db.prepare("SELECT * FROM household_inventory ORDER BY level ASC, name ASC").all();
  res.json(items);
});

app.patch("/api/household-inventory/:id", (req, res) => {
  const { level } = req.body;
  if (level === undefined || level < 0 || level > 3) {
    return res.status(400).json({ error: "level must be 0-3" });
  }
  db.prepare("UPDATE household_inventory SET level = ? WHERE id = ?").run(level, req.params.id);
  const item = db.prepare("SELECT * FROM household_inventory WHERE id = ?").get(req.params.id);
  res.json(item);
});

// ─── Supplement Inventory ─────────────────────────────────────────────────────
function initSupplementInventory() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS supplement_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 3
    )
  `).run();
}

initSupplementInventory();

app.get("/api/supplement-inventory", (req, res) => {
  const items = db.prepare("SELECT * FROM supplement_inventory ORDER BY name ASC").all();
  res.json(items);
});

app.patch("/api/supplement-inventory/:id", (req, res) => {
  const { level } = req.body;
  if (level === undefined || level < 0 || level > 3) {
    return res.status(400).json({ error: "level must be 0-3" });
  }
  db.prepare("UPDATE supplement_inventory SET level = ? WHERE id = ?").run(level, req.params.id);
  const item = db.prepare("SELECT * FROM supplement_inventory WHERE id = ?").get(req.params.id);
  res.json(item);
});

// ─── Bookkeeping ──────────────────────────────────────────────────────────────

// Counts toward Total Income: paychecks + Plasma (+ SpeedX delivery, added separately)
const FIXED_INCOME = {
  'IT Check 1': 620,
  'IT Check 2': 620,
  'IT Check 3': 620,
  'IT Check 4': 620,
  'Plasma': 520
};

// Per-card income labels only — NOT counted in Total Income.
// People and Subscriptions intentionally excluded: People shows a live "Owed" total
// (computed from its bills) and Subscriptions shows only its bills total.
const GROUP_INCOME_LABELS = {
  ...FIXED_INCOME
};

const GROUP_ORDER = [
  'IT Check 1', 'IT Check 2', 'IT Check 3', 'IT Check 4', 'People',
  'SpeedX Check 1', 'SpeedX Check 2', 'SpeedX Check 3', 'SpeedX Check 4',
  'Subscriptions'
];

app.get("/api/bookkeeping", (req, res) => {
  ensureCurrentMonth();
  const months = db.prepare("SELECT * FROM bookkeeping_months ORDER BY month DESC").all();
  res.json(months);
});

// Auto-set autopay bills to PAID on/after their due date.
// Due day is parsed from the bill name, e.g. "Amazon Prime (14th)" -> 14.
// Guard: only act when the viewed month is the current calendar month or earlier
// (never pre-pay a future month). Only flips bills not already PAID.
function autopayCatchUp(monthId, monthStr) {
  const today = db.prepare("SELECT date('now','localtime') AS d").get().d; // YYYY-MM-DD
  const curYm = today.slice(0, 7);
  if (monthStr > curYm) return; // future month: don't pre-pay
  const todayDay = parseInt(today.slice(8, 10), 10);
  // If viewing a past month, every due date has already passed.
  const pastMonth = monthStr < curYm;
  const bills = db.prepare(
    "SELECT id, name, status FROM bookkeeping_bills WHERE month_id = ? AND autopay = 1 AND status != 'PAID'"
  ).all(monthId);
  const upd = db.prepare("UPDATE bookkeeping_bills SET status = 'PAID' WHERE id = ?");
  const tx = db.transaction(() => {
    bills.forEach(b => {
      const m = b.name.match(/\((\d{1,2})(?:st|nd|rd|th)\)/i);
      if (!m) return;
      const dueDay = parseInt(m[1], 10);
      if (pastMonth || todayDay >= dueDay) upd.run(b.id);
    });
  });
  tx();
}

app.get("/api/bookkeeping/:monthId", (req, res) => {
  const month = db.prepare("SELECT * FROM bookkeeping_months WHERE id = ?").get(req.params.monthId);
  if (!month) return res.status(404).json({ error: "Month not found" });
  autopayCatchUp(month.id, month.month);
  const bills = db.prepare("SELECT * FROM bookkeeping_bills WHERE month_id = ? ORDER BY sort_order").all(req.params.monthId);

  // Ensure this month's delivery weeks exist, then compute SpeedX from them
  generateDeliveryWeeksForMonth(month.id, month.month);
  const speedxChecks = speedxByCheckForMonth(month.id);
  const speedxTotal = Math.round(Object.values(speedxChecks).reduce((a, b) => a + b, 0) * 100) / 100;

  const groups = {};
  bills.forEach(b => {
    if (!groups[b.group_name]) groups[b.group_name] = [];
    groups[b.group_name].push(b);
  });

  res.json({ month, bills, groups, speedxTotal, speedxByCheck: speedxChecks, incomeLabels: GROUP_INCOME_LABELS, fixedIncome: FIXED_INCOME });
});

// Ensure a bookkeeping month exists for the current calendar month (by today's date).
// Seeds it with the previous month's bills (reset to NOT PAID) and its delivery weeks.
function ensureCurrentMonth() {
  const ym = db.prepare("SELECT strftime('%Y-%m', date('now','localtime')) AS ym").get().ym;
  let month = db.prepare("SELECT * FROM bookkeeping_months WHERE month = ?").get(ym);
  if (!month) {
    db.prepare("INSERT INTO bookkeeping_months (month, speedx_amount) VALUES (?, 0)").run(ym);
    month = db.prepare("SELECT * FROM bookkeeping_months WHERE month = ?").get(ym);
    seedBillsFromPreviousMonth(month.id, month.month);
    generateDeliveryWeeksForMonth(month.id, month.month);
  }
  return month;
}

// Update a month's notes
app.patch("/api/bookkeeping/:monthId/notes", (req, res) => {
  const { notes } = req.body;
  const month = db.prepare("SELECT * FROM bookkeeping_months WHERE id = ?").get(req.params.monthId);
  if (!month) return res.status(404).json({ error: "Month not found" });
  db.prepare("UPDATE bookkeeping_months SET notes = ? WHERE id = ?").run(notes ?? '', month.id);
  res.json({ success: true });
});

// Delete a month and all its bills + delivery weeks
app.delete("/api/bookkeeping/:monthId", (req, res) => {
  const month = db.prepare("SELECT * FROM bookkeeping_months WHERE id = ?").get(req.params.monthId);
  if (!month) return res.status(404).json({ error: "Month not found" });
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM bookkeeping_bills WHERE month_id = ?").run(month.id);
    db.prepare("DELETE FROM delivery_weeks WHERE month_id = ?").run(month.id);
    db.prepare("DELETE FROM bookkeeping_months WHERE id = ?").run(month.id);
  });
  tx();
  res.json({ success: true });
});

// Copy all bills from the most recent month before `newMonth` into the new month,
// resetting every status to 'NOT PAID'. No-op if there's no earlier month or bills already exist.
function seedBillsFromPreviousMonth(newMonthId, newMonthStr) {
  const existing = db.prepare("SELECT COUNT(*) AS c FROM bookkeeping_bills WHERE month_id = ?").get(newMonthId);
  if (existing.c > 0) return;
  const prev = db.prepare(
    "SELECT * FROM bookkeeping_months WHERE month < ? ORDER BY month DESC LIMIT 1"
  ).get(newMonthStr);
  if (!prev) return;
  const srcBills = db.prepare("SELECT * FROM bookkeeping_bills WHERE month_id = ? ORDER BY sort_order").all(prev.id);
  const insert = db.prepare(
    "INSERT INTO bookkeeping_bills (month_id, group_name, name, amount, status, sort_order, autopay) VALUES (?, ?, ?, ?, 'NOT PAID', ?, ?)"
  );
  const tx = db.transaction(() => {
    srcBills.forEach(b => insert.run(newMonthId, b.group_name, b.name, b.amount, b.sort_order, b.autopay ? 1 : 0));
  });
  tx();
}

app.post("/api/bookkeeping", (req, res) => {
  const { month } = req.body;
  if (!month) return res.status(400).json({ error: "month required" });
  try {
    db.prepare("INSERT INTO bookkeeping_months (month, speedx_amount) VALUES (?, 0)").run(month);
    const newMonth = db.prepare("SELECT * FROM bookkeeping_months WHERE month = ?").get(month);
    seedBillsFromPreviousMonth(newMonth.id, newMonth.month);
    generateDeliveryWeeksForMonth(newMonth.id, newMonth.month);
    res.json(newMonth);
  } catch (e) {
    res.status(400).json({ error: "Month already exists" });
  }
});

app.patch("/api/bookkeeping/bills/:id", (req, res) => {
  const { status, amount } = req.body;
  const bill = db.prepare("SELECT * FROM bookkeeping_bills WHERE id = ?").get(req.params.id);
  if (!bill) return res.status(404).json({ error: "Bill not found" });
  db.prepare("UPDATE bookkeeping_bills SET status = ?, amount = ? WHERE id = ?")
    .run(status ?? bill.status, amount ?? bill.amount, req.params.id);
  res.json(db.prepare("SELECT * FROM bookkeeping_bills WHERE id = ?").get(req.params.id));
});

// ─── Bookkeeping Web UI ───────────────────────────────────────────────────────
app.get("/notepad", requireAuth, (req, res) => {
  const row = db.prepare("SELECT content FROM notepad WHERE id = 1").get();
  const content = (row ? row.content : '').replace(/</g, '&lt;');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Notepad</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a1a; color: #ddd; font-family: -apple-system, sans-serif; padding: 16px; }
  h1 { color: #fff; font-size: 24px; margin-bottom: 4px; }
  .subtitle { color: #888; font-size: 13px; margin-bottom: 20px; }
  textarea { width: 100%; min-height: 70vh; background: #12122a; border: 1px solid #2a2a3a; border-radius: 8px; color: #fff; font-size: 15px; padding: 14px; resize: both; font-family: inherit; line-height: 1.5; }
  .save { margin-top: 12px; background: #1a2a1a; border: 1px solid #2a3a2a; color: #4CAF50; padding: 8px 22px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: bold; }
  .save:hover { background: #24382a; }
  .toast { position: fixed; bottom: 20px; right: 20px; background: #4CAF50; color: #fff; padding: 10px 18px; border-radius: 8px; font-size: 13px; display: none; z-index: 999; }
</style>
</head>
<body>
<h1>Notepad</h1>
<div class="subtitle">Solo Leveling Scratchpad · <span id="save-status">Saved</span> · <a href="/logout" style="color:#7b8cde;">Log out</a></div>
<textarea id="note" placeholder="Type your notes here...">${content}</textarea>
<script>
const noteEl = document.getElementById('note');
const statusEl = document.getElementById('save-status');
let saveTimer = null;
let lastSaved = noteEl.value;

function doSave() {
  const content = noteEl.value;
  if (content === lastSaved) return;
  statusEl.textContent = 'Saving...';
  return fetch('/api/notepad', {
    method: 'PATCH',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({content})
  }).then(() => { lastSaved = content; statusEl.textContent = 'Saved'; })
    .catch(() => { statusEl.textContent = 'Save failed'; });
}
noteEl.addEventListener('input', () => {
  statusEl.textContent = 'Editing...';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 1500);
});
// Save on exit (navigating away / closing tab)
window.addEventListener('beforeunload', () => {
  if (noteEl.value !== lastSaved) {
    navigator.sendBeacon('/api/notepad', new Blob([JSON.stringify({content: noteEl.value})], {type: 'application/json'}));
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && noteEl.value !== lastSaved) doSave();
});
</script>
</body>
</html>`;
  res.send(html);
});

app.get("/side-tasks", requireAuth, (req, res) => {
  const row = db.prepare("SELECT content FROM side_tasks WHERE id = 1").get();
  const content = (row ? row.content : '').replace(/</g, '&lt;');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Side Tasks</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a1a; color: #ddd; font-family: -apple-system, sans-serif; padding: 16px; }
  h1 { color: #fff; font-size: 24px; margin-bottom: 4px; }
  .subtitle { color: #888; font-size: 13px; margin-bottom: 20px; }
  textarea { width: 100%; min-height: 70vh; background: #12122a; border: 1px solid #2a2a3a; border-radius: 8px; color: #fff; font-size: 15px; padding: 14px; resize: both; font-family: inherit; line-height: 1.5; }
  .save { margin-top: 12px; background: #1a2a1a; border: 1px solid #2a3a2a; color: #4CAF50; padding: 8px 22px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: bold; }
  .save:hover { background: #24382a; }
  .toast { position: fixed; bottom: 20px; right: 20px; background: #4CAF50; color: #fff; padding: 10px 18px; border-radius: 8px; font-size: 13px; display: none; z-index: 999; }
</style>
</head>
<body>
<h1>Side Tasks</h1>
<div class="subtitle">Solo Leveling Scratchpad · <span id="save-status">Saved</span> · <a href="/logout" style="color:#7b8cde;">Log out</a></div>
<textarea id="note" placeholder="Type your side tasks here...">${content}</textarea>
<script>
const noteEl = document.getElementById('note');
const statusEl = document.getElementById('save-status');
let saveTimer = null;
let lastSaved = noteEl.value;

function doSave() {
  const content = noteEl.value;
  if (content === lastSaved) return;
  statusEl.textContent = 'Saving...';
  return fetch('/api/side-tasks', {
    method: 'PATCH',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({content})
  }).then(() => { lastSaved = content; statusEl.textContent = 'Saved'; })
    .catch(() => { statusEl.textContent = 'Save failed'; });
}
noteEl.addEventListener('input', () => {
  statusEl.textContent = 'Editing...';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 1500);
});
// Save on exit (navigating away / closing tab)
window.addEventListener('beforeunload', () => {
  if (noteEl.value !== lastSaved) {
    navigator.sendBeacon('/api/side-tasks', new Blob([JSON.stringify({content: noteEl.value})], {type: 'application/json'}));
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && noteEl.value !== lastSaved) doSave();
});
</script>
</body>
</html>`;
  res.send(html);
});

app.get("/bookkeeping", requireAuth, (req, res) => {
  ensureCurrentMonth();
  const months = db.prepare("SELECT * FROM bookkeeping_months ORDER BY month DESC").all();
  const todayYm = db.prepare("SELECT strftime('%Y-%m', date('now','localtime')) AS ym").get().ym;
  const currentMonth = req.query.month
    ? months.find(m => String(m.id) === String(req.query.month)) || months[0]
    : (months.find(m => m.month === todayYm) || months[0]);
  if (!currentMonth) return res.send("<h1>No months found</h1>");

  const bills = db.prepare("SELECT * FROM bookkeeping_bills WHERE month_id = ? ORDER BY sort_order").all(currentMonth.id);

  // Ensure this month's delivery weeks exist, then compute SpeedX from them
  generateDeliveryWeeksForMonth(currentMonth.id, currentMonth.month);
  const speedxChecks = speedxByCheckForMonth(currentMonth.id);
  const speedxTotal = Math.round(Object.values(speedxChecks).reduce((a, b) => a + b, 0) * 100) / 100;

  const groups = {};
  bills.forEach(b => {
    if (!groups[b.group_name]) groups[b.group_name] = [];
    groups[b.group_name].push(b);
  });

  const totalIncome = Object.values(FIXED_INCOME).reduce((a, b) => a + b, 0) + speedxTotal;
  const totalExpenses = bills.filter(b => b.status !== 'ON HOLD' && b.group_name !== 'People').reduce((sum, b) => sum + b.amount, 0);
  const paidExpenses = bills.filter(b => b.status === 'PAID' || b.status === 'AUTOPAY').reduce((sum, b) => sum + b.amount, 0);

  const statusColors = { 'PAID': '#4CAF50', 'NOT PAID': '#888', 'AUTOPAY': '#D4B84A', 'ON HOLD': '#8B4513' };
  const statuses = ['NOT PAID', 'PAID', 'AUTOPAY', 'ON HOLD'];

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bookkeeping — ${(() => { const [yy, mm] = currentMonth.month.split('-'); return ['January','February','March','April','May','June','July','August','September','October','November','December'][parseInt(mm,10)-1] + ' ' + yy; })()}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a1a; color: #ddd; font-family: -apple-system, sans-serif; padding: 16px; }
  h1 { color: #fff; font-size: 24px; margin-bottom: 4px; }
  .subtitle { color: #888; font-size: 13px; margin-bottom: 20px; }
  .summary { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
  .summary-box { background: #12122a; border-radius: 8px; padding: 14px 20px; flex: 0 0 auto; min-width: 140px; }
  .summary-box .label { font-size: 11px; color: #888; margin-bottom: 4px; }
  .summary-box .value { font-size: 20px; font-weight: bold; }
  .notes-box { min-width: 240px; max-width: none; }
  .notes-input { width: 100%; min-height: 48px; margin-top: 6px; background: #0e0e1e; border: 1px solid #2a2a3a; border-radius: 6px; color: #fff; font-size: 13px; padding: 6px 8px; resize: both; font-family: inherit; }
  .notes-save { margin-top: 6px; background: #1a2a1a; border: 1px solid #2a3a2a; color: #4CAF50; padding: 4px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; }
  .notes-save:hover { background: #24382a; }
  .grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 16px; align-items: start; }
  .card { background: #12122a; border-radius: 10px; padding: 14px; }
  .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .card-title { font-size: 14px; font-weight: bold; color: #7b8cde; }
  .card-income { font-size: 13px; color: #4CAF50; font-weight: bold; }
  .bill-row { display: flex; align-items: center; padding: 8px 0; border-bottom: 1px solid #1a1a2e; gap: 8px; }
  .bill-row:last-child { border-bottom: none; }
  .bill-name { font-size: 13px; color: #ccc; flex: 1; }
  .autopay-badge { font-size: 9px; font-weight: bold; color: #D4B84A; background: #D4B84A22; border: 1px solid #D4B84A44; border-radius: 4px; padding: 1px 5px; margin-left: 6px; letter-spacing: 0.5px; vertical-align: middle; }
  .bill-amount { font-size: 13px; color: #fff; font-weight: 600; min-width: 48px; text-align: right; }
  .bill-amount input { background: #0e0e1e; border: 1px solid #2a2a3a; border-radius: 4px; color: #fff; font-size: 13px; width: 70px; padding: 4px 6px; text-align: right; }
  .status-btn { border: none; border-radius: 6px; padding: 4px 0; font-size: 11px; font-weight: bold; cursor: pointer; white-space: nowrap; width: 80px; text-align: center; }
  .month-selector { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
  .month-chip { display: inline-flex; align-items: stretch; border-radius: 6px; overflow: hidden; border: 1px solid #2a2a3a; }
  .month-chip.active { border-color: #7b8cde; }
  .month-btn { background: #12122a; border: none; color: #ccc; padding: 6px 12px; cursor: pointer; font-size: 13px; }
  .month-btn.active { background: #7b8cde; color: #fff; }
  .month-del { background: #12122a; border: none; border-left: 1px solid #2a2a3a; color: #888; padding: 6px 9px; cursor: pointer; font-size: 13px; line-height: 1; }
  .month-del:hover { background: #3a1a1a; color: #CF6679; }
  .new-month { background: #1a2a1a; border: 1px solid #2a3a2a; color: #4CAF50; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .toast { position: fixed; bottom: 20px; right: 20px; background: #4CAF50; color: #fff; padding: 10px 18px; border-radius: 8px; font-size: 13px; display: none; z-index: 999; }
  .remaining { font-size: 11px; color: #888; margin-top: 6px; }
</style>
</head>
<body>
<h1>Bookkeeping</h1>
<div class="subtitle">Solo Leveling Finance Tracker · <a href="/logout" style="color:#7b8cde;">Log out</a></div>

<div class="month-selector">
  ${months.slice().sort((a, b) => a.month.localeCompare(b.month)).map(m => {
    const [yy, mm] = m.month.split('-');
    const mn = ['January','February','March','April','May','June','July','August','September','October','November','December'][parseInt(mm,10)-1];
    const label = `${mn} ${yy}`;
    return `<span class="month-chip ${m.id === currentMonth.id ? 'active' : ''}">`
      + `<button class="month-btn ${m.id === currentMonth.id ? 'active' : ''}" onclick="location.href='/bookkeeping?month=${m.id}'">${label}</button>`
      + `<button class="month-del" title="Delete ${label}" onclick="deleteMonth(${m.id}, '${label}')">×</button>`
      + `</span>`;
  }).join('')}
</div>

<div class="summary">
  <div class="summary-box"><div class="label">Total Income</div><div class="value" style="color:#4CAF50">$${totalIncome.toFixed(2)}</div></div>
  <div class="summary-box"><div class="label">Total Expenses</div><div class="value" style="color:#CF6679">$${totalExpenses.toFixed(2)}</div></div>
  <div class="summary-box"><div class="label">Plasma</div><div class="value" style="color:#4CAF50">$520.00</div></div>
  <div class="summary-box notes-box">
    <div class="label">Notes · <span id="notes-status" style="color:#4CAF50;">Saved</span></div>
    <textarea id="month-notes" class="notes-input" placeholder="Add a note..." data-month="${currentMonth.id}">${(currentMonth.notes || '').replace(/</g, '&lt;')}</textarea>
  </div>
</div>

<div class="grid">`;

  const allGroups = [...GROUP_ORDER, ...Object.keys(groups).filter(g => !GROUP_ORDER.includes(g) && g !== 'Plasma')];

  // People reimbursements fund the Subscriptions bucket; compute the People total
  // (live sum of People bills, excluding ON HOLD) to display on the Subscriptions card.
  const peopleFunding = (groups['People'] || [])
    .filter(b => b.status !== 'ON HOLD')
    .reduce((sum, b) => sum + b.amount, 0);

  allGroups.forEach(groupName => {
    const groupBills = groups[groupName];
    if (!groupBills) return;
    const income = (groupName in speedxChecks) ? speedxChecks[groupName] : (GROUP_INCOME_LABELS[groupName] ?? null);
    const groupTotal = groupBills.filter(b => b.status !== 'ON HOLD').reduce((sum, b) => sum + b.amount, 0);
    const remaining = (income !== null && groupName !== 'People' && groupName !== 'Subscriptions') ? income - groupTotal
      : (groupName === 'Subscriptions' ? peopleFunding - groupTotal : null);

    html += `<div class="card">
      <div class="card-header">
        <div class="card-title">${groupName}</div>
        ${income ? `<div class="card-income">$${income.toFixed(0)} income · $${groupTotal.toFixed(0)} bills</div>` : (groupName === 'People' ? `<div class="card-income" style="color:#4CAF50">Owed: $${groupTotal.toFixed(0)}</div>` : (groupName === 'Subscriptions' ? `<div class="card-income" style="color:#4CAF50">$${peopleFunding.toFixed(0)} from People · $${groupTotal.toFixed(0)} bills</div>` : (groupTotal > 0 ? `<div class="card-income" style="color:#888">$${groupTotal.toFixed(0)} bills</div>` : '')))}
      </div>`;

    groupBills.forEach(bill => {
      const color = statusColors[bill.status] || '#888';
      html += `<div class="bill-row">
        <span class="bill-name">${bill.name}${bill.autopay ? '<span class="autopay-badge">AUTOPAY</span>' : ''}</span>
        <input type="number" value="${bill.amount}" onchange="updateAmount(${bill.id}, this.value)" style="background:#0e0e1e;border:1px solid #2a2a3a;border-radius:4px;color:#fff;font-size:12px;flex:0 0 65px;box-sizing:border-box;width:65px;padding:3px 5px;text-align:right;">
        <button class="status-btn" style="background:${color}22;color:${color};border:1px solid ${color}44" onclick="cycleStatus(${bill.id}, this)">${bill.status}</button>
      </div>`;
    });

    if (remaining !== null) {
      html += `<div class="remaining">Remaining after bills: $${remaining.toFixed(2)}</div>`;
    }

    html += `</div>`;
  });

  html += `</div>
<div class="toast" id="toast">Saved ✓</div>
<script>
const statuses = ${JSON.stringify(statuses)};
const statusColors = ${JSON.stringify(statusColors)};

function showToast() {
  const t = document.getElementById('toast');
  t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 1500);
}

function cycleStatus(id, btn) {
  const cur = btn.textContent.trim();
  const next = statuses[(statuses.indexOf(cur) + 1) % statuses.length];
  fetch('/api/bookkeeping/bills/' + id, {
    method: 'PATCH',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({status: next})
  }).then(() => {
    btn.textContent = next;
    const color = statusColors[next];
    btn.style.background = color + '22';
    btn.style.color = color;
    btn.style.borderColor = color + '44';
    showToast();
  });
}

function updateAmount(id, amount) {
  fetch('/api/bookkeeping/bills/' + id, {
    method: 'PATCH',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({amount: parseFloat(amount)})
  }).then(() => showToast());
}

function createMonth() {
  const month = prompt('Enter month (YYYY-MM):');
  if (!month) return;
  fetch('/api/bookkeeping', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({month})
  }).then(r => r.json()).then(data => {
    if (data.error) alert(data.error);
    else location.href = '/bookkeeping?month=' + data.id;
  });
}

function deleteMonth(id, label) {
  if (!confirm('Delete ' + label + '? This removes its bills and delivery weeks. This cannot be undone.')) return;
  fetch('/api/bookkeeping/' + id, { method: 'DELETE' })
    .then(r => r.json()).then(() => { location.href = '/bookkeeping'; });
}

// Bookkeeping notes autosave (debounced + on exit)
(function () {
  const ta = document.getElementById('month-notes');
  const statusEl = document.getElementById('notes-status');
  if (!ta) return;
  const monthId = ta.getAttribute('data-month');
  let saveTimer = null;
  let lastSaved = ta.value;

  function doSave() {
    const notes = ta.value;
    if (notes === lastSaved) return;
    if (statusEl) statusEl.textContent = 'Saving...';
    return fetch('/api/bookkeeping/' + monthId + '/notes', {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({notes})
    }).then(() => { lastSaved = notes; if (statusEl) statusEl.textContent = 'Saved'; })
      .catch(() => { if (statusEl) statusEl.textContent = 'Save failed'; });
  }
  ta.addEventListener('input', () => {
    if (statusEl) statusEl.textContent = 'Editing...';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 1500);
  });
  window.addEventListener('beforeunload', () => {
    if (ta.value !== lastSaved) {
      navigator.sendBeacon('/api/bookkeeping/' + monthId + '/notes',
        new Blob([JSON.stringify({notes: ta.value})], {type: 'application/json'}));
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && ta.value !== lastSaved) doSave();
  });

  // Remember the notes box size across page loads (per browser)
  try {
    const saved = JSON.parse(localStorage.getItem('notesBoxSize') || 'null');
    if (saved && saved.w && saved.h) { ta.style.width = saved.w; ta.style.height = saved.h; }
  } catch (e) {}
  const obs = new ResizeObserver(() => {
    try { localStorage.setItem('notesBoxSize', JSON.stringify({ w: ta.style.width, h: ta.style.height })); } catch (e) {}
  });
  obs.observe(ta);
})();
</script>
</body>
</html>`;

  res.send(html);
});

// ─── Delivery Tracker ─────────────────────────────────────────────────────────
function initDeliveryTracker() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS delivery_weeks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start TEXT NOT NULL UNIQUE,
      month_id INTEGER,
      check_number INTEGER,
      tue_delivered INTEGER NOT NULL DEFAULT 0,
      tue_duplicates INTEGER NOT NULL DEFAULT 0,
      tue_undeliverable INTEGER NOT NULL DEFAULT 0,
      wed_delivered INTEGER NOT NULL DEFAULT 0,
      wed_duplicates INTEGER NOT NULL DEFAULT 0,
      wed_undeliverable INTEGER NOT NULL DEFAULT 0
    )
  `).run();

  // Migration: add columns if upgrading an existing table
  const cols = db.prepare("PRAGMA table_info(delivery_weeks)").all().map(c => c.name);
  if (!cols.includes('month_id')) {
    db.prepare("ALTER TABLE delivery_weeks ADD COLUMN month_id INTEGER").run();
  }
  if (!cols.includes('check_number')) {
    db.prepare("ALTER TABLE delivery_weeks ADD COLUMN check_number INTEGER").run();
  }

  // Migration: add notes column to bookkeeping_months
  const mcols = db.prepare("PRAGMA table_info(bookkeeping_months)").all().map(c => c.name);
  if (!mcols.includes('notes')) {
    db.prepare("ALTER TABLE bookkeeping_months ADD COLUMN notes TEXT DEFAULT ''").run();
  }

  // Migration: add autopay flag to bookkeeping_bills (badge + auto-PAID-on-due-date)
  const bcols = db.prepare("PRAGMA table_info(bookkeeping_bills)").all().map(c => c.name);
  if (!bcols.includes('autopay')) {
    db.prepare("ALTER TABLE bookkeeping_bills ADD COLUMN autopay INTEGER NOT NULL DEFAULT 0").run();
  }

  // Migration: add per-day Route 324 rate toggles to delivery_weeks
  const dcols = db.prepare("PRAGMA table_info(delivery_weeks)").all().map(c => c.name);
  if (!dcols.includes('tue_route324')) {
    db.prepare("ALTER TABLE delivery_weeks ADD COLUMN tue_route324 INTEGER NOT NULL DEFAULT 0").run();
  }
  if (!dcols.includes('wed_route324')) {
    db.prepare("ALTER TABLE delivery_weeks ADD COLUMN wed_route324 INTEGER NOT NULL DEFAULT 0").run();
  }

  // Migration: add 'important' flag to daily quests (amber "Don't Skip" badge, reusable)
  const dqtCols = db.prepare("PRAGMA table_info(daily_quest_templates)").all().map(c => c.name);
  if (!dqtCols.includes('important')) {
    db.prepare("ALTER TABLE daily_quest_templates ADD COLUMN important INTEGER NOT NULL DEFAULT 0").run();
  }
  const qCols = db.prepare("PRAGMA table_info(quests)").all().map(c => c.name);
  if (!qCols.includes('important')) {
    db.prepare("ALTER TABLE quests ADD COLUMN important INTEGER NOT NULL DEFAULT 0").run();
  }

  // Migration: 'monthly' flag — a required quest that fires only on the first occurrence
  // of its weekday each calendar month (e.g. first Thursday). Gets a distinct Monthly badge.
  const wqtCols = db.prepare("PRAGMA table_info(weekly_quest_templates)").all().map(c => c.name);
  if (!wqtCols.includes('monthly')) {
    db.prepare("ALTER TABLE weekly_quest_templates ADD COLUMN monthly INTEGER NOT NULL DEFAULT 0").run();
  }
  const wqCols = db.prepare("PRAGMA table_info(weekly_quests)").all().map(c => c.name);
  if (!wqCols.includes('monthly')) {
    db.prepare("ALTER TABLE weekly_quests ADD COLUMN monthly INTEGER NOT NULL DEFAULT 0").run();
  }
}

initDeliveryTracker();

// One-time backfill: tag existing delivery weeks to their correct month by pay date,
// and ensure each existing bookkeeping month has its weeks generated.
// Auto-creates a month if an existing week's pay date falls in a month that doesn't exist yet
// (e.g. a Jun 14 week pays in July -> creates July so its data is preserved).
(function backfillDeliveryWeeks() {
  try {
    const orphanWeeks = db.prepare("SELECT * FROM delivery_weeks WHERE month_id IS NULL").all();
    orphanWeeks.forEach(w => {
      const ym = payMonthFor(w.week_start);
      let month = db.prepare("SELECT * FROM bookkeeping_months WHERE month = ?").get(ym);
      if (!month) {
        db.prepare("INSERT INTO bookkeeping_months (month, speedx_amount) VALUES (?, 0)").run(ym);
        month = db.prepare("SELECT * FROM bookkeeping_months WHERE month = ?").get(ym);
      }
    });
    // Generate/normalize weeks for every existing month, and seed bills for any empty month
    const allMonths = db.prepare("SELECT * FROM bookkeeping_months").all();
    allMonths.forEach(m => {
      generateDeliveryWeeksForMonth(m.id, m.month);
      seedBillsFromPreviousMonth(m.id, m.month);
    });
  } catch (e) {
    console.error("Delivery week backfill error:", e.message);
  }
})();

function getWeekStart(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const diff = d.getDate() - day;
  const sunday = new Date(d);
  sunday.setDate(diff);
  return sunday.toISOString().split('T')[0];
}

// Billable pay for a single delivery week row
function weekBillable(w) {
  const tueBillable = Math.max(0, w.tue_delivered - w.tue_duplicates - w.tue_undeliverable);
  const wedBillable = Math.max(0, w.wed_delivered - w.wed_duplicates - w.wed_undeliverable);
  const tueRate = w.tue_route324 ? 1.90 : 1.60;
  const wedRate = w.wed_route324 ? 1.90 : 1.60;
  return tueBillable * tueRate + wedBillable * wedRate;
}

// Pay date for a delivery week = that week's Wednesday (week_start + 3) + 16 days
function payDateFor(weekStartStr) {
  const d = new Date(weekStartStr + 'T12:00:00');
  d.setDate(d.getDate() + 3 + 16);
  return d.toISOString().split('T')[0];
}

// The month (YYYY-MM) a delivery week belongs to = month its pay date falls in
function payMonthFor(weekStartStr) {
  return payDateFor(weekStartStr).slice(0, 7);
}

// All week_start Sundays whose pay date falls in the given YYYY-MM, in date order
function weekStartsForMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const firstOfMonth = new Date(Date.UTC(y, m - 1, 1, 12));
  const scan = new Date(firstOfMonth);
  scan.setUTCDate(scan.getUTCDate() - 56);
  while (scan.getUTCDay() !== 0) scan.setUTCDate(scan.getUTCDate() + 1);
  const out = [];
  const cur = new Date(scan);
  for (let i = 0; i < 16; i++) {
    const ws = cur.toISOString().split('T')[0];
    if (payMonthFor(ws) === ym) out.push(ws);
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return out;
}

// Ensure a bookkeeping month has its delivery weeks generated (check_number 1..N in date order).
// Reuses any existing delivery_weeks row with a matching week_start (preserves entered data).
function generateDeliveryWeeksForMonth(monthId, ym) {
  const starts = weekStartsForMonth(ym);
  starts.forEach((ws, idx) => {
    const checkNumber = idx + 1;
    const existing = db.prepare("SELECT * FROM delivery_weeks WHERE week_start = ?").get(ws);
    if (existing) {
      db.prepare("UPDATE delivery_weeks SET month_id = ?, check_number = ? WHERE week_start = ?")
        .run(monthId, checkNumber, ws);
    } else {
      db.prepare("INSERT INTO delivery_weeks (week_start, month_id, check_number) VALUES (?, ?, ?)")
        .run(ws, monthId, checkNumber);
    }
  });
}

// Returns the SpeedX Check label -> billable amount map for a specific month
function speedxByCheckForMonth(monthId) {
  const weeks = db.prepare("SELECT * FROM delivery_weeks WHERE month_id = ? ORDER BY check_number").all(monthId);
  const map = {};
  weeks.forEach(w => {
    map['SpeedX Check ' + w.check_number] = Math.round(weekBillable(w) * 100) / 100;
  });
  return map;
}

// Delivery weeks for a given bookkeeping month (generates them if missing).
// If no month specified, default to the most recent bookkeeping month.
app.get("/api/delivery-weeks", (req, res) => {
  let month;
  if (req.query.month_id) {
    month = db.prepare("SELECT * FROM bookkeeping_months WHERE id = ?").get(req.query.month_id);
  } else {
    month = db.prepare("SELECT * FROM bookkeeping_months ORDER BY month DESC LIMIT 1").get();
  }
  if (!month) return res.json([]);
  generateDeliveryWeeksForMonth(month.id, month.month);
  const weeks = db.prepare("SELECT * FROM delivery_weeks WHERE month_id = ? ORDER BY check_number").all(month.id);
  res.json(weeks);
});

app.patch("/api/delivery-weeks/:id", (req, res) => {
  const { tue_delivered, tue_duplicates, tue_undeliverable, wed_delivered, wed_duplicates, wed_undeliverable, tue_route324, wed_route324 } = req.body;
  const week = db.prepare("SELECT * FROM delivery_weeks WHERE id = ?").get(req.params.id);
  if (!week) return res.status(404).json({ error: "Week not found" });
  db.prepare(`
    UPDATE delivery_weeks SET
      tue_delivered = ?,
      tue_duplicates = ?,
      tue_undeliverable = ?,
      wed_delivered = ?,
      wed_duplicates = ?,
      wed_undeliverable = ?,
      tue_route324 = ?,
      wed_route324 = ?
    WHERE id = ?
  `).run(
    tue_delivered ?? week.tue_delivered,
    tue_duplicates ?? week.tue_duplicates,
    tue_undeliverable ?? week.tue_undeliverable,
    wed_delivered ?? week.wed_delivered,
    wed_duplicates ?? week.wed_duplicates,
    wed_undeliverable ?? week.wed_undeliverable,
    (tue_route324 ?? week.tue_route324) ? 1 : 0,
    (wed_route324 ?? week.wed_route324) ? 1 : 0,
    req.params.id
  );
  res.json(db.prepare("SELECT * FROM delivery_weeks WHERE id = ?").get(req.params.id));
});

app.delete("/api/delivery-weeks/:id", (req, res) => {
  db.prepare("DELETE FROM delivery_weeks WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(3743, "0.0.0.0", () => {
  console.log("Solo Leveling on 3743");
});