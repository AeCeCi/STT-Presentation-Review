"""로그인/계정 관리 모듈.

- store.py      : 사용자 계정 저장소 (output/auth/users.json), 비밀번호 해시·검증
- sessions.py   : 로그인 세션 저장소 (output/auth/sessions.json), 쿠키 헤더 생성
- usage_log.py  : 로그인 사용자별 기능 호출 로그 (output/api_usage.jsonl)
- manage.py     : 계정 관리 CLI (python -m presentation_review.auth.manage ...)
"""
