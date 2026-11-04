#!/usr/bin/env python3
"""TinyCore-hosted Stockroom API. Python standard library + SQLite only."""
import hmac, json, os, re, sqlite3, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from pathlib import Path

DATA_DIR = Path(os.environ.get("STOCKROOM_DATA_DIR", "/var/lib/stockroom"))
GATEWAY_TOKEN = os.environ.get("STOCKROOM_GATEWAY_TOKEN", "")
HOST = os.environ.get("STOCKROOM_BIND", "127.0.0.1")
PORT = int(os.environ.get("STOCKROOM_PORT", "8787"))
ACCOUNT_RE = re.compile(r"^acct-[a-f0-9-]{36}$")
UUID_RE = re.compile(r"^[a-f0-9-]{36}$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
 id TEXT PRIMARY KEY, sku TEXT NOT NULL COLLATE NOCASE UNIQUE, name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '',
 price_cents INTEGER NOT NULL DEFAULT 0, cost_cents INTEGER NOT NULL DEFAULT 0,
 quantity INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active'
 CHECK(status IN ('active','draft','archived')), variations_json TEXT NOT NULL DEFAULT '[]',
 external_url TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory_movements (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL, quantity_delta INTEGER NOT NULL,
 reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory_consumptions (checkout_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS business_orders (order_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS products_status_updated ON products(status, updated_at);
CREATE INDEX IF NOT EXISTS inventory_product_created ON inventory_movements(product_id, created_at);
"""

def now(): return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
def cents(v):
    if isinstance(v, bool): return None
    try: n=float(v)
    except (TypeError, ValueError): return None
    if n < 0 or n > 100000000: return None
    return round(n*100)
def clean(v, limit):
    return v.strip()[:limit] if isinstance(v,str) else ""
def safe_url(v):
    from urllib.parse import urlparse as _parse
    s=clean(v,2048)
    if re.fullmatch(r"/api/media/acct-[a-f0-9-]{36}/[a-f0-9-]{36}/[a-f0-9-]{36}\.(jpg|png|webp|gif)", s):
        return s
    p=_parse(s)
    return s if p.scheme in ("http","https") and p.netloc else ""
def db_for(account):
    if not ACCOUNT_RE.fullmatch(account): raise ValueError("invalid_account_id")
    DATA_DIR.mkdir(parents=True,exist_ok=True,mode=0o700)
    os.chmod(DATA_DIR,0o700)
    path=DATA_DIR/(account+".sqlite3")
    db=sqlite3.connect(str(path),timeout=15,isolation_level=None)
    db.row_factory=sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript(SCHEMA)
    os.chmod(path,0o600)
    return db
def product_dict(row):
    return {"id":row["id"],"sku":row["sku"],"name":row["name"],"description":row["description"],
      "category":row["category"],"image_url":row["image_url"],"price":row["price_cents"]/100,
      "cost":row["cost_cents"]/100,"quantity":row["quantity"],"status":row["status"],
      "variations":json.loads(row["variations_json"]),"external_url":row["external_url"],
      "created_at":row["created_at"],"updated_at":row["updated_at"]}
def validate_product(b):
    if not isinstance(b,dict): return None
    sku=clean(b.get("sku"),64).upper(); name=clean(b.get("name"),120)
    price=cents(b.get("price")); cost=cents(b.get("cost"))
    try: qty=int(b.get("quantity"))
    except (TypeError,ValueError): return None
    status=b.get("status") if b.get("status") in ("active","draft","archived") else "active"
    if not sku or not re.fullmatch(r"[A-Z0-9][A-Z0-9._-]{0,63}",sku) or not name or price is None or cost is None or qty<0 or qty>1000000000: return None
    variations=[]
    for v in (b.get("variations") if isinstance(b.get("variations"),list) else [])[:100]:
        if isinstance(v,dict):
            vp=cents(v.get("price"))
            variations.append({"name":clean(v.get("name"),80),"sku":clean(v.get("sku"),64).upper(),"price":None if vp is None else vp/100})
    return {"sku":sku,"name":name,"description":clean(b.get("description"),2000),"category":clean(b.get("category"),80),
      "image_url":safe_url(b.get("image_url")),"price_cents":price,"cost_cents":cost,"quantity":qty,
      "status":status,"variations_json":json.dumps(variations),"external_url":safe_url(b.get("external_url"))}
def movement(db,pid,delta,reason):
    db.execute("INSERT INTO inventory_movements VALUES(?,?,?,?,?)",(str(uuid.uuid4()),pid,delta,reason,now()))

class Handler(BaseHTTPRequestHandler):
    server_version="TinyCoreStockroom/1"
    def log_message(self,*args): pass
    def send_json(self,code,data):
        raw=json.dumps(data,separators=(",",":")).encode()
        self.send_response(code); self.send_header("content-type","application/json; charset=utf-8")
        self.send_header("content-length",str(len(raw))); self.send_header("cache-control","no-store")
        self.end_headers(); self.wfile.write(raw)
    def body(self):
        n=int(self.headers.get("content-length","0"))
        if n<0 or n>65536: raise ValueError("body_too_large")
        return json.loads(self.rfile.read(n) or b"{}")
    def do_GET(self): self.route()
    def do_POST(self): self.route()
    def do_PUT(self): self.route()
    def do_DELETE(self): self.route()
    def route(self):
        if self.path=="/health":
            self.send_json(200,{"ok":True,"service":"tinycore-stockroom","database":"sqlite"}); return
        if not GATEWAY_TOKEN or not hmac.compare_digest(self.headers.get("x-stockroom-gateway-token",""),GATEWAY_TOKEN):
            self.send_json(401,{"error":"unauthorized"}); return
        account=self.headers.get("x-stockroom-account-id","")
        if not ACCOUNT_RE.fullmatch(account): self.send_json(400,{"error":"invalid_account_id"}); return
        parsed=urlparse(self.path); path=parsed.path; q=parse_qs(parsed.query)
        try:
            db=db_for(account)
            if path=="/v1/initialize" and self.command=="POST":
                n=db.execute("SELECT COUNT(*) FROM products").fetchone()[0]
                self.send_json(200,{"ok":True,"database":"ready","engine":"tinycore-sqlite","product_count":n}); return
            if path=="/v1/purge" and self.command=="POST":
                db.executescript("DROP TABLE IF EXISTS inventory_consumptions; DROP TABLE IF EXISTS inventory_movements; DROP TABLE IF EXISTS products;")
                self.send_json(200,{"ok":True,"database_cleared":True}); return
            if path=="/v1/public-products" and self.command=="GET":
                rows=db.execute("SELECT id,sku,name,description,category,image_url,price_cents,quantity,variations_json,external_url FROM products WHERE status='active' ORDER BY name LIMIT 250").fetchall()
                self.send_json(200,{"ok":True,"products":[{"id":r["id"],"sku":r["sku"],"name":r["name"],"description":r["description"],"category":r["category"],"image_url":r["image_url"],"price":r["price_cents"]/100,"in_stock":r["quantity"]>0,"variations":json.loads(r["variations_json"]),"external_url":r["external_url"]} for r in rows]}); return
            if path=="/v1/apply-orders" and self.command=="POST":
                b=self.body(); orders=b.get("orders")
                if not isinstance(orders,list) or len(orders)>250:
                    self.send_json(400,{"error":"invalid_order_batch"}); return
                applied=[]
                db.execute("BEGIN IMMEDIATE")
                try:
                    for order in orders:
                        if not isinstance(order,dict): raise ValueError("invalid_order")
                        oid=order.get("order_id"); items=order.get("items")
                        if not isinstance(oid,str) or not UUID_RE.fullmatch(oid) or not isinstance(items,list) or not 1<=len(items)<=20:
                            raise ValueError("invalid_order")
                        if db.execute("SELECT 1 FROM business_orders WHERE order_id=?",(oid,)).fetchone():
                            applied.append(oid); continue
                        requested={}
                        for item in items:
                            if not isinstance(item,dict) or not isinstance(item.get("product_id"),str) or not UUID_RE.fullmatch(item["product_id"]) or type(item.get("quantity")) is not int or not 1<=item["quantity"]<=99:
                                raise ValueError("invalid_order_item")
                            requested[item["product_id"]]=requested.get(item["product_id"],0)+item["quantity"]
                        checked=[]
                        for pid,qty in requested.items():
                            row=db.execute("SELECT quantity FROM products WHERE id=?",(pid,)).fetchone()
                            if not row or row["quantity"]<qty: raise LookupError(pid)
                            checked.append((pid,qty))
                        stamp=now()
                        for pid,qty in checked:
                            db.execute("UPDATE products SET quantity=quantity-?,updated_at=? WHERE id=?",(qty,stamp,pid))
                            movement(db,pid,-qty,"synced paid order "+oid)
                        db.execute("INSERT INTO business_orders(order_id,payload_json,applied_at) VALUES(?,?,?)",(oid,json.dumps(order,separators=(",",":")),stamp))
                        applied.append(oid)
                    db.commit()
                except LookupError as e:
                    db.rollback(); self.send_json(409,{"error":"local_inventory_conflict","product_id":str(e)}); return
                except ValueError as e:
                    db.rollback(); self.send_json(400,{"error":str(e)}); return
                except Exception:
                    db.rollback(); raise
                self.send_json(200,{"ok":True,"applied_order_ids":applied}); return
            if path=="/v1/products" and self.command=="GET":
                term=clean((q.get("q") or [""])[0],100); status=clean((q.get("status") or [""])[0],16)
                if term: rows=db.execute("SELECT * FROM products WHERE status!='archived' AND (name LIKE ? OR sku LIKE ? OR category LIKE ?) ORDER BY updated_at DESC LIMIT 250",("%"+term+"%",)*3).fetchall()
                else: rows=db.execute("SELECT * FROM products WHERE (?='' OR status=?) ORDER BY updated_at DESC LIMIT 250",(status,status)).fetchall()
                summary=db.execute("SELECT COUNT(*) product_count,COALESCE(SUM(quantity),0) units,SUM(CASE WHEN quantity<=5 AND status='active' THEN 1 ELSE 0 END) low_stock FROM products WHERE status!='archived'").fetchone()
                self.send_json(200,{"ok":True,"products":[product_dict(r) for r in rows],"summary":{"product_count":summary["product_count"],"units":summary["units"],"low_stock":summary["low_stock"] or 0}}); return
            if path=="/v1/products" and self.command=="POST":
                p=validate_product(self.body())
                if not p: self.send_json(400,{"error":"invalid_product_fields"}); return
                pid=str(uuid.uuid4()); stamp=now()
                try:
                    db.execute("INSERT INTO products VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(pid,p["sku"],p["name"],p["description"],p["category"],p["image_url"],p["price_cents"],p["cost_cents"],p["quantity"],p["status"],p["variations_json"],p["external_url"],stamp,stamp))
                except sqlite3.IntegrityError: self.send_json(409,{"error":"sku_already_exists"}); return
                if p["quantity"]: movement(db,pid,p["quantity"],"initial stock")
                self.send_json(201,{"ok":True,"product":product_dict(db.execute("SELECT * FROM products WHERE id=?",(pid,)).fetchone())}); return
            match=re.fullmatch(r"/v1/products/([a-f0-9-]{36})",path)
            if match and self.command=="PUT":
                p=validate_product(self.body())
                if not p: self.send_json(400,{"error":"invalid_product_fields"}); return
                old=db.execute("SELECT * FROM products WHERE id=?",(match.group(1),)).fetchone()
                if not old: self.send_json(404,{"error":"product_not_found"}); return
                try:
                    db.execute("UPDATE products SET sku=?,name=?,description=?,category=?,image_url=?,price_cents=?,cost_cents=?,quantity=?,status=?,variations_json=?,external_url=?,updated_at=? WHERE id=?",(p["sku"],p["name"],p["description"],p["category"],p["image_url"],p["price_cents"],p["cost_cents"],p["quantity"],p["status"],p["variations_json"],p["external_url"],now(),match.group(1)))
                except sqlite3.IntegrityError: self.send_json(409,{"error":"sku_already_exists"}); return
                if p["quantity"]!=old["quantity"]: movement(db,match.group(1),p["quantity"]-old["quantity"],"stock adjustment")
                self.send_json(200,{"ok":True,"product":product_dict(db.execute("SELECT * FROM products WHERE id=?",(match.group(1),)).fetchone())}); return
            if match and self.command=="DELETE":
                cur=db.execute("UPDATE products SET status='archived',updated_at=? WHERE id=?",(now(),match.group(1),))
                if not cur.rowcount: self.send_json(404,{"error":"product_not_found"}); return
                self.send_json(200,{"ok":True,"archived":match.group(1)}); return
            if path=="/v1/movements" and self.command=="GET":
                rows=db.execute("SELECT m.id,m.product_id,p.name,p.sku,m.quantity_delta,m.reason,m.created_at FROM inventory_movements m LEFT JOIN products p ON p.id=m.product_id ORDER BY m.created_at DESC LIMIT 100").fetchall()
                self.send_json(200,{"ok":True,"movements":[dict(r) for r in rows]}); return
            if path=="/v1/consume" and self.command=="POST":
                b=self.body(); checkout=b.get("checkout_id"); items=b.get("items")
                if not isinstance(checkout,str) or not UUID_RE.fullmatch(checkout) or not isinstance(items,list) or not 1<=len(items)<=20:
                    self.send_json(400,{"error":"invalid_inventory_consumption"}); return
                db.execute("BEGIN IMMEDIATE")
                try:
                    if db.execute("SELECT 1 FROM inventory_consumptions WHERE checkout_id=?",(checkout,)).fetchone():
                        db.execute("COMMIT"); self.send_json(200,{"ok":True,"already_consumed":True}); return
                    requested={}
                    for item in items:
                        if not isinstance(item,dict) or not isinstance(item.get("product_id"),str) or not UUID_RE.fullmatch(item["product_id"]) or type(item.get("quantity")) is not int or not 1<=item["quantity"]<=99:
                            raise ValueError("invalid_inventory_item")
                        requested[item["product_id"]]=requested.get(item["product_id"],0)+item["quantity"]
                    checked=[]
                    for pid,qty in requested.items():
                        row=db.execute("SELECT quantity FROM products WHERE id=? AND status='active'",(pid,)).fetchone()
                        if not row or row["quantity"]<qty: raise LookupError(pid)
                        checked.append((pid,row["quantity"],qty))
                    stamp=now()
                    for pid,stock,qty in checked:
                        db.execute("UPDATE products SET quantity=?,updated_at=? WHERE id=?",(stock-qty,stamp,pid)); movement(db,pid,-qty,"paid checkout "+checkout)
                    db.execute("INSERT INTO inventory_consumptions VALUES(?,?)",(checkout,stamp)); db.execute("COMMIT")
                    self.send_json(200,{"ok":True,"consumed":len(checked)}); return
                except LookupError as e:
                    db.execute("ROLLBACK"); self.send_json(409,{"error":"insufficient_stock","product_id":str(e)}); return
                except Exception as e:
                    db.execute("ROLLBACK")
                    if str(e)=="invalid_inventory_item": self.send_json(400,{"error":str(e)})
                    else: raise
                return
            self.send_json(404,{"error":"not_found"})
        except Exception as e:
            self.send_json(500,{"error":"stockroom_internal_error","detail":str(e)[:160]})
        finally:
            try: db.close()
            except Exception: pass

if __name__=="__main__":
    if not GATEWAY_TOKEN: raise SystemExit("STOCKROOM_GATEWAY_TOKEN is required")
    DATA_DIR.mkdir(parents=True,exist_ok=True,mode=0o700)
    ThreadingHTTPServer((HOST,PORT),Handler).serve_forever()
