import os
from pathlib import Path

from dotenv import dotenv_values, load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[2]

# STT_SKIP_DOTENV=1 이면 실제 .env 를 읽지 않는다 (테스트 인스턴스가 운영 키/계정 설정을 쓰지 않도록).
if os.getenv("STT_SKIP_DOTENV", "").strip() == "1":
    RAW_DOTENV: dict[str, str] = {}
else:
    load_dotenv(".env", override=True)
    RAW_DOTENV = {key.lstrip("\ufeff"): value for key, value in dotenv_values(".env").items() if key}


def env_value(*names: str, default: str = "") -> str:
    for name in names:
        value = os.getenv(name) or RAW_DOTENV.get(name)
        if value:
            return value.strip()
    return default


CLOVA_SECRET = env_value("CLOVA_SPEECH_SECRET_KEY", "CLOVA_SECRET_KEY", "CLOVA_SECRET")
CLOVA_INVOKE_URL = env_value("CLOVA_SPEECH_INVOKE_URL", "CLOVA_INVOKE_URL", "CLOVA_INVOKE_KEY")
CLAUDE_API_KEY = env_value("CLAUDE_API_KEY", "ANTHROPIC_API_KEY")
CLAUDE_MODEL = env_value("CLAUDE_MODEL", "ANTHROPIC_MODEL", default="claude-3-5-haiku-latest")
CLAUDE_TIMEOUT_SECONDS = int(env_value("CLAUDE_TIMEOUT_SECONDS", "ANTHROPIC_TIMEOUT_SECONDS", default="180"))
ADMIN_API_KEY = env_value("ANTHROPIC_ADMIN_KEY", "CLAUDE_ADMIN_KEY")
# 로그인 시스템: 서버 시작 시 admin 역할 사용자가 하나도 없을 때만 이 값으로 관리자 계정을 만든다.
# 이후에는 output/auth/users.json 이 기준이라 여기 값을 바꿔도 기존 관리자 비밀번호는 바뀌지 않는다.
ADMIN_LOGIN_ID = env_value("ADMIN_LOGIN_ID")
ADMIN_LOGIN_PASSWORD = env_value("ADMIN_LOGIN_PASSWORD")
# 산출물 폴더(녹음·계정·세션·사용 로그). 기본 output/ — 테스트는 STT_OUTPUT_DIR 로 임시 폴더를 지정한다.
_output_dir = Path(env_value("STT_OUTPUT_DIR", default="output"))
OUTPUT_DIR = _output_dir if _output_dir.is_absolute() else PROJECT_ROOT / _output_dir
HAS_CLOVA = bool(CLOVA_SECRET and CLOVA_INVOKE_URL)
HAS_CLAUDE = bool(CLAUDE_API_KEY)
HAS_ADMIN_KEY = bool(ADMIN_API_KEY)
