'use strict';

// YT9 §7.8: Unicode content packet(s), then FF + teacher message source 01.
// Keep frames within the baseline 20-byte ATT payload; never split a UTF-16 pair.
function messageFrames(text, encoding = 'utf16le') {
  const safe = Array.from(String(text || '').replace(/[\x00-\x1f]/g, ' ')).slice(0, 60).join('');
  const parts = [];
  let part = Buffer.alloc(0);
  for (const ch of safe) {
    const bytes = Buffer.from(ch, 'utf16le');
    if (encoding === 'utf16be') bytes.swap16();
    if (part.length + bytes.length > 14) { parts.push(part); part = Buffer.alloc(0); }
    part = Buffer.concat([part, bytes]);
  }
  if (part.length) parts.push(part);
  return [...parts.map((b, i) => Buffer.concat([Buffer.from([0xa0, 0x04, 0x0b, i, b.length]), b])), Buffer.from([0xa0, 0x04, 0x0b, 0xff, 0x01])];
}

function createTeacherLink({query, vibrate, isBusy, pickGw}) {
  let mappingCache = null, loading;
  const inFlight = new Set();
  async function mappings(force = false) {
    if (!force && mappingCache && Date.now() - mappingCache.at < 10000) return mappingCache.rows;
    if (loading) return loading;
    loading = query(`SELECT t.*, c.name AS class_name FROM band_teacher_mapping t JOIN classes c ON c.id=t.class_id`)
      .then(([rows]) => { mappingCache = {at: Date.now(), rows}; return rows; })
      .finally(() => { loading = null; });
    return loading;
  }
  async function isTeacher(mac) { return (await mappings()).some(t => t.band_mac === mac); }
  async function enqueue(childMac, childCommandId, seconds, reason) {
    const teachers = await mappings();
    if (teachers.some(t => t.band_mac === childMac)) return 0; // no recursive teacher → teacher link
    const [children] = await query(`SELECT ch.id AS child_id,ch.name AS child_name,ch.class_id,c.name AS class_name
      FROM band_mapping m JOIN children ch ON ch.id=m.child_id JOIN classes c ON c.id=ch.class_id
      WHERE m.band_mac=? AND ch.enabled=1 AND c.enabled=1 LIMIT 1`, [childMac]);
    if (!children.length) return 0;
    const child = children[0];
    const targets = teachers.filter(t => t.enabled && t.class_id === child.class_id);
    const text = `${child.class_name} ${child.child_name} ${String(reason || '手环震动提醒').slice(0, 35)}`;
    for (const t of targets) {
      const configured = Number(t.vibrate_seconds);
      const duration = Number.isInteger(configured) && configured >= 1 && configured <= 60 ? configured : 15;
      await query(`INSERT IGNORE INTO band_teacher_notifications
        (child_command_id,child_mac,child_id,child_name,class_id,teacher_mac,message_text,vibrate_seconds,expires_at)
        VALUES (?,?,?,?,?,?,?,?,DATE_ADD(NOW(),INTERVAL 3 MINUTE))`,
      [childCommandId,childMac,child.child_id,child.child_name,child.class_id,t.band_mac,text,duration]);
    }
    return targets.length;
  }
  async function tick() {
    await query(`UPDATE band_teacher_notifications SET status='expired',error_msg='超过3分钟未能送达（离线或忙碌）'
      WHERE status='queued' AND expires_at<=NOW()`);
    const [jobs] = await query(`SELECT n.* FROM band_teacher_notifications n
      JOIN band_teacher_mapping t ON t.band_mac=n.teacher_mac AND t.class_id=n.class_id AND t.enabled=1
      WHERE n.status='queued' AND n.expires_at>NOW() ORDER BY n.id LIMIT 100`);
    for (const job of jobs) {
      if (inFlight.has(job.teacher_mac) || isBusy(job.teacher_mac) || !pickGw(job.teacher_mac)) continue;
      inFlight.add(job.teacher_mac);
      // Run each watch independently; database claims prevent duplicate sends.
      (async () => {
        const [claim] = await query(`UPDATE band_teacher_notifications SET status='sending' WHERE id=? AND status='queued'`, [job.id]);
        if (!claim.affectedRows) return;
        const result = await vibrate(job.teacher_mac, job.vibrate_seconds, 'teacher_link', job.message_text,
          {text: job.message_text, child: {child_id:job.child_id,child_name:job.child_name}});
        await query(`UPDATE band_teacher_notifications SET status=?,command_id=?,message_acked=?,error_msg=? WHERE id=?`,
          [result.ok ? 'sent' : 'failed',result.cmdId || null,result.messageAcked ? 1 : 0,
            result.error || (result.messageAcked ? null : '震动已下发，文字未获手环确认，需核对屏幕'),job.id]);
      })().catch(async e => {
        await query(`UPDATE band_teacher_notifications SET status='failed',error_msg=? WHERE id=?`, [String(e.message).slice(0,255),job.id]).catch(() => {});
      }).finally(() => inFlight.delete(job.teacher_mac));
    }
  }
  async function recover() {
    await query(`UPDATE band_teacher_notifications SET status='failed',error_msg='服务重启，发送结果未确认，请查看下发记录' WHERE status='sending'`);
  }
  return {mappings,isTeacher,enqueue,tick,recover};
}
module.exports = {messageFrames,createTeacherLink};
