import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/cloudflare-workers';
import type { HonoEnv } from './types/bindings';
import { initDatabase, isDatabaseInitialized } from './db/init';

const app = new Hono<HonoEnv>();

// CORS 中间件
app.use('/api/*', cors());

// 静态文件服务
app.use('/static/*', serveStatic({ root: './public' }));

// ============================================
// 数据库初始化 API
// ============================================
app.get('/api/db/init', async (c) => {
  const { DB } = c.env;
  const isInit = await isDatabaseInitialized(DB);
  
  if (isInit) {
    return c.json({ 
      success: true, 
      message: '数据库已初始化' 
    });
  }
  
  const result = await initDatabase(DB, true);
  return c.json(result);
});

app.get('/api/db/status', async (c) => {
  const { DB } = c.env;
  const isInit = await isDatabaseInitialized(DB);
  return c.json({ initialized: isInit });
});

// ============================================
// 认证 API
// ============================================
import { generateToken, hashPassword, verifyPassword } from './lib/auth';

// 登录
app.post('/api/auth/login', async (c) => {
  const { DB } = c.env;
  const { email, password } = await c.req.json();
  
  if (!email || !password) {
    return c.json({ success: false, error: '邮箱和密码不能为空' }, 400);
  }
  
  // 查询用户
  const user = await DB.prepare('SELECT * FROM users WHERE email = ?')
    .bind(email).first();
  
  if (!user) {
    return c.json({ success: false, error: '用户不存在' }, 404);
  }
  
  // 验证密码（MVP 阶段简化处理）
  const passwordHash = await hashPassword(password);
  
  // 生成 token
  const token = await generateToken(
    user.id as number, 
    user.email as string, 
    user.role as string
  );
  
  return c.json({
    success: true,
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    }
  });
});

// 注册
app.post('/api/auth/register', async (c) => {
  const { DB } = c.env;
  const { email, password, name } = await c.req.json();
  
  if (!email || !password || !name) {
    return c.json({ success: false, error: '所有字段都是必填的' }, 400);
  }
  
  // 检查用户是否已存在
  const existing = await DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email).first();
  
  if (existing) {
    return c.json({ success: false, error: '该邮箱已被注册' }, 409);
  }
  
  // 密码哈希
  const passwordHash = await hashPassword(password);
  
  // 创建用户
  const result = await DB.prepare(`
    INSERT INTO users (email, password, name, role) 
    VALUES (?, ?, ?, 'sales')
  `).bind(email, passwordHash, name).run();
  
  // 生成 token
  const token = await generateToken(
    result.meta.last_row_id as number, 
    email, 
    'sales'
  );
  
  return c.json({
    success: true,
    token,
    user: {
      id: result.meta.last_row_id,
      email,
      name,
      role: 'sales'
    }
  });
});

// 获取当前用户信息
app.get('/api/auth/me', async (c) => {
  const { DB } = c.env;
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, error: '未授权' }, 401);
  }
  
  // MVP 阶段简化：直接返回默认用户
  const user = await DB.prepare('SELECT id, email, name, role FROM users WHERE id = 2')
    .first();
  
  if (!user) {
    return c.json({ success: false, error: '用户不存在' }, 404);
  }
  
  return c.json({ success: true, user });
});

// ============================================
// 客户 API
// ============================================

// 获取所有客户（按阶段分组，支持搜索和筛选）
app.get('/api/clients', async (c) => {
  const { DB } = c.env;
  const userId = c.req.query('user_id') || '2';
  const search = c.req.query('search') || '';
  const stage = c.req.query('stage') || '';
  const tempLevel = c.req.query('temp_level') || '';
  
  let query = `
    SELECT * FROM clients 
    WHERE user_id = ? AND is_archived = 0
  `;
  const params: any[] = [userId];
  
  if (search) {
    query += ` AND (name LIKE ? OR phone LIKE ? OR wechat LIKE ?)`;
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern, searchPattern);
  }
  
  if (stage) {
    query += ` AND stage = ?`;
    params.push(stage);
  }
  
  if (tempLevel) {
    query += ` AND temperature_level = ?`;
    params.push(tempLevel);
  }
  
  query += ` ORDER BY stage, last_interaction_at DESC`;
  
  const clients = await DB.prepare(query).bind(...params).all();
  
  return c.json({ success: true, clients: clients.results });
});

// 获取客户详情
app.get('/api/clients/:id', async (c) => {
  const { DB } = c.env;
  const clientId = c.req.param('id');
  
  // 获取客户基本信息
  const client = await DB.prepare('SELECT * FROM clients WHERE id = ?')
    .bind(clientId).first();
  
  if (!client) {
    return c.json({ success: false, error: '客户不存在' }, 404);
  }
  
  // 获取客户标签
  const tags = await DB.prepare(`
    SELECT t.* FROM tags t
    INNER JOIN client_tags ct ON t.id = ct.tag_id
    WHERE ct.client_id = ?
  `).bind(clientId).all();
  
  // 获取互动日志
  const logs = await DB.prepare(`
    SELECT * FROM client_logs 
    WHERE client_id = ? 
    ORDER BY created_at DESC
    LIMIT 50
  `).bind(clientId).all();
  
  return c.json({ 
    success: true, 
    client,
    tags: tags.results,
    logs: logs.results
  });
});

// 创建新客户
app.post('/api/clients', async (c) => {
  const { DB } = c.env;
  const data = await c.req.json();
  const userId = data.user_id || '2';
  
  const result = await DB.prepare(`
    INSERT INTO clients (
      user_id, name, phone, wechat, email, source, stage,
      temperature_score, temperature_level
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    userId,
    data.name,
    data.phone || null,
    data.wechat || null,
    data.email || null,
    data.source || '其他',
    data.stage || 'new_lead',
    50,
    'neutral'
  ).run();
  
  return c.json({ 
    success: true, 
    clientId: result.meta.last_row_id 
  });
});

// 更新客户信息
app.put('/api/clients/:id', async (c) => {
  const { DB } = c.env;
  const clientId = c.req.param('id');
  const data = await c.req.json();
  
  await DB.prepare(`
    UPDATE clients SET
      name = ?,
      phone = ?,
      wechat = ?,
      email = ?,
      source = ?,
      interests = ?,
      personality = ?,
      unique_qualities = ?,
      behavior_patterns = ?,
      investment_profile = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    data.name,
    data.phone,
    data.wechat,
    data.email,
    data.source,
    data.interests,
    data.personality,
    data.unique_qualities,
    data.behavior_patterns,
    data.investment_profile,
    clientId
  ).run();
  
  return c.json({ success: true });
});

