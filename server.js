const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");
const https = require("https");

const db = new Database(path.join(__dirname, "system.db"));
const app = express();

app.use(cors());
app.use(express.json());

// ─── Hevy Config ──────────────────────────────────────────────────────────────
const HEVY_API_KEY = "YOUR_HEVY_API_KEY_HERE"; // hevy.com/settings?developer
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
      templates = db.prepare("SELECT * FROM daily_quest_templates WHERE time IS NOT NULL AND tuesday_time IS NULL AND wednesday_time IS NULL").all();
    }

    const insert = db.prepare("INSERT INTO quests (title, type, category, xp_reward, created_date, optional) VALUES (?, 'daily', ?, ?, ?, ?)");
    templates.forEach(t => {
      let time = null;
      if (dayOfWeek === 2 && t.tuesday_time) {
        time = t.tuesday_time;
      } else if (dayOfWeek === 3 && t.wednesday_time) {
        time = t.wednesday_time;
      } else if (t.time) {
        time = t.time;
      }
      if (time) {
        const title = t.title + " @ " + time;
        insert.run(title, t.category, t.xp_reward, today, t.optional);
      }
    });
    console.log("Daily quests generated for " + today);
  }
}

function generateWeeklyQuests() {
  const today = db.prepare("SELECT date('now', 'localtime') as today").get().today;
  const todayWeekday = db.prepare("SELECT CAST(strftime('%w', 'now', 'localtime') AS INTEGER) as dayOfWeek").get().dayOfWeek;

  const templates = db.prepare("SELECT * FROM weekly_quest_templates").all();
  const insert = db.prepare("INSERT INTO weekly_quests (template_id, title, weekday, category, xp_reward, created_date, optional) VALUES (?, ?, ?, ?, ?, ?, ?)");
  templates.forEach(t => {
    const exists = db.prepare("SELECT COUNT(*) as count FROM weekly_quests WHERE template_id = ?").get(t.id);
    if (exists.count === 0) {
      insert.run(t.id, t.title, t.weekday, t.category, t.xp_reward, today, t.optional);
    }
  });

  const resetResult = db.prepare("UPDATE weekly_quests SET completed = 0, created_date = ? WHERE weekday = ? AND created_date < ?")
    .run(today, todayWeekday, today);

  if (resetResult.changes > 0) {
    console.log("Reset " + resetResult.changes + " weekly quests for weekday " + todayWeekday);
  }
}

function startMidnightScheduler() {
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) {
      console.log("Midnight reset triggered at " + now.toISOString());
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

// Standards for ~191 lb male [beginner, novice, intermediate, advanced, elite] in lbs 1RM
const STRENGTH_STANDARDS = {
  "Bench Press (Barbell)":       [100, 145, 200, 275, 360],
  "Squat (Barbell)":             [125, 190, 270, 370, 480],
  "Deadlift (Barbell)":          [150, 225, 325, 445, 580],
  "Overhead Press (Barbell)":    [65,  95,  135, 185, 245],
  "Bent Over Row (Barbell)":     [85,  130, 185, 255, 335],
  "Romanian Deadlift":           [120, 185, 265, 365, 475],
  "Incline Bench Press (Barbell)": [85, 125, 175, 240, 315],
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

// ─── Existing Quest Endpoints ─────────────────────────────────────────────────
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

app.post("/api/quests/:id/complete", (req, res) => {
  console.log("RECEIVED COMPLETE REQUEST FOR QUEST: " + req.params.id);
  const quest = db.prepare("SELECT * FROM quests WHERE id = ?").get(req.params.id);
  db.prepare("UPDATE quests SET completed = 1 WHERE id = ?").run(req.params.id);
  db.prepare("UPDATE player SET xp = xp + ? WHERE id = 1").run(quest.xp_reward);

  if (quest.title && quest.title.includes("You Didn't Fap Today")) {
    db.prepare("UPDATE player SET nofap_streak = nofap_streak + 1 WHERE id = 1").run();
  }

  console.log("QUEST COMPLETED: " + req.params.id);
  res.json({ success: true, xpGained: quest.xp_reward });
});

app.post("/api/quests/:id/uncomplete", (req, res) => {
  console.log("RECEIVED UNCOMPLETE REQUEST FOR QUEST: " + req.params.id);
  const quest = db.prepare("SELECT * FROM quests WHERE id = ?").get(req.params.id);
  db.prepare("UPDATE quests SET completed = 0 WHERE id = ?").run(req.params.id);
  db.prepare("UPDATE player SET xp = xp - ? WHERE id = 1").run(quest.xp_reward);

  if (quest.title && quest.title.includes("You Didn't Fap Today")) {
    db.prepare("UPDATE player SET nofap_streak = MAX(0, nofap_streak - 1) WHERE id = 1").run();
  }

  console.log("QUEST UNCOMPLETED: " + req.params.id);
  res.json({ success: true, xpLost: quest.xp_reward });
});

app.post("/api/weekly-quests/:id/complete", (req, res) => {
  console.log("RECEIVED WEEKLY COMPLETE REQUEST FOR QUEST: " + req.params.id);
  const quest = db.prepare("SELECT * FROM weekly_quests WHERE id = ?").get(req.params.id);
  db.prepare("UPDATE weekly_quests SET completed = 1 WHERE id = ?").run(req.params.id);
  db.prepare("UPDATE player SET xp = xp + ? WHERE id = 1").run(quest.xp_reward);
  console.log("WEEKLY QUEST COMPLETED: " + req.params.id);
  res.json({ success: true, xpGained: quest.xp_reward });
});

app.post("/api/weekly-quests/:id/uncomplete", (req, res) => {
  console.log("RECEIVED WEEKLY UNCOMPLETE REQUEST FOR QUEST: " + req.params.id);
  const quest = db.prepare("SELECT * FROM weekly_quests WHERE id = ?").get(req.params.id);
  db.prepare("UPDATE weekly_quests SET completed = 0 WHERE id = ?").run(req.params.id);
  db.prepare("UPDATE player SET xp = xp - ? WHERE id = 1").run(quest.xp_reward);
  console.log("WEEKLY QUEST UNCOMPLETED: " + req.params.id);
  res.json({ success: true, xpLost: quest.xp_reward });
});

// ─── Gym Helpers ─────────────────────────────────────────────────────────────
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
    // Detect current week from the most recent workout that has a Week number in its title
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
        // Fallback: show any routine used in recent workouts
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

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(3743, "0.0.0.0", () => {
  console.log("Solo Leveling on 3743");
});