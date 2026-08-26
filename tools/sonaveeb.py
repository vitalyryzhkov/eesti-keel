#!/usr/bin/env python3
"""Сверка и пополнение словаря приложения по данным EKI (api.sonapi.ee, витрина Sõnaveeb).

    python tools/sonaveeb.py check                 # сверить весь data/words.json
    python tools/sonaveeb.py check raamat tuba     # сверить отдельные слова
    python tools/sonaveeb.py add words-new.txt     # добавить новые (строки «sõna — перевод»)
    python tools/sonaveeb.py show lugema           # что словарь знает про слово

Формы НЕ берутся из головы: всё, что попадает в words.json, приходит из API.
Перевод — единственное поле, которое пишем сами.
"""

import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORDS = os.path.join(ROOT, "data", "words.json")
CACHE = os.path.join(ROOT, "tools", ".cache")
API = "https://api.sonapi.ee/v2/"
PAUSE = 0.6  # вежливая пауза между запросами

# какие формы нам нужны и под каким именем лежат в words.json
NOUN_FORMS = [("nom", "SgN"), ("gen", "SgG"), ("part", "SgP"), ("plpart", "PlP")]
VERB_FORMS = [("ma", "Sup"), ("da", "Inf"), ("b", "IndPrSg3"),
              ("neg", "IndPrPs_"), ("past", "IndIpfSg3"), ("nud", "PtsPtPs")]


