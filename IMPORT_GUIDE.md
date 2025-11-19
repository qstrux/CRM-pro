# 📥 真实数据导入指南

## 🎯 概述

本指南帮助你将现有客户数据导入到 CRM 系统中。

---

## 📋 数据准备

### 1. 下载模板文件

```bash
# 模板文件位置
import-template.csv
```

### 2. 模板字段说明

| 字段名 | 类型 | 必填 | 说明 | 示例 |
|--------|------|------|------|------|
| name | 文本 | ✅ | 客户姓名 | 王先生 |
| phone | 文本 | ❌ | 电话号码 | 13800138001 |
| wechat | 文本 | ❌ | 微信号 | wangxs |
| email | 文本 | ❌ | 邮箱地址 | wang@example.com |
| source | 文本 | ✅ | 客户来源 | LinkedIn / Facebook / 朋友推荐 |
| stage | 文本 | ✅ | 当前阶段 | new_lead / nurturing / high_intent |
| temperature_score | 数字 | ❌ | 温度评分 (0-100) | 75 |
| temperature_level | 文本 | ❌ | 温度等级 | hot / warm / neutral / cold |
| interests | 文本 | ❌ | 兴趣点（逗号分隔） | 数字货币,股票投资 |
| personality | 文本 | ❌ | 性格特征 | 理性、谨慎 |
| unique_qualities | 文本 | ❌ | 稀缺品质 | 决策果断 |
| behavior_patterns | 文本 | ❌ | 行为习惯 | 晚上活跃 |
| investment_profile | 文本 | ❌ | 投资画像 | 风险偏好中等 |

### 3. 阶段枚举值

```
new_lead          - 新接粉
initial_contact   - 初步破冰
nurturing         - 深度培育
high_intent       - 高意向
joined_group      - 已进群
opened_account    - 已开户
deposited         - 已入金
```

### 4. 温度枚举值

```
hot      - 热（🔥）
warm     - 温（🌤️）
neutral  - 中（☁️）
cold     - 冷（❄️）
```

---

## 🔧 导入方式

### 方式 1：API 导入（推荐）

#### 步骤 1：准备 CSV 文件
按照模板格式准备你的数据文件 `my-clients.csv`

#### 步骤 2：使用 wrangler 导入

```bash
# 1. 创建导入 SQL 脚本（需要先转换 CSV 为 SQL）
# 你可以使用在线工具或脚本转换

# 2. 导入到本地数据库
npx wrangler d1 execute webapp-production --local --file=./import.sql

# 3. 导入到生产数据库
npx wrangler d1 execute crm-high-trust-sales-db --remote --file=./import.sql
```

#### 步骤 3：验证导入

```bash
# 查询客户数量
npx wrangler d1 execute crm-high-trust-sales-db --remote \
  --command="SELECT COUNT(*) FROM clients"

# 查看最新导入的客户
npx wrangler d1 execute crm-high-trust-sales-db --remote \
  --command="SELECT * FROM clients ORDER BY created_at DESC LIMIT 5"
```

---

### 方式 2：手动通过 UI 导入

如果数据量不大（<50 个客户），可以通过系统界面手动添加：

1. 访问系统主页
2. 点击"新增客户"按钮
3. 逐个填写客户信息

---

## 🔄 CSV 转 SQL 脚本

### Python 脚本示例

创建 `csv_to_sql.py`:

\`\`\`python
import csv
import sys

def csv_to_sql(csv_file, user_id=2):
    """将 CSV 转换为 SQL INSERT 语句"""
    
    sql_statements = []
    
    with open(csv_file, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        
        for row in reader:
            # 转义单引号
            name = row['name'].replace("'", "''")
            phone = row.get('phone', '').replace("'", "''")
            wechat = row.get('wechat', '').replace("'", "''")
            email = row.get('email', '').replace("'", "''")
            source = row['source'].replace("'", "''")
            stage = row['stage']
            temp_score = row.get('temperature_score', '50')
            temp_level = row.get('temperature_level', 'neutral')
            interests = row.get('interests', '').replace("'", "''")
            personality = row.get('personality', '').replace("'", "''")
            unique_qualities = row.get('unique_qualities', '').replace("'", "''")
            behavior_patterns = row.get('behavior_patterns', '').replace("'", "''")
            investment_profile = row.get('investment_profile', '').replace("'", "''")
            
            sql = f"""
INSERT INTO clients (
  user_id, name, phone, wechat, email, source, stage,
  temperature_score, temperature_level,
  interests, personality, unique_qualities, behavior_patterns, investment_profile
) VALUES (
  {user_id}, '{name}', '{phone}', '{wechat}', '{email}', '{source}', '{stage}',
  {temp_score}, '{temp_level}',
  '{interests}', '{personality}', '{unique_qualities}', '{behavior_patterns}', '{investment_profile}'
);
            """.strip()
            
            sql_statements.append(sql)
    
    return '\n\n'.join(sql_statements)

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("用法: python csv_to_sql.py <csv文件>")
        sys.exit(1)
    
    csv_file = sys.argv[1]
    user_id = sys.argv[2] if len(sys.argv) > 2 else 2
    
    sql_output = csv_to_sql(csv_file, user_id)
    
    # 保存到文件
    with open('import.sql', 'w', encoding='utf-8') as f:
        f.write(sql_output)
    
    print(f"✅ SQL 文件已生成：import.sql")
    print(f"📊 共 {sql_output.count('INSERT INTO')} 条记录")
\`\`\`

### 使用方法

```bash
# 1. 运行转换脚本
python csv_to_sql.py my-clients.csv 2

# 2. 导入生成的 SQL
npx wrangler d1 execute crm-high-trust-sales-db --remote --file=./import.sql
```

---

## 🧹 清理测试数据

如果需要删除所有测试数据，先导入真实数据：

```bash
# 1. 备份当前数据库
npx wrangler d1 export crm-high-trust-sales-db --remote --output=backup.sql

# 2. 删除测试客户（ID 1-5）
npx wrangler d1 execute crm-high-trust-sales-db --remote \
  --command="DELETE FROM clients WHERE id IN (1, 2, 3, 4, 5)"

# 3. 删除相关日志
npx wrangler d1 execute crm-high-trust-sales-db --remote \
  --command="DELETE FROM client_logs WHERE client_id IN (1, 2, 3, 4, 5)"

# 4. 删除相关标签关联
npx wrangler d1 execute crm-high-trust-sales-db --remote \
  --command="DELETE FROM client_tags WHERE client_id IN (1, 2, 3, 4, 5)"
```

---

## 📊 导入后验证

### 检查数据完整性

```bash
# 1. 检查客户总数
npx wrangler d1 execute crm-high-trust-sales-db --remote \
  --command="SELECT COUNT(*) as total FROM clients"

# 2. 按阶段统计
npx wrangler d1 execute crm-high-trust-sales-db --remote \
  --command="SELECT stage, COUNT(*) as count FROM clients GROUP BY stage"

# 3. 按温度统计
npx wrangler d1 execute crm-high-trust-sales-db --remote \
  --command="SELECT temperature_level, COUNT(*) as count FROM clients GROUP BY temperature_level"

# 4. 检查是否有空值
npx wrangler d1 execute crm-high-trust-sales-db --remote \
  --command="SELECT COUNT(*) as missing_name FROM clients WHERE name IS NULL OR name = ''"
```

---

## ⚠️ 注意事项

### 数据格式要求

1. **CSV 编码**: 必须是 UTF-8 编码
2. **字段包含逗号**: 用双引号包裹，如 `"数字货币,股票投资"`
3. **空值处理**: 非必填字段可以留空
4. **日期格式**: 系统会自动设置 `created_at` 时间戳

### 性能建议

1. **批量导入**: 建议每次导入不超过 1000 条记录
2. **分批执行**: 大量数据分多个文件导入
3. **备份优先**: 导入前先备份现有数据

### 常见问题

#### Q: 导入失败怎么办？
A: 检查 CSV 格式是否正确，特别是编码和特殊字符

#### Q: 能否更新现有客户？
A: 需要使用 UPDATE 语句，不建议通过导入覆盖

#### Q: 如何处理重复客户？
A: 导入前检查是否存在相同手机号或微信号

---

## 🔒 安全建议

1. **敏感信息**: 导入文件包含客户隐私，注意保密
2. **权限控制**: 只有管理员执行导入操作
3. **日志记录**: 记录每次导入的时间和数量
4. **数据验证**: 导入后人工抽查数据正确性

---

## 📞 获取帮助

如果遇到导入问题：

1. 检查 CSV 格式是否符合模板
2. 查看 wrangler 错误日志
3. 尝试先导入单条数据测试

---

**最后更新**: 2025-11-19
**适用版本**: v0.2.0+
