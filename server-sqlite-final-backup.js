'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'xuanji-tarot-secret-xj2024';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

// ─── Database ──────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'xuanji.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    username         TEXT UNIQUE NOT NULL,
    password_hash    TEXT NOT NULL,
    is_admin         INTEGER DEFAULT 0,
    is_member        INTEGER DEFAULT 0,
    member_expires_at TEXT,
    free_uses        INTEGER DEFAULT 3,
    month_uses       INTEGER DEFAULT 0,
    month_reset_at   TEXT,
    invite_code_used TEXT,
    created_at       TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS invite_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT UNIQUE NOT NULL,
    used_by    INTEGER,
    used_at    TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (used_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS readings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    question    TEXT NOT NULL,
    cards       TEXT NOT NULL,
    result      TEXT NOT NULL,
    category    TEXT DEFAULT '其他',
    share_token TEXT,
    created_at  TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS question_stats (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    count    INTEGER DEFAULT 0,
    date     TEXT NOT NULL,
    UNIQUE(category, date)
  );
`);

// migration: add note column if not exists
try { db.exec(`ALTER TABLE users ADD COLUMN note TEXT DEFAULT NULL`); } catch(_) {}
// migration: add invited_by column if not exists
try { db.exec(`ALTER TABLE users ADD COLUMN invited_by TEXT DEFAULT NULL`); } catch(_) {}
// migration: add remaining_count column, copy from free_uses
try {
  db.exec(`ALTER TABLE users ADD COLUMN remaining_count INTEGER DEFAULT 3`);
  db.exec(`UPDATE users SET remaining_count = free_uses`);
} catch(_) {}

// seed admin
const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!adminExists) {
  const hash = bcrypt.hashSync('admin888', 10);
  db.prepare('INSERT INTO users (username,password_hash,is_admin,remaining_count) VALUES (?,?,1,9999)')
    .run('admin', hash);
  console.log('✓ 管理员账号已创建: admin / admin888');
}

// ─── Tarot Cards ───────────────────────────────────────────────────────────────
const MAJOR_ARCANA = [
  { id: 0,  name: '愚者',     name_en: 'The Fool' },
  { id: 1,  name: '魔术师',   name_en: 'The Magician' },
  { id: 2,  name: '女祭司',   name_en: 'The High Priestess' },
  { id: 3,  name: '女皇',     name_en: 'The Empress' },
  { id: 4,  name: '皇帝',     name_en: 'The Emperor' },
  { id: 5,  name: '教皇',     name_en: 'The Hierophant' },
  { id: 6,  name: '恋人',     name_en: 'The Lovers' },
  { id: 7,  name: '战车',     name_en: 'The Chariot' },
  { id: 8,  name: '力量',     name_en: 'Strength' },
  { id: 9,  name: '隐者',     name_en: 'The Hermit' },
  { id: 10, name: '命运之轮', name_en: 'Wheel of Fortune' },
  { id: 11, name: '正义',     name_en: 'Justice' },
  { id: 12, name: '倒吊人',   name_en: 'The Hanged Man' },
  { id: 13, name: '死神',     name_en: 'Death' },
  { id: 14, name: '节制',     name_en: 'Temperance' },
  { id: 15, name: '恶魔',     name_en: 'The Devil' },
  { id: 16, name: '塔',       name_en: 'The Tower' },
  { id: 17, name: '星星',     name_en: 'The Star' },
  { id: 18, name: '月亮',     name_en: 'The Moon' },
  { id: 19, name: '太阳',     name_en: 'The Sun' },
  { id: 20, name: '审判',     name_en: 'Judgement' },
  { id: 21, name: '世界',     name_en: 'The World' },
];

function drawCards(count = 3) {
  const pool = [...MAJOR_ARCANA].sort(() => Math.random() - 0.5);
  return pool.slice(0, count).map(c => ({ ...c, reversed: Math.random() > 0.55 }));
}

// ─── Question Classification ───────────────────────────────────────────────────
const CATEGORY_KEYWORDS = {
  '感情': ['爱情','恋爱','婚姻','分手','复合','男友','女友','男朋友','女朋友','伴侣','相亲','暗恋','表白','感情','情感','喜欢','爱','恋人','对象','追','脱单','约会','失恋','挽回','喜欢我','在乎','前任'],
  '事业': ['工作','职业','升职','加薪','跳槽','创业','职场','老板','同事','项目','求职','面试','事业','晋升','公司','上班','离职','辞职','转行','合作','客户','业务','考试','学业','考研'],
  '财运': ['钱','财富','投资','理财','收入','薪资','股票','基金','生意','财运','赚钱','借钱','债务','贷款','财务','资金','利润','亏损','彩票','副业','赚'],
  '健康': ['健康','身体','生病','疾病','医院','手术','心理','情绪','睡眠','焦虑','抑郁','压力','减肥','饮食','体重','运动','精神','状态','头痛','失眠'],
};

function classifyQuestion(q) {
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some(kw => q.includes(kw))) return cat;
  }
  return '其他';
}

function recordCategoryStat(category) {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO question_stats (category, count, date) VALUES (?, 1, ?)
    ON CONFLICT(category, date) DO UPDATE SET count = count + 1
  `).run(category, today);
}

