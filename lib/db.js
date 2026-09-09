/**
 * db.js — 数据库初始化 + 通用查询
 */

const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { normalizeText, inferGradeLevelByClassName, uniqueNumberIds, buildPlaceholders } = require('./helpers');

let pool;

const DEFAULT_SETTINGS = {
  siteName: '幼儿园体适能数智化教研平台',
  subtitle: '教研管理平台',
  heroTitle: '幼儿园体适能数智化教研平台',
  heroDesc: '集体测数据采集、科学评分分析、场地智能预约、幼儿成长档案于一体，为幼儿园体适能教研提供全流程数智化支撑。',
  mobileHint: '教师端已适配手机 H5，可通过微信直接访问，随时录入体测数据和管理场地预约。',
  adminNotice: 'Admin 后台支持用户、班级、幼儿档案、批量导入导出与批量编辑。',
  // ========== AI 大模型接入（OpenAI 兼容协议） ==========
  aiEnabled: '0',
  aiBaseUrl: 'https://api.deepseek.com/v1',
  aiApiKey: '',
  aiModel: 'deepseek-chat',
  aiProviderName: 'DeepSeek',
  aiTimeoutMs: '60000',
  aiTemperature: '0.6',
  aiMaxTokens: '1800',
  // ========== 手环健康监测 ==========
  bandEnabledClasses: '[]',
  aiSystemPrompt: '你是一名儿童体适能与幼儿教育专家，擅长解读幼儿体测数据。请用温和、专业、易懂的语言为幼儿园教师与家长生成体质画像、薄弱项分析和家庭训练建议。所有建议必须安全、适龄、可执行，避免医学诊断与不当训练强度。'
};

const DEFAULT_FEATURES = [
  { title: '体测数据录入与分析', desc: '支持逐条录入和 Excel 批量导入体测数据，系统自动对照国标评分表计算各项得分与综合评级。' },
  { title: '科学评分体系', desc: '内置身高、BMI、握力、立定跳远、坐位体前屈、双脚连续跳、绕障碍跑、走平衡木 8 大维度评分标准。' },
  { title: '场地智能预约', desc: '可视化场地地图，支持按班级、年龄段分池预约，实时显示剩余容量和倒计时。' },
  { title: '幼儿成长档案', desc: '建立完整的幼儿档案体系，支持重点关注标记、关注原因记录和关注周期管理。' },
  { title: '多角色权限管理', desc: '支持自定义角色与细粒度权限控制，管理员、教师各司其职，数据安全有保障。' },
  { title: '批量导入导出', desc: '用户、幼儿、体测数据均支持 Excel 模板下载、批量导入和一键导出。' }
];

const DEFAULT_QUICK_LINKS = [
  { name: '登录平台', path: '/login' },
  { name: '管理后台', path: '/admin' },
  { name: '教师工作台', path: '/user' },
  { name: '场地预约', path: '/user/venues' }
];

function getPool() {
  return pool;
}

function normalizePageNumber(value, fallback = 1) {
  const page = Number.parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? page : fallback;
}

function normalizePageSize(value, fallback = 10) {
  const size = Number.parseInt(value, 10);
  return [10, 20, 50].includes(size) ? size : fallback;
}

function paginateItems(items, page, pageSize = 10) {
  const safeSize = normalizePageSize(pageSize, 10);
  const total = Array.isArray(items) ? items.length : 0;
  const totalPages = Math.max(1, Math.ceil(total / safeSize));
  const currentPage = Math.min(Math.max(normalizePageNumber(page, 1), 1), totalPages);
  const start = (currentPage - 1) * safeSize;
  const pagedItems = total ? items.slice(start, start + safeSize) : [];
  return {
    items: pagedItems,
    pagination: {
      pageSize: safeSize,
      total,
      totalPages,
      currentPage,
      hasPrev: currentPage > 1,
      hasNext: currentPage < totalPages,
      prevPage: currentPage > 1 ? currentPage - 1 : 1,
      nextPage: currentPage < totalPages ? currentPage + 1 : totalPages,
      startIndex: total ? start + 1 : 0,
      endIndex: total ? start + pagedItems.length : 0
    }
  };
}

