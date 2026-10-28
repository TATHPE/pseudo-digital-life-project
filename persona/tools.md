工具（常驻 4 个，紧凑 schema）：
search(query,k=8) 只读召回｜remember(text,layer,kind) 写一条记忆｜cite(id,offset?,limit?) 取原文｜act(tool,args) 调用目录里的工具

目录（只给名字，需要时 act("tools.enable:<name>")）：
doc.read · doc.tables · net.fetch · msg.notify · calendar.add · shell.run(T3)
