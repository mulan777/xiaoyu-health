const path=require('path');
const {spawn}=require('child_process');
const {dbQuery,getSettings,getStudentDisplayMap,maskDisplayName}=require('../lib/db');
const {requireRole,hasPermission}=require('../lib/helpers');
const {requireBandTeacher}=require('../lib/band-access');
const {audit,errorLog}=require('../lib/logger');
const F=require('../lib/exercise-focus');

module.exports=async function mountExerciseFocus(app){
  await F.init();
  for(const teacher of [true,false]){
    const base=teacher?'/user/exercise-focus':'/admin/exercise-focus';
    const role=requireRole(teacher?'user':'admin');
    const run=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){if(e.status)return res.status(e.status).render('error',{message:e.message});next(e);}};
    async function scope(req,res,write=false){
      const u=req.session.user;
      if(!teacher&&!hasPermission(u,'booking.attention.view'))F.fail('无权查看每周锻炼监测',403);
      if(write&&(u.isReadonly||(!teacher&&!hasPermission(u,'booking.attention.edit'))))F.fail('当前账号无权修改记录',403);
      let enabled=[];
      if(teacher){const s=await requireBandTeacher(req,res);if(!s)return null;enabled=[s.classId];}
      else{const s=await getSettings();enabled=F.json(s.bandEnabledClasses,[]);if(!Array.isArray(enabled))enabled=[];enabled=enabled.map(Number).filter(Number.isSafeInteger);}
      const w=F.week(req.method==='POST'?req.body.week:req.query.week);
      const input=req.method==='POST'?req.body.classId:req.query.classId;
      const classId=teacher?Number(u.classId||u.class_id):(input?F.positive(input):0);
      if(teacher&&input&&Number(input)!==classId)F.fail('无权查看其他班级',403);
      if(write&&(!classId||!enabled.includes(classId)))F.fail('仅已开通手环的班级可以新增或修改',403);
      const classes=await dbQuery(`SELECT c.id,c.name FROM classes c WHERE ${teacher?'c.id=?':`c.id IN (${enabled.length?enabled.map(()=>'?').join(','):'NULL'}) OR EXISTS (SELECT 1 FROM exercise_focus_weeks w WHERE w.class_id=c.id)`} ORDER BY c.id`,teacher?[classId]:enabled);
      if(classId&&!classes.some(c=>Number(c.id)===classId))F.fail('班级不可用',403);
      return {base,teacher,u,enabled,classes,classId,w,canWrite:!u.isReadonly&&(teacher||hasPermission(u,'booking.attention.edit'))&&enabled.includes(classId)};
    }
    function query(s,extra={}){return s.base+'?'+new URLSearchParams({week:s.w,...(s.classId?{classId:String(s.classId)}:{}),...extra});}
    async function load(s){
      const params=[s.w];let filter='';if(s.classId){filter=' AND w.class_id=?';params.push(s.classId);}
      const members=await dbQuery(`SELECT m.*,w.class_id,c.name AS class_name,
          (SELECT COUNT(*) FROM exercise_monitor_records r WHERE r.week_id=m.week_id AND r.child_id=m.child_id) AS record_count
          FROM exercise_focus_members m JOIN exercise_focus_weeks w ON w.id=m.week_id JOIN classes c ON c.id=w.class_id
          WHERE w.week_start=?${filter} ORDER BY c.id,m.active DESC,m.id`,params);
      const records=await dbQuery(`SELECT r.*,w.class_id,DATE_FORMAT(r.observed_date,'%Y-%m-%d') AS date_text,
          DATE_FORMAT(r.updated_at,'%Y-%m-%d %H:%i') AS updated_text,u.name AS author_name
          FROM exercise_monitor_records r JOIN exercise_focus_weeks w ON w.id=r.week_id
          LEFT JOIN users u ON u.id=r.updated_by WHERE w.week_start=?${filter} ORDER BY r.observed_date DESC,r.start_time DESC,r.id DESC`,params);
      for(const r of records){r.data=F.json(r.payload_json);r.metrics=F.json(r.metrics_json);}
      return {members,records};
    }
    app.get(base,role,run(async(req,res)=>{
      const s=await scope(req,res);if(!s)return;
      const {members,records}=await load(s);
      const roster=s.classId?await dbQuery('SELECT id,name FROM children WHERE class_id=? AND enabled=1 ORDER BY name,id',[s.classId]):[];
      // Keep historical selections visible after a child changes class or is disabled.
      for(const m of members)if(!roster.some(ch=>Number(ch.id)===Number(m.child_id)))roster.push({id:m.child_id,name:m.child_name,historical:true});
      const dm=await getStudentDisplayMap();for(const ch of roster)ch.display_name=maskDisplayName(dm,(s.classes.find(c=>Number(c.id)===s.classId)||{}).name,ch.name);
      for(const m of members)m.display_name=maskDisplayName(dm,m.class_name,m.child_name);
      for(const r of records)r.display_name=maskDisplayName(dm,r.class_name,r.child_name);
      const [wr]=s.classId?await dbQuery('SELECT revision FROM exercise_focus_weeks WHERE class_id=? AND week_start=?',[s.classId,s.w]):[];
      const editId=req.query.recordId?F.positive(req.query.recordId):0;
      const editing=editId?records.find(r=>Number(r.id)===editId):null;if(editId&&!editing)F.fail('该记录不在当前班级或周次范围',404);
      const requestedView=['list','write','history'].includes(req.query.view)?req.query.view:'';
      const activeMembers=members.filter(m=>m.active);
      let childId=editing?Number(editing.child_id):(req.query.childId?F.positive(req.query.childId):0);
      let pageView=!s.classId?'overview':(editing||childId?'write':requestedView||((s.canWrite&&activeMembers.length)?'write':'list'));
      if(pageView==='write'&&!childId&&activeMembers.length)childId=Number(activeMembers[0].child_id);
      const selectedMember=childId?members.find(m=>Number(m.child_id)===childId&&(m.active||editing)):null;
      if(childId&&!selectedMember)F.fail('请先将幼儿加入本周重点关注名单',400);
      const date=editing?editing.date_text:(F.today()>=s.w&&F.today()<F.plus(s.w,7)?F.today():s.w);
      const classStats=s.classes.map(c=>{const m=members.filter(m=>Number(m.class_id)===Number(c.id)&&m.active),r=records.filter(r=>Number(r.class_id)===Number(c.id));return {...c,focusCount:m.length,recordCount:r.length,communicationCount:r.filter(r=>r.data.communication).length,pendingCount:r.filter(r=>!r.data.communication).length};});
      const activeChildIndex=activeMembers.findIndex(m=>Number(m.child_id)===childId);
      const nextMember=activeMembers.length>1?activeMembers[(activeChildIndex+1)%activeMembers.length]:null;
      res.render('exercise-focus-v2',{...s,members,activeMembers,classStats,pageView,nextMember,records,roster,editing,childId,selectedMember,date,weekEnd:F.plus(s.w,6),revision:wr?wr.revision:0,
        groups:F.GROUPS,sections:['活动情况','活动中监测','活动后监测'],url:extra=>query(s,extra),data:editing?editing.data:{teacher:s.u.name||'',inspector:'',caregiver:''},
        pageClass:'exercise-focus-page',pageTitleOverride:'每周锻炼监测 · 小鱼健康',message:req.query.saved?'已保存；心率已按活动时段自动带入。':(req.query.selectionSaved?'本周重点关注名单已保存。':'')});
    }));
    app.post(base+'/selection',role,run(async(req,res)=>{
      const s=await scope(req,res,true);if(!s)return;
      const raw=req.body.childIds==null?[]:(Array.isArray(req.body.childIds)?req.body.childIds:[req.body.childIds]);const ids=[...new Set(raw.map(F.positive))];
      const version=Number(req.body.revision);if(!Number.isSafeInteger(version)||version<0)F.fail('名单版本不正确');
      await F.transaction(async c=>{
        await c.execute('INSERT IGNORE INTO exercise_focus_weeks(class_id,week_start,updated_by) VALUES(?,?,?)',[s.classId,s.w,s.u.id]);
        const [[w]]=await c.execute('SELECT id,revision FROM exercise_focus_weeks WHERE class_id=? AND week_start=? FOR UPDATE',[s.classId,s.w]);
        if(Number(w.revision)!==version)F.fail('另一位老师已更新名单，请刷新后重试。',409);
        const [currentChildren]=await c.execute('SELECT id,name FROM children WHERE class_id=? AND enabled=1',[s.classId]);
        const [pastChildren]=await c.execute('SELECT child_id AS id,child_name AS name FROM exercise_focus_members WHERE week_id=?',[w.id]);
        const eligible=[...currentChildren,...pastChildren];
        if(ids.some(id=>!eligible.some(ch=>Number(ch.id)===id)))F.fail('包含不属于本班的幼儿',403);
        await c.execute('UPDATE exercise_focus_members SET active=0 WHERE week_id=?',[w.id]);
        for(const id of ids){const ch=eligible.find(ch=>Number(ch.id)===id);await c.execute(`INSERT INTO exercise_focus_members(week_id,child_id,child_name,active) VALUES(?,?,?,1) ON DUPLICATE KEY UPDATE active=1`,[w.id,id,ch.name]);}
        await c.execute('UPDATE exercise_focus_weeks SET revision=revision+1,updated_by=? WHERE id=?',[s.u.id,w.id]);
      });
      audit('exercise_focus_selection_saved',{actor:s.u,ip:req.ip,classId:s.classId,week:s.w,count:ids.length});res.redirect(303,query(s,{selectionSaved:'1'}));
    }));
    app.get(base+'/metrics',role,run(async(req,res)=>{
      const s=await scope(req,res);if(!s)return;const childId=F.positive(req.query.childId);const date=F.day(req.query.date);
      if(date<s.w||date>=F.plus(s.w,7))F.fail('活动日期须在所选周内');
      const {members}=await load(s);if(!members.some(m=>Number(m.child_id)===childId))F.fail('无权查看该幼儿数据',403);
      res.json({ok:true,metrics:await F.metrics(childId,date,req.query.start,req.query.end)});
    }));
    app.post(base+'/record',role,run(async(req,res)=>{
      const s=await scope(req,res,true);if(!s)return;
      const childId=F.positive(req.body.childId),date=F.day(req.body.date),start=F.time(req.body.start),end=F.time(req.body.end);
      if(date<s.w||date>=F.plus(s.w,7))F.fail('活动日期须在所选周内');if(start>=end)F.fail('结束时间须晚于开始时间');
      const data=F.payload(req.body);const recordId=req.body.recordId?F.positive(req.body.recordId):0;
      const [w]=await dbQuery('SELECT id FROM exercise_focus_weeks WHERE class_id=? AND week_start=?',[s.classId,s.w]);if(!w)F.fail('请先保存本周重点关注名单');
      const [member]=await dbQuery('SELECT * FROM exercise_focus_members WHERE week_id=? AND child_id=?',[w.id,childId]);if(!member)F.fail('该幼儿不在本周名单',403);
      const [old]=recordId?await dbQuery("SELECT *,DATE_FORMAT(observed_date,'%Y-%m-%d') AS date_text FROM exercise_monitor_records WHERE id=? AND week_id=? AND child_id=?",[recordId,w.id,childId]):[];
      if(recordId&&!old)F.fail('无权修改此记录',403);if(!recordId&&!member.active)F.fail('该幼儿已取消本周关注，请先重新勾选');
      let metric=old?F.json(old.metrics_json):null;
      if(!old||req.body.refreshMetrics==='1'||old.date_text!==date||old.start_time!==start||old.end_time!==end)metric=await F.metrics(childId,date,start,end);
      let savedRecordId=recordId;
      await F.transaction(async c=>{
        const [[lock]]=await c.execute('SELECT id FROM exercise_focus_weeks WHERE id=? FOR UPDATE',[w.id]);
        const [[current]]=await c.execute('SELECT active FROM exercise_focus_members WHERE week_id=? AND child_id=?',[lock.id,childId]);
        if(!recordId&&!current.active)F.fail('本周名单已更新，请刷新后重试',409);
        if(recordId){const [result]=await c.execute(`UPDATE exercise_monitor_records SET observed_date=?,start_time=?,end_time=?,payload_json=?,metrics_json=?,updated_by=?,revision=revision+1 WHERE id=? AND week_id=? AND revision=?`,[date,start,end,JSON.stringify(data),JSON.stringify(metric),s.u.id,recordId,w.id,Number(req.body.recordRevision)]);if(!result.affectedRows)F.fail('此记录已被其他老师修改，请刷新后重试。',409);}
        else {const [inserted]=await c.execute(`INSERT INTO exercise_monitor_records(week_id,child_id,child_name,class_name,observed_date,start_time,end_time,payload_json,metrics_json,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[w.id,childId,member.child_name,s.classes.find(c=>Number(c.id)===s.classId).name,date,start,end,JSON.stringify(data),JSON.stringify(metric),s.u.id,s.u.id]);savedRecordId=inserted.insertId;}
      });
      audit('exercise_monitor_saved',{actor:s.u,ip:req.ip,recordId:savedRecordId,classId:s.classId,week:s.w,childId});
      if(req.body.action==='next'){
        const nextMembers=await dbQuery('SELECT child_id FROM exercise_focus_members WHERE week_id=? AND active=1 ORDER BY id',[w.id]);
        if(nextMembers.length>1){const at=nextMembers.findIndex(m=>Number(m.child_id)===childId);const next=nextMembers[(at+1)%nextMembers.length];return res.redirect(303,query(s,{saved:'1',childId:String(next.child_id),view:'write'}));}
      }
      res.redirect(303,query(s,{saved:'1',recordId:String(savedRecordId),view:'write'}));
    }));
    app.get(base+'/export',role,run(async(req,res)=>{
      const s=await scope(req,res);if(!s)return;const {members,records}=await load(s);
      if(!records.length&&!members.some(m=>m.active))F.fail('本周暂无关注名单或监测记录可导出');
      const rows=records.map(r=>({id:r.id,childId:r.child_id,name:r.child_name,classId:r.class_id,className:r.class_name,date:r.date_text,start:r.start_time,end:r.end_time,data:r.data,metrics:r.metrics}));
      for(const m of members)if(m.active&&!rows.some(r=>Number(r.childId)===Number(m.child_id)&&Number(r.classId)===Number(m.class_id)))rows.push({childId:m.child_id,name:m.child_name,classId:m.class_id,className:m.class_name,date:'',data:{},metrics:{},unrecorded:true});
      const buffer=await new Promise((resolve,reject)=>{
        const child=spawn(process.env.EXERCISE_EXPORT_PYTHON||'python3',[path.join(__dirname,'../scripts/export-exercise.py')],{stdio:['pipe','pipe','pipe']});
        const out=[],err=[];let size=0;const timer=setTimeout(()=>{child.kill();reject(new Error('导出超时'));},60000);
        child.stdout.on('data',d=>{size+=d.length;if(size>32*1024*1024){child.kill();return;}out.push(d);});child.stderr.on('data',d=>err.push(d));
        child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);if(code===0)resolve(Buffer.concat(out));else reject(new Error('Excel export failed: '+Buffer.concat(err).toString().slice(0,500)));});
        child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({week:s.w,weekEnd:F.plus(s.w,6),rows}));
      });
      audit('exercise_monitor_export',{actor:s.u,ip:req.ip,classId:s.classId,week:s.w,count:records.length});
      res.set('Content-Type','application/vnd.ms-excel');res.attachment('体格锻炼监测表_'+s.w+'.xls');res.send(buffer);
    }));
  }
};
