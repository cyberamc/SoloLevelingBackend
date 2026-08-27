require('dotenv').config({ path: __dirname + '/.env', override: true });
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
// Key lives in .env (HEVY_API_KEY=...) so it is never committed to git.
const HEVY_API_KEY = process.env.HEVY_API_KEY || "";
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
function generateDailyQuests() {
  const today = db.prepare("SELECT date('now', 'localtime') as today").get().today;
  db.prepare("DELETE FROM quests WHERE type = 'daily' AND created_date < ?").run(today);
  const existing = db.prepare("SELECT COUNT(*) as count FROM quests WHERE created_date = ? AND type = 'daily'").get(today);
  if (existing.count === 0) {
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
  const templates = db.prepare("SELECT * FROM weekly_quest_templates").all();
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
  // The 00:00 minute lasts 60 ticks, so without a latch this fired the rollover 60
  // times a night — incrementing or zeroing the streak once per second. Record the
  // date we last ran and skip if it has already happened today.
  let lastRunDate = null;
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) {
      const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
      if (lastRunDate === today) return; // already rolled over today
      lastRunDate = today;
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

// ─── Plateau Analyzer ─────────────────────────────────────────────────────────
// Scans recent Hevy workouts after each new session and writes suggestions into
// gym_suggestions, surfaced read-only in the Gym tab. Three signals:
//   1. e1RM trend flat/negative over the last N sessions for a lift
//   2. Rep-target miss  — top set failing to clear the block's prescribed top rep
//   3. Volume / frequency — tonnage well below trailing average, or muscle gone stale
// Tuning knobs live in PA_CONFIG.
const PA_CONFIG = {
  window: 5,          // sessions per lift used for the trend fit
  flatSlopeLbs: 1.0,  // <= this slope (lbs/session) counts as flat
  minSessions: 3,     // need at least this many sessions before judging a lift
  repMissCount: 2,    // this many misses inside the window flags the lift
  dropPct: 0.20,      // tonnage this far below trailing average flags the group
  staleDays: 6        // days without training a group before a frequency flag
};

// Rep targets by block. Value = the TOP of the heaviest (lowest-rep) prescription
// for that exercise in that block, since the analyzer compares against the top set.
// Exercises whose reps aren't a load proxy (failure sets, bodyweight lever
// progressions) are deliberately absent so the rep signal skips them.
const PA_REP_TARGETS = [
  { // Block 1 - Weeks 1-4
    "Chest Press (Machine)": 6,
    "Chest Press (Cable)": 12,
    "Lat Pulldown (Machine)": 8,
    "Single Arm Lat Pulldown (Machine)": 12,
    "Seated Shoulder Press (Machine)": 10,
    "Seated Cable Row - V Grip (Cable)": 10,
    "Overhead Triceps Extension (Cable)": 15,
    "Bicep Curl (Cable)": 15,
    "Bayesian Cable Curl": 15,
    "Triceps Pressdown": 15,
    "Single Arm Lateral Raise (Cable)": 15,
    "Face Pull": 12,
    "Hack Squat (Machine)": 6,
    "Leg Press (Machine)": 6,
    "Leg Press Horizontal (Machine)": 6,
    "Seated Leg Curl (Machine)": 12,
    "Calf Extension (Machine)": 12,
    "Leg Extension (Machine)": 12,
    "Romanian Deadlift (Barbell)": 12,
    "Romanian Deadlift (Smith Machine)": 12,
    "Decline Crunch (Weighted)": 15
  },
  { // Block 2 - Weeks 5-8 (arms move to 15-20 rep work)
    "Chest Press (Machine)": 8,
    "Lat Pulldown (Machine)": 10,
    "Single Arm Lat Pulldown (Machine)": 12,
    "Seated Cable Row - V Grip (Cable)": 10,
    "Seated Row (Machine)": 12,
    "Seated Shoulder Press (Machine)": 10,
    "Bicep Curl (Cable)": 20,
    "Overhead Triceps Extension (Cable)": 20,
    "Bayesian Cable Curl": 15,
    "Triceps Pressdown": 15,
    "Single Arm Lateral Raise (Cable)": 15,
    "Rear Delt Reverse Fly (Machine)": 15,
    "Hack Squat (Machine)": 8,
    "Leg Press (Machine)": 12,
    "Leg Press Horizontal (Machine)": 12,
    "Lying Leg Curl (Machine)": 12,
    "Calf Extension (Machine)": 15,
    "Leg Extension (Machine)": 15,
    "Romanian Deadlift (Barbell)": 12,
    "Romanian Deadlift (Smith Machine)": 12,
    "Decline Crunch (Weighted)": 12
  },
  { // Block 3 - Weeks 9-12
    "Chest Press (Machine)": 6,
    "Chest Press (Cable)": 12,
    "Lat Pulldown (Machine)": 10,
    "Single Arm Lat Pulldown (Machine)": 12,
    "Seated Row (Machine)": 12,
    "Seated Shoulder Press (Machine)": 12,
    "Overhead Triceps Extension (Cable)": 15,
    "Bicep Curl (Cable)": 15,
    "Bayesian Cable Curl": 12,
    "Triceps Pressdown": 12,
    "Single Arm Lateral Raise (Cable)": 12,
    "Rear Delt Reverse Fly (Machine)": 20,
    "Hack Squat (Machine)": 6,
    "Leg Press (Machine)": 10,
    "Leg Press Horizontal (Machine)": 10,
    "Lying Leg Curl (Machine)": 10,
    "Calf Extension (Machine)": 12,
    "Leg Extension (Machine)": 15,
    "Romanian Deadlift (Barbell)": 12,
    "Romanian Deadlift (Smith Machine)": 12,
    "Decline Crunch (Weighted)": 15
  }
];
// Reps aren't a load proxy on these, so the rep-target signal skips them:
// Dragon Flag, Kneeling Push Up, Push Up - Close Grip.

// Which 4-week block is active right now (0/1/2), from the same rotation start
// date the Gym tab uses so targets stay in sync with the routines shown.
function paActiveBlockIndex() {
  return paBlockInfo().blockIndex;
}

// Current block index plus the date that block began. Analysis is confined to the
// current block: each block prescribes different rep ranges and loads (Block 2
// deliberately drops arm loads for 15-20 rep work), so comparing sessions across
// a block boundary reads a planned deload as a plateau.
function paBlockInfo() {
  const startRow = db.prepare("SELECT start_date FROM gym_rotation WHERE id = 1").get();
  const startDate = startRow ? startRow.start_date : "2026-07-06";
  const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
  const daysElapsed = db.prepare("SELECT CAST(julianday(?) - julianday(?) AS INTEGER) AS n").get(today, startDate).n;
  const cycleDay = ((daysElapsed % 84) + 84) % 84;
  const blockIndex = Math.floor(cycleDay / 28);
  // Days since the current 28-day block started -> that block's first date.
  const daysIntoBlock = cycleDay % 28;
  const blockStart = db.prepare("SELECT date(?, '-' || ? || ' days') AS d").get(today, daysIntoBlock).d;
  return { blockIndex, blockStart, daysIntoBlock };
}

// Hevy's workout payload does NOT carry primary_muscle_group, so the volume signal
// needs a title -> muscle map built from /v1/exercise_templates. Cached in memory and
// refreshed lazily; falls back to "other" for anything unmapped.
let _paMuscleMap = null;
async function paMuscleMap() {
  if (_paMuscleMap) return _paMuscleMap;
  const map = {};
  try {
    for (let page = 1; page <= 10; page++) {
      const data = await hevyGet("/v1/exercise_templates?page=" + page + "&pageSize=100");
      const list = data.exercise_templates || [];
      list.forEach(t => {
        if (t.title) map[t.title] = t.primary_muscle_group || "other";
      });
      if (!data.page_count || page >= data.page_count) break;
    }
  } catch (e) {
    console.error("exercise_templates lookup:", e.message);
  }
  _paMuscleMap = map;
  return map;
}

// ISO-ish week key (YYYY-Www) so tonnage can be bucketed by week.
function paWeekKey(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  const day = (d.getDay() + 6) % 7;          // Mon=0
  d.setDate(d.getDate() - day);              // back to Monday
  return d.toISOString().slice(0, 10);
}

function paRepTarget(exerciseTitle, blockIndex) {
  const table = PA_REP_TARGETS[blockIndex] || {};
  return table[exerciseTitle] ?? null;
}

// Least-squares slope of y over evenly spaced sessions. Null if under 2 points.
function paSlope(values) {
  const n = values.length;
  if (n < 2) return null;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  values.forEach((y, i) => {
    num += (i - meanX) * (y - meanY);
    den += (i - meanX) * (i - meanX);
  });
  return den === 0 ? null : num / den;
}

// Flatten Hevy workouts (newest-first) into per-exercise session series and
// per-muscle-group tonnage, oldest -> newest. Warmup sets are dropped.
function paNormalize(workouts, muscleMap) {
  const bySeries = {};   // exercise title -> [{date, bestE1rm, topReps, topWeight}]
  const byGroup = {};    // muscle group   -> [{date, tonnage}]
  const ordered = workouts.slice().sort((a, b) =>
    new Date(a.start_time) - new Date(b.start_time));

  ordered.forEach(w => {
    const date = (w.start_time || "").slice(0, 10);
    const groupTonnage = {};
    (w.exercises || []).forEach(ex => {
      const working = (ex.sets || []).filter(s => s.type !== "warmup");
      if (working.length === 0) return;
      const title = ex.title;
      const group = ex.primary_muscle_group || (muscleMap && muscleMap[title]) || "other";

      let best = { e1rm: 0, reps: 0, weight: 0 };
      let tonnage = 0;
      working.forEach(s => {
        const lbs = (s.weight_kg || 0) * KG_TO_LBS;
        const reps = s.reps || 0;
        tonnage += lbs * reps;
        const e = epley1RM(lbs, reps);
        if (e > best.e1rm) best = { e1rm: e, reps: reps, weight: Math.round(lbs) };
      });

      if (best.e1rm > 0) {
        if (!bySeries[title]) bySeries[title] = [];
        bySeries[title].push({ date, bestE1rm: best.e1rm, topReps: best.reps, topWeight: best.weight });
      }
      groupTonnage[group] = (groupTonnage[group] || 0) + tonnage;
    });
    Object.keys(groupTonnage).forEach(g => {
      if (!byGroup[g]) byGroup[g] = [];
      byGroup[g].push({ date, tonnage: Math.round(groupTonnage[g]) });
    });
  });
  return { bySeries, byGroup };
}

// Signals 1 and 2 for a single lift.
function paAnalyzeExercise(title, sessions, blockIndex) {
  const out = [];
  const recent = sessions.slice(-PA_CONFIG.window);
  if (recent.length < PA_CONFIG.minSessions) return out;

  // 1. e1RM trend
  const slope = paSlope(recent.map(s => s.bestE1rm));
  if (slope !== null && slope <= PA_CONFIG.flatSlopeLbs) {
    const negative = slope < 0;
    out.push({
      exercise: title,
      muscle_group: null,
      signal: "e1rm_flat",
      severity: negative ? "high" : "medium",
      detail: "Estimated 1RM " + (negative ? "declining" : "flat") + " over " + recent.length +
              " sessions (" + slope.toFixed(1) + " lbs/session). Best now ~" +
              recent[recent.length - 1].bestE1rm + " lbs.",
      fix: negative
        ? "Deload ~10% and rebuild for 2-3 sessions, or swap to a variation for a block."
        : "Add a rep before adding load. If it stays flat 2 more sessions, deload ~10% and rebuild."
    });
  }

  // 2. Rep-target miss
  const target = paRepTarget(title, blockIndex);
  if (target !== null) {
    const misses = recent.filter(s => s.topReps < target).length;
    if (misses >= PA_CONFIG.repMissCount) {
      const lastReps = recent[recent.length - 1].topReps;
      const short = target - lastReps;
      out.push({
        exercise: title,
        muscle_group: null,
        signal: "rep_target_miss",
        severity: misses >= recent.length ? "high" : "medium",
        detail: "Top set missed the " + target + "-rep target in " + misses + " of the last " +
                recent.length + " sessions (last: " + lastReps + " reps).",
        // Missing by a rep or two is a grind-it-out problem; missing by 3+ means the load
        // is wrong for this block's rep range, so lighten rather than chase reps.
        fix: short >= 3
          ? "You're " + short + " reps short \u2014 the load is too heavy for this block's " +
            target + "-rep range. Drop ~20-30% and work back up once you're clearing " + target + "."
          : "Hold the load and chase +1 rep per session until you clear " + target +
            " on the top set, then add weight."
      });
    }
  }
  return out;
}

// Signal 3 for a muscle group.
function paAnalyzeVolume(group, sessions, todayStr, latestOverall) {
  const out = [];
  const freqRef = latestOverall || sessions[sessions.length - 1];
  if (!freqRef) return out;

  const daysSince = Math.round(
    (new Date(todayStr + "T12:00:00") - new Date(freqRef.date + "T12:00:00")) / 86400000);
  if (daysSince > PA_CONFIG.staleDays) {
    out.push({
      exercise: null,
      muscle_group: group,
      signal: "frequency_gap",
      severity: daysSince > PA_CONFIG.staleDays * 2 ? "high" : "medium",
      detail: group + " last trained " + daysSince + " days ago.",
      fix: "Get " + group + " back into the week. Frequency drives progress more than any single session."
    });
  }

  // Volume is judged WEEKLY, not per session: a muscle is hit across different day
  // types (lats on Upper and Pull, quads on Lower and Legs) with very different
  // per-session volume by design, so session-to-session comparison is pure noise.
  // Bodyweight-only sessions contribute 0 tonnage and are excluded so they don't
  // read as a total drop-off.
  const weeks = {};
  sessions.forEach(s => {
    if (!s.tonnage || s.tonnage <= 0) return; // bodyweight-only, not a volume signal
    const wk = paWeekKey(s.date);
    weeks[wk] = (weeks[wk] || 0) + s.tonnage;
  });
  // Judge only COMPLETED weeks. The in-progress week is always partial (the training
  // week runs Mon/Tue/Thu/Fri/Sat), so comparing it against full prior weeks makes
  // every muscle look like it collapsed. Volume is a weekly metric — evaluate it on a
  // weekly boundary.
  const thisWeek = paWeekKey(todayStr);
  const weekKeys = Object.keys(weeks).sort().filter(k => k !== thisWeek);
  // Blocks are only 4 weeks long, so demanding a long baseline would mean the signal
  // never fires. One completed week to judge plus at least one before it is enough.
  if (weekKeys.length >= 2) {
    const currentKey = weekKeys[weekKeys.length - 1];
    const current = weeks[currentKey];
    const prior = weekKeys.slice(0, -1).map(k => weeks[k]);
    const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
    if (avg > 0 && current < avg * (1 - PA_CONFIG.dropPct)) {
      const pct = Math.round((1 - current / avg) * 100);
      out.push({
        exercise: null,
        muscle_group: group,
        signal: "volume_drop",
        severity: pct >= 40 ? "high" : "medium",
        detail: group + " tonnage for week of " + currentKey + " was " + pct +
                "% below the trailing average (" + Math.round(current).toLocaleString() +
                " vs ~" + Math.round(avg).toLocaleString() + " lbs).",
        fix: "If that wasn't a planned lighter week, check sleep, food, and caffeine timing. " +
             "Add a set back before adding load."
      });
    }
  }
  return out;
}

function initGymSuggestions() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS gym_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exercise TEXT,
      muscle_group TEXT,
      signal TEXT NOT NULL,
      severity TEXT NOT NULL,
      detail TEXT NOT NULL,
      fix TEXT NOT NULL,
      workout_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      dismissed INTEGER NOT NULL DEFAULT 0,
      UNIQUE(signal, exercise, muscle_group, workout_id)
    )
  `).run();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS hevy_sync (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `).run();
}
initGymSuggestions();

