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
          <button onclick="showTagsManagement()" class="px-4 py-2 text-gray-700 hover:text-blue-600 transition">
            <i class="fas fa-tags mr-2"></i>标签管理
          </button>
          <button onclick="showNewClientModal()" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">
            <i class="fas fa-plus mr-2"></i>新增客户
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
                  <div class="space-y-3">
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
        <div class="client-card \${tempClass} bg-white border rounded-lg p-3 cursor-pointer" 
             onclick="viewClientDetail(\${client.id})">
          <div class="flex items-start justify-between mb-2">
            <h3 class="font-semibold text-gray-900">\${client.name}</h3>
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
          <button 
            onclick="showView('reports')" 
            class="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium"
          >
            <i class="fas fa-file-alt mr-2"></i>查看每日战报
          </button>
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
              <div class="mt-4 flex items-center justify-between">
                <span class="text-sm text-gray-600">温度评分</span>
                <span class="text-2xl font-bold text-blue-600">\${client.temperature_score}/100</span>
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

    // 启动应用
    initApp();
  </script>
</body>
</html>
  `);
});

export default app;
