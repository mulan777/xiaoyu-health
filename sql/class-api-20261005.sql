-- ============================================================================
-- class-api-20261005.sql — 班级只读查询 API 迁移
-- 仅新建 2 张表：class_api_keys（按班 API Key，存 sha256 哈希）
--               class_api_logs（调用审计）
-- 不动任何现有表。 charset utf8mb4。
-- 执行： mysql -u kindergarten_app --default-character-set=utf8mb4 kindergarten_platform < class-api-20261005.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS `class_api_keys` (
  `id` int NOT NULL AUTO_INCREMENT,
  `key_hash` char(64) NOT NULL COMMENT 'API Key 的 sha256 十六进制（不存明文）',
  `key_prefix` varchar(12) NOT NULL DEFAULT '' COMMENT 'Key 前缀，仅用于后台辨识',
  `class_id` int NOT NULL COMMENT '绑死班级，鉴权后一切数据 scope 由此派生',
  `label` varchar(100) NOT NULL DEFAULT '' COMMENT '备注/用途',
  `enabled` tinyint(1) NOT NULL DEFAULT 1 COMMENT '1启用 0停用',
  `last_used_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_api_key_hash` (`key_hash`),
  KEY `idx_api_key_class` (`class_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='班级只读查询 API 密钥';

CREATE TABLE IF NOT EXISTS `class_api_logs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `key_id` int DEFAULT NULL COMMENT 'class_api_keys.id（鉴权失败时为空）',
  `class_id` int DEFAULT NULL,
  `endpoint` varchar(64) NOT NULL DEFAULT '' COMMENT '如 summary/children',
  `params` varchar(500) NOT NULL DEFAULT '' COMMENT '查询串（已剔除 key）',
  `ip` varchar(64) NOT NULL DEFAULT '',
  `status` int NOT NULL DEFAULT 0 COMMENT 'HTTP 状态码',
  `duration_ms` int NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_api_log_key` (`key_id`),
  KEY `idx_api_log_class_time` (`class_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='班级只读查询 API 调用审计';