"""Fill the supplied BIFF .xls template; preserve its original headers and grid."""
import copy
import io
import json
import os
import re
import sys
from collections import OrderedDict

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'vendor', 'exercise-python'))
import xlrd
import xlwt
from xlutils.filter import XLWTWriter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
UPPER = [('activity',2,5),('movement',5,13),('coverage',13,16),('ground',16,20),('equipment',20,27),('training',27,32),('interest',32,35),('participation',35,38)]
LOWER = [('complexion',3,7),('sweat',7,10),('breathing',10,13),('coordination',13,16),('attention',16,21),('spirit',21,24),('diet',24,27),('sleep',27,30),('intensity',30,34)]

def build(payload):
    template=xlrd.open_workbook(os.path.join(ROOT,'templates','exercise-monitor.xls'),formatting_info=True)
    writer=XLWTWriter();writer.start();writer.workbook(template,'exercise.xls')
    groups=OrderedDict()
    for row in payload['rows']:
        d=row['data'];key=(row['className'],d.get('inspector',''),d.get('teacher',''),d.get('caregiver',''))
        groups.setdefault(key,[]).append(row)
    page=0
    body=xlwt.easyxf('font: name SimSun, height 160; alignment: horiz center, vert center, wrap on; borders: left thin, right thin, top thin, bottom thin;')
    communication=xlwt.easyxf('font: name SimSun, height 160; alignment: horiz left, vert top, wrap on; borders: left thin, right thin, top thin, bottom thin;')
    date_style=copy.deepcopy(body);date_style.num_format_str='mm-dd'
    note=xlwt.easyxf('font: name SimSun, height 160; alignment: horiz left, vert top, wrap on;')
    for key,items in groups.items():
        for offset in range(0,len(items),15):
            page+=1;rows=items[offset:offset+15]
            for index in (0,1):
                rd=template.sheet_by_index(index)
                name=rd.name if len(groups)==1 and len(items)<=15 else re.sub(r'[\[\]:*?/\\]','',key[0])[:18]+('-上-' if index==0 else '-下-')+str(page)
                writer.sheet(rd,name)
                # Copy every formatted row as well as populated cells.
                for r in range(max(rd.nrows,max(rd.rowinfo_map.keys(),default=0)+1)):
                    writer.row(r,r)
                    if r<rd.nrows:
                        for c in range(rd.ncols):writer.cell(r,c,r,c)
                ws=writer.wtsheet;cols=39 if index==0 else 34
                ws.write(1,0,'班级：'+key[0]+'    检查者：'+key[1]+'    带班教师：'+key[2]+'    保育员：'+key[3],writer.style_list[rd.cell_xf_index(1,0)])
                first=4 if index==0 else 5
                for n in range(15):
                    r=first+n
                    for c in range(cols):ws.write(r,c,'',body)
                    ws.row(r).height=400;ws.row(r).height_mismatch=True
                    if n>=len(rows):continue
                    row=rows[n];d=row['data'];m=row.get('metrics',{})
                    if row.get('date'):
                        from datetime import datetime
                        ws.write(r,0,datetime.strptime(row['date'],'%Y-%m-%d'),date_style)
                    ws.write(r,1,row['name'],body)
                    for field,start,end in UPPER if index==0 else LOWER:
                        selected=d.get(field,[])
                        if not isinstance(selected,list):selected=[selected]
                        label_row=3 if index==0 else 4
                        for c in range(start,end):
                            if rd.cell_value(label_row,c) in selected:ws.write(r,c,'√',body)
                    if index==0:
                        message='未填写观察记录' if row.get('unrecorded') else d.get('communication','')
                        units=lambda s:sum(2 if ord(ch)>255 else 1 for ch in s)
                        if units(message)>250:
                            preview=''
                            for ch in message:
                                if units(preview+ch)>220:break
                                preview+=ch
                            message=preview+'…\n完整内容见“记录明细”。'
                        ws.write(r,38,message,communication)
                        lines=sum(max(1,(units(line)+10)//11) for line in message.split('\n'))
                        ws.row(r).height=min(8000,max(640,lines*260+200))
                    else:
                        ws.write(r,2,m['avg'] if m.get('avg') is not None else ('未填写' if row.get('unrecorded') else '无数据'),body)
                ws.portrait=False;ws.paper_size_code=9;ws.fit_width_to_pages=1;ws.fit_height_to_pages=0;ws.fit_num_pages=True
                ws.header_str=('&C'+payload['week']+' - '+payload['weekEnd']).encode('ascii')
                ws.footer_str=b'&C&P / &N'
                if index==0:
                    # Preserve the supplied exercise definitions below the 15 entry rows.
                    ws.row(19).height=1600;ws.row(19).height_mismatch=True
    wb=writer.wtbook
    detail=wb.add_sheet('记录明细',cell_overwrite_ok=True)
    headers=['周开始','周结束','班级','姓名','观察日期','开始时间','结束时间','记录状态','活动时段平均心率（次/分）','最低心率','最高心率','有效采样数','心率说明','最近采样时间','心率读取时间','检查者','带班教师','保育员','教师沟通','补充观察']
    title=xlwt.easyxf('font: name SimSun,bold on,colour white; pattern: pattern solid,fore_colour dark_green; alignment: wrap on,vert center;')
    detail.col(0).width=8000;detail.col(1).width=24500
    cursor=0
    for n,row in enumerate(payload['rows'],1):
        d=row['data'];m=row.get('metrics',{})
        values=[payload['week'],payload['weekEnd'],row['className'],row['name'],row.get('date',''),row.get('start',''),row.get('end',''),'未填写观察' if row.get('unrecorded') else ('已记录沟通' if d.get('communication') else '尚未记录沟通'),m.get('avg'),m.get('min'),m.get('max'),m.get('sample_count'),m.get('reason','') or ('按活动时段有效采样求平均' if m.get('sample_count') else ''),m.get('last_sample',''),m.get('captured_at',''),d.get('inspector',''),d.get('teacher',''),d.get('caregiver',''),d.get('communication',''),d.get('notes','')]
        detail.write_merge(cursor,cursor,0,1,'第 '+str(n)+' 条 · '+row['className']+' · '+row['name'],title);detail.row(cursor).height=500;cursor+=1
        for h,v in zip(headers,values):
            v='' if v is None else v
            # Keep long communications printable by continuing them on additional rows.
            chunks=[v] if not isinstance(v,str) or len(v)<=500 else [v[i:i+500] for i in range(0,len(v),500)]
            for i,chunk in enumerate(chunks):
                detail.write(cursor,0,h if i==0 else h+'（续）',body);detail.write(cursor,1,chunk,communication)
                detail.row(cursor).height=max(360,((len(str(chunk))+45)//46)*240);detail.row(cursor).height_mismatch=True;cursor+=1
        cursor+=1
    detail.portrait=True;detail.paper_size_code=9;detail.fit_num_pages=True;detail.fit_width_to_pages=1;detail.fit_height_to_pages=0
    output=io.BytesIO();wb.save(output);return output.getvalue()

if __name__=='__main__':
    sys.stdout.buffer.write(build(json.load(sys.stdin)))
