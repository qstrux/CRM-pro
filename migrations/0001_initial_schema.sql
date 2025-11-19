-- ============================================
-- CRM 高信任关系销售系统 - 数据库 Schema
-- ============================================

-- 1. Users 表（团队成员）
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL, -- bcrypt hashed
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'sales', -- sales, team_lead, admin
  avatar_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Clients 表（客户主表）
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL, -- 归属销售
  name TEXT NOT NULL,
  phone TEXT,
  wechat TEXT,
  email TEXT,
  
  -- 客户来源
  source TEXT NOT NULL, -- 引流渠道
  
  -- 当前阶段（7 个阶段）
  stage TEXT NOT NULL DEFAULT 'new_lead', 
  -- new_lead, initial_contact, nurturing, high_intent, joined_group, opened_account, deposited, archived
  
  -- 温度评分 (0-100)
  temperature_score INTEGER DEFAULT 50,
  temperature_level TEXT DEFAULT 'neutral', -- hot, warm, neutral, cold
  
  -- 客户画像
  interests TEXT, -- JSON 格式存储兴趣点
  personality TEXT, -- 性格特征
  unique_qualities TEXT, -- 稀缺品质
  behavior_patterns TEXT, -- 行为习惯
  investment_profile TEXT, -- 投资画像
  
  -- 风险与机会标识
  is_high_opportunity INTEGER DEFAULT 0, -- 0/1 布尔值
  is_high_risk INTEGER DEFAULT 0, -- 0/1 布尔值
  risk_notes TEXT, -- 风险备注
  
  -- 最后互动时间
  last_interaction_at DATETIME,
  
  -- 归档信息
  is_archived INTEGER DEFAULT 0,
  archive_reason TEXT, -- lost, blocked, converted, etc.
  archived_at DATETIME,
  
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 3. Client_Logs 表（互动日志）
CREATE TABLE IF NOT EXISTS client_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  
  -- 日志类型
  log_type TEXT NOT NULL, -- interaction, stage_change, system_alert, note
  
  -- 日志内容
  content TEXT NOT NULL,
  
  -- 互动详情（JSON 格式）
  highlights TEXT, -- 本次互动亮点
  challenges TEXT, -- 本次挑战
  next_action TEXT, -- 明日目标
  script_used TEXT, -- 使用的话术
  
  -- 情绪标记
  sentiment TEXT, -- positive, neutral, negative
  
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 4. Daily_Reports 表（每日战报）
CREATE TABLE IF NOT EXISTS daily_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  report_date DATE NOT NULL,
  
  -- KPI 数据
  new_leads INTEGER DEFAULT 0,
  initial_contacts INTEGER DEFAULT 0,
  deep_nurturing INTEGER DEFAULT 0,
  high_intents INTEGER DEFAULT 0,
  joined_groups INTEGER DEFAULT 0,
  opened_accounts INTEGER DEFAULT 0,
  deposited INTEGER DEFAULT 0,
  
  -- 互动统计
  total_interactions INTEGER DEFAULT 0,
  
  -- 转化统计
  conversions INTEGER DEFAULT 0,
  
  -- 备注
  notes TEXT,
  
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, report_date)
);

-- 5. Scripts 表（话术智库）
CREATE TABLE IF NOT EXISTS scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL, -- 创建人
  
  -- 话术内容
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  
  -- 话术分类
  category TEXT, -- breaking_ice, nurturing, objection_handling, closing, etc.
  
  -- 成功案例来源
  source_client_id INTEGER, -- 哪个客户的成功案例
  success_count INTEGER DEFAULT 0, -- 使用成功次数
  
  -- 标签关联
  tags TEXT, -- JSON 格式
  
  is_public INTEGER DEFAULT 0, -- 是否团队共享
  
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (source_client_id) REFERENCES clients(id) ON DELETE SET NULL
);

-- 6. Tags 表（标签库）
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  color TEXT DEFAULT '#3B82F6', -- Hex 颜色值
  category TEXT, -- client_trait, interest, risk, opportunity
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 7. Client_Tags 表（客户-标签 多对多关系）
CREATE TABLE IF NOT EXISTS client_tags (
  client_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  PRIMARY KEY (client_id, tag_id),
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

-- 8. Client_Stages 表（阶段变更历史记录）
CREATE TABLE IF NOT EXISTS client_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  
  notes TEXT,
  
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 9. System_Alerts 表（系统提醒）
CREATE TABLE IF NOT EXISTS system_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  client_id INTEGER,
  
  alert_type TEXT NOT NULL, -- interaction_overdue, high_opportunity, high_risk, stage_stuck
  priority TEXT NOT NULL DEFAULT 'medium', -- high, medium, low
  
  message TEXT NOT NULL,
  
  is_read INTEGER DEFAULT 0,
  read_at DATETIME,
  
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

-- ============================================
-- 索引优化
-- ============================================

-- Clients 表索引
CREATE INDEX IF NOT EXISTS idx_clients_user_id ON clients(user_id);
CREATE INDEX IF NOT EXISTS idx_clients_stage ON clients(stage);
CREATE INDEX IF NOT EXISTS idx_clients_temperature_level ON clients(temperature_level);
CREATE INDEX IF NOT EXISTS idx_clients_last_interaction ON clients(last_interaction_at);
CREATE INDEX IF NOT EXISTS idx_clients_archived ON clients(is_archived);

-- Client_Logs 表索引
CREATE INDEX IF NOT EXISTS idx_logs_client_id ON client_logs(client_id);
CREATE INDEX IF NOT EXISTS idx_logs_user_id ON client_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON client_logs(created_at);

-- Daily_Reports 表索引
CREATE INDEX IF NOT EXISTS idx_reports_user_id ON daily_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_reports_date ON daily_reports(report_date);

-- Scripts 表索引
CREATE INDEX IF NOT EXISTS idx_scripts_user_id ON scripts(user_id);
CREATE INDEX IF NOT EXISTS idx_scripts_category ON scripts(category);

-- Client_Tags 表索引
CREATE INDEX IF NOT EXISTS idx_client_tags_client ON client_tags(client_id);
CREATE INDEX IF NOT EXISTS idx_client_tags_tag ON client_tags(tag_id);

-- System_Alerts 表索引
CREATE INDEX IF NOT EXISTS idx_alerts_user_id ON system_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_read ON system_alerts(is_read);
CREATE INDEX IF NOT EXISTS idx_alerts_priority ON system_alerts(priority);
