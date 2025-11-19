# 🚀 CRM 系统部署指南

## ✅ 已完成的部署

### 生产环境信息

**Cloudflare Pages URL:**
```
https://7e404bd5.crm-high-trust-sales.pages.dev
```

**项目名称:** `crm-high-trust-sales`

**数据库:**
- 名称: `crm-high-trust-sales-db`
- ID: `5b81b16a-1936-44b1-a9a7-c12852fe5b48`
- 区域: ENAM
- 大小: 0.16 MB

**部署状态:** ✅ 成功
**数据库迁移:** ✅ 完成
**测试数据:** ✅ 已导入

---

## 📊 部署统计

- **构建时间:** ~2 秒
- **上传文件:** 1 个（Worker bundle）
- **部署时间:** ~10 秒
- **数据库行数:** 
  - 3 位用户
  - 5 位客户
  - 8 个标签
  - 5 条日志
  - 3 条话术
  - 3 条提醒

---

## 🔧 配置文件

### wrangler.toml
```toml
name = "crm-high-trust-sales"
compatibility_date = "2025-11-19"
pages_build_output_dir = "./dist"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "crm-high-trust-sales-db"
database_id = "5b81b16a-1936-44b1-a9a7-c12852fe5b48"
```

---

## 🌐 访问方式

### 1. 主页（Dashboard）
```
https://7e404bd5.crm-high-trust-sales.pages.dev
```

### 2. API 端点
```
# 数据库状态
GET https://7e404bd5.crm-high-trust-sales.pages.dev/api/db/status

# 客户列表
GET https://7e404bd5.crm-high-trust-sales.pages.dev/api/clients

# Dashboard 数据
GET https://7e404bd5.crm-high-trust-sales.pages.dev/api/dashboard

# 客户详情
GET https://7e404bd5.crm-high-trust-sales.pages.dev/api/clients/{id}

# 标签列表
GET https://7e404bd5.crm-high-trust-sales.pages.dev/api/tags
```

---

## 🔄 更新部署

### 方式 1: 命令行部署
```bash
# 1. 构建
npm run build

# 2. 部署
npx wrangler pages deploy dist --project-name crm-high-trust-sales
```

### 方式 2: 使用快捷命令
```bash
npm run deploy:prod
```

### 方式 3: Git 推送自动部署（需要配置 GitHub）
```bash
git push origin main
# Cloudflare Pages 会自动检测并部署
```

---

## 🗄️ 数据库管理

### 查看数据库信息
```bash
npx wrangler d1 info crm-high-trust-sales-db
```

### 执行 SQL 查询（生产环境）
```bash
# 查询客户数量
npx wrangler d1 execute crm-high-trust-sales-db --remote --command="SELECT COUNT(*) FROM clients"

# 查看所有表
npx wrangler d1 execute crm-high-trust-sales-db --remote --command="SELECT name FROM sqlite_master WHERE type='table'"
```

### 应用新迁移
```bash
# 1. 创建新的迁移文件
# migrations/0002_new_feature.sql

# 2. 应用到生产
npx wrangler d1 migrations apply crm-high-trust-sales-db --remote
```

### 导入数据
```bash
npx wrangler d1 execute crm-high-trust-sales-db --remote --file=./seed.sql
```

---

## 🔐 环境变量和密钥

### 设置密钥（如果需要）
```bash
# 为生产环境设置密钥
npx wrangler pages secret put API_KEY --project-name crm-high-trust-sales

# 列出所有密钥
npx wrangler pages secret list --project-name crm-high-trust-sales
```

### 本地开发环境变量
创建 `.dev.vars` 文件：
```env
API_KEY=your_development_key
```

---

## 📱 自定义域名（可选）

### 添加自定义域名
```bash
npx wrangler pages domain add your-domain.com --project-name crm-high-trust-sales
```

### 验证域名
1. 在 Cloudflare Dashboard 中查看 DNS 记录
2. 添加 CNAME 记录指向 `crm-high-trust-sales.pages.dev`
3. 等待 SSL 证书自动配置

---

## 🐛 故障排查

### 部署失败
```bash
# 查看详细日志
npx wrangler pages deploy dist --project-name crm-high-trust-sales --verbose

# 检查配置
npx wrangler pages project list
```

### 数据库连接问题
```bash
# 验证数据库绑定
npx wrangler d1 list

# 测试数据库连接
npx wrangler d1 execute crm-high-trust-sales-db --remote --command="SELECT 1"
```

### API 500 错误
1. 检查 Cloudflare Dashboard 的 Workers 日志
2. 确认数据库迁移已应用
3. 检查环境变量是否正确设置

---

## 📊 监控和日志

### 查看实时日志
```bash
# Pages Functions 日志
npx wrangler pages deployment tail --project-name crm-high-trust-sales
```

### Cloudflare Dashboard
1. 访问 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 选择账户 → Workers & Pages
3. 找到 `crm-high-trust-sales` 项目
4. 查看 Analytics、Logs 和 Metrics

---

## 🔄 回滚部署

### 查看部署历史
```bash
npx wrangler pages deployment list --project-name crm-high-trust-sales
```

### 回滚到之前的部署
1. 访问 Cloudflare Dashboard
2. 进入项目设置
3. 在 Deployments 中选择旧版本
4. 点击 "Rollback"

---

## 🚀 性能优化建议

### 1. 启用 Cache
在响应中添加缓存头：
```typescript
return c.json(data, {
  headers: {
    'Cache-Control': 'public, max-age=300'
  }
});
```

### 2. 数据库查询优化
- 使用索引
- 避免 N+1 查询
- 使用分页

### 3. 静态资源优化
- 使用 CDN（已启用）
- 压缩 JavaScript 和 CSS
- 图片使用 WebP 格式

---

## 📝 备份策略

### 自动备份
Cloudflare D1 自动备份（保留 30 天）

### 手动导出
```bash
# 导出所有数据
npx wrangler d1 export crm-high-trust-sales-db --remote --output=backup.sql

# 本地保存
cp backup.sql /path/to/safe/location/backup-$(date +%Y%m%d).sql
```

### 恢复数据
```bash
# 从备份恢复
npx wrangler d1 execute crm-high-trust-sales-db --remote --file=backup.sql
```

---

## 🎯 下一步计划

### 短期（1-2 周）
- [ ] 配置 GitHub 自动部署
- [ ] 添加自定义域名
- [ ] 设置监控告警
- [ ] 实现数据自动备份

### 中期（1 个月）
- [ ] 性能优化（缓存策略）
- [ ] 添加错误跟踪（Sentry）
- [ ] 实现 CI/CD 流程
- [ ] 添加 E2E 测试

### 长期（3 个月）
- [ ] 多租户支持
- [ ] 高级分析功能
- [ ] 移动端 App
- [ ] 国际化支持

---

## 📞 支持

遇到问题？

1. **查看日志**: Cloudflare Dashboard → Workers & Pages → Logs
2. **检查文档**: [Cloudflare Pages Docs](https://developers.cloudflare.com/pages/)
3. **社区支持**: [Cloudflare Community](https://community.cloudflare.com/)

---

**部署时间:** 2025-11-19
**部署者:** Qstrux
**版本:** v0.1.0 MVP
