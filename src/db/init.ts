import { SCHEMA_SQL, SEED_SQL } from './schema';

// 初始化数据库
export async function initDatabase(db: D1Database, useSeed: boolean = true) {
  try {
    // 执行 Schema SQL - 分批执行每个 CREATE TABLE 语句
    const schemaStatements = SCHEMA_SQL
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    
    for (const statement of schemaStatements) {
      await db.prepare(statement).run();
    }
    
    console.log('✅ 数据库表结构创建成功');
    
    // 执行测试数据
    if (useSeed) {
      const seedStatements = SEED_SQL
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      
      for (const statement of seedStatements) {
        await db.prepare(statement).run();
      }
      
      console.log('✅ 测试数据插入成功');
    }
    
    return { success: true };
  } catch (error) {
    console.error('❌ 数据库初始化失败:', error);
    return { success: false, error: String(error) };
  }
}

// 检查数据库是否已初始化
export async function isDatabaseInitialized(db: D1Database): Promise<boolean> {
  try {
    const result = await db.prepare('SELECT name FROM sqlite_master WHERE type="table" AND name="users"').first();
    return result !== null;
  } catch (error) {
    return false;
  }
}
