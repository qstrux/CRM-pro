# CRM 高信任关系销售系统

> 专为高信任关系型销售团队打造的智能 CRM 系统

## 🎯 项目概述

这是一个专门为**高净值客户关系管理**和**投资顾问团队**设计的 CRM 系统。系统通过可视化看板、智能提醒、客户画像和互动日志等功能，帮助销售团队：

1. **更快识别高价值客户** - 通过温度评分和机会识别
2. **更聪明推动客户转化** - 7 阶段销售漏斗自动监测
3. **让新人快速上手** - 话术智库和 SOP 流程化

---

## 🚀 当前已完成功能（MVP v0.1）

### ✅ 核心功能模块

#### 1. 📊 Dashboard 仪表盘
- [x] 实时 KPI 展示（今日互动、高机会客户、风险客户、总客户数）
- [x] 销售漏斗可视化
- [x] 阶段分布统计
- [x] 温度分布统计

#### 2. 📋 客户看板（Kanban Board）
- [x] 7 个销售阶段列展示
  - 新接粉 → 初步破冰 → 深度培育 → 高意向 → 已进群 → 已开户 → 已入金
- [x] 客户卡片展示（姓名、来源、温度、微信）
- [x] 温度可视化（热🔥/温🌤️/中性☁️/冷❄️）
- [x] 点击查看详情

#### 3. 👤 客户详情页（完整作战室）

**左侧：客户画像**
- [x] 基本信息（姓名、电话、微信、邮箱、来源）
- [x] 当前阶段选择器（可直接切换）
- [x] 温度评分显示
- [x] 标签系统（显示/移除）
- [x] 五维客户画像
  - 兴趣点
  - 性格特征
  - 稀缺品质
  - 行为习惯
  - 投资画像

**右侧：互动 Timeline**
- [x] 新增日志表单（含亮点/挑战/明日目标）
- [x] 日志 Timeline（倒序显示）
- [x] 情绪标记可视化（正向🟢/中性🔵/负向🔴）
- [x] 阶段变更自动记录
- [x] 一键保存所有修改

#### 4. 🗄️ 数据库架构
- [x] 9 张核心表（Users, Clients, Logs, Reports, Scripts, Tags, etc.）
- [x] 完整索引优化
- [x] Cloudflare D1 本地开发支持
- [x] 测试数据自动初始化

#### 5. 🔌 完整 API 接口
- [x] 客户 CRUD（创建/读取/更新/删除）
- [x] 阶段更新（含历史记录）
- [x] 日志管理（创建/列表）
- [x] 标签管理（创建/关联/移除）
- [x] Dashboard 统计数据

---

## 📱 功能演示截图

### 仪表盘
- **KPI 卡片**：今日互动、高机会客户、风险客户、总客户数
- **销售漏斗**：各阶段客户分布与转化率

### 客户看板
- **7 列阶段**：横向滚动看板
- **客户卡片**：温度颜色标识，一键查看详情

### 客户详情
- **左侧**：完整客户画像编辑
- **右侧**：互动日志 Timeline

---

## 🛠️ 技术栈

### 后端
- **Hono** - 轻量级 Web 框架（Cloudflare Workers 优化）
- **Cloudflare D1** - 全球分布式 SQLite 数据库
- **TypeScript** - 类型安全

### 前端
- **Vanilla JavaScript** - 无框架依赖，极致轻量
- **TailwindCSS** - 响应式 UI（CDN）
- **Font Awesome** - 图标库（CDN）
- **Axios** - HTTP 客户端（CDN）

### 部署
- **Cloudflare Pages** - 全球边缘节点部署
- **Wrangler** - CLI 开发工具
- **PM2** - 本地开发进程管理

---

## 📂 项目结构