// ─── Confidence Meter ─────────────────────────────────────────────────────────
// A 0-100 meter that rises when an urge is overcome and decays slowly, so it
// reflects "how I've been doing lately" rather than a lifetime total. Each win is
// logged with its type (hunger | urge) for the breakdown; the meter itself is one
// combined value. Tunables:
const CONF_POINTS_PER_WIN = 5;   // added per logged win
const CONF_DECAY_PER_DAY  = 1;   // subtracted per elapsed day
const CONF_MAX            = 100;

function initConfidence() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS confidence_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      value REAL NOT NULL DEFAULT 0,
      last_decay_date TEXT NOT NULL DEFAULT (date('now','localtime'))
    )
  `).run();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS confidence_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `).run();
  if (!db.prepare("SELECT id FROM confidence_state WHERE id = 1").get()) {
    db.prepare("INSERT INTO confidence_state (id, value) VALUES (1, 0)").run();
  }
}
initConfidence();

// Apply any decay owed since the last time we touched the meter, then return it.
// Done lazily on read/write so no scheduler is needed.
function confidenceCurrent() {
  const row = db.prepare("SELECT value, last_decay_date FROM confidence_state WHERE id = 1").get();
  const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
  if (!row) return 0;
  const days = db.prepare("SELECT CAST(julianday(?) - julianday(?) AS INTEGER) AS n")
    .get(today, row.last_decay_date).n;
  if (days > 0) {
    const decayed = Math.max(0, row.value - days * CONF_DECAY_PER_DAY);
    db.prepare("UPDATE confidence_state SET value = ?, last_decay_date = ? WHERE id = 1")
      .run(decayed, today);
    return decayed;
  }
  return row.value;
}

app.get("/api/confidence", (req, res) => {
  const value = confidenceCurrent();
  const counts = db.prepare("SELECT type, COUNT(*) AS n FROM confidence_log GROUP BY type").all();
  const byType = {};
  counts.forEach(r => { byType[r.type] = r.n; });
  res.json({
    value: Math.round(value),
    max: CONF_MAX,
    hunger: byType.hunger || 0,
    urge: byType.urge || 0,
    total: (byType.hunger || 0) + (byType.urge || 0)
  });
});

// Log a win. body: { type: "hunger" | "urge" }
app.post("/api/confidence", (req, res) => {
  const type = (req.body && req.body.type === "hunger") ? "hunger" : "urge";
  const current = confidenceCurrent();
  const next = Math.min(CONF_MAX, current + CONF_POINTS_PER_WIN);
  db.prepare("UPDATE confidence_state SET value = ? WHERE id = 1").run(next);
  db.prepare("INSERT INTO confidence_log (type) VALUES (?)").run(type);
  const counts = db.prepare("SELECT type, COUNT(*) AS n FROM confidence_log GROUP BY type").all();
  const byType = {};
  counts.forEach(r => { byType[r.type] = r.n; });
  res.json({
    value: Math.round(next),
    max: CONF_MAX,
    hunger: byType.hunger || 0,
    urge: byType.urge || 0,
    total: (byType.hunger || 0) + (byType.urge || 0)
  });
});


// Pull recent workouts, analyze, persist. No-ops unless the newest workout id
// differs from the last one analyzed (or force = true).
async function runPlateauAnalysis(force) {
  if (!HEVY_API_KEY) return { skipped: "no HEVY_API_KEY" };
  const page1 = await hevyGet("/v1/workouts?page=1&pageSize=10");
  const page2 = await hevyGet("/v1/workouts?page=2&pageSize=10");
  const workouts = [...(page1.workouts || []), ...(page2.workouts || [])];
  if (workouts.length === 0) return { skipped: "no workouts" };

  const newestId = String(workouts[0].id);
  const lastRow = db.prepare("SELECT value FROM hevy_sync WHERE key = 'last_workout_id'").get();
  if (!force && lastRow && lastRow.value === newestId) {
    return { skipped: "no new workout", lastWorkoutId: newestId };
  }

  const { blockIndex, blockStart } = paBlockInfo();
  const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
  const muscleMap = await paMuscleMap();
  const { bySeries, byGroup } = paNormalize(workouts, muscleMap);

  // Confine every signal to the current block (see paBlockInfo).
  const inBlock = arr => arr.filter(s => s.date >= blockStart);

  const found = [];
  Object.keys(bySeries).forEach(title => {
    paAnalyzeExercise(title, inBlock(bySeries[title]), blockIndex).forEach(s => found.push(s));
  });
  Object.keys(byGroup).forEach(group => {
    if (group === "other") return; // unmapped catch-all isn't a meaningful muscle group
    const sessions = inBlock(byGroup[group]);
    // Frequency needs the true last-trained date, even if it predates the block.
    const full = byGroup[group];
    paAnalyzeVolume(group, sessions, today, full[full.length - 1]).forEach(s => found.push(s));
  });

  const insert = db.prepare(`
    INSERT OR IGNORE INTO gym_suggestions
      (exercise, muscle_group, signal, severity, detail, fix, workout_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  // A suggestion describes the CURRENT state of a lift, not history. Without this,
  // every analysed workout left another row behind (UNIQUE includes workout_id), so
  // one stalled lift accumulated an alert per session. Retire older undismissed rows
  // for the same signal+exercise+group before writing the new one.
  const supersede = db.prepare(`
    UPDATE gym_suggestions SET dismissed = 1
    WHERE dismissed = 0
      AND signal = ?
      AND IFNULL(exercise, '') = IFNULL(?, '')
      AND IFNULL(muscle_group, '') = IFNULL(?, '')
      AND workout_id IS NOT ?
  `);
  let written = 0;
  found.forEach(s => {
    supersede.run(s.signal, s.exercise, s.muscle_group, newestId);
    const info = insert.run(s.exercise, s.muscle_group, s.signal, s.severity, s.detail, s.fix, newestId);
    if (info.changes > 0) written++;
  });

  db.prepare("INSERT INTO hevy_sync (key, value) VALUES ('last_workout_id', ?) " +
             "ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(newestId);

  return { analyzed: workouts.length, blockIndex, blockStart, found: found.length, written, workoutId: newestId };
}

// Active suggestions, highest severity first. Runs the analysis opportunistically
// so opening the Gym tab picks up a workout logged since the last check.
app.get("/api/gym/suggestions", async (req, res) => {
  try { await runPlateauAnalysis(false); } catch (e) { console.error("Plateau analysis:", e.message); }
  const rows = db.prepare(`
    SELECT * FROM gym_suggestions
    WHERE dismissed = 0
    ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC
  `).all();
  res.json({ suggestions: rows });
});

app.post("/api/gym/suggestions/:id/dismiss", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
  db.prepare("UPDATE gym_suggestions SET dismissed = 1 WHERE id = ?").run(id);
  res.json({ success: true });
});

// Manual trigger for testing / tuning: forces a re-analysis of recent workouts.
app.post("/api/gym/analyze", async (req, res) => {
  try {
    const result = await runPlateauAnalysis(true);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


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
  generateDailyQuests();
  generateWeeklyQuests();
  const today = db.prepare("SELECT date('now', 'localtime') as today").get().today;
  const daily = db.prepare("SELECT * FROM quests WHERE created_date = ? AND type = 'daily' ORDER BY id").all(today);
  const weekly = db.prepare("SELECT * FROM weekly_quests ORDER BY weekday, optional, completed").all();
  const req_weekly = weekly.filter(q => !q.optional);
  res.json({
    dailyQuests: daily,
    weeklyQuests: weekly,
    dailiesCompleted: daily.filter(q => q.completed && !q.optional).length,
    totalDailies: daily.filter(q => !q.optional).length,
    weekliesCompleted: req_weekly.filter(q => q.completed).length,
    hasWeeklyQuests: req_weekly.length > 0
  });
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
      // Count every WORKING set, not just type "normal". Hevy labels sets taken to
      // failure as "failure" and drop sets as "dropset" — this program is built on
      // those, so requiring "normal" discarded ~98% of logged sets and left nearly
      // every exercise showing "No data yet".
      // Keep every working set with reps, INCLUDING unweighted ones. Bodyweight work
      // (Dragon Flag, Kneeling Push Up) logs weight_kg = 0; requiring weight > 0 threw
      // those sessions away entirely, so those lifts showed as never performed. Their
      // progression is reps (and lever length), so they're tracked by reps instead.
      const normalSets = (ex.sets || []).filter(s => s.type !== "warmup" && s.reps > 0);
      if (!normalSets.length) continue;
      const bodyweight = normalSets.every(s => !(s.weight_kg > 0));
      const bestSet = bodyweight
        ? normalSets.reduce((b, s) => (s.reps > b.reps ? s : b))
        : normalSets.reduce((b, s) =>
            epley1RM(s.weight_kg * KG_TO_LBS, s.reps) > epley1RM(b.weight_kg * KG_TO_LBS, b.reps) ? s : b
          );
      const weightLbs = Math.round((bestSet.weight_kg || 0) * KG_TO_LBS);
      if (!map[id]) map[id] = { title: ex.title, sessions: [], bodyweight: bodyweight };
      if (!bodyweight) map[id].bodyweight = false;
      map[id].sessions.push({ date, weightLbs, reps: bestSet.reps });
    }
  }
  return { map, workouts };
}

// Exercise titles the plateau analyzer currently flags (e1RM flat/declining, or
// missing the block's rep target). This drives the inline "Plateau" badge, replacing
// the old weight-only check — that one called rep progression (140x10 -> 140x12) a
// plateau, because the load hadn't changed, and ignored block boundaries.
function paFlaggedExerciseTitles() {
  try {
    const rows = db.prepare(
      "SELECT DISTINCT exercise FROM gym_suggestions WHERE dismissed = 0 AND exercise IS NOT NULL"
    ).all();
    return new Set(rows.map(r => r.exercise));
  } catch (e) {
    return new Set();
  }
}

// Active suggestions grouped by exercise title, so each exercise can carry its own
// alerts inline in the Gym tab instead of them all living in one list at the top.
function paSuggestionsByExercise() {
  try {
    const rows = db.prepare(
      "SELECT id, exercise, signal, severity, detail, fix FROM gym_suggestions " +
      "WHERE dismissed = 0 AND exercise IS NOT NULL " +
      "ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END"
    ).all();
    const map = {};
    rows.forEach(r => {
      if (!map[r.exercise]) map[r.exercise] = [];
      map[r.exercise].push({
        id: r.id, signal: r.signal, severity: r.severity, detail: r.detail, fix: r.fix
      });
    });
    return map;
  } catch (e) {
    return {};
  }
}

// Canonical training-day order for the Gym tab, regardless of Hevy's ordering.
const GYM_DAY_ORDER = ["upper", "lower", "push", "pull", "legs"];
function gymDayRank(title) {
  const t = (title || "").trim().toLowerCase();
  const i = GYM_DAY_ORDER.findIndex(d => t === d || t.startsWith(d));
  return i === -1 ? GYM_DAY_ORDER.length : i;
}

function buildExerciseStats(id, fallbackTitle, exerciseMap, flagged, suggMap) {
  const data = exerciseMap[id];
  const title = (data && data.title) || fallbackTitle;
  if (!data || !data.sessions.length) return {
    exercise_template_id: id, title,
    suggestions: (suggMap && suggMap[fallbackTitle]) || [],
    is_bodyweight: false,
    session_count: 0, best_weight_lbs: 0, best_reps: 0, estimated_1rm_lbs: 0,
    is_plateaued: false, sessions_at_current_weight: 0, last_pr_date: "",
    stuck_at_weight_lbs: 0, stuck_at_reps: 0,
    recent_gain_lbs: 0, strength_level: null, strength_percentile: null,
  };
  const { sessions } = data;
  const isBodyweight = !!data.bodyweight;
  // Bodyweight lifts have no load, so "best" is most reps rather than most weight.
  const best = isBodyweight
    ? sessions.reduce((b, s) => (s.reps > b.reps ? s : b))
    : sessions.reduce((b, s) => (s.weightLbs > b.weightLbs ? s : b));
  const oneRM = epley1RM(best.weightLbs, best.reps);
  const strength = getStrengthInfo(title, oneRM);
  // "Stuck" = sessions since the last personal record, measured by estimated 1RM so
  // rep progress counts (175x6 -> 175x8 is progress even though the load didn't move).
  // Bodyweight lifts have no load, so they're judged on reps.
  // The old version compared every session against the MOST RECENT weight and counted
  // anything >=, so a single light day made the whole history look "stuck".
  const metric = s => (isBodyweight ? s.reps : epley1RM(s.weightLbs, s.reps));
  // sessions[0] is the newest (Hevy returns workouts newest-first).
  let bestSoFar = -Infinity;
  let prIndex = 0;              // index of the session holding the all-time best
  for (let i = sessions.length - 1; i >= 0; i--) {   // walk oldest -> newest
    const v = metric(sessions[i]);
    if (v > bestSoFar) { bestSoFar = v; prIndex = i; }
  }
  // Sessions logged after that PR (prIndex is newest-first, so it IS the count).
  const sessionsAtCurrentWeight = prIndex;
  const lastPrDate = sessions[prIndex].date;
  const stuckAtWeightLbs = sessions[prIndex].weightLbs;
  const stuckAtReps = sessions[prIndex].reps;
  return {
    exercise_template_id: id, title,
    suggestions: (suggMap && suggMap[title]) || [],
    is_bodyweight: isBodyweight,
    session_count: sessions.length, best_weight_lbs: best.weightLbs, best_reps: best.reps,
    estimated_1rm_lbs: oneRM,
    is_plateaued: flagged ? flagged.has(title) : (sessionsAtCurrentWeight >= 3),
    sessions_at_current_weight: sessionsAtCurrentWeight, last_pr_date: lastPrDate,
    stuck_at_weight_lbs: stuckAtWeightLbs, stuck_at_reps: stuckAtReps,
    recent_gain_lbs: sessions.length >= 2 ? sessions[0].weightLbs - sessions[1].weightLbs : 0,
    strength_level: strength ? strength.level : null,
    strength_percentile: strength ? strength.percentile : null,
  };
}

// ─── Gym Endpoints ────────────────────────────────────────────────────────────
app.get("/api/gym/summary", async (req, res) => {
  try {
    const { map: exerciseMap } = await buildExerciseMap();
    const flagged = paFlaggedExerciseTitles();
    const results = Object.keys(exerciseMap)
      .map(id => buildExerciseStats(id, exerciseMap[id].title, exerciseMap, flagged, paSuggestionsByExercise()))
      .sort((a, b) => b.session_count - a.session_count);
    res.json(results);
  } catch (e) {
    console.error("Hevy /summary error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/gym/routines", async (req, res) => {
  try {
    const [{ map: exerciseMap, workouts }, r1, r2, r3, r4, r5, r6, foldersResp] = await Promise.all([
      buildExerciseMap(),
      hevyGet("/v1/routines?page=1&pageSize=10"),
      hevyGet("/v1/routines?page=2&pageSize=10"),
      hevyGet("/v1/routines?page=3&pageSize=10"),
      hevyGet("/v1/routines?page=4&pageSize=10"),
      hevyGet("/v1/routines?page=5&pageSize=10"),
      hevyGet("/v1/routines?page=6&pageSize=10"),
      hevyGet("/v1/routine_folders?page=1&pageSize=10"),
    ]);
    const routines = [
      ...(r1.routines || []), ...(r2.routines || []), ...(r3.routines || []),
      ...(r4.routines || []), ...(r5.routines || []), ...(r6.routines || []),
    ];
    const folders = foldersResp.routine_folders || [];
    // Routines live in Hevy folders ("Essential Week 1 - 4", "5 - 8", "9 - 12"). Workouts no
    // longer carry "Week N", so the active 4-week block is derived from elapsed days since the
    // rotation start date (stored in gym_rotation). 28 days per block; 84-day cycle then repeats.
    const startRow = db.prepare("SELECT start_date FROM gym_rotation WHERE id = 1").get();
    const startDate = startRow ? startRow.start_date : "2026-07-06";
    const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
    const daysElapsed = db.prepare("SELECT CAST(julianday(?) - julianday(?) AS INTEGER) AS n").get(today, startDate).n;
    // Block index 0/1/2 within the 84-day cycle (guard against negative if start is future).
    const cycleDay = ((daysElapsed % 84) + 84) % 84;
    const blockIndex = Math.floor(cycleDay / 28); // 0 -> Week 1-4, 1 -> 5-8, 2 -> 9-12
    // Match the folder by its title's low week number (1 -> block 0, 5 -> block 1, 9 -> block 2),
    // falling back to Hevy's folder index ordering if titles don't parse.
    const blockLow = blockIndex * 4 + 1; // 1, 5, or 9
    let activeFolder = folders.find(f => {
      const m = (f.title || "").match(/Week\s+(\d+)\s*-\s*\d+/i);
      return m && parseInt(m[1]) === blockLow;
    });
    if (!activeFolder) {
      activeFolder = folders.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[blockIndex];
    }
    const activeFolderId = activeFolder ? activeFolder.id : null;
    let filtered = routines.filter(r => r.folder_id === activeFolderId);
    // Last-resort: never return blank -> distinct routines by title.
    if (filtered.length === 0) {
      const seen = new Set();
      filtered = routines.filter(r => {
        const t = (r.title || "").trim();
        if (!t || seen.has(t)) return false;
        seen.add(t); return true;
      });
    }
    const flagged = paFlaggedExerciseTitles();
    const suggMap = paSuggestionsByExercise();
    const result = filtered
      .slice()
      .sort((a, b) => gymDayRank(a.title) - gymDayRank(b.title))
      .map(r => {
        const exList = r.exercises || [];
        // A lift can occupy two slots in one routine (heavy + back-off). Hevy stores
        // both under the same title, so the analyzer sees ONE lift and produces ONE
        // alert — attach it to the first slot only, noting it covers both, instead of
        // repeating it and implying two separate problems.
        const counts = {};
        exList.forEach(ex => { counts[ex.title] = (counts[ex.title] || 0) + 1; });
        const used = new Set();
        return {
          routine_id: r.id,
          title: r.title,
          exercises: exList.map(ex => {
            const first = !used.has(ex.title);
            used.add(ex.title);
            const stats = buildExerciseStats(
              ex.exercise_template_id, ex.title, exerciseMap, flagged,
              first ? suggMap : null
            );
            if (first && counts[ex.title] > 1 && stats.suggestions.length) {
              stats.suggestions = stats.suggestions.map(s => ({
                ...s,
                fix: s.fix + " Covers both slots — deloading the heavy set drops the back-off proportionally."
              }));
            }
            return stats;
          }),
        };
      });
    res.json(result);
  } catch (e) {
    console.error("Hevy /routines error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/gym/history/:exerciseId", async (req, res) => {
  try {
    const data = await hevyGet("/v1/exercise_history/" + req.params.exerciseId + "?page=1&pageSize=10");
    // Hevy returns a FLAT list of individual SETS (workout_id, workout_start_time,
    // weight_kg, reps, set_type) — not workouts containing a sets array. Group by
    // workout, then take that session's best working set.
    const byWorkout = {};
    (data.exercise_history || []).forEach(s => {
      if (s.set_type === "warmup") return;
      if (!(s.reps > 0)) return;   // unweighted bodyweight sets still count
      const id = s.workout_id || s.workout_start_time || "";
      if (!byWorkout[id]) {
        byWorkout[id] = { date: (s.workout_start_time || "").slice(0, 10), best: null };
      }
      const kg = s.weight_kg || 0;
      // Unweighted sets compare by reps; weighted ones by estimated 1RM.
      const e = kg > 0 ? epley1RM(kg * KG_TO_LBS, s.reps) : 0;
      const cur = byWorkout[id].best;
      const better = !cur || (kg > 0 ? e > cur.e1rm : s.reps > cur.reps);
      if (better) {
        byWorkout[id].best = { e1rm: e, weight_kg: kg, reps: s.reps };
      }
    });
    const history = Object.values(byWorkout)
      .filter(w => w.best)
      .map(w => {
        const weightLbs = Math.round(w.best.weight_kg * KG_TO_LBS);
        return {
          date: w.date,
          weight_lbs: weightLbs,
          reps: w.best.reps,
          estimated_1rm_lbs: epley1RM(weightLbs, w.best.reps),
        };
      })
      // Newest first: the Recent-sessions list renders this order directly, and the
      // chart reverses it internally so it still reads left-to-right chronologically.
      .sort((a, b) => b.date.localeCompare(a.date));
    res.json(history);
  } catch (e) {
    console.error("Hevy /history error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Gym rotation control ──────────────────────────────────────────────────────
// GET current rotation start date + which block is active today.
app.get("/api/gym/rotation", (req, res) => {
  const row = db.prepare("SELECT start_date FROM gym_rotation WHERE id = 1").get();
  const startDate = row ? row.start_date : null;
  let block = null, daysElapsed = null;
  let weekInBlock = null, dayInBlock = null, daysLeftInBlock = null, blockStart = null, blockEnd = null;
  if (startDate) {
    const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
    daysElapsed = db.prepare("SELECT CAST(julianday(?) - julianday(?) AS INTEGER) AS n").get(today, startDate).n;
    const cycleDay = ((daysElapsed % 84) + 84) % 84;
    block = Math.floor(cycleDay / 28) + 1;      // 1, 2, or 3
    const daysIntoBlock = cycleDay % 28;        // 0-27
    dayInBlock = daysIntoBlock + 1;             // 1-28
    weekInBlock = Math.floor(daysIntoBlock / 7) + 1; // 1-4
    daysLeftInBlock = 28 - dayInBlock;          // days remaining after today
    blockStart = db.prepare("SELECT date(?, '-' || ? || ' days') AS d").get(today, daysIntoBlock).d;
    blockEnd = db.prepare("SELECT date(?, '+' || ? || ' days') AS d").get(blockStart, 27).d;
  }
  res.json({
    startDate, daysElapsed, block,
    weekInBlock, dayInBlock, daysLeftInBlock, blockStart, blockEnd
  });
});

// POST reset: restart the rotation. Body { start_date } optional; defaults to today.
app.post("/api/gym/rotation/reset", (req, res) => {
  const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
  const sd = (req.body && req.body.start_date) ? req.body.start_date : today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sd)) {
    return res.status(400).json({ error: "start_date must be YYYY-MM-DD" });
  }
  db.prepare("UPDATE gym_rotation SET start_date = ? WHERE id = 1").run(sd);
  res.json({ success: true, start_date: sd });
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

// Core daily routine reference — the everyday "autopilot" tasks, shown read-only
// in the app (Daily Routine card) and on the /routine web page. Single source of
// truth: this table. Edit rows here to change the reference everywhere.
function initRoutineReference() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS routine_reference (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sort_order INTEGER NOT NULL,
      title TEXT NOT NULL
    )
  `).run();
  // Migration: add section column if upgrading an existing table (wfm | delivery).
  const cols = db.prepare("PRAGMA table_info(routine_reference)").all().map(c => c.name);
  if (!cols.includes('section')) {
    db.prepare("ALTER TABLE routine_reference ADD COLUMN section TEXT NOT NULL DEFAULT 'wfm'").run();
  }
  const count = db.prepare("SELECT COUNT(*) as count FROM routine_reference").get();
  if (count.count === 0) {
    const insert = db.prepare("INSERT INTO routine_reference (sort_order, title, section) VALUES (?, ?, ?)");
    const wfm = [
      "5:45 AM - Wake Up",
      "Bathroom, Teeth, Clothes, Hair, & Supplement Drink",
      "6:00 AM - Walk Toby & Turn Off Lights",
      "Move Trash Bin (Monday & Thursday)",
      "6:15 AM - Bed, Trash, Supplement Drink, Ice, & Protein Shake",
      "Grab Water Jug (Monday & Thursday)",
      "6:30 AM - Pickup Dad",
      "6:45 AM - Gym (Mon, Tues, & Thurs to Sat)",
      "6:50 AM - Donate Plasma (Sunday & Wednesday)",
      "Water Refill (Monday & Thursday)",
      "7:30 AM - Air Humidifier & Protein Shake",
      "7:35 AM - One Hour Of Day Specific Tasks",
      "9:00 AM - Prepare Clothes & Shower",
      "9:20 AM - Clean Hearing Aids & Meditate",
      "9:30 AM - Feed Toby & Luna",
      "9:40 AM - Chill",
      "10:10 AM - Cook Lunch, Eat, Clean, & Prepare Dinner",
      "11:00 AM - Study",
      "11:45 AM - Prepare For Work & Air Humidifier",
      "3:00 PM - Cook Rice",
      "3:30 PM - Bake Pork",
      "4:00 PM - Sear Pork",
      "4:20 PM - Eat Dessert",
      "4:40 PM - Clean & Prepare Soda",
      "7:00 PM - Brush Teeth",
      "8:00 PM - Take & Prepare Evening Supplement",
      "9:00 PM - Walk Toby & Turn On Lights"
    ];
    const delivery = [
      "5:15 AM - Wake Up",
      "Bathroom, Teeth, Clothes, Hair, & Supplement Drink",
      "5:30 AM - Walk Toby & Turn Off Lights",
      "5:45 AM - Bed, Supplement, Ice, & Protein Shake",
      "6:00 AM - Gym",
      "6:30 AM - Pickup Dad",
      "6:40 AM - Lunch & Snack",
      "4:30 PM - Wash & Vacuum Car",
      "5:00 PM - Shower, Dinner, & Dessert",
      "6:00 PM - Feed Toby & Luna",
      "6:10 PM - Meditate",
      "6:15 PM - Take & Prepare Evening Supplement",
      "6:20 PM - Brush Teeth",
      "6:25 PM - Walk Toby & Turn On Lights"
    ];
    let idx = 0;
    wfm.forEach(title => insert.run(idx++, title, 'wfm'));
    delivery.forEach(title => insert.run(idx++, title, 'delivery'));
    console.log("routine_reference seeded: " + wfm.length + " wfm + " + delivery.length + " delivery");
  }
}
initRoutineReference();

