"""로그인/계정 시스템 통합 테스트.

server.py 를 별도 프로세스(포트 8512, 임시 output 폴더, .env 무시)로 띄우고 HTTP 로 검증한다.

    .venv\\Scripts\\python.exe -X utf8 -m unittest tests.test_auth_server -v

운영 인스턴스(8502)나 실제 output/auth/users.json 은 건드리지 않는다.
"""

import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from urllib.parse import urlencode

REPO_ROOT = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get("STT_TEST_PORT", "8512"))
ADMIN_ID = "admin@test.local"
ADMIN_PASSWORD = "test-password-123"
LOGIN_ERROR = "아이디 또는 비밀번호가 올바르지 않습니다."
AUTH_REQUIRED_ERROR = "로그인이 필요합니다."
FORBIDDEN_ERROR = "관리자만 사용할 수 있습니다."
LOCKOUT_ERROR = "로그인 시도가 너무 많습니다. 10분 후 다시 시도하세요."
DISABLED_ERROR = "비활성화된 계정입니다."


def tiny_pdf() -> bytes:
    """pypdf 가 읽을 수 있는 최소 PDF (한 페이지, 텍스트 한 줄)."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        None,  # stream, filled below
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    stream = b"BT /F1 12 Tf 20 100 Td (hello test) Tj ET"
    objects[3] = b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{index} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_pos = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode()
    return bytes(out)


def multipart(fields: dict[str, str], files: dict[str, tuple[str, bytes, str]]) -> tuple[bytes, str]:
    boundary = "----stt-test-" + uuid.uuid4().hex
    body = bytearray()
    for name, value in fields.items():
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode("utf-8")
    for name, (filename, data, content_type) in files.items():
        body += (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\n"
            f"Content-Type: {content_type}\r\n\r\n"
        ).encode("utf-8") + data + b"\r\n"
    body += f"--{boundary}--\r\n".encode("utf-8")
    return bytes(body), f"multipart/form-data; boundary={boundary}"


class Response:
    def __init__(self, status: int, headers: list[tuple[str, str]], body: bytes) -> None:
        self.status = status
        self.headers = headers
        self.body = body

    def header(self, name: str) -> str:
        for key, value in self.headers:
            if key.lower() == name.lower():
                return value
        return ""

    @property
    def json(self) -> dict:
        return json.loads(self.body.decode("utf-8"))

    @property
    def cookie_token(self) -> str:
        """Set-Cookie 의 stt_session 값 (만료 쿠키면 빈 문자열)."""
        set_cookie = self.header("Set-Cookie")
        if not set_cookie.startswith("stt_session="):
            return ""
        return set_cookie.split(";", 1)[0].split("=", 1)[1]


class Client:
    """테스트마다 다른 X-Forwarded-For 를 써서 IP별 호출 제한이 서로 간섭하지 않게 한다."""

    _ip_counter = 0

    def __init__(self) -> None:
        Client._ip_counter += 1
        self.ip = f"10.0.{Client._ip_counter // 256}.{Client._ip_counter % 256}"
        self.token = ""

    def request(self, method: str, path: str, body: bytes | None = None, content_type: str = "", headers: dict | None = None, token: str | None = None) -> Response:
        conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=30)
        all_headers = {"X-Forwarded-For": self.ip, "User-Agent": "stt-auth-test"}
        if content_type:
            all_headers["Content-Type"] = content_type
        use_token = self.token if token is None else token
        if use_token:
            all_headers["Cookie"] = f"stt_session={use_token}"
        all_headers.update(headers or {})
        try:
            conn.request(method, path, body=body, headers=all_headers)
            raw = conn.getresponse()
            return Response(raw.status, raw.getheaders(), raw.read())
        finally:
            conn.close()

    def post_json(self, path: str, payload: dict, **kwargs) -> Response:
        return self.request("POST", path, json.dumps(payload).encode("utf-8"), "application/json", **kwargs)

    def get(self, path: str, **kwargs) -> Response:
        return self.request("GET", path, **kwargs)

    def login(self, login_id: str, password: str) -> Response:
        res = self.post_json("/api/auth/login", {"id": login_id, "password": password})
        if res.status == 200:
            self.token = res.cookie_token
        return res


class AuthServerTest(unittest.TestCase):
    proc: subprocess.Popen | None = None
    output_dir: Path
    log_file = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.output_dir = Path(tempfile.mkdtemp(prefix="stt-auth-test-"))
        env = {
            key: value for key, value in os.environ.items()
            if not key.startswith(("ADMIN_", "STT_", "CLOVA", "CLAUDE", "ANTHROPIC"))
        }
        env.update({
            "PORT": str(PORT),
            "STT_OUTPUT_DIR": str(cls.output_dir),
            "STT_SKIP_DOTENV": "1",
            "ADMIN_LOGIN_ID": ADMIN_ID,
            "ADMIN_LOGIN_PASSWORD": ADMIN_PASSWORD,
            "PYTHONUTF8": "1",
        })
        cls.log_file = open(cls.output_dir / "server-stderr.log", "w", encoding="utf-8")
        cls.proc = subprocess.Popen(
            [sys.executable, "-X", "utf8", "server.py"],
            cwd=str(REPO_ROOT),
            env=env,
            stdout=cls.log_file,
            stderr=subprocess.STDOUT,
        )
        deadline = time.time() + 60
        while time.time() < deadline:
            if cls.proc.poll() is not None:
                cls.log_file.flush()
                raise RuntimeError("server exited early:\n" + (cls.output_dir / "server-stderr.log").read_text(encoding="utf-8", errors="replace"))
            try:
                with socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
                    break
            except OSError:
                time.sleep(0.3)
        else:
            raise RuntimeError("server did not start on port %d" % PORT)

    @classmethod
    def tearDownClass(cls) -> None:
        if cls.proc and cls.proc.poll() is None:
            cls.proc.terminate()
            try:
                cls.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                cls.proc.kill()
                cls.proc.wait(timeout=10)
        if cls.log_file:
            cls.log_file.close()
        shutil.rmtree(cls.output_dir, ignore_errors=True)

    # ---------- helpers ----------

    def admin(self) -> Client:
        client = Client()
        res = client.login(ADMIN_ID, ADMIN_PASSWORD)
        self.assertEqual(res.status, 200, res.body)
        return client

    def create_user(self, admin: Client, login_id: str, name: str = "테스트 사용자", password: str = "user-password-456", role: str | None = None) -> Response:
        payload = {"id": login_id, "name": name, "password": password}
        if role:
            payload["role"] = role
        return admin.post_json("/api/admin/users", payload)

    def unique_id(self, prefix: str) -> str:
        return f"{prefix}-{uuid.uuid4().hex[:6]}@test.local"

    def usage_rows_for(self, ip: str, expected: int, timeout: float = 5.0) -> list[dict]:
        """사용 로그는 응답을 보낸 뒤(finally)에 기록되므로 해당 IP 의 행이 expected 개가 될 때까지 잠시 기다린다."""
        log_path = self.output_dir / "api_usage.jsonl"
        deadline = time.time() + timeout
        rows: list[dict] = []
        while time.time() < deadline:
            if log_path.is_file():
                rows = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines() if line.strip()]
                rows = [r for r in rows if r.get("ip") == ip]
                if len(rows) >= expected:
                    break
            time.sleep(0.05)
        return rows

    # ---------- tests ----------

    def test_bootstrap_admin_from_env(self) -> None:
        users_path = self.output_dir / "auth" / "users.json"
        self.assertTrue(users_path.is_file())
        data = json.loads(users_path.read_text(encoding="utf-8"))
        admins = [u for u in data["users"] if u["role"] == "admin"]
        self.assertEqual([u["id"] for u in admins], [ADMIN_ID])
        self.assertEqual(admins[0]["created_by"], "bootstrap")
        self.assertTrue(admins[0]["password"].startswith("pbkdf2_sha256$200000$"))
        self.assertNotIn(ADMIN_PASSWORD, users_path.read_text(encoding="utf-8"))

    def test_login_success_me_logout(self) -> None:
        client = Client()
        res = client.login(ADMIN_ID, ADMIN_PASSWORD)
        self.assertEqual(res.status, 200)
        self.assertEqual(res.json, {"ok": True, "user": {"id": ADMIN_ID, "name": "관리자", "role": "admin"}})
        cookie = res.header("Set-Cookie")
        self.assertTrue(cookie.startswith("stt_session="), cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Lax", cookie)
        self.assertIn("Path=/", cookie)
        self.assertNotIn("Secure", cookie)  # X-Forwarded-Proto 없음
        self.assertTrue(client.token)

        me = client.get("/api/auth/me")
        self.assertEqual(me.status, 200)
        self.assertTrue(me.json["ok"])
        self.assertEqual(me.json["user"]["id"], ADMIN_ID)
        self.assertEqual(me.json["user"]["role"], "admin")
        self.assertTrue(me.json["user"]["last_login_at"])

        out = client.request("POST", "/api/auth/logout")
        self.assertEqual(out.status, 200)
        self.assertEqual(out.json, {"ok": True})
        self.assertIn("Max-Age=0", out.header("Set-Cookie"))

        after = client.get("/api/auth/me")  # 같은 토큰으로 재시도 → 세션 삭제됨
        self.assertEqual(after.status, 401)
        self.assertEqual(after.json, {"ok": False, "auth_required": True, "error": AUTH_REQUIRED_ERROR})

    def test_secure_cookie_behind_https_proxy(self) -> None:
        client = Client()
        res = client.post_json("/api/auth/login", {"id": ADMIN_ID, "password": ADMIN_PASSWORD}, headers={"X-Forwarded-Proto": "https"})
        self.assertEqual(res.status, 200)
        self.assertIn("Secure", res.header("Set-Cookie"))

    def test_login_failure(self) -> None:
        client = Client()
        wrong = client.login(ADMIN_ID, "wrong-password-xyz")
        self.assertEqual(wrong.status, 401)
        self.assertEqual(wrong.json, {"ok": False, "error": LOGIN_ERROR})
        self.assertEqual(wrong.header("Set-Cookie"), "")
        unknown = client.login("nobody@test.local", "whatever-password")
        self.assertEqual(unknown.status, 401)
        self.assertEqual(unknown.json, {"ok": False, "error": LOGIN_ERROR})
        empty = client.post_json("/api/auth/login", {"id": "", "password": ""})
        self.assertEqual(empty.status, 400)
        bad = client.request("POST", "/api/auth/login", b"not json", "application/json")
        self.assertEqual(bad.status, 400)
        self.assertFalse(bad.json["ok"])
        # 성공 로그인은 대소문자·공백을 무시한 아이디로도 된다
        case = client.login("  " + ADMIN_ID.upper() + " ", ADMIN_PASSWORD)
        self.assertEqual(case.status, 200)

    def test_login_lockout_after_five_failures(self) -> None:
        client = Client()
        target = self.unique_id("lockme")
        for _ in range(5):
            res = client.login(target, "bad-password-000")
            self.assertEqual(res.status, 401)
        locked = client.login(target, "bad-password-000")
        self.assertEqual(locked.status, 429)
        self.assertEqual(locked.json, {"ok": False, "error": LOCKOUT_ERROR})
        # 다른 아이디는 영향 없음
        other = Client().login(ADMIN_ID, ADMIN_PASSWORD)
        self.assertEqual(other.status, 200)

    def test_login_ip_rate_limit(self) -> None:
        client = Client()
        statuses = [client.post_json("/api/auth/login", {"id": self.unique_id("rl"), "password": "x-password-1"}).status for _ in range(21)]
        self.assertEqual(statuses[:20], [401] * 20)
        self.assertEqual(statuses[20], 429)

    def test_admin_create_user_and_user_login(self) -> None:
        admin = self.admin()
        login_id = self.unique_id("alice")
        created = self.create_user(admin, login_id, name="앨리스")
        self.assertEqual(created.status, 201, created.body)
        user = created.json["user"]
        self.assertEqual(user["id"], login_id)
        self.assertEqual(user["name"], "앨리스")
        self.assertEqual(user["role"], "user")
        self.assertEqual(user["created_by"], ADMIN_ID)
        self.assertFalse(user["disabled"])
        self.assertNotIn("password", user)

        dup = self.create_user(admin, login_id.upper())
        self.assertEqual(dup.status, 409)
        short = self.create_user(admin, self.unique_id("short"), password="tooshort")
        self.assertEqual(short.status, 400)
        self.assertIn("10자", short.json["error"])
        bad_role = self.create_user(admin, self.unique_id("role"), role="root")
        self.assertEqual(bad_role.status, 400)

        listing = admin.get("/api/admin/users")
        self.assertEqual(listing.status, 200)
        ids = [u["id"] for u in listing.json["users"]]
        self.assertIn(login_id, ids)
        self.assertIn(ADMIN_ID, ids)
        for item in listing.json["users"]:
            self.assertNotIn("password", item)

        alice = Client()
        res = alice.login(login_id, "user-password-456")
        self.assertEqual(res.status, 200)
        self.assertEqual(res.json["user"], {"id": login_id, "name": "앨리스", "role": "user"})
        self.assertEqual(alice.get("/api/auth/me").json["user"]["role"], "user")

    def test_non_admin_forbidden_on_admin_routes(self) -> None:
        admin = self.admin()
        login_id = self.unique_id("bob")
        self.assertEqual(self.create_user(admin, login_id).status, 201)
        bob = Client()
        self.assertEqual(bob.login(login_id, "user-password-456").status, 200)
        for path in ("/api/admin/users", "/api/admin/usage-log", "/api/admin/usage-summary", "/api/admin/call-log", "/admin-token-check"):
            res = bob.get(path)
            self.assertEqual(res.status, 403, path)
            self.assertEqual(res.json, {"ok": False, "error": FORBIDDEN_ERROR}, path)
        self.assertEqual(bob.post_json("/api/admin/users", {"id": "x@test.local", "name": "x", "password": "p" * 12}).status, 403)
        self.assertEqual(bob.request("DELETE", f"/api/admin/users/{ADMIN_ID}").status, 403)
        # 미로그인은 401 JSON (HTML 이나 Basic 인증 요구가 아님)
        anon = Client()
        res = anon.get("/admin-token-check")
        self.assertEqual(res.status, 401)
        self.assertEqual(res.header("WWW-Authenticate"), "")
        self.assertEqual(res.json, {"ok": False, "auth_required": True, "error": AUTH_REQUIRED_ERROR})
        self.assertEqual(anon.get("/api/admin/users").status, 401)

    def test_paid_and_free_routes_require_login(self) -> None:
        anon = Client()
        expected = {"ok": False, "auth_required": True, "error": AUTH_REQUIRED_ERROR}
        self.assertEqual(anon.post_json("/api/analyze-text", {"transcript": "안녕하세요"}).json, expected)
        self.assertEqual(anon.post_json("/api/translate", {"text": "안녕", "target": "en"}).json, expected)
        self.assertEqual(anon.post_json("/api/evaluate-answer", {"question": {}, "answer": "a", "transcript": ""}).json, expected)
        body, ctype = multipart({}, {"audio": ("a.webm", b"\x00\x01", "audio/webm")})
        self.assertEqual(anon.request("POST", "/api/analyze", body, ctype).status, 401)
        self.assertEqual(anon.post_json("/api/report", {"analysis": {"x": 1}}).json, expected)
        body, ctype = multipart({}, {"material": ("m.pdf", tiny_pdf(), "application/pdf")})
        self.assertEqual(anon.request("POST", "/api/material-preview", body, ctype).status, 401)
        body, ctype = multipart({}, {"audio": ("rec.webm", b"\x00", "audio/webm")})
        self.assertEqual(anon.request("POST", "/api/save-recording", body, ctype).status, 401)
        # 만료/위조 토큰도 401
        self.assertEqual(anon.get("/api/auth/me", token="forged-token").status, 401)
        # 로그인 전 요청은 사용 로그에 남지 않는다 (사용자가 없으므로)
        time.sleep(0.3)
        self.assertEqual(self.usage_rows_for(anon.ip, expected=1, timeout=0.5), [])

    def test_static_files_stay_public(self) -> None:
        anon = Client()
        self.assertEqual(anon.get("/").status, 200)
        self.assertIn("text/html", anon.get("/index.html").header("Content-Type"))
        self.assertEqual(anon.get("/app.js").status, 200)
        self.assertEqual(anon.get("/styles.css").status, 200)
        self.assertEqual(anon.get("/favicon.ico").status, 200)
        self.assertEqual(anon.get("/server.py").status, 404)
        self.assertEqual(anon.get("/.env").status, 404)

    def test_usage_log_written_for_material_preview(self) -> None:
        admin = self.admin()
        pdf = tiny_pdf()
        body, ctype = multipart({}, {"material": ("slides.pdf", pdf, "application/pdf")})
        res = admin.request("POST", "/api/material-preview", body, ctype)
        self.assertEqual(res.status, 200, res.body)
        self.assertTrue(res.json["ok"])
        self.assertEqual(res.json["type"], "PDF")

        mine = self.usage_rows_for(admin.ip, expected=1)
        self.assertEqual(len(mine), 1)
        row = mine[0]
        self.assertEqual(row["user_id"], ADMIN_ID)
        self.assertEqual(row["role"], "admin")
        self.assertEqual(row["path"], "/api/material-preview")
        self.assertEqual(row["feature"], "자료 미리보기")
        self.assertTrue(row["ok"])
        self.assertEqual(row["status"], 200)
        self.assertEqual(row["bytes_in"], len(body))
        self.assertGreaterEqual(row["elapsed_ms"], 0)
        self.assertTrue(row["ts_kst"].endswith("+09:00"))
        self.assertEqual(row["detail"]["file_name"], "slides.pdf")
        self.assertEqual(row["detail"]["file_size"], len(pdf))
        self.assertEqual(row["detail"]["material_type"], "PDF")
        self.assertNotIn("hello test", json.dumps(row, ensure_ascii=False))

        # 실패 호출도 기록된다 (자료 없음 → 400)
        body2, ctype2 = multipart({"x": "1"}, {})
        self.assertEqual(admin.request("POST", "/api/material-preview", body2, ctype2).status, 400)
        mine = self.usage_rows_for(admin.ip, expected=2)
        self.assertEqual(len(mine), 2)
        self.assertFalse(mine[1]["ok"])
        self.assertEqual(mine[1]["status"], 400)

        # 관리자 조회 API
        log = admin.get("/api/admin/usage-log?" + urlencode({"limit": 5, "user": ADMIN_ID, "feature": "자료 미리보기"}))
        self.assertEqual(log.status, 200)
        self.assertTrue(log.json["ok"])
        self.assertGreaterEqual(len(log.json["items"]), 2)
        self.assertEqual(log.json["items"][0]["status"], 400)  # 최신순
        summary = admin.get("/api/admin/usage-summary").json
        self.assertTrue(summary["ok"])
        self.assertGreaterEqual(summary["total"], 2)
        self.assertIn(ADMIN_ID, [u["user_id"] for u in summary["by_user"]])
        self.assertIn("자료 미리보기", [f["feature"] for f in summary["by_feature"]])

    def test_disabled_user(self) -> None:
        admin = self.admin()
        login_id = self.unique_id("carol")
        self.assertEqual(self.create_user(admin, login_id).status, 201)
        carol = Client()
        self.assertEqual(carol.login(login_id, "user-password-456").status, 200)

        res = admin.post_json(f"/api/admin/users/{login_id}/status", {"disabled": True})
        self.assertEqual(res.status, 200, res.body)
        self.assertTrue(res.json["user"]["disabled"])

        # 기존 세션으로는 401 "비활성화된 계정입니다."
        me = carol.get("/api/auth/me")
        self.assertEqual(me.status, 401)
        self.assertEqual(me.json, {"ok": False, "auth_required": True, "error": DISABLED_ERROR})
        self.assertEqual(carol.post_json("/api/translate", {"text": "a", "target": "en"}).status, 401)
        # 새 로그인은 일반 실패 메시지 (계정 상태를 노출하지 않음)
        again = Client().login(login_id, "user-password-456")
        self.assertEqual(again.status, 401)
        self.assertEqual(again.json, {"ok": False, "error": LOGIN_ERROR})

        # 다시 활성화하면 로그인 가능
        self.assertEqual(admin.post_json(f"/api/admin/users/{login_id}/status", {"disabled": False}).status, 200)
        self.assertEqual(Client().login(login_id, "user-password-456").status, 200)
        # 자기 자신 비활성화 불가, 잘못된 값 400, 없는 사용자 404
        self.assertEqual(admin.post_json(f"/api/admin/users/{ADMIN_ID}/status", {"disabled": True}).status, 400)
        self.assertEqual(admin.post_json(f"/api/admin/users/{login_id}/status", {"disabled": "yes"}).status, 400)
        self.assertEqual(admin.post_json("/api/admin/users/ghost@test.local/status", {"disabled": True}).status, 404)

    def test_delete_user_drops_session(self) -> None:
        admin = self.admin()
        login_id = self.unique_id("dave")
        self.assertEqual(self.create_user(admin, login_id).status, 201)
        dave = Client()
        self.assertEqual(dave.login(login_id, "user-password-456").status, 200)
        self.assertEqual(dave.get("/api/auth/me").status, 200)

        res = admin.request("DELETE", f"/api/admin/users/{login_id}")
        self.assertEqual(res.status, 200, res.body)
        self.assertTrue(res.json["ok"])
        self.assertEqual(res.json["sessions_dropped"], 1)

        self.assertEqual(dave.get("/api/auth/me").status, 401)
        self.assertNotIn(login_id, [u["id"] for u in admin.get("/api/admin/users").json["users"]])
        self.assertEqual(Client().login(login_id, "user-password-456").status, 401)
        self.assertEqual(admin.request("DELETE", f"/api/admin/users/{ADMIN_ID}").status, 400)  # 자기 자신 삭제 불가
        self.assertEqual(admin.request("DELETE", f"/api/admin/users/{login_id}").status, 404)

    def test_admin_reset_password(self) -> None:
        admin = self.admin()
        login_id = self.unique_id("erin")
        self.assertEqual(self.create_user(admin, login_id).status, 201)
        erin = Client()
        self.assertEqual(erin.login(login_id, "user-password-456").status, 200)
        self.assertEqual(admin.post_json(f"/api/admin/users/{login_id}/password", {"password": "short"}).status, 400)
        res = admin.post_json(f"/api/admin/users/{login_id}/password", {"password": "new-password-789"})
        self.assertEqual(res.status, 200, res.body)
        self.assertEqual(erin.get("/api/auth/me").status, 401)  # 기존 세션 종료
        self.assertEqual(Client().login(login_id, "user-password-456").status, 401)
        self.assertEqual(Client().login(login_id, "new-password-789").status, 200)

    def test_change_own_password(self) -> None:
        admin = self.admin()
        login_id = self.unique_id("frank")
        self.assertEqual(self.create_user(admin, login_id).status, 201)
        frank = Client()
        self.assertEqual(frank.login(login_id, "user-password-456").status, 200)
        self.assertEqual(Client().post_json("/api/auth/change-password", {"current_password": "a", "new_password": "b" * 12}).status, 401)
        wrong = frank.post_json("/api/auth/change-password", {"current_password": "nope-nope-nope", "new_password": "fresh-password-321"})
        self.assertEqual(wrong.status, 400)
        self.assertFalse(wrong.json["ok"])
        short = frank.post_json("/api/auth/change-password", {"current_password": "user-password-456", "new_password": "short"})
        self.assertEqual(short.status, 400)
        ok = frank.post_json("/api/auth/change-password", {"current_password": "user-password-456", "new_password": "fresh-password-321"})
        self.assertEqual(ok.status, 200, ok.body)
        self.assertEqual(ok.json, {"ok": True})
        self.assertEqual(frank.get("/api/auth/me").status, 200)  # 현재 세션은 유지
        self.assertEqual(Client().login(login_id, "fresh-password-321").status, 200)
        self.assertEqual(Client().login(login_id, "user-password-456").status, 401)

    # ---------- 계정별 분석 기록 ----------

    def test_history_requires_login(self) -> None:
        client = Client()
        res = client.get("/api/history")
        self.assertEqual(res.status, 401)
        self.assertTrue(res.json.get("auth_required"))

    def test_history_save_list_get_delete_per_user(self) -> None:
        admin = self.admin()
        self.create_user(admin, "hist-user-a", password="hist-password-123")
        self.create_user(admin, "hist-user-b", password="hist-password-456")
        a = Client()
        self.assertEqual(a.login("hist-user-a", "hist-password-123").status, 200)
        b = Client()
        self.assertEqual(b.login("hist-user-b", "hist-password-456").status, 200)
        analysis = {"score": 82, "grade": "B+", "wpm": 113.4, "filler_total": 6, "sentence_segments": [{"text": "안녕하세요"}], "transcript": "안녕하세요 발표를 시작합니다"}
        res = a.post_json("/api/history", {"title": "테스트 발표", "audio": "test.m4a", "material": "deck.pdf", "analysis": analysis})
        self.assertEqual(res.status, 201, res.body)
        meta = res.json["item"]
        self.assertEqual(meta["title"], "테스트 발표")
        self.assertEqual(meta["score"], 82)
        self.assertEqual(meta["grade"], "B+")
        self.assertEqual(meta["wpm"], 113)
        self.assertEqual(meta["fillers"], 6)
        self.assertEqual(meta["sentences"], 1)
        item_id = meta["id"]
        listed = a.get("/api/history").json
        self.assertEqual([m["id"] for m in listed["items"]], [item_id])
        got = a.get(f"/api/history/{item_id}").json
        self.assertTrue(got["ok"])
        self.assertEqual(got["item"]["analysis"]["transcript"], analysis["transcript"])
        # the other account sees nothing and cannot open or delete it
        self.assertEqual(b.get("/api/history").json["items"], [])
        self.assertEqual(b.get(f"/api/history/{item_id}").status, 404)
        self.assertEqual(b.request("DELETE", f"/api/history/{item_id}").status, 404)
        # stored on disk under the user's own folder
        folder = self.output_dir / "users" / "hist-user-a" / "analyses"
        self.assertTrue((folder / f"{item_id}.json").is_file())
        # admin user list shows the count
        users = {u["id"]: u for u in admin.get("/api/admin/users").json["users"]}
        self.assertEqual(users["hist-user-a"]["analyses"], 1)
        # delete
        self.assertEqual(a.request("DELETE", f"/api/history/{item_id}").status, 200)
        self.assertEqual(a.get("/api/history").json["items"], [])
        self.assertEqual(a.get(f"/api/history/{item_id}").status, 404)

    def test_history_qa_progress_saved_per_item(self) -> None:
        admin = self.admin()
        self.create_user(admin, "qa-user", password="qa-password-123")
        c = Client()
        self.assertEqual(c.login("qa-user", "qa-password-123").status, 200)
        analysis = {"score": 70, "questions": [{"question": "q1"}, {"question": "q2"}], "document_match": {"available": True, "sections": [{"page": 1}, {"page": 2}]}}
        meta = c.post_json("/api/history", {"title": "QA", "analysis": analysis}).json["item"]
        self.assertEqual((meta["questions"], meta["pages"], meta["qa_done"], meta["qa_avg"]), (2, 2, 0, 0))
        qa = {"answers": {"0": "답변"}, "results": {"0": {"score": 82, "logic": 88}}, "info": {"0": {"seconds": 72, "mode": "voice"}}}
        res = c.post_json(f"/api/history/{meta['id']}/qa", {"qa": qa})
        self.assertEqual(res.status, 200, res.body)
        self.assertEqual((res.json["item"]["qa_done"], res.json["item"]["qa_avg"]), (1, 82))
        got = c.get(f"/api/history/{meta['id']}").json["item"]
        self.assertEqual(got["qa"]["results"]["0"]["score"], 82)
        self.assertEqual(got["qa"]["info"]["0"]["mode"], "voice")
        self.assertEqual(c.get("/api/history").json["items"][0]["qa_done"], 1)
        self.assertEqual(c.post_json("/api/history/nope-nope/qa", {"qa": qa}).status, 404)
        self.assertEqual(c.post_json(f"/api/history/{meta['id']}/qa", {"qa": "bad"}).status, 400)
        self.assertEqual(Client().post_json(f"/api/history/{meta['id']}/qa", {"qa": qa}).status, 401)

    def test_history_rejects_bad_input(self) -> None:
        admin = self.admin()
        self.create_user(admin, "hist-user-c", password="hist-password-789")
        c = Client()
        self.assertEqual(c.login("hist-user-c", "hist-password-789").status, 200)
        self.assertEqual(c.post_json("/api/history", {"title": "x"}).status, 400)
        self.assertEqual(c.get("/api/history/..%2F..%2Fetc").status, 400)
        self.assertEqual(c.request("DELETE", "/api/history/not-a-valid-id-with-$").status, 400)

    def test_sessions_file_holds_hashes_only(self) -> None:
        client = Client()
        self.assertEqual(client.login(ADMIN_ID, ADMIN_PASSWORD).status, 200)
        sessions_path = self.output_dir / "auth" / "sessions.json"
        text = sessions_path.read_text(encoding="utf-8")
        self.assertNotIn(client.token, text)
        data = json.loads(text)
        self.assertTrue(all(len(key) == 64 for key in data))
        self.assertTrue(any(v["user_id"] == ADMIN_ID and v["ip"] == client.ip for v in data.values()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
