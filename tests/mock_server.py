"""Test-only server: serves ../ui and answers the same commands the Rust side does."""
import json, sqlite3, sys, os, hashlib, shutil, tempfile
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = tempfile.mkdtemp(prefix="dmts-")
DB = sqlite3.connect(":memory:", check_same_thread=False)
DB.executescript(open(os.path.join(ROOT, "src-tauri/src/schema.sql")).read())
CALLS = []
PICK = {"next": []}

MOCK_JS = b"""<script>
window.__mockInvoke = async (cmd, args) => {
  const r = await fetch('/invoke', {method:'POST', body: JSON.stringify({cmd, args})});
  const j = await r.json();
  if (j.error) throw j.error;
  return j.result;
};
window.print = () => { window.__printed = document.getElementById('print-area').innerHTML; window.dispatchEvent(new Event('afterprint')); };
</script>"""


def handle(cmd, a):
    CALLS.append({"cmd": cmd, "args": a})
    if cmd == "db_query":
        cur = DB.execute(a["sql"], a["params"])
        cols = [d[0] for d in cur.description] if cur.description else []
        return [dict(zip(cols, row)) for row in cur.fetchall()]
    if cmd == "db_execute":
        cur = DB.execute(a["sql"], a["params"]); DB.commit()
        return {"changes": cur.rowcount, "lastId": cur.lastrowid}
    if cmd == "app_info":
        return {"dataDir": "C:\\Apps\\DocumentTracker\\DMTSData", "dbPath": "x", "version": "1.0.0"}
    if cmd == "pick_files":
        out, PICK["next"] = PICK["next"], []
        return out
    if cmd == "vault_import":
        src = a["src"]; h = hashlib.sha256(open(src, "rb").read()).hexdigest()
        ext = os.path.splitext(src)[1].lstrip(".").lower() or "bin"
        rel = f"vault/{h[:2]}/{h}.{ext}"; dest = os.path.join(DATA, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if not os.path.exists(dest): shutil.copy(src, dest)
        return {"sha256": h, "size": os.path.getsize(src), "relPath": rel, "fileName": os.path.basename(src)}
    if cmd == "open_file":
        assert os.path.exists(os.path.join(DATA, a["rel"])), "missing"
        return None
    if cmd == "save_copy":
        return "C:\\Users\\me\\Downloads\\" + a["name"]
    if cmd == "backup_to_folder":
        return {"path": "G:\\My Drive\\DocumentTracker-Backup", "copied": 3}
    if cmd == "export_xlsx":
        return "C:\\Users\\me\\Documents\\" + a["defaultName"]
    if cmd == "open_data_folder":
        return None
    raise ValueError("unknown command " + cmd)


class H(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kw):
        super().__init__(*args, directory=os.path.join(ROOT, "ui"), **kw)
    def log_message(self, *a): pass
    def _json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path == "/calls": return self._json(CALLS)
        if self.path in ("/", "/index.html"):
            html = open(os.path.join(ROOT, "ui/index.html"), "rb").read()
            html = html.replace(b'<script src="app.js">', MOCK_JS + b'<script src="app.js">')
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers(); self.wfile.write(html); return
        super().do_GET()
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/setpick":
            PICK["next"] = req; return self._json({"ok": True})
        try: out = {"result": handle(req["cmd"], req.get("args", {}))}
        except Exception as e: out = {"error": str(e)}
        self._json(out)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8766), H).serve_forever()
