const { dbQuery } = require('./db');
const { createBandCache } = require('./band-cache');
const cached = createBandCache(5000, 64);

async function recentClassRecords(classId, limit = 30, timeWindow = '') {
  const size = limit === 10 ? 10 : 30;
  return cached([classId, size, timeWindow].join('|'), async () => {
    const mappings = await dbQuery(`SELECT m.band_mac FROM band_mapping m
      JOIN children ch ON ch.id = m.child_id WHERE ch.class_id = ?`, [classId]);
    if (!mappings.length) return [];
    // The class-wide JOIN+sort used to read hundreds of thousands of rows
    // for just 10/30 results. Take at most that many from each MAC's index.
    const parts = mappings.map(() => `(SELECT r.id, r.bp_time FROM band_records r FORCE INDEX (idx_band_time)
      WHERE r.band_mac = ? ${timeWindow ? 'AND ' + timeWindow : ''}
      ORDER BY r.bp_time DESC, r.id DESC LIMIT ${size})`);
    return dbQuery(`SELECT b.id, b.band_mac, b.gw_addr, b.bp_time, b.heart_rate, b.body_temp,
        b.systolic, b.diastolic, b.spo2, b.steps, b.battery, b.sos,
        m.child_id, ch.name AS child_name, c.name AS class_name, c.id AS class_id
      FROM (SELECT id, bp_time FROM (${parts.join(' UNION ALL ')}) candidates
        ORDER BY bp_time DESC, id DESC LIMIT ${size}) recent
      JOIN band_records b ON b.id = recent.id
      JOIN band_mapping m ON m.band_mac = b.band_mac
      JOIN children ch ON ch.id = m.child_id AND ch.class_id = ?
      LEFT JOIN classes c ON c.id = ch.class_id
      ORDER BY b.bp_time DESC, b.id DESC`, [...mappings.map(m => m.band_mac), classId]);
  });
}

module.exports = { recentClassRecords };
