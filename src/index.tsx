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

// 获取所有客户（按阶段分组）
app.get('/api/clients', async (c) => {
  const { DB } = c.env;
  const userId = c.req.query('user_id') || '2'; // MVP 阶段默认用户
  
  const clients = await DB.prepare(`
    SELECT * FROM clients 
    WHERE user_id = ? AND is_archived = 0
    ORDER BY stage, last_interaction_at DESC
  `).bind(userId).all();
  
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

      const html = \`
        <div class="mb-6">
          <h2 class="text-2xl font-bold text-gray-900">客户看板</h2>
          <p class="text-gray-600 mt-2">拖拽客户卡片到不同阶段，或点击查看详情</p>
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
      alert('客户详情页功能开发中...');
      // TODO: 实现客户详情页
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
