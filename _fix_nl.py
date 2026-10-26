# -*- coding: utf-8 -*-
"""修 settings.js 里被 heredoc 转义搞坏的两个正则/字符串（写完自删）"""
import io

P = "E:/For WorkBuddy/2026-10-11-09-17-47/deeplink-open/settings.js"
s = io.open(P, encoding="utf-8", newline="").read()

# 1) split(/<换行>  →  split(/\r?\n
bad1 = "split(/?" + chr(13) + chr(10) + "/).forEach"
bad1b = "split(/?" + chr(10) + "/).forEach"
good1 = "split(/\\r?\\n/).forEach"
n1 = s.count(bad1) + s.count(bad1b)
s = s.replace(bad1, good1).replace(bad1b, good1)

# 2) join("<换行>")  →  join("\n")
bad2 = 'join("' + chr(13) + chr(10) + '")'
bad2b = 'join("' + chr(10) + '")'
good2 = 'join("\\n")'
n2 = s.count(bad2) + s.count(bad2b)
s = s.replace(bad2, good2).replace(bad2b, good2)

io.open(P, "w", encoding="utf-8", newline="").write(s)
print("fixed:", n1, n2)