def fetch(word):
    """Ответ API с диском в качестве кэша — повторный прогон не бьёт по сервису."""
    os.makedirs(CACHE, exist_ok=True)
    safe = re.sub(r"[^\w]", "_", word, flags=re.UNICODE)
    path = os.path.join(CACHE, safe + ".json")
    if os.path.exists(path):
        return json.load(io.open(path, encoding="utf-8"))

    url = API + urllib.parse.quote(word)
    # заголовки — только ASCII, иначе urllib падает ещё до запроса
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "eesti-keel-trainer/1.0 (+github.com/vitalyryzhkov/eesti-keel)",
    })
    data = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                data = json.loads(r.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as e:
            if e.code == 429:                   # сервис просит притормозить — ждём и пробуем ещё
                wait = 2 ** attempt
                print("  429 на %s, пауза %ds" % (word, wait), file=sys.stderr)
                time.sleep(wait)
                continue
            data = {"error": "HTTP %d" % e.code}  # 404 = слова нет в словаре
            break
        except Exception as e:
            data = {"error": "%s: %s" % (type(e).__name__, e)}
            break

    if data is None:
        data = {"error": "429 после 5 попыток"}

    # ошибки не кэшируем: иначе временный сбой сети навсегда превратится в «слова нет»
    if "error" not in data:
        json.dump(data, io.open(path, "w", encoding="utf-8"), ensure_ascii=False)
    else:
        print("  ! %s -> %s" % (word, data["error"]), file=sys.stderr)
    time.sleep(PAUSE)
    return data


def pick(data, want_class):
    """Из омонимов выбираем нужную часть речи: noomen для существительных, verb для глаголов."""
    if not data or "searchResult" not in data:
        return None
    results = data["searchResult"]
    for r in results:
        classes = [c.lower() for c in (r.get("wordClasses") or []) if c]
        if want_class == "verb" and "verb" in classes:
            return r
        if want_class == "noun" and any(c in classes for c in ("noomen", "nimisõna")):
            return r
    return results[0] if results else None


def forms_of(result):
    out = {}
    for f in result.get("wordForms") or []:
        v = (f.get("value") or "").strip()
        if v and v != "-":
            out.setdefault(f["code"], v)
    return out


def rection(result):
    for m in result.get("meanings") or []:
        if m.get("rection"):
            return m["rection"]
    return ""


def norm(s):
    """Сравниваем без регистра и без учёта запятых-вариантов: 'a,b' == 'b,a'."""
    parts = [unicodedata.normalize("NFC", p.strip().lower()) for p in (s or "").split(",")]
    return {p for p in parts if p}


def load_words():
    return json.load(io.open(WORDS, encoding="utf-8"))


def save_words(d):
    with io.open(WORDS, "w", encoding="utf-8", newline="\n") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
        f.write("\n")


def check(only=None):
    d = load_words()
    bad, missing, ok = [], [], 0

    for kind, key, spec in (("noun", "nouns", NOUN_FORMS), ("verb", "verbs", VERB_FORMS)):
        for w in d[key]:
            head = w["nom"] if kind == "noun" else w["ma"]
            if only and head not in only:
                continue
            res = pick(fetch(head), kind)
            if not res:
                missing.append(head)
                continue
            api = forms_of(res)
            for field, code in spec:
                if field not in w:                  # neg/past/nud в старых записях нет
                    continue
                mine, theirs = w.get(field, ""), api.get(code, "")
                if not theirs:
                    continue
                if not mine:                        # мы оставили пусто, а форма есть
                    bad.append((head, field, "(пусто)", theirs))
                elif norm(mine) != norm(theirs):
                    bad.append((head, field, mine, theirs))
                else:
                    ok += 1

    print("совпало форм: %d" % ok)
    if missing:
        print("\nНЕ НАЙДЕНО в словаре (%d): %s" % (len(missing), ", ".join(missing)))
    if bad:
        print("\nРАСХОЖДЕНИЯ (%d):" % len(bad))
        for head, field, mine, theirs in bad:
            print("  %-12s %-7s было: %-22s словарь: %s" % (head, field, mine, theirs))
    else:
        print("\nрасхождений нет")
    return bad, missing


def fix():
    """Переписывает формы по словарю и дозаполняет neg/past/nud/rek у глаголов."""
    d = load_words()
    changed = 0

    for w in d["nouns"]:
        res = pick(fetch(w["nom"]), "noun")
        if not res:
            continue
        api = forms_of(res)
        for field, code in NOUN_FORMS:
            if api.get(code) and norm(w.get(field, "")) != norm(api[code]):
                w[field] = api[code]
                changed += 1

    for w in d["verbs"]:
        res = pick(fetch(w["ma"]), "verb")
        if not res:
            continue
        api = forms_of(res)
        for field, code in VERB_FORMS:
            if api.get(code) and norm(w.get(field, "")) != norm(api[code]):
                w[field] = api[code]
                changed += 1
        r = rection(res)
        if r and w.get("rek") != r:
            w["rek"] = r
            changed += 1

    d["meta"]["source"] = "формы — EKI через api.sonapi.ee; переводы вручную"
    save_words(d)
    print("полей обновлено: %d" % changed)


def slug(word):
    table = {"õ": "o", "ä": "a", "ö": "o", "ü": "u", "š": "s", "ž": "z"}
    return "".join(table.get(c, c) for c in word.lower() if c.isalnum() or c in table)


def add(path):
    """Файл со строками вида «sõna — перевод» (разделитель — тире, дефис или таб)."""
    d = load_words()
    have = {w["nom"] for w in d["nouns"]} | {w["ma"] for w in d["verbs"]}
    added, skipped, failed = [], [], []

    for line in io.open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = re.split(r"\s+[—–-]\s+|\t", line, maxsplit=1)
        word = parts[0].strip()
        ru = parts[1].strip() if len(parts) > 1 else ""
        if word in have:
            skipped.append(word)
            continue

        data = fetch(word)
        res = pick(data, "verb") or pick(data, "noun")
        if not res:
            failed.append(word)
            continue
        classes = [c.lower() for c in (res.get("wordClasses") or []) if c]
        api = forms_of(res)

        if "verb" in classes:
            entry = {"id": "v_" + slug(word), "ru": ru}
            for field, code in VERB_FORMS:
                entry[field] = api.get(code, "")
            r = rection(res)
            if r:
                entry["rek"] = r
            if not entry["ma"] or not entry["da"] or not entry["b"]:
                failed.append(word)
                continue
            d["verbs"].append(entry)
        else:
            entry = {"id": "n_" + slug(word), "ru": ru}
            for field, code in NOUN_FORMS:
                entry[field] = api.get(code, "")
            if not entry["nom"] or not entry["gen"] or not entry["part"]:
                failed.append(word)
                continue
            d["nouns"].append(entry)
        added.append(word + ("" if ru else "  ← БЕЗ ПЕРЕВОДА"))

    save_words(d)
    print("добавлено: %d" % len(added))
    for a in added:
        print("  +", a)
    if skipped:
        print("уже были (%d): %s" % (len(skipped), ", ".join(skipped)))
    if failed:
        print("НЕ НАЙДЕНО, добавь руками (%d): %s" % (len(failed), ", ".join(failed)))


def show(word):
    data = fetch(word)
    if "searchResult" not in data:
        print("нет в словаре:", word, data.get("error", ""))
        return
    for res in data["searchResult"]:
        print("класс:", ", ".join(res.get("wordClasses") or []))
        api = forms_of(res)
        for code in ("SgN", "SgG", "SgP", "PlP", "Sup", "Inf", "IndPrSg3", "IndPrPs_", "IndIpfSg3", "PtsPtPs"):
            if code in api:
                print("  %-10s %s" % (code, api[code]))
        if rection(res):
            print("  рекция:", rection(res))
        for m in (res.get("meanings") or [])[:1]:
            if m.get("examples"):
                print("  пример:", m["examples"][0])
        print()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    args = sys.argv[2:]
    if cmd == "check":
        check(set(args) or None)
    elif cmd == "fix":
        fix()
    elif cmd == "add":
        add(args[0])
    elif cmd == "show":
        for w in args:
            show(w)
    else:
        print(__doc__)
