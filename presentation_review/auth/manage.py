"""계정 관리 CLI.

    python -m presentation_review.auth.manage create-user <id> --name <name> [--role user|admin] [--password-env VAR]
    python -m presentation_review.auth.manage list-users
    python -m presentation_review.auth.manage set-password <id> [--password-env VAR]
    python -m presentation_review.auth.manage disable <id>
    python -m presentation_review.auth.manage enable <id>
    python -m presentation_review.auth.manage delete <id>

비밀번호는 --password-env 로 지정한 환경 변수에서 읽거나 getpass 프롬프트로 입력받는다.
명령행 인자로는 받지 않으며, 출력에는 비밀번호나 해시가 절대 포함되지 않는다.
"""

import argparse
import getpass
import os
import sys

from . import sessions, store


def read_password(env_name: str | None, confirm: bool) -> str:
    if env_name:
        value = os.environ.get(env_name, "")
        if not value:
            raise SystemExit(f"환경 변수 {env_name} 가 비어 있습니다.")
        return value
    if not sys.stdin or not sys.stdin.isatty():
        raise SystemExit("터미널이 아니어서 비밀번호를 물을 수 없습니다. --password-env VAR 를 사용하세요.")
    first = getpass.getpass("비밀번호 (10자 이상): ")
    if confirm:
        second = getpass.getpass("비밀번호 확인: ")
        if first != second:
            raise SystemExit("비밀번호가 서로 다릅니다.")
    return first


def print_user(user: dict) -> None:
    status = "비활성" if user.get("disabled") else "활성"
    print(
        f"{user.get('id')}\t{user.get('name')}\t{user.get('role')}\t{status}\t"
        f"생성 {user.get('created_at') or '-'} ({user.get('created_by') or '-'})\t"
        f"최근 로그인 {user.get('last_login_at') or '-'}"
    )


def cmd_create_user(args: argparse.Namespace) -> int:
    password = read_password(args.password_env, confirm=True)
    user = store.create_user(args.id, args.name, password, role=args.role, created_by="cli")
    print(f"사용자를 만들었습니다: {user['id']} ({user['role']}) -> {store.USERS_PATH}")
    return 0


def cmd_list_users(args: argparse.Namespace) -> int:
    users = store.list_users()
    if not users:
        print(f"등록된 사용자가 없습니다. ({store.USERS_PATH})")
        return 0
    print("id\tname\trole\tstatus\tcreated\tlast_login")
    for user in users:
        print_user(user)
    print(f"총 {len(users)}명 · 활성 세션 {sessions.count_sessions()}개 · {store.USERS_PATH}")
    return 0


def cmd_set_password(args: argparse.Namespace) -> int:
    if store.get_user(args.id) is None:
        raise SystemExit(f"사용자를 찾을 수 없습니다: {args.id}")
    password = read_password(args.password_env, confirm=True)
    store.set_password(args.id, password)
    dropped = sessions.delete_user_sessions(args.id)
    print(f"비밀번호를 변경했습니다: {store.normalize_id(args.id)} (기존 세션 {dropped}개 종료)")
    return 0


def cmd_disable(args: argparse.Namespace) -> int:
    user = store.set_disabled(args.id, True)
    dropped = sessions.delete_user_sessions(args.id)
    print(f"비활성화했습니다: {user['id']} (세션 {dropped}개 종료)")
    return 0


def cmd_enable(args: argparse.Namespace) -> int:
    user = store.set_disabled(args.id, False)
    print(f"활성화했습니다: {user['id']}")
    return 0


def cmd_delete(args: argparse.Namespace) -> int:
    user = store.delete_user(args.id)
    dropped = sessions.delete_user_sessions(args.id)
    print(f"삭제했습니다: {user['id']} (세션 {dropped}개 종료)")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m presentation_review.auth.manage", description="발표 리뷰 서비스 계정 관리")
    sub = parser.add_subparsers(dest="command", required=True)

    create = sub.add_parser("create-user", help="사용자 생성")
    create.add_argument("id", help="로그인 아이디 (대소문자 구분 없음)")
    create.add_argument("--name", required=True, help="표시 이름")
    create.add_argument("--role", choices=list(store.ROLES), default="user")
    create.add_argument("--password-env", metavar="VAR", help="비밀번호를 담은 환경 변수 이름 (없으면 프롬프트)")
    create.set_defaults(func=cmd_create_user)

    listing = sub.add_parser("list-users", help="사용자 목록")
    listing.set_defaults(func=cmd_list_users)

    setpw = sub.add_parser("set-password", help="비밀번호 재설정 (기존 세션 종료)")
    setpw.add_argument("id")
    setpw.add_argument("--password-env", metavar="VAR")
    setpw.set_defaults(func=cmd_set_password)

    disable = sub.add_parser("disable", help="계정 비활성화")
    disable.add_argument("id")
    disable.set_defaults(func=cmd_disable)

    enable = sub.add_parser("enable", help="계정 활성화")
    enable.add_argument("id")
    enable.set_defaults(func=cmd_enable)

    delete = sub.add_parser("delete", help="계정 삭제 (세션도 삭제)")
    delete.add_argument("id")
    delete.set_defaults(func=cmd_delete)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args) or 0)
    except store.AuthError as exc:
        print(f"오류: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