// ─── DeepSeek API ──────────────────────────────────────────────────────────────
function buildTarotPrompt(question, cards) {
  const positions = ['过去·根因', '现在·核心', '未来·走向'];
  const cardDesc = cards.map((c, i) => {
    const orient = c.reversed ? '逆位' : '正位';
    return `  第${i + 1}张【${positions[i]}】：${c.name}（${c.name_en}）${orient}`;
  }).join('\n');

  return `你是"玄机塔罗"占卜师，精通分形结构语法塔罗体系，融合荣格原型心理学、卡巴拉生命之树与中国玄学智慧。

═══════════════════════════════════
提问者的问题：
${question}

本次抽取三张牌（过去·现在·未来三位一体展开）：
${cardDesc}
═══════════════════════════════════

请按以下分形结构进行深度解读：

**一、牌阵宏观格局**
简述三牌整体能量场，说明它们共同指向的核心议题（2-3句）。

**二、逐牌精解**
对每张牌深入解读——原型能量、象征意象、正/逆位含义，紧扣提问者的具体情境展开（每牌3-4句）。

**三、分形共鸣**
发现三牌之间隐藏的能量呼应与张力（数字、元素、原型模式的自相似性），揭示深层规律（2-3句）。

**四、玄机指引**
给出具体、可落地的行动建议或内在工作方向，语气温柔坚定，如至交相诫（3-4句）。

**五、一句箴言**
用一句优美的诗意语言凝结本次推演的核心启示。

语言风格：古典与现代融合，神秘而不晦涩，深邃而不说教，有温度有力量。
总字数：650-900字。`;
}

function callDeepSeek(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      temperature: 0.88,
      max_tokens: 2048,
    });

    const url = new URL(DEEPSEEK_ENDPOINT);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message || 'DeepSeek API error'));
          const content = json.choices?.[0]?.message?.content || '';
          if (!content) return reject(new Error('API返回内容为空'));
          resolve(content);
        } catch (e) { reject(new Error('解析API响应失败: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('API请求超时')); });
    req.write(body);
    req.end();
  });
}

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (!token) return res.status(401).json({ error: '请先登录' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
    if (!user) return res.status(401).json({ error: '用户不存在，请重新登录' });
    req.dbUser = user;
    next();
  } catch {
    res.status(401).json({ error: 'Token已过期，请重新登录' });
  }
}

function adminMiddleware(req, res, next) {
  if (!req.dbUser.is_admin) return res.status(403).json({ error: '无管理员权限' });
  next();
}

// ─── Usage Helpers ─────────────────────────────────────────────────────────────
function getRemainingUses(user) {
  if (user.is_admin) return 9999;
  return Math.max(0, user.remaining_count || 0);
}

function consumeUse(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (user.is_admin) return;
  db.prepare('UPDATE users SET remaining_count = MAX(0, remaining_count - 1) WHERE id = ?').run(userId);
}

