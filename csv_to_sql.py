#!/usr/bin/env python3
"""
CSV 转 SQL 导入脚本
用于将客户数据从 CSV 文件转换为 SQL INSERT 语句

使用方法:
  python csv_to_sql.py my-clients.csv [user_id]
  
示例:
  python csv_to_sql.py clients.csv 2
"""

import csv
import sys
import os

def csv_to_sql(csv_file, user_id=2):
    """将 CSV 转换为 SQL INSERT 语句"""
    
    if not os.path.exists(csv_file):
        print(f"❌ 错误：文件 {csv_file} 不存在")
        sys.exit(1)
    
    sql_statements = []
    count = 0
    
    try:
        with open(csv_file, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            
            # 验证必需字段
            required_fields = ['name', 'source', 'stage']
            if not all(field in reader.fieldnames for field in required_fields):
                print(f"❌ 错误：CSV 文件缺少必需字段")
                print(f"必需字段: {', '.join(required_fields)}")
                print(f"当前字段: {', '.join(reader.fieldnames)}")
                sys.exit(1)
            
            for row in reader:
                count += 1
                
                # 转义单引号和处理空值
                def escape(value):
                    if not value:
                        return ''
                    return value.replace("'", "''")
                
                name = escape(row['name'])
                phone = escape(row.get('phone', ''))
                wechat = escape(row.get('wechat', ''))
                email = escape(row.get('email', ''))
                source = escape(row['source'])
                stage = row['stage']
                temp_score = row.get('temperature_score', '50')
                temp_level = row.get('temperature_level', 'neutral')
                interests = escape(row.get('interests', ''))
                personality = escape(row.get('personality', ''))
                unique_qualities = escape(row.get('unique_qualities', ''))
                behavior_patterns = escape(row.get('behavior_patterns', ''))
                investment_profile = escape(row.get('investment_profile', ''))
                
                # 验证 stage 值
                valid_stages = ['new_lead', 'initial_contact', 'nurturing', 'high_intent', 
                               'joined_group', 'opened_account', 'deposited']
                if stage not in valid_stages:
                    print(f"⚠️  警告：第 {count} 行的 stage 值 '{stage}' 无效，使用默认值 'new_lead'")
                    stage = 'new_lead'
                
                # 验证 temperature_level 值
                valid_temps = ['hot', 'warm', 'neutral', 'cold']
                if temp_level not in valid_temps:
                    print(f"⚠️  警告：第 {count} 行的 temperature_level 值 '{temp_level}' 无效，使用默认值 'neutral'")
                    temp_level = 'neutral'
                
                sql = f"""INSERT INTO clients (
  user_id, name, phone, wechat, email, source, stage,
  temperature_score, temperature_level,
  interests, personality, unique_qualities, behavior_patterns, investment_profile
) VALUES (
  {user_id}, '{name}', '{phone}', '{wechat}', '{email}', '{source}', '{stage}',
  {temp_score}, '{temp_level}',
  '{interests}', '{personality}', '{unique_qualities}', '{behavior_patterns}', '{investment_profile}'
);"""
                
                sql_statements.append(sql)
        
        return '\n\n'.join(sql_statements), count
        
    except Exception as e:
        print(f"❌ 错误：处理 CSV 文件时出错")
        print(f"详细信息：{str(e)}")
        sys.exit(1)


def main():
    """主函数"""
    print("=" * 60)
    print("  CRM 客户数据导入工具")
    print("=" * 60)
    print()
    
    # 检查参数
    if len(sys.argv) < 2:
        print("用法: python csv_to_sql.py <csv文件> [user_id]")
        print()
        print("参数说明:")
        print("  csv文件   - 客户数据 CSV 文件路径")
        print("  user_id   - 归属用户 ID（默认: 2）")
        print()
        print("示例:")
        print("  python csv_to_sql.py my-clients.csv")
        print("  python csv_to_sql.py my-clients.csv 3")
        sys.exit(1)
    
    csv_file = sys.argv[1]
    user_id = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    
    print(f"📂 输入文件: {csv_file}")
    print(f"👤 用户 ID: {user_id}")
    print()
    
    # 转换 CSV
    print("🔄 正在转换 CSV 数据...")
    sql_output, count = csv_to_sql(csv_file, user_id)
    
    # 保存到文件
    output_file = 'import.sql'
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write("-- CRM 客户数据导入脚本\n")
        f.write(f"-- 来源文件: {csv_file}\n")
        f.write(f"-- 用户 ID: {user_id}\n")
        f.write(f"-- 记录数量: {count}\n")
        f.write("-- 生成时间: " + __import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M:%S') + "\n\n")
        f.write(sql_output)
    
    print(f"✅ 转换完成!")
    print()
    print(f"📊 统计信息:")
    print(f"  - 总记录数: {count}")
    print(f"  - 输出文件: {output_file}")
    print()
    print("📝 下一步操作:")
    print()
    print("  导入到本地数据库:")
    print(f"    npx wrangler d1 execute webapp-production --local --file=./{output_file}")
    print()
    print("  导入到生产数据库:")
    print(f"    npx wrangler d1 execute crm-high-trust-sales-db --remote --file=./{output_file}")
    print()
    print("  验证导入结果:")
    print("    npx wrangler d1 execute crm-high-trust-sales-db --remote \\")
    print('      --command="SELECT COUNT(*) FROM clients"')
    print()
    print("=" * 60)


if __name__ == '__main__':
    main()
