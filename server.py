#!/usr/bin/env python3
"""
Nova — a voice-in / voice-out assistant with a photorealistic talking avatar.

Zero-dependency server (Python 3.9+ stdlib only):
  * serves the web app from ./public
  * /api/answer  — answers a question by searching the internet
                   (Open-Meteo weather, Wikipedia, DuckDuckGo, Google News RSS)
  * /api/face    — fetches an AI-generated photorealistic portrait
                   (thispersondoesnotexist.com) and caches it locally so the
                   browser can use it as a WebGL texture (same-origin)
  * optional: if ANTHROPIC_API_KEY is set, general answers are composed by
    Claude using the gathered web snippets (raw HTTP, no SDK needed)

Run:  python3 server.py          (then open http://localhost:8765)
"""

import ast
import json
import operator
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
FACE_DIR = ROOT / "avatar_cache"
PORT = int(os.environ.get("PORT", "8765"))
UA = "Mozilla/5.0 (compatible; NovaAssistant/1.0; local demo)"

ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
CLAUDE_MODEL = os.environ.get("NOVA_MODEL", "claude-opus-4-8")

_executor = ThreadPoolExecutor(max_workers=8)


# --------------------------------------------------------------------------
# small TTL cache
# --------------------------------------------------------------------------
_cache: dict = {}
_cache_lock = threading.Lock()


def cached(key, ttl, fn):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    val = fn()
    with _cache_lock:
        _cache[key] = (now, val)
    return val


# --------------------------------------------------------------------------
# outbound HTTP
# --------------------------------------------------------------------------
def http_get(url, timeout=6, binary=False, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    return data if binary else data.decode("utf-8", "replace")


def http_get_json(url, timeout=6):
    return json.loads(http_get(url, timeout=timeout))


# --------------------------------------------------------------------------
# safety: profanity + harmful-request filtering
# --------------------------------------------------------------------------
PROFANITY = {
    "fuck", "fucking", "fucker", "motherfucker", "shit", "bullshit", "shitty",
    "bitch", "bitches", "bastard", "asshole", "arsehole", "dick", "dickhead",
    "cock", "pussy", "cunt", "slut", "whore", "twat", "wanker", "prick",
    "douche", "douchebag", "jackass", "dumbass", "piss", "pissed",
    "nigger", "nigga", "faggot", "fag", "retard", "retarded", "chink",
    "spic", "kike", "tranny", "bollocks", "bloody hell", "damn", "goddamn",
    "crap", "screw you", "son of a bitch",
}
_LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s",
                       "7": "t", "@": "a", "$": "s", "!": "i", "+": "t"})

HARMFUL_PATTERNS = [
    r"\b(make|build|create|manufacture|synthesi[sz]e)\b.{0,40}\b(bomb|explosive|weapon|napalm|nerve agent|poison gas)\b",
    r"\bhow to (kill|hurt|harm|poison|attack)\b.{0,30}\b(someone|somebody|people|myself|a person)\b",
    r"\b(kill|hurt|harm) (myself|me)\b",
    r"\bsuicide method",
    r"\b(hack|steal) (into )?(someone|somebody|a person)'?s? (account|phone|email)\b",
]


def _norm(text):
    return re.sub(r"\s+", " ", text.lower().translate(_LEET))


def contains_profanity(text):
    t = _norm(text)
    for w in PROFANITY:
        if re.search(r"(?<![a-z])" + re.escape(w) + r"(?![a-z])", t):
            return True
    return False


def is_harmful(text):
    t = _norm(text)
    return any(re.search(p, t) for p in HARMFUL_PATTERNS)


def mask_profanity(text):
    def repl(m):
        w = m.group(0)
        return w[0] + "*" * (len(w) - 1)
    t = text
    for w in sorted(PROFANITY, key=len, reverse=True):
        t = re.sub(r"(?i)(?<![a-z])" + re.escape(w) + r"(?![a-z])", repl, t)
    return t


REFUSAL_PROFANITY = ("I'd rather keep our conversation friendly, so I won't "
                     "respond to that kind of language. I'm happy to help with "
                     "anything else — try asking me about the weather, the news, "
                     "or any topic you're curious about.")
REFUSAL_HARMFUL = ("I can't help with that. If you're going through something "
                   "difficult, please reach out to someone you trust or a local "
                   "helpline. I'm here for everyday questions — weather, news, "
                   "facts, and more.")