// 更新客户阶段
app.put('/api/clients/:id/stage', async (c) => {
  const { DB } = c.env;
  const clientId = c.req.param('id');
  const { stage, userId } = await c.req.json();
  
  // 获取当前阶段
  const client = await DB.prepare('SELECT stage FROM clients WHERE id = ?')
    .bind(clientId).first();
  
  if (!client) {
    return c.json({ success: false, error: '客户不存在' }, 404);
  }
  
  // 更新阶段
  await DB.prepare('UPDATE clients SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(stage, clientId).run();
  
  // 记录阶段变更
  await DB.prepare(`
    INSERT INTO client_stages (client_id, user_id, from_stage, to_stage)
    VALUES (?, ?, ?, ?)
  `).bind(clientId, userId || 2, client.stage, stage).run();
  
  // 创建日志
  await DB.prepare(`
    INSERT INTO client_logs (client_id, user_id, log_type, content)
    VALUES (?, ?, 'stage_change', ?)
  `).bind(
    clientId, 
    userId || 2, 
    `阶段变更: ${client.stage} → ${stage}`
  ).run();
  
  return c.json({ success: true });
});

// ============================================
// 日志 API
// ============================================
app.post('/api/logs', async (c) => {
  const { DB } = c.env;
  const data = await c.req.json();
  
  const result = await DB.prepare(`
    INSERT INTO client_logs (
      client_id, user_id, log_type, content, 
      highlights, challenges, next_action, script_used, sentiment
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    data.client_id,
    data.user_id || 2,
    data.log_type || 'interaction',
    data.content,
    data.highlights || null,
    data.challenges || null,
    data.next_action || null,
    data.script_used || null,
    data.sentiment || 'neutral'
  ).run();
  
  // 更新客户最后互动时间
  await DB.prepare(`
    UPDATE clients SET last_interaction_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(data.client_id).run();
  
  return c.json({ success: true, logId: result.meta.last_row_id });
});

// ============================================
// 标签 API
// ============================================
app.get('/api/tags', async (c) => {
  const { DB } = c.env;
  const tags = await DB.prepare('SELECT * FROM tags ORDER BY category, name').all();
  return c.json({ success: true, tags: tags.results });
});

app.post('/api/tags', async (c) => {
  const { DB } = c.env;
  const { name, color, category } = await c.req.json();
  
  const result = await DB.prepare(`
    INSERT INTO tags (name, color, category) VALUES (?, ?, ?)
  `).bind(name, color || '#3B82F6', category || 'client_trait').run();
  
  return c.json({ success: true, tagId: result.meta.last_row_id });
});

// 删除标签
app.delete('/api/tags/:id', async (c) => {
  const { DB } = c.env;
  const tagId = c.req.param('id');
  
  // 先删除关联关系
  await DB.prepare('DELETE FROM client_tags WHERE tag_id = ?').bind(tagId).run();
  
  // 再删除标签
  await DB.prepare('DELETE FROM tags WHERE id = ?').bind(tagId).run();
  
  return c.json({ success: true });
});

// 为客户添加标签
app.post('/api/clients/:id/tags', async (c) => {
  const { DB } = c.env;
  const clientId = c.req.param('id');
  const { tag_id } = await c.req.json();
  
  await DB.prepare(`
    INSERT OR IGNORE INTO client_tags (client_id, tag_id) VALUES (?, ?)
  `).bind(clientId, tag_id).run();
  
  return c.json({ success: true });
});

// 移除客户标签
app.delete('/api/clients/:id/tags/:tagId', async (c) => {
  const { DB } = c.env;
  const clientId = c.req.param('id');
  const tagId = c.req.param('tagId');
  
  await DB.prepare('DELETE FROM client_tags WHERE client_id = ? AND tag_id = ?')
    .bind(clientId, tagId).run();
  
  return c.json({ success: true });
});

// ============================================
// 每日战报 API
// ============================================

// 提交每日战报
app.post('/api/daily-reports', async (c) => {
  const { DB } = c.env;
  const data = await c.req.json();
  const userId = data.user_id || '2';
  
  // 检查当天是否已提交战报
  const existingReport = await DB.prepare(`
    SELECT id FROM daily_reports 
    WHERE user_id = ? AND report_date = ?
  `).bind(userId, data.report_date).first();
  
  if (existingReport) {
    // 更新现有战报
    await DB.prepare(`
      UPDATE daily_reports SET
        new_leads = ?,
        initial_contacts = ?,
        deep_nurturing = ?,
        high_intents = ?,
        joined_groups = ?,
        opened_accounts = ?,
        deposited = ?,
        total_interactions = ?,
        conversions = ?,
        notes = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      data.new_leads || 0,
      data.initial_contacts || 0,
      data.deep_nurturing || 0,
      data.high_intents || 0,
      data.joined_groups || 0,
      data.opened_accounts || 0,
      data.deposited || 0,
      data.total_interactions || 0,
      data.conversions || 0,
      data.notes || '',
      existingReport.id
    ).run();
    
    return c.json({ success: true, reportId: existingReport.id, updated: true });
  }
  
  // 创建新战报
  const result = await DB.prepare(`
    INSERT INTO daily_reports (
      user_id, report_date,
      new_leads, initial_contacts, deep_nurturing, high_intents,
      joined_groups, opened_accounts, deposited,
      total_interactions, conversions, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    userId,
    data.report_date,
    data.new_leads || 0,
    data.initial_contacts || 0,
    data.deep_nurturing || 0,
    data.high_intents || 0,
    data.joined_groups || 0,
    data.opened_accounts || 0,
    data.deposited || 0,
    data.total_interactions || 0,
    data.conversions || 0,
    data.notes || ''
  ).run();
  
  return c.json({ success: true, reportId: result.meta.last_row_id });
});

// 获取每日战报列表
app.get('/api/daily-reports', async (c) => {
  const { DB } = c.env;
  const userId = c.req.query('user_id') || '2';
  const startDate = c.req.query('start_date');
  const endDate = c.req.query('end_date');
  const limit = c.req.query('limit') || '30';
  
  let query = `
    SELECT * FROM daily_reports 
    WHERE user_id = ?
  `;
  const params: any[] = [userId];
  
  if (startDate) {
    query += ` AND report_date >= ?`;
    params.push(startDate);
  }
  
  if (endDate) {
    query += ` AND report_date <= ?`;
    params.push(endDate);
  }
  
  query += ` ORDER BY report_date DESC LIMIT ?`;
  params.push(limit);
  
  const reports = await DB.prepare(query).bind(...params).all();
  
  return c.json({ success: true, reports: reports.results });
});

// 获取单个战报详情
app.get('/api/daily-reports/:id', async (c) => {
  const { DB } = c.env;
  const reportId = c.req.param('id');
  
  const report = await DB.prepare('SELECT * FROM daily_reports WHERE id = ?')
    .bind(reportId).first();
  
  if (!report) {
    return c.json({ success: false, error: '战报不存在' }, 404);
  }
  
  return c.json({ success: true, report });
});

// 获取战报统计数据
app.get('/api/daily-reports/stats/summary', async (c) => {
  const { DB } = c.env;
  const userId = c.req.query('user_id') || '2';
  const days = c.req.query('days') || '7'; // 默认最近7天
  
  // 计算日期范围
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];
  
  // 获取期间的汇总数据
  const summary = await DB.prepare(`
    SELECT 
      COUNT(*) as total_reports,
      SUM(new_leads) as total_new_leads,
      SUM(initial_contacts) as total_initial_contacts,
      SUM(deep_nurturing) as total_deep_nurturing,
      SUM(high_intents) as total_high_intents,
      SUM(joined_groups) as total_joined_groups,
      SUM(opened_accounts) as total_opened_accounts,
      SUM(deposited) as total_deposited,
      SUM(total_interactions) as total_interactions,
      SUM(conversions) as total_conversions,
      AVG(new_leads) as avg_new_leads,
      AVG(total_interactions) as avg_interactions,
      AVG(conversions) as avg_conversions
    FROM daily_reports
    WHERE user_id = ? AND report_date >= ? AND report_date <= ?
  `).bind(userId, startDate, endDate).first();
  
  // 获取今日战报
  const todayReport = await DB.prepare(`
    SELECT * FROM daily_reports
    WHERE user_id = ? AND report_date = ?
  `).bind(userId, endDate).first();
  
  return c.json({
    success: true,
    summary,
    todayReport,
    dateRange: { startDate, endDate, days: parseInt(days) }
  });
});

// ============================================
// 话术智库 API
// ============================================

// 获取话术列表
app.get('/api/scripts', async (c) => {
  const { DB } = c.env;
  const userId = c.req.query('user_id') || '2';
  const category = c.req.query('category') || '';
  const search = c.req.query('search') || '';
  const showPublic = c.req.query('show_public') === 'true';
  
  let query = `
    SELECT s.*, u.name as creator_name
    FROM scripts s
    LEFT JOIN users u ON s.user_id = u.id
    WHERE (s.user_id = ? OR s.is_public = 1)
  `;
  const params: any[] = [userId];
  
  if (category) {
    query += ` AND s.category = ?`;
    params.push(category);
  }
  
  if (search) {
    query += ` AND (s.title LIKE ? OR s.content LIKE ?)`;
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern);
  }
  
  query += ` ORDER BY s.created_at DESC`;
  
  const scripts = await DB.prepare(query).bind(...params).all();
  
  return c.json({ success: true, scripts: scripts.results });
});

// 获取话术详情
app.get('/api/scripts/:id', async (c) => {
  const { DB } = c.env;
  const scriptId = c.req.param('id');
  
  const script = await DB.prepare(`
    SELECT s.*, u.name as creator_name
    FROM scripts s
    LEFT JOIN users u ON s.user_id = u.id
    WHERE s.id = ?
  `).bind(scriptId).first();
  
  if (!script) {
    return c.json({ success: false, error: '话术不存在' }, 404);
  }
  
  return c.json({ success: true, script });
});

// 创建话术
app.post('/api/scripts', async (c) => {
  const { DB } = c.env;
  const data = await c.req.json();
  const userId = data.user_id || '2';
  
  if (!data.title || !data.content) {
    return c.json({ success: false, error: '标题和内容不能为空' }, 400);
  }
  
  const result = await DB.prepare(`
    INSERT INTO scripts (
      user_id, title, content, category, is_public, tags
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    userId,
    data.title,
    data.content,
    data.category || 'general',
    data.is_public ? 1 : 0,
    data.tags || '[]'
  ).run();
  
  return c.json({ success: true, scriptId: result.meta.last_row_id });
});

// 更新话术
app.put('/api/scripts/:id', async (c) => {
  const { DB } = c.env;
  const scriptId = c.req.param('id');
  const data = await c.req.json();
  
  await DB.prepare(`
    UPDATE scripts SET
      title = ?,
      content = ?,
      category = ?,
      is_public = ?,
      tags = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    data.title,
    data.content,
    data.category,
    data.is_public ? 1 : 0,
    data.tags || '[]',
    scriptId
  ).run();
  
  return c.json({ success: true });
});

// 删除话术
app.delete('/api/scripts/:id', async (c) => {
  const { DB } = c.env;
  const scriptId = c.req.param('id');
  
  await DB.prepare('DELETE FROM scripts WHERE id = ?').bind(scriptId).run();
  
  return c.json({ success: true });
});

// 记录话术使用（增加使用计数）
app.post('/api/scripts/:id/use', async (c) => {
  const { DB } = c.env;
  const scriptId = c.req.param('id');
  
  await DB.prepare(`
    UPDATE scripts SET
      success_count = success_count + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(scriptId).run();
  
  return c.json({ success: true });
});

// 获取话术使用统计
app.get('/api/scripts/stats/summary', async (c) => {
  const { DB } = c.env;
  const userId = c.req.query('user_id') || '2';
  
  // 总话术数
  const totalScripts = await DB.prepare(`
    SELECT COUNT(*) as count FROM scripts WHERE user_id = ?
  `).bind(userId).first();
  
  // 按分类统计
  const categoryStats = await DB.prepare(`
    SELECT category, COUNT(*) as count
    FROM scripts
    WHERE user_id = ?
    GROUP BY category
  `).bind(userId).all();
  
  // 最常用话术
  const topScripts = await DB.prepare(`
    SELECT * FROM scripts
    WHERE user_id = ?
    ORDER BY success_count DESC
    LIMIT 5
  `).bind(userId).all();
  
  return c.json({
    success: true,
    totalScripts: totalScripts?.count || 0,
    categoryStats: categoryStats.results,
    topScripts: topScripts.results
  });
});

// ============================================
// 话术智库 API
// ============================================

// 获取话术列表
app.get('/api/scripts', async (c) => {
  const { DB } = c.env;
  const userId = c.req.query('user_id') || '2';
  const category = c.req.query('category') || '';
  const search = c.req.query('search') || '';
  const isPublic = c.req.query('is_public');
  
  let query = `
    SELECT s.*, u.name as creator_name 
    FROM scripts s
    LEFT JOIN users u ON s.user_id = u.id
    WHERE (s.user_id = ? OR s.is_public = 1)
  `;
  const params: any[] = [userId];
  
  if (category) {
    query += ` AND s.category = ?`;
    params.push(category);
  }
  
  if (search) {
    query += ` AND (s.title LIKE ? OR s.content LIKE ?)`;
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern);
  }
  
  if (isPublic !== undefined) {
    query += ` AND s.is_public = ?`;
    params.push(isPublic === 'true' ? 1 : 0);
  }
  
  query += ` ORDER BY s.created_at DESC`;
  
  const scripts = await DB.prepare(query).bind(...params).all();
  
  return c.json({ success: true, scripts: scripts.results });
});

// 获取话术详情
app.get('/api/scripts/:id', async (c) => {
  const { DB } = c.env;
  const scriptId = c.req.param('id');
  
  const script = await DB.prepare(`
    SELECT s.*, u.name as creator_name, cl.name as source_client_name
    FROM scripts s
    LEFT JOIN users u ON s.user_id = u.id
    LEFT JOIN clients cl ON s.source_client_id = cl.id
    WHERE s.id = ?
  `).bind(scriptId).first();
  
  if (!script) {
    return c.json({ success: false, error: '话术不存在' }, 404);
  }
  
  return c.json({ success: true, script });
});

// 创建新话术
app.post('/api/scripts', async (c) => {
  const { DB } = c.env;
  const data = await c.req.json();
  const userId = data.user_id || '2';
  
  const result = await DB.prepare(`
    INSERT INTO scripts (
      user_id, title, content, category, 
      source_client_id, tags, is_public
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    userId,
    data.title,
    data.content,
    data.category || 'general',
    data.source_client_id || null,
    data.tags || null,
    data.is_public ? 1 : 0
  ).run();
  
  return c.json({ success: true, scriptId: result.meta.last_row_id });
});

// 更新话术
app.put('/api/scripts/:id', async (c) => {
  const { DB } = c.env;
  const scriptId = c.req.param('id');
  const data = await c.req.json();
  
  await DB.prepare(`
    UPDATE scripts SET
      title = ?,
      content = ?,
      category = ?,
      source_client_id = ?,
      tags = ?,
      is_public = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    data.title,
    data.content,
    data.category,
    data.source_client_id || null,
    data.tags || null,
    data.is_public ? 1 : 0,
    scriptId
  ).run();
  
  return c.json({ success: true });
});

// 删除话术
app.delete('/api/scripts/:id', async (c) => {
  const { DB } = c.env;
  const scriptId = c.req.param('id');
  
  await DB.prepare('DELETE FROM scripts WHERE id = ?').bind(scriptId).run();
  
  return c.json({ success: true });
});

// 记录话术使用（增加成功次数）
app.post('/api/scripts/:id/use', async (c) => {
  const { DB } = c.env;
  const scriptId = c.req.param('id');
  const { client_id, log_id } = await c.req.json();
  
  // 增加成功次数
  await DB.prepare(`
    UPDATE scripts 
    SET success_count = success_count + 1 
    WHERE id = ?
  `).bind(scriptId).run();
  
  // 可选：在客户日志中记录话术使用
  if (log_id) {
    await DB.prepare(`
      UPDATE client_logs 
      SET script_used = ? 
      WHERE id = ?
    `).bind(scriptId, log_id).run();
  }
  
  return c.json({ success: true });
});

// 获取话术统计
app.get('/api/scripts/stats/summary', async (c) => {
  const { DB } = c.env;
  const userId = c.req.query('user_id') || '2';
  
  // 总话术数
  const totalScripts = await DB.prepare(`
    SELECT COUNT(*) as count 
    FROM scripts 
    WHERE user_id = ? OR is_public = 1
  `).bind(userId).first();
  
  // 我的话术数
  const myScripts = await DB.prepare(`
    SELECT COUNT(*) as count 
    FROM scripts 
    WHERE user_id = ?
  `).bind(userId).first();
  
  // 公共话术数
  const publicScripts = await DB.prepare(`
    SELECT COUNT(*) as count 
    FROM scripts 
    WHERE is_public = 1
  `).first();
  
  // 最常用话术（前5）
  const topScripts = await DB.prepare(`
    SELECT id, title, category, success_count
    FROM scripts
    WHERE user_id = ? OR is_public = 1
    ORDER BY success_count DESC
    LIMIT 5
  `).bind(userId).all();
  
  // 各分类数量
  const categoryCounts = await DB.prepare(`
    SELECT category, COUNT(*) as count
    FROM scripts
    WHERE user_id = ? OR is_public = 1
    GROUP BY category
  `).bind(userId).all();
  
  return c.json({
    success: true,
    stats: {
      totalScripts: totalScripts?.count || 0,
      myScripts: myScripts?.count || 0,
      publicScripts: publicScripts?.count || 0,
      topScripts: topScripts.results,
      categoryCounts: categoryCounts.results
    }
  });
});

// ============================================
// 批量导入 API
// ============================================

// 批量导入客户数据
app.post('/api/clients/batch-import', async (c) => {
  const { DB } = c.env;
  const { clients, userId } = await c.req.json();
  
  if (!clients || !Array.isArray(clients)) {
    return c.json({ success: false, error: '无效的客户数据' }, 400);
  }
  
  const results = {
    success: 0,
    failed: 0,
    errors: [] as any[]
  };
  
  // 逐个插入客户数据
  for (let i = 0; i < clients.length; i++) {
    const client = clients[i];
    
    try {
      // 验证必填字段
      if (!client.name) {
        results.failed++;
        results.errors.push({ row: i + 1, error: '姓名不能为空', data: client });
        continue;
      }
      
      // 插入客户数据
      await DB.prepare(`
        INSERT INTO clients (
          user_id, name, phone, wechat, email, source, 
          stage, temperature_score, temperature_level,
          interests, personality, unique_qualities, 
          behavior_patterns, investment_profile
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        userId || 2,
        client.name,
        client.phone || null,
        client.wechat || null,
        client.email || null,
        client.source || '导入',
        client.stage || 'new_lead',
        client.temperature_score || 50,
        client.temperature_level || 'neutral',
        client.interests || null,
        client.personality || null,
        client.unique_qualities || null,
        client.behavior_patterns || null,
        client.investment_profile || null
      ).run();
      
      results.success++;
      
    } catch (error: any) {
      results.failed++;
      results.errors.push({ 
        row: i + 1, 
        error: error.message || '插入失败', 
        data: client 
      });
    }
  }
  
  return c.json({ 
    success: true, 
    results: {
      total: clients.length,
      success: results.success,
      failed: results.failed,
      errors: results.errors
    }
  });
});

// 解析CSV文本
app.post('/api/clients/parse-csv', async (c) => {
  const { csvText } = await c.req.json();
  
  if (!csvText) {
    return c.json({ success: false, error: 'CSV内容不能为空' }, 400);
  }
  
  try {
    // 简单的CSV解析（支持逗号和制表符分隔）
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) {
      return c.json({ success: false, error: 'CSV至少需要包含表头和一行数据' }, 400);
    }
    
    // 解析表头
    const headers = lines[0].split(/[,\t]/).map((h: string) => h.trim().replace(/"/g, ''));
    
    // 解析数据行
    const clients = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const values = line.split(/[,\t]/).map((v: string) => v.trim().replace(/"/g, ''));
      const client: any = {};
      
      headers.forEach((header: string, index: number) => {
        const value = values[index] || '';
        // 映射中文表头到英文字段
        const fieldMap: any = {
          '姓名': 'name',
          '电话': 'phone',
          '微信': 'wechat',
          '邮箱': 'email',
          '来源': 'source',
          '阶段': 'stage',
          '兴趣点': 'interests',
          '性格特征': 'personality',
          '稀缺品质': 'unique_qualities',
          '行为习惯': 'behavior_patterns',
          '投资画像': 'investment_profile'
        };
        
        const field = fieldMap[header] || header.toLowerCase();
        client[field] = value;
      });
      
      clients.push(client);
    }
    
    return c.json({ 
      success: true, 
      clients,
      count: clients.length 
    });
    
  } catch (error: any) {
    return c.json({ 
      success: false, 
      error: 'CSV解析失败: ' + error.message 
    }, 400);
  }
});

// ============================================
// 团队管理 API
// ============================================

// 获取团队成员列表
app.get('/api/team/members', async (c) => {
  const { DB } = c.env;
  
  const members = await DB.prepare(`
    SELECT 
      u.id, u.name, u.email, u.role, u.created_at,
      COUNT(DISTINCT c.id) as total_clients,
      COUNT(DISTINCT CASE WHEN c.stage = 'deposited' THEN c.id END) as deposited_clients,
      COUNT(DISTINCT l.id) as total_interactions
    FROM users u
    LEFT JOIN clients c ON u.id = c.user_id AND c.is_archived = 0
    LEFT JOIN client_logs l ON u.id = l.user_id
    WHERE u.role IN ('sales', 'team_lead')
    GROUP BY u.id
    ORDER BY deposited_clients DESC, total_clients DESC
  `).all();
  
  return c.json({ success: true, members: members.results });
});

// 获取成员KPI详情
app.get('/api/team/members/:id/kpi', async (c) => {
  const { DB } = c.env;
  const memberId = c.req.param('id');
  const days = c.req.query('days') || '30';
  
  const startDate = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];
  
  // 基础KPI
  const basicKPI = await DB.prepare(`
    SELECT 
      COUNT(DISTINCT c.id) as total_clients,
      COUNT(DISTINCT CASE WHEN c.stage = 'new_lead' THEN c.id END) as new_leads,
      COUNT(DISTINCT CASE WHEN c.stage = 'high_intent' THEN c.id END) as high_intents,
      COUNT(DISTINCT CASE WHEN c.stage = 'deposited' THEN c.id END) as deposited,
      COUNT(DISTINCT l.id) as total_interactions,
      COUNT(DISTINCT CASE WHEN DATE(c.created_at) >= ? THEN c.id END) as new_clients_period
    FROM clients c
    LEFT JOIN client_logs l ON c.id = l.client_id
    WHERE c.user_id = ? AND c.is_archived = 0
  `).bind(startDate, memberId).first();
  
  // 每日战报汇总
  const reportsKPI = await DB.prepare(`
    SELECT 
      COUNT(*) as total_reports,
      SUM(new_leads) as sum_new_leads,
      SUM(conversions) as sum_conversions,
      SUM(deposited) as sum_deposited,
      AVG(total_interactions) as avg_daily_interactions
    FROM daily_reports
    WHERE user_id = ? AND report_date >= ?
  `).bind(memberId, startDate).first();
  
  // 话术使用情况
  const scriptsKPI = await DB.prepare(`
    SELECT COUNT(*) as total_scripts
    FROM scripts
    WHERE user_id = ?
  `).bind(memberId).first();
  
  return c.json({
    success: true,
    kpi: {
      ...basicKPI,
      ...reportsKPI,
      ...scriptsKPI
    }
  });
});

// 获取团队排行榜
app.get('/api/team/leaderboard', async (c) => {
  const { DB } = c.env;
  const period = c.req.query('period') || 'month'; // week, month, quarter
  
  let days = 30;
  if (period === 'week') days = 7;
  if (period === 'quarter') days = 90;
  
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];
  
  const leaderboard = await DB.prepare(`
    SELECT 
      u.id, u.name,
      COUNT(DISTINCT r.id) as report_days,
      SUM(r.new_leads) as total_new_leads,
      SUM(r.conversions) as total_conversions,
      SUM(r.deposited) as total_deposited,
      SUM(r.total_interactions) as total_interactions,
      CAST(SUM(r.deposited) AS FLOAT) / NULLIF(SUM(r.new_leads), 0) * 100 as conversion_rate
    FROM users u
    LEFT JOIN daily_reports r ON u.id = r.user_id AND r.report_date >= ?
    WHERE u.role IN ('sales', 'team_lead')
    GROUP BY u.id
    ORDER BY total_deposited DESC, total_conversions DESC
  `).bind(startDate).all();
  
  return c.json({ success: true, leaderboard: leaderboard.results, period, days });
});

// ============================================
// Dashboard API
// ============================================
app.get('/api/dashboard', async (c) => {
  const { DB } = c.env;
  const userId = c.req.query('user_id') || '2';
  
  // 各阶段客户数量
  const stageCounts = await DB.prepare(`
    SELECT stage, COUNT(*) as count 
    FROM clients 
    WHERE user_id = ? AND is_archived = 0
    GROUP BY stage
  `).bind(userId).all();
  
  // 温度分布
  const tempCounts = await DB.prepare(`
    SELECT temperature_level, COUNT(*) as count 
    FROM clients 
    WHERE user_id = ? AND is_archived = 0
    GROUP BY temperature_level
  `).bind(userId).all();
  
  // 今日互动数
  const todayInteractions = await DB.prepare(`
    SELECT COUNT(*) as count 
    FROM client_logs 
    WHERE user_id = ? AND DATE(created_at) = DATE('now')
  `).bind(userId).first();
  
  // 高机会客户
  const highOpportunity = await DB.prepare(`
    SELECT COUNT(*) as count 
    FROM clients 
    WHERE user_id = ? AND is_high_opportunity = 1 AND is_archived = 0
  `).bind(userId).first();
  
  // 风险客户
  const highRisk = await DB.prepare(`
    SELECT COUNT(*) as count 
    FROM clients 
    WHERE user_id = ? AND is_high_risk = 1 AND is_archived = 0
  `).bind(userId).first();
  
  return c.json({
    success: true,
    stageCounts: stageCounts.results,
    tempCounts: tempCounts.results,
    todayInteractions: todayInteractions?.count || 0,
    highOpportunity: highOpportunity?.count || 0,
    highRisk: highRisk?.count || 0
  });
});

// ============================================
// 自动提醒系统 API
// ============================================

// 检测并创建48小时未互动提醒
app.post('/api/alerts/check-overdue', async (c) => {
  const { DB } = c.env;
  const userId = c.req.query('user_id');
  
  if (!userId) {
    return c.json({ success: false, error: '缺少 user_id 参数' }, 400);
  }
  
  // 查找48小时未互动的客户（排除已归档）
  const overdueClients = await DB.prepare(`
    SELECT 
      c.id,
      c.name,
      c.stage,
      c.last_interaction_at,
      CAST((julianday('now') - julianday(c.last_interaction_at)) * 24 AS INTEGER) as hours_since_interaction
    FROM clients c
    WHERE c.user_id = ?
      AND c.is_archived = 0
      AND c.last_interaction_at IS NOT NULL
      AND julianday('now') - julianday(c.last_interaction_at) >= 2.0
      AND NOT EXISTS (
        SELECT 1 FROM system_alerts sa
        WHERE sa.client_id = c.id
          AND sa.alert_type = 'interaction_overdue'
          AND sa.is_read = 0
          AND DATE(sa.created_at) = DATE('now')
      )
  `).bind(userId).all();
  
  let createdCount = 0;
  
  // 为每个超期客户创建提醒
  for (const client of overdueClients.results || []) {
    const message = `客户「${client.name}」已 ${client.hours_since_interaction} 小时未互动，请尽快跟进！`;
    
    await DB.prepare(`
      INSERT INTO system_alerts (user_id, client_id, alert_type, priority, message)
      VALUES (?, ?, 'interaction_overdue', 'high', ?)
    `).bind(userId, client.id, message).run();
    
    // 同时更新客户为高风险
    await DB.prepare(`
      UPDATE clients 
      SET is_high_risk = 1,
          risk_notes = '48小时未互动，流失风险'
      WHERE id = ?
    `).bind(client.id).run();
    
    createdCount++;
  }
  
  return c.json({
    success: true,
    checked: overdueClients.results?.length || 0,
    created: createdCount,
    message: `检测完成，创建了 ${createdCount} 条提醒`
  });
});

// 获取当前用户的所有提醒
app.get('/api/alerts', async (c) => {
  const { DB } = c.env;
  const userId = c.req.query('user_id');
  const unreadOnly = c.req.query('unread_only') === 'true';
  
  if (!userId) {
    return c.json({ success: false, error: '缺少 user_id 参数' }, 400);
  }
  
  let query = `
    SELECT 
      sa.*,
      c.name as client_name,
      c.stage as client_stage
    FROM system_alerts sa
    LEFT JOIN clients c ON sa.client_id = c.id
    WHERE sa.user_id = ?
  `;
  
  if (unreadOnly) {
    query += ` AND sa.is_read = 0`;
  }
  
  query += ` ORDER BY sa.created_at DESC LIMIT 100`;
  
  const alerts = await DB.prepare(query).bind(userId).all();
  
  return c.json({
    success: true,
    alerts: alerts.results || []
  });
});

// 标记提醒为已读
app.put('/api/alerts/:id/read', async (c) => {
  const { DB } = c.env;
  const alertId = c.req.param('id');
  
  await DB.prepare(`
    UPDATE system_alerts 
    SET is_read = 1, read_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(alertId).run();
  
  return c.json({ success: true });
});

// 批量标记为已读
app.post('/api/alerts/mark-all-read', async (c) => {
  const { DB } = c.env;
  const userId = c.req.query('user_id');
  
  if (!userId) {
    return c.json({ success: false, error: '缺少 user_id 参数' }, 400);
  }
  
  await DB.prepare(`
    UPDATE system_alerts 
    SET is_read = 1, read_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND is_read = 0
  `).bind(userId).run();
  
  return c.json({ success: true });
});

// 删除提醒
app.delete('/api/alerts/:id', async (c) => {
  const { DB } = c.env;
  const alertId = c.req.param('id');
  
  await DB.prepare(`DELETE FROM system_alerts WHERE id = ?`).bind(alertId).run();
  
  return c.json({ success: true });
});

// ============================================
// 温度自动计算系统 API
// ============================================

// 计算单个客户温度
async function calculateClientTemperature(DB: D1Database, clientId: number) {
  // 获取客户基本信息
  const client = await DB.prepare(`
    SELECT 
      c.*,
      COUNT(DISTINCT cl.id) as total_interactions,
      MAX(cl.created_at) as last_interaction
    FROM clients c
    LEFT JOIN client_logs cl ON c.id = cl.client_id 
      AND cl.log_type = 'interaction'
      AND julianday('now') - julianday(cl.created_at) <= 30
    WHERE c.id = ?
    GROUP BY c.id
  `).bind(clientId).first();
  
  if (!client) {
    return null;
  }
  
  let score = 50; // 基础分50分
  
  // === 1. 阶段评分 (0-25分) ===
  const stageScores: { [key: string]: number } = {
    'new_lead': 0,
    'initial_contact': 5,
    'nurturing': 10,
    'high_intent': 20,
    'joined_group': 22,
    'opened_account': 23,
    'deposited': 25
  };
  score += stageScores[client.stage as string] || 0;
  
  // === 2. 互动频率评分 (0-25分) ===
  const interactionCount = client.total_interactions || 0;
  if (interactionCount >= 20) score += 25;
  else if (interactionCount >= 15) score += 20;
  else if (interactionCount >= 10) score += 15;
  else if (interactionCount >= 5) score += 10;
  else if (interactionCount >= 2) score += 5;
  
  // === 3. 最近互动时长评分 (-20 到 +15分) ===
  if (client.last_interaction) {
    const hoursSinceInteraction = 
      (new Date().getTime() - new Date(client.last_interaction as string).getTime()) / (1000 * 3600);
    
    if (hoursSinceInteraction <= 24) score += 15;      // 24小时内 +15
    else if (hoursSinceInteraction <= 48) score += 10; // 48小时内 +10
    else if (hoursSinceInteraction <= 72) score += 5;  // 72小时内 +5
    else if (hoursSinceInteraction <= 168) score += 0; // 1周内 0
    else if (hoursSinceInteraction <= 336) score -= 10; // 2周内 -10
    else score -= 20; // 超过2周 -20
  } else {
    score -= 10; // 从未互动 -10
  }
  
  // === 4. 情绪评分 (-10 到 +10分) ===
  const sentiments = await DB.prepare(`
    SELECT sentiment, COUNT(*) as count
    FROM client_logs
    WHERE client_id = ? AND sentiment IS NOT NULL
      AND julianday('now') - julianday(created_at) <= 30
    GROUP BY sentiment
  `).bind(clientId).all();
  
  let positiveCount = 0;
  let negativeCount = 0;
  for (const s of sentiments.results || []) {
    if (s.sentiment === 'positive') positiveCount = s.count as number;
    if (s.sentiment === 'negative') negativeCount = s.count as number;
  }
  
  if (positiveCount > negativeCount * 2) score += 10;
  else if (positiveCount > negativeCount) score += 5;
  else if (negativeCount > positiveCount) score -= 5;
  else if (negativeCount > positiveCount * 2) score -= 10;
  
  // 限制在 0-100 范围
  score = Math.max(0, Math.min(100, score));
  
  // 确定温度等级
  let level = 'neutral';
  if (score >= 80) level = 'hot';
  else if (score >= 60) level = 'warm';
  else if (score >= 40) level = 'neutral';
  else level = 'cold';
  
  return {
    score: Math.round(score),
    level,
    details: {
      stageScore: stageScores[client.stage as string] || 0,
      interactionCount,
      hoursSinceInteraction: client.last_interaction 
        ? Math.round((new Date().getTime() - new Date(client.last_interaction as string).getTime()) / (1000 * 3600))
        : null,
      positiveCount,
      negativeCount
    }
  };
}

// 批量更新所有客户温度
app.post('/api/temperature/update-all', async (c) => {
  const { DB } = c.env;
  const userId = c.req.query('user_id');
  
  if (!userId) {
    return c.json({ success: false, error: '缺少 user_id 参数' }, 400);
  }
  
  // 获取该用户的所有非归档客户
  const clients = await DB.prepare(`
    SELECT id FROM clients 
    WHERE user_id = ? AND is_archived = 0
  `).bind(userId).all();
  
  let updatedCount = 0;
  const results = [];
  
  for (const client of clients.results || []) {
    const temp = await calculateClientTemperature(DB, client.id as number);
    if (temp) {
      await DB.prepare(`
        UPDATE clients 
        SET temperature_score = ?,
            temperature_level = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(temp.score, temp.level, client.id).run();
      
      updatedCount++;
      results.push({
        clientId: client.id,
        score: temp.score,
        level: temp.level
      });
    }
  }
  
  return c.json({
    success: true,
    updated: updatedCount,
    total: clients.results?.length || 0,
    results
  });
});

// 更新单个客户温度
app.post('/api/temperature/update/:clientId', async (c) => {
  const { DB } = c.env;
  const clientId = parseInt(c.req.param('clientId'));
  
  const temp = await calculateClientTemperature(DB, clientId);
  
  if (!temp) {
    return c.json({ success: false, error: '客户不存在' }, 404);
  }
  
  await DB.prepare(`
    UPDATE clients 
    SET temperature_score = ?,
        temperature_level = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(temp.score, temp.level, clientId).run();
  
  return c.json({
    success: true,
    clientId,
    temperature: temp
  });
});

// ============================================
// 风险/机会自动识别系统 API
// ============================================

// 评估单个客户的风险和机会
async function assessClientRiskOpportunity(DB: D1Database, clientId: number) {
  const client = await DB.prepare(`
    SELECT 
      c.*,
      COUNT(DISTINCT cl.id) as interaction_count,
      MAX(cl.created_at) as last_interaction,
      SUM(CASE WHEN cl.sentiment = 'positive' THEN 1 ELSE 0 END) as positive_count,
      SUM(CASE WHEN cl.sentiment = 'negative' THEN 1 ELSE 0 END) as negative_count
    FROM clients c
    LEFT JOIN client_logs cl ON c.id = cl.client_id 
      AND cl.log_type = 'interaction'
      AND julianday('now') - julianday(cl.created_at) <= 30
    WHERE c.id = ?
    GROUP BY c.id
  `).bind(clientId).first();
  
  if (!client) return null;
  
  let isHighOpportunity = false;
  let isHighRisk = false;
  let riskReasons: string[] = [];
  let opportunityReasons: string[] = [];
  
  // === 高机会识别 ===
  
  // 1. 温度高于80分
  if (client.temperature_score >= 80) {
    isHighOpportunity = true;
    opportunityReasons.push('温度评分高达 ' + client.temperature_score + ' 分');
  }
  
  // 2. 高意向阶段
  if (['high_intent', 'joined_group', 'opened_account'].includes(client.stage as string)) {
    isHighOpportunity = true;
    opportunityReasons.push('处于高转化阶段');
  }
  
  // 3. 近7天内互动频繁（≥5次）
  const recentInteractions = await DB.prepare(`
    SELECT COUNT(*) as count
    FROM client_logs
    WHERE client_id = ? 
      AND log_type = 'interaction'
      AND julianday('now') - julianday(created_at) <= 7
  `).bind(clientId).first();
  
  if ((recentInteractions?.count as number || 0) >= 5) {
    isHighOpportunity = true;
    opportunityReasons.push('近7天互动 ' + recentInteractions?.count + ' 次');
  }
  
  // 4. 正向情绪占比高（>80%）
  const totalSentiment = (client.positive_count || 0) + (client.negative_count || 0);
  if (totalSentiment > 0 && (client.positive_count || 0) / totalSentiment > 0.8) {
    isHighOpportunity = true;
    opportunityReasons.push('正向情绪占比 ' + Math.round((client.positive_count as number / totalSentiment) * 100) + '%');
  }
  
  // === 高风险识别 ===
  
  // 1. 温度低于40分
  if (client.temperature_score < 40) {
    isHighRisk = true;
    riskReasons.push('温度评分仅 ' + client.temperature_score + ' 分');
  }
  
  // 2. 48小时未互动
  if (client.last_interaction) {
    const hoursSince = (new Date().getTime() - new Date(client.last_interaction as string).getTime()) / (1000 * 3600);
    if (hoursSince >= 48) {
      isHighRisk = true;
      riskReasons.push(Math.round(hoursSince) + ' 小时未互动');
    }
  }
  
  // 3. 阶段停滞超过7天
  const stageHistory = await DB.prepare(`
    SELECT created_at 
    FROM client_stages
    WHERE client_id = ? AND to_stage = ?
    ORDER BY created_at DESC LIMIT 1
  `).bind(clientId, client.stage).first();
  
  if (stageHistory) {
    const daysSinceStageChange = 
      (new Date().getTime() - new Date(stageHistory.created_at as string).getTime()) / (1000 * 3600 * 24);
    if (daysSinceStageChange > 7) {
      isHighRisk = true;
      riskReasons.push('当前阶段停滞 ' + Math.round(daysSinceStageChange) + ' 天');
    }
  }
  
  // 4. 负向情绪占比高（>50%）
  if (totalSentiment > 0 && (client.negative_count || 0) / totalSentiment > 0.5) {
    isHighRisk = true;
    riskReasons.push('负向情绪占比 ' + Math.round((client.negative_count as number / totalSentiment) * 100) + '%');
  }
  
  // 5. 互动频率下降（近7天 vs 前7天）
  const recentCount = await DB.prepare(`
    SELECT COUNT(*) as count FROM client_logs
    WHERE client_id = ? AND log_type = 'interaction'
      AND julianday('now') - julianday(created_at) <= 7
  `).bind(clientId).first();
  
  const previousCount = await DB.prepare(`
    SELECT COUNT(*) as count FROM client_logs
    WHERE client_id = ? AND log_type = 'interaction'
      AND julianday('now') - julianday(created_at) > 7
      AND julianday('now') - julianday(created_at) <= 14
  `).bind(clientId).first();
  
  const recentNum = recentCount?.count as number || 0;
  const previousNum = previousCount?.count as number || 0;
  
  if (previousNum > 0 && recentNum < previousNum * 0.5) {
    isHighRisk = true;
    riskReasons.push('互动频率下降 ' + Math.round((1 - recentNum / previousNum) * 100) + '%');
  }
  
  return {
    isHighOpportunity,
    isHighRisk,
    opportunityReasons,
    riskReasons,
    riskNotes: riskReasons.join('；')
  };
}

// 批量评估所有客户
app.post('/api/risk-opportunity/assess-all', async (c) => {
  const { DB } = c.env;
  const userId = c.req.query('user_id');
  
  if (!userId) {
    return c.json({ success: false, error: '缺少 user_id 参数' }, 400);
  }
  
  const clients = await DB.prepare(`
    SELECT id FROM clients 
    WHERE user_id = ? AND is_archived = 0
  `).bind(userId).all();
  
  let opportunityCount = 0;
  let riskCount = 0;
  const results = [];
  
  for (const client of clients.results || []) {
    const assessment = await assessClientRiskOpportunity(DB, client.id as number);
    if (assessment) {
      await DB.prepare(`
        UPDATE clients 
        SET is_high_opportunity = ?,
            is_high_risk = ?,
            risk_notes = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        assessment.isHighOpportunity ? 1 : 0,
        assessment.isHighRisk ? 1 : 0,
        assessment.riskNotes,
        client.id
      ).run();
      
      if (assessment.isHighOpportunity) opportunityCount++;
      if (assessment.isHighRisk) riskCount++;
      
      // 如果是高风险，创建提醒
      if (assessment.isHighRisk) {
        const clientData = await DB.prepare('SELECT name FROM clients WHERE id = ?').bind(client.id).first();
        const message = `客户「${clientData?.name}」被标记为高风险：${assessment.riskNotes}`;
        
        // 检查今天是否已有同类提醒
        const existing = await DB.prepare(`
          SELECT id FROM system_alerts
          WHERE user_id = ? AND client_id = ?
            AND alert_type = 'high_risk'
            AND DATE(created_at) = DATE('now')
        `).bind(userId, client.id).first();
        
        if (!existing) {
          await DB.prepare(`
            INSERT INTO system_alerts (user_id, client_id, alert_type, priority, message)
            VALUES (?, ?, 'high_risk', 'high', ?)
          `).bind(userId, client.id, message).run();
        }
      }
      
      // 如果是高机会，创建提醒
      if (assessment.isHighOpportunity) {
        const clientData = await DB.prepare('SELECT name FROM clients WHERE id = ?').bind(client.id).first();
        const message = `客户「${clientData?.name}」被标记为高机会：${assessment.opportunityReasons.join('；')}`;
        
        const existing = await DB.prepare(`
          SELECT id FROM system_alerts
          WHERE user_id = ? AND client_id = ?
            AND alert_type = 'high_opportunity'
            AND DATE(created_at) = DATE('now')
        `).bind(userId, client.id).first();
        
        if (!existing) {
          await DB.prepare(`
            INSERT INTO system_alerts (user_id, client_id, alert_type, priority, message)
            VALUES (?, ?, 'high_opportunity', 'high', ?)
          `).bind(userId, client.id, message).run();
        }
      }
      
      results.push({
        clientId: client.id,
        isHighOpportunity: assessment.isHighOpportunity,
        isHighRisk: assessment.isHighRisk
      });
    }
  }
  
  return c.json({
    success: true,
    total: clients.results?.length || 0,
    opportunityCount,
    riskCount,
    results
  });
});

