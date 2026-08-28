import os

from dotenv import dotenv_values, load_dotenv

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
ADMIN_PAGE_PASSWORD = env_value("ADMIN_PAGE_PASSWORD")
HAS_CLOVA = bool(CLOVA_SECRET and CLOVA_INVOKE_URL)
HAS_CLAUDE = bool(CLAUDE_API_KEY)
HAS_ADMIN_KEY = bool(ADMIN_API_KEY)
