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
  
  const sundayResult = db.prepare("SELECT date('now', 'localtime', '-' || CAST(strftime('%w', 'now', 'localtime') AS TEXT) || ' days') as sunday").get();
  const week_start_date = sundayResult.sunday;
  
  const todayWeekdayResult = db.prepare("SELECT CAST(strftime('%w', 'now', 'localtime') AS INTEGER) as dayOfWeek").get();
  const todayWeekday = todayWeekdayResult.dayOfWeek;
  
  // Delete quests from old weeks
  db.prepare("DELETE FROM weekly_quests WHERE week_start_date < ?").run(week_start_date);
  
  // Reset today's weekday quests if their created_date is before today (their reset day)
  const resetResult = db.prepare("UPDATE weekly_quests SET completed = 0, created_date = ? WHERE weekday = ? AND week_start_date = ? AND created_date < ?")
    .run(today, todayWeekday, week_start_date, today);
  
  if (resetResult.changes > 0) {
    console.log("Reset " + resetResult.changes + " weekly quests for weekday " + todayWeekday);
  }
  
  for (let weekday = 0; weekday <= 6; weekday++) {
    const existing = db.prepare("SELECT COUNT(*) as count FROM weekly_quests WHERE week_start_date = ? AND weekday = ?").get(week_start_date, weekday);
    
    if (existing.count === 0) {
      const templates = db.prepare("SELECT * FROM weekly_quest_templates WHERE weekday = ?").all(weekday);
      const insert = db.prepare("INSERT INTO weekly_quests (template_id, title, weekday, category, xp_reward, created_date, optional, week_start_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      
      templates.forEach(t => {
        insert.run(t.id, t.title, t.weekday, t.category, t.xp_reward, today, t.optional, week_start_date);
      });
    }
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

app.get("/api/player", (req, res) => {
  res.json(getPlayer());
});

app.get("/api/quests", (req, res) => {
  generateDailyQuests();
  generateWeeklyQuests();
  
  const today = db.prepare("SELECT date('now', 'localtime') as today").get().today;
  
  const sundayResult = db.prepare("SELECT date('now', 'localtime', '-' || CAST(strftime('%w', 'now', 'localtime') AS TEXT) || ' days') as sunday").get();
  const week_start_date = sundayResult.sunday;
  
  const daily = db.prepare("SELECT * FROM quests WHERE created_date = ? AND type = 'daily' ORDER BY id").all(today);
  const weekly = db.prepare("SELECT * FROM weekly_quests WHERE week_start_date = ? ORDER BY weekday, optional, completed").all(week_start_date);
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
  
  const todayWeekdayResult = db.prepare("SELECT CAST(strftime('%w', 'now', 'localtime') AS INTEGER) as dayOfWeek").get();
  const todayWeekday = todayWeekdayResult.dayOfWeek;
  
  const sundayResult = db.prepare("SELECT date('now', 'localtime', '-' || CAST(strftime('%w', 'now', 'localtime') AS TEXT) || ' days') as sunday").get();
  const week_start_date = sundayResult.sunday;
  
  const all = db.prepare("SELECT wq.* FROM weekly_quests wq WHERE wq.week_start_date = ? ORDER BY wq.weekday, wq.optional, wq.completed").all(week_start_date);
  const withOverdue = all.map(q => ({
    ...q,
    isOverdue: q.completed === 0 && q.optional === 0 && q.weekday < todayWeekday ? 1 : 0
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

app.listen(3743, "0.0.0.0", () => {
  console.log("Solo Leveling on 3743");
});