// 评估单个客户
app.post('/api/risk-opportunity/assess/:clientId', async (c) => {
  const { DB } = c.env;
  const clientId = parseInt(c.req.param('clientId'));
  
  const assessment = await assessClientRiskOpportunity(DB, clientId);
  
  if (!assessment) {
    return c.json({ success: false, error: '客户不存在' }, 404);
  }
  
  await DB.prepare(`
    UPDATE clients 
    SET is_high_opportunity = ?,
        is_high_risk = ?,
        risk_notes = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    assessment.isHighOpportunity ? 1 : 0,
    assessment.isHighRisk ? 1 : 0,
    assessment.riskNotes,
    clientId
  ).run();
  
  return c.json({
    success: true,
    clientId,
    assessment
  });
});

// ============================================
// 登录/注册页面
// ============================================
app.get('/login', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登录 - CRM 系统</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen flex items-center justify-center">
  <div class="max-w-md w-full mx-4">
    <div class="bg-white rounded-2xl shadow-xl p-8">
      <!-- Logo and Title -->
      <div class="text-center mb-8">
        <div class="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-full mb-4">
          <i class="fas fa-users-cog text-3xl text-white"></i>
        </div>
        <h1 class="text-2xl font-bold text-gray-900">CRM 高信任关系销售系统</h1>
        <p class="text-gray-600 mt-2">登录以继续使用</p>
      </div>

      <!-- Tabs -->
      <div class="flex border-b mb-6">
        <button id="loginTab" onclick="showLoginForm()" class="flex-1 py-3 text-center font-medium border-b-2 border-blue-600 text-blue-600">
          登录
        </button>
        <button id="registerTab" onclick="showRegisterForm()" class="flex-1 py-3 text-center font-medium text-gray-500 hover:text-gray-700">
          注册
        </button>
      </div>

      <!-- Login Form -->
      <form id="loginForm" class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">邮箱</label>
          <input 
            type="email" 
            name="email" 
            required 
            class="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="your@email.com"
          >
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">密码</label>
          <input 
            type="password" 
            name="password" 
            required 
            class="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="••••••••"
          >
        </div>
        <button 
          type="submit" 
          class="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 font-medium transition"
        >
          <i class="fas fa-sign-in-alt mr-2"></i>登录
        </button>
      </form>

      <!-- Register Form (Hidden) -->
      <form id="registerForm" class="space-y-4 hidden">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">姓名</label>
          <input 
            type="text" 
            name="name" 
            required 
            class="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="张三"
          >
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">邮箱</label>
          <input 
            type="email" 
            name="email" 
            required 
            class="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="your@email.com"
          >
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">密码</label>
          <input 
            type="password" 
            name="password" 
            required 
            minlength="6"
            class="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="至少 6 位"
          >
        </div>
        <button 
          type="submit" 
          class="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 font-medium transition"
        >
          <i class="fas fa-user-plus mr-2"></i>注册
        </button>
      </form>

      <!-- Demo Hint -->
      <div class="mt-6 p-4 bg-blue-50 rounded-lg">
        <p class="text-sm text-blue-800">
          <i class="fas fa-info-circle mr-2"></i>
          <strong>测试账号：</strong><br>
          邮箱：sales1@crm.com<br>
          密码：password123
        </p>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script>
    // 切换表单
    function showLoginForm() {
      document.getElementById('loginForm').classList.remove('hidden');
      document.getElementById('registerForm').classList.add('hidden');
      document.getElementById('loginTab').classList.add('border-blue-600', 'text-blue-600');
      document.getElementById('loginTab').classList.remove('text-gray-500');
      document.getElementById('registerTab').classList.remove('border-blue-600', 'text-blue-600');
      document.getElementById('registerTab').classList.add('text-gray-500');
    }

    function showRegisterForm() {
      document.getElementById('loginForm').classList.add('hidden');
      document.getElementById('registerForm').classList.remove('hidden');
      document.getElementById('registerTab').classList.add('border-blue-600', 'text-blue-600');
      document.getElementById('registerTab').classList.remove('text-gray-500');
      document.getElementById('loginTab').classList.remove('border-blue-600', 'text-blue-600');
      document.getElementById('loginTab').classList.add('text-gray-500');
    }

    // 登录表单提交
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const data = Object.fromEntries(formData.entries());
      
      try {
        const res = await axios.post('/api/auth/login', data);
        
        if (res.data.success) {
          // 保存 token
          localStorage.setItem('auth_token', res.data.token);
          localStorage.setItem('user', JSON.stringify(res.data.user));
          
          // 跳转到主页
          window.location.href = '/';
        } else {
          alert(res.data.error || '登录失败');
        }
      } catch (error) {
        alert('登录失败：' + (error.response?.data?.error || error.message));
      }
    });

    // 注册表单提交
    document.getElementById('registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const data = Object.fromEntries(formData.entries());
      
      try {
        const res = await axios.post('/api/auth/register', data);
        
        if (res.data.success) {
          // 保存 token
          localStorage.setItem('auth_token', res.data.token);
          localStorage.setItem('user', JSON.stringify(res.data.user));
          
          // 跳转到主页
          window.location.href = '/';
        } else {
          alert(res.data.error || '注册失败');
        }
      } catch (error) {
        alert('注册失败：' + (error.response?.data?.error || error.message));
      }
    });

    // 检查是否已登录
    if (localStorage.getItem('auth_token')) {
      window.location.href = '/';
    }
  </script>
</body>
</html>
  `);
});

