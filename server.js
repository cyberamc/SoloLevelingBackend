const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "system.db"));
const app = express();

app.use(cors());
app.use(express.json());

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
    db.prepare("INSERT INTO player (id, name, level, xp, rank) VALUES (1, 'HUNTER', 1, 0, 'E')").run();
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
    gold: player.gold
  };
}

function generateDailyQuests() {
  const today = new Date().toISOString().split('T')[0];
  
  // Delete yesterday's quests to force fresh generation
  db.prepare("DELETE FROM quests WHERE type = 'daily' AND created_date != ?").run(today);
  
  const existing = db.prepare("SELECT COUNT(*) as count FROM quests WHERE created_date = ? AND type = 'daily'").get(today);
  
  if (existing.count === 0) {
    const dayOfWeek = new Date().getDay();
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
    console.log("Daily quests for " + today);
  }
}

function generateWeeklyQuests() {
  const today = new Date().toISOString().split('T')[0];
  const existing = db.prepare("SELECT COUNT(*) as count FROM weekly_quests WHERE created_date = ?").get(today);
  
  if (existing.count === 0) {
    const templates = db.prepare("SELECT * FROM weekly_quest_templates").all();
    console.log("TEMPLATE_COUNT=" + templates.length);
    
    const insert = db.prepare("INSERT INTO weekly_quests (template_id, title, weekday, category, xp_reward, created_date, optional) VALUES (?, ?, ?, ?, ?, ?, ?)");
    let insCount = 0;
    templates.forEach(t => {
      insert.run(t.id, t.title, t.weekday, t.category, t.xp_reward, today, t.optional);
      insCount++;
    });
    console.log("INSERTED=" + insCount);
  }
}

app.get("/api/player", (req, res) => {
  res.json(getPlayer());
});

app.get("/api/quests", (req, res) => {
  generateDailyQuests();
  generateWeeklyQuests();
  
  const today = new Date().toISOString().split('T')[0];
  const daily = db.prepare("SELECT * FROM quests WHERE created_date = ? AND type = 'daily' ORDER BY id").all(today);
  const weekly = db.prepare("SELECT * FROM weekly_quests WHERE created_date = ? ORDER BY weekday, optional, completed").all(today);
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
  
  const today = new Date().toISOString().split('T')[0];
  const todayWeekday = new Date().getDay();
  
  const all = db.prepare("SELECT wq.* FROM weekly_quests wq WHERE wq.created_date = ? ORDER BY wq.weekday, wq.optional, wq.completed").all(today);
  const withOverdue = all.map(q => ({
    ...q,
    isOverdue: q.completed === 0 && q.optional === 0 && q.weekday < todayWeekday ? 1 : 0
  }));
  
  res.json(withOverdue);
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

app.listen(3743, "0.0.0.0", () => {
  console.log("Solo Leveling on 3743");
});
