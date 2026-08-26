#!/usr/bin/env python3
"""Достаёт поурочные списки слов из «Eesti keele sõnavihik A2» (Settle in Estonia).

    python tools/book.py list  sonavihik.pdf          # оглавление: урок → сколько слов
    python tools/book.py dump  sonavihik.pdf 12.1     # слова одного урока
    python tools/book.py dump  sonavihik.pdf 12       # слова всей главы 12

Сам PDF в репозиторий не кладём — учебник под копирайтом Kultuuriministeerium.
Скрипт работает с локальной копией, наружу отдаёт только список слов.
"""

import io
import re
import sys
from collections import OrderedDict

from pypdf import PdfReader

# заголовок урока: «3.2 Mitmendal korrusel?» или «0. Kohvipaus»
HEAD = re.compile(r'^\s*(\d+\.\d+|0\.)\s+([A-ZÕÄÖÜŠŽ][^\n•]{1,44})\s*$', re.M)
# слова идут списком через • — в упражнениях с пропусками они не встречаются
BULLET = re.compile(r'•\s*([^•\n]{2,40}?)\s*(?=•|$)', re.M)


def sections(path):
    """{номер урока: (название, [слова])} в порядке следования в книге."""
    reader = PdfReader(path)
    out = OrderedDict()
    current = None

    for page in reader.pages:
        text = page.extract_text() or ""
        heads = [(m.start(), m.group(1).rstrip('.'), m.group(2).strip())
                 for m in HEAD.finditer(text)
                 # отсекаем номера заданий: «1. Siin on k — h v ...»
                 if not re.search(r'[—_]{2,}|\s—\s', m.group(2))]

        # в конце заголовка стоит номер страницы — он не часть названия
        heads = [(pos, num, re.sub(r'\s+\d+$', '', title)) for pos, num, title in heads]

        for pos, num, title in heads:
            if num not in out:
                out[num] = (title, [])
            current = num

        for m in BULLET.finditer(text):
            word = m.group(1).strip(" .,;")
            if not word or len(word) < 2:
                continue
            if re.search(r'[—_]', word) or re.search(r'\d', word) or '?' in word:
                continue                            # обрывки заданий и заголовков
            if word == title:                       # заголовок урока, попавший в поток
                continue
            if current is None:
                continue
            title, words = out[current]
            if word not in words:
                words.append(word)

    return out


def cmd_list(path):
    out = sections(path)
    total = 0
    lines = []
    for num, (title, words) in out.items():
        total += len(words)
        lines.append("%-6s %-32s %3d" % (num, title[:32], len(words)))
    lines.append("-" * 44)
    lines.append("%-6s %-32s %3d" % ("", "всего", total))
    write("\n".join(lines))


def cmd_dump(path, prefix):
    out = sections(path)
    picked = [(n, t, w) for n, (t, w) in out.items()
              if n == prefix or n.startswith(prefix + ".")]
    if not picked:
        write("нет такого урока: " + prefix)
        return
    lines = []
    for num, title, words in picked:
        lines.append("# %s %s" % (num, title))
        lines.extend(words)
        lines.append("")
    write("\n".join(lines))


def write(s):
    io.open(1, "w", encoding="utf-8", closefd=False).write(s + "\n")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    cmd, pdf = sys.argv[1], sys.argv[2]
    if cmd == "list":
        cmd_list(pdf)
    elif cmd == "dump":
        cmd_dump(pdf, sys.argv[3])
    else:
        print(__doc__)
