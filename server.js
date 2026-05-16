const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const cron = require("node-cron");
const PORT = 3743;
const DB_PATH = path.join(__dirname, "system.db");
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS player (id INTEGER PRIMARY KEY, name TEXT DEFAULT 'HUNTER', level INTEGER DEFAULT 1, xp INTEGER DEFAULT 0, stat_str INTEGER DEFAULT 5, stat_int INTEGER DEFAULT 5, stat_vit INTEGER DEFAULT 5, stat_agi INTEGER DEFAULT 5, stat_end INTEGER DEFAULT 5, stat_points INTEGER DEFAULT 0, gold INTEGER DEFAULT 0, rank TEXT DEFAULT 'E')`);
db.exec(`CREATE TABLE IF NOT EXISTS quests (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, type TEXT DEFAULT 'daily', category TEXT DEFAULT 'STR', xp_reward INTEGER DEFAULT 20, gold_reward INTEGER DEFAULT 5, completed INTEGER DEFAULT 0, streak INTEGER DEFAULT 0, created_date TEXT DEFAULT CURRENT_DATE)`);
db.exec(`CREATE TABLE IF NOT EXISTS daily_quest_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, time TEXT, category TEXT DEFAULT 'STR', xp_reward INTEGER DEFAULT 20, gold_reward INTEGER DEFAULT 5)`);
db.exec(`CREATE TABLE IF NOT EXISTS weekly_quest_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, weekday INTEGER NOT NULL, category TEXT DEFAULT 'STR', xp_reward INTEGER DEFAULT 20, gold_reward INTEGER DEFAULT 5)`);
db.exec(`CREATE TABLE IF NOT EXISTS weekly_quests (id INTEGER PRIMARY KEY AUTOINCREMENT, template_id INTEGER NOT NULL, title TEXT NOT NULL, weekday INTEGER NOT NULL, category TEXT DEFAULT 'STR', xp_reward INTEGER DEFAULT 20, gold_reward INTEGER DEFAULT 5, completed INTEGER DEFAULT 0, created_date TEXT DEFAULT CURRENT_DATE, FOREIGN KEY (template_id) REFERENCES weekly_quest_templates(id))`);
db.exec(`CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, description TEXT, gold_change INTEGER DEFAULT 0, xp_change INTEGER DEFAULT 0, timestamp TEXT DEFAULT CURRENT_TIMESTAMP)`);
db.exec(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT, timestamp TEXT DEFAULT CURRENT_TIMESTAMP)`);
const existingPlayer = db.prepare("SELECT COUNT(*) as count FROM player").get().count;
if (existingPlayer === 0) {
  db.prepare(`INSERT INTO player (id, name, level, xp, stat_str, stat_int, stat_vit, stat_agi, stat_end, stat_points, gold, rank) VALUES (1, 'HUNTER', 1, 0, 5, 5, 5, 5, 5, 0, 0, 'E')`).run();
  console.log("✓ Player initialized");
}
const templateCount = db.prepare("SELECT COUNT(*) as count FROM daily_quest_templates").get().count;
if (templateCount === 0) {
  const templates = [
    { title: "Wake Up @ 6 AM", time: "6:00 AM", xp: 10 },
    { title: "Walk Toby @ 6:30 AM", time: "6:30 AM", xp: 15 },
    { title: "Gym @ 7 AM", time: "7:00 AM", xp: 25 },
    { title: "Shower @ 8:15 AM", time: "8:15 AM", xp: 10 },
    { title: "Feed Toby & Luna - 9 AM", time: "9:00 AM", xp: 10 },
    { title: "Clean Kitchen, Table, Hallway, Bathroom, & Bedroom - 9:15 AM", time: "9:15 AM", xp: 20 },
    { title: "Prepare Pre-Workout - 9:45 AM", time: "9:45 AM", xp: 10 },
    { title: "Prepare Soda - 9:50 AM", time: "9:50 AM", xp: 10 },
    { title: "Prepare Tomorrow's Clothes - 9:55 AM", time: "9:55 AM", xp: 10 },
    { title: "Study @10 AM", time: "10:00 AM", xp: 30 },
    { title: "Work @ 12 PM", time: "12:00 PM", xp: 50 },
    { title: "Take Nightly Supplements & Walk Toby @ 9 PM", time: "9:00 PM", xp: 15 },
    { title: "Do Parasympathetic Stretching @ 9:15 PM", time: "9:15 PM", xp: 15 },
    { title: "Dark Room Decompression @ 9:40 PM", time: "9:40 PM", xp: 10 },
    { title: "Final Check Before Bed @ 9:55 PM", time: "9:55 PM", xp: 10 },
  ];
  const insert = db.prepare(`INSERT INTO daily_quest_templates (title, time, category, xp_reward) VALUES (?, ?, 'INT', ?)`);
  templates.forEach(t => insert.run(t.title, t.time, t.xp));
  console.log("✓ Daily quest templates initialized");
}
const weeklyTemplateCount = db.prepare("SELECT COUNT(*) as count FROM weekly_quest_templates").get().count;
if (weeklyTemplateCount === 0) {
  const weeklyTemplates = [
    { title: "Do Laundry & Set Timer", weekday: 0, xp: 10 },
    { title: "Prepare Weekly Supplements", weekday: 0, xp: 10 },
    { title: "Damon's Therapy @ 9:15 AM - 10:45 AM", weekday: 1, xp: 15 },
    { title: "Damon's Therapy @ 8:00 AM - 8:30 AM", weekday: 4, xp: 15 },
  ];
  const insert = db.prepare(`INSERT INTO weekly_quest_templates (title, weekday, category, xp_reward) VALUES (?, ?, 'INT', ?)`);
  weeklyTemplates.forEach(t => insert.run(t.title, t.weekday, t.xp));
  console.log("✓ Weekly quest templates initialized");
}

function calculateXpForLevel(level) {
  return 100 * level;
}

function calculateTotalXpForLevel(level) {
  return 100 * level * (level + 1) / 2;
}

function calculateLevelFromXp(xp) {
  let level = 1;
  while (calculateTotalXpForLevel(level + 1) <= xp) {
    level++;
  }
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
    db.prepare(`INSERT INTO player (id, name, level, xp, stat_str, stat_int, stat_vit, stat_agi, stat_end, stat_points, gold, rank) VALUES (1, 'HUNTER', 1, 0, 5, 5, 5, 5, 5, 0, 0, 'E')`).run();
    player = db.prepare("SELECT * FROM player WHERE id = 1").get();
  }
  
  const level = calculateLevelFromXp(player.xp);
  const rank = calculateRank(level);
  const nextLevelXp = calculateTotalXpForLevel(level + 1);
  const currentLevelXp = calculateTotalXpForLevel(level);
  const xpInCurrentLevel = player.xp - currentLevelXp;
  const xpNeededForLevel = nextLevelXp - currentLevelXp;

  return {
    id: player.id,
    name: player.name,
    level: level,
    xp: player.xp,
    xpInCurrentLevel: xpInCurrentLevel,
    xpNeededForLevel: xpNeededForLevel,
    totalXp: player.xp,
    totalXpNeeded: nextLevelXp,
    rank: rank,
    gold: player.gold,
    statPoints: player.stat_points,
    stats: {
      STR: player.stat_str,
      INT: player.stat_int,
      VIT: player.stat_vit,
      AGI: player.stat_agi,
      END: player.stat_end,
    }
  };
}

function generateDailyQuests() {
  const today = new Date().toISOString().split('T')[0];
  const existing = db.prepare("SELECT COUNT(*) as count FROM quests WHERE created_date = ? AND type = 'daily'").get(today);
  if (existing.count === 0) {
    const templates = db.prepare("SELECT * FROM daily_quest_templates").all();
    const insert = db.prepare(`INSERT INTO quests (title, type, category, xp_reward, created_date) VALUES (?, 'daily', ?, ?, ?)`);
    templates.forEach(t => {
      const finalTitle = t.title.includes('@') ? t.title : (t.time ? `${t.title} @ ${t.time}` : t.title);
      insert.run(finalTitle, t.category, t.xp_reward, today);
    });
    console.log(`✓ Daily quests generated for ${today}`);
  }
}

function generateWeeklyQuests() {
  const today = new Date().toISOString().split('T')[0];
  const existing = db.prepare("SELECT COUNT(*) as count FROM weekly_quests WHERE created_date = ?").get(today);
  if (existing.count === 0) {
    const calendar = new Date();
    const todayWeekday = calendar.getDay();
    
    const templates = db.prepare("SELECT * FROM weekly_quest_templates WHERE weekday = ?").all(todayWeekday);
    const insert = db.prepare(`INSERT INTO weekly_quests (template_id, title, weekday, category, xp_reward, created_date) VALUES (?, ?, ?, ?, ?, ?)`);
    templates.forEach(t => {
      insert.run(t.id, t.title, t.weekday, t.category, t.xp_reward, today);
    });
    if (templates.length > 0) {
      console.log(`✓ Weekly quests generated for ${today} (${templates.length} quests)`);
    }
  }
}

generateDailyQuests();
generateWeeklyQuests();
app.get("/api/player", (_, res) => {
  res.json(getPlayer());
});
app.patch("/api/player/name", (req, res) => {
  const { name } = req.body;
  db.prepare("UPDATE player SET name = ? WHERE id = 1").run(name);
  res.json(getPlayer());
});
app.post("/api/player/allocate-stat", (req, res) => {
  const { stat } = req.body;
  const player = db.prepare("SELECT * FROM player WHERE id = 1").get();
  if (player.stat_points < 1) return res.status(400).json({ error: "No stat points" });
  const statCol = `stat_${stat.toLowerCase()}`;
  db.prepare(`UPDATE player SET ${statCol} = ${statCol} + 1, stat_points = stat_points - 1 WHERE id = 1`).run();
  res.json(getPlayer());
});
app.get("/api/quests", (_, res) => {
  generateDailyQuests();
  generateWeeklyQuests();
  const today = new Date().toISOString().split('T')[0];
  const dailyQuests = db.prepare("SELECT * FROM quests WHERE type = 'daily' AND created_date = ? ORDER BY id").all(today);
  const weeklyQuests = db.prepare("SELECT * FROM weekly_quests WHERE created_date = ? ORDER BY id").all(today);
  const dailiesCompleted = dailyQuests.filter(q => q.completed).length;
  const weekliesCompleted = weeklyQuests.filter(q => q.completed).length;
  res.json({
    dailyQuests: dailyQuests.map(q => ({
      id: q.id,
      title: q.title,
      type: q.type,
      category: q.category,
      xpReward: q.xp_reward,
      goldReward: q.gold_reward,
      completed: q.completed === 1,
      streak: q.streak
    })),
    weeklyQuests: weeklyQuests.map(q => ({
      id: q.id,
      title: q.title,
      type: q.type,
      category: q.category,
      xpReward: q.xp_reward,
      goldReward: q.gold_reward,
      completed: q.completed === 1,
      streak: q.streak
    })),
    dailiesCompleted,
    weekliesCompleted,
    totalDailies: dailyQuests.length,
    totalWeeklies: weeklyQuests.length,
    hasWeeklyQuests: weeklyQuests.length > 0,
    perfectClearBonus: dailiesCompleted === dailyQuests.length && dailyQuests.length > 0 ? 50 : 0
  });
});
app.get("/api/weekly-quests/all", (_, res) => {
  const allTemplates = db.prepare("SELECT * FROM weekly_quest_templates ORDER BY weekday, id").all();
  const today = new Date().toISOString().split('T')[0];
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const result = allTemplates.map(t => {
    const completed = db.prepare("SELECT completed FROM weekly_quests WHERE template_id = ? AND created_date = ?").get(t.id, today);
    return {
      id: t.id,
      title: t.title,
      weekday: t.weekday,
      weekdayName: dayNames[t.weekday],
      category: t.category,
      xpReward: t.xp_reward,
      goldReward: t.gold_reward,
      completed: completed ? completed.completed === 1 : false
    };
  });
  res.json(result);
});
app.post("/api/quests/:id/complete", (req, res) => {
  try {
    const questRow = db.prepare("SELECT * FROM quests WHERE id = ?").get(req.params.id);
    if (!questRow) return res.status(404).json({ error: "Quest not found" });
    db.prepare("UPDATE quests SET completed = 1 WHERE id = ?").run(req.params.id);
    const playerRow = db.prepare("SELECT * FROM player WHERE id = 1").get();
    const newXp = playerRow.xp + questRow.xp_reward;
    const newLevel = Math.floor(newXp / 100) + 1;
    db.prepare("UPDATE player SET xp = ?, level = ? WHERE id = 1").run(newXp, newLevel);
    res.json({ success: true, player: getPlayer() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/quests/:id/uncomplete", (req, res) => {
  try {
    const questRow = db.prepare("SELECT * FROM quests WHERE id = ?").get(req.params.id);
    if (!questRow) return res.status(404).json({ error: "Quest not found" });
    db.prepare("UPDATE quests SET completed = 0 WHERE id = ?").run(req.params.id);
    res.json({ success: true, player: getPlayer() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/weekly-quests/:id/complete", (req, res) => {
  try {
    const templateId = parseInt(req.params.id);
    const templateRow = db.prepare("SELECT * FROM weekly_quest_templates WHERE id = ?").get(templateId);
    if (!templateRow) return res.status(404).json({ error: "Quest template not found" });
    const today = new Date().toISOString().split('T')[0];
    db.prepare("UPDATE weekly_quests SET completed = 1 WHERE template_id = ? AND created_date = ?").run(templateId, today);
    const playerRow = db.prepare("SELECT * FROM player WHERE id = 1").get();
    const newXp = playerRow.xp + templateRow.xp_reward;
    const newLevel = Math.floor(newXp / 100) + 1;
    db.prepare("UPDATE player SET xp = ?, level = ? WHERE id = 1").run(newXp, newLevel);
    res.json({ success: true, player: getPlayer() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/weekly-quests/:id/uncomplete", (req, res) => {
  try {
    const templateId = parseInt(req.params.id);
    const templateRow = db.prepare("SELECT * FROM weekly_quest_templates WHERE id = ?").get(templateId);
    if (!templateRow) return res.status(404).json({ error: "Quest template not found" });
    const today = new Date().toISOString().split('T')[0];
    db.prepare("UPDATE weekly_quests SET completed = 0 WHERE template_id = ? AND created_date = ?").run(templateId, today);
    res.json({ success: true, player: getPlayer() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/ledger", (req, res) => {
  const limit = req.query.limit || 50;
  const entries = db.prepare("SELECT * FROM ledger ORDER BY id DESC LIMIT ?").all(limit);
  res.json(entries);
});
app.post("/api/ledger", (req, res) => {
  const { type, description, goldChange, xpChange } = req.body;
  const result = db.prepare(`INSERT INTO ledger (type, description, gold_change, xp_change) VALUES (?, ?, ?, ?)`).run(type, description, goldChange, xpChange);
  res.json({ id: result.lastInsertRowid, type, description, goldChange, xpChange });
});
app.get("/api/logs", (_, res) => {
  const logs = db.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT 50").all();
  res.json(logs);
});
app.get("/api/ping", (_, res) => {
  res.json({ status: "online", time: new Date().toISOString() });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SYSTEM ONLINE — Port ${PORT}`);
  console.log(`Daily and weekly quests initialized`);
});