# --------------------------------------------------------------------------
# weather (Open-Meteo, free, no key)
# --------------------------------------------------------------------------
WMO = {
    0: "clear skies", 1: "mostly clear skies", 2: "partly cloudy skies",
    3: "overcast skies", 45: "fog", 48: "freezing fog",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
    56: "freezing drizzle", 57: "freezing drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain",
    66: "freezing rain", 67: "freezing rain",
    71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
    80: "light rain showers", 81: "rain showers", 82: "violent rain showers",
    85: "snow showers", 86: "heavy snow showers",
    95: "a thunderstorm", 96: "a thunderstorm with hail",
    99: "a heavy thunderstorm with hail",
}


def geocode(place):
    def fetch():
        url = ("https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name="
               + urllib.parse.quote(place))
        j = http_get_json(url)
        res = (j.get("results") or [None])[0]
        if not res:
            return None
        return {
            "name": res.get("name", place.title()),
            "country": res.get("country", ""),
            "admin": res.get("admin1", ""),
            "lat": res["latitude"], "lon": res["longitude"],
            "tz": res.get("timezone", "UTC"),
        }
    return cached(("geo", place.lower()), 86400, fetch)


def weather_answer(place, want_forecast):
    loc = geocode(place)
    if not loc:
        return {"answer": f"I couldn't find a place called {place}. Could you try another city name?",
                "sources": []}

    def fetch():
        url = (f"https://api.open-meteo.com/v1/forecast?latitude={loc['lat']}&longitude={loc['lon']}"
               "&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m"
               "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code"
               "&forecast_days=2&timezone=auto")
        return http_get_json(url)
    j = cached(("wx", loc["lat"], loc["lon"]), 300, fetch)

    cur = j.get("current", {})
    temp = round(cur.get("temperature_2m", 0))
    feels = round(cur.get("apparent_temperature", temp))
    hum = round(cur.get("relative_humidity_2m", 0))
    wind = round(cur.get("wind_speed_10m", 0))
    desc = WMO.get(cur.get("weather_code", 0), "unremarkable skies")

    where = loc["name"] + (f", {loc['country']}" if loc["country"] else "")
    parts = [f"Right now in {where}, it's {temp} degrees Celsius with {desc}."]
    if abs(feels - temp) >= 2:
        parts.append(f"It feels like {feels} degrees.")
    parts.append(f"Humidity is {hum} percent, with winds around {wind} kilometers per hour.")

    if want_forecast:
        d = j.get("daily", {})
        try:
            hi, lo = round(d["temperature_2m_max"][1]), round(d["temperature_2m_min"][1])
            rain = d.get("precipitation_probability_max", [0, 0])[1]
            fdesc = WMO.get(d.get("weather_code", [0, 0])[1], "mixed skies")
            parts.append(f"Tomorrow expect {fdesc}, a high of {hi} and a low of {lo}"
                         + (f", with a {rain} percent chance of rain." if rain is not None else "."))
        except (KeyError, IndexError, TypeError):
            pass

    return {"answer": " ".join(parts),
            "sources": [{"label": "Open-Meteo", "url": "https://open-meteo.com"}]}


# --------------------------------------------------------------------------
# time lookup
# --------------------------------------------------------------------------
def time_answer(place):
    loc = geocode(place)
    if not loc or ZoneInfo is None:
        return {"answer": f"I couldn't work out the time zone for {place}.", "sources": []}
    now = datetime.now(ZoneInfo(loc["tz"]))
    where = loc["name"] + (f", {loc['country']}" if loc["country"] else "")
    return {"answer": f"It's {now.strftime('%-I:%M %p')} on {now.strftime('%A, %B %-d')} in {where}.",
            "sources": [{"label": "Open-Meteo geocoding", "url": "https://open-meteo.com"}]}


# --------------------------------------------------------------------------
# safe math
# --------------------------------------------------------------------------
_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
        ast.Div: operator.truediv, ast.Pow: operator.pow, ast.Mod: operator.mod,
        ast.FloorDiv: operator.floordiv, ast.USub: operator.neg, ast.UAdd: operator.pos}


def _eval_node(n):
    if isinstance(n, ast.Expression):
        return _eval_node(n.body)
    if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)):
        return n.value
    if isinstance(n, ast.BinOp) and type(n.op) in _OPS:
        a, b = _eval_node(n.left), _eval_node(n.right)
        if isinstance(n.op, ast.Pow) and (abs(a) > 1e6 or abs(b) > 64):
            raise ValueError("too big")
        return _OPS[type(n.op)](a, b)
    if isinstance(n, ast.UnaryOp) and type(n.op) in _OPS:
        return _OPS[type(n.op)](_eval_node(n.operand))
    raise ValueError("unsupported")


def try_math(q):
    t = q.lower()
    t = re.sub(r"\b(what\s+is|what's|whats|calculate|compute|solve|equals?|please)\b", " ", t)
    t = t.replace("x", "*").replace("×", "*").replace("÷", "/").replace("^", "**")
    t = t.replace("plus", "+").replace("minus", "-").replace("times", "*").replace("divided by", "/")
    t = re.sub(r"[?.,!]", " ", t).strip()
    if not re.fullmatch(r"[\d\s+\-*/().%]+", t) or not re.search(r"\d", t):
        return None
    if not re.search(r"[+\-*/%]", t):
        return None
    try:
        val = _eval_node(ast.parse(t, mode="eval"))
    except Exception:
        return None
    val = round(val, 6)
    if isinstance(val, float) and val.is_integer():
        val = int(val)
    return {"answer": f"That comes out to {val}.", "sources": []}


# --------------------------------------------------------------------------
# news (Google News RSS, free, no key)
# --------------------------------------------------------------------------
def news_answer(topic):
    def fetch():
        if topic:
            url = ("https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q="
                   + urllib.parse.quote(topic))
        else:
            url = "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en"
        xml = http_get(url, timeout=7)
        root = ET.fromstring(xml)
        items = []
        for item in root.iter("item"):
            title = (item.findtext("title") or "").strip()
            if title:
                items.append(re.sub(r"\s+-\s+[^-]+$", "", title))
            if len(items) >= 3:
                break
        return items
    try:
        items = cached(("news", (topic or "").lower()), 600, fetch)
    except Exception:
        items = []
    if not items:
        return {"answer": f"I couldn't fetch news about {topic or 'that'} right now — please try again in a moment.",
                "sources": []}
    label = f"about {topic}" if topic else "right now"
    lines = ". ".join(f"{i + 1}: {t}" for i, t in enumerate(items))
    return {"answer": f"Here are the top headlines {label}. {lines}.",
            "sources": [{"label": "Google News", "url": "https://news.google.com"}]}


# --------------------------------------------------------------------------
# general knowledge: DuckDuckGo instant answers + Wikipedia (in parallel)
# --------------------------------------------------------------------------
def ddg_instant(q):
    url = ("https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&kp=1&q="
           + urllib.parse.quote(q))
    return http_get_json(url, timeout=6)