// ============================================
// 主页
// ============================================
app.get('/', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CRM 高信任关系销售系统</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; }
    .stage-column { min-width: 280px; max-width: 320px; }
    .client-card { transition: all 0.2s; }
    .client-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
    .temp-hot { border-left: 4px solid #EF4444; }
    .temp-warm { border-left: 4px solid #F59E0B; }
    .temp-neutral { border-left: 4px solid #3B82F6; }
    .temp-cold { border-left: 4px solid #6B7280; }
    
    /* 移动端响应式优化 */
    @media (max-width: 768px) {
      /* 导航栏移动端优化 */
      nav h1 { font-size: 1.25rem !important; }
      nav h1 i { display: none; }
      nav .flex.items-center.space-x-4 { 
        flex-wrap: wrap; 
        gap: 0.25rem;
      }
      nav button { 
        padding: 0.5rem 0.75rem !important; 
        font-size: 0.875rem;
      }
      nav button span { display: none; }
      nav button i { margin: 0 !important; }
      
      /* 看板列优化 */
      .stage-column { 
        min-width: 240px !important; 
        max-width: 280px !important; 
      }
      
      /* 卡片优化 */
      .client-card { padding: 0.75rem !important; }
      .client-card h3 { font-size: 0.9rem; }
      
      /* 搜索和筛选优化 */
      #searchInput { 
        width: 100% !important; 
        max-width: 200px;
      }
      
      /* 按钮组优化 */
      .flex.space-x-3 { 
        flex-wrap: wrap; 
        gap: 0.5rem; 
      }
      
      /* Dashboard KPI卡片优化 */
      .grid.grid-cols-1.md\\:grid-cols-4 { 
        grid-template-columns: repeat(2, 1fr) !important; 
      }
      
      /* 表格优化 */
      table { 
        font-size: 0.875rem; 
        display: block;
        overflow-x: auto;
      }
      
      /* Modal优化 */
      .max-w-4xl, .max-w-6xl { 
        max-width: 95vw !important; 
        margin: 0.5rem !important;
      }
      
      /* 提醒面板优化 */
      #alertsPanel { 
        right: 0.5rem !important; 
        left: 0.5rem !important; 
        width: auto !important; 
      }
      
      /* Toast优化 */
      .fixed.bottom-8.right-8 { 
        bottom: 1rem !important; 
        right: 1rem !important; 
        left: 1rem !important; 
        width: auto !important;
      }
    }
    
    @media (max-width: 480px) {
      /* 超小屏幕优化 */
      nav { padding: 0.5rem !important; }
      .max-w-7xl { padding: 0.5rem !important; }
      
      .stage-column { 
        min-width: 200px !important; 
        max-width: 240px !important; 
      }
      
      /* Dashboard单列显示 */
      .grid.grid-cols-1.md\\:grid-cols-4 { 
        grid-template-columns: 1fr !important; 
      }
      
      /* 隐藏部分次要信息 */
      .text-xs.text-gray-500 { display: none; }
    }
  </style>
</head>
<body class="bg-gray-50">
  <!-- 顶部导航 -->
  <nav class="bg-white shadow-sm border-b">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex justify-between h-16">
        <div class="flex items-center">
          <h1 class="text-2xl font-bold text-gray-900">
            <i class="fas fa-users-cog text-blue-600 mr-2"></i>
            CRM 高信任关系销售系统
          </h1>
        </div>
        <div class="flex items-center space-x-4">
          <button onclick="showView('dashboard')" class="px-4 py-2 text-gray-700 hover:text-blue-600 transition">
            <i class="fas fa-chart-line mr-2"></i>仪表盘
          </button>
          <button onclick="showView('kanban')" class="px-4 py-2 text-gray-700 hover:text-blue-600 transition">
            <i class="fas fa-columns mr-2"></i>客户看板
          </button>
          <button onclick="showView('reports')" class="px-4 py-2 text-gray-700 hover:text-blue-600 transition">
            <i class="fas fa-file-alt mr-2"></i>每日战报
          </button>
          <button onclick="showView('scripts')" class="px-4 py-2 text-gray-700 hover:text-blue-600 transition">
            <i class="fas fa-book mr-2"></i>话术智库
          </button>
          <button onclick="showView('team')" class="px-4 py-2 text-gray-700 hover:text-blue-600 transition">
            <i class="fas fa-users mr-2"></i>团队管理
          </button>
          <button onclick="showTagsManagement()" class="px-4 py-2 text-gray-700 hover:text-blue-600 transition">
            <i class="fas fa-tags mr-2"></i>标签管理
          </button>
          
          <!-- 提醒铃铛 -->
          <button onclick="showAlertsPanel()" class="relative px-4 py-2 text-gray-700 hover:text-blue-600 transition">
            <i class="fas fa-bell text-xl"></i>
            <span id="alertsBadge" class="hidden absolute top-0 right-0 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">0</span>
          </button>
          
          <button onclick="showNewClientModal()" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">
            <i class="fas fa-plus mr-2"></i>新增客户
          </button>
          <button onclick="showImportModal()" class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition">
            <i class="fas fa-file-import mr-2"></i>导入数据
          </button>
          
          <!-- 用户信息 -->
          <div class="flex items-center space-x-3 border-l pl-4">
            <div class="text-right">
              <p id="userName" class="text-sm font-medium text-gray-900">加载中...</p>
              <p id="userRole" class="text-xs text-gray-500">--</p>
            </div>
            <button onclick="logout()" class="text-gray-600 hover:text-red-600 transition" title="登出">
              <i class="fas fa-sign-out-alt text-xl"></i>
            </button>
          </div>
        </div>
      </div>
    </div>
  </nav>

  <!-- 主内容区 -->
  <div id="mainContent" class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <div id="loadingScreen" class="text-center py-20">
      <i class="fas fa-spinner fa-spin text-4xl text-blue-600 mb-4"></i>
      <p class="text-gray-600">正在初始化数据库...</p>
    </div>
  </div>

  <!-- 新增客户模态框 -->
  <div id="newClientModal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
    <div class="bg-white rounded-lg p-8 max-w-md w-full">
      <h2 class="text-2xl font-bold mb-6">新增客户</h2>
      <form id="newClientForm" class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">姓名 *</label>
          <input type="text" name="name" required class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">电话</label>
          <input type="tel" name="phone" class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">微信</label>
          <input type="text" name="wechat" class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">来源 *</label>
          <select name="source" required class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500">
            <option value="LinkedIn">LinkedIn</option>
            <option value="Facebook">Facebook</option>
            <option value="Instagram">Instagram</option>
            <option value="Twitter">Twitter</option>
            <option value="朋友推荐">朋友推荐</option>
            <option value="其他">其他</option>
          </select>
        </div>
        <div class="flex space-x-3 mt-6">
          <button type="submit" class="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700">
            <i class="fas fa-check mr-2"></i>创建
          </button>
          <button type="button" onclick="hideNewClientModal()" class="flex-1 bg-gray-300 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-400">
            取消
          </button>
        </div>
      </form>
    </div>
  </div>

  <!-- 标签管理模态框 -->
  <div id="tagsManagementModal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
    <div class="bg-white rounded-lg p-8 max-w-3xl w-full max-h-[90vh] overflow-y-auto">
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-2xl font-bold">标签管理</h2>
        <button onclick="hideTagsManagement()" class="text-gray-500 hover:text-gray-700">
          <i class="fas fa-times text-2xl"></i>
        </button>
      </div>

      <!-- 新建标签表单 -->
      <div class="bg-gray-50 rounded-lg p-4 mb-6">
        <h3 class="font-semibold text-gray-900 mb-4">新建标签</h3>
        <form id="newTagForm" class="flex space-x-3">
          <input 
            type="text" 
            name="name" 
            placeholder="标签名称" 
            required 
            class="flex-1 px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
          >
          <input 
            type="color" 
            name="color" 
            value="#3B82F6" 
            class="w-16 h-10 border rounded-lg cursor-pointer"
          >
          <select 
            name="category" 
            class="px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
          >
            <option value="client_trait">客户特征</option>
            <option value="interest">兴趣点</option>
            <option value="risk">风险</option>
            <option value="opportunity">机会</option>
          </select>
          <button type="submit" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            <i class="fas fa-plus mr-2"></i>创建
          </button>
        </form>
      </div>

      <!-- 标签列表 -->
      <div id="tagsListContainer">
        <div class="text-center py-8 text-gray-500">
          <i class="fas fa-spinner fa-spin text-2xl mb-2"></i>
          <p>加载中...</p>
        </div>
      </div>
    </div>
  </div>

  <!-- 为客户添加标签模态框 -->
  <div id="addTagToClientModal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
    <div class="bg-white rounded-lg p-8 max-w-md w-full">
      <h2 class="text-2xl font-bold mb-6">为客户添加标签</h2>
      <div id="availableTagsList" class="space-y-2 max-h-96 overflow-y-auto">
        <!-- 动态加载标签列表 -->
      </div>
      <div class="mt-6">
        <button onclick="hideAddTagToClientModal()" class="w-full bg-gray-300 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-400">
          关闭
        </button>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script>
    let clientsData = [];
    let tagsData = [];
    let currentUser = null;

    // 检查认证状态
    function checkAuth() {
      const token = localStorage.getItem('auth_token');
      const user = localStorage.getItem('user');
      
      if (!token || !user) {
        // MVP 阶段：如果没有 token，跳转到登录页
        // window.location.href = '/login';
        // 暂时使用默认用户
        currentUser = { id: 2, name: '张销售', role: 'sales' };
      } else {
        currentUser = JSON.parse(user);
      }
      
      // 更新导航栏用户信息
      document.getElementById('userName').textContent = currentUser.name;
      document.getElementById('userRole').textContent = currentUser.role === 'admin' ? '管理员' : 
                                                         currentUser.role === 'team_lead' ? '团队主管' : '销售';
    }

    // 登出
    function logout() {
      if (confirm('确定要登出吗？')) {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('user');
        window.location.href = '/login';
      }
    }

    // 配置 axios 默认请求头
    axios.interceptors.request.use(config => {
      const token = localStorage.getItem('auth_token');
      if (token) {
        config.headers.Authorization = \`Bearer \${token}\`;
      }
      return config;
    });

    // 初始化
    async function initApp() {
      try {
        // 检查认证
        checkAuth();
        
        // 检查数据库状态
        const status = await axios.get('/api/db/status');
        if (!status.data.initialized) {
          await axios.get('/api/db/init');
        }
        
        // 加载标签
        const tagsRes = await axios.get('/api/tags');
        tagsData = tagsRes.data.tags;
        
        // 默认显示看板
        await showView('kanban');
        
      } catch (error) {
        console.error('初始化失败:', error);
        document.getElementById('loadingScreen').innerHTML = 
          '<p class="text-red-600">初始化失败，请刷新页面重试</p>';
      }
    }

    // 切换视图
    async function showView(view) {
      const content = document.getElementById('mainContent');
      
      if (view === 'dashboard') {
        content.innerHTML = '<div class="text-center py-20"><i class="fas fa-spinner fa-spin text-4xl text-blue-600"></i></div>';
        const res = await axios.get('/api/dashboard');
        renderDashboard(res.data);
      } else if (view === 'kanban') {
        content.innerHTML = '<div class="text-center py-20"><i class="fas fa-spinner fa-spin text-4xl text-blue-600"></i></div>';
        const res = await axios.get('/api/clients');
        clientsData = res.data.clients;
        renderKanban();
      } else if (view === 'reports') {
        content.innerHTML = '<div class="text-center py-20"><i class="fas fa-spinner fa-spin text-4xl text-blue-600"></i></div>';
        await renderDailyReports();
      } else if (view === 'scripts') {
        content.innerHTML = '<div class="text-center py-20"><i class="fas fa-spinner fa-spin text-4xl text-blue-600"></i></div>';
        await renderScriptsLibrary();
      } else if (view === 'team') {
        content.innerHTML = '<div class="text-center py-20"><i class="fas fa-spinner fa-spin text-4xl text-blue-600"></i></div>';
        await renderTeamManagement();
      }
    }

    // 渲染看板
    function renderKanban() {
      const stages = [
        { key: 'new_lead', name: '新接粉', icon: 'fa-user-plus', color: 'bg-purple-100 text-purple-800' },
        { key: 'initial_contact', name: '初步破冰', icon: 'fa-handshake', color: 'bg-blue-100 text-blue-800' },
        { key: 'nurturing', name: '深度培育', icon: 'fa-seedling', color: 'bg-green-100 text-green-800' },
        { key: 'high_intent', name: '高意向', icon: 'fa-fire', color: 'bg-orange-100 text-orange-800' },
        { key: 'joined_group', name: '已进群', icon: 'fa-users', color: 'bg-teal-100 text-teal-800' },
        { key: 'opened_account', name: '已开户', icon: 'fa-id-card', color: 'bg-indigo-100 text-indigo-800' },
        { key: 'deposited', name: '已入金', icon: 'fa-money-bill-wave', color: 'bg-green-100 text-green-800' }
      ];

      // 计算统计数据
      const tempStats = {
        hot: clientsData.filter(c => c.temperature_level === 'hot').length,
        warm: clientsData.filter(c => c.temperature_level === 'warm').length,
        neutral: clientsData.filter(c => c.temperature_level === 'neutral').length,
        cold: clientsData.filter(c => c.temperature_level === 'cold').length
      };

      const html = \`
        <div class="mb-6 flex items-center justify-between">
          <div>
            <h2 class="text-2xl font-bold text-gray-900">客户看板</h2>
            <p class="text-gray-600 mt-1">
              共 \${clientsData.length} 位客户 · 
              <span class="text-red-600">🔥 \${tempStats.hot}</span> · 
              <span class="text-orange-500">🌤️ \${tempStats.warm}</span> · 
              <span class="text-blue-500">☁️ \${tempStats.neutral}</span> · 
              <span class="text-gray-500">❄️ \${tempStats.cold}</span>
            </p>
          </div>
          <div class="flex space-x-3">
            <div class="relative">
              <input 
                type="text" 
                id="searchInput"
                placeholder="搜索客户姓名/电话/微信..." 
                class="pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 w-64"
                onkeyup="handleSearch(this.value)"
              >
              <i class="fas fa-search absolute left-3 top-3 text-gray-400"></i>
            </div>
            <select 
              id="tempFilter" 
              class="px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
              onchange="handleFilter()"
            >
              <option value="">所有温度</option>
              <option value="hot">🔥 热 (\${tempStats.hot})</option>
              <option value="warm">🌤️ 温 (\${tempStats.warm})</option>
              <option value="neutral">☁️ 中 (\${tempStats.neutral})</option>
              <option value="cold">❄️ 冷 (\${tempStats.cold})</option>
            </select>
          </div>
        </div>
        <div class="flex space-x-4 overflow-x-auto pb-4">
          \${stages.map(stage => {
            const stageClients = clientsData.filter(c => c.stage === stage.key);
            return \`
              <div class="stage-column flex-shrink-0">
                <div class="bg-white rounded-lg shadow-sm p-4">
                  <div class="flex items-center justify-between mb-4">
                    <div class="flex items-center">
                      <span class="\${stage.color} px-3 py-1 rounded-full text-sm font-medium">
                        <i class="fas \${stage.icon} mr-2"></i>
                        \${stage.name}
                      </span>
                    </div>
                    <span class="bg-gray-200 text-gray-700 px-2 py-1 rounded-full text-xs font-bold">
                      \${stageClients.length}
                    </span>
                  </div>
                  <div class="space-y-3 min-h-[200px]" 
                       data-stage="\${stage.key}"
                       ondrop="handleDrop(event)" 
                       ondragover="handleDragOver(event)"
                       ondragenter="handleDragEnter(event)"
                       ondragleave="handleDragLeave(event)">
                    \${stageClients.map(client => renderClientCard(client)).join('')}
                  </div>
                </div>
              </div>
            \`;
          }).join('')}
        </div>
      \`;

      document.getElementById('mainContent').innerHTML = html;
    }

    // 渲染客户卡片
    function renderClientCard(client) {
      const tempClass = \`temp-\${client.temperature_level}\`;
      const tempIcon = {
        hot: 'fa-fire text-red-600',
        warm: 'fa-sun text-orange-500',
        neutral: 'fa-cloud text-blue-500',
        cold: 'fa-snowflake text-gray-500'
      }[client.temperature_level];

      return \`
        <div class="client-card \${tempClass} bg-white border rounded-lg p-3 cursor-move" 
             draggable="true"
             data-client-id="\${client.id}"
             data-client-name="\${client.name}"
             data-current-stage="\${client.stage}"
             ondragstart="handleDragStart(event)"
             ondragend="handleDragEnd(event)"
             onclick="event.stopPropagation(); viewClientDetail(\${client.id})">
          <div class="flex items-start justify-between mb-2">
            <div class="flex items-center">
              <i class="fas fa-grip-vertical text-gray-400 mr-2 text-xs"></i>
              <h3 class="font-semibold text-gray-900">\${client.name}</h3>
            </div>
            <i class="fas \${tempIcon}"></i>
          </div>
          <div class="text-sm text-gray-600 space-y-1">
            <div><i class="fas fa-tag mr-2"></i>\${client.source}</div>
            \${client.wechat ? \`<div><i class="fab fa-weixin mr-2"></i>\${client.wechat}</div>\` : ''}
          </div>
          \${client.last_interaction_at ? \`
            <div class="text-xs text-gray-500 mt-2">
              最后互动: \${new Date(client.last_interaction_at).toLocaleDateString()}
            </div>
          \` : ''}
        </div>
      \`;
    }

    // 渲染仪表盘
    function renderDashboard(data) {
      const stageNames = {
        new_lead: '新接粉',
        initial_contact: '初步破冰',
        nurturing: '深度培育',
        high_intent: '高意向',
        joined_group: '已进群',
        opened_account: '已开户',
        deposited: '已入金'
      };

      const html = \`
        <div class="mb-6 flex items-center justify-between">
          <div>
            <h2 class="text-2xl font-bold text-gray-900">数据仪表盘</h2>
            <p class="text-gray-600 mt-1">实时业绩概览</p>
          </div>
          <div class="flex space-x-3">
            <button 
              onclick="assessAllRiskOpportunity()" 
              class="px-4 py-3 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition font-medium"
              title="智能识别高价值客户和流失风险"
            >
              <i class="fas fa-brain mr-2"></i>智能评估
            </button>
            <button 
              onclick="updateAllTemperatures()" 
              class="px-4 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition font-medium"
              title="重新计算所有客户温度评分"
            >
              <i class="fas fa-thermometer-half mr-2"></i>更新温度
            </button>
            <button 
              onclick="showView('reports')" 
              class="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium"
            >
              <i class="fas fa-file-alt mr-2"></i>查看每日战报
            </button>
          </div>
        </div>
        
        <!-- KPI 卡片 -->
        <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <div class="bg-white rounded-lg shadow-sm p-6">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-gray-600 text-sm">今日互动</p>
                <p class="text-3xl font-bold text-blue-600">\${data.todayInteractions}</p>
              </div>
              <i class="fas fa-comments text-4xl text-blue-200"></i>
            </div>
          </div>
          
          <div class="bg-white rounded-lg shadow-sm p-6">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-gray-600 text-sm">高机会客户</p>
                <p class="text-3xl font-bold text-green-600">\${data.highOpportunity}</p>
              </div>
              <i class="fas fa-fire text-4xl text-green-200"></i>
            </div>
          </div>
          
          <div class="bg-white rounded-lg shadow-sm p-6">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-gray-600 text-sm">风险客户</p>
                <p class="text-3xl font-bold text-red-600">\${data.highRisk}</p>
              </div>
              <i class="fas fa-exclamation-triangle text-4xl text-red-200"></i>
            </div>
          </div>
          
          <div class="bg-white rounded-lg shadow-sm p-6">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-gray-600 text-sm">总客户数</p>
                <p class="text-3xl font-bold text-purple-600">\${data.stageCounts.reduce((sum, s) => sum + s.count, 0)}</p>
              </div>
              <i class="fas fa-users text-4xl text-purple-200"></i>
            </div>
          </div>
        </div>

        <!-- 销售漏斗 -->
        <div class="bg-white rounded-lg shadow-sm p-6 mb-8">
          <h3 class="text-xl font-bold text-gray-900 mb-4">销售漏斗</h3>
          <div class="space-y-3">
            \${data.stageCounts.map(stage => {
              const total = data.stageCounts.reduce((sum, s) => sum + s.count, 0);
              const percentage = total > 0 ? (stage.count / total * 100).toFixed(1) : 0;
              return \`
                <div>
                  <div class="flex justify-between text-sm mb-1">
                    <span class="text-gray-700">\${stageNames[stage.stage] || stage.stage}</span>
                    <span class="text-gray-600">\${stage.count} (\${percentage}%)</span>
                  </div>
                  <div class="w-full bg-gray-200 rounded-full h-2">
                    <div class="bg-blue-600 h-2 rounded-full" style="width: \${percentage}%"></div>
                  </div>
                </div>
              \`;
            }).join('')}
          </div>
        </div>
      \`;

      document.getElementById('mainContent').innerHTML = html;
    }

    // 查看客户详情
    async function viewClientDetail(clientId) {
      const content = document.getElementById('mainContent');
      content.innerHTML = '<div class="text-center py-20"><i class="fas fa-spinner fa-spin text-4xl text-blue-600"></i></div>';
      
      try {
        const res = await axios.get(\`/api/clients/\${clientId}\`);
        renderClientDetail(res.data);
      } catch (error) {
        content.innerHTML = '<div class="text-center py-20 text-red-600">加载失败</div>';
      }
    }

    // 渲染客户详情页
    function renderClientDetail(data) {
      const { client, tags, logs } = data;
      
      const stageOptions = [
        { value: 'new_lead', label: '新接粉' },
        { value: 'initial_contact', label: '初步破冰' },
        { value: 'nurturing', label: '深度培育' },
        { value: 'high_intent', label: '高意向' },
        { value: 'joined_group', label: '已进群' },
        { value: 'opened_account', label: '已开户' },
        { value: 'deposited', label: '已入金' }
      ];

      const html = \`
        <div class="mb-6 flex items-center justify-between">
          <div class="flex items-center">
            <button onclick="showView('kanban')" class="mr-4 text-gray-600 hover:text-gray-900">
              <i class="fas fa-arrow-left text-xl"></i>
            </button>
            <h2 class="text-2xl font-bold text-gray-900">\${client.name} - 客户详情</h2>
          </div>
          <div class="flex space-x-2">
            <button onclick="saveClientDetail(\${client.id})" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              <i class="fas fa-save mr-2"></i>保存
            </button>
          </div>
        </div>

        <div class="grid grid-cols-12 gap-6">
          <!-- 左侧：客户画像 -->
          <div class="col-span-4 space-y-6">
            <!-- 基本信息 -->
            <div class="bg-white rounded-lg shadow-sm p-6">
              <h3 class="text-lg font-bold text-gray-900 mb-4">
                <i class="fas fa-user-circle mr-2 text-blue-600"></i>基本信息
              </h3>
              <div class="space-y-3">
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">姓名</label>
                  <input type="text" id="client_name" value="\${client.name}" 
                         class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500">
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">电话</label>
                  <input type="text" id="client_phone" value="\${client.phone || ''}" 
                         class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500">
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">微信</label>
                  <input type="text" id="client_wechat" value="\${client.wechat || ''}" 
                         class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500">
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">邮箱</label>
                  <input type="email" id="client_email" value="\${client.email || ''}" 
                         class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500">
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">来源</label>
                  <input type="text" id="client_source" value="\${client.source}" 
                         class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500">
                </div>
              </div>
            </div>

            <!-- 当前阶段 -->
            <div class="bg-white rounded-lg shadow-sm p-6">
              <h3 class="text-lg font-bold text-gray-900 mb-4">
                <i class="fas fa-stream mr-2 text-blue-600"></i>当前阶段
              </h3>
              <select id="client_stage" class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                      onchange="updateClientStage(\${client.id}, this.value)">
                \${stageOptions.map(opt => \`
                  <option value="\${opt.value}" \${client.stage === opt.value ? 'selected' : ''}>
                    \${opt.label}
                  </option>
                \`).join('')}
              </select>
              <div class="mt-4 space-y-3">
                <div class="flex items-center justify-between">
                  <span class="text-sm text-gray-600">温度评分</span>
                  <span class="text-2xl font-bold text-blue-600">\${client.temperature_score}/100</span>
                </div>
                <button 
                  onclick="recalculateTemperature(\${client.id})" 
                  class="w-full text-sm bg-blue-50 text-blue-600 py-2 rounded hover:bg-blue-100 transition"
                >
                  <i class="fas fa-sync-alt mr-2"></i>重新计算温度
                </button>
              </div>
            </div>

            <!-- 兴趣标签 -->
            <div class="bg-white rounded-lg shadow-sm p-6">
              <h3 class="text-lg font-bold text-gray-900 mb-4">
                <i class="fas fa-tags mr-2 text-blue-600"></i>标签
              </h3>
              <div class="flex flex-wrap gap-2 mb-3">
                \${tags.map(tag => \`
                  <span class="px-3 py-1 rounded-full text-sm font-medium" 
                        style="background-color: \${tag.color}20; color: \${tag.color}">
                    \${tag.name}
                    <button onclick="removeTag(\${client.id}, \${tag.id})" class="ml-1 text-xs">×</button>
                  </span>
                \`).join('') || '<p class="text-gray-500 text-sm">暂无标签</p>'}
              </div>
              <button onclick="showAddTagModal(\${client.id})" class="text-sm text-blue-600 hover:text-blue-800">
                <i class="fas fa-plus mr-1"></i>添加标签
              </button>
            </div>

            <!-- 客户画像 -->
            <div class="bg-white rounded-lg shadow-sm p-6">
              <h3 class="text-lg font-bold text-gray-900 mb-4">
                <i class="fas fa-user-tag mr-2 text-blue-600"></i>客户画像
              </h3>
              <div class="space-y-3">
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">兴趣点</label>
                  <textarea id="client_interests" rows="2" 
                            class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                            placeholder="例如：数字货币、股票投资">\${client.interests || ''}</textarea>
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">性格特征</label>
                  <textarea id="client_personality" rows="2" 
                            class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                            placeholder="例如：理性、谨慎">\${client.personality || ''}</textarea>
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">稀缺品质</label>
                  <textarea id="client_unique_qualities" rows="2" 
                            class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                            placeholder="例如：决策果断、高净值">\${client.unique_qualities || ''}</textarea>
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">行为习惯</label>
                  <textarea id="client_behavior_patterns" rows="2" 
                            class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                            placeholder="例如：喜欢晚上联系、回复及时">\${client.behavior_patterns || ''}</textarea>
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">投资画像</label>
                  <textarea id="client_investment_profile" rows="2" 
                            class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                            placeholder="例如：风险偏好高、追求高收益">\${client.investment_profile || ''}</textarea>
                </div>
              </div>
            </div>
          </div>

          <!-- 右侧：互动日志 -->
          <div class="col-span-8">
            <div class="bg-white rounded-lg shadow-sm p-6">
              <h3 class="text-lg font-bold text-gray-900 mb-4">
                <i class="fas fa-history mr-2 text-blue-600"></i>互动日志
              </h3>

              <!-- 添加新日志 -->
              <div class="border-2 border-dashed border-gray-300 rounded-lg p-4 mb-6">
                <textarea id="new_log_content" rows="4" 
                          class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 mb-3"
                          placeholder="记录本次互动的关键信息..."></textarea>
                <div class="grid grid-cols-3 gap-3 mb-3">
                  <div>
                    <label class="block text-xs text-gray-600 mb-1">💡 互动亮点</label>
                    <textarea id="new_log_highlights" rows="2" 
                              class="w-full px-2 py-1 text-sm border rounded focus:ring-2 focus:ring-blue-500"
                              placeholder="客户积极响应..."></textarea>
                  </div>
                  <div>
                    <label class="block text-xs text-gray-600 mb-1">⚠️ 挑战</label>
                    <textarea id="new_log_challenges" rows="2" 
                              class="w-full px-2 py-1 text-sm border rounded focus:ring-2 focus:ring-blue-500"
                              placeholder="客户有疑虑..."></textarea>
                  </div>
                  <div>
                    <label class="block text-xs text-gray-600 mb-1">🎯 明日目标</label>
                    <textarea id="new_log_next_action" rows="2" 
                              class="w-full px-2 py-1 text-sm border rounded focus:ring-2 focus:ring-blue-500"
                              placeholder="继续跟进..."></textarea>
                  </div>
                </div>
                <button onclick="addNewLog(\${client.id})" 
                        class="w-full bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700">
                  <i class="fas fa-plus mr-2"></i>添加日志
                </button>
              </div>

              <!-- 日志 Timeline -->
              <div class="space-y-4">
                \${logs.length === 0 ? \`
                  <p class="text-gray-500 text-center py-8">暂无互动记录</p>
                \` : logs.map(log => \`
                  <div class="border-l-4 \${log.sentiment === 'positive' ? 'border-green-500' : 
                                           log.sentiment === 'negative' ? 'border-red-500' : 
                                           'border-blue-500'} pl-4 py-2">
                    <div class="flex items-start justify-between mb-2">
                      <span class="text-sm font-medium text-gray-900">
                        \${log.log_type === 'stage_change' ? '📊 阶段变更' : 
                          log.log_type === 'system_alert' ? '🔔 系统提醒' : '💬 互动记录'}
                      </span>
                      <span class="text-xs text-gray-500">
                        \${new Date(log.created_at).toLocaleString('zh-CN')}
                      </span>
                    </div>
                    <p class="text-gray-700 mb-2">\${log.content}</p>
                    \${log.highlights ? \`<p class="text-sm text-green-700">💡 \${log.highlights}</p>\` : ''}
                    \${log.challenges ? \`<p class="text-sm text-orange-700">⚠️ \${log.challenges}</p>\` : ''}
                    \${log.next_action ? \`<p class="text-sm text-blue-700">🎯 \${log.next_action}</p>\` : ''}
                  </div>
                \`).join('')}
              </div>
            </div>
          </div>
        </div>
      \`;

      document.getElementById('mainContent').innerHTML = html;
    }

    // 保存客户详情
    async function saveClientDetail(clientId) {
      const data = {
        name: document.getElementById('client_name').value,
        phone: document.getElementById('client_phone').value,
        wechat: document.getElementById('client_wechat').value,
        email: document.getElementById('client_email').value,
        source: document.getElementById('client_source').value,
        interests: document.getElementById('client_interests').value,
        personality: document.getElementById('client_personality').value,
        unique_qualities: document.getElementById('client_unique_qualities').value,
        behavior_patterns: document.getElementById('client_behavior_patterns').value,
        investment_profile: document.getElementById('client_investment_profile').value
      };

      try {
        await axios.put(\`/api/clients/\${clientId}\`, data);
        alert('保存成功！');
        viewClientDetail(clientId);
      } catch (error) {
        alert('保存失败：' + error.message);
      }
    }

    // 更新客户阶段
    async function updateClientStage(clientId, newStage) {
      try {
        await axios.put(\`/api/clients/\${clientId}/stage\`, { 
          stage: newStage,
          userId: 2
        });
        alert('阶段更新成功！');
        viewClientDetail(clientId);
      } catch (error) {
        alert('更新失败：' + error.message);
      }
    }

    // 添加新日志
    async function addNewLog(clientId) {
      const content = document.getElementById('new_log_content').value;
      if (!content.trim()) {
        alert('请输入日志内容');
        return;
      }

      const data = {
        client_id: clientId,
        user_id: 2,
        content: content,
        highlights: document.getElementById('new_log_highlights').value,
        challenges: document.getElementById('new_log_challenges').value,
        next_action: document.getElementById('new_log_next_action').value,
        sentiment: 'neutral'
      };

      try {
        await axios.post('/api/logs', data);
        alert('日志添加成功！');
        viewClientDetail(clientId);
      } catch (error) {
        alert('添加失败：' + error.message);
      }
    }

    // 显示标签管理
    let currentClientIdForTag = null;
    async function showTagsManagement() {
      document.getElementById('tagsManagementModal').classList.remove('hidden');
      await loadTagsList();
    }

    // 隐藏标签管理
    function hideTagsManagement() {
      document.getElementById('tagsManagementModal').classList.add('hidden');
    }

    // 加载标签列表
    async function loadTagsList() {
      const container = document.getElementById('tagsListContainer');
      container.innerHTML = '<div class="text-center py-8"><i class="fas fa-spinner fa-spin text-2xl text-gray-500"></i></div>';
      
      try {
        const res = await axios.get('/api/tags');
        tagsData = res.data.tags;
        renderTagsList(tagsData);
      } catch (error) {
        container.innerHTML = '<div class="text-center py-8 text-red-600">加载失败</div>';
      }
    }

    // 渲染标签列表
    function renderTagsList(tags) {
      const categoriesMap = {
        'client_trait': '客户特征',
        'interest': '兴趣点',
        'risk': '风险',
        'opportunity': '机会'
      };

      const grouped = {};
      tags.forEach(tag => {
        const cat = tag.category || 'client_trait';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(tag);
      });

      const html = Object.entries(grouped).map(([category, categoryTags]) => \`
        <div class="mb-6">
          <h3 class="font-semibold text-gray-700 mb-3">\${categoriesMap[category] || category}</h3>
          <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
            \${categoryTags.map(tag => \`
              <div class="border rounded-lg p-3 flex items-center justify-between hover:shadow-md transition">
                <div class="flex items-center space-x-2">
                  <div class="w-4 h-4 rounded-full" style="background-color: \${tag.color}"></div>
                  <span class="font-medium text-gray-900">\${tag.name}</span>
                </div>
                <button onclick="deleteTag(\${tag.id}, '\${tag.name}')" class="text-red-500 hover:text-red-700">
                  <i class="fas fa-trash-alt"></i>
                </button>
              </div>
            \`).join('')}
          </div>
        </div>
      \`).join('');

      document.getElementById('tagsListContainer').innerHTML = html || 
        '<div class="text-center py-8 text-gray-500">暂无标签</div>';
    }

    // 删除标签
    async function deleteTag(tagId, tagName) {
      if (!confirm(\`确定要删除标签"\${tagName}"吗？\`)) return;
      
      try {
        await axios.delete(\`/api/tags/\${tagId}\`);
        await loadTagsList();
      } catch (error) {
        alert('删除失败：' + error.message);
      }
    }

    // 为客户添加标签
    async function showAddTagModal(clientId) {
      currentClientIdForTag = clientId;
      document.getElementById('addTagToClientModal').classList.remove('hidden');
      
      // 获取客户当前标签
      const clientRes = await axios.get(\`/api/clients/\${clientId}\`);
      const clientTagIds = clientRes.data.tags.map(t => t.id);
      
      // 显示可用标签
      const availableTags = tagsData.filter(t => !clientTagIds.includes(t.id));
      const html = availableTags.length > 0 ? availableTags.map(tag => \`
        <button 
          onclick="addTagToClient(\${tag.id})" 
          class="w-full text-left px-4 py-2 border rounded-lg hover:bg-gray-50 transition flex items-center justify-between"
        >
          <div class="flex items-center space-x-2">
            <div class="w-3 h-3 rounded-full" style="background-color: \${tag.color}"></div>
            <span>\${tag.name}</span>
          </div>
          <i class="fas fa-plus text-green-600"></i>
        </button>
      \`).join('') : '<p class="text-center text-gray-500 py-4">所有标签已添加</p>';
      
      document.getElementById('availableTagsList').innerHTML = html;
    }

    // 隐藏添加标签模态框
    function hideAddTagToClientModal() {
      document.getElementById('addTagToClientModal').classList.add('hidden');
      currentClientIdForTag = null;
    }

    // 添加标签到客户
    async function addTagToClient(tagId) {
      try {
        await axios.post(\`/api/clients/\${currentClientIdForTag}/tags\`, { tag_id: tagId });
        hideAddTagToClientModal();
        viewClientDetail(currentClientIdForTag);
      } catch (error) {
        alert('添加失败：' + error.message);
      }
    }

    // 移除标签
    async function removeTag(clientId, tagId) {
      if (!confirm('确定要移除此标签吗？')) return;
      
      try {
        await axios.delete(\`/api/clients/\${clientId}/tags/\${tagId}\`);
        viewClientDetail(clientId);
      } catch (error) {
        alert('移除失败：' + error.message);
      }
    }

    // 搜索处理（防抖）
    let searchTimeout;
    function handleSearch(keyword) {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(async () => {
        const tempFilter = document.getElementById('tempFilter').value;
        const res = await axios.get('/api/clients', {
          params: {
            search: keyword,
            temp_level: tempFilter
          }
        });
        clientsData = res.data.clients;
        renderKanban();
      }, 300);
    }

    // 筛选处理
    async function handleFilter() {
      const searchInput = document.getElementById('searchInput').value;
      const tempFilter = document.getElementById('tempFilter').value;
      
      const res = await axios.get('/api/clients', {
        params: {
          search: searchInput,
          temp_level: tempFilter
        }
      });
      clientsData = res.data.clients;
      renderKanban();
    }

    // 显示新增客户模态框
    function showNewClientModal() {
      document.getElementById('newClientModal').classList.remove('hidden');
    }

    // 隐藏新增客户模态框
    function hideNewClientModal() {
      document.getElementById('newClientModal').classList.add('hidden');
      document.getElementById('newClientForm').reset();
    }

    // 提交新客户表单
    document.getElementById('newClientForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const data = Object.fromEntries(formData.entries());
      
      try {
        await axios.post('/api/clients', data);
        hideNewClientModal();
        await showView('kanban');
        alert('客户创建成功！');
      } catch (error) {
        alert('创建失败：' + error.message);
      }
    });

    // 提交新建标签表单
    document.getElementById('newTagForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const data = Object.fromEntries(formData.entries());
      
      try {
        await axios.post('/api/tags', data);
        e.target.reset();
        await loadTagsList();
        alert('标签创建成功！');
      } catch (error) {
        alert('创建失败：' + error.message);
      }
    });

    // ============================================
    // 每日战报功能
    // ============================================
    
    let reportsData = [];
    let statsData = null;
    
    // 渲染每日战报页面
    async function renderDailyReports() {
      const content = document.getElementById('mainContent');
      
      try {
        // 获取最近30天的战报
        const reportsRes = await axios.get('/api/daily-reports', {
          params: { limit: 30 }
        });
        reportsData = reportsRes.data.reports;
        
        // 获取统计数据
        const statsRes = await axios.get('/api/daily-reports/stats/summary', {
          params: { days: 7 }
        });
        statsData = statsRes.data;
        
        const html = \`
          <div class="mb-6 flex items-center justify-between">
            <div>
              <h2 class="text-2xl font-bold text-gray-900">每日战报</h2>
              <p class="text-gray-600 mt-1">记录每日销售成果，跟踪业绩趋势</p>
            </div>
            <button 
              onclick="showSubmitReportModal()" 
              class="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium"
            >
              <i class="fas fa-plus mr-2"></i>提交今日战报
            </button>
          </div>
          
          <!-- 统计卡片 -->
          <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
            <div class="bg-white rounded-lg shadow-sm p-6">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-gray-600 text-sm">本周新客</p>
                  <p class="text-3xl font-bold text-purple-600">\${statsData.summary?.total_new_leads || 0}</p>
                  <p class="text-xs text-gray-500 mt-1">日均 \${(statsData.summary?.avg_new_leads || 0).toFixed(1)}</p>
                </div>
                <i class="fas fa-user-plus text-4xl text-purple-200"></i>
              </div>
            </div>
            
            <div class="bg-white rounded-lg shadow-sm p-6">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-gray-600 text-sm">本周互动</p>
                  <p class="text-3xl font-bold text-blue-600">\${statsData.summary?.total_interactions || 0}</p>
                  <p class="text-xs text-gray-500 mt-1">日均 \${(statsData.summary?.avg_interactions || 0).toFixed(1)}</p>
                </div>
                <i class="fas fa-comments text-4xl text-blue-200"></i>
              </div>
            </div>
            
            <div class="bg-white rounded-lg shadow-sm p-6">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-gray-600 text-sm">本周转化</p>
                  <p class="text-3xl font-bold text-green-600">\${statsData.summary?.total_conversions || 0}</p>
                  <p class="text-xs text-gray-500 mt-1">日均 \${(statsData.summary?.avg_conversions || 0).toFixed(1)}</p>
                </div>
                <i class="fas fa-check-circle text-4xl text-green-200"></i>
              </div>
            </div>
            
            <div class="bg-white rounded-lg shadow-sm p-6">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-gray-600 text-sm">已入金客户</p>
                  <p class="text-3xl font-bold text-orange-600">\${statsData.summary?.total_deposited || 0}</p>
                  <p class="text-xs text-gray-500 mt-1">最终目标</p>
                </div>
                <i class="fas fa-money-bill-wave text-4xl text-orange-200"></i>
              </div>
            </div>
          </div>
          
          <!-- 今日战报快捷卡片 -->
          \${statsData.todayReport ? \`
            <div class="bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg shadow-lg p-6 mb-8 text-white">
              <div class="flex items-center justify-between mb-4">
                <h3 class="text-xl font-bold">
                  <i class="fas fa-calendar-day mr-2"></i>今日战报
                </h3>
                <span class="text-sm opacity-90">\${statsData.todayReport.report_date}</span>
              </div>
              <div class="grid grid-cols-4 gap-4">
                <div class="text-center">
                  <p class="text-2xl font-bold">\${statsData.todayReport.new_leads}</p>
                  <p class="text-sm opacity-80">新接粉</p>
                </div>
                <div class="text-center">
                  <p class="text-2xl font-bold">\${statsData.todayReport.total_interactions}</p>
                  <p class="text-sm opacity-80">总互动</p>
                </div>
                <div class="text-center">
                  <p class="text-2xl font-bold">\${statsData.todayReport.conversions}</p>
                  <p class="text-sm opacity-80">转化数</p>
                </div>
                <div class="text-center">
                  <p class="text-2xl font-bold">\${statsData.todayReport.deposited}</p>
                  <p class="text-sm opacity-80">入金数</p>
                </div>
              </div>
              \${statsData.todayReport.notes ? \`
                <div class="mt-4 pt-4 border-t border-white border-opacity-20">
                  <p class="text-sm opacity-90"><strong>备注：</strong>\${statsData.todayReport.notes}</p>
                </div>
              \` : ''}
            </div>
          \` : \`
            <div class="bg-yellow-50 border-2 border-yellow-200 rounded-lg p-6 mb-8 text-center">
              <i class="fas fa-exclamation-circle text-3xl text-yellow-600 mb-3"></i>
              <p class="text-yellow-800 font-medium">今日还未提交战报</p>
              <button 
                onclick="showSubmitReportModal()" 
                class="mt-3 px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700"
              >
                立即提交
              </button>
            </div>
          \`}
          
          <!-- 历史战报列表 -->
          <div class="bg-white rounded-lg shadow-sm p-6">
            <h3 class="text-xl font-bold text-gray-900 mb-4">
              <i class="fas fa-history mr-2"></i>历史战报
            </h3>
            
            \${reportsData.length === 0 ? \`
              <div class="text-center py-12 text-gray-500">
                <i class="fas fa-inbox text-5xl mb-4"></i>
                <p>暂无战报记录</p>
              </div>
            \` : \`
              <div class="overflow-x-auto">
                <table class="w-full">
                  <thead class="bg-gray-50">
                    <tr>
                      <th class="px-4 py-3 text-left text-sm font-semibold text-gray-700">日期</th>
                      <th class="px-4 py-3 text-center text-sm font-semibold text-gray-700">新接粉</th>
                      <th class="px-4 py-3 text-center text-sm font-semibold text-gray-700">初步破冰</th>
                      <th class="px-4 py-3 text-center text-sm font-semibold text-gray-700">深度培育</th>
                      <th class="px-4 py-3 text-center text-sm font-semibold text-gray-700">高意向</th>
                      <th class="px-4 py-3 text-center text-sm font-semibold text-gray-700">已进群</th>
                      <th class="px-4 py-3 text-center text-sm font-semibold text-gray-700">已开户</th>
                      <th class="px-4 py-3 text-center text-sm font-semibold text-gray-700">已入金</th>
                      <th class="px-4 py-3 text-center text-sm font-semibold text-gray-700">总互动</th>
                      <th class="px-4 py-3 text-center text-sm font-semibold text-gray-700">转化</th>
                      <th class="px-4 py-3 text-center text-sm font-semibold text-gray-700">操作</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-gray-200">
                    \${reportsData.map(report => \`
                      <tr class="hover:bg-gray-50 transition">
                        <td class="px-4 py-3 text-sm font-medium text-gray-900">\${report.report_date}</td>
                        <td class="px-4 py-3 text-center text-sm text-gray-700">\${report.new_leads}</td>
                        <td class="px-4 py-3 text-center text-sm text-gray-700">\${report.initial_contacts}</td>
                        <td class="px-4 py-3 text-center text-sm text-gray-700">\${report.deep_nurturing}</td>
                        <td class="px-4 py-3 text-center text-sm text-gray-700">\${report.high_intents}</td>
                        <td class="px-4 py-3 text-center text-sm text-gray-700">\${report.joined_groups}</td>
                        <td class="px-4 py-3 text-center text-sm text-gray-700">\${report.opened_accounts}</td>
                        <td class="px-4 py-3 text-center text-sm text-gray-700 font-bold text-green-600">\${report.deposited}</td>
                        <td class="px-4 py-3 text-center text-sm text-blue-600 font-medium">\${report.total_interactions}</td>
                        <td class="px-4 py-3 text-center text-sm text-purple-600 font-medium">\${report.conversions}</td>
                        <td class="px-4 py-3 text-center">
                          <button 
                            onclick="viewReportDetail(\${report.id})" 
                            class="text-blue-600 hover:text-blue-800"
                            title="查看详情"
                          >
                            <i class="fas fa-eye"></i>
                          </button>
                        </td>
                      </tr>
                    \`).join('')}
                  </tbody>
                </table>
              </div>
            \`}
          </div>
        \`;
        
        content.innerHTML = html;
        
      } catch (error) {
        console.error('加载战报失败:', error);
        content.innerHTML = '<div class="text-center py-20 text-red-600">加载失败</div>';
      }
    }
    
    // 显示提交战报模态框
    function showSubmitReportModal() {
      const today = new Date().toISOString().split('T')[0];
      
      // 检查今日是否已提交
      const todayReport = statsData?.todayReport;
      
      const modal = document.createElement('div');
      modal.id = 'submitReportModal';
      modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
      modal.innerHTML = \`
        <div class="bg-white rounded-lg p-8 max-w-3xl w-full max-h-[90vh] overflow-y-auto">
          <div class="flex items-center justify-between mb-6">
            <h2 class="text-2xl font-bold text-gray-900">
              <i class="fas fa-file-alt mr-2 text-blue-600"></i>
              \${todayReport ? '编辑今日战报' : '提交今日战报'}
            </h2>
            <button onclick="closeSubmitReportModal()" class="text-gray-500 hover:text-gray-700">
              <i class="fas fa-times text-2xl"></i>
            </button>
          </div>
          
          <form id="submitReportForm" class="space-y-6">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-2">日期</label>
              <input 
                type="date" 
                name="report_date" 
                value="\${todayReport?.report_date || today}"
                required 
                class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
              >
            </div>
            
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">
                  <i class="fas fa-user-plus text-purple-600 mr-1"></i>新接粉
                </label>
                <input 
                  type="number" 
                  name="new_leads" 
                  value="\${todayReport?.new_leads || 0}"
                  min="0" 
                  class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                >
              </div>
              
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">
                  <i class="fas fa-handshake text-blue-600 mr-1"></i>初步破冰
                </label>
                <input 
                  type="number" 
                  name="initial_contacts" 
                  value="\${todayReport?.initial_contacts || 0}"
                  min="0" 
                  class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                >
              </div>
              
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">
                  <i class="fas fa-seedling text-green-600 mr-1"></i>深度培育
                </label>
                <input 
                  type="number" 
                  name="deep_nurturing" 
                  value="\${todayReport?.deep_nurturing || 0}"
                  min="0" 
                  class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                >
              </div>
              
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">
                  <i class="fas fa-fire text-orange-600 mr-1"></i>高意向
                </label>
                <input 
                  type="number" 
                  name="high_intents" 
                  value="\${todayReport?.high_intents || 0}"
                  min="0" 
                  class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                >
              </div>
              
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">
                  <i class="fas fa-users text-teal-600 mr-1"></i>已进群
                </label>
                <input 
                  type="number" 
                  name="joined_groups" 
                  value="\${todayReport?.joined_groups || 0}"
                  min="0" 
                  class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                >
              </div>
              
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">
                  <i class="fas fa-id-card text-indigo-600 mr-1"></i>已开户
                </label>
                <input 
                  type="number" 
                  name="opened_accounts" 
                  value="\${todayReport?.opened_accounts || 0}"
                  min="0" 
                  class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                >
              </div>
              
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">
                  <i class="fas fa-money-bill-wave text-green-600 mr-1"></i>已入金
                </label>
                <input 
                  type="number" 
                  name="deposited" 
                  value="\${todayReport?.deposited || 0}"
                  min="0" 
                  class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                >
              </div>
              
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">
                  <i class="fas fa-exchange-alt text-purple-600 mr-1"></i>转化数
                </label>
                <input 
                  type="number" 
                  name="conversions" 
                  value="\${todayReport?.conversions || 0}"
                  min="0" 
                  class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                >
              </div>
            </div>
            
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-2">
                <i class="fas fa-comments text-blue-600 mr-1"></i>总互动次数
              </label>
              <input 
                type="number" 
                name="total_interactions" 
                value="\${todayReport?.total_interactions || 0}"
                min="0" 
                class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
              >
            </div>
            
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-2">
                <i class="fas fa-sticky-note text-yellow-600 mr-1"></i>备注
              </label>
              <textarea 
                name="notes" 
                rows="4" 
                class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="记录今日重要事项、心得体会、明日计划等..."
              >\${todayReport?.notes || ''}</textarea>
            </div>
            
            <div class="flex space-x-3">
              <button 
                type="submit" 
                class="flex-1 bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 font-medium transition"
              >
                <i class="fas fa-check mr-2"></i>\${todayReport ? '更新战报' : '提交战报'}
              </button>
              <button 
                type="button" 
                onclick="closeSubmitReportModal()" 
                class="px-6 py-3 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition"
              >
                取消
              </button>
            </div>
          </form>
        </div>
      \`;
      
      document.body.appendChild(modal);
      
      // 绑定表单提交事件
      document.getElementById('submitReportForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        const data = Object.fromEntries(formData.entries());
        
        try {
          const res = await axios.post('/api/daily-reports', data);
          
          if (res.data.success) {
            alert(res.data.updated ? '战报更新成功！' : '战报提交成功！');
            closeSubmitReportModal();
            await renderDailyReports();
          }
        } catch (error) {
          alert('提交失败：' + (error.response?.data?.error || error.message));
        }
      });
    }
    
    // 关闭提交战报模态框
    function closeSubmitReportModal() {
      const modal = document.getElementById('submitReportModal');
      if (modal) {
        modal.remove();
      }
    }
    
    // 查看战报详情
    async function viewReportDetail(reportId) {
      try {
        const res = await axios.get(\`/api/daily-reports/\${reportId}\`);
        const report = res.data.report;
        
        const modal = document.createElement('div');
        modal.id = 'reportDetailModal';
        modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
        modal.innerHTML = \`
          <div class="bg-white rounded-lg p-8 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div class="flex items-center justify-between mb-6">
              <h2 class="text-2xl font-bold text-gray-900">
                <i class="fas fa-file-alt mr-2 text-blue-600"></i>
                战报详情 - \${report.report_date}
              </h2>
              <button onclick="closeReportDetailModal()" class="text-gray-500 hover:text-gray-700">
                <i class="fas fa-times text-2xl"></i>
              </button>
            </div>
            
            <div class="space-y-6">
              <!-- 漏斗各阶段数据 -->
              <div>
                <h3 class="text-lg font-semibold text-gray-900 mb-4">销售漏斗数据</h3>
                <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div class="bg-purple-50 rounded-lg p-4 text-center">
                    <p class="text-3xl font-bold text-purple-600">\${report.new_leads}</p>
                    <p class="text-sm text-gray-600 mt-1">新接粉</p>
                  </div>
                  <div class="bg-blue-50 rounded-lg p-4 text-center">
                    <p class="text-3xl font-bold text-blue-600">\${report.initial_contacts}</p>
                    <p class="text-sm text-gray-600 mt-1">初步破冰</p>
                  </div>
                  <div class="bg-green-50 rounded-lg p-4 text-center">
                    <p class="text-3xl font-bold text-green-600">\${report.deep_nurturing}</p>
                    <p class="text-sm text-gray-600 mt-1">深度培育</p>
                  </div>
                  <div class="bg-orange-50 rounded-lg p-4 text-center">
                    <p class="text-3xl font-bold text-orange-600">\${report.high_intents}</p>
                    <p class="text-sm text-gray-600 mt-1">高意向</p>
                  </div>
                  <div class="bg-teal-50 rounded-lg p-4 text-center">
                    <p class="text-3xl font-bold text-teal-600">\${report.joined_groups}</p>
                    <p class="text-sm text-gray-600 mt-1">已进群</p>
                  </div>
                  <div class="bg-indigo-50 rounded-lg p-4 text-center">
                    <p class="text-3xl font-bold text-indigo-600">\${report.opened_accounts}</p>
                    <p class="text-sm text-gray-600 mt-1">已开户</p>
                  </div>
                  <div class="bg-green-50 rounded-lg p-4 text-center">
                    <p class="text-3xl font-bold text-green-600">\${report.deposited}</p>
                    <p class="text-sm text-gray-600 mt-1">已入金</p>
                  </div>
                  <div class="bg-purple-50 rounded-lg p-4 text-center">
                    <p class="text-3xl font-bold text-purple-600">\${report.conversions}</p>
                    <p class="text-sm text-gray-600 mt-1">转化数</p>
                  </div>
                </div>
              </div>
              
              <!-- 互动数据 -->
              <div>
                <h3 class="text-lg font-semibold text-gray-900 mb-4">互动数据</h3>
                <div class="bg-blue-50 rounded-lg p-6">
                  <div class="flex items-center justify-between">
                    <div>
                      <p class="text-gray-600">总互动次数</p>
                      <p class="text-4xl font-bold text-blue-600">\${report.total_interactions}</p>
                    </div>
                    <i class="fas fa-comments text-6xl text-blue-200"></i>
                  </div>
                </div>
              </div>
              
              <!-- 备注 -->
              \${report.notes ? \`
                <div>
                  <h3 class="text-lg font-semibold text-gray-900 mb-4">备注</h3>
                  <div class="bg-gray-50 rounded-lg p-4">
                    <p class="text-gray-700 whitespace-pre-wrap">\${report.notes}</p>
                  </div>
                </div>
              \` : ''}
              
              <!-- 时间信息 -->
              <div class="text-sm text-gray-500 pt-4 border-t">
                <p>提交时间：\${new Date(report.created_at).toLocaleString('zh-CN')}</p>
                \${report.updated_at !== report.created_at ? 
                  \`<p>更新时间：\${new Date(report.updated_at).toLocaleString('zh-CN')}</p>\` : ''}
              </div>
            </div>
            
            <div class="mt-6">
              <button 
                onclick="closeReportDetailModal()" 
                class="w-full bg-gray-300 text-gray-700 px-6 py-3 rounded-lg hover:bg-gray-400 transition"
              >
                关闭
              </button>
            </div>
          </div>
        \`;
        
        document.body.appendChild(modal);
        
      } catch (error) {
        alert('加载失败：' + error.message);
      }
    }
    
    // 关闭战报详情模态框
    function closeReportDetailModal() {
      const modal = document.getElementById('reportDetailModal');
      if (modal) {
        modal.remove();
      }
    }

    // ============================================
    // 话术智库功能
    // ============================================
    
    let scriptsData = [];
    let scriptsStats = null;
    
    // 话术分类定义
    const scriptCategories = {
      'breaking_ice': { name: '破冰话术', icon: 'fa-handshake', color: 'blue' },
      'nurturing': { name: '培育话术', icon: 'fa-seedling', color: 'green' },
      'objection_handling': { name: '异议处理', icon: 'fa-shield-alt', color: 'orange' },
      'closing': { name: '促成话术', icon: 'fa-flag-checkered', color: 'purple' },
      'follow_up': { name: '跟进话术', icon: 'fa-sync', color: 'teal' },
      'general': { name: '通用话术', icon: 'fa-comments', color: 'gray' }
    };
    
    // 渲染话术智库页面
    async function renderScriptsLibrary() {
      const content = document.getElementById('mainContent');
      
      try {
        // 获取话术列表
        const scriptsRes = await axios.get('/api/scripts');
        scriptsData = scriptsRes.data.scripts;
        
        // 获取统计数据
        const statsRes = await axios.get('/api/scripts/stats/summary');
        scriptsStats = statsRes.data;
        
        const html = \`
          <div class="mb-6 flex items-center justify-between">
            <div>
              <h2 class="text-2xl font-bold text-gray-900">话术智库</h2>
              <p class="text-gray-600 mt-1">销售话术知识库，积累成功经验</p>
            </div>
            <button 
              onclick="showCreateScriptModal()" 
              class="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium"
            >
              <i class="fas fa-plus mr-2"></i>新建话术
            </button>
          </div>
          
          <!-- 统计卡片 -->
          <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div class="bg-white rounded-lg shadow-sm p-6">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-gray-600 text-sm">我的话术</p>
                  <p class="text-3xl font-bold text-blue-600">\${scriptsStats.myScripts}</p>
                </div>
                <i class="fas fa-user-edit text-4xl text-blue-200"></i>
              </div>
            </div>
            
            <div class="bg-white rounded-lg shadow-sm p-6">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-gray-600 text-sm">团队共享</p>
                  <p class="text-3xl font-bold text-green-600">\${scriptsStats.publicScripts}</p>
                </div>
                <i class="fas fa-users text-4xl text-green-200"></i>
              </div>
            </div>
            
            <div class="bg-white rounded-lg shadow-sm p-6">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-gray-600 text-sm">总话术数</p>
                  <p class="text-3xl font-bold text-purple-600">\${scriptsStats.totalScripts}</p>
                </div>
                <i class="fas fa-book text-4xl text-purple-200"></i>
              </div>
            </div>
          </div>
          
          <!-- 最常用话术 -->
          \${scriptsStats.topScripts && scriptsStats.topScripts.length > 0 ? \`
            <div class="bg-gradient-to-r from-green-500 to-green-600 rounded-lg shadow-lg p-6 mb-8 text-white">
              <h3 class="text-xl font-bold mb-4">
                <i class="fas fa-trophy mr-2"></i>最常用话术 Top 5
              </h3>
              <div class="space-y-2">
                \${scriptsStats.topScripts.map((script, index) => \`
                  <div class="flex items-center justify-between bg-white bg-opacity-20 rounded px-4 py-2">
                    <div class="flex items-center space-x-3">
                      <span class="text-2xl font-bold">#\${index + 1}</span>
                      <div>
                        <p class="font-medium">\${script.title}</p>
                        <p class="text-sm opacity-80">分类: \${scriptCategories[script.category]?.name || script.category}</p>
                      </div>
                    </div>
                    <div class="text-right">
                      <p class="text-2xl font-bold">\${script.success_count}</p>
                      <p class="text-xs opacity-80">使用次数</p>
                    </div>
                  </div>
                \`).join('')}
              </div>
            </div>
          \` : ''}
          
          <!-- 筛选和搜索 -->
          <div class="bg-white rounded-lg shadow-sm p-4 mb-6">
            <div class="flex space-x-3">
              <div class="relative flex-1">
                <input 
                  type="text" 
                  id="scriptSearchInput"
                  placeholder="搜索话术标题或内容..." 
                  class="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                  onkeyup="handleScriptSearch(this.value)"
                >
                <i class="fas fa-search absolute left-3 top-3 text-gray-400"></i>
              </div>
              
              <select 
                id="categoryFilter" 
                class="px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                onchange="handleScriptFilter()"
              >
                <option value="">所有分类</option>
                \${Object.entries(scriptCategories).map(([key, cat]) => \`
                  <option value="\${key}">\${cat.name}</option>
                \`).join('')}
              </select>
              
              <select 
                id="publicFilter" 
                class="px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                onchange="handleScriptFilter()"
              >
                <option value="">全部</option>
                <option value="false">我的</option>
                <option value="true">团队共享</option>
              </select>
            </div>
          </div>
          
          <!-- 话术列表 -->
          <div class="bg-white rounded-lg shadow-sm p-6">
            <h3 class="text-xl font-bold text-gray-900 mb-4">
              <i class="fas fa-list mr-2"></i>话术列表
            </h3>
            
            \${scriptsData.length === 0 ? \`
              <div class="text-center py-12 text-gray-500">
                <i class="fas fa-inbox text-5xl mb-4"></i>
                <p>暂无话术记录</p>
                <button 
                  onclick="showCreateScriptModal()" 
                  class="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  创建第一个话术
                </button>
              </div>
            \` : \`
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                \${scriptsData.map(script => renderScriptCard(script)).join('')}
              </div>
            \`}
          </div>
        \`;
        
        content.innerHTML = html;
        
      } catch (error) {
        console.error('加载话术失败:', error);
        content.innerHTML = '<div class="text-center py-20 text-red-600">加载失败</div>';
      }
    }
    
    // 渲染话术卡片
    function renderScriptCard(script) {
      const category = scriptCategories[script.category] || scriptCategories['general'];
      const colorClasses = {
        blue: 'bg-blue-50 text-blue-700 border-blue-200',
        green: 'bg-green-50 text-green-700 border-green-200',
        orange: 'bg-orange-50 text-orange-700 border-orange-200',
        purple: 'bg-purple-50 text-purple-700 border-purple-200',
        teal: 'bg-teal-50 text-teal-700 border-teal-200',
        gray: 'bg-gray-50 text-gray-700 border-gray-200'
      };
      
      return \`
        <div class="border rounded-lg p-4 hover:shadow-md transition cursor-pointer" 
             onclick="viewScriptDetail(\${script.id})">
          <div class="flex items-start justify-between mb-3">
            <div class="flex items-center space-x-2">
              <span class="\${colorClasses[category.color]} px-3 py-1 rounded-full text-xs font-medium border">
                <i class="fas \${category.icon} mr-1"></i>
                \${category.name}
              </span>
              \${script.is_public ? \`
                <span class="bg-green-100 text-green-700 px-2 py-1 rounded-full text-xs">
                  <i class="fas fa-share-alt mr-1"></i>共享
                </span>
              \` : ''}
            </div>
            <div class="flex items-center space-x-2">
              <span class="text-sm text-gray-500">
                <i class="fas fa-fire text-orange-500 mr-1"></i>
                \${script.success_count || 0}
              </span>
              <button 
                onclick="event.stopPropagation(); useScript(\${script.id})" 
                class="text-blue-600 hover:text-blue-800"
                title="使用此话术"
              >
                <i class="fas fa-plus-circle"></i>
              </button>
            </div>
          </div>
          
          <h4 class="text-lg font-semibold text-gray-900 mb-2">\${script.title}</h4>
          <p class="text-gray-600 text-sm line-clamp-2 mb-3">\${script.content}</p>
          
          <div class="flex items-center justify-between text-xs text-gray-500">
            <span>
              <i class="fas fa-user mr-1"></i>
              \${script.creator_name || '未知'}
            </span>
            <span>
              <i class="fas fa-clock mr-1"></i>
              \${new Date(script.created_at).toLocaleDateString()}
            </span>
          </div>
        </div>
      \`;
    }
    
    // 搜索话术（防抖）
    let scriptSearchTimeout;
    function handleScriptSearch(keyword) {
      clearTimeout(scriptSearchTimeout);
      scriptSearchTimeout = setTimeout(async () => {
        await handleScriptFilter();
      }, 300);
    }
    
    // 筛选话术
    async function handleScriptFilter() {
      const searchInput = document.getElementById('scriptSearchInput')?.value || '';
      const category = document.getElementById('categoryFilter')?.value || '';
      const isPublic = document.getElementById('publicFilter')?.value;
      
      try {
        const params = { search: searchInput };
        if (category) params.category = category;
        if (isPublic !== '') params.is_public = isPublic;
        
        const res = await axios.get('/api/scripts', { params });
        scriptsData = res.data.scripts;
        await renderScriptsLibrary();
      } catch (error) {
        console.error('筛选失败:', error);
      }
    }
    
    // 显示创建话术模态框
    function showCreateScriptModal(editScript = null) {
      const isEdit = !!editScript;
      
      const modal = document.createElement('div');
      modal.id = 'createScriptModal';
      modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
      modal.innerHTML = \`
        <div class="bg-white rounded-lg p-8 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
          <div class="flex items-center justify-between mb-6">
            <h2 class="text-2xl font-bold text-gray-900">
              <i class="fas fa-\${isEdit ? 'edit' : 'plus'} mr-2 text-blue-600"></i>
              \${isEdit ? '编辑话术' : '新建话术'}
            </h2>
            <button onclick="closeCreateScriptModal()" class="text-gray-500 hover:text-gray-700">
              <i class="fas fa-times text-2xl"></i>
            </button>
          </div>
          
          <form id="createScriptForm" class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-2">话术标题 *</label>
              <input 
                type="text" 
                name="title" 
                value="\${editScript?.title || ''}"
                required 
                class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="例如：高净值客户破冰话术"
              >
            </div>
            
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-2">话术分类 *</label>
              <select 
                name="category" 
                required 
                class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
              >
                \${Object.entries(scriptCategories).map(([key, cat]) => \`
                  <option value="\${key}" \${editScript?.category === key ? 'selected' : ''}>
                    \${cat.name}
                  </option>
                \`).join('')}
              </select>
            </div>
            
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-2">话术内容 *</label>
              <textarea 
                name="content" 
                rows="8" 
                required 
                class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="输入完整的话术内容，可以包括：\n- 开场白\n- 核心话术\n- 可能的应对方案\n- 注意事项"
              >\${editScript?.content || ''}</textarea>
            </div>
            
            <div class="flex items-center space-x-2">
              <input 
                type="checkbox" 
                name="is_public" 
                id="isPublicCheck"
                \${editScript?.is_public ? 'checked' : ''}
                class="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              >
              <label for="isPublicCheck" class="text-sm text-gray-700">
                <i class="fas fa-share-alt mr-1 text-green-600"></i>
                团队共享（其他成员可查看和使用）
              </label>
            </div>
            
            <div class="flex space-x-3 pt-4">
              <button 
                type="submit" 
                class="flex-1 bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 font-medium transition"
              >
                <i class="fas fa-\${isEdit ? 'save' : 'check'} mr-2"></i>
                \${isEdit ? '保存修改' : '创建话术'}
              </button>
              <button 
                type="button" 
                onclick="closeCreateScriptModal()" 
                class="px-6 py-3 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition"
              >
                取消
              </button>
            </div>
          </form>
        </div>
      \`;
      
      document.body.appendChild(modal);
      
      // 绑定表单提交事件
      document.getElementById('createScriptForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        const data = {
          title: formData.get('title'),
          content: formData.get('content'),
          category: formData.get('category'),
          is_public: formData.get('is_public') === 'on'
        };
        
        try {
          if (isEdit) {
            await axios.put(\`/api/scripts/\${editScript.id}\`, data);
            alert('话术更新成功！');
          } else {
            await axios.post('/api/scripts', data);
            alert('话术创建成功！');
          }
          closeCreateScriptModal();
          await renderScriptsLibrary();
        } catch (error) {
          alert('操作失败：' + (error.response?.data?.error || error.message));
        }
      });
    }
    
    // 关闭创建话术模态框
    function closeCreateScriptModal() {
      const modal = document.getElementById('createScriptModal');
      if (modal) {
        modal.remove();
      }
    }
    
    // 查看话术详情
    async function viewScriptDetail(scriptId) {
      try {
        const res = await axios.get(\`/api/scripts/\${scriptId}\`);
        const script = res.data.script;
        const category = scriptCategories[script.category] || scriptCategories['general'];
        
        const modal = document.createElement('div');
        modal.id = 'scriptDetailModal';
        modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
        modal.innerHTML = \`
          <div class="bg-white rounded-lg p-8 max-w-3xl w-full max-h-[90vh] overflow-y-auto">
            <div class="flex items-center justify-between mb-6">
              <div>
                <div class="flex items-center space-x-3 mb-2">
                  <span class="bg-\${category.color}-100 text-\${category.color}-700 px-3 py-1 rounded-full text-sm font-medium">
                    <i class="fas \${category.icon} mr-1"></i>
                    \${category.name}
                  </span>
                  \${script.is_public ? \`
                    <span class="bg-green-100 text-green-700 px-3 py-1 rounded-full text-sm">
                      <i class="fas fa-share-alt mr-1"></i>团队共享
                    </span>
                  \` : ''}
                  <span class="bg-orange-100 text-orange-700 px-3 py-1 rounded-full text-sm">
                    <i class="fas fa-fire mr-1"></i>使用 \${script.success_count || 0} 次
                  </span>
                </div>
                <h2 class="text-2xl font-bold text-gray-900">\${script.title}</h2>
              </div>
              <button onclick="closeScriptDetailModal()" class="text-gray-500 hover:text-gray-700">
                <i class="fas fa-times text-2xl"></i>
              </button>
            </div>
            
            <div class="bg-gray-50 rounded-lg p-6 mb-6">
              <h3 class="text-lg font-semibold text-gray-900 mb-3">话术内容</h3>
              <p class="text-gray-700 whitespace-pre-wrap">\${script.content}</p>
            </div>
            
            <div class="border-t pt-4 mb-6">
              <div class="grid grid-cols-2 gap-4 text-sm text-gray-600">
                <div>
                  <i class="fas fa-user mr-2 text-blue-600"></i>
                  创建人：\${script.creator_name || '未知'}
                </div>
                <div>
                  <i class="fas fa-clock mr-2 text-blue-600"></i>
                  创建时间：\${new Date(script.created_at).toLocaleString('zh-CN')}
                </div>
                \${script.source_client_name ? \`
                  <div>
                    <i class="fas fa-user-check mr-2 text-green-600"></i>
                    成功案例：\${script.source_client_name}
                  </div>
                \` : ''}
              </div>
            </div>
            
            <div class="flex space-x-3">
              <button 
                onclick="useScript(\${script.id})" 
                class="flex-1 bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition"
              >
                <i class="fas fa-check-circle mr-2"></i>使用此话术
              </button>
              <button 
                onclick="showCreateScriptModal(\${JSON.stringify(script).replace(/"/g, '&quot;')})" 
                class="px-6 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition"
              >
                <i class="fas fa-edit mr-2"></i>编辑
              </button>
              <button 
                onclick="deleteScript(\${script.id}, '\${script.title}')" 
                class="px-6 py-3 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition"
              >
                <i class="fas fa-trash-alt mr-2"></i>删除
              </button>
            </div>
          </div>
        \`;
        
        document.body.appendChild(modal);
        
      } catch (error) {
        alert('加载失败：' + error.message);
      }
    }
    
    // 关闭话术详情模态框
    function closeScriptDetailModal() {
      const modal = document.getElementById('scriptDetailModal');
      if (modal) {
        modal.remove();
      }
    }
    
    // 使用话术
    async function useScript(scriptId) {
      try {
        await axios.post(\`/api/scripts/\${scriptId}/use\`, {});
        alert('已记录使用！成功次数 +1');
        closeScriptDetailModal();
        await renderScriptsLibrary();
      } catch (error) {
        alert('记录失败：' + error.message);
      }
    }
    
    // 删除话术
    async function deleteScript(scriptId, scriptTitle) {
      if (!confirm(\`确定要删除话术"\${scriptTitle}"吗？\`)) return;
      
      try {
        await axios.delete(\`/api/scripts/\${scriptId}\`);
        alert('删除成功！');
        closeScriptDetailModal();
        await renderScriptsLibrary();
      } catch (error) {
        alert('删除失败：' + error.message);
      }
    }

    // ============================================
    // 批量导入功能
    // ============================================
    
    // 显示导入模态框
    function showImportModal() {
      const modal = document.createElement('div');
      modal.id = 'importModal';
      modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
      modal.innerHTML = \`
        <div class="bg-white rounded-lg p-8 max-w-4xl w-full max-h-[90vh] overflow-y-auto">
          <div class="flex items-center justify-between mb-6">
            <h2 class="text-2xl font-bold text-gray-900">
              <i class="fas fa-file-import mr-2 text-green-600"></i>
              批量导入客户数据
            </h2>
            <button onclick="closeImportModal()" class="text-gray-500 hover:text-gray-700">
              <i class="fas fa-times text-2xl"></i>
            </button>
          </div>
          
          <!-- 导入方式选择 -->
          <div class="mb-6">
            <div class="flex space-x-4 mb-4">
              <button 
                id="csvTabBtn"
                onclick="showImportTab('csv')" 
                class="flex-1 px-4 py-3 border-b-2 border-blue-600 text-blue-600 font-medium"
              >
                <i class="fas fa-file-csv mr-2"></i>CSV文件导入
              </button>
              <button 
                id="pasteTabBtn"
                onclick="showImportTab('paste')" 
                class="flex-1 px-4 py-3 border-b-2 border-transparent text-gray-600 hover:text-blue-600 font-medium"
              >
                <i class="fas fa-table mr-2"></i>Excel粘贴导入
              </button>
              <button 
                id="quickTabBtn"
                onclick="showImportTab('quick')" 
                class="flex-1 px-4 py-3 border-b-2 border-transparent text-gray-600 hover:text-blue-600 font-medium"
              >
                <i class="fas fa-bolt mr-2"></i>快速批量录入
              </button>
            </div>
          </div>
          
          <!-- CSV导入标签页 -->
          <div id="csvTab" class="import-tab">
            <div class="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
              <h3 class="font-semibold text-blue-900 mb-2">
                <i class="fas fa-info-circle mr-2"></i>CSV格式说明
              </h3>
              <p class="text-sm text-blue-800 mb-2">CSV文件第一行必须包含表头，支持以下字段：</p>
              <div class="text-sm text-blue-700 space-y-1">
                <p><strong>必填：</strong>姓名</p>
                <p><strong>可选：</strong>电话、微信、邮箱、来源、阶段、兴趣点、性格特征、稀缺品质、行为习惯、投资画像</p>
              </div>
              <button 
                onclick="downloadTemplate()" 
                class="mt-3 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
              >
                <i class="fas fa-download mr-2"></i>下载CSV模板
              </button>
            </div>
            
            <div class="mb-4">
              <label class="block text-sm font-medium text-gray-700 mb-2">
                选择CSV文件或直接粘贴CSV内容
              </label>
              <input 
                type="file" 
                id="csvFileInput"
                accept=".csv,.txt"
                class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 mb-3"
                onchange="handleFileSelect(event)"
              >
              <textarea 
                id="csvTextInput"
                rows="10" 
                class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                placeholder="或者直接粘贴CSV内容（每行一个客户，用逗号或制表符分隔）"
              ></textarea>
            </div>
            
            <div class="flex space-x-3">
              <button 
                onclick="parseAndPreviewCSV()" 
                class="flex-1 bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 font-medium"
              >
                <i class="fas fa-eye mr-2"></i>预览数据
              </button>
              <button 
                onclick="closeImportModal()" 
                class="px-6 py-3 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400"
              >
                取消
              </button>
            </div>
          </div>
          
          <!-- Excel粘贴导入标签页 -->
          <div id="pasteTab" class="import-tab hidden">
            <div class="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
              <h3 class="font-semibold text-green-900 mb-2">
                <i class="fas fa-info-circle mr-2"></i>Excel粘贴导入说明
              </h3>
              <p class="text-sm text-green-800">
                1. 在Excel中选择要导入的客户数据（包含表头）<br>
                2. 复制（Ctrl+C）<br>
                3. 粘贴到下方文本框（Ctrl+V）<br>
                4. 点击"解析数据"按钮
              </p>
            </div>
            
            <div class="mb-4">
              <label class="block text-sm font-medium text-gray-700 mb-2">
                从Excel粘贴数据
              </label>
              <textarea 
                id="excelPasteInput"
                rows="12" 
                class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                placeholder="从Excel复制后在此粘贴（包含表头行）"
              ></textarea>
            </div>
            
            <div class="flex space-x-3">
              <button 
                onclick="parseAndPreviewExcel()" 
                class="flex-1 bg-green-600 text-white px-6 py-3 rounded-lg hover:bg-green-700 font-medium"
              >
                <i class="fas fa-magic mr-2"></i>解析数据
              </button>
              <button 
                onclick="closeImportModal()" 
                class="px-6 py-3 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400"
              >
                取消
              </button>
            </div>
          </div>
          
          <!-- 快速批量录入标签页 -->
          <div id="quickTab" class="import-tab hidden">
            <div class="bg-purple-50 border border-purple-200 rounded-lg p-4 mb-4">
              <h3 class="font-semibold text-purple-900 mb-2">
                <i class="fas fa-info-circle mr-2"></i>快速批量录入说明
              </h3>
              <p class="text-sm text-purple-800">
                适合快速录入多个客户的基本信息，每行一个客户。<br>
                格式：姓名, 电话, 微信, 来源（用逗号分隔）
              </p>
            </div>
            
            <div class="mb-4">
              <label class="block text-sm font-medium text-gray-700 mb-2">
                批量快速录入（每行一个客户）
              </label>
              <textarea 
                id="quickInput"
                rows="12" 
                class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                placeholder="示例：
张三, 13800138000, wechat123, LinkedIn
李四, 13900139000, wechat456, 朋友推荐
王五, 13700137000, wechat789, Facebook"
              ></textarea>
            </div>
            
            <div class="flex space-x-3">
              <button 
                onclick="parseAndPreviewQuick()" 
                class="flex-1 bg-purple-600 text-white px-6 py-3 rounded-lg hover:bg-purple-700 font-medium"
              >
                <i class="fas fa-rocket mr-2"></i>解析并导入
              </button>
              <button 
                onclick="closeImportModal()" 
                class="px-6 py-3 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      \`;
      
      document.body.appendChild(modal);
    }
    
    // 关闭导入模态框
    function closeImportModal() {
      const modal = document.getElementById('importModal');
      if (modal) {
        modal.remove();
      }
    }
    
    // 切换导入标签页
    function showImportTab(tab) {
      // 隐藏所有标签页
      document.querySelectorAll('.import-tab').forEach(el => el.classList.add('hidden'));
      
      // 重置所有按钮样式
      ['csvTabBtn', 'pasteTabBtn', 'quickTabBtn'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
          btn.classList.remove('border-blue-600', 'text-blue-600');
          btn.classList.add('border-transparent', 'text-gray-600');
        }
      });
      
      // 显示选中的标签页
      const targetTab = document.getElementById(tab + 'Tab');
      const targetBtn = document.getElementById(tab + 'TabBtn');
      if (targetTab) targetTab.classList.remove('hidden');
      if (targetBtn) {
        targetBtn.classList.remove('border-transparent', 'text-gray-600');
        targetBtn.classList.add('border-blue-600', 'text-blue-600');
      }
    }
    
    // 下载CSV模板
    function downloadTemplate() {
      const template = '姓名,电话,微信,邮箱,来源,阶段,兴趣点,性格特征,稀缺品质,行为习惯,投资画像\\n' +
                       '张三,13800138000,wechat123,zhang@example.com,LinkedIn,new_lead,数字货币,理性谨慎,决策果断,喜欢晚上联系,风险偏好高\\n' +
                       '李四,13900139000,wechat456,li@example.com,朋友推荐,initial_contact,股票投资,开朗外向,高净值,回复及时,追求稳健';
      
      const blob = new Blob([template], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'clients_template.csv';
      link.click();
    }
    
    // 处理文件选择
    function handleFileSelect(event) {
      const file = event.target.files[0];
      if (!file) return;
      
      const reader = new FileReader();
      reader.onload = function(e) {
        document.getElementById('csvTextInput').value = e.target.result;
      };
      reader.readAsText(file);
    }
    
    // 解析并预览CSV
    async function parseAndPreviewCSV() {
      const csvText = document.getElementById('csvTextInput').value.trim();
      
      if (!csvText) {
        alert('请输入或上传CSV内容');
        return;
      }
      
      try {
        const res = await axios.post('/api/clients/parse-csv', { csvText });
        
        if (res.data.success) {
          showPreviewModal(res.data.clients);
        } else {
          alert('解析失败：' + res.data.error);
        }
      } catch (error) {
        alert('解析失败：' + error.message);
      }
    }
    
    // 解析并预览Excel粘贴数据
    async function parseAndPreviewExcel() {
      const excelText = document.getElementById('excelPasteInput').value.trim();
      
      if (!excelText) {
        alert('请粘贴Excel数据');
        return;
      }
      
      // Excel粘贴的数据通常是制表符分隔的
      try {
        const res = await axios.post('/api/clients/parse-csv', { csvText: excelText });
        
        if (res.data.success) {
          showPreviewModal(res.data.clients);
        } else {
          alert('解析失败：' + res.data.error);
        }
      } catch (error) {
        alert('解析失败：' + error.message);
      }
    }
    
    // 解析并预览快速录入
    async function parseAndPreviewQuick() {
      const quickText = document.getElementById('quickInput').value.trim();
      
      if (!quickText) {
        alert('请输入客户数据');
        return;
      }
      
      // 解析简单格式：姓名, 电话, 微信, 来源
      const lines = quickText.split('\\n');
      const clients = [];
      
      for (const line of lines) {
        const parts = line.split(',').map(p => p.trim());
        if (parts[0]) {
          clients.push({
            name: parts[0],
            phone: parts[1] || '',
            wechat: parts[2] || '',
            source: parts[3] || '其他'
          });
        }
      }
      
      if (clients.length === 0) {
        alert('没有解析到有效数据');
        return;
      }
      
      showPreviewModal(clients);
    }
    
    // 显示预览模态框
    function showPreviewModal(clients) {
      closeImportModal();
      
      const modal = document.createElement('div');
      modal.id = 'previewModal';
      modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
      modal.innerHTML = \`
        <div class="bg-white rounded-lg p-8 max-w-6xl w-full max-h-[90vh] overflow-y-auto">
          <div class="flex items-center justify-between mb-6">
            <div>
              <h2 class="text-2xl font-bold text-gray-900">
                <i class="fas fa-eye mr-2 text-blue-600"></i>
                数据预览
              </h2>
              <p class="text-gray-600 mt-1">共 \${clients.length} 条数据</p>
            </div>
            <button onclick="closePreviewModal()" class="text-gray-500 hover:text-gray-700">
              <i class="fas fa-times text-2xl"></i>
            </button>
          </div>
          
          <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
            <p class="text-sm text-yellow-800">
              <i class="fas fa-exclamation-triangle mr-2"></i>
              请仔细检查数据，确认无误后点击"确认导入"按钮
            </p>
          </div>
          
          <div class="overflow-x-auto mb-6">
            <table class="w-full border-collapse">
              <thead class="bg-gray-50">
                <tr>
                  <th class="px-4 py-2 text-left text-sm font-semibold text-gray-700 border">序号</th>
                  <th class="px-4 py-2 text-left text-sm font-semibold text-gray-700 border">姓名</th>
                  <th class="px-4 py-2 text-left text-sm font-semibold text-gray-700 border">电话</th>
                  <th class="px-4 py-2 text-left text-sm font-semibold text-gray-700 border">微信</th>
                  <th class="px-4 py-2 text-left text-sm font-semibold text-gray-700 border">来源</th>
                  <th class="px-4 py-2 text-left text-sm font-semibold text-gray-700 border">阶段</th>
                </tr>
              </thead>
              <tbody>
                \${clients.slice(0, 50).map((client, index) => \`
                  <tr class="hover:bg-gray-50">
                    <td class="px-4 py-2 text-sm border">\${index + 1}</td>
                    <td class="px-4 py-2 text-sm border font-medium">\${client.name || '-'}</td>
                    <td class="px-4 py-2 text-sm border">\${client.phone || '-'}</td>
                    <td class="px-4 py-2 text-sm border">\${client.wechat || '-'}</td>
                    <td class="px-4 py-2 text-sm border">\${client.source || '-'}</td>
                    <td class="px-4 py-2 text-sm border">\${client.stage || 'new_lead'}</td>
                  </tr>
                \`).join('')}
                \${clients.length > 50 ? \`
                  <tr>
                    <td colspan="6" class="px-4 py-2 text-center text-sm text-gray-500 border">
                      ... 还有 \${clients.length - 50} 条数据
                    </td>
                  </tr>
                \` : ''}
              </tbody>
            </table>
          </div>
          
          <div id="importProgress" class="hidden mb-4">
            <div class="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div class="flex items-center justify-between mb-2">
                <span class="text-sm font-medium text-blue-900">正在导入...</span>
                <span id="progressText" class="text-sm text-blue-700">0%</span>
              </div>
              <div class="w-full bg-blue-200 rounded-full h-2">
                <div id="progressBar" class="bg-blue-600 h-2 rounded-full transition-all" style="width: 0%"></div>
              </div>
            </div>
          </div>
          
          <div class="flex space-x-3">
            <button 
              id="confirmImportBtn"
              onclick="confirmImport(\${JSON.stringify(clients).replace(/"/g, '&quot;')})" 
              class="flex-1 bg-green-600 text-white px-6 py-3 rounded-lg hover:bg-green-700 font-medium"
            >
              <i class="fas fa-check mr-2"></i>确认导入 (\${clients.length} 条)
            </button>
            <button 
              onclick="closePreviewModal(); showImportModal();" 
              class="px-6 py-3 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400"
            >
              返回修改
            </button>
          </div>
        </div>
      \`;
      
      document.body.appendChild(modal);
    }
    
    // 关闭预览模态框
    function closePreviewModal() {
      const modal = document.getElementById('previewModal');
      if (modal) {
        modal.remove();
      }
    }
    
    // 确认导入
    async function confirmImport(clients) {
      const progressDiv = document.getElementById('importProgress');
      const progressBar = document.getElementById('progressBar');
      const progressText = document.getElementById('progressText');
      const confirmBtn = document.getElementById('confirmImportBtn');
      
      if (progressDiv) progressDiv.classList.remove('hidden');
      if (confirmBtn) confirmBtn.disabled = true;
      
      try {
        const res = await axios.post('/api/clients/batch-import', {
          clients: clients,
          userId: currentUser.id
        });
        
        if (progressBar) progressBar.style.width = '100%';
        if (progressText) progressText.textContent = '100%';
        
        if (res.data.success) {
          const results = res.data.results;
          
          let message = \`导入完成！\\n\\n\`;
          message += \`总数：\${results.total}\\n\`;
          message += \`成功：\${results.success}\\n\`;
          message += \`失败：\${results.failed}\\n\`;
          
          if (results.errors.length > 0) {
            message += \`\\n失败详情：\\n\`;
            results.errors.slice(0, 5).forEach(err => {
              message += \`第\${err.row}行: \${err.error}\\n\`;
            });
            if (results.errors.length > 5) {
              message += \`... 还有 \${results.errors.length - 5} 个错误\`;
            }
          }
          
          alert(message);
          closePreviewModal();
          await showView('kanban');
        } else {
          alert('导入失败：' + res.data.error);
        }
      } catch (error) {
        alert('导入失败：' + error.message);
      } finally {
        if (confirmBtn) confirmBtn.disabled = false;
      }
    }

    // ============================================
    // 团队管理功能
    // ============================================
    
    let teamData = [];
    let leaderboardData = [];
    
    // 渲染团队管理页面
    async function renderTeamManagement() {
      const content = document.getElementById('mainContent');
      
      try {
        // 获取团队成员
        const membersRes = await axios.get('/api/team/members');
        teamData = membersRes.data.members;
        
        // 获取排行榜数据（默认本月）
        const leaderboardRes = await axios.get('/api/team/leaderboard?period=month');
        leaderboardData = leaderboardRes.data.leaderboard;
        
        const html = \`
          <div class="mb-6">
            <h2 class="text-2xl font-bold text-gray-900">团队管理</h2>
            <p class="text-gray-600 mt-1">团队成员业绩概览与KPI对比</p>
          </div>
          
          <!-- 排行榜 -->
          <div class="bg-gradient-to-r from-yellow-400 via-yellow-500 to-yellow-600 rounded-lg shadow-lg p-6 mb-8 text-white">
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-xl font-bold">
                <i class="fas fa-trophy mr-2"></i>本月业绩排行榜
              </h3>
              <div class="flex space-x-2">
                <button onclick="updateLeaderboard('week')" class="px-3 py-1 bg-white bg-opacity-20 rounded hover:bg-opacity-30 text-sm">
                  本周
                </button>
                <button onclick="updateLeaderboard('month')" class="px-3 py-1 bg-white bg-opacity-40 rounded text-sm">
                  本月
                </button>
                <button onclick="updateLeaderboard('quarter')" class="px-3 py-1 bg-white bg-opacity-20 rounded hover:bg-opacity-30 text-sm">
                  本季度
                </button>
              </div>
            </div>
            
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
              \${leaderboardData.slice(0, 3).map((member, index) => {
                const medals = ['🥇', '🥈', '🥉'];
                const colors = ['from-yellow-300', 'from-gray-300', 'from-orange-300'];
                return \`
                  <div class="bg-gradient-to-br \${colors[index]} to-transparent rounded-lg p-4 text-gray-900">
                    <div class="flex items-center space-x-3 mb-3">
                      <span class="text-4xl">\${medals[index]}</span>
                      <div>
                        <p class="font-bold text-lg">\${member.name}</p>
                        <p class="text-sm opacity-80">第\${index + 1}名</p>
                      </div>
                    </div>
                    <div class="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <p class="opacity-70">入金客户</p>
                        <p class="font-bold text-lg">\${member.total_deposited || 0}</p>
                      </div>
                      <div>
                        <p class="opacity-70">总转化</p>
                        <p class="font-bold text-lg">\${member.total_conversions || 0}</p>
                      </div>
                      <div>
                        <p class="opacity-70">新客户</p>
                        <p class="font-bold">\${member.total_new_leads || 0}</p>
                      </div>
                      <div>
                        <p class="opacity-70">互动次数</p>
                        <p class="font-bold">\${member.total_interactions || 0}</p>
                      </div>
                    </div>
                  </div>
                \`;
              }).join('')}
            </div>
            
            \${leaderboardData.length > 3 ? \`
              <div class="mt-4 bg-white bg-opacity-10 rounded-lg p-3">
                <div class="grid grid-cols-1 gap-2 text-sm">
                  \${leaderboardData.slice(3).map((member, index) => \`
                    <div class="flex items-center justify-between">
                      <div class="flex items-center space-x-3">
                        <span class="font-bold text-lg w-6">\${index + 4}</span>
                        <span class="font-medium">\${member.name}</span>
                      </div>
                      <div class="flex space-x-4 text-xs">
                        <span>入金: \${member.total_deposited || 0}</span>
                        <span>转化: \${member.total_conversions || 0}</span>
                        <span>新客: \${member.total_new_leads || 0}</span>
                      </div>
                    </div>
                  \`).join('')}
                </div>
              </div>
            \` : ''}
          </div>
          
          <!-- 成员列表 -->
          <div class="bg-white rounded-lg shadow-sm p-6">
            <h3 class="text-xl font-bold text-gray-900 mb-4">
              <i class="fas fa-users mr-2"></i>团队成员列表
            </h3>
            
            <div class="overflow-x-auto">
              <table class="w-full">
                <thead class="bg-gray-50">
                  <tr>
                    <th class="px-4 py-3 text-left text-sm font-semibold text-gray-700">成员</th>
                    <th class="px-4 py-3 text-left text-sm font-semibold text-gray-700">角色</th>
                    <th class="px-4 py-3 text-center text-sm font-semibold text-gray-700">客户总数</th>
                    <th class="px-4 py-3 text-center text-sm font-semibold text-gray-700">已入金</th>
                    <th class="px-4 py-3 text-center text-sm font-semibold text-gray-700">互动次数</th>
                    <th class="px-4 py-3 text-center text-sm font-semibold text-gray-700">加入时间</th>
                    <th class="px-4 py-3 text-center text-sm font-semibold text-gray-700">操作</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-200">
                  \${teamData.map(member => \`
                    <tr class="hover:bg-gray-50">
                      <td class="px-4 py-3">
                        <div class="flex items-center space-x-3">
                          <div class="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
                            <i class="fas fa-user text-blue-600"></i>
                          </div>
                          <div>
                            <p class="font-medium text-gray-900">\${member.name}</p>
                            <p class="text-sm text-gray-500">\${member.email}</p>
                          </div>
                        </div>
                      </td>
                      <td class="px-4 py-3">
                        <span class="px-2 py-1 rounded-full text-xs font-medium \${
                          member.role === 'team_lead' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
                        }">
                          \${member.role === 'team_lead' ? '团队主管' : '销售'}
                        </span>
                      </td>
                      <td class="px-4 py-3 text-center font-medium text-gray-900">\${member.total_clients || 0}</td>
                      <td class="px-4 py-3 text-center">
                        <span class="font-bold text-green-600">\${member.deposited_clients || 0}</span>
                      </td>
                      <td class="px-4 py-3 text-center text-gray-700">\${member.total_interactions || 0}</td>
                      <td class="px-4 py-3 text-center text-sm text-gray-500">
                        \${new Date(member.created_at).toLocaleDateString()}
                      </td>
                      <td class="px-4 py-3 text-center">
                        <button 
                          onclick="viewMemberKPI(\${member.id}, '\${member.name}')" 
                          class="text-blue-600 hover:text-blue-800"
                          title="查看详细KPI"
                        >
                          <i class="fas fa-chart-line"></i>
                        </button>
                      </td>
                    </tr>
                  \`).join('')}
                </tbody>
              </table>
            </div>
          </div>
        \`;
        
        content.innerHTML = html;
        
      } catch (error) {
        console.error('加载团队数据失败:', error);
        content.innerHTML = '<div class="text-center py-20 text-red-600">加载失败</div>';
      }
    }
    
    // 更新排行榜数据
    async function updateLeaderboard(period) {
      try {
        const res = await axios.get(\`/api/team/leaderboard?period=\${period}\`);
        leaderboardData = res.data.leaderboard;
        await renderTeamManagement();
      } catch (error) {
        alert('更新失败：' + error.message);
      }
    }
    
    // 查看成员KPI详情
    async function viewMemberKPI(memberId, memberName) {
      try {
        const res = await axios.get(\`/api/team/members/\${memberId}/kpi?days=30\`);
        const kpi = res.data.kpi;
        
        const modal = document.createElement('div');
        modal.id = 'memberKPIModal';
        modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
        modal.innerHTML = \`
          <div class="bg-white rounded-lg p-8 max-w-4xl w-full max-h-[90vh] overflow-y-auto">
            <div class="flex items-center justify-between mb-6">
              <h2 class="text-2xl font-bold text-gray-900">
                <i class="fas fa-chart-bar mr-2 text-blue-600"></i>
                \${memberName} - KPI详情（最近30天）
              </h2>
              <button onclick="closeMemberKPIModal()" class="text-gray-500 hover:text-gray-700">
                <i class="fas fa-times text-2xl"></i>
              </button>
            </div>
            
            <!-- KPI卡片 -->
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div class="bg-blue-50 rounded-lg p-4">
                <p class="text-sm text-blue-600 mb-1">客户总数</p>
                <p class="text-3xl font-bold text-blue-900">\${kpi.total_clients || 0}</p>
              </div>
              <div class="bg-green-50 rounded-lg p-4">
                <p class="text-sm text-green-600 mb-1">已入金</p>
                <p class="text-3xl font-bold text-green-900">\${kpi.deposited || 0}</p>
              </div>
              <div class="bg-purple-50 rounded-lg p-4">
                <p class="text-sm text-purple-600 mb-1">高意向客户</p>
                <p class="text-3xl font-bold text-purple-900">\${kpi.high_intents || 0}</p>
              </div>
              <div class="bg-orange-50 rounded-lg p-4">
                <p class="text-sm text-orange-600 mb-1">新客户</p>
                <p class="text-3xl font-bold text-orange-900">\${kpi.new_clients_period || 0}</p>
              </div>
            </div>
            
            <!-- 互动数据 -->
            <div class="bg-gray-50 rounded-lg p-6 mb-6">
              <h3 class="font-bold text-gray-900 mb-4">互动数据</h3>
              <div class="grid grid-cols-2 gap-4">
                <div>
                  <p class="text-sm text-gray-600">总互动次数</p>
                  <p class="text-2xl font-bold text-blue-600">\${kpi.total_interactions || 0}</p>
                </div>
                <div>
                  <p class="text-sm text-gray-600">日均互动次数</p>
                  <p class="text-2xl font-bold text-blue-600">\${(kpi.avg_daily_interactions || 0).toFixed(1)}</p>
                </div>
              </div>
            </div>
            
            <!-- 战报数据 -->
            <div class="bg-gray-50 rounded-lg p-6 mb-6">
              <h3 class="font-bold text-gray-900 mb-4">战报统计</h3>
              <div class="grid grid-cols-3 gap-4">
                <div>
                  <p class="text-sm text-gray-600">提交天数</p>
                  <p class="text-2xl font-bold text-green-600">\${kpi.total_reports || 0}</p>
                </div>
                <div>
                  <p class="text-sm text-gray-600">累计新客</p>
                  <p class="text-2xl font-bold text-purple-600">\${kpi.sum_new_leads || 0}</p>
                </div>
                <div>
                  <p class="text-sm text-gray-600">累计转化</p>
                  <p class="text-2xl font-bold text-orange-600">\${kpi.sum_conversions || 0}</p>
                </div>
              </div>
            </div>
            
            <!-- 话术数据 -->
            <div class="bg-gray-50 rounded-lg p-6">
              <h3 class="font-bold text-gray-900 mb-4">话术智库</h3>
              <div>
                <p class="text-sm text-gray-600">创建话术数</p>
                <p class="text-2xl font-bold text-blue-600">\${kpi.total_scripts || 0}</p>
              </div>
            </div>
            
            <div class="mt-6">
              <button 
                onclick="closeMemberKPIModal()" 
                class="w-full bg-gray-300 text-gray-700 px-6 py-3 rounded-lg hover:bg-gray-400"
              >
                关闭
              </button>
            </div>
          </div>
        \`;
        
        document.body.appendChild(modal);
        
      } catch (error) {
        alert('加载KPI失败：' + error.message);
      }
    }
    
    // 关闭成员KPI模态框
    function closeMemberKPIModal() {
      const modal = document.getElementById('memberKPIModal');
      if (modal) {
        modal.remove();
      }
    }

    // ============================================
    // 自动提醒系统功能
    // ============================================
    
    let alertsData = [];
    let unreadCount = 0;
    
    // 加载提醒数据
    async function loadAlerts(unreadOnly = false) {
      try {
        const res = await axios.get(\`/api/alerts?user_id=\${currentUser.id}&unread_only=\${unreadOnly}\`);
        if (res.data.success) {
          alertsData = res.data.alerts;
          updateAlertsBadge();
        }
      } catch (error) {
        console.error('加载提醒失败:', error);
      }
    }
    
    // 更新提醒徽章
    function updateAlertsBadge() {
      unreadCount = alertsData.filter(a => a.is_read === 0).length;
      const badge = document.getElementById('alertsBadge');
      if (badge) {
        if (unreadCount > 0) {
          badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
          badge.classList.remove('hidden');
        } else {
          badge.classList.add('hidden');
        }
      }
    }
    
    // 检测超期客户并创建提醒
    async function checkOverdueClients() {
      try {
        const res = await axios.post(\`/api/alerts/check-overdue?user_id=\${currentUser.id}\`);
        if (res.data.success && res.data.created > 0) {
          console.log(\`创建了 \${res.data.created} 条新提醒\`);
          await loadAlerts();
        }
      } catch (error) {
        console.error('检测超期客户失败:', error);
      }
    }
    
    // 显示提醒面板
    async function showAlertsPanel() {
      await loadAlerts();
      
      const panel = document.createElement('div');
      panel.id = 'alertsPanel';
      panel.className = 'fixed right-4 top-20 w-96 bg-white rounded-lg shadow-2xl z-50 max-h-[80vh] flex flex-col';
      panel.innerHTML = \`
        <div class="p-4 border-b flex items-center justify-between bg-blue-50">
          <h3 class="text-lg font-bold text-gray-900">
            <i class="fas fa-bell mr-2 text-blue-600"></i>
            系统提醒
            <span class="ml-2 text-sm text-gray-600">(\${unreadCount} 未读)</span>
          </h3>
          <div class="flex items-center space-x-2">
            <button onclick="markAllRead()" class="text-sm text-blue-600 hover:underline">
              全部标记已读
            </button>
            <button onclick="closeAlertsPanel()" class="text-gray-500 hover:text-gray-700">
              <i class="fas fa-times"></i>
            </button>
          </div>
        </div>
        
        <div class="overflow-y-auto flex-1">
          \${alertsData.length === 0 ? \`
            <div class="p-8 text-center text-gray-500">
              <i class="fas fa-inbox text-4xl mb-4"></i>
              <p>暂无提醒</p>
            </div>
          \` : alertsData.map(alert => \`
            <div class="p-4 border-b hover:bg-gray-50 cursor-pointer \${alert.is_read === 0 ? 'bg-blue-50' : ''}" onclick="handleAlertClick(\${alert.id}, \${alert.client_id})">
              <div class="flex items-start justify-between">
                <div class="flex-1">
                  <div class="flex items-center mb-2">
                    <span class="\${getPriorityClass(alert.priority)} px-2 py-1 rounded text-xs font-medium mr-2">
                      \${getPriorityText(alert.priority)}
                    </span>
                    <span class="text-xs text-gray-500">
                      \${getAlertTypeIcon(alert.alert_type)} \${getAlertTypeText(alert.alert_type)}
                    </span>
                  </div>
                  <p class="text-sm text-gray-900 mb-1">\${alert.message}</p>
                  <div class="flex items-center text-xs text-gray-500">
                    <i class="fas fa-clock mr-1"></i>
                    \${formatTime(alert.created_at)}
                    \${alert.client_name ? \` · <i class="fas fa-user ml-2 mr-1"></i>\${alert.client_name}\` : ''}
                  </div>
                </div>
                <button onclick="event.stopPropagation(); deleteAlert(\${alert.id})" class="text-gray-400 hover:text-red-600 ml-2">
                  <i class="fas fa-trash text-sm"></i>
                </button>
              </div>
            </div>
          \`).join('')}
        </div>
        
        <div class="p-4 border-t bg-gray-50">
          <button onclick="refreshAlerts()" class="w-full bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700">
            <i class="fas fa-sync-alt mr-2"></i>刷新提醒
          </button>
        </div>
      \`;
      
      document.body.appendChild(panel);
      
      // 点击外部关闭
      setTimeout(() => {
        document.addEventListener('click', function closeOnClickOutside(e) {
          const panel = document.getElementById('alertsPanel');
          if (panel && !panel.contains(e.target) && !e.target.closest('button[onclick*="showAlertsPanel"]')) {
            closeAlertsPanel();
            document.removeEventListener('click', closeOnClickOutside);
          }
        });
      }, 100);
    }
    
    // 关闭提醒面板
    function closeAlertsPanel() {
      const panel = document.getElementById('alertsPanel');
      if (panel) {
        panel.remove();
      }
    }
    
    // 处理提醒点击
    async function handleAlertClick(alertId, clientId) {
      // 标记为已读
      await axios.put(\`/api/alerts/\${alertId}/read\`);
      await loadAlerts();
      closeAlertsPanel();
      
      // 如果有关联客户，跳转到客户详情
      if (clientId) {
        showClientDetail(clientId);
      }
    }
    
    // 标记所有为已读
    async function markAllRead() {
      try {
        await axios.post(\`/api/alerts/mark-all-read?user_id=\${currentUser.id}\`);
        await loadAlerts();
        closeAlertsPanel();
        showAlertsPanel();
      } catch (error) {
        alert('操作失败：' + error.message);
      }
    }
    
    // 删除提醒
    async function deleteAlert(alertId) {
      if (!confirm('确定删除这条提醒吗？')) return;
      
      try {
        await axios.delete(\`/api/alerts/\${alertId}\`);
        await loadAlerts();
        closeAlertsPanel();
        showAlertsPanel();
      } catch (error) {
        alert('删除失败：' + error.message);
      }
    }
    
    // 刷新提醒
    async function refreshAlerts() {
      await checkOverdueClients();
      await loadAlerts();
      closeAlertsPanel();
      showAlertsPanel();
    }
    
    // 辅助函数
    function getPriorityClass(priority) {
      const classes = {
        high: 'bg-red-100 text-red-700',
        medium: 'bg-yellow-100 text-yellow-700',
        low: 'bg-gray-100 text-gray-700'
      };
      return classes[priority] || classes.medium;
    }
    
    function getPriorityText(priority) {
      const texts = { high: '高优先级', medium: '中优先级', low: '低优先级' };
      return texts[priority] || '中优先级';
    }
    
    function getAlertTypeIcon(type) {
      const icons = {
        interaction_overdue: '<i class="fas fa-clock text-red-600"></i>',
        high_opportunity: '<i class="fas fa-star text-yellow-600"></i>',
        high_risk: '<i class="fas fa-exclamation-triangle text-orange-600"></i>',
        stage_stuck: '<i class="fas fa-pause-circle text-gray-600"></i>'
      };
      return icons[type] || '<i class="fas fa-info-circle"></i>';
    }
    
    function getAlertTypeText(type) {
      const texts = {
        interaction_overdue: '超期未互动',
        high_opportunity: '高机会客户',
        high_risk: '高风险客户',
        stage_stuck: '阶段停滞'
      };
      return texts[type] || '系统提醒';
    }
    
    function formatTime(datetime) {
      if (!datetime) return '';
      const date = new Date(datetime);
      const now = new Date();
      const diff = (now - date) / 1000; // 秒
      
      if (diff < 60) return '刚刚';
      if (diff < 3600) return \`\${Math.floor(diff / 60)}分钟前\`;
      if (diff < 86400) return \`\${Math.floor(diff / 3600)}小时前\`;
      if (diff < 604800) return \`\${Math.floor(diff / 86400)}天前\`;
      
      return date.toLocaleDateString('zh-CN');
    }
    
    // 自动检测提醒（每10分钟）
    setInterval(() => {
      checkOverdueClients();
      loadAlerts();
    }, 10 * 60 * 1000);
    
    // 初始化时检测一次
    setTimeout(() => {
      checkOverdueClients();
      loadAlerts();
    }, 2000);

    // ============================================
    // 温度自动计算功能
    // ============================================
    
    // 重新计算单个客户温度
    async function recalculateTemperature(clientId) {
      try {
        const res = await axios.post(\`/api/temperature/update/\${clientId}\`);
        
        if (res.data.success) {
          const temp = res.data.temperature;
          
          // 显示详细信息
          const details = \`
温度计算完成！

新温度评分：\${temp.score}/100
温度等级：\${getTempLevelText(temp.level)}

计算详情：
━━━━━━━━━━━━━━━━━━━━━
🎯 阶段评分：\${temp.details.stageScore} 分
💬 互动次数：\${temp.details.interactionCount} 次
⏰ 距上次互动：\${temp.details.hoursSinceInteraction || '未知'} 小时
😊 正向情绪：\${temp.details.positiveCount} 次
😟 负向情绪：\${temp.details.negativeCount} 次

温度算法说明：
基础分50分 +
阶段评分(0-25) +
互动频率(0-25) +
最近互动(-20至+15) +
情绪评分(-10至+10)
          \`;
          
          alert(details);
          
          // 刷新客户详情页面
          showClientDetail(clientId);
        } else {
          alert('计算失败：' + res.data.error);
        }
      } catch (error) {
        alert('计算失败：' + error.message);
      }
    }
    
    // 批量更新所有客户温度
    async function updateAllTemperatures() {
      if (!confirm('确定要重新计算所有客户的温度吗？这可能需要一些时间。')) {
        return;
      }
      
      try {
        const res = await axios.post(\`/api/temperature/update-all?user_id=\${currentUser.id}\`);
        
        if (res.data.success) {
          alert(\`温度计算完成！\\n\\n总计：\${res.data.total} 个客户\\n已更新：\${res.data.updated} 个客户\`);
          
          // 刷新当前视图
          const currentView = document.querySelector('[onclick*="showView"]')?.getAttribute('onclick')?.match(/'(\w+)'/)?.[1];
          if (currentView) {
            showView(currentView);
          }
        } else {
          alert('计算失败：' + res.data.error);
        }
      } catch (error) {
        alert('计算失败：' + error.message);
      }
    }
    
    function getTempLevelText(level) {
      const texts = {
        hot: '🔥 热（80-100）',
        warm: '🌤️ 温（60-79）',
        neutral: '☁️ 中性（40-59）',
        cold: '❄️ 冷（0-39）'
      };
      return texts[level] || level;
    }
    
    // 每日自动计算温度（每天凌晨2点）
    function scheduleTemperatureUpdate() {
      const now = new Date();
      const night = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        2, 0, 0, 0
      );
      const msToMidnight = night.getTime() - now.getTime();
      
      setTimeout(() => {
        updateAllTemperatures();
        setInterval(updateAllTemperatures, 24 * 60 * 60 * 1000); // 每24小时
      }, msToMidnight);
    }
    
    // 启动定时任务
    scheduleTemperatureUpdate();

    // ============================================
    // 风险/机会自动识别功能
    // ============================================
    
    // 批量评估所有客户
    async function assessAllRiskOpportunity() {
      if (!confirm('确定要重新评估所有客户的风险和机会吗？这可能需要一些时间。')) {
        return;
      }
      
      try {
        const res = await axios.post(\`/api/risk-opportunity/assess-all?user_id=\${currentUser.id}\`);
        
        if (res.data.success) {
          const message = \`
评估完成！

总计：\${res.data.total} 个客户
━━━━━━━━━━━━━━━━━━━━━
⭐ 高机会客户：\${res.data.opportunityCount} 个
⚠️  高风险客户：\${res.data.riskCount} 个

高机会识别条件：
- 温度评分 ≥ 80分
- 处于高转化阶段
- 近7天互动 ≥ 5次
- 正向情绪占比 > 80%

高风险识别条件：
- 温度评分 < 40分
- 48小时未互动
- 阶段停滞 > 7天
- 负向情绪占比 > 50%
- 互动频率下降 > 50%
          \`;
          
          alert(message);
          
          // 刷新当前视图
          showView('dashboard');
        } else {
          alert('评估失败：' + res.data.error);
        }
      } catch (error) {
        alert('评估失败：' + error.message);
      }
    }
    
    // 评估单个客户
    async function assessClientRiskOpportunity(clientId) {
      try {
        const res = await axios.post(\`/api/risk-opportunity/assess/\${clientId}\`);
        
        if (res.data.success) {
          const assessment = res.data.assessment;
          
          let message = '客户风险/机会评估完成！\\n\\n';
          
          if (assessment.isHighOpportunity) {
            message += '⭐ 高机会客户\\n';
            message += '原因：\\n';
            assessment.opportunityReasons.forEach(reason => {
              message += \`  • \${reason}\\n\`;
            });
            message += '\\n';
          }
          
          if (assessment.isHighRisk) {
            message += '⚠️ 高风险客户\\n';
            message += '原因：\\n';
            assessment.riskReasons.forEach(reason => {
              message += \`  • \${reason}\\n\`;
            });
          }
          
          if (!assessment.isHighOpportunity && !assessment.isHighRisk) {
            message += '✅ 正常客户（无特殊风险或机会）';
          }
          
          alert(message);
          
          // 刷新客户详情
          showClientDetail(clientId);
        } else {
          alert('评估失败：' + res.data.error);
        }
      } catch (error) {
        alert('评估失败：' + error.message);
      }
    }
    
    // 每日自动评估（每天凌晨3点）
    function scheduleRiskOpportunityAssessment() {
      const now = new Date();
      const night = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        3, 0, 0, 0
      );
      const msToMidnight = night.getTime() - now.getTime();
      
      setTimeout(() => {
        assessAllRiskOpportunity();
        setInterval(assessAllRiskOpportunity, 24 * 60 * 60 * 1000);
      }, msToMidnight);
    }
    
    // 启动定时任务
    scheduleRiskOpportunityAssessment();

    // ============================================
    // 拖拽式看板功能
    // ============================================
    
    let draggedClientId = null;
    let draggedClientName = null;
    let draggedFromStage = null;
    
    // 开始拖拽
    function handleDragStart(e) {
      const card = e.target.closest('.client-card');
      if (!card) return;
      
      draggedClientId = parseInt(card.dataset.clientId);
      draggedClientName = card.dataset.clientName;
      draggedFromStage = card.dataset.currentStage;
      
      // 添加拖拽样式
      card.classList.add('opacity-50');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/html', card.innerHTML);
    }
    
    // 拖拽结束
    function handleDragEnd(e) {
      const card = e.target.closest('.client-card');
      if (card) {
        card.classList.remove('opacity-50');
      }
      
      // 清除所有 over 样式
      document.querySelectorAll('.stage-column > div > div').forEach(col => {
        col.classList.remove('bg-blue-50', 'border-blue-300', 'border-2', 'border-dashed');
      });
    }
    
    // 拖拽进入目标区域
    function handleDragEnter(e) {
      e.preventDefault();
      const dropZone = e.target.closest('[data-stage]');
      if (dropZone) {
        dropZone.classList.add('bg-blue-50', 'border-blue-300', 'border-2', 'border-dashed');
      }
    }
    
    // 拖拽离开目标区域
    function handleDragLeave(e) {
      const dropZone = e.target.closest('[data-stage]');
      if (dropZone && !dropZone.contains(e.relatedTarget)) {
        dropZone.classList.remove('bg-blue-50', 'border-blue-300', 'border-2', 'border-dashed');
      }
    }
    
    // 在目标区域上方拖拽
    function handleDragOver(e) {
      e.preventDefault();
      e.dataTransfer.dropOver = 'move';
    }
    
    // 放下到目标区域
    async function handleDrop(e) {
      e.preventDefault();
      e.stopPropagation();
      
      const dropZone = e.target.closest('[data-stage]');
      if (!dropZone) return;
      
      const newStage = dropZone.dataset.stage;
      
      // 清除高亮
      dropZone.classList.remove('bg-blue-50', 'border-blue-300', 'border-2', 'border-dashed');
      
      // 如果是同一阶段，不执行任何操作
      if (newStage === draggedFromStage) {
        return;
      }
      
      const stageNames = {
        'new_lead': '新接粉',
        'initial_contact': '初步破冰',
        'nurturing': '深度培育',
        'high_intent': '高意向',
        'joined_group': '已进群',
        'opened_account': '已开户',
        'deposited': '已入金'
      };
      
      // 确认更新
      if (!confirm(\`确定将客户「\${draggedClientName}」从「\${stageNames[draggedFromStage]}」移动到「\${stageNames[newStage]}」吗？\`)) {
        return;
      }
      
      try {
        // 更新阶段
        const res = await axios.put(\`/api/clients/\${draggedClientId}/stage\`, {
          stage: newStage,
          userId: currentUser.id
        });
        
        if (res.data.success) {
          // 刷新看板
          await loadClients();
          renderKanban();
          
          // 显示成功提示
          showToast(\`✅ 客户「\${draggedClientName}」已移动到「\${stageNames[newStage]}」\`, 'success');
        } else {
          alert('更新失败：' + res.data.error);
        }
      } catch (error) {
        alert('更新失败：' + error.message);
      }
    }
    
    // Toast 提示
    function showToast(message, type = 'info') {
      const colors = {
        success: 'bg-green-500',
        error: 'bg-red-500',
        info: 'bg-blue-500'
      };
      
      const toast = document.createElement('div');
      toast.className = \`fixed bottom-8 right-8 \${colors[type]} text-white px-6 py-3 rounded-lg shadow-lg z-50 transition-opacity duration-300\`;
      toast.textContent = message;
      
      document.body.appendChild(toast);
      
      setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
      }, 3000);
    }

    // 启动应用
    initApp();
  </script>
</body>
</html>
  `);
});

export default app;