// ─── Auth Routes ───────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  try {
    const { username, password, invite_code } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
    if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名长度2-20位' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
    if (!invite_code || !invite_code.trim()) return res.status(400).json({ error: '请输入邀请码' });

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return res.status(400).json({ error: '用户名已存在' });

    const inviteRecord = db.prepare('SELECT * FROM invite_codes WHERE code = ? AND used_by IS NULL').get(invite_code.trim().toUpperCase());
    if (!inviteRecord) return res.status(400).json({ error: '邀请码无效或已被使用' });

    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare(
      'INSERT INTO users (username, password_hash, invite_code_used, invited_by) VALUES (?, ?, ?, ?)'
    ).run(username, hash, invite_code.trim().toUpperCase(), invite_code.trim().toUpperCase());

    db.prepare("UPDATE invite_codes SET used_by = ?, used_at = datetime('now','localtime') WHERE id = ?")
      .run(result.lastInsertRowid, inviteRecord.id);

    const token = jwt.sign({ id: result.lastInsertRowid, username }, JWT_SECRET, { expiresIn: '30d' });
    const newUser = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.json({ token, username, is_admin: false, remaining_uses: getRemainingUses(newUser) });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: '注册失败：' + (err.message || '服务器内部错误') });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请填写用户名和密码' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({
    token,
    username: user.username,
    is_admin: !!user.is_admin,
    is_member: !!user.is_member,
    remaining_uses: getRemainingUses(user),
  });
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_admin = 1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: '管理员账号或密码错误' });
  }
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const u = req.dbUser;
  res.json({
    id: u.id,
    username: u.username,
    is_admin: !!u.is_admin,
    is_member: !!u.is_member,
    member_expires_at: u.member_expires_at,
    remaining_uses: getRemainingUses(u),
  });
});

// ─── Reading Route ─────────────────────────────────────────────────────────────
app.post('/api/read', authMiddleware, async (req, res) => {
  const { question } = req.body || {};
  if (!question || question.trim().length < 2) return res.status(400).json({ error: '请输入你的问题（至少2个字）' });
  if (question.length > 300) return res.status(400).json({ error: '问题不超过300字' });
  if (!DEEPSEEK_API_KEY) return res.status(500).json({ error: '服务未配置API Key，请联系管理员' });

  const u = req.dbUser;
  const remaining = getRemainingUses(u);
  if (remaining <= 0) return res.status(403).json({ error: 'NO_USES', message: '推演次数已用完' });

  const cards = drawCards(3);
  const category = classifyQuestion(question.trim());

  try {
    const prompt = buildTarotPrompt(question.trim(), cards);
    const result = await callDeepSeek([
      { role: 'system', content: '你是玄机塔罗占卜师，用简体中文进行深度塔罗解读，语言优美而有洞见。' },
      { role: 'user', content: prompt },
    ]);

    consumeUse(u.id);
    recordCategoryStat(category);

    const insertResult = db.prepare(
      'INSERT INTO readings (user_id, question, cards, result, category) VALUES (?,?,?,?,?)'
    ).run(u.id, question.trim(), JSON.stringify(cards), result, category);

    const freshUser = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);

    res.json({
      id: insertResult.lastInsertRowid,
      question: question.trim(),
      cards,
      result,
      category,
      remaining_uses: getRemainingUses(freshUser),
    });
  } catch (err) {
    console.error('DeepSeek error:', err.message);
    res.status(500).json({ error: '推演服务暂时不可用，请稍后再试。（次数未扣除）' });
  }
});

// ─── New UI Routes (五窗口分形推演) ────────────────────────────────────────────
const SYS_PROMPT_FRACTAL = `你是一位深谙"分形结构语法"的塔罗推演者。不依赖牌意书或关键词库，只基于位置逻辑与过程语法推演。

# 规则
## 四个中性过程
- 水（圣杯）：内在孕育，边界内部酝酿
- 土（星币）：向外成形，推出痕迹
- 火（权杖）：已存在的内容
- 风（宝剑）：内容回流
水→土→火→风→水，闭合圆。

## 大阿尔卡纳
11号力量为中轴。1-5水，6-10土，12-16火，17-21风。0愚者圆外。韦特编号（8=正义，11=力量）。

## 小阿尔卡纳三层坐标
花色=过程。2-3水组，4-5土组，6-7火组，8-9风组。

## 宫廷牌
国王=火风格，王后=水风格，骑士=风风格，侍卫=土风格。

## 正逆位
正位=外面，逆位=内面。不改坐标改观察角度。

# 禁令
- 禁止传统牌意关键词
- 禁止引用牌意书
- 只从结构坐标推导
- 语言具体深刻

# 输出格式
每张牌：
### 【窗口名】牌名（正位/逆位）
**结构坐标**：位置描述
**过程信号**：中性结构描述
**情境翻译**：结合问题的深度解读
---
最后：
## 综合洞察
串联所有窗口的完整图景。结构清晰，洞察犀利。`;

