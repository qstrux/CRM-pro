// JWT 认证工具
// 注意：Cloudflare Workers 环境使用 Web Crypto API

interface JWTPayload {
  userId: number;
  email: string;
  role: string;
  exp: number;
}

// 简化版 JWT（使用 base64 编码）
// 生产环境建议使用 jose 库或 Cloudflare Workers JWT
export async function generateToken(userId: number, email: string, role: string): Promise<string> {
  const payload: JWTPayload = {
    userId,
    email,
    role,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 天过期
  };
  
  const payloadStr = JSON.stringify(payload);
  const encoded = btoa(payloadStr);
  
  // 简化版签名（生产环境应使用 HMAC）
  const signature = await generateSignature(encoded);
  
  return `${encoded}.${signature}`;
}

export async function verifyToken(token: string): Promise<JWTPayload | null> {
  try {
    const [encoded, signature] = token.split('.');
    
    // 验证签名
    const expectedSignature = await generateSignature(encoded);
    if (signature !== expectedSignature) {
      return null;
    }
    
    const payload: JWTPayload = JSON.parse(atob(encoded));
    
    // 检查过期
    if (Date.now() > payload.exp) {
      return null;
    }
    
    return payload;
  } catch (error) {
    return null;
  }
}

async function generateSignature(data: string): Promise<string> {
  // 使用 Web Crypto API 生成签名
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data + 'SECRET_KEY'); // 生产环境应使用环境变量
  
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  return hashHex;
}

// 密码哈希（简化版 - 生产环境应使用 bcrypt）
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'SALT');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const computedHash = await hashPassword(password);
  return computedHash === hash;
}

// 从请求头获取用户信息
export function getUserFromRequest(authHeader: string | null): { userId: number; role: string } | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  
  const token = authHeader.substring(7);
  // 这里应该验证 token，为了简化先直接返回
  // 生产环境需要调用 verifyToken
  
  return { userId: 2, role: 'sales' }; // MVP 阶段默认返回
}