async function dbQuery(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function ensureColumnExists(databaseName, tableName, columnName, definitionSql) {
  const rows = await dbQuery(
    `SELECT COUNT(*) AS total
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [databaseName, tableName, columnName]
  );
  if (!Number(rows[0]?.total || 0)) {
    await dbQuery(`ALTER TABLE ${tableName} ADD COLUMN ${definitionSql}`);
  }
}

async function initDatabase(config) {
  const { host, port, user, password, database } = config;

  const bootstrapConn = await mysql.createConnection({
    host, port, user, password, multipleStatements: true
  });
  try {
    await bootstrapConn.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } catch (err) {
    console.warn('Create database skipped:', err.code || err.message);
  } finally {
    await bootstrapConn.end();
  }

  pool = mysql.createPool({
    host, port, user, password, database,
    waitForConnections: true,
    connectionLimit: 20,
    queueLimit: 100,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    charset: 'utf8mb4'
  });

  // ========== 建表 ==========
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS classes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      grade_level ENUM('small', 'middle', 'large') NOT NULL DEFAULT 'small',
      teacher_name VARCHAR(255) DEFAULT '',
      capacity INT DEFAULT 0,
      description TEXT,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(64) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
      name VARCHAR(100) NOT NULL,
      class_id INT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_users_class_id (class_id),
      CONSTRAINT fk_users_class FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await ensureColumnExists(database, 'users', 'birth_date', "birth_date DATE NULL");

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS children (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      gender ENUM('男', '女', '其他') NOT NULL DEFAULT '男',
      birth_date DATE NULL,
      class_id INT NULL,
      guardian_name VARCHAR(100) DEFAULT '',
      guardian_phone VARCHAR(32) DEFAULT '',
      notes TEXT,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_children_class_id (class_id),
      CONSTRAINT fk_children_class FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await ensureColumnExists(database, 'children', 'needs_attention', "needs_attention TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否需要关注'");
  await ensureColumnExists(database, 'children', 'attention_reason', "attention_reason TEXT NULL COMMENT '关注原因'");
  await ensureColumnExists(database, 'children', 'attention_start_date', "attention_start_date DATE NULL COMMENT '关注开始日期'");
  await ensureColumnExists(database, 'children', 'attention_end_date', "attention_end_date DATE NULL COMMENT '关注结束日期'");
  await ensureColumnExists(database, 'children', 'attention_tags', "attention_tags VARCHAR(255) NULL COMMENT '关注标签'");
  await ensureColumnExists(database, 'children', 'attention_vest_type', "attention_vest_type VARCHAR(16) NULL COMMENT '重点关注马甲类型 yellow/green/red'");

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS site_settings (
      setting_key VARCHAR(100) PRIMARY KEY,
      setting_value TEXT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS home_features (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sort_order INT NOT NULL DEFAULT 1,
      title VARCHAR(150) NOT NULL,
      description TEXT,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS home_quick_links (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sort_order INT NOT NULL DEFAULT 1,
      name VARCHAR(100) NOT NULL,
      path VARCHAR(255) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ========== 体测记录表 ==========
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS fitness_records (
      id INT AUTO_INCREMENT PRIMARY KEY,
      child_id INT NOT NULL,
      test_date DATE NOT NULL,
      height_cm DECIMAL(5,1) NULL COMMENT '身高(CM)',
      weight_kg DECIMAL(5,2) NULL COMMENT '体重(KG)',
      bmi DECIMAL(5,2) NULL COMMENT 'BMI 自动算',
      grip_kg DECIMAL(5,2) NULL COMMENT '握力(KG)',
      long_jump_cm DECIMAL(6,1) NULL COMMENT '立定跳远(CM)',
      sit_reach_cm DECIMAL(5,1) NULL COMMENT '坐位体前屈(CM)',
      double_jump_sec DECIMAL(5,2) NULL COMMENT '双脚连续跳(秒)',
      obstacle_run_sec DECIMAL(5,2) NULL COMMENT '15米绕障碍跑(秒)',
      balance_beam_sec DECIMAL(5,2) NULL COMMENT '走平衡木(秒)',
      height_score INT NULL COMMENT '身高 得分',
      bmi_score INT NULL COMMENT 'BMI 得分',
      grip_score INT NULL COMMENT '握力 得分',
      jump_score INT NULL COMMENT '立定跳远 得分',
      sit_score INT NULL COMMENT '坐位体前屈 得分',
      djump_score INT NULL COMMENT '双脚连续跳 得分',
      obstacle_score INT NULL COMMENT '15米绕障碍跑 得分',
      balance_score INT NULL COMMENT '走平衡木 得分',
      total_score DECIMAL(5,1) NULL COMMENT '综合得分',
      rating VARCHAR(20) NULL COMMENT '评级',
      created_by INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_fr_child (child_id),
      INDEX idx_fr_date (test_date),
      UNIQUE KEY uk_child_date (child_id, test_date),
      CONSTRAINT fk_fr_child FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await ensureColumnExists(database, 'fitness_records', 'height_score', "height_score INT NULL COMMENT '身高 得分'");

  // ========== 场地预约表 (v2) ==========
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS venues (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL COMMENT '场地名称',
      image_path VARCHAR(500) NULL COMMENT '场地图片',
      image_width INT NULL DEFAULT 280 COMMENT '图片宽(px)',
      image_height INT NULL DEFAULT 180 COMMENT '图片高(px)',
      map_x INT NULL COMMENT '地图布局 x',
      map_y INT NULL COMMENT '地图布局 y',
      map_width INT NULL COMMENT '地图布局宽(px)',
      map_height INT NULL COMMENT '地图布局高(px)',
      hotspot_points TEXT NULL COMMENT 'venue hotspot polygon json',
      hotspot_hint_x INT NULL COMMENT 'venue hotspot hint x',
      hotspot_hint_y INT NULL COMMENT 'venue hotspot hint y',
      hotspot_hint_label VARCHAR(50) NULL COMMENT 'venue hotspot hint label',
      hotspot_hint_label_size INT NULL DEFAULT 14 COMMENT 'venue hotspot hint label size',
      hotspot_hint_color VARCHAR(20) NULL COMMENT 'venue hotspot hint color',
      hotspot_hint_size INT NULL DEFAULT 28 COMMENT 'venue hotspot hint arrow size',
      hotspot_hint_length INT NULL DEFAULT 54 COMMENT 'venue hotspot hint arrow length',
      hotspot_hint_bounce_ms INT NULL DEFAULT 1500 COMMENT 'venue hotspot hint bounce duration',
      detail_image_path VARCHAR(500) NULL COMMENT 'venue fullscreen scene image',
      detail_view_width INT NULL DEFAULT 960 COMMENT 'venue fullscreen scene width',
      detail_view_height INT NULL DEFAULT 640 COMMENT 'venue fullscreen scene height',
      play_desc_small TEXT COMMENT '小班玩法说明',
      play_images_small LONGTEXT NULL COMMENT '小班玩法图片列表 json',
      play_desc_ml TEXT COMMENT '中大班玩法说明',
      play_images_ml LONGTEXT NULL COMMENT '中大班玩法图片列表 json',
      equipment TEXT NULL COMMENT '器材说明',
      loop_guide_image_path VARCHAR(500) NULL COMMENT '大循环示意图',
      loop_guide_station_image_path VARCHAR(500) NULL COMMENT '大循环指导站位图',
      loop_guide_video_path VARCHAR(500) NULL COMMENT '大循环指导视频',
      loop_guide_video_autoplay TINYINT(1) NOT NULL DEFAULT 0 COMMENT '大循环视频自动播放',
      loop_guide_desc_small TEXT NULL COMMENT '小班大循环指导说明',
      loop_guide_desc_ml TEXT NULL COMMENT '中大班大循环指导说明',
      cap_small INT NOT NULL DEFAULT 1 COMMENT '小班可约班数',
      cap_middle INT NOT NULL DEFAULT 2 COMMENT '中班可约班数',
      cap_large INT NOT NULL DEFAULT 2 COMMENT '大班可约班数',
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await ensureColumnExists(database, 'venues', 'play_desc_small', "play_desc_small TEXT NULL COMMENT '小班玩法说明'");
  await ensureColumnExists(database, 'venues', 'play_desc_ml', "play_desc_ml TEXT NULL COMMENT '中大班玩法说明'");
  await ensureColumnExists(database, 'venues', 'cap_middle', "cap_middle INT NOT NULL DEFAULT 2 COMMENT '中班可约班数'");
  await ensureColumnExists(database, 'venues', 'cap_large', "cap_large INT NOT NULL DEFAULT 2 COMMENT '大班可约班数'");
  await ensureColumnExists(database, 'venues', 'map_x', "map_x INT NULL COMMENT '地图布局 x'");
  await ensureColumnExists(database, 'venues', 'map_y', "map_y INT NULL COMMENT '地图布局 y'");
  await ensureColumnExists(database, 'venues', 'map_width', "map_width INT NULL COMMENT '地图布局宽(px)'");
  await ensureColumnExists(database, 'venues', 'map_height', "map_height INT NULL COMMENT '地图布局高(px)'");
  await ensureColumnExists(database, 'venues', 'hotspot_points', "hotspot_points TEXT NULL COMMENT 'venue hotspot polygon json'");
  await ensureColumnExists(database, 'venues', 'hotspot_hint_x', "hotspot_hint_x INT NULL COMMENT 'venue hotspot hint x'");
  await ensureColumnExists(database, 'venues', 'hotspot_hint_y', "hotspot_hint_y INT NULL COMMENT 'venue hotspot hint y'");
  await ensureColumnExists(database, 'venues', 'hotspot_hint_label', "hotspot_hint_label VARCHAR(50) NULL COMMENT 'venue hotspot hint label'");
  await ensureColumnExists(database, 'venues', 'hotspot_hint_label_size', "hotspot_hint_label_size INT NULL DEFAULT 14 COMMENT 'venue hotspot hint label size'");
  await ensureColumnExists(database, 'venues', 'hotspot_hint_color', "hotspot_hint_color VARCHAR(20) NULL COMMENT 'venue hotspot hint color'");
  await ensureColumnExists(database, 'venues', 'hotspot_hint_size', "hotspot_hint_size INT NULL DEFAULT 28 COMMENT 'venue hotspot hint arrow size'");
  await ensureColumnExists(database, 'venues', 'hotspot_hint_length', "hotspot_hint_length INT NULL DEFAULT 54 COMMENT 'venue hotspot hint arrow length'");
  await ensureColumnExists(database, 'venues', 'hotspot_hint_bounce_ms', "hotspot_hint_bounce_ms INT NULL DEFAULT 1500 COMMENT 'venue hotspot hint bounce duration'");
  await ensureColumnExists(database, 'venues', 'detail_image_path', "detail_image_path VARCHAR(500) NULL COMMENT 'venue fullscreen scene image'");
  await ensureColumnExists(database, 'venues', 'detail_view_width', "detail_view_width INT NULL DEFAULT 960 COMMENT 'venue fullscreen scene width'");
  await ensureColumnExists(database, 'venues', 'detail_view_height', "detail_view_height INT NULL DEFAULT 640 COMMENT 'venue fullscreen scene height'");
  await ensureColumnExists(database, 'venues', 'play_images_small', "play_images_small LONGTEXT NULL COMMENT '小班玩法图片列表 json'");
  await ensureColumnExists(database, 'venues', 'play_images_ml', "play_images_ml LONGTEXT NULL COMMENT '中大班玩法图片列表 json'");
  await ensureColumnExists(database, 'venues', 'equipment', "equipment TEXT NULL COMMENT '器材说明'");
  await ensureColumnExists(database, 'venues', 'loop_guide_image_path', "loop_guide_image_path VARCHAR(500) NULL COMMENT '大循环示意图'");
  await ensureColumnExists(database, 'venues', 'loop_guide_station_image_path', "loop_guide_station_image_path VARCHAR(500) NULL COMMENT '大循环指导站位图'");
  await ensureColumnExists(database, 'venues', 'loop_guide_video_path', "loop_guide_video_path VARCHAR(500) NULL COMMENT '大循环指导视频'");
  await ensureColumnExists(database, 'venues', 'loop_guide_video_autoplay', "loop_guide_video_autoplay TINYINT(1) NOT NULL DEFAULT 0 COMMENT '大循环视频自动播放'");
  await ensureColumnExists(database, 'venues', 'loop_guide_desc_small', "loop_guide_desc_small TEXT NULL COMMENT '小班大循环指导说明'");
  await ensureColumnExists(database, 'venues', 'loop_guide_desc_ml', "loop_guide_desc_ml TEXT NULL COMMENT '中大班大循环指导说明'");

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS venue_backgrounds (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL COMMENT '背景层名称',
      image_path VARCHAR(500) NULL COMMENT '背景图片',
      map_x INT NOT NULL DEFAULT 0 COMMENT '背景布局 x',
      map_y INT NOT NULL DEFAULT 0 COMMENT '背景布局 y',
      map_width INT NOT NULL DEFAULT 600 COMMENT '背景布局宽(px)',
      map_height INT NOT NULL DEFAULT 320 COMMENT '背景布局高(px)',
      sort_order INT NOT NULL DEFAULT 1 COMMENT '背景层顺序',
      is_fixed TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否固定背景',
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await ensureColumnExists(database, 'venue_backgrounds', 'name', "name VARCHAR(100) NOT NULL DEFAULT '背景层' COMMENT '背景层名称'");
  await ensureColumnExists(database, 'venue_backgrounds', 'image_path', "image_path VARCHAR(500) NULL COMMENT '背景图片'");
  await ensureColumnExists(database, 'venue_backgrounds', 'map_x', "map_x INT NOT NULL DEFAULT 0 COMMENT '背景布局 x'");
  await ensureColumnExists(database, 'venue_backgrounds', 'map_y', "map_y INT NOT NULL DEFAULT 0 COMMENT '背景布局 y'");
  await ensureColumnExists(database, 'venue_backgrounds', 'map_width', "map_width INT NOT NULL DEFAULT 600 COMMENT '背景布局宽(px)'");
  await ensureColumnExists(database, 'venue_backgrounds', 'map_height', "map_height INT NOT NULL DEFAULT 320 COMMENT '背景布局高(px)'");
  await ensureColumnExists(database, 'venue_backgrounds', 'sort_order', "sort_order INT NOT NULL DEFAULT 1 COMMENT '背景层顺序'");
  await ensureColumnExists(database, 'venue_backgrounds', 'is_fixed', "is_fixed TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否固定背景'");
  await ensureColumnExists(database, 'venue_backgrounds', 'enabled', "enabled TINYINT(1) NOT NULL DEFAULT 1");


  // 场地地图元素（叠加在场地地图上的可点击元素）
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS venue_elements (
      id INT AUTO_INCREMENT PRIMARY KEY,
      venue_id INT NOT NULL,
      element_name VARCHAR(100) NOT NULL COMMENT '元素名称，如攀爬区',
      icon_path VARCHAR(500) NULL COMMENT '地图上点击元素图标',
      detail_image_small VARCHAR(500) NULL COMMENT '小班图文介绍图片',
      detail_image_ml VARCHAR(500) NULL COMMENT '中大班图文介绍图片',
      detail_desc_small TEXT NULL COMMENT '小班图文介绍文字',
      detail_desc_ml TEXT NULL COMMENT '中大班图文介绍文字',
      pos_x INT NOT NULL DEFAULT 20 COMMENT '元素在地图上的 x 坐标(px)',
      pos_y INT NOT NULL DEFAULT 20 COMMENT '元素在地图上的 y 坐标(px)',
      box_width INT NOT NULL DEFAULT 64 COMMENT '元素宽(px)',
      box_height INT NOT NULL DEFAULT 64 COMMENT '元素高(px)',
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_ve_venue (venue_id),
      CONSTRAINT fk_ve_venue FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await ensureColumnExists(database, 'venue_elements', 'detail_desc_small', "detail_desc_small TEXT NULL COMMENT '小班图文介绍文字'");
  await ensureColumnExists(database, 'venue_elements', 'detail_desc_ml', "detail_desc_ml TEXT NULL COMMENT '中大班图文介绍文字'");
  await ensureColumnExists(database, 'venue_elements', 'enabled', "enabled TINYINT(1) NOT NULL DEFAULT 1");
  await ensureColumnExists(database, 'venue_elements', 'sort_order', "sort_order INT NOT NULL DEFAULT 1");

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS venue_skill_guides (
      id INT AUTO_INCREMENT PRIMARY KEY,
      venue_id INT NOT NULL,
      title VARCHAR(120) NOT NULL COMMENT '技能分类名称',
      basic_skill_names TEXT NULL COMMENT '基础级技能名称',
      basic_equipment TEXT NULL COMMENT '基础级对应器械',
      basic_action_points TEXT NULL COMMENT '基础级动作要领',
      basic_safety_points TEXT NULL COMMENT '基础级安全指导要点',
      basic_image_path VARCHAR(500) NULL COMMENT '基础级配图',
      basic_video_path VARCHAR(500) NULL COMMENT '基础级视频',
      basic_video_autoplay TINYINT(1) NOT NULL DEFAULT 0 COMMENT '基础级视频自动播放',
      advanced_skill_names TEXT NULL COMMENT '提升级技能名称',
      advanced_equipment TEXT NULL COMMENT '提升级对应器械',
      advanced_action_points TEXT NULL COMMENT '提升级动作要领',
      advanced_safety_points TEXT NULL COMMENT '提升级安全指导要点',
      advanced_image_path VARCHAR(500) NULL COMMENT '提升级配图',
      advanced_video_path VARCHAR(500) NULL COMMENT '提升级视频',
      advanced_video_autoplay TINYINT(1) NOT NULL DEFAULT 0 COMMENT '提升级视频自动播放',
      bridge_indicators TEXT NULL COMMENT '幼小衔接指标',
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_vsg_venue (venue_id),
      CONSTRAINT fk_vsg_venue FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 预约轮次：统一的预约开放时间，不按场地分
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS venue_round (
      id INT AUTO_INCREMENT PRIMARY KEY,
      round_date DATE NOT NULL COMMENT '活动日期（幼儿用场地的日期）',
      open_time DATETIME NOT NULL COMMENT '预约开放时刻（教师可以开始抢的时间）',
      close_time DATETIME NULL COMMENT '预约截止时间（可选）',
      status ENUM('pending','open','closed') NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_round_date (round_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 预约记录
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS venue_bookings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      round_id INT NOT NULL,
      venue_id INT NOT NULL,
      class_id INT NOT NULL,
      user_id INT NOT NULL COMMENT '预约教师',
      grade_pool ENUM('small','middle','large') NOT NULL COMMENT '班级年级池',
      status ENUM('confirmed','cancelled') NOT NULL DEFAULT 'confirmed',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_vb_round (round_id),
      INDEX idx_vb_venue (venue_id),
      INDEX idx_vb_class (class_id),
      UNIQUE KEY uk_round_class (round_id, class_id),
      CONSTRAINT fk_vb2_round FOREIGN KEY (round_id) REFERENCES venue_round(id) ON DELETE CASCADE,
      CONSTRAINT fk_vb2_venue FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE,
      CONSTRAINT fk_vb2_class FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      CONSTRAINT fk_vb2_user  FOREIGN KEY (user_id)  REFERENCES users(id)   ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await seedInitialData(config);
}

async function seedInitialData(config) {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await dbQuery(
      `INSERT INTO site_settings (setting_key, setting_value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE setting_value = setting_value`,
      [key, value]
    );
  }

  const featureCountRows = await dbQuery('SELECT COUNT(*) AS total FROM home_features');
  if (!featureCountRows[0].total) {
    for (let i = 0; i < DEFAULT_FEATURES.length; i++) {
      await dbQuery('INSERT INTO home_features (sort_order, title, description, enabled) VALUES (?, ?, ?, 1)', [i + 1, DEFAULT_FEATURES[i].title, DEFAULT_FEATURES[i].desc]);
    }
  }

  const qlCountRows = await dbQuery('SELECT COUNT(*) AS total FROM home_quick_links');
  if (!qlCountRows[0].total) {
    for (let i = 0; i < DEFAULT_QUICK_LINKS.length; i++) {
      await dbQuery('INSERT INTO home_quick_links (sort_order, name, path, enabled) VALUES (?, ?, ?, 1)', [i + 1, DEFAULT_QUICK_LINKS[i].name, DEFAULT_QUICK_LINKS[i].path]);
    }
  }

  // admin 只在不存在时才插入（不覆盖已修改的密码）
  const existingAdmin = await dbQuery('SELECT id FROM users WHERE username = ? LIMIT 1', [config.adminUsername]);
  if (!existingAdmin.length) {
    await dbQuery(
      `INSERT INTO users (username, password_hash, role, name, class_id, enabled)
       VALUES (?, ?, 'admin', ?, NULL, 1)`,
      [config.adminUsername, bcrypt.hashSync(config.adminPassword, 10), config.adminName]
    );
  }

  const teacherRows = await dbQuery('SELECT id FROM users WHERE username = ? LIMIT 1', [config.userUsername]);
  if (!teacherRows.length) {
    await dbQuery(
      'INSERT INTO users (username, password_hash, role, name, class_id, enabled) VALUES (?, ?, ?, ?, NULL, 1)',
      [config.userUsername, bcrypt.hashSync(config.userPassword, 10), 'user', config.userName]
    );
  }
}

// ========== Settings / Content ==========

async function getSettings() {
  const rows = await dbQuery('SELECT setting_key, setting_value FROM site_settings');
  const settings = { ...DEFAULT_SETTINGS };
  for (const row of rows) settings[row.setting_key] = row.setting_value;
  return settings;
}

async function saveSettings(payload) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const [key, value] of Object.entries(payload)) {
      await conn.execute(
        `INSERT INTO site_settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [key, value]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getHomeFeatures(includeDisabled = false) {
  const rows = await dbQuery(
    `SELECT id, sort_order, title, description, enabled FROM home_features
     ${includeDisabled ? '' : 'WHERE enabled = 1'}
     ORDER BY sort_order ASC, id ASC`
  );
  return rows.map(r => ({ id: r.id, title: r.title, desc: r.description, enabled: Boolean(r.enabled), sortOrder: r.sort_order }));
}

async function getQuickLinks(includeDisabled = false) {
  const rows = await dbQuery(
    `SELECT id, sort_order, name, path, enabled FROM home_quick_links
     ${includeDisabled ? '' : 'WHERE enabled = 1'}
     ORDER BY sort_order ASC, id ASC`
  );
  return rows.map(r => ({ id: r.id, name: r.name, path: r.path, enabled: Boolean(r.enabled), sortOrder: r.sort_order }));
}

async function saveHomeContent(features, quickLinks) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM home_features');
    for (let i = 0; i < features.length; i++) {
      await conn.execute('INSERT INTO home_features (sort_order, title, description, enabled) VALUES (?, ?, ?, 1)', [i + 1, features[i].title, features[i].desc]);
    }
    await conn.execute('DELETE FROM home_quick_links');
    for (let i = 0; i < quickLinks.length; i++) {
      await conn.execute('INSERT INTO home_quick_links (sort_order, name, path, enabled) VALUES (?, ?, ?, 1)', [i + 1, quickLinks[i].name, quickLinks[i].path]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ========== 辅助建班 / 教师同步 ==========

async function ensureClassByName(className, gradeLevel = '') {
  const name = normalizeText(className);
  if (!name) return null;
  const existing = await dbQuery('SELECT id, name, grade_level FROM classes WHERE name = ? LIMIT 1', [name]);
  if (existing.length) return { ...existing[0], createdNow: false };

  const gl = ['small', 'middle', 'large'].includes(gradeLevel) ? gradeLevel : inferGradeLevelByClassName(name);
  await dbQuery('INSERT INTO classes (name, grade_level, teacher_name, capacity, description, enabled) VALUES (?, ?, ?, 0, ?, 1)', [name, gl, '', '']);
  const inserted = await dbQuery('SELECT id, name, grade_level FROM classes WHERE name = ? LIMIT 1', [name]);
  return { ...inserted[0], createdNow: true };
}

async function syncClassTeachers(classId, teacherIds) {
  const ids = uniqueNumberIds(teacherIds).slice(0, 3);
  if (!ids.length) {
    await dbQuery('UPDATE users SET class_id = NULL WHERE role = ? AND class_id = ?', ['user', classId]);
    return;
  }
  const ph = buildPlaceholders(ids);
  await dbQuery(`UPDATE users SET class_id = NULL WHERE role = 'user' AND class_id = ? AND id NOT IN (${ph})`, [classId, ...ids]);
  await dbQuery(`UPDATE users SET class_id = ? WHERE role = 'user' AND id IN (${ph})`, [classId, ...ids]);
}

// ========== 大查询 ==========

async function fetchAdminData(activePanel = 'overview', pageQuery = {}) {
  const settings = await getSettings();
  const result = {
    settings,
    content: { features: [], quickLinks: [] },
    users: [],
    teacherOptions: [],
    classes: [],
    children: [],
    counts: {}
  };

  async function queryCounts() {
    const rows = await dbQuery(`
      SELECT
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM users WHERE enabled = 1) AS enabled_users,
        (SELECT COUNT(*) FROM classes) AS total_classes,
        (SELECT COUNT(*) FROM classes WHERE enabled = 1) AS enabled_classes,
        (SELECT COUNT(*) FROM children) AS total_children,
        (SELECT COUNT(*) FROM children WHERE enabled = 1) AS enabled_children,
        (SELECT COUNT(*) FROM children WHERE enabled = 1 AND needs_attention = 1
          AND (attention_start_date IS NULL OR attention_start_date <= CURDATE())
          AND (attention_end_date IS NULL OR attention_end_date >= CURDATE())) AS attention_children
    `);
    return rows[0] || {};
  }

  async function queryClasses() {
    return dbQuery(`
      SELECT c.id, c.name, c.grade_level, c.capacity, c.description, c.enabled, c.created_at,
             COALESCE((SELECT GROUP_CONCAT(u.name ORDER BY u.id SEPARATOR '、') FROM users u WHERE u.role = 'user' AND u.class_id = c.id), '') AS teacher_names,
             COALESCE((SELECT GROUP_CONCAT(u.id ORDER BY u.id SEPARATOR ',') FROM users u WHERE u.role = 'user' AND u.class_id = c.id), '') AS teacher_ids,
             (SELECT COUNT(*) FROM children ch WHERE ch.class_id = c.id AND ch.enabled = 1) AS child_count
      FROM classes c
      ORDER BY CASE c.grade_level WHEN 'small' THEN 1 WHEN 'middle' THEN 2 WHEN 'large' THEN 3 ELSE 99 END, c.id DESC
    `);
  }

  async function queryChildren() {
    return dbQuery(`
      SELECT ch.id, ch.name, ch.gender, ch.birth_date, ch.class_id, ch.enabled,
             ch.needs_attention AS attention_marked,
             CASE
               WHEN ch.needs_attention = 1
                 AND (ch.attention_start_date IS NULL OR ch.attention_start_date <= CURDATE())
                 AND (ch.attention_end_date IS NULL OR ch.attention_end_date >= CURDATE())
               THEN 1 ELSE 0
             END AS needs_attention,
             CASE
               WHEN ch.needs_attention <> 1 THEN 'normal'
               WHEN ch.attention_start_date IS NOT NULL AND ch.attention_start_date > CURDATE() THEN 'scheduled'
               WHEN ch.attention_end_date IS NOT NULL AND ch.attention_end_date < CURDATE() THEN 'expired'
               ELSE 'active'
             END AS attention_status,
             ch.attention_reason, ch.attention_start_date, ch.attention_end_date, ch.attention_tags, ch.attention_vest_type,
             ch.created_at, c.name AS class_name, c.grade_level
      FROM children ch LEFT JOIN classes c ON c.id = ch.class_id
      ORDER BY ch.enabled DESC, needs_attention DESC, ch.id DESC
    `);
  }

  if (activePanel === 'overview') {
    result.counts = await queryCounts();
    return result;
  }

  if (activePanel === 'site') {
    const [features, quickLinks] = await Promise.all([getHomeFeatures(true), getQuickLinks(true)]);
    result.content = { features, quickLinks };
    return result;
  }

  if (activePanel === 'users') {
    const [users, teacherOptions, classes] = await Promise.all([
      dbQuery(`
        SELECT u.id, u.username, u.role, u.name, u.birth_date, u.class_id, u.enabled, u.created_at, c.name AS class_name
        FROM users u LEFT JOIN classes c ON c.id = u.class_id
        ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.id DESC
      `),
      dbQuery(`SELECT id, name, username, birth_date, class_id, enabled FROM users WHERE role = 'user' ORDER BY enabled DESC, name ASC, id ASC`),
      queryClasses()
    ]);
    const keywordRaw = String(pageQuery.userKeyword || '').trim().toLowerCase();
    const classFilter = String(pageQuery.userClassId || '');
    const filteredUsers = users.filter((user) => {
      const haystack = [user.name, user.username, user.class_name, user.role === 'admin' ? '管理员' : '教师'].join(' ').toLowerCase();
      const matchKeyword = !keywordRaw || haystack.includes(keywordRaw);
      const matchClass = !classFilter || String(user.class_id || '') === classFilter;
      return matchKeyword && matchClass;
    });
    result.users = users;
    result.teacherOptions = teacherOptions;
    result.classes = classes;
    result.userPagination = paginateItems(filteredUsers, pageQuery.userPage, pageQuery.pageSize).pagination;
    return result;
  }

  if (activePanel === 'classes') {
    const [teacherOptions, classes] = await Promise.all([
      dbQuery(`SELECT id, name, username, birth_date, class_id, enabled FROM users WHERE role = 'user' ORDER BY enabled DESC, name ASC, id ASC`),
      queryClasses()
    ]);
    result.teacherOptions = teacherOptions;
    result.classes = classes;
    return result;
  }

  if (activePanel === 'children') {
    const [classes, children] = await Promise.all([queryClasses(), queryChildren()]);
    const keywordRaw = String(pageQuery.childKeyword || '').trim().toLowerCase();
    const classFilter = String(pageQuery.childClassId || '');
    const filteredChildren = children.filter((child) => {
      const haystack = [child.name, child.gender, child.class_name].join(' ').toLowerCase();
      const matchKeyword = !keywordRaw || haystack.includes(keywordRaw);
      const matchClass = !classFilter || String(child.class_id || '') === classFilter;
      return matchKeyword && matchClass;
    });
    result.classes = classes;
    result.children = children;
    result.childPagination = paginateItems(filteredChildren, pageQuery.childPage, pageQuery.pageSize).pagination;
    return result;
  }

  if (activePanel === 'attention') {
    const [classes, children, counts] = await Promise.all([queryClasses(), queryChildren(), queryCounts()]);
    const keywordRaw = String(pageQuery.attentionKeyword || '').trim().toLowerCase();
    const classFilter = String(pageQuery.attentionClassId || '');
    const statusFilter = String(pageQuery.attentionStatus || 'all');
    const filteredAttentionChildren = children.filter((child) => {
      const haystack = [child.name, child.class_name, child.gender, child.attention_reason, child.attention_tags, child.attention_vest_type].join(' ').toLowerCase();
      const matchKeyword = !keywordRaw || haystack.includes(keywordRaw);
      const matchClass = !classFilter || String(child.class_id || '') === classFilter;
      const status = String(child.attention_status || (child.needs_attention ? 'active' : 'normal'));
      const matchStatus = statusFilter === 'all'
        ? true
        : statusFilter === 'active'
          ? status === 'active'
          : statusFilter === 'scheduled'
            ? status === 'scheduled'
            : statusFilter === 'expired'
              ? status === 'expired'
              : status === 'normal';
      return matchKeyword && matchClass && matchStatus;
    });
    result.classes = classes;
    result.children = children;
    result.counts = counts;
    result.attentionPagination = paginateItems(filteredAttentionChildren, pageQuery.attentionPage, pageQuery.pageSize).pagination;
    return result;
  }

  if (activePanel === 'logs') {
    return result;
  }

  result.counts = await queryCounts();
  return result;
}

async function buildUserDashboard(user) {
  if (!user.classId) return { assignedClass: null, children: [] };
  const classRows = await dbQuery(
    `SELECT c.id, c.name, c.grade_level, c.capacity, c.description, c.enabled,
            COALESCE((SELECT GROUP_CONCAT(u.name ORDER BY u.id SEPARATOR '、') FROM users u WHERE u.role = 'user' AND u.class_id = c.id), '') AS teacher_names,
            (SELECT COUNT(*) FROM children ch WHERE ch.class_id = c.id AND ch.enabled = 1) AS child_count
     FROM classes c WHERE c.id = ? LIMIT 1`,
    [user.classId]
  );
  if (!classRows.length) return { assignedClass: null, children: [] };
  const children = await dbQuery(
    `SELECT ch.id, ch.name, ch.gender, ch.birth_date, ch.enabled,
            CASE
              WHEN ch.needs_attention = 1
                AND (ch.attention_start_date IS NULL OR ch.attention_start_date <= CURDATE())
                AND (ch.attention_end_date IS NULL OR ch.attention_end_date >= CURDATE())
              THEN 1 ELSE 0
            END AS needs_attention,
            CASE
              WHEN ch.needs_attention <> 1 THEN 'normal'
              WHEN ch.attention_start_date IS NOT NULL AND ch.attention_start_date > CURDATE() THEN 'scheduled'
              WHEN ch.attention_end_date IS NOT NULL AND ch.attention_end_date < CURDATE() THEN 'expired'
              ELSE 'active'
            END AS attention_status,
            ch.attention_reason, ch.attention_start_date, ch.attention_end_date, ch.attention_tags, ch.attention_vest_type
     FROM children ch
     WHERE ch.class_id = ? AND ch.enabled = 1
     ORDER BY needs_attention DESC, ch.name ASC, ch.id ASC`,
    [user.classId]
  );
  return { assignedClass: classRows[0], children };
}

// ========== 角色管理 (RBAC) ==========

async function getRoles() {
  return dbQuery('SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role = r.name) AS user_count FROM roles r ORDER BY r.is_system DESC, r.id ASC');
}

async function getRoleByName(name) {
  const rows = await dbQuery('SELECT * FROM roles WHERE name = ?', [name]);
  return rows[0] || null;
}

async function getRoleById(id) {
  const rows = await dbQuery('SELECT * FROM roles WHERE id = ?', [id]);
  return rows[0] || null;
}

async function createRole(name, displayName, permissions, isReadonly) {
  const permsJson = JSON.stringify(permissions);
  await dbQuery(
    'INSERT INTO roles (name, display_name, permissions, is_readonly, is_system) VALUES (?, ?, ?, ?, 0)',
    [name, displayName, permsJson, isReadonly ? 1 : 0]
  );
}

async function updateRole(id, displayName, permissions, isReadonly) {
  const role = await getRoleById(id);
  if (!role || role.name === 'admin') return; // admin 不可编辑
  const permsJson = JSON.stringify(permissions);
  await dbQuery(
    'UPDATE roles SET display_name = ?, permissions = ?, is_readonly = ? WHERE id = ?',
    [displayName, permsJson, isReadonly ? 1 : 0, id]
  );
}

async function deleteRole(id) {
  const role = await getRoleById(id);
  if (!role || role.name === 'admin') return false; // admin 不可删
  const users = await dbQuery('SELECT COUNT(*) AS cnt FROM users WHERE role = ?', [role.name]);
  if (users[0].cnt > 0) return false;
  await dbQuery('DELETE FROM roles WHERE id = ?', [id]);
  return true;
}

async function cloneRole(id, newName, newDisplayName) {
  const src = await getRoleById(id);
  if (!src) throw new Error('原角色不存在');
  await dbQuery(
    'INSERT INTO roles (name, display_name, permissions, is_readonly, is_system) VALUES (?, ?, ?, ?, 0)',
    [newName, newDisplayName, typeof src.permissions === 'string' ? src.permissions : JSON.stringify(src.permissions), src.is_readonly ? 1 : 0]
  );
}

async function getUserPermissions(roleName) {
  const role = await getRoleByName(roleName);
  if (!role) return { permissions: [], isReadonly: false, roleName: roleName, roleDisplayName: roleName };
  const perms = typeof role.permissions === 'string' ? JSON.parse(role.permissions) : role.permissions;
  return {
    permissions: perms,
    isReadonly: !!role.is_readonly,
    roleName: role.name,
    roleDisplayName: role.display_name
  };
}


// ========== AI Settings ==========

const AI_SETTING_KEYS = [
  'aiEnabled', 'aiBaseUrl', 'aiApiKey', 'aiModel', 'aiProviderName',
  'aiTimeoutMs', 'aiTemperature', 'aiMaxTokens', 'aiSystemPrompt'
];

function maskApiKey(key) {
  const text = String(key || '').trim();
  if (!text) return '';
  if (text.length <= 8) return '****';
  return text.slice(0, 4) + '****' + text.slice(-4);
}

async function getAiSettings(includeRawKey = false) {
  const settings = await getSettings();
  const ai = {};
  for (const k of AI_SETTING_KEYS) {
    ai[k] = settings[k] != null ? settings[k] : (DEFAULT_SETTINGS[k] || '');
  }
  if (!includeRawKey) {
    const raw = ai.aiApiKey || '';
    ai.aiApiKeyMasked = maskApiKey(raw);
    ai.aiApiKeyPresent = raw ? '1' : '';
    delete ai.aiApiKey;
  }
  return ai;
}

async function saveAiSettings(payload) {
  const writable = {};
  for (const k of AI_SETTING_KEYS) {
    if (payload[k] === undefined) continue;
    if (k === 'aiApiKey') {
      // 仅当显式提供了非空、非掩码值时才覆盖
      const raw = String(payload.aiApiKey || '').trim();
      if (!raw) continue;
      if (raw.includes('****')) continue;
      writable.aiApiKey = raw;
      continue;
    }
    writable[k] = String(payload[k] == null ? '' : payload[k]);
  }
  if (Object.keys(writable).length === 0) return;
  await saveSettings(writable);
}

async function clearAiApiKey() {
  await saveSettings({ aiApiKey: '' });
}

module.exports = {
  getPool,
  dbQuery,
  initDatabase,
  getSettings,
  saveSettings,
  getAiSettings,
  saveAiSettings,
  clearAiApiKey,
  AI_SETTING_KEYS,
  maskApiKey,
  getHomeFeatures,
  getQuickLinks,
  saveHomeContent,
  ensureClassByName,
  syncClassTeachers,
  fetchAdminData,
  buildUserDashboard,
  normalizePageNumber,
  normalizePageSize,
  paginateItems,
  DEFAULT_SETTINGS,
  getRoles,
  getRoleByName,
  getRoleById,
  createRole,
  updateRole,
  deleteRole,
  cloneRole,
  getUserPermissions
};
