#!/usr/bin/env python3
"""Deploy a released maplex build's web dashboard + upstream edge functions.

Lives on the server at /root/.maplex-deploy/deploy.py (copy it there by hand
after changing it). Run as root over the normal admin SSH; the InsForge admin
key is read from InsForge's .env on the server and never leaves it.

  python3 deploy.py state                       -> JSON state (deployed, sql_reviewed)
  python3 deploy.py deploy X.Y.Z[.N] < bundle.tar.gz
        bundle: web/ (dashboard dist) + fns/ (functions.json + *.js from
        build-upstream-functions.cjs). Uploads only functions whose code
        changed (old code kept in fn-backup/<version>/), then swaps the web
        root (previous copy kept in web-prev.tgz). Refuses downgrades.
  python3 deploy.py mark-sql-reviewed X.Y.Z     -> after reviewing/applying upstream SQL

Upstream SQL is never applied by this script.
"""
import io, json, os, re, shutil, subprocess, sys, tarfile, tempfile, time, urllib.request, urllib.error

HOME = "/root/.maplex-deploy"
STATE = os.path.join(HOME, "state.json")
WEB_SITE = "/opt/1panel/www/sites/tokentracker.maplex.top"
WEB_ROOT = os.path.join(WEB_SITE, "index")
INSFORGE_ENV = "/opt/1panel/apps/custom/insforge/.env"
API = "http://127.0.0.1:7130/api/functions"
VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:\.([1-9]\d*))?$")
MAX_BUNDLE = 200 * 1024 * 1024


def die(msg):
    print("✗ " + msg, file=sys.stderr)
    sys.exit(1)


def vtuple(v):
    m = VERSION_RE.match(v or "")
    if not m:
        die("invalid version: %r" % v)
    return tuple(int(x or 0) for x in m.groups())


def load_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_state(state):
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE)


def admin_key():
    with open(INSFORGE_ENV) as f:
        for line in f:
            if line.startswith("ACCESS_API_KEY="):
                return line.split("=", 1)[1].strip()
    die("ACCESS_API_KEY not found in InsForge .env")


def api(method, path, key, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={"x-api-key": key, "Content-Type": "application/json"})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 5:  # admin API is rate limited
                time.sleep(20)
                continue
            return e.code, {"error": e.read()[:300].decode("utf8", "replace")}


def safe_extract(data, dest):
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for m in tar.getmembers():
            name = os.path.normpath(m.name)
            if name.startswith("/") or name == ".." or name.startswith("../") or not (m.isfile() or m.isdir()):
                die("refusing bundle member: %r" % m.name)
            if not (name == "." or name.split("/")[0] in ("web", "fns")):
                die("unexpected bundle member: %r" % m.name)
        for m in tar.getmembers():
            name = os.path.normpath(m.name)
            target = os.path.join(dest, name)
            if m.isdir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with tar.extractfile(m) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
            os.chmod(target, 0o644)


def deploy_web(src, version):
    if not os.path.isfile(os.path.join(src, "index.html")):
        die("bundle web/ has no index.html")
    os.makedirs(HOME, exist_ok=True)
    subprocess.run(["tar", "-czf", os.path.join(HOME, "web-prev.tgz"), "-C", WEB_ROOT, "."], check=True)
    new, old = WEB_ROOT + ".new", WEB_ROOT + ".old"
    shutil.rmtree(new, ignore_errors=True)
    shutil.rmtree(old, ignore_errors=True)
    shutil.copytree(src, new)
    subprocess.run(["chown", "-R", "--reference=" + WEB_ROOT, new], check=True)
    os.rename(WEB_ROOT, old)
    os.rename(new, WEB_ROOT)
    shutil.rmtree(old, ignore_errors=True)
    print("✓ web: tokentracker.maplex.top now %s (previous kept in %s/web-prev.tgz)" % (version, HOME))


def deploy_functions(src, version):
    with open(os.path.join(src, "functions.json")) as f:
        manifest = json.load(f)
    key = admin_key()
    status, listing = api("GET", "", key)
    if status != 200:
        die("listing functions failed: %s %s" % (status, listing))
    existing = {f["slug"] for f in listing.get("functions", [])}
    backup = os.path.join(HOME, "fn-backup", version)
    changed, failed = [], []
    for fn in manifest["functions"]:
        slug = fn["slug"]
        if not re.match(r"^[a-z0-9-]+$", slug):
            die("bad slug %r" % slug)
        with open(os.path.join(src, os.path.basename(fn["file"])), encoding="utf8") as f:
            code = f.read()
        if slug in existing:
            st, live = api("GET", "/" + slug, key)
            live_code = (live.get("code") or (live.get("function") or {}).get("code") or "") if st == 200 else ""
            if live_code == code:
                continue
            os.makedirs(backup, exist_ok=True)
            with open(os.path.join(backup, slug + ".js"), "w", encoding="utf8") as f:
                f.write(live_code)
        body = {"name": slug, "slug": slug, "code": code, "description": "TokenTracker self-host", "status": "active"}
        st, res = api("PUT", "/" + slug, key, body) if slug in existing else api("POST", "", key, body)
        (changed if 200 <= st < 300 else failed).append(slug if 200 <= st < 300 else "%s(%s)" % (slug, st))
    print("✓ functions: %d updated%s" % (len(changed), (": " + " ".join(changed)) if changed else ""))
    if failed:
        die("function upload failed: " + " ".join(failed))


def cmd_deploy(version):
    vtuple(version)
    state = load_state()
    if state.get("deployed") and vtuple(version) < vtuple(state["deployed"]):
        die("refusing downgrade %s -> %s" % (state["deployed"], version))
    data = sys.stdin.buffer.read(MAX_BUNDLE + 1)
    if len(data) > MAX_BUNDLE:
        die("bundle too large")
    with tempfile.TemporaryDirectory(prefix="maplex-deploy-") as tmp:
        safe_extract(data, tmp)
        deploy_functions(os.path.join(tmp, "fns"), version)
        deploy_web(os.path.join(tmp, "web"), version)
    state.update(deployed=version, deployedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    save_state(state)


def main():
    os.makedirs(HOME, mode=0o700, exist_ok=True)
    args = sys.argv[1:]
    if args == ["state"]:
        print(json.dumps(load_state()))
    elif len(args) == 2 and args[0] == "deploy":
        cmd_deploy(args[1])
    elif len(args) == 2 and args[0] == "mark-sql-reviewed":
        vtuple(args[1])
        state = load_state()
        state["sql_reviewed"] = args[1]
        save_state(state)
        print("✓ sql_reviewed = " + args[1])
    else:
        die("usage: state | deploy <version> | mark-sql-reviewed <version>")


if __name__ == "__main__":
    main()