app.post('/api/reading', authMiddleware, async (req, res) => {
  const { question, cards_info } = req.body || {};
  if (!question || question.trim().length < 2) return res.status(400).json({ error: '请输入你的问题（至少2个字）' });
  if (!cards_info) return res.status(400).json({ error: '缺少牌阵信息' });
  if (!DEEPSEEK_API_KEY) return res.status(500).json({ error: '服务未配置API Key' });

  const u = req.dbUser;
  const remaining = getRemainingUses(u);
  if (remaining <= 0) return res.status(403).json({ error: 'NO_USES', message: '推演次数已用完' });

  const category = classifyQuestion(question.trim());
  try {
    const result = await callDeepSeek([
      { role: 'system', content: SYS_PROMPT_FRACTAL },
      { role: 'user', content: `问题：${question.trim()}\n\n牌阵：五窗口结构采样\n${cards_info}\n\n请按格式推演。` },
    ]);

    consumeUse(u.id);
    recordCategoryStat(category);

    const insertResult = db.prepare(
      'INSERT INTO readings (user_id, question, cards, result, category) VALUES (?,?,?,?,?)'
    ).run(u.id, question.trim(), cards_info, result, category);

    const freshUser = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
    res.json({ reading: result, id: insertResult.lastInsertRowid, remaining_uses: getRemainingUses(freshUser) });
  } catch (err) {
    console.error('Reading error:', err.message);
    res.status(500).json({ error: '推演服务暂时不可用，请稍后再试' });
  }
});

app.post('/api/followup', authMiddleware, async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: '缺少对话内容' });
  if (!DEEPSEEK_API_KEY) return res.status(500).json({ error: '服务未配置API Key' });

  const u = req.dbUser;
  const remaining = getRemainingUses(u);
  if (remaining <= 0) return res.status(403).json({ error: 'NO_USES', message: '推演次数已用完' });

  const sysFollowup = SYS_PROMPT_FRACTAL + '\n\n现在用户在追问。基于同一次推演的上下文回答，保持结构语法框架，语言简洁直接。不要重复已经说过的内容，直接回答新问题。';
  try {
    const reply = await callDeepSeek([
      { role: 'system', content: sysFollowup },
      ...messages,
    ]);
    consumeUse(u.id);
    const freshUser = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
    res.json({ reply, remaining_uses: getRemainingUses(freshUser) });
  } catch (err) {
    console.error('Followup error:', err.message);
    res.status(500).json({ error: '追问服务暂时不可用，请稍后再试' });
  }
});

// ─── History Routes ────────────────────────────────────────────────────────────
app.get('/api/history', authMiddleware, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 10;
  const offset = (page - 1) * limit;
  const rows = db.prepare(
    'SELECT id, question, cards, result, category, share_token, created_at FROM readings WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?'
  ).all(req.dbUser.id, limit, offset);
  const total = db.prepare('SELECT COUNT(*) as c FROM readings WHERE user_id = ?').get(req.dbUser.id).c;
  res.json({ list: rows.map(r => ({ ...r, cards: JSON.parse(r.cards) })), total, page, pages: Math.ceil(total / limit) });
});

app.get('/api/history/:id', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM readings WHERE id = ? AND user_id = ?').get(req.params.id, req.dbUser.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  res.json({ ...row, cards: JSON.parse(row.cards) });
});

app.delete('/api/history/:id', authMiddleware, (req, res) => {
  const info = db.prepare('DELETE FROM readings WHERE id = ? AND user_id = ?').run(req.params.id, req.dbUser.id);
  if (!info.changes) return res.status(404).json({ error: '记录不存在' });
  res.json({ message: '已删除' });
});

// ─── Share Routes ──────────────────────────────────────────────────────────────
app.post('/api/share/:id', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM readings WHERE id = ? AND user_id = ?').get(req.params.id, req.dbUser.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  let token = row.share_token;
  if (!token) {
    token = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    db.prepare('UPDATE readings SET share_token = ? WHERE id = ?').run(token, row.id);
  }
  res.json({ share_token: token, share_url: `/share/${token}` });
});

