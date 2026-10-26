# -*- coding: utf-8 -*-
"""修 settings.js 第 3364 行：split(/ CR ? LF /) → split(/\\r?\\n/)（写完自删）"""
import io

P = "E:/For WorkBuddy/2026-10-11-09-17-47/deeplink-open/settings.js"
s = io.open(P, encoding="utf-8", newline="").read()

bad = "split(/" + chr(13) + "?" + chr(10) + "/).forEach"
good = "split(/\\r?\\n/).forEach"
n = s.count(bad)
s = s.replace(bad, good)
io.open(P, "w", encoding="utf-8", newline="").write(s)
print("fixed:", n)
