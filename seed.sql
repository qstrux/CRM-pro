-- ============================================
-- 测试数据（Seed Data）
-- ============================================

-- 1. 创建测试用户
INSERT OR IGNORE INTO users (id, email, password, name, role) VALUES 
  (1, 'admin@crm.com', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 'Admin User', 'admin'),
  -- 密码: password123
  (2, 'sales1@crm.com', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', '张销售', 'sales'),
  (3, 'sales2@crm.com', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', '李经理', 'team_lead');

-- 2. 创建测试标签
INSERT OR IGNORE INTO tags (id, name, color, category) VALUES 
  (1, '高净值', '#10B981', 'client_trait'),
  (2, '投资经验丰富', '#3B82F6', 'client_trait'),
  (3, '风险偏好高', '#F59E0B', 'client_trait'),
  (4, '数字货币', '#8B5CF6', 'interest'),
  (5, '股票投资', '#EC4899', 'interest'),
  (6, '被骗经历', '#EF4444', 'risk'),
  (7, '决策谨慎', '#6B7280', 'client_trait'),
  (8, '积极响应', '#10B981', 'opportunity');

-- 3. 创建测试客户
INSERT OR IGNORE INTO clients (
  id, user_id, name, phone, wechat, source, stage, 
  temperature_score, temperature_level, interests, personality,
  last_interaction_at
) VALUES 
  (1, 2, '王先生', '13800138001', 'wangxs', 'LinkedIn', 'high_intent', 
   75, 'warm', '["数字货币", "股票投资"]', '理性、谨慎、追求稳健收益',
   datetime('now', '-1 day')),
   
  (2, 2, '刘女士', '13800138002', 'liuns', '朋友推荐', 'nurturing', 
   60, 'neutral', '["财富管理", "资产配置"]', '果断、高净值、投资经验丰富',
   datetime('now', '-2 hours')),
   
  (3, 2, '张总', '13800138003', 'zhangz', 'Facebook', 'new_lead', 
   45, 'neutral', '["创业投资"]', '创业者、风险偏好高',
   datetime('now', '-5 days')),
   
  (4, 2, '陈先生', '13800138004', 'chenxs', 'Instagram', 'joined_group', 
   85, 'hot', '["加密货币", "DeFi"]', '技术极客、对新事物敏感',
   datetime('now', '-3 hours')),
   
  (5, 2, '李女士', '13800138005', 'lins', 'Twitter', 'initial_contact', 
   55, 'neutral', '["理财规划"]', '稳健型投资者',
   datetime('now', '-4 days'));

-- 4. 关联客户标签
INSERT OR IGNORE INTO client_tags (client_id, tag_id) VALUES 
  (1, 2), (1, 4), (1, 7),
  (2, 1), (2, 2), (2, 5),
  (3, 3), (3, 6),
  (4, 1), (4, 4), (4, 8),
  (5, 7);

-- 5. 创建测试日志
INSERT OR IGNORE INTO client_logs (
  client_id, user_id, log_type, content, highlights, sentiment
) VALUES 
  (1, 2, 'interaction', '深入讨论了数字资产配置方案', '客户对我们的投资策略表示认可', 'positive'),
  (2, 2, 'interaction', '了解客户风险承受能力', '客户有丰富投资经验，风险承受能力强', 'positive'),
  (3, 2, 'interaction', '初次破冰，建立基本信任', '客户比较谨慎，需要更多案例展示', 'neutral'),
  (4, 2, 'stage_change', '客户已加入VIP投资群', '主动询问开户流程', 'positive'),
  (5, 2, 'interaction', '发送了投资白皮书', '客户表示需要时间研究', 'neutral');

-- 6. 创建阶段变更记录
INSERT OR IGNORE INTO client_stages (client_id, user_id, from_stage, to_stage) VALUES 
  (1, 2, 'nurturing', 'high_intent'),
  (4, 2, 'high_intent', 'joined_group');

-- 7. 创建测试话术
INSERT OR IGNORE INTO scripts (
  user_id, title, content, category, success_count, is_public
) VALUES 
  (2, '破冰话术 - LinkedIn', 
   '您好，我关注到您在金融科技领域的丰富经验。我们团队专注于为高净值客户提供专业的数字资产配置服务...', 
   'breaking_ice', 5, 1),
   
  (2, '异议处理 - 担心风险', 
   '您的担心非常合理。我们的投资策略建立在严格的风控体系之上，过去3年我们帮助客户实现了...', 
   'objection_handling', 3, 1),
   
  (2, '价值展示 - 投资回报', 
   '让我分享一个真实案例：王总去年同期投入100万，通过我们的专业配置，目前收益达到...', 
   'nurturing', 8, 1);

-- 8. 创建测试提醒
INSERT OR IGNORE INTO system_alerts (
  user_id, client_id, alert_type, priority, message
) VALUES 
  (2, 3, 'interaction_overdue', 'high', '张总已经5天未互动，建议主动跟进'),
  (2, 1, 'high_opportunity', 'high', '王先生表现出强烈投资意向，建议尽快推进'),
  (2, 5, 'stage_stuck', 'medium', '李女士在初步破冰阶段停留4天，需要采取行动');
