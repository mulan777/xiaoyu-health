const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
(async () => {
  try {
    const cwd = '/opt/kindergarten-fitness-platform';
    const envPath = path.join(cwd, '.env');
    const env = {};
    if (fs.existsSync(envPath)) {
      const text = fs.readFileSync(envPath, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        let v = m[2] || '';
        if ((v.startsWith(') && v.endsWith(')) || (v.startsWith(") && v.endsWith("))) v = v.slice(1, -1);
        env[m[1]] = v;
      }
    }
    const conn = await mysql.createConnection({
      host: env.DB_HOST || '127.0.0.1',
      port: Number(env.DB_PORT || 3306),
      user: env.DB_USER || 'root',
      password: env.DB_PASSWORD || '',
      database: env.DB_NAME || env.DB_DATABASE || 'kindergarten_platform',
      charset: 'utf8mb4'
    });
    const [all] = await conn.execute('SELECT id,name,enabled,sort_order,image_width,image_height,map_x,map_y,map_width,map_height FROM venues ORDER BY sort_order ASC, id ASC');
    const [enabled] = await conn.execute('SELECT id,name,enabled,sort_order,image_width,image_height,map_x,map_y,map_width,map_height FROM venues WHERE enabled=1 ORDER BY sort_order ASC, id ASC');
    console.log('ALL_VENUES=' + JSON.stringify(all));
    console.log('ENABLED_VENUES=' + JSON.stringify(enabled));
    await conn.end();
  } catch (e) {
    console.error('QUERY_FAILED=' + (e && (e.stack || e.message || String(e))));
    process.exit(1);
  }
})();