def wiki_lookup(q):
    topic = re.sub(r"^(who|what|where|when|why|how)\s+(is|are|was|were)\s+", "", q.lower())
    topic = re.sub(r"^(tell me about|define|explain|search for|look up|what do you know about)\s+", "", topic)
    topic = re.sub(r"[?.!]", "", topic).strip() or q
    j = http_get_json("https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&format=json&search="
                      + urllib.parse.quote(topic), timeout=6)
    titles = j[1] if len(j) > 1 else []
    if not titles:
        return None
    title = titles[0]
    s = http_get_json("https://en.wikipedia.org/api/rest_v1/page/summary/"
                      + urllib.parse.quote(title.replace(" ", "_")), timeout=6)
    extract = (s.get("extract") or "").strip()
    if not extract:
        return None
    return {"title": title, "extract": extract,
            "url": s.get("content_urls", {}).get("desktop", {}).get("page",
                   "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title))}


def shorten_speakable(text, limit=420):
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    m = re.search(r"^(.+[.!?])\s", cut)
    return m.group(1) if m else cut.rsplit(" ", 1)[0] + "."


def claude_compose(question, snippets):
    """Optional: compose a spoken-style answer with Claude from web snippets."""
    if not ANTHROPIC_KEY:
        return None
    body = json.dumps({
        "model": CLAUDE_MODEL,
        "max_tokens": 300,
        "system": ("You are Nova, a friendly voice assistant. Answer the user's question "
                   "in one to three short spoken-style sentences using the provided web "
                   "snippets when relevant. Plain text only — no markdown, no lists. "
                   "Never use offensive or inappropriate language. If the snippets don't "
                   "answer it and you don't know, say so briefly."),
        "messages": [{"role": "user",
                      "content": f"Question: {question}\n\nWeb snippets:\n{snippets or '(none found)'}"}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=body, method="POST",
        headers={"Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY,
                 "anthropic-version": "2023-06-01"})
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            j = json.loads(r.read().decode())
        if j.get("stop_reason") == "refusal":
            return None
        text = " ".join(b.get("text", "") for b in j.get("content", []) if b.get("type") == "text").strip()
        return text or None
    except Exception:
        return None


def general_answer(q):
    f_ddg = _executor.submit(ddg_instant, q)
    f_wiki = _executor.submit(wiki_lookup, q)
    ddg, wiki = None, None
    try:
        ddg = f_ddg.result(timeout=7)
    except Exception:
        pass
    try:
        wiki = f_wiki.result(timeout=7)
    except Exception:
        pass

    sources, snippets = [], []
    if ddg and ddg.get("AbstractText"):
        snippets.append(ddg["AbstractText"])
        if ddg.get("AbstractURL") and ddg.get("AbstractSource", "").lower() != "wikipedia":
            sources.append({"label": ddg.get("AbstractSource", "DuckDuckGo"), "url": ddg["AbstractURL"]})
    if wiki:
        snippets.append(wiki["extract"])
        sources.append({"label": f"Wikipedia — {wiki['title']}", "url": wiki["url"]})

    llm = claude_compose(q, "\n---\n".join(snippets)) if snippets or ANTHROPIC_KEY else None
    if llm:
        return {"answer": shorten_speakable(llm, 520), "sources": sources, "llm": True}

    if ddg and ddg.get("Answer"):
        return {"answer": shorten_speakable(str(ddg["Answer"])), "sources": sources or
                [{"label": "DuckDuckGo", "url": "https://duckduckgo.com/?q=" + urllib.parse.quote(q)}]}
    if ddg and ddg.get("AbstractText"):
        return {"answer": shorten_speakable(ddg["AbstractText"]), "sources": sources}
    if wiki:
        return {"answer": shorten_speakable(wiki["extract"]), "sources": sources}
    if ddg:
        for t in ddg.get("RelatedTopics", []):
            if isinstance(t, dict) and t.get("Text"):
                return {"answer": shorten_speakable(t["Text"]),
                        "sources": [{"label": "DuckDuckGo", "url": t.get("FirstURL", "https://duckduckgo.com")}]}
    return {"answer": "I searched the web but couldn't find a clear answer to that. "
                      "Could you try rephrasing the question?", "sources": []}


# --------------------------------------------------------------------------
# intent routing
# --------------------------------------------------------------------------
GREETINGS = re.compile(r"^\s*(hi|hii+|hello|hey|hey there|good (morning|afternoon|evening)|namaste)[\s!.,]*$", re.I)
IDENTITY = re.compile(r"\b(who are you|what('?s| is) your name|introduce yourself)\b", re.I)
THANKS = re.compile(r"^\s*(thanks?( you| a lot)?|thank you( so much)?)[\s!.,]*$", re.I)
WEATHER_KW = re.compile(r"\b(weather|temperature|forecast|rain(ing|y)?|snow(ing)?|humid(ity)?|"
                        r"wind(y)?|sunny|cloudy|hot|cold|climate)\b", re.I)
TIME_KW = re.compile(r"\b(what time|current time|time (is it|now)|the time|today'?s date|what('?s| is) the date)\b", re.I)
NEWS_KW = re.compile(r"\b(news|headlines?|latest on|what'?s happening)\b", re.I)


def extract_place(q):
    m = re.search(r"\b(?:in|at|for|near|of)\s+([A-Za-zÀ-ɏ][A-Za-zÀ-ɏ .'\-]*?)"
                  r"(?=\s*(?:\?|!|\.|,|$|today|tomorrow|right now|now\b|currently))", q, re.I)
    if not m:
        return None
    place = m.group(1).strip()
    place = re.sub(r"\b(the|city|town)\b", "", place, flags=re.I).strip()
    return place or None


def answer_question(q):
    t0 = time.time()
    q = (q or "").strip()
    intent = "general"
    if not q:
        out = {"answer": "I didn't catch that — could you say it again?", "sources": []}
    elif is_harmful(q):
        intent, out = "safety", {"answer": REFUSAL_HARMFUL, "sources": [], "refused": True}
    elif contains_profanity(q):
        intent, out = "safety", {"answer": REFUSAL_PROFANITY, "sources": [], "refused": True}
    elif GREETINGS.match(q):
        intent = "chat"
        out = {"answer": "Hello! I'm Nova. Ask me anything — the weather in any city, "
                         "the latest news, or any question you'd search the web for.", "sources": []}
    elif IDENTITY.search(q):
        intent = "chat"
        out = {"answer": "I'm Nova, a voice assistant. I listen to your question, search "
                         "the internet for the answer, and speak it back to you.", "sources": []}
    elif THANKS.match(q):
        intent, out = "chat", {"answer": "You're very welcome! What else can I find for you?", "sources": []}
    else:
        m = try_math(q)
        if m:
            intent, out = "math", m
        elif TIME_KW.search(q) and extract_place(q):
            intent, out = "time", time_answer(extract_place(q))
        elif WEATHER_KW.search(q):
            intent = "weather"
            place = extract_place(q)
            if place:
                want_fc = bool(re.search(r"\b(forecast|tomorrow)\b", q, re.I))
                try:
                    out = weather_answer(place, want_fc)
                except Exception:
                    out = {"answer": "The weather service seems unreachable right now — "
                                     "please try again in a moment.", "sources": []}
            else:
                out = {"answer": "Sure — which city's weather would you like? "
                                 "For example, ask: what's the weather in Hyderabad?", "sources": []}
        elif NEWS_KW.search(q):
            intent = "news"
            topic = re.sub(r".*?\b(?:news|headlines?|latest)\b(?:\s+(?:about|on|for|of))?", "", q, flags=re.I)
            topic = re.sub(r"[?.!]", "", topic).strip()
            topic = re.sub(r"^(the|today'?s|current)\s+", "", topic, flags=re.I).strip()
            out = news_answer(topic)
        else:
            try:
                out = general_answer(q)
            except Exception:
                out = {"answer": "I hit a snag searching the web for that. Please try again.",
                       "sources": []}

    out["answer"] = mask_profanity(out.get("answer", ""))
    out["intent"] = intent
    out["server_ms"] = int((time.time() - t0) * 1000)
    return out


# --------------------------------------------------------------------------
# avatar face fetching (AI-generated portrait, no real person)
# --------------------------------------------------------------------------
FACE_SOURCES = [
    "https://thispersondoesnotexist.com/random-person.jpeg",
    "https://thispersondoesnotexist.com/",  # legacy: served the JPEG at the root
]


def fetch_face(force_new):
    FACE_DIR.mkdir(exist_ok=True)
    path = FACE_DIR / "face.jpg"
    if path.exists() and not force_new:
        return {"ok": True, "url": f"/avatar/face.jpg?ts={int(path.stat().st_mtime)}"}
    for src in FACE_SOURCES:
        try:
            data = http_get(src, timeout=10, binary=True,
                            headers={"Accept": "image/jpeg,image/*"})
            if data[:2] == b"\xff\xd8" and len(data) > 20000:  # sane JPEG
                path.write_bytes(data)
                return {"ok": True, "url": f"/avatar/face.jpg?ts={int(time.time())}"}
            print(f"[nova] face source {src}: unexpected payload ({len(data)} bytes)")
        except Exception as e:
            print(f"[nova] face source {src} failed: {e}")
            continue
    if path.exists():
        return {"ok": True, "url": f"/avatar/face.jpg?ts={int(path.stat().st_mtime)}"}
    return {"ok": False}


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
        ".json": "application/json"}


class Handler(BaseHTTPRequestHandler):
    server_version = "Nova/1.0"

    def log_message(self, fmt, *args):
        try:
            msg = fmt % args
        except Exception:
            msg = str(fmt)
        if "/api/" in msg:
            print("[nova]", msg)

    def do_HEAD(self):  # health probes from proxies
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()

    def _send(self, code, body, ctype="application/json", cache="no-store"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path, qs = parsed.path, urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/api/answer":
                q = (qs.get("q", [""])[0])[:500]
                self._send(200, answer_question(q))
            elif path == "/api/face":
                self._send(200, fetch_face(force_new="new" in qs))
            elif path == "/api/health":
                self._send(200, {"ok": True, "llm": bool(ANTHROPIC_KEY)})
            elif path.startswith("/avatar/"):
                f = (FACE_DIR / Path(path).name).resolve()
                if f.is_file() and f.parent == FACE_DIR.resolve():
                    self._send(200, f.read_bytes(), MIME.get(f.suffix, "application/octet-stream"),
                               cache="no-cache")
                else:
                    self._send(404, {"error": "not found"})
            else:
                self._serve_static(path)
        except BrokenPipeError:
            pass
        except Exception as e:
            try:
                self._send(500, {"error": str(e)})
            except Exception:
                pass

    def _serve_static(self, path):
        rel = path.lstrip("/") or "index.html"
        f = (PUBLIC / rel).resolve()
        if not str(f).startswith(str(PUBLIC.resolve())) or not f.is_file():
            f = PUBLIC / "index.html"
        self._send(200, f.read_bytes(), MIME.get(f.suffix, "application/octet-stream"),
                   cache="no-cache")


def main():
    PUBLIC.mkdir(exist_ok=True)
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Nova is listening on http://localhost:{PORT}"
          + ("  (Claude answers: ON)" if ANTHROPIC_KEY else "  (Claude answers: off — set ANTHROPIC_API_KEY to enable)"))
    srv.serve_forever()


if __name__ == "__main__":
    main()