// Today's routine section: WFM = Sun-Thu (weekday 0-4), Delivery = Fri/Sat (5-6).
function routineSectionForToday() {
  const wd = new Date().getDay(); // 0=Sun..6=Sat, local time
  return (wd === 5 || wd === 6) ? 'delivery' : 'wfm';
}

// GET /api/routine-reference — returns ONE schedule (WFM or Delivery) with a label.
// Defaults to today's; pass ?weekday=0-6 to get a specific day's section, which the
// app's Routine screen uses so the reference follows its day picker.
// Open (no auth) so the Android app can fetch it without login.
app.get("/api/routine-reference", (req, res) => {
  const wd = parseInt(req.query.weekday, 10);
  const section = Number.isFinite(wd) && wd >= 0 && wd <= 6
    ? ((wd === 5 || wd === 6) ? 'delivery' : 'wfm')
    : routineSectionForToday();
  const rows = db.prepare("SELECT sort_order, title FROM routine_reference WHERE section = ? ORDER BY sort_order").all(section);
  const label = section === 'delivery' ? 'Delivery Day' : 'WFM';
  res.json({ section, label, items: rows });
});

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
    // Show the "remaining bills" line on the same cards as before (income cards + Subscriptions).
    const showRemaining = (income !== null && groupName !== 'People' && groupName !== 'Subscriptions') || groupName === 'Subscriptions';
    // Remaining bills = sum of bills not yet paid (excludes PAID/AUTOPAY and ON HOLD).
    const remainingBills = groupBills
      .filter(b => b.status !== 'PAID' && b.status !== 'AUTOPAY' && b.status !== 'ON HOLD')
      .reduce((sum, b) => sum + b.amount, 0);

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

    if (showRemaining) {
      html += `<div class="remaining">Remaining bills: $${remainingBills.toFixed(2)}</div>`;
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
  if (!dcols.includes('tue_route121')) {
    db.prepare("ALTER TABLE delivery_weeks ADD COLUMN tue_route121 INTEGER NOT NULL DEFAULT 0").run();
  }
  if (!dcols.includes('wed_route121')) {
    db.prepare("ALTER TABLE delivery_weeks ADD COLUMN wed_route121 INTEGER NOT NULL DEFAULT 0").run();
  }
  // Migration: per-check "paid" flag for the SpeedX paycheck list on the Finance page.
  if (!dcols.includes('paid')) {
    db.prepare("ALTER TABLE delivery_weeks ADD COLUMN paid INTEGER NOT NULL DEFAULT 0").run();
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
  const tueRate = w.tue_route324 ? 1.90 : (w.tue_route121 ? 1.80 : 1.60);
  const wedRate = w.wed_route324 ? 1.90 : (w.wed_route121 ? 1.80 : 1.60);
  return tueBillable * tueRate + wedBillable * wedRate;
}

// Pay date for a delivery week = that week's Wednesday (week_start + 3) + 20 days
function payDateFor(weekStartStr) {
  const d = new Date(weekStartStr + 'T12:00:00');
  d.setDate(d.getDate() + 3 + 17);
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

// ─── SpeedX paychecks (Finance page card) ─────────────────────────────────────
// Lists the current bookkeeping month's checks (one per delivery week, month_id =
// current month) with amount, pay date, and a per-check "paid" toggle.
app.get("/api/speedx-checks", (req, res) => {
  const month = db.prepare("SELECT * FROM bookkeeping_months ORDER BY month DESC LIMIT 1").get();
  if (!month) return res.json({ month: null, checks: [] });
  generateDeliveryWeeksForMonth(month.id, month.month);
  const weeks = db.prepare("SELECT * FROM delivery_weeks WHERE month_id = ? ORDER BY check_number").all(month.id);
  const checks = weeks.map(w => ({
    id: w.id,
    check_number: w.check_number,
    week_start: w.week_start,
    pay_date: payDateFor(w.week_start),
    amount: Math.round(weekBillable(w) * 100) / 100,
    paid: w.paid || 0
  }));
  res.json({ month: month.month, checks });
});

app.patch("/api/speedx-checks/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
  const week = db.prepare("SELECT * FROM delivery_weeks WHERE id = ?").get(id);
  if (!week) return res.status(404).json({ error: "check not found" });
  const paid = req.body && req.body.paid ? 1 : 0;
  db.prepare("UPDATE delivery_weeks SET paid = ? WHERE id = ?").run(paid, id);
  res.json({ success: true, id, paid });
});

// A delivery week's WORKED month = the month its Wednesday (week_start + 3) falls in.
function workedMonthFor(weekStartStr) {
  const d = new Date(weekStartStr + 'T12:00:00');
  d.setDate(d.getDate() + 3);
  return d.toISOString().split('T')[0].slice(0, 7);
}
// All week_start Sundays whose WORKED month (Wednesday's month) is the given YYYY-MM.
function weekStartsForWorkedMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const firstOfMonth = new Date(Date.UTC(y, m - 1, 1, 12));
  const scan = new Date(firstOfMonth);
  scan.setUTCDate(scan.getUTCDate() - 14);
  while (scan.getUTCDay() !== 0) scan.setUTCDate(scan.getUTCDate() + 1);
  const out = [];
  const cur = new Date(scan);
  for (let i = 0; i < 8; i++) {
    const ws = cur.toISOString().split('T')[0];
    if (workedMonthFor(ws) === ym) out.push(ws);
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return out;
}

// Delivery weeks for a given month (generates them if missing).
// Two modes:
//   ?worked_month=YYYY-MM  -> tracker view: weeks grouped by the month they're
//     WORKED in (Wednesday's month). month_id/check_number stay on pay-month so
//     bookkeeping SpeedX income is unaffected. The current worked week appears
//     immediately even if its pay-month hasn't been created yet.
//   ?month_id=N            -> legacy pay-month view (unchanged).
// If neither specified, default to the most recent bookkeeping month.
app.get("/api/delivery-weeks", (req, res) => {
  if (req.query.worked_month) {
    const ym = req.query.worked_month;
    const starts = weekStartsForWorkedMonth(ym);
    if (starts.length === 0) return res.json([]);
    // Lazily ensure each worked week's row exists, assigning month_id/check_number
    // by its PAY month (never overwriting an existing row's assignment).
    starts.forEach((ws) => {
      const existing = db.prepare("SELECT id FROM delivery_weeks WHERE week_start = ?").get(ws);
      if (!existing) {
        const payYm = payMonthFor(ws);
        const payMonth = db.prepare("SELECT * FROM bookkeeping_months WHERE month = ?").get(payYm);
        if (payMonth) {
          const cnt = db.prepare("SELECT COUNT(*) AS n FROM delivery_weeks WHERE month_id = ?").get(payMonth.id).n;
          db.prepare("INSERT INTO delivery_weeks (week_start, month_id, check_number) VALUES (?, ?, ?)")
            .run(ws, payMonth.id, cnt + 1);
        } else {
          db.prepare("INSERT INTO delivery_weeks (week_start, month_id, check_number) VALUES (?, NULL, NULL)")
            .run(ws);
        }
      }
    });
    const weeks = db.prepare(
      "SELECT * FROM delivery_weeks WHERE week_start IN (" +
      starts.map(() => "?").join(",") + ") ORDER BY week_start"
    ).all(...starts);
    return res.json(weeks);
  }

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
  const { tue_delivered, tue_duplicates, tue_undeliverable, wed_delivered, wed_duplicates, wed_undeliverable, tue_route324, wed_route324, tue_route121, wed_route121 } = req.body;
  const week = db.prepare("SELECT * FROM delivery_weeks WHERE id = ?").get(req.params.id);
  if (!week) return res.status(404).json({ error: "Week not found" });
  // Resolve flags, then enforce mutual exclusivity per day (Route 324 takes precedence).
  let t324 = (tue_route324 ?? week.tue_route324) ? 1 : 0;
  let w324 = (wed_route324 ?? week.wed_route324) ? 1 : 0;
  let t121 = (tue_route121 ?? week.tue_route121) ? 1 : 0;
  let w121 = (wed_route121 ?? week.wed_route121) ? 1 : 0;
  if (t324) t121 = 0;
  if (w324) w121 = 0;
  db.prepare(`
    UPDATE delivery_weeks SET
      tue_delivered = ?,
      tue_duplicates = ?,
      tue_undeliverable = ?,
      wed_delivered = ?,
      wed_duplicates = ?,
      wed_undeliverable = ?,
      tue_route324 = ?,
      wed_route324 = ?,
      tue_route121 = ?,
      wed_route121 = ?
    WHERE id = ?
  `).run(
    tue_delivered ?? week.tue_delivered,
    tue_duplicates ?? week.tue_duplicates,
    tue_undeliverable ?? week.tue_undeliverable,
    wed_delivered ?? week.wed_delivered,
    wed_duplicates ?? week.wed_duplicates,
    wed_undeliverable ?? week.wed_undeliverable,
    t324, w324, t121, w121,
    req.params.id
  );
  res.json(db.prepare("SELECT * FROM delivery_weeks WHERE id = ?").get(req.params.id));
});

app.delete("/api/delivery-weeks/:id", (req, res) => {
  db.prepare("DELETE FROM delivery_weeks WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ─── Routine Editor (browser-based template editing) ──────────────────────────
// GET  /api/routine-editor/:tab   — load a tab's editable rows
// POST /api/routine-editor/:tab   — save a tab (delete-all + re-insert, time-sorted)
// Tabs: weekday "0".."6" (Sun..Sat).
// Weekday tabs edit daily_quest_templates + weekly_quest_templates.
// XP/gold left at existing defaults, never surfaced. Sentinel row always hidden.

// Parse "6 AM" / "9:15 AM" / "5:00 PM" -> minutes since midnight (null if unparseable).
function reTimeToMinutes(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (h < 1 || h > 12 || min > 59) return null;
  const ap = m[3].toUpperCase();
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return h * 60 + min;
}
// Normalize a time string to canonical "H:MM AM/PM" (e.g. "5 pm" -> "5:00 PM").
function reNormalizeTime(s) {
  const mins = reTimeToMinutes(s);
  if (mins === null) return null;
  let h = Math.floor(mins / 60);
  const min = mins % 60;
  const ap = h >= 12 ? "PM" : "AM";
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return h12 + ":" + String(min).padStart(2, "0") + " " + ap;
}
app.get("/api/routine-editor/:tab", (req, res) => {
  const tab = req.params.tab;

  // Weekday tab (0..6)
  const wd = parseInt(tab, 10);
  if (isNaN(wd) || wd < 0 || wd > 6) {
    return res.status(400).json({ error: "tab must be 0-6" });
  }

  let dailyRows;
  if (wd === 2 || wd === 3) {
    const col = wd === 2 ? "tuesday_time" : "wednesday_time";
    dailyRows = db.prepare(
      `SELECT id, title, ${col} AS t, optional, important FROM daily_quest_templates WHERE ${col} IS NOT NULL AND time IS NULL`
    ).all();
  } else {
    dailyRows = db.prepare(
      "SELECT id, title, time AS t, optional, important FROM daily_quest_templates WHERE time IS NOT NULL AND tuesday_time IS NULL AND wednesday_time IS NULL AND weekday = ?"
    ).all(wd);
  }
  const sortByTime = (rows) => rows.slice().sort((a, b) => {
    const am = reTimeToMinutes(a.t), bm = reTimeToMinutes(b.t);
    return (am === null ? 99999 : am) - (bm === null ? 99999 : bm);
  });
  const daily = sortByTime(dailyRows).map(r => ({
    title: r.title, time: r.t,
    optional: r.optional ? 1 : 0, important: r.important ? 1 : 0
  }));

  const weeklyRows = db.prepare(
    "SELECT id, title, time AS t, optional, monthly FROM weekly_quest_templates WHERE weekday = ?"
  ).all(wd);
  const required = sortByTime(weeklyRows).map(r => ({
    title: r.title, time: r.t,
    optional: r.optional ? 1 : 0, monthly: r.monthly ? 1 : 0
  }));

  res.json({ tab, kind: "weekday", weekday: wd, daily, required });
});

app.post("/api/routine-editor/:tab", (req, res) => {
  const tab = req.params.tab;

  // ── Weekday save ──
  const wd = parseInt(tab, 10);
  if (isNaN(wd) || wd < 0 || wd > 6) {
    return res.status(400).json({ error: "tab must be 0-6 or SAT/SUN/TUE/WED" });
  }
  const daily = Array.isArray(req.body.daily) ? req.body.daily : null;
  const required = Array.isArray(req.body.required) ? req.body.required : null;
  if (!daily || !required) return res.status(400).json({ error: "daily and required arrays required" });

  // Validate both sections
  for (const it of [...daily, ...required]) {
    if (!it.title || !String(it.title).trim()) return res.status(400).json({ error: "Every quest needs a title." });
    if (reNormalizeTime(it.time) === null) return res.status(400).json({ error: `Invalid time "${it.time}" for "${it.title}". Use e.g. 5:00 PM.` });
  }
  const cleanDaily = daily.map(it => ({
    title: String(it.title).trim(), time: reNormalizeTime(it.time),
    optional: it.optional ? 1 : 0, important: it.important ? 1 : 0
  })).sort((a, b) => reTimeToMinutes(a.time) - reTimeToMinutes(b.time));
  const cleanReq = required.map(it => ({
    title: String(it.title).trim(), time: reNormalizeTime(it.time),
    optional: it.optional ? 1 : 0, monthly: it.monthly ? 1 : 0
  })).sort((a, b) => reTimeToMinutes(a.time) - reTimeToMinutes(b.time));

  const tx = db.transaction(() => {
    // Daily: delete only THIS day's rows, re-insert
    if (wd === 2 || wd === 3) {
      const col = wd === 2 ? "tuesday_time" : "wednesday_time";
      db.prepare(`DELETE FROM daily_quest_templates WHERE ${col} IS NOT NULL AND time IS NULL`).run();
      const ins = db.prepare(
        `INSERT INTO daily_quest_templates (title, time, category, xp_reward, gold_reward, ${col}, optional, weekday, important) VALUES (?, NULL, 'STR', 10, 5, ?, ?, NULL, ?)`
      );
      cleanDaily.forEach(it => ins.run(it.title, it.time, it.optional, it.important));
    } else {
      db.prepare(
        "DELETE FROM daily_quest_templates WHERE time IS NOT NULL AND tuesday_time IS NULL AND wednesday_time IS NULL AND weekday = ?"
      ).run(wd);
      const ins = db.prepare(
        "INSERT INTO daily_quest_templates (title, time, category, xp_reward, gold_reward, tuesday_time, wednesday_time, optional, weekday, important) VALUES (?, ?, 'STR', 10, 5, NULL, NULL, ?, ?, ?)"
      );
      cleanDaily.forEach(it => ins.run(it.title, it.time, it.optional, wd, it.important));
    }
    // Required (weekly): materialized weekly_quests rows reference templates by id
    // (FK). A template rebuild assigns new ids, so first remove this weekday's
    // dependent weekly_quests, then replace the templates. weekly_quests
    // re-materialize on the next daily cycle.
    db.prepare("DELETE FROM weekly_quests WHERE weekday = ?").run(wd);
    db.prepare("DELETE FROM weekly_quest_templates WHERE weekday = ?").run(wd);
    const insW = db.prepare(
      "INSERT INTO weekly_quest_templates (title, weekday, category, xp_reward, gold_reward, optional, time, monthly) VALUES (?, ?, 'STR', 10, 5, ?, ?, ?)"
    );
    cleanReq.forEach(it => insW.run(it.title, wd, it.optional, it.time, it.monthly));
  });
  tx();
  res.json({ success: true, tab, dailyCount: cleanDaily.length, requiredCount: cleanReq.length });
});

app.get("/routines", requireAuth, (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Routine Editor</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a1a; color: #ddd; font-family: -apple-system, sans-serif; padding: 16px; max-width: 900px; margin: 0 auto; }
  h1 { color: #fff; font-size: 24px; margin-bottom: 4px; }
  .subtitle { color: #888; font-size: 13px; margin-bottom: 16px; }
  .subtitle a { color: #7b8cde; text-decoration: none; }
  .tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
  .tab { background: #12122a; border: 1px solid #2a2a3a; color: #bbb; padding: 7px 13px; border-radius: 8px; cursor: pointer; font-size: 14px; }
  .tab:hover { background: #1a1a30; }
  .tab.active { background: #7b8cde; border-color: #7b8cde; color: #fff; font-weight: bold; }
  .note { background: #1a1a2e; border: 1px solid #2a2a3a; border-left: 3px solid #7b8cde; border-radius: 6px; padding: 8px 12px; font-size: 12px; color: #99a; margin-bottom: 18px; }
  .section-head { display: flex; justify-content: space-between; align-items: baseline; margin: 18px 0 8px; }
  .section-head h2 { color: #fff; font-size: 17px; }
  .section-head .count { color: #888; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; background: #12122a; border: 1px solid #2a2a3a; border-radius: 8px; overflow: hidden; }
  th { text-align: left; font-size: 11px; color: #777; font-weight: normal; padding: 8px 10px; border-bottom: 1px solid #2a2a3a; }
  th.c, td.c { text-align: center; }
  td { padding: 6px 10px; border-bottom: 1px solid #1e1e30; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  input[type=text] { width: 100%; background: #0e0e1e; border: 1px solid #2a2a3a; border-radius: 6px; color: #fff; font-size: 14px; padding: 7px 9px; font-family: inherit; }
  input.time { width: 96px; }
  input[type=checkbox] { width: 17px; height: 17px; accent-color: #7b8cde; cursor: pointer; }
  .badge { display: inline-block; font-size: 10px; font-weight: bold; padding: 3px 7px; border-radius: 5px; letter-spacing: .3px; white-space: nowrap; }
  .badge.daily { background: #16233a; color: #7fb0ff; border: 1px solid #23405f; }
  .badge.required { background: #2a1f36; color: #c79bff; border: 1px solid #43315c; }
  .del { background: none; border: none; color: #a55; font-size: 17px; cursor: pointer; line-height: 1; padding: 2px 6px; }
  .del:hover { color: #e77; }
  .adds { display: flex; gap: 8px; margin-top: 8px; }
  .add { background: #12122a; border: 1px dashed #3a3a4a; color: #9ab; padding: 7px 14px; border-radius: 8px; cursor: pointer; font-size: 13px; }
  .add:hover { background: #1a1a30; }
  .add.req { border-color: #43315c; color: #c79bff; }
  .add.req:hover { background: #1c1630; }
  .bar { display: flex; align-items: center; gap: 12px; margin-top: 22px; position: sticky; bottom: 0; background: #0a0a1a; padding: 12px 0; }
  .save { background: #1a2a1a; border: 1px solid #2a3a2a; color: #4CAF50; padding: 10px 26px; border-radius: 8px; cursor: pointer; font-size: 15px; font-weight: bold; }
  .save:hover { background: #24382a; }
  .save:disabled { opacity: .5; cursor: default; }
  .status { font-size: 13px; color: #888; }
  .drag { color: #555; cursor: grab; font-size: 15px; padding: 0 2px; user-select: none; }
  tr.dragging { opacity: .4; }
  .col-drag { width: 20px; }
  .col-kind { width: 78px; }
  .col-time { width: 108px; }
  .col-flag { width: 68px; }
  .col-del { width: 34px; }
  .flag-na { color: #333; font-size: 12px; }
  .empty { color: #666; font-size: 13px; padding: 10px; }
  .toast { position: fixed; bottom: 20px; right: 20px; padding: 11px 20px; border-radius: 8px; font-size: 14px; display: none; z-index: 999; }
  .toast.ok { background: #1e3a1e; color: #7CFC7C; border: 1px solid #2a4a2a; }
  .toast.err { background: #3a1e1e; color: #FF9999; border: 1px solid #4a2a2a; }
</style>
</head>
<body>
<h1>Routine Editor</h1>
<div class="subtitle">Edit quest templates · <a href="/logout">Log out</a></div>

<div class="tabs" id="weekday-tabs"></div>

<div class="note" id="note"></div>
<div id="content"></div>

<div class="bar">
  <button class="save" id="saveBtn" onclick="save()">Save changes</button>
  <span class="status" id="status"></span>
</div>
<div class="toast" id="toast"></div>

<script>
const WEEKDAYS = [["0","Sun"],["1","Mon"],["2","Tue"],["3","Wed"],["4","Thu"],["5","Fri"],["6","Sat"]];
let current = "0";
let dirty = false;

function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function toast(msg, ok){ const t=document.getElementById("toast"); t.textContent=msg; t.className="toast "+(ok?"ok":"err"); t.style.display="block"; setTimeout(()=>{t.style.display="none";},2600); }
function setDirty(d){ dirty=d; document.getElementById("status").textContent = d ? "Unsaved changes" : ""; }

function buildTabs(){
  const wt=document.getElementById("weekday-tabs");
  WEEKDAYS.forEach(([v,label])=>{
    const b=document.createElement("button"); b.className="tab"; b.textContent=label; b.dataset.tab=v;
    b.onclick=()=>selectTab(v); wt.appendChild(b);
  });
}
function highlightTab(){
  document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active", b.dataset.tab===current));
}
function selectTab(tab){
  if(dirty && !confirm("You have unsaved changes. Switch tabs and lose them?")) return;
  current=tab; highlightTab(); load();
}

const tmin = (s) => { if(!s) return 99999; const m=String(s).trim().match(/^(\\d{1,2})(?::(\\d{2}))?\\s*(AM|PM)$/i); if(!m) return 99999; let h=parseInt(m[1],10); const mn=m[2]?parseInt(m[2],10):0; const ap=m[3].toUpperCase(); if(ap==="PM"&&h!==12)h+=12; if(ap==="AM"&&h===12)h=0; return h*60+mn; };

// ── Merged weekday row (kind = 'daily' | 'required') ──
function mergedRow(item){
  const kind = item._kind;
  let c = '<td class="drag-cell"><span class="drag" draggable="true">⋮⋮</span></td>';
  c += '<td class="col-kind"><span class="badge '+kind+'">'+(kind==="daily"?"Daily":"Required")+'</span></td>';
  c += '<td><input type="text" class="f-title" value="'+esc(item.title)+'" oninput="setDirty(true)"></td>';
  c += '<td class="col-time"><input type="text" class="time f-time" value="'+esc(item.time)+'" oninput="setDirty(true)"></td>';
  // Important applies to daily only
  if(kind==="daily") c += '<td class="c col-flag"><input type="checkbox" class="f-important" '+(item.important?"checked":"")+' onchange="setDirty(true)"></td>';
  else c += '<td class="c col-flag flag-na">—</td>';
  // Monthly applies to required only
  if(kind==="required") c += '<td class="c col-flag"><input type="checkbox" class="f-monthly" '+(item.monthly?"checked":"")+' onchange="setDirty(true)"></td>';
  else c += '<td class="c col-flag flag-na">—</td>';
  c += '<td class="c col-del"><button class="del" onclick="this.closest(\\'tr\\').remove(); setDirty(true); refreshCounts();" title="Delete">&times;</button></td>';
  const tr = document.createElement('tr');
  tr.dataset.kind = kind;
  tr.innerHTML = c;
  return tr;
}

function addMerged(kind){
  const tbody = document.querySelector('#tbl tbody');
  const er = tbody.querySelector('.empty-row'); if(er) er.remove();
  const tr = mergedRow({_kind:kind, title:"", time:"", optional:0, important:0, monthly:0});
  tbody.appendChild(tr); attachDrag(tr);
  setDirty(true); refreshCounts();
  tr.querySelector('.f-title').focus();
}

function refreshCounts(){
  const rows = document.querySelectorAll('#tbl tbody tr:not(.empty-row)');
  const el = document.getElementById('count');
  if(el) el.textContent = rows.length+' quest'+(rows.length===1?'':'s')+' · time-sorted';
}

// Drag reorder (visual; save re-sorts by time regardless)
let dragEl=null;
function attachDrag(tr){
  const handle = tr.querySelector('.drag');
  if(!handle) return;
  handle.addEventListener('dragstart', e=>{ dragEl=tr; tr.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; });
  handle.addEventListener('dragend', ()=>{ if(dragEl)dragEl.classList.remove('dragging'); dragEl=null; });
  tr.addEventListener('dragover', e=>{
    e.preventDefault();
    if(!dragEl || dragEl===tr || dragEl.parentNode!==tr.parentNode) return;
    const rect=tr.getBoundingClientRect();
    const after = (e.clientY - rect.top) > rect.height/2;
    tr.parentNode.insertBefore(dragEl, after ? tr.nextSibling : tr);
    setDirty(true);
  });
}
function attachAllDrag(){ document.querySelectorAll('#tbl tbody tr:not(.empty-row)').forEach(attachDrag); }

async function load(){
  document.getElementById("content").innerHTML = '<div class="empty">Loading…</div>';
  setDirty(false);
  try{
    const r = await fetch('/api/routine-editor/'+current);
    if(!r.ok) throw new Error((await r.json()).error||'Load failed');
    const data = await r.json();
    const note = document.getElementById("note");

    {
      const dayName = WEEKDAYS.find(w=>w[0]===current)[1];
      note.textContent = 'Editing '+dayName+'. Daily and required quests shown together, sorted by time. Changes apply the next time this day occurs — today\\'s quests are already generated.';
      let h = '<div class="section-head"><h2>Quests</h2><span class="count" id="count"></span></div>';
      h += '<table id="tbl"><thead><tr><th class="col-drag"></th><th class="col-kind">Type</th><th>Title</th><th class="col-time">Time</th><th class="c col-flag">Important</th><th class="c col-flag">Monthly</th><th class="col-del"></th></tr></thead><tbody></tbody></table>';
      h += '<div class="adds"><button class="add" onclick="addMerged(\\'daily\\')">+ Daily quest</button><button class="add req" onclick="addMerged(\\'required\\')">+ Required quest</button></div>';
      document.getElementById("content").innerHTML = h;
      const tbody = document.querySelector('#tbl tbody');
      const merged = []
        .concat((data.daily||[]).map(x=>Object.assign({_kind:"daily"},x)))
        .concat((data.required||[]).map(x=>Object.assign({_kind:"required"},x)))
        .sort((a,b)=>tmin(a.time)-tmin(b.time));
      if(merged.length===0){ tbody.innerHTML='<tr class="empty-row"><td colspan="7" class="empty">No quests. Add one below.</td></tr>'; }
      else merged.forEach(it=> tbody.appendChild(mergedRow(it)));
    }
    attachAllDrag();
    refreshCounts();
  }catch(e){ document.getElementById("content").innerHTML='<div class="empty">Error: '+esc(e.message)+'</div>'; }
}

async function save(){
  const btn=document.getElementById("saveBtn");
  let body;
  {
    const rows = document.querySelectorAll('#tbl tbody tr:not(.empty-row)');
    const daily=[], required=[];
    rows.forEach(r=>{
      const kind=r.dataset.kind;
      const base={ title:r.querySelector('.f-title').value, time:r.querySelector('.f-time').value, optional:0 };
      if(kind==="daily"){ base.important = r.querySelector('.f-important').checked?1:0; daily.push(base); }
      else { base.monthly = r.querySelector('.f-monthly').checked?1:0; required.push(base); }
    });
    body = { daily, required };
  }
  btn.disabled=true; document.getElementById("status").textContent="Saving…";
  try{
    const r = await fetch('/api/routine-editor/'+current, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
    });
    const data = await r.json();
    if(!r.ok) throw new Error(data.error||'Save failed');
    setDirty(false);
    toast('Saved '+WEEKDAYS.find(w=>w[0]===current)[1], true);
    load();
  }catch(e){ document.getElementById("status").textContent=""; toast(e.message, false); }
  finally{ btn.disabled=false; }
}

window.addEventListener('beforeunload', e=>{ if(dirty){ e.preventDefault(); e.returnValue=''; } });

buildTabs(); highlightTab(); load();
</script>
</body>
</html>`;
  res.send(html);
});


// ─── Daily Routine reference page (read-only, protected) ──────────────────────
// Shows the core everyday routine from routine_reference. Gated with requireAuth
// to match /routines, /notepad, /bookkeeping, /reminders.
// ─── Tasks page (browse any weekday; today's are toggleable) ──────────────────
// Today shows the LIVE generated quests from /api/quests, so ticking a box here is
// the same action as ticking it in the app (and counts toward the streak). Other
// weekdays show that day's templates read-only, since their quests don't exist yet.
app.get("/tasks", requireAuth, (req, res) => {
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tasks</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a1a; color: #ddd; font-family: -apple-system, sans-serif; padding: 16px; max-width: 760px; margin: 0 auto; }
  h1 { color: #fff; font-size: 24px; margin-bottom: 4px; }
  .subtitle { color: #888; font-size: 13px; margin-bottom: 16px; }
  .tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 16px; }
  .tab { background: #12122a; border: 1px solid #2a2a3a; border-radius: 6px; color: #aab;
         font-size: 13px; padding: 8px 12px; cursor: pointer; font-family: inherit; }
  .tab.active { background: #2a3a5c; border-color: #4a6cae; color: #cfe0ff; font-weight: 600; }
  .tab.today { border-color: #FFD700; }
  .note { background: #12122a; border-left: 3px solid #4a6cae; border-radius: 6px;
          color: #99a; font-size: 12px; padding: 9px 12px; margin-bottom: 14px; }
  .section-head { color: #b9b9ff; font-size: 12px; font-weight: 700; letter-spacing: 1px;
                  text-transform: uppercase; margin: 16px 0 8px; }
  .card { background: #12122a; border: 1px solid #2a2a3a; border-radius: 8px; overflow: hidden; }
  .row { display: flex; align-items: center; gap: 12px; padding: 12px 14px;
         border-bottom: 1px solid #1e1e30; font-size: 15px; }
  .row:last-child { border-bottom: none; }
  .row.done .title { color: #667; text-decoration: line-through; }
  .row input[type=checkbox] { width: 20px; height: 20px; accent-color: #7b8cde; flex: none; cursor: pointer; }
  .dot { width: 20px; flex: none; color: #444; text-align: center; }
  .title { flex: 1; color: #cfcfe0; }
  .time { color: #777; font-size: 13px; flex: none; }
  .empty { color: #666; font-size: 14px; padding: 14px; }
  .count { color: #666; font-size: 12px; font-weight: 400; margin-left: 6px; }
</style>
</head>
<body>
<h1>Tasks</h1>
<div class="subtitle">Today's tasks can be checked off. Other days are a preview.</div>
<div class="tabs" id="tabs"></div>
<div id="note"></div>
<div id="content"><div class="empty">Loading…</div></div>

<script>
const DAYS = [["0","Sun"],["1","Mon"],["2","Tue"],["3","Wed"],["4","Thu"],["5","Fri"],["6","Sat"]];
const TODAY = new Date().getDay();
let current = TODAY;

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function buildTabs(){
  const t = document.getElementById("tabs");
  t.innerHTML = "";
  DAYS.forEach(function(d){
    const b = document.createElement("button");
    b.className = "tab" + (String(current)===d[0] ? " active" : "") + (Number(d[0])===TODAY ? " today" : "");
    b.textContent = d[1] + (Number(d[0])===TODAY ? " •" : "");
    b.onclick = function(){ current = Number(d[0]); buildTabs(); load(); };
    t.appendChild(b);
  });
}

function rowHtml(item, toggleable){
  const done = item.completed ? " done" : "";
  const box = toggleable
    ? '<input type="checkbox" ' + (item.completed ? 'checked' : '') +
      ' data-kind="' + item.kind + '" data-id="' + item.id + '">'
    : '<span class="dot">•</span>';
  const time = item.time ? '<span class="time">' + esc(item.time) + '</span>' : '';
  return '<div class="row' + done + '">' + box +
         '<span class="title">' + esc(item.title) + '</span>' + time + '</div>';
}

// Titles come back as "Task @ 6:15 AM" for generated quests — split for display.
function splitTitle(t){
  const m = String(t).match(/^(.*) @ (\\d{1,2}:\\d{2}\\s*[AP]M)$/i);
  return m ? { title: m[1], time: m[2] } : { title: t, time: null };
}

async function load(){
  const content = document.getElementById("content");
  const note = document.getElementById("note");
  content.innerHTML = '<div class="empty">Loading…</div>';
  try {
    if (current === TODAY) {
      note.innerHTML = '<div class="note">These are today&#39;s live tasks — checking one here is the same as checking it in the app.</div>';
      const r = await fetch('/api/quests');
      const data = await r.json();
      const daily = (data.dailyQuests || []).map(function(q){
        const s = splitTitle(q.title);
        return { id: q.id, kind: 'daily', title: s.title, time: s.time, completed: q.completed };
      });
      const weekly = (data.weeklyQuests || [])
        .filter(function(q){ return q.weekday === TODAY; })
        .map(function(q){
          const s = splitTitle(q.title);
          return { id: q.id, kind: 'weekly', title: s.title, time: s.time, completed: q.completed };
        });
      render(daily, weekly, true);
    } else {
      note.innerHTML = '<div class="note">Preview of what generates on this day. Not checkable — only today&#39;s tasks can be toggled.</div>';
      const r = await fetch('/api/routine/' + current);
      const data = await r.json();
      const daily = (data.daily || []).map(function(t){
        return { id: t.id, kind: 'daily', title: t.title, time: t.time, completed: 0 };
      });
      const req = (data.required || []).map(function(t){
        return { id: t.id, kind: 'weekly', title: t.title, time: t.time, completed: 0 };
      });
      render(daily, req, false);
    }
  } catch(e) {
    content.innerHTML = '<div class="empty">Could not load tasks.</div>';
  }
}

function render(daily, required, toggleable){
  let h = '';
  h += '<div class="section-head">Daily <span class="count">' + daily.length + '</span></div>';
  h += '<div class="card">' + (daily.length
        ? daily.map(function(i){ return rowHtml(i, toggleable); }).join('')
        : '<div class="empty">Nothing scheduled.</div>') + '</div>';
  h += '<div class="section-head">Required <span class="count">' + required.length + '</span></div>';
  h += '<div class="card">' + (required.length
        ? required.map(function(i){ return rowHtml(i, toggleable); }).join('')
        : '<div class="empty">Nothing required.</div>') + '</div>';
  const content = document.getElementById("content");
  content.innerHTML = h;
  content.querySelectorAll('input[type=checkbox]').forEach(function(cb){
    cb.addEventListener('change', function(){
      toggle(cb.getAttribute('data-kind'), cb.getAttribute('data-id'), cb.checked);
    });
  });
}

async function toggle(kind, id, checked){
  const base = kind === 'weekly' ? '/api/weekly-quests/' : '/api/quests/';
  const action = checked ? 'complete' : 'uncomplete';
  try {
    await fetch(base + id + '/' + action, { method: 'POST' });
    load();
  } catch(e) { load(); }
}

buildTabs(); load();
setInterval(function(){ if (current === TODAY) load(); }, 60000);
</script>
</body>
</html>`;
  res.send(html);
});

// ─── Urge card (mirror of the app screen behind the streak long-press) ────────
// Static content, no client-side JS: the HTML is assembled server-side from these
// arrays and interpolated, so apostrophes in the copy need no escaping.
const URGE_STEPS_WEB = [
  "Feet on the pad. 2 mph. Now. Don't negotiate, just start walking.",
  "The urge is a cue, not a command. It's your body flagging idle + alone. Answer it with motion.",
  "10 minutes minimum. The wave passes. It always passes.",
  "Two wins, one move. Steps banked. Loop broken. Same pad, both jobs."
];

const URGE_REASONS_WEB = [
  ["The urge is temporary — you're not.",
   "It peaks and passes within minutes if you don't feed it. Riding it out proves you're in control, not the impulse."],
  ["It drains the drive you're building things with.",
   "You're stacking real projects — the homelab, the SYSTEM app, CCNA. That focus and momentum is the same energy. Redirecting it is fuel, not deprivation."],
  ["Nothing changes for the better afterward.",
   "The problem you were avoiding is still there, plus the low, foggy, slightly-ashamed feeling that follows. You never once finish and think &quot;glad I did that.&quot;"],
  ["It reinforces the exact loop you're trying to break.",
   "Every time you give in, you teach your brain that discomfort = escape. Every time you don't, you weaken that wiring and get stronger."],
  ["You're training discipline, and it transfers.",
   "The person who can say no here is the same person who shows up for workouts, studies when tired, and follows through on the route. This is rep one."],
  ["Future-you is watching.",
   "The version of you a month clean doesn't want you to reset the counter over five minutes of impulse. Don't rob him of the streak he earned."],
  ["Act, don't wait.",
   "You already know the moves — get up, cold water, walk, push-ups, leave the room. The urge can't survive you standing up and changing your state."]
];

app.get("/urge", requireAuth, (req, res) => {
  const steps = URGE_STEPS_WEB.map((s, i) =>
    '<div class="step"><span class="num">' + (i + 1) + '</span><span>' + s + '</span></div>'
  ).join("");
  const reasons = URGE_REASONS_WEB.map(r =>
    '<div class="reason"><div class="head">' + r[0] + '</div><div class="body">' + r[1] + '</div></div>'
  ).join("");
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>When The Urge Hits</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a0a; color: #ddd; font-family: -apple-system, sans-serif;
         padding: 18px; max-width: 700px; margin: 0 auto; }
  h1 { color: #fff; font-size: 26px; }
  .sub { color: #FFD700; font-size: 14px; font-weight: 700; letter-spacing: 2px;
         margin: 4px 0 18px; }
  .step { background: #1a1a1a; border-radius: 10px; padding: 14px; margin-bottom: 10px;
          display: flex; gap: 12px; font-size: 15px; color: #ddd; line-height: 22px; }
  .num { color: #FFD700; font-weight: 700; flex: none; }
  .note { background: #141414; border-radius: 10px; padding: 14px; margin-bottom: 22px;
          color: #999; font-size: 14px; line-height: 21px; }
  .sec { color: #FFD700; font-size: 12px; font-weight: 700; letter-spacing: 2px;
         margin-bottom: 8px; }
  .reason { background: #1a1a1a; border-radius: 10px; padding: 14px; margin-bottom: 10px; }
  .reason .head { color: #ddd; font-size: 14px; font-weight: 700; line-height: 20px; }
  .reason .body { color: #999; font-size: 13px; line-height: 19px; margin-top: 4px; }
</style>
</head>
<body>
<h1>When The Urge Hits</h1>
<div class="sub">STAND UP &rarr; PAD</div>
${steps}
<div class="note">If you're not near the pad: leave the room. Change what you're looking at. Then come back to the pad.</div>
<div class="sec">REASONS TO PULL UP</div>
${reasons}
</body>
</html>`;
  res.send(html);
});

app.get("/routine", requireAuth, (req, res) => {
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const buildList = (section) => {
    const rows = db.prepare("SELECT title FROM routine_reference WHERE section = ? ORDER BY sort_order").all(section);
    return rows.map(r => `<li>${esc(r.title)}</li>`).join("");
  };
  const wfmItems = buildList('wfm');
  const deliveryItems = buildList('delivery');
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Daily Routine</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a1a; color: #ddd; font-family: -apple-system, sans-serif; padding: 16px; max-width: 1000px; margin: 0 auto; }
  h1 { color: #fff; font-size: 24px; margin-bottom: 4px; }
  .subtitle { color: #888; font-size: 13px; margin-bottom: 18px; }
  .columns { display: flex; gap: 16px; align-items: flex-start; }
  .column { flex: 1 1 0; min-width: 0; }
  .col-head { color: #b9b9ff; font-size: 13px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 10px; }
  .card { background: #12122a; border: 1px solid #2a2a3a; border-radius: 8px; padding: 8px 6px; }
  ol { list-style: none; counter-reset: item; }
  li { counter-increment: item; padding: 11px 14px; border-bottom: 1px solid #1e1e30; font-size: 15px; color: #cfcfe0; display: flex; align-items: baseline; }
  li:last-child { border-bottom: none; }
  li::before { content: counter(item); color: #555; font-size: 12px; width: 26px; flex: none; }
  @media (max-width: 640px) { .columns { flex-direction: column; } }
</style>
</head>
<body>
<h1>Daily Routine</h1>
<div class="subtitle">Both schedules. Reference only.</div>
<div class="columns">
  <div class="column">
    <div class="col-head">WFM (Sun-Thu)</div>
    <div class="card"><ol>${wfmItems}</ol></div>
  </div>
  <div class="column">
    <div class="col-head">Delivery (Fri/Sat)</div>
    <div class="card"><ol>${deliveryItems}</ol></div>
  </div>
</div>
</body>
</html>`;
  res.send(html);
});


// ─── Reminders (user-created one-time notifications) ──────────────────────────
function initReminders() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      remind_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      fired INTEGER NOT NULL DEFAULT 0
    )
  `).run();
  // Migration: tag rows generated from a recurring rule so we can dedupe / trace them.
  const cols = db.prepare("PRAGMA table_info(reminders)").all().map(c => c.name);
  if (!cols.includes('source_recurring_id')) {
    db.prepare("ALTER TABLE reminders ADD COLUMN source_recurring_id INTEGER DEFAULT NULL").run();
  }
  // Recurring reminder RULES. Each active rule materializes its next occurrence into
  // the reminders table (see materializeRecurringReminders), so the phone — which just
  // polls /api/reminders — needs no changes. type: 'daily' | 'weekly' | 'monthly'.
  //   time_str      : "HH:MM" 24h, the fire time
  //   weekdays      : CSV of 0-6 (Sun-Sat) for weekly, e.g. "1,3,5"
  //   day_of_month  : 1-31 for monthly (clamped to month length)
  db.prepare(`
    CREATE TABLE IF NOT EXISTS recurring_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      time_str TEXT NOT NULL,
      weekdays TEXT,
      day_of_month INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `).run();
}
initReminders();

// Format a JS Date as the "YYYY-MM-DD HH:MM:SS" local string reminders use.
function fmtRemindAt(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

// Compute the next occurrence (JS Date strictly after `from`) for a recurring rule.
function nextOccurrence(rule, from) {
  const [hh, mm] = rule.time_str.split(':').map(Number);
  if (rule.type === 'daily') {
    const c = new Date(from.getFullYear(), from.getMonth(), from.getDate(), hh, mm, 0, 0);
    if (c <= from) c.setDate(c.getDate() + 1);
    return c;
  }
  if (rule.type === 'weekly') {
    const days = String(rule.weekdays || '').split(',').map(s => parseInt(s, 10)).filter(n => n >= 0 && n <= 6);
    if (days.length === 0) return null;
    // Scan the next 8 days for the soonest selected weekday at the fire time > from.
    for (let i = 0; i < 8; i++) {
      const c = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, hh, mm, 0, 0);
      if (c > from && days.includes(c.getDay())) return c;
    }
    return null;
  }
  if (rule.type === 'monthly') {
    const dom = rule.day_of_month;
    // Try this month, then following months; clamp to the month's last day.
    for (let i = 0; i < 3; i++) {
      const y = from.getFullYear();
      const m = from.getMonth() + i;
      const lastDay = new Date(y, m + 1, 0).getDate();
      const day = Math.min(dom, lastDay);
      const c = new Date(y, m, day, hh, mm, 0, 0);
      if (c > from) return c;
    }
    return null;
  }
  return null;
}

// For each active recurring rule, ensure its next occurrence exists as an un-fired
// reminders row. Idempotent: won't duplicate a row already sitting for that rule+time.
function materializeRecurringReminders() {
  const rules = db.prepare("SELECT * FROM recurring_reminders WHERE active = 1").all();
  const now = new Date();
  rules.forEach(rule => {
    const next = nextOccurrence(rule, now);
    if (!next) return;
    const remindAt = fmtRemindAt(next);
    const existing = db.prepare(
      "SELECT id FROM reminders WHERE source_recurring_id = ? AND remind_at = ? AND fired = 0"
    ).get(rule.id, remindAt);
    if (!existing) {
      db.prepare(
        "INSERT INTO reminders (title, remind_at, source_recurring_id) VALUES (?, ?, ?)"
      ).run(rule.title, remindAt, rule.id);
    }
  });
}

// Remove reminders that are done with: already fired, or more than a day past due
// (the day of grace means a reminder isn't silently deleted before the phone polls).
function purgeOldReminders() {
  db.prepare(`
    DELETE FROM reminders
    WHERE fired = 1
       OR remind_at < datetime('now','localtime','-1 day')
  `).run();
}

// Pending = not yet fired and not yet past due. Sorted soonest first.
// Materialize recurring occurrences first so the phone's poll sees them.
app.get("/api/reminders", (req, res) => {
  materializeRecurringReminders();
  purgeOldReminders();
  const rows = db.prepare(`
    SELECT id, title, remind_at, created_at
    FROM reminders
    WHERE fired = 0
      AND remind_at >= datetime('now','localtime')
    ORDER BY remind_at ASC
  `).all();
  res.json({ reminders: rows });
});

// ─── Recurring reminder rules ─────────────────────────────────────────────────
app.get("/api/recurring-reminders", (req, res) => {
  const rows = db.prepare("SELECT * FROM recurring_reminders WHERE active = 1 ORDER BY id DESC").all();
  res.json({ recurring: rows });
});

app.post("/api/recurring-reminders", (req, res) => {
  const b = req.body || {};
  const title = (b.title ? String(b.title) : "").trim();
  const type = (b.type ? String(b.type) : "").trim();
  const time = (b.time ? String(b.time) : "").trim();
  if (!title) return res.status(400).json({ error: "title is required" });
  if (!["daily", "weekly", "monthly"].includes(type)) {
    return res.status(400).json({ error: "type must be daily, weekly, or monthly" });
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    return res.status(400).json({ error: "time must be HH:MM (24h)" });
  }
  let weekdays = null;
  let dayOfMonth = null;
  if (type === "weekly") {
    const arr = Array.isArray(b.weekdays) ? b.weekdays : [];
    const clean = arr.map(n => parseInt(n, 10)).filter(n => n >= 0 && n <= 6);
    if (clean.length === 0) return res.status(400).json({ error: "pick at least one weekday" });
    weekdays = clean.sort((a, c) => a - c).join(",");
  }
  if (type === "monthly") {
    dayOfMonth = parseInt(b.day_of_month, 10);
    if (!(dayOfMonth >= 1 && dayOfMonth <= 31)) {
      return res.status(400).json({ error: "day_of_month must be 1-31" });
    }
  }
  const info = db.prepare(
    "INSERT INTO recurring_reminders (title, type, time_str, weekdays, day_of_month) VALUES (?, ?, ?, ?, ?)"
  ).run(title, type, time, weekdays, dayOfMonth);
  materializeRecurringReminders();
  res.json({ success: true, id: info.lastInsertRowid });
});

app.delete("/api/recurring-reminders/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
  db.prepare("DELETE FROM recurring_reminders WHERE id = ?").run(id);
  // Also drop any un-fired materialized rows for this rule so it stops firing.
  db.prepare("DELETE FROM reminders WHERE source_recurring_id = ? AND fired = 0").run(id);
  res.json({ success: true });
});

app.post("/api/reminders", (req, res) => {
  const title = (req.body && req.body.title ? String(req.body.title) : "").trim();
  const date = (req.body && req.body.date ? String(req.body.date) : "").trim();
  const time = (req.body && req.body.time ? String(req.body.time) : "").trim();

  if (!title) return res.status(400).json({ error: "title is required" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    return res.status(400).json({ error: "time must be HH:MM (24h)" });
  }
  const remindAt = `${date} ${time}:00`;

  const info = db.prepare(
    "INSERT INTO reminders (title, remind_at) VALUES (?, ?)"
  ).run(title, remindAt);

  res.json({ success: true, id: info.lastInsertRowid, remind_at: remindAt });
});

// Phone calls this after showing the notification so the row is retired.
app.post("/api/reminders/:id/fired", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
  db.prepare("UPDATE reminders SET fired = 1 WHERE id = ?").run(id);
  res.json({ success: true });
});

app.delete("/api/reminders/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
  db.prepare("DELETE FROM reminders WHERE id = ?").run(id);
  res.json({ success: true });
});

app.get("/reminders", requireAuth, (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reminders</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a1a; color: #ddd; font-family: -apple-system, sans-serif; padding: 16px; max-width: 700px; margin: 0 auto; }
  h1 { color: #fff; font-size: 24px; margin-bottom: 4px; }
  .subtitle { color: #888; font-size: 13px; margin-bottom: 18px; }
  .card { background: #12122a; border: 1px solid #2a2a3a; border-radius: 8px; padding: 14px; margin-bottom: 18px; }
  label { display: block; font-size: 11px; color: #777; margin-bottom: 4px; }
  input[type=text], input[type=date], input[type=time], input[type=number], select {
    width: 100%; background: #0e0e1e; border: 1px solid #2a2a3a; border-radius: 6px;
    color: #fff; font-size: 15px; padding: 9px 10px; font-family: inherit;
  }
  .weekdays { display: flex; gap: 6px; flex-wrap: wrap; }
  .wd { flex: 1; min-width: 38px; text-align: center; background: #0e0e1e; border: 1px solid #2a2a3a;
        border-radius: 6px; color: #999; font-size: 13px; padding: 8px 4px; cursor: pointer; user-select: none; }
  .wd.on { background: #2a3a5c; border-color: #4a6cae; color: #cfe0ff; }
  .row { display: flex; gap: 10px; margin-top: 10px; }
  .row > div { flex: 1; }
  .warn { display: none; background: #2a2010; border: 1px solid #5c4a1e; border-left: 3px solid #f59e0b;
          border-radius: 6px; padding: 9px 12px; font-size: 12px; color: #e5b567; margin-top: 10px; }
  .warn.show { display: block; }
  button.primary { width: 100%; margin-top: 12px; background: #7b8cde; border: none; color: #fff;
                   font-size: 15px; font-weight: bold; padding: 11px; border-radius: 8px; cursor: pointer; font-family: inherit; }
  button.primary:disabled { opacity: .5; cursor: default; }
  h2 { color: #fff; font-size: 17px; margin-bottom: 8px; }
  .count { color: #888; font-size: 13px; font-weight: normal; }
  table { width: 100%; border-collapse: collapse; background: #12122a; border: 1px solid #2a2a3a; border-radius: 8px; overflow: hidden; }
  th { text-align: left; font-size: 11px; color: #777; font-weight: normal; padding: 8px 10px; border-bottom: 1px solid #2a2a3a; }
  td { padding: 9px 10px; border-bottom: 1px solid #1e1e30; vertical-align: middle; font-size: 14px; }
  tr:last-child td { border-bottom: none; }
  td.when { color: #9ab; white-space: nowrap; font-size: 13px; }
  td.soon { color: #e5b567; }
  .del { background: none; border: none; color: #a55; font-size: 17px; cursor: pointer; line-height: 1; padding: 2px 6px; }
  .del:hover { color: #e77; }
  .empty { color: #666; font-size: 13px; padding: 14px 10px; text-align: center; }
  #toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); padding: 10px 18px;
           border-radius: 8px; font-size: 14px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  #toast.ok { background: #1e3a2a; color: #7fd6a0; border: 1px solid #2f5c44; }
  #toast.err { background: #3a1e1e; color: #e78; border: 1px solid #5c2f2f; }
  #toast.show { opacity: 1; }
</style>
</head>
<body>
<h1>Reminders</h1>
<div class="subtitle">One-time notifications sent to your phone.</div>

<div class="card">
  <label>What</label>
  <input type="text" id="title" placeholder="e.g. Call the vet" autocomplete="off">
  <div style="margin-top:10px">
    <label>Repeat</label>
    <select id="repeat" onchange="onRepeatChange()">
      <option value="none">Once</option>
      <option value="daily">Daily</option>
      <option value="weekly">Weekly</option>
      <option value="monthly">Monthly</option>
    </select>
  </div>
  <div class="row" id="dateRow">
    <div>
      <label>Date</label>
      <input type="date" id="date">
    </div>
    <div>
      <label>Time</label>
      <input type="time" id="time">
    </div>
  </div>
  <div id="timeOnlyRow" style="margin-top:10px; display:none">
    <label>Time</label>
    <input type="time" id="rtime">
  </div>
  <div id="weekdayRow" style="margin-top:10px; display:none">
    <label>Days</label>
    <div id="weekdays" class="weekdays"></div>
  </div>
  <div id="domRow" style="margin-top:10px; display:none">
    <label>Day of month (1-31)</label>
    <input type="number" id="dom" min="1" max="31" value="1">
  </div>
  <div class="warn" id="warn">Under 30 minutes away — open the app after saving so it arms right away.</div>
  <button class="primary" id="addBtn" onclick="addReminder()">Add reminder</button>
</div>

<h2>Pending <span class="count" id="count"></span></h2>
<table>
  <thead><tr><th>What</th><th>When</th><th></th></tr></thead>
  <tbody id="list"><tr><td colspan="3" class="empty">Loading…</td></tr></tbody>
</table>

<h2 style="margin-top:22px">Recurring <span class="count" id="rcount"></span></h2>
<table>
  <thead><tr><th>What</th><th>Repeats</th><th></th></tr></thead>
  <tbody id="rlist"><tr><td colspan="3" class="empty">Loading…</td></tr></tbody>
</table>

<div id="toast"></div>

<script>
const LEAD_MIN = 30;

function toast(msg, ok){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = (ok ? 'ok' : 'err') + ' show';
  setTimeout(()=>{ t.className = ok ? 'ok' : 'err'; }, 2600);
}

function pad(n){ return String(n).padStart(2,'0'); }

// Default the form to today and the next round half-hour.
const WD_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// Build the weekday toggle buttons once.
function buildWeekdays(){
  const box = document.getElementById('weekdays');
  box.innerHTML = WD_NAMES.map(function(n,i){
    return '<div class="wd" data-d="'+i+'">'+n+'</div>';
  }).join('');
  box.addEventListener('click', function(e){
    const el = e.target.closest('.wd');
    if(el) el.classList.toggle('on');
  });
}

function onRepeatChange(){
  const v = document.getElementById('repeat').value;
  document.getElementById('dateRow').style.display    = (v === 'none') ? 'flex' : 'none';
  document.getElementById('timeOnlyRow').style.display= (v === 'none') ? 'none' : 'block';
  document.getElementById('weekdayRow').style.display = (v === 'weekly') ? 'block' : 'none';
  document.getElementById('domRow').style.display     = (v === 'monthly') ? 'block' : 'none';
}

function repeatSummary(r){
  if(r.type === 'daily') return 'Daily · ' + to12h(r.time_str);
  if(r.type === 'weekly'){
    const days = String(r.weekdays||'').split(',').filter(function(s){return s!=='';})
      .map(function(s){ return WD_NAMES[parseInt(s,10)]; }).join(', ');
    return 'Weekly · ' + days + ' · ' + to12h(r.time_str);
  }
  if(r.type === 'monthly') return 'Monthly · day ' + r.day_of_month + ' · ' + to12h(r.time_str);
  return '';
}

function to12h(hhmm){
  const parts = String(hhmm).split(':').map(Number);
  let h = parts[0]; const m = pad(parts[1]);
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12; if(h===0) h = 12;
  return h+':'+m+' '+ap;
}

async function loadRecurring(){
  try{
    const r = await fetch('/api/recurring-reminders');
    const data = await r.json();
    const list = data.recurring || [];
    const tb = document.getElementById('rlist');
    document.getElementById('rcount').textContent = list.length ? '· ' + list.length : '';
    if(!list.length){
      tb.innerHTML = '<tr><td colspan="3" class="empty">No recurring reminders.</td></tr>';
      return;
    }
    tb.innerHTML = list.map(function(r){
      const safeTitle = String(r.title)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return '<tr>' +
        '<td>' + safeTitle + '</td>' +
        '<td class="when">' + repeatSummary(r) + '</td>' +
        '<td style="text-align:right"><button class="del" onclick="delRecurring(' + r.id + ')">&times;</button></td>' +
        '</tr>';
    }).join('');
  }catch(e){
    document.getElementById('rlist').innerHTML =
      '<tr><td colspan="3" class="empty">Could not load recurring.</td></tr>';
  }
}

async function delRecurring(id){
  try{
    const r = await fetch('/api/recurring-reminders/' + id, { method: 'DELETE' });
    if(!r.ok) throw new Error('Failed to delete');
    loadRecurring(); load();
  }catch(e){ toast(e.message, false); }
}

function seedDefaults(){
  const now = new Date();
  const d = new Date(now.getTime() + 60*60*1000);
  document.getElementById('date').value =
    d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
  document.getElementById('time').value = pad(d.getHours())+':'+pad(d.getMinutes());
}

function chosenDate(){
  const d = document.getElementById('date').value;
  const t = document.getElementById('time').value;
  if(!d || !t) return null;
  const parts = d.split('-').map(Number);
  const tp = t.split(':').map(Number);
  return new Date(parts[0], parts[1]-1, parts[2], tp[0], tp[1], 0, 0);
}

function checkLead(){
  const when = chosenDate();
  const warn = document.getElementById('warn');
  if(!when){ warn.classList.remove('show'); return; }
  const diffMin = (when.getTime() - Date.now()) / 60000;
  if(diffMin < LEAD_MIN){ warn.classList.add('show'); }
  else { warn.classList.remove('show'); }
}

document.getElementById('date').addEventListener('input', checkLead);
document.getElementById('time').addEventListener('input', checkLead);

function fmtWhen(s){
  const p = s.split(' ');
  const d = p[0].split('-').map(Number);
  const t = p[1].split(':').map(Number);
  const dt = new Date(d[0], d[1]-1, d[2], t[0], t[1]);
  const now = new Date();
  const sameDay = dt.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 86400000);
  const isTomorrow = dt.toDateString() === tomorrow.toDateString();
  let h = dt.getHours(); const m = pad(dt.getMinutes());
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if(h === 0) h = 12;
  const time = h+':'+m+' '+ap;
  if(sameDay) return 'Today ' + time;
  if(isTomorrow) return 'Tomorrow ' + time;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[dt.getMonth()]+' '+dt.getDate()+', '+time;
}

function minutesUntil(s){
  const p = s.split(' ');
  const d = p[0].split('-').map(Number);
  const t = p[1].split(':').map(Number);
  const dt = new Date(d[0], d[1]-1, d[2], t[0], t[1]);
  return (dt.getTime() - Date.now()) / 60000;
}

async function load(){
  try{
    const r = await fetch('/api/reminders');
    const data = await r.json();
    const list = data.reminders || [];
    const tb = document.getElementById('list');
    document.getElementById('count').textContent = list.length ? '· ' + list.length : '';
    if(!list.length){
      tb.innerHTML = '<tr><td colspan="3" class="empty">No pending reminders.</td></tr>';
      return;
    }
    tb.innerHTML = list.map(function(r){
      const soon = minutesUntil(r.remind_at) < LEAD_MIN ? ' soon' : '';
      const safeTitle = String(r.title)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return '<tr>' +
        '<td>' + safeTitle + '</td>' +
        '<td class="when' + soon + '">' + fmtWhen(r.remind_at) + '</td>' +
        '<td style="text-align:right"><button class="del" onclick="delReminder(' + r.id + ')">&times;</button></td>' +
        '</tr>';
    }).join('');
  }catch(e){
    document.getElementById('list').innerHTML =
      '<tr><td colspan="3" class="empty">Could not load reminders.</td></tr>';
  }
}

async function addReminder(){
  const btn = document.getElementById('addBtn');
  const title = document.getElementById('title').value.trim();
  const repeat = document.getElementById('repeat').value;
  if(!title){ toast('Enter what the reminder is for', false); return; }

  btn.disabled = true;
  try{
    if(repeat === 'none'){
      const date = document.getElementById('date').value;
      const time = document.getElementById('time').value;
      if(!date || !time){ toast('Pick a date and time', false); btn.disabled=false; return; }
      const when = chosenDate();
      if(when && when.getTime() <= Date.now()){ toast('That time has already passed', false); btn.disabled=false; return; }
      const r = await fetch('/api/reminders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title, date: date, time: time })
      });
      const data = await r.json();
      if(!r.ok) throw new Error(data.error || 'Failed to save');
      toast('Reminder added', true);
    } else {
      const time = document.getElementById('rtime').value;
      if(!time){ toast('Pick a time', false); btn.disabled=false; return; }
      const payload = { title: title, type: repeat, time: time };
      if(repeat === 'weekly'){
        const days = Array.prototype.slice.call(document.querySelectorAll('#weekdays .wd.on'))
          .map(function(el){ return parseInt(el.getAttribute('data-d'),10); });
        if(!days.length){ toast('Pick at least one day', false); btn.disabled=false; return; }
        payload.weekdays = days;
      }
      if(repeat === 'monthly'){
        payload.day_of_month = parseInt(document.getElementById('dom').value,10);
      }
      const r = await fetch('/api/recurring-reminders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if(!r.ok) throw new Error(data.error || 'Failed to save');
      toast('Recurring reminder added', true);
      loadRecurring();
    }
    document.getElementById('title').value = '';
    load();
  }catch(e){ toast(e.message, false); }
  finally{ btn.disabled = false; }
}

async function delReminder(id){
  try{
    const r = await fetch('/api/reminders/' + id, { method: 'DELETE' });
    if(!r.ok) throw new Error('Failed to delete');
    load();
  }catch(e){ toast(e.message, false); }
}

buildWeekdays(); onRepeatChange();
seedDefaults(); checkLead(); load(); loadRecurring();
setInterval(function(){ load(); loadRecurring(); }, 60000);
</script>
</body>
</html>`;
  res.send(html);
});


// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(3743, "0.0.0.0", () => {
  console.log("Solo Leveling on 3743");
});