// Cloudflare Workers 环境绑定类型定义
export type Bindings = {
  DB: D1Database;
};

// Hono Context with Bindings
export type HonoEnv = {
  Bindings: Bindings;
};
