const { dbQuery, getPool } = require('./db');
const GROUPS = [
  {key:'activity',label:'活动内容',multi:true,options:['集体操','自由活动','分散活动'],section:'活动情况'},
  {key:'movement',label:'活动方式',multi:true,options:['跑','跳','站','走','爬','钻','投掷','悬挂'],section:'活动情况'},
  {key:'coverage',label:'活动度',options:['全体儿童','大部分儿童','少数儿童'],section:'活动情况'},
  {key:'ground',label:'活动场地',multi:true,options:['平整','无障碍','有障碍','凹凸不平'],section:'活动情况'},
  {key:'equipment',label:'活动器材',multi:true,options:['球','绳','投掷器材','平衡器','滑动器材','抓杠器材','其他'],section:'活动情况'},
  {key:'training',label:'锻炼部位',multi:true,options:['肌肉力量','肌肉柔韧性','平衡能力','反应灵敏度','其他'],section:'活动情况'},
  {key:'interest',label:'参与度 · 兴趣',options:['很有兴趣','兴趣一般','无兴趣'],section:'活动情况'},
  {key:'participation',label:'参与度 · 参与范围',options:['全部','大部分','少数'],section:'活动情况'},
  {key:'complexion',label:'面色',options:['如常','稍红','红','苍白'],section:'活动中监测'},
  {key:'sweat',label:'汗量',options:['正常','大量出汗','无汗'],section:'活动中监测'},
  {key:'breathing',label:'呼吸',options:['急促','稍快','平稳'],section:'活动中监测'},
  {key:'coordination',label:'动作',options:['协调','略失调','不协调'],section:'活动中监测'},
  {key:'attention',label:'注意力（反应）',options:['正常','尚可','弱','迟钝','其他'],section:'活动中监测'},
  {key:'spirit',label:'精神',options:['愉快','倦意','疲乏'],section:'活动中监测'},
  {key:'diet',label:'饮食',options:['增加','一般','下降'],section:'活动后监测'},
  {key:'sleep',label:'睡眠',options:['好','一般','入睡困难'],section:'活动后监测'},
  {key:'intensity',label:'强度评价',options:['正常','适度疲劳','中度疲劳','重度疲劳'],section:'活动后监测'}
];
function fail(message,status=400){const e=new Error(message);e.status=status;throw e;}
function day(value){
  const s=String(value||'');const d=new Date(s+'T00:00:00Z');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==s)fail('日期格式不正确');
  return s;
}
function today(){return new Date(Date.now()+8*3600000).toISOString().slice(0,10);}
function plus(date,n){const d=new Date(day(date)+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
function week(value){const s=day(value||today());const d=new Date(s+'T00:00:00Z');return plus(s,-((d.getUTCDay()+6)%7));}
function positive(value){const n=Number(value);if(!Number.isSafeInteger(n)||n<=0)fail('编号不正确');return n;}
function text(value,max){if(value!=null&&typeof value!=='string')fail('填写内容格式不正确');const s=String(value||'').trim();if(s.length>max)fail('填写内容过长');return s;}
function time(value){const s=String(value||'');if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(s))fail('请填写正确的活动起止时间');return s;}
function payload(body){
  const p={};for(const g of GROUPS){const v=body[g.key];if(g.multi){const a=v==null?[]:(Array.isArray(v)?v:[v]);if(a.some(x=>!g.options.includes(x)))fail(g.label+'选项不正确');p[g.key]=[...new Set(a)];}else{if(v&& !g.options.includes(v))fail(g.label+'选项不正确');p[g.key]=v||'';}}
  for(const [key,max] of Object.entries({inspector:80,teacher:80,caregiver:80,communication:6000,notes:3000}))p[key]=text(body[key],max);
  return p;
}
function json(value,fallback={}){if(value&&typeof value==='object')return value;try{return JSON.parse(value||'null')||fallback;}catch(_){return fallback;}}
async function init(){
  await dbQuery(`CREATE TABLE IF NOT EXISTS exercise_focus_weeks (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, class_id INT NOT NULL, week_start DATE NOT NULL,
    revision INT UNSIGNED NOT NULL DEFAULT 0, updated_by INT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY class_week (class_id,week_start)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await dbQuery(`CREATE TABLE IF NOT EXISTS exercise_focus_members (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, week_id INT UNSIGNED NOT NULL, child_id INT NOT NULL,
    child_name VARCHAR(100) NOT NULL, active TINYINT NOT NULL DEFAULT 1,
    UNIQUE KEY week_child (week_id,child_id), KEY child_idx (child_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await dbQuery(`CREATE TABLE IF NOT EXISTS exercise_monitor_records (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, week_id INT UNSIGNED NOT NULL, child_id INT NOT NULL,
    child_name VARCHAR(100) NOT NULL, class_name VARCHAR(100) NOT NULL,
    observed_date DATE NOT NULL, start_time CHAR(5) NOT NULL, end_time CHAR(5) NOT NULL,
    payload_json JSON NOT NULL, metrics_json JSON NOT NULL,
    revision INT UNSIGNED NOT NULL DEFAULT 1, created_by INT NOT NULL, updated_by INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY week_child (week_id,child_id), KEY observed_idx (observed_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}
async function transaction(fn){const c=await getPool().getConnection();try{await c.beginTransaction();const v=await fn(c);await c.commit();return v;}catch(e){await c.rollback();throw e;}finally{c.release();}}
async function metrics(childId,date,start,end){
  positive(childId);day(date);time(start);time(end);if(start>=end)fail('结束时间须晚于开始时间');
  const mappings=await dbQuery('SELECT band_mac FROM band_mapping WHERE child_id=?',[childId]);
  const macs=mappings.map(m=>m.band_mac);const result={source:'band_records',date,start,end,macs,sample_count:0,avg:null,min:null,max:null,last_sample:null,captured_at:new Date().toISOString()};
  if(!macs.length)return {...result,reason:'未绑定手环'};
  // Multiple gateways can relay the same packet. Count one sample per band and timestamp.
  const [r]=await dbQuery(`SELECT COUNT(*) AS n,ROUND(AVG(hr)) AS avg_hr,MIN(hr) AS min_hr,MAX(hr) AS max_hr,
      DATE_FORMAT(MAX(bp_time),'%Y-%m-%d %H:%i:%s') AS last_sample FROM (
      SELECT band_mac,bp_time,MAX(heart_rate) AS hr FROM band_records
      WHERE band_mac IN (${macs.map(()=>'?').join(',')}) AND bp_time>=? AND bp_time<? AND heart_rate>0
      GROUP BY band_mac,bp_time) samples`,[...macs,date+' '+start+':00',date+' '+end+':00']);
  return {...result,sample_count:Number(r.n),avg:r.avg_hr==null?null:Number(r.avg_hr),min:r.min_hr==null?null:Number(r.min_hr),max:r.max_hr==null?null:Number(r.max_hr),last_sample:r.last_sample,reason:Number(r.n)?'':'所选活动时段暂无有效心率'};
}
module.exports={GROUPS,fail,day,today,plus,week,positive,text,time,payload,json,init,transaction,metrics};