app.get('/api/share/:token', (req, res) => {
  const row = db.prepare(
    'SELECT question, cards, result, category, created_at FROM readings WHERE share_token = ?'
  ).get(req.params.token);
  if (!row) return res.status(404).json({ error: '分享链接不存在' });
  res.json({ ...row, cards: JSON.parse(row.cards) });
});

// ─── Admin Routes ──────────────────────────────────────────────────────────────
app.get('/api/admin/stats', authMiddleware, adminMiddleware, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const totalUsers    = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_admin = 0').get().c;
  const todayUsers    = db.prepare("SELECT COUNT(*) as c FROM users WHERE is_admin = 0 AND created_at LIKE ?").get(today + '%').c;
  const todayReadings = db.prepare("SELECT COUNT(*) as c FROM readings WHERE created_at LIKE ?").get(today + '%').c;
  const members       = db.prepare("SELECT COUNT(*) as c FROM users WHERE remaining_count > 0 AND is_admin = 0").get().c;
  const totalReadings = db.prepare('SELECT COUNT(*) as c FROM readings').get().c;
  res.json({ totalUsers, todayUsers, todayReadings, members, totalReadings });
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  const search = req.query.search || '';
  const page   = Math.max(1, parseInt(req.query.page) || 1);
  const limit  = 20;
  const offset = (page - 1) * limit;
  const like   = `%${search}%`;
  const rows = db.prepare(
    'SELECT id, username, note, invited_by, remaining_count, created_at FROM users WHERE is_admin = 0 AND username LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?'
  ).all(like, limit, offset);
  const total = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_admin = 0 AND username LIKE ?').get(like).c;
  res.json({ list: rows, total });
});

app.post('/api/admin/users/:id/member', authMiddleware, adminMiddleware, (req, res) => {
  const { action, months } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_admin = 0').get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  if (action === 'grant') {
    const m = Math.max(1, parseInt(months) || 1);
    const base = (user.is_member && user.member_expires_at && new Date(user.member_expires_at) > new Date())
      ? new Date(user.member_expires_at) : new Date();
    base.setMonth(base.getMonth() + m);
    db.prepare('UPDATE users SET is_member = 1, member_expires_at = ? WHERE id = ?')
      .run(base.toISOString(), user.id);
    res.json({ message: `已发放${m}个月星渊会员` });
  } else if (action === 'revoke') {
    db.prepare('UPDATE users SET is_member = 0, member_expires_at = NULL WHERE id = ?').run(user.id);
    res.json({ message: '已取消会员' });
  } else {
    res.status(400).json({ error: '无效的action' });
  }
});

app.post('/api/admin/users/:id/credits', authMiddleware, adminMiddleware, (req, res) => {
  const { count } = req.body || {};
  const n = Math.max(1, Math.min(9999, parseInt(count) || 0));
  if (!n) return res.status(400).json({ error: '请输入有效次数（1-9999）' });
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_admin = 0').get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  db.prepare('UPDATE users SET remaining_count = remaining_count + ? WHERE id = ?').run(n, user.id);
  const updated = db.prepare('SELECT remaining_count FROM users WHERE id = ?').get(user.id);
  res.json({ message: `已充值 ${n} 次，当前剩余 ${updated.remaining_count} 次` });
});

app.post('/api/admin/credits', authMiddleware, adminMiddleware, (req, res) => {
  const { username, count } = req.body || {};
  if (!username) return res.status(400).json({ error: '请输入用户名' });
  const n = Math.max(1, Math.min(9999, parseInt(count) || 0));
  if (!n) return res.status(400).json({ error: '请输入有效次数（1-9999）' });
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_admin = 0').get(username);
  if (!user) return res.status(404).json({ error: `用户 "${username}" 不存在` });
  db.prepare('UPDATE users SET remaining_count = remaining_count + ? WHERE id = ?').run(n, user.id);
  const updated = db.prepare('SELECT remaining_count FROM users WHERE id = ?').get(user.id);
  res.json({ message: `${username} 已充值 ${n} 次，当前剩余 ${updated.remaining_count} 次` });
});