```
webapp/
├── src/
│   ├── index.tsx              # 主应用入口（API + 前端）
│   ├── db/
│   │   ├── schema.ts          # 数据库 Schema SQL
│   │   └── init.ts            # 数据库初始化逻辑
│   └── types/
│       └── bindings.ts        # Cloudflare 环境类型定义
├── migrations/
│   └── 0001_initial_schema.sql  # 数据库迁移文件
├── seed.sql                   # 测试数据
├── public/                    # 静态资源目录
├── dist/                      # 构建输出（自动生成）
├── .wrangler/                 # 本地开发数据库（自动生成）
├── ecosystem.config.cjs       # PM2 配置
├── wrangler.toml              # Cloudflare 配置
├── vite.config.ts             # Vite 构建配置
├── package.json               # 依赖和脚本
└── README.md                  # 本文档
```

---

## 🚀 快速开始

### 1. 安装依赖
```bash
npm install
```

### 2. 构建项目
```bash
npm run build
```

### 3. 启动本地开发服务器
```bash
# 方式 1：使用 PM2（推荐）
npm run clean-port
pm2 start ecosystem.config.cjs
pm2 logs webapp --nostream

# 方式 2：直接启动
npm run dev:d1
```

### 4. 访问应用
```
http://localhost:3000
```

### 5. 数据库管理
```bash
# 本地数据库操作
npm run db:migrate:local    # 应用迁移
npm run db:seed             # 导入测试数据
npm run db:reset            # 重置数据库
npm run db:console:local    # 打开 SQL 控制台
```

---

## 📊 数据模型概览

### 核心表结构

#### 1. **users** - 团队成员
- 邮箱、密码（bcrypt）、姓名、角色（sales/team_lead/admin）

#### 2. **clients** - 客户主表
- 基本信息（姓名、电话、微信、邮箱）
- 销售状态（阶段、温度评分、温度等级）
- 客户画像（兴趣、性格、行为、投资偏好）
- 风险标识（高机会、高风险）
- 互动追踪（最后互动时间）

#### 3. **client_logs** - 互动日志
- 日志类型（互动/阶段变更/系统提醒/备注）
- 内容、亮点、挑战、明日目标、使用话术
- 情绪标记（positive/neutral/negative）

#### 4. **tags** - 标签库
- 标签名称、颜色、分类

#### 5. **scripts** - 话术智库
- 标题、内容、分类、成功次数、来源客户

#### 6. **daily_reports** - 每日战报
- 各阶段客户数量、互动次数、转化数

#### 7. **system_alerts** - 系统提醒
- 提醒类型、优先级、消息、已读状态

---

## 🌐 公共访问地址

### 开发环境
```
https://3000-ihq45sgs2pt3az2hus31k-a402f90a.sandbox.novita.ai
```

### 生产环境（待部署）
```
待部署到 Cloudflare Pages
```

---

## 🔑 测试账号

**默认登录信息**（MVP 阶段暂无认证）：
- 默认用户 ID：2（张销售）

**测试客户数据**：
- 王先生（高意向，温度 75）
- 刘女士（深度培育，温度 60）
- 张总（新接粉，温度 45）
- 陈先生（已进群，温度 85）
- 李女士（初步破冰，温度 55）

---

## 📋 功能路线图

### MVP v0.1（已完成） ✅
- [x] 数据库设计与初始化
- [x] 客户看板（7 阶段）
- [x] 客户详情页（完整编辑）
- [x] Dashboard 仪表盘
- [x] 互动日志 Timeline
- [x] 标签系统（基础）

### MVP v0.2（开发中） 🔄
- [ ] 用户认证系统（JWT）
- [ ] 每日战报录入
- [ ] 话术智库管理
- [ ] 团队管理页面

### V1.0（规划中） 📅
- [ ] 自动提醒系统（48小时未互动）
- [ ] 温度评分算法（自动计算）
- [ ] 风险/机会自动识别
- [ ] 拖拽式阶段更新
- [ ] 移动端响应式优化

### V2.0（未来规划） 🚀
- [ ] AI 辅助建议（GPT 集成）
- [ ] 话术自动沉淀与推荐
- [ ] 微信集成（企业微信）
- [ ] 数据导出（Excel/CSV）
- [ ] 高级筛选与搜索
- [ ] 权限管理（角色权限）

---

## 🎨 设计理念

### 1. **简洁优先**
- 避免过度设计
- 每个页面只解决一个核心问题
- 3 次点击内完成任何操作

### 2. **数据驱动**
- 所有决策基于可视化数据
- 温度评分让客户状态一目了然
- KPI 实时更新，无需等待

### 3. **流程化**
- 7 阶段强制规范销售流程
- 日志强制记录亮点/挑战/明日目标
- 阶段变更自动记录历史

### 4. **知识沉淀**
- 优秀话术自动识别并入库
- 成功案例永久保存
- 新人可复用老手经验

---

## 🔧 开发命令速查

### 本地开发
```bash
npm run dev:d1          # 启动本地开发服务器（D1 数据库）
npm run build           # 构建生产版本
npm run clean-port      # 清理 3000 端口
npm run test            # 测试服务是否运行
```

### 数据库管理
```bash
npm run db:migrate:local    # 应用迁移（本地）
npm run db:migrate:prod     # 应用迁移（生产）
npm run db:seed             # 导入测试数据
npm run db:reset            # 重置本地数据库
npm run db:console:local    # SQL 控制台（本地）
```

### Git 管理
```bash
npm run git:commit "message"  # 快速提交
npm run git:status            # 查看状态
npm run git:log               # 查看日志
```

### 部署
```bash
npm run deploy          # 部署到 Cloudflare Pages
npm run deploy:prod     # 生产环境部署
```

---

## 📈 性能指标

### 当前性能
- **首次加载**：< 1.5s（含 CDN 资源）
- **API 响应**：< 100ms（本地 D1）
- **页面切换**：< 200ms
- **数据库查询**：< 50ms

### 优化目标
- 首次加载 < 1s
- API 响应 < 50ms
- 支持 1000+ 客户无卡顿

---

## 🤝 贡献指南

### 开发流程
1. Fork 本仓库
2. 创建功能分支（`git checkout -b feature/AmazingFeature`）
3. 提交代码（`git commit -m 'Add some AmazingFeature'`）
4. 推送到分支（`git push origin feature/AmazingFeature`）
5. 提交 Pull Request

### 代码规范
- 使用 TypeScript 类型定义
- 遵循 Prettier 格式化规范
- API 返回统一 JSON 格式 `{ success: boolean, ... }`
- 所有数据库操作使用 Prepared Statements

---

## 📝 更新日志

### v0.1.0 (2025-11-19)
**新增功能：**
- ✨ 初始化项目结构
- ✨ 完整数据库 Schema（9 张表）
- ✨ 客户看板（7 阶段）
- ✨ 客户详情页（左侧画像 + 右侧日志）
- ✨ Dashboard 仪表盘（KPI + 漏斗）
- ✨ 完整 API 接口（CRUD + 统计）
- ✨ 测试数据自动初始化

**技术改进：**
- 🔧 Cloudflare D1 本地开发环境配置
- 🔧 PM2 进程管理配置
- 🔧 Vite 构建优化

---

## 📄 许可证

MIT License - 自由使用和修改

---

## 👨‍💻 作者

**Qstrux**
- 金融科技创业者 & 投资顾问
- 专注于 AI 驱动的财富管理解决方案
- GitHub: [项目链接待添加]

---

## 🙏 致谢

感谢以下开源项目和工具：
- [Hono](https://hono.dev/) - 极致轻量的 Web 框架
- [Cloudflare Workers](https://workers.cloudflare.com/) - 边缘计算平台
- [TailwindCSS](https://tailwindcss.com/) - 现代 CSS 框架
- [Font Awesome](https://fontawesome.com/) - 图标库

---

## 📞 联系方式

如有问题或建议，欢迎联系：
- 📧 Email: [待添加]
- 💬 WeChat: [待添加]
- 🌐 Website: [待添加]

---

**⭐️ 如果这个项目对你有帮助，请给个 Star！**
