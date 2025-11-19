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
          <button onclick="showView('dashboard')" class="px-4 py-2 text-gray-700 hover:text-blue-600">
            <i class="fas fa-chart-line mr-2"></i>仪表盘
          </button>
          <button onclick="showView('kanban')" class="px-4 py-2 text-gray-700 hover:text-blue-600">
            <i class="fas fa-columns mr-2"></i>客户看板
          </button>
          <button onclick="showNewClientModal()" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            <i class="fas fa-plus mr-2"></i>新增客户
          </button>
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

  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script>
    let clientsData = [];
    let tagsData = [];

    // 初始化
    async function initApp() {
      try {
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
        <div class="mb-6">
          <h2 class="text-2xl font-bold text-gray-900">数据仪表盘</h2>
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

    // 添加标签（简化版）
    async function showAddTagModal(clientId) {
      alert('标签管理功能开发中...');
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

    // 启动应用
    initApp();
  </script>
</body>
</html>
  `);
});

export default app;