app.get('/api/admin/invites', authMiddleware, adminMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT i.id, i.code, i.used_at, i.created_at, u.username AS used_by_name
    FROM invite_codes i LEFT JOIN users u ON i.used_by = u.id
    ORDER BY i.id DESC LIMIT 200
  `).all();
  res.json(rows);
});

app.post('/api/admin/invites', authMiddleware, adminMiddleware, (req, res) => {
  const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const count = Math.min(50, Math.max(1, parseInt(req.body?.count) || 1));
  const codes = [];
  for (let i = 0; i < count; i++) {
    let suffix = '';
    for (let j = 0; j < 6; j++) suffix += CHARSET[Math.floor(Math.random() * CHARSET.length)];
    const code = 'XJ' + suffix;
    try {
      db.prepare('INSERT INTO invite_codes (code) VALUES (?)').run(code);
      codes.push(code);
    } catch { /* duplicate, skip */ }
  }
  res.json({ codes });
});

app.delete('/api/admin/invites/:id', authMiddleware, adminMiddleware, (req, res) => {
  const info = db.prepare('DELETE FROM invite_codes WHERE id = ? AND used_by IS NULL').run(req.params.id);
  if (!info.changes) return res.status(400).json({ error: '无法删除（已被使用或不存在）' });
  res.json({ message: '已删除' });
});

app.get('/api/admin/category-stats', authMiddleware, adminMiddleware, (req, res) => {
  const days = Math.min(90, parseInt(req.query.days) || 30);
  const since = new Date();
  since.setDate(since.getDate() - days + 1);
  const sinceStr = since.toISOString().slice(0, 10);
  const rows = db.prepare(
    'SELECT category, SUM(count) AS total FROM question_stats WHERE date >= ? GROUP BY category ORDER BY total DESC'
  ).all(sinceStr);
  const total = rows.reduce((s, r) => s + r.total, 0);
  res.json({ rows, total, days });
});

app.get('/api/admin/category-stats/daily', authMiddleware, adminMiddleware, (req, res) => {
  const days = Math.min(30, parseInt(req.query.days) || 7);
  const since = new Date();
  since.setDate(since.getDate() - days + 1);
  const sinceStr = since.toISOString().slice(0, 10);
  const rows = db.prepare(
    'SELECT date, category, count FROM question_stats WHERE date >= ? ORDER BY date ASC, count DESC'
  ).all(sinceStr);
  res.json(rows);
});

app.put('/api/admin/users/:id/note', authMiddleware, adminMiddleware, (req, res) => {
  const { note } = req.body || {};
  const user = db.prepare('SELECT id FROM users WHERE id = ? AND is_admin = 0').get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  db.prepare('UPDATE users SET note = ? WHERE id = ?').run((note || '').trim() || null, user.id);
  res.json({ message: '备注已保存' });
});

app.get('/api/admin/questions', authMiddleware, adminMiddleware, (req, res) => {
  const { category, username, start_date, end_date } = req.query;
  const conditions = [];
  const params = [];
  if (username) { conditions.push('u.username LIKE ?'); params.push(`%${username}%`); }
  if (category) { conditions.push('r.category = ?'); params.push(category); }
  if (start_date) { conditions.push("date(r.created_at) >= ?"); params.push(start_date); }
  if (end_date) { conditions.push("date(r.created_at) <= ?"); params.push(end_date); }
  if (!conditions.length) return res.status(400).json({ error: '需要至少一个筛选条件' });
  const sql = `SELECT r.id, r.question, r.category, r.created_at, u.username
               FROM readings r JOIN users u ON r.user_id = u.id
               WHERE ${conditions.join(' AND ')} ORDER BY r.id DESC LIMIT 200`;
  res.json(db.prepare(sql).all(...params));
});

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_admin = 0').get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  db.prepare('DELETE FROM readings WHERE user_id = ?').run(user.id);
  db.prepare('UPDATE invite_codes SET used_by = NULL, used_at = NULL WHERE used_by = ?').run(user.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  res.json({ message: `用户 ${user.username} 已删除` });
});

// ─── SPA Fallback ──────────────────────────────────────────────────────────────
app.get('/share/:token', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));
app.get('/admin/*', (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));

app.listen(PORT, () => {
  console.log(`✦ 玄机塔罗已启动 → http://localhost:${PORT}`);
  console.log(`  管理后台 → http://localhost:${PORT}/admin`);
});
