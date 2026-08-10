#!/usr/bin/env python3
"""Private, bounded local Python execution service.

The service deliberately has a small HTTP surface because the web and durable
worker run in separate containers. It is not exposed to the host. Python code
never inherits the application environment, and every subprocess is placed in
its own process group so the service can terminate the whole process tree on a
deadline.
"""

from __future__ import annotations

import base64
import binascii
from contextlib import contextmanager
import hashlib
import hmac
import http.server
import json
import os
import re
try:
    import resource
except ImportError:  # pragma: no cover - Docker production runs on Linux.
    class _ResourceFallback:
        RLIMIT_CORE = 0
        RLIMIT_FSIZE = 1
        RLIMIT_NOFILE = 2
        RLIMIT_NPROC = 3
        RLIMIT_CPU = 4

        @staticmethod
        def setrlimit(_limit: int, _values: tuple[int, int]) -> None:
            return

    resource = _ResourceFallback()
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Callable
from urllib.parse import urlsplit


HOST = "0.0.0.0"
PORT = int(os.environ.get("PYTHON_WORKER_PORT", "5003"))
WORKSPACE_ROOT = Path(os.environ.get("PYTHON_WORKSPACE_ROOT", "/workspaces"))
WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)

CALL_TIMEOUT_SECONDS = 60.0
MAX_RESPONSE_SECONDS = 240.0
MAX_CODE_LENGTH = 64 * 1024
MAX_OUTPUT_BYTES = 64 * 1024
MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
MAX_ARTIFACT_TOTAL_BYTES = 50 * 1024 * 1024
MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_WRITE_BYTES = MAX_ARTIFACT_BYTES
MAX_STREAMING_WRITE_BYTES = 1 * 1024 * 1024 * 1024
MAX_ISOLATED_SOURCE_BYTES = 256 * 1024
MAX_LIST_ENTRIES = 100
MAX_WORKSPACE_FILE_SIZE = MAX_STREAMING_WRITE_BYTES
MAX_SEARCH_QUERY_LENGTH = 1_024
MAX_SEARCH_RESULTS = 100
MAX_SEARCH_FILE_BYTES = 4 * 1024 * 1024
MAX_SEARCH_TOTAL_BYTES = 32 * 1024 * 1024
MAX_COMMAND_ARGS = 32
MAX_COMMAND_ARG_LENGTH = 4_096
MAX_COMMAND_ARG_BYTES = 64 * 1024
MAX_COMMAND_TIMEOUT_SECONDS = CALL_TIMEOUT_SECONDS
WORKSPACE_OPERATION_TIMEOUT_SECONDS = 30.0
SESSION_TTL_SECONDS = MAX_RESPONSE_SECONDS + 60.0
VENV_INITIALIZATION_ATTEMPTS = 2
SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9._:-]{1,200}$")
SAFE_PACKAGE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*(?:[<>=!~]=?[A-Za-z0-9.*+!-]+)?$")
SAFE_PATH = re.compile(r"^[A-Za-z0-9_./ -]+$")
SAFE_COMMAND = re.compile(r"^[A-Za-z0-9._+-]{1,128}$")
RESERVED_ROOTS = {".venv", ".runs"}
BLOCKED_COMMANDS = {"bash", "busybox", "csh", "dash", "fish", "ksh", "sh", "zsh"}


class WorkerError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class DeadlineExceeded(WorkerError):
    def __init__(self):
        super().__init__(408, "Python execution timed out before its deadline.")


@dataclass
class ProcessResult:
    stdout: str
    stderr: str
    exit_code: int
    timed_out: bool = False
    stdout_truncated: bool = False
    stderr_truncated: bool = False


@dataclass
class FileSnapshot:
    path: str
    size: int
    mtime_ns: int


@dataclass
class Session:
    token: str
    key: str
    workspace: Path
    expires_at: float
    process: subprocess.Popen[bytes] | None = None


SECRET = os.environ.get("PYTHON_WORKER_SECRET", "").strip()
if len(SECRET) < 32:
    raise SystemExit("PYTHON_WORKER_SECRET must contain at least 32 characters.")
# The secret is needed only while authenticating HTTP requests. Remove it from
# the worker environment before any user-controlled subprocess is started.
os.environ.pop("PYTHON_WORKER_SECRET", None)

STATE_LOCK = threading.RLock()
EXECUTION_SLOT = threading.Lock()
SESSIONS_BY_TOKEN: dict[str, Session] = {}
TOKENS_BY_KEY: dict[str, set[str]] = {}


def now() -> float:
    return time.monotonic()


def deadline_seconds(deadline_ms: Any, maximum: float = MAX_RESPONSE_SECONDS) -> float:
    if not isinstance(deadline_ms, (int, float)):
        raise WorkerError(400, "deadlineAt must be a number.")
    deadline = min(float(deadline_ms) / 1000.0, time.time() + maximum)
    if deadline <= time.time():
        raise DeadlineExceeded()
    return deadline


def remaining(deadline: float) -> float:
    value = deadline - time.time()
    if value <= 0:
        raise DeadlineExceeded()
    return value


def resource_limits() -> None:
    """Apply per-subprocess limits in addition to the container limits."""
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_WORKSPACE_FILE_SIZE, MAX_WORKSPACE_FILE_SIZE))
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
        resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
        resource.setrlimit(resource.RLIMIT_CPU, (int(CALL_TIMEOUT_SECONDS) + 2, int(CALL_TIMEOUT_SECONDS) + 2))
    except (OSError, ValueError):
        # The Docker limits remain authoritative on platforms that do not
        # expose every Linux resource limit.
        pass


def kill_process_group(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        try:
            process.terminate()
        except ProcessLookupError:
            return
    try:
        process.wait(timeout=1.5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            try:
                process.kill()
            except ProcessLookupError:
                return


def bounded_reader(stream: BinaryIO, limit: int, destination: list[bytes], truncated: list[bool]) -> None:
    size = 0
    try:
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                return
            if size < limit:
                accepted = chunk[: limit - size]
                destination.append(accepted)
                size += len(accepted)
                if len(accepted) != len(chunk):
                    truncated[0] = True
            else:
                truncated[0] = True
    except (OSError, ValueError):
        return


def run_process(
    command: list[str],
    cwd: Path,
    deadline: float,
    stdin: str | bytes | None = None,
    output_limit: int = MAX_OUTPUT_BYTES,
    environment: dict[str, str] | None = None,
    process_callback: Callable[[subprocess.Popen[bytes]], None] | None = None,
) -> ProcessResult:
    try:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=environment,
            shell=False,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            preexec_fn=resource_limits,
        )
    except OSError as error:
        raise WorkerError(503, f"Unable to start Python: {error.strerror or error}") from error

    if process_callback is not None:
        process_callback(process)

    stdout_chunks: list[bytes] = []
    stderr_chunks: list[bytes] = []
    stdout_truncated = [False]
    stderr_truncated = [False]
    stdout_thread = threading.Thread(target=bounded_reader, args=(process.stdout, output_limit, stdout_chunks, stdout_truncated), daemon=True)
    stderr_thread = threading.Thread(target=bounded_reader, args=(process.stderr, output_limit, stderr_chunks, stderr_truncated), daemon=True)
    stdout_thread.start()
    stderr_thread.start()

    def write_input() -> None:
        if process.stdin is None:
            return
        try:
            if stdin is not None:
                process.stdin.write(stdin.encode("utf-8") if isinstance(stdin, str) else stdin)
                process.stdin.flush()
            process.stdin.close()
        except (BrokenPipeError, OSError, ValueError):
            try:
                process.stdin.close()
            except (OSError, ValueError):
                pass

    input_thread = threading.Thread(target=write_input, daemon=True)
    input_thread.start()
    timed_out = False
    try:
        process.wait(timeout=remaining(deadline))
    except (subprocess.TimeoutExpired, DeadlineExceeded):
        timed_out = True
        kill_process_group(process)
    stdout_thread.join(timeout=2)
    stderr_thread.join(timeout=2)
    input_thread.join(timeout=1)
    if timed_out:
        return ProcessResult(
            stdout=decode_output(stdout_chunks, stdout_truncated[0]),
            stderr=decode_output(stderr_chunks, stderr_truncated[0]),
            exit_code=process.returncode if process.returncode is not None else 124,
            timed_out=True,
            stdout_truncated=stdout_truncated[0],
            stderr_truncated=stderr_truncated[0],
        )
    return ProcessResult(
        stdout=decode_output(stdout_chunks, stdout_truncated[0]),
        stderr=decode_output(stderr_chunks, stderr_truncated[0]),
        exit_code=process.returncode if process.returncode is not None else 1,
        stdout_truncated=stdout_truncated[0],
        stderr_truncated=stderr_truncated[0],
    )


def decode_output(chunks: list[bytes], truncated: bool) -> str:
    value = b"".join(chunks).decode("utf-8", errors="replace")
    return value + ("\n[output truncated]" if truncated else "")


def safe_relative(value: Any) -> str:
    if not isinstance(value, str):
        raise WorkerError(400, "workspace paths must be strings.")
    normalized = value.replace("\\", "/").strip()
    while normalized.startswith("./"):
        normalized = normalized[2:]
    pieces = normalized.split("/")
    if (
        not normalized
        or normalized.startswith("/")
        or any(not part or part in {".", ".."} for part in pieces)
        or SAFE_PATH.fullmatch(normalized) is None
        or pieces[0] in RESERVED_ROOTS
    ):
        raise WorkerError(400, "file must be a safe relative path inside the conversation workspace.")
    return normalized


def safe_directory_relative(value: Any, allow_root: bool = False) -> str:
    if allow_root and isinstance(value, str) and value.replace("\\", "/").strip() in {"", ".", "./"}:
        return ""
    return safe_relative(value)


def safe_path(root: Path, relative: str) -> Path:
    # The path is validated before this function and the root is generated by
    # the server, never accepted from the caller.
    return root.joinpath(*relative.split("/"))


def open_regular(root: Path, relative: str) -> int:
    parts = relative.split("/")
    root_fd = os.open(root, os.O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    fd = root_fd
    try:
        for index, part in enumerate(parts):
            flags = os.O_RDONLY | O_CLOEXEC | O_NOFOLLOW
            if index < len(parts) - 1:
                flags |= O_DIRECTORY
            next_fd = os.open(part, flags, dir_fd=fd)
            if fd != root_fd:
                os.close(fd)
            fd = next_fd
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise WorkerError(400, "artifact must be a regular file.")
        os.close(root_fd)
        return fd
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        if fd != root_fd:
            try:
                os.close(root_fd)
            except OSError:
                pass
        raise


def read_bounded(root: Path, relative: str, limit: int = MAX_ARTIFACT_BYTES) -> bytes:
    try:
        fd = open_regular(root, relative)
    except FileNotFoundError as error:
        raise WorkerError(404, "Artifact not found.") from error
    except OSError as error:
        raise WorkerError(400, "artifact must be a regular file.") from error
    chunks: list[bytes] = []
    total = 0
    try:
        while total <= limit:
            chunk = os.read(fd, min(64 * 1024, limit + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        if total > limit:
            raise WorkerError(413, "Artifact exceeds the 25 MiB download limit.")
        return b"".join(chunks)
    finally:
        os.close(fd)


def directory_path(root: Path, relative: str) -> Path:
    try:
        fd = open_directory_chain(root, relative.split("/") if relative else [], create=False)
    except OSError as error:
        raise WorkerError(404, "Workspace directory not found.") from error
    else:
        os.close(fd)
    return safe_path(root, relative)


def open_directory_chain(root: Path, parts: list[str], create: bool) -> int:
    fd = os.open(root, os.O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    try:
        for part in parts:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            next_fd = os.open(part, os.O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except Exception:
        os.close(fd)
        raise


def _sha256_fd(fd: int) -> str:
    digest = hashlib.sha256()
    while True:
        chunk = os.read(fd, 64 * 1024)
        if not chunk:
            return digest.hexdigest()
        digest.update(chunk)


def existing_file_sha256(parent_fd: int, name: str, limit: int = MAX_WRITE_BYTES) -> str | None:
    try:
        fd = os.open(name, os.O_RDONLY | O_NOFOLLOW | O_CLOEXEC, dir_fd=parent_fd)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise WorkerError(400, "Workspace entry must be a regular file.") from error
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise WorkerError(400, "Workspace entry must be a regular file.")
        details = os.fstat(fd)
        if details.st_size > limit:
            if limit == MAX_STREAMING_WRITE_BYTES:
                raise WorkerError(413, "Workspace file exceeds the 1 GiB streaming write limit.")
            raise WorkerError(413, "Workspace file exceeds the 25 MiB limit.")
        return _sha256_fd(fd)
    finally:
        os.close(fd)


def write_workspace_file(
    root: Path,
    relative: str,
    data: bytes,
    replace: bool = False,
    expected_sha256: str | None = None,
) -> bool:
    if len(data) > MAX_WRITE_BYTES:
        raise WorkerError(413, "Workspace file exceeds the 25 MiB limit.")
    if expected_sha256 is not None and re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha256) is None:
        raise WorkerError(400, "expectedSha256 must be a SHA-256 hex digest.")
    if expected_sha256 is not None:
        expected_sha256 = expected_sha256.lower()
    parts = relative.split("/")
    try:
        parent_fd = open_directory_chain(root, parts[:-1], create=True)
    except OSError as error:
        raise WorkerError(400, "Workspace parent is not a safe directory.") from error
    fd = -1
    temporary_name: str | None = None
    replaced = False
    try:
        current_sha256 = existing_file_sha256(parent_fd, parts[-1])
        if expected_sha256 is not None and current_sha256 != expected_sha256:
            raise WorkerError(409, "Workspace file changed before it could be replaced.")
        if current_sha256 is not None and not replace:
            raise WorkerError(409, "Workspace file already exists.")
        if current_sha256 is None and expected_sha256 is not None:
            raise WorkerError(409, "Workspace file changed before it could be replaced.")

        temporary_name = f".workspace-write-{secrets.token_hex(12)}"
        fd = os.open(temporary_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600, dir_fd=parent_fd)
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
        os.close(fd)
        fd = -1
        os.replace(temporary_name, parts[-1], src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        replaced = current_sha256 is not None
    finally:
        if fd >= 0:
            os.close(fd)
        if temporary_name is not None:
            try:
                os.unlink(temporary_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
        os.close(parent_fd)
    return replaced


def write_new_file(root: Path, relative: str, data: bytes) -> None:
    write_workspace_file(root, relative, data)


def write_workspace_stream(
    root: Path,
    relative: str,
    body: BinaryIO,
    size: int,
    replace: bool = False,
    expected_sha256: str | None = None,
) -> tuple[bool, str]:
    if not isinstance(size, int) or isinstance(size, bool) or size < 0 or size > MAX_STREAMING_WRITE_BYTES:
        raise WorkerError(413 if isinstance(size, int) and size > MAX_STREAMING_WRITE_BYTES else 400, "Streaming workspace size must be an integer between 0 and 1 GiB.")
    if not isinstance(replace, bool):
        raise WorkerError(400, "replace must be a boolean.")
    if expected_sha256 is not None and re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha256) is None:
        raise WorkerError(400, "expectedSha256 must be a SHA-256 hex digest.")
    if expected_sha256 is not None:
        expected_sha256 = expected_sha256.lower()
    parts = relative.split("/")
    try:
        parent_fd = open_directory_chain(root, parts[:-1], create=True)
    except OSError as error:
        raise WorkerError(400, "Workspace parent is not a safe directory.") from error
    fd = -1
    temporary_name: str | None = None
    replaced = False
    digest = hashlib.sha256()
    total = 0
    try:
        current_sha256 = existing_file_sha256(parent_fd, parts[-1], MAX_STREAMING_WRITE_BYTES)
        if expected_sha256 is not None and current_sha256 != expected_sha256:
            raise WorkerError(409, "Workspace file changed before it could be replaced.")
        if current_sha256 is not None and not replace:
            raise WorkerError(409, "Workspace file already exists.")
        if current_sha256 is None and expected_sha256 is not None:
            raise WorkerError(409, "Workspace file changed before it could be replaced.")

        temporary_name = f".workspace-stream-{secrets.token_hex(12)}"
        fd = os.open(temporary_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600, dir_fd=parent_fd)
        while total < size:
            try:
                chunk = body.read(min(64 * 1024, size - total))
            except (OSError, ValueError) as error:
                raise WorkerError(400, "Workspace stream body could not be read.") from error
            if not chunk:
                raise WorkerError(400, "Workspace stream body was incomplete.")
            if total + len(chunk) > size:
                raise WorkerError(400, "Workspace stream body exceeded Content-Length.")
            view = memoryview(chunk)
            while view:
                written = os.write(fd, view)
                view = view[written:]
            digest.update(chunk)
            total += len(chunk)
        if total != size:
            raise WorkerError(400, "Workspace stream body length did not match Content-Length.")
        os.fsync(fd)
        os.close(fd)
        fd = -1
        os.replace(temporary_name, parts[-1], src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        replaced = current_sha256 is not None
        return replaced, digest.hexdigest()
    finally:
        if fd >= 0:
            os.close(fd)
        if temporary_name is not None:
            try:
                os.unlink(temporary_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
        os.close(parent_fd)


def create_directory(root: Path, relative: str) -> None:
    parts = relative.split("/")
    parent_fd = open_directory_chain(root, parts[:-1], create=True)
    try:
        os.mkdir(parts[-1], 0o700, dir_fd=parent_fd)
    except FileExistsError as error:
        raise WorkerError(409, "Workspace directory already exists.") from error
    finally:
        os.close(parent_fd)


def snapshot_files(root: Path, deadline: float) -> dict[str, FileSnapshot]:
    result: dict[str, FileSnapshot] = {}
    for base, directories, files in os.walk(root, followlinks=False):
        if time.time() >= deadline:
            raise DeadlineExceeded()
        directories[:] = [directory for directory in directories if directory not in {".venv", ".runs", "__pycache__"} and not os.path.islink(os.path.join(base, directory))]
        for name in files:
            path = Path(base) / name
            try:
                details = path.lstat()
            except OSError:
                continue
            if not stat.S_ISREG(details.st_mode):
                continue
            relative = path.relative_to(root).as_posix()
            result[relative] = FileSnapshot(relative, details.st_size, details.st_mtime_ns)
            if len(result) > 10_000:
                raise WorkerError(413, "Conversation workspace contains too many files.")
    return result


def list_workspace(root: Path, relative: str, deadline: float | None = None) -> list[dict[str, Any]]:
    target = directory_path(root, relative)
    output: list[dict[str, Any]] = []
    for base, directories, files in os.walk(target, followlinks=False):
        if deadline is not None and time.time() >= deadline:
            raise DeadlineExceeded()
        directories[:] = [directory for directory in directories if directory not in {".venv", ".runs", "__pycache__"} and not os.path.islink(os.path.join(base, directory))]
        for name in files:
            path = Path(base) / name
            try:
                details = path.lstat()
            except OSError:
                continue
            if not stat.S_ISREG(details.st_mode):
                continue
            output.append({"path": path.relative_to(root).as_posix(), "size": details.st_size})
            if len(output) > MAX_LIST_ENTRIES:
                raise WorkerError(413, "Workspace source tree contains too many files.")
    return sorted(output, key=lambda item: item["path"])


def search_workspace(
    root: Path,
    relative: str,
    query: str,
    deadline: float | None = None,
    case_sensitive: bool = False,
) -> dict[str, Any]:
    if not isinstance(query, str) or not query or len(query) > MAX_SEARCH_QUERY_LENGTH:
        raise WorkerError(400, "Search query must be a bounded non-empty string.")
    if not isinstance(case_sensitive, bool):
        raise WorkerError(400, "caseSensitive must be a boolean.")
    target = directory_path(root, relative)
    needle = query if case_sensitive else query.casefold()
    matches: list[dict[str, Any]] = []
    scanned_bytes = 0
    truncated = False
    for base, directories, files in os.walk(target, followlinks=False):
        if deadline is not None and time.time() >= deadline:
            raise DeadlineExceeded()
        directories[:] = [directory for directory in directories if directory not in {".venv", ".runs", "__pycache__"} and not os.path.islink(os.path.join(base, directory))]
        for name in files:
            path = Path(base) / name
            try:
                details = path.lstat()
            except OSError:
                continue
            if not stat.S_ISREG(details.st_mode) or details.st_size > MAX_SEARCH_FILE_BYTES:
                continue
            relative_path = path.relative_to(root).as_posix()
            if scanned_bytes + details.st_size > MAX_SEARCH_TOTAL_BYTES:
                truncated = True
                break
            try:
                data = read_bounded(root, relative_path, MAX_SEARCH_FILE_BYTES)
            except WorkerError:
                continue
            scanned_bytes += len(data)
            text = data.decode("utf-8", errors="replace")
            for line_number, line in enumerate(text.splitlines(), start=1):
                haystack = line if case_sensitive else line.casefold()
                column = haystack.find(needle)
                if column < 0:
                    continue
                matches.append({"path": relative_path, "line": line_number, "column": column + 1, "excerpt": line[:4_096]})
                if len(matches) >= MAX_SEARCH_RESULTS:
                    truncated = True
                    break
            if len(matches) >= MAX_SEARCH_RESULTS:
                break
        if truncated or len(matches) >= MAX_SEARCH_RESULTS:
            break
    return {"matches": matches, "truncated": truncated}


def delete_workspace_entry(root: Path, relative: str) -> None:
    parts = relative.split("/")
    try:
        parent_fd = open_directory_chain(root, parts[:-1], create=False)
    except OSError as error:
        raise WorkerError(404, "Workspace entry not found.") from error
    try:
        try:
            details = os.lstat(parts[-1], dir_fd=parent_fd)
        except FileNotFoundError as error:
            raise WorkerError(404, "Workspace entry not found.") from error
        if stat.S_ISREG(details.st_mode):
            os.unlink(parts[-1], dir_fd=parent_fd)
        else:
            raise WorkerError(400, "Workspace entry must be a regular file.")
    finally:
        os.close(parent_fd)


def workspace_key(owner_id: str, workspace_id: str) -> str:
    if SAFE_IDENTIFIER.fullmatch(owner_id) is None or SAFE_IDENTIFIER.fullmatch(workspace_id) is None:
        raise WorkerError(400, "Invalid workspace identity.")
    return hashlib.sha256(f"{owner_id}:{workspace_id}".encode("utf-8")).hexdigest()[:32]


def workspace_for(key: str) -> Path:
    return WORKSPACE_ROOT / key


def remove_session(token: str) -> Session | None:
    session = SESSIONS_BY_TOKEN.pop(token, None)
    if session is None:
        return None
    tokens = TOKENS_BY_KEY.get(session.key)
    if tokens is not None:
        tokens.discard(token)
        if not tokens:
            TOKENS_BY_KEY.pop(session.key, None)
    return session


def cleanup_sessions() -> None:
    expired: list[str] = []
    with STATE_LOCK:
        for token, session in SESSIONS_BY_TOKEN.items():
            if session.expires_at < now():
                expired.append(token)
        for token in expired:
            remove_session(token)


def session_for(token: Any) -> Session:
    if not isinstance(token, str) or not token:
        raise WorkerError(401, "A Python session is required.")
    cleanup_sessions()
    with STATE_LOCK:
        session = SESSIONS_BY_TOKEN.get(token)
        if session is None:
            raise WorkerError(409, "The Python session is no longer active.")
        session.expires_at = now() + SESSION_TTL_SECONDS
        return session


@contextmanager
def execution_slot(deadline: float):
    if not EXECUTION_SLOT.acquire(timeout=remaining(deadline)):
        raise DeadlineExceeded()
    try:
        yield
    finally:
        EXECUTION_SLOT.release()


def base_environment(workspace: Path, extra: dict[str, str] | None = None) -> dict[str, str]:
    environment = {
        "PATH": f"{workspace / '.venv' / 'bin'}:/usr/local/bin:/usr/bin:/bin",
        "HOME": str(workspace),
        "TMPDIR": str(workspace / ".runs"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONUNBUFFERED": "1",
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        "PIP_NO_CACHE_DIR": "1",
        "OMP_NUM_THREADS": "1",
        "OPENBLAS_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
        "NUMEXPR_NUM_THREADS": "1",
        "TOKENIZERS_PARALLELISM": "false",
    }
    if extra:
        for name, value in extra.items():
            if isinstance(name, str) and isinstance(value, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", name):
                environment[name] = value[:16 * 1024]
    (workspace / ".runs").mkdir(parents=True, exist_ok=True)
    return environment


def virtual_environment_paths(root: Path) -> tuple[Path, Path, Path]:
    return root / "bin" / "python", root / "bin" / "pip", root / "pyvenv.cfg"


def virtual_environment_is_ready(root: Path) -> bool:
    python, _pip, config = virtual_environment_paths(root)
    return python.is_file() and config.is_file()


def virtual_environment_is_usable(root: Path, workspace: Path, deadline: float, environment: dict[str, str]) -> bool:
    if not virtual_environment_is_ready(root):
        return False
    python, _pip, _config = virtual_environment_paths(root)
    validation = run_process(
        [str(python), "-c", "import pip, sys; raise SystemExit(0 if sys.prefix != sys.base_prefix else 1)"],
        workspace,
        deadline,
        output_limit=MAX_OUTPUT_BYTES,
        environment=environment,
    )
    if validation.timed_out:
        raise DeadlineExceeded()
    return validation.exit_code == 0


def initialize_virtual_environment(workspace: Path, deadline: float) -> Path:
    target = workspace / ".venv"
    python, _pip, _config = virtual_environment_paths(target)
    environment = base_environment(workspace)

    if virtual_environment_is_usable(target, workspace, deadline, environment):
        return python

    if target.exists():
        # A workspace created by an older worker may contain a partially
        # initialized venv. Repair it in place so existing user-installed
        # packages are preserved.
        result = run_process(["python", "-m", "venv", "--system-site-packages", "--without-pip", str(target)], workspace, deadline, output_limit=MAX_OUTPUT_BYTES, environment=environment)
        if result.timed_out:
            raise DeadlineExceeded()
        if result.exit_code != 0:
            raise WorkerError(500, result.stderr or "Unable to initialize Python workspace.")
        if not virtual_environment_is_usable(target, workspace, deadline, environment):
            raise WorkerError(500, "Python workspace initialization did not produce a usable environment.")
        return python

    # Build new environments outside the published .venv path. If venv setup
    # fails, a later attempt must not mistake a partial directory for a usable
    # environment.
    temporary = Path(tempfile.mkdtemp(prefix=".venv-", dir=str(workspace / ".runs")))
    published = False
    try:
        result = run_process(["python", "-m", "venv", "--system-site-packages", "--without-pip", str(temporary)], workspace, deadline, output_limit=MAX_OUTPUT_BYTES, environment=environment)
        if result.timed_out:
            raise DeadlineExceeded()
        if result.exit_code != 0:
            raise WorkerError(500, result.stderr or "Unable to initialize Python workspace.")
        if not virtual_environment_is_usable(temporary, workspace, deadline, environment):
            raise WorkerError(500, "Python workspace initialization did not produce a usable environment.")
        try:
            os.replace(temporary, target)
            published = True
        except FileExistsError:
            # Another opener may have completed initialization while this
            # request was building its temporary environment.
            if not virtual_environment_is_usable(target, workspace, deadline, environment):
                raise WorkerError(500, "Python workspace initialization raced with another setup attempt.")
    finally:
        if not published and temporary.exists():
            shutil.rmtree(temporary, ignore_errors=True)
    return python


def ensure_virtual_environment(workspace: Path, deadline: float) -> Path:
    last_error: WorkerError | None = None
    for attempt in range(VENV_INITIALIZATION_ATTEMPTS):
        try:
            return initialize_virtual_environment(workspace, deadline)
        except DeadlineExceeded:
            raise
        except WorkerError as error:
            last_error = error
            if attempt + 1 == VENV_INITIALIZATION_ATTEMPTS:
                raise
    raise last_error or WorkerError(500, "Unable to initialize Python workspace.")


def validate_python_input(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise WorkerError(400, "run_python arguments must be an object.")
    allowed = {"code", "file", "packages", "args", "stdin", "artifacts"}
    unexpected = next((key for key in value if key not in allowed), None)
    if unexpected is not None:
        raise WorkerError(400, f"Unexpected run_python argument: {unexpected}.")
    has_code = isinstance(value.get("code"), str) and bool(value["code"].strip())
    has_file = isinstance(value.get("file"), str) and bool(value["file"].strip())
    if has_code == has_file:
        raise WorkerError(400, "Provide exactly one of code or file.")
    if has_code and len(value["code"]) > MAX_CODE_LENGTH:
        raise WorkerError(400, "code is too long.")
    packages = value.get("packages")
    if packages is not None:
        if not isinstance(packages, list) or len(packages) > 20 or any(not isinstance(item, str) or len(item) > 120 or SAFE_PACKAGE.fullmatch(item) is None for item in packages):
            raise WorkerError(400, "packages are invalid.")
    args = value.get("args")
    if args is not None and (not isinstance(args, list) or len(args) > 32 or any(not isinstance(item, str) or len(item) > 4096 for item in args)):
        raise WorkerError(400, "args are invalid.")
    stdin = value.get("stdin")
    if stdin is not None and (not isinstance(stdin, str) or len(stdin) > 64 * 1024):
        raise WorkerError(400, "stdin is too long.")
    artifacts = value.get("artifacts")
    if artifacts is not None and (not isinstance(artifacts, list) or len(artifacts) > 20 or any(not isinstance(item, str) for item in artifacts)):
        raise WorkerError(400, "artifacts are invalid.")
    output: dict[str, Any] = {}
    if has_code:
        output["code"] = value["code"]
    if has_file:
        output["file"] = safe_relative(value["file"])
    if packages:
        output["packages"] = packages
    if args:
        output["args"] = args
    if isinstance(stdin, str):
        output["stdin"] = stdin
    if artifacts:
        output["artifacts"] = [safe_relative(item) for item in artifacts]
    return output


def validate_command_input(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise WorkerError(400, "Command arguments must be an object.")
    allowed = {"command", "args", "cwd", "stdin", "timeoutMs", "deadlineAt"}
    unexpected = next((key for key in value if key not in allowed), None)
    if unexpected is not None:
        raise WorkerError(400, f"Unexpected command argument: {unexpected}.")
    command = value.get("command")
    if not isinstance(command, str) or SAFE_COMMAND.fullmatch(command) is None or command.lower() in BLOCKED_COMMANDS:
        raise WorkerError(400, "command must name a permitted executable without shell syntax.")
    args = value.get("args", [])
    if not isinstance(args, list) or len(args) > MAX_COMMAND_ARGS or any(not isinstance(item, str) or len(item) > MAX_COMMAND_ARG_LENGTH for item in args):
        raise WorkerError(400, "args must contain at most 32 bounded strings.")
    if sum(len(item.encode("utf-8")) for item in args) > MAX_COMMAND_ARG_BYTES:
        raise WorkerError(400, "command arguments are too large.")
    cwd = safe_directory_relative(value.get("cwd", ""), allow_root=True)
    stdin = value.get("stdin")
    if stdin is not None and (not isinstance(stdin, str) or len(stdin.encode("utf-8")) > 64 * 1024):
        raise WorkerError(400, "stdin is too long.")
    timeout_ms = value.get("timeoutMs", int(MAX_COMMAND_TIMEOUT_SECONDS * 1_000))
    if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, (int, float)) or not 1 <= timeout_ms <= MAX_COMMAND_TIMEOUT_SECONDS * 1_000:
        raise WorkerError(400, "timeoutMs must be between 1 and 60000.")
    output: dict[str, Any] = {"command": command, "args": args, "cwd": cwd, "timeoutMs": int(timeout_ms)}
    if isinstance(stdin, str):
        output["stdin"] = stdin
    if "deadlineAt" in value:
        output["deadlineAt"] = value["deadlineAt"]
    return output


def execute_command(session: Session, input_value: Any, deadline: float) -> dict[str, Any]:
    input_data = validate_command_input(input_value)
    workspace = session.workspace
    cwd = directory_path(workspace, input_data["cwd"])
    command_deadline = min(deadline, time.time() + input_data["timeoutMs"] / 1_000.0)
    with execution_slot(command_deadline):
        started_at = time.monotonic()
        before = snapshot_files(workspace, command_deadline)
        execution = run_process(
            [input_data["command"], *input_data["args"]],
            cwd,
            command_deadline,
            stdin=input_data.get("stdin"),
            environment=base_environment(workspace),
        )
        after = snapshot_files(workspace, command_deadline) if not execution.timed_out else before
        changed = [
            item for item in after.values()
            if item.path not in before or before[item.path].size != item.size or before[item.path].mtime_ns != item.mtime_ns
        ][:20]
        result = {
            **result_json(execution),
            "command": input_data["command"],
            "args": input_data["args"],
            "cwd": input_data["cwd"],
            "durationMs": round((time.monotonic() - started_at) * 1_000),
        }
        if changed:
            result["changedFiles"] = [{"path": item.path, "size": item.size} for item in changed]
        return result


def execute_in_workspace(session: Session, input_value: Any, deadline: float) -> dict[str, Any]:
    input_data = validate_python_input(input_value)
    workspace = session.workspace
    with execution_slot(deadline):
        python = ensure_virtual_environment(workspace, deadline)
        before = snapshot_files(workspace, deadline)
        packages = input_data.get("packages", [])
        if packages:
            install = run_process([str(python), "-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir", *packages], workspace, deadline, environment=base_environment(workspace))
            if install.exit_code != 0:
                return result_json(install)
        if "code" in input_data:
            command = [str(python), "-c", input_data["code"], *input_data.get("args", [])]
        else:
            command = [str(python), str(safe_path(workspace, input_data["file"])), *input_data.get("args", [])]
        execution = run_process(command, workspace, min(deadline, time.time() + CALL_TIMEOUT_SECONDS), stdin=input_data.get("stdin"), environment=base_environment(workspace))
        after = snapshot_files(workspace, deadline) if not execution.timed_out else before
        requested = set(input_data.get("artifacts", []))
        candidates = [
            item for item in after.values()
            if (requested and item.path in requested) or item.path not in before or before[item.path].size != item.size or before[item.path].mtime_ns != item.mtime_ns
        ]
        candidates = [item for item in candidates if item.size <= MAX_ARTIFACT_BYTES][:20]
        artifacts: list[dict[str, Any]] = []
        artifact_bytes = 0
        for item in candidates:
            if artifact_bytes + item.size > MAX_ARTIFACT_TOTAL_BYTES:
                break
            data = read_bounded(workspace, item.path)
            if artifact_bytes + len(data) > MAX_ARTIFACT_TOTAL_BYTES:
                break
            artifacts.append({"path": item.path, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
            artifact_bytes += len(data)
        return {
            **result_json(execution),
            **({"artifacts": artifacts} if artifacts else {}),
        }


def result_json(result: ProcessResult) -> dict[str, Any]:
    return {
        "stdout": result.stdout,
        "stderr": result.stderr,
        "exitCode": result.exit_code,
        **({"timedOut": True} if result.timed_out else {}),
        **({"stdoutTruncated": True} if result.stdout_truncated else {}),
        **({"stderrTruncated": True} if result.stderr_truncated else {}),
    }


def execute_isolated(source: str, input_value: Any, environment: dict[str, str], deadline: float) -> dict[str, Any]:
    if not isinstance(source, str) or not source or len(source.encode("utf-8")) > MAX_ISOLATED_SOURCE_BYTES:
        raise WorkerError(400, "Custom Python source is invalid or too large.")
    if not isinstance(environment, dict):
        raise WorkerError(400, "Custom Python environment is invalid.")
    with execution_slot(deadline):
        with tempfile.TemporaryDirectory(prefix="custom-", dir="/tmp") as temporary:
            workspace = Path(temporary)
            result = run_process(["python", "-c", source], workspace, min(deadline, time.time() + CALL_TIMEOUT_SECONDS), stdin=json.dumps(input_value), environment=base_environment(workspace, environment))
            return result_json(result)


class WorkerHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("python-worker " + (format % args) + "\n")

    def authenticated(self) -> bool:
        supplied = self.headers.get("x-python-worker-secret", "")
        return hmac.compare_digest(supplied, SECRET)

    def send_bytes(self, status: int, data: bytes, content_type: str = "application/octet-stream") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(data)
        except BrokenPipeError:
            pass

    def send_json(self, status: int, value: Any) -> None:
        self.send_bytes(status, json.dumps(value, separators=(",", ":")).encode("utf-8"), "application/json")

    def read_body(self, limit: int) -> bytes:
        value = self.headers.get("content-length")
        try:
            length = int(value or "0")
        except ValueError as error:
            raise WorkerError(400, "Invalid content length.") from error
        if length < 0 or length > limit:
            raise WorkerError(413, "Request body is too large.")
        data = self.rfile.read(length)
        if len(data) != length:
            raise WorkerError(400, "Request body was incomplete.")
        return data

    def read_json(self, limit: int = MAX_REQUEST_BYTES) -> dict[str, Any]:
        try:
            value = json.loads(self.read_body(limit))
        except json.JSONDecodeError as error:
            raise WorkerError(400, "Request body must be valid JSON.") from error
        if not isinstance(value, dict):
            raise WorkerError(400, "Request body must be a JSON object.")
        return value

    def stream_size_header(self, name: str) -> int:
        value = self.headers.get(name)
        if value is None or re.fullmatch(r"(?:0|[1-9][0-9]*)", value.strip()) is None:
            raise WorkerError(400, f"{name} must be a non-negative decimal byte count.")
        size = int(value)
        if size > MAX_STREAMING_WRITE_BYTES:
            raise WorkerError(413, "Streaming workspace size exceeds the 1 GiB limit.")
        return size

    def dispatch(self, method: str, path: str) -> tuple[int, Any, str]:
        if path == "/health" and method == "GET":
            return 200, {"status": "ok", "activeSessions": len(SESSIONS_BY_TOKEN)}, "json"
        if not self.authenticated():
            raise WorkerError(401, "Python worker authentication failed.")
        stream_write = path == "/v1/workspace/write-stream" and method == "POST"
        body = {} if stream_write else (self.read_json(MAX_WRITE_BYTES * 2) if method == "PUT" else (self.read_json(MAX_REQUEST_BYTES) if method == "POST" else {}))
        if path == "/v1/sessions/open" and method == "POST":
            owner_id = body.get("ownerId")
            conversation_id = body.get("conversationId")
            workspace_id = body.get("workspaceId", conversation_id)
            key = workspace_key(owner_id, workspace_id)
            with STATE_LOCK:
                cleanup_sessions()
                token = secrets.token_urlsafe(24)
                workspace = workspace_for(key)
                workspace.mkdir(parents=True, exist_ok=True)
                session = Session(token, key, workspace, now() + SESSION_TTL_SECONDS)
                SESSIONS_BY_TOKEN[token] = session
                TOKENS_BY_KEY.setdefault(key, set()).add(token)
            try:
                # Prepare the workspace before the caller receives a session.
                # This keeps venv creation out of the first user-visible
                # execution and serializes setup with normal executions.
                with execution_slot(time.time() + CALL_TIMEOUT_SECONDS):
                    ensure_virtual_environment(workspace, time.time() + CALL_TIMEOUT_SECONDS)
            except Exception:
                with STATE_LOCK:
                    if SESSIONS_BY_TOKEN.get(token) is session:
                        remove_session(token)
                raise
            return 200, {"session": token}, "json"
        if path == "/v1/sessions/close" and method == "POST":
            token = body.get("session")
            with STATE_LOCK:
                if isinstance(token, str):
                    remove_session(token)
            return 200, {"closed": True}, "json"
        if path == "/v1/execute" and method == "POST":
            session = session_for(body.get("session"))
            deadline = deadline_seconds(body.get("deadlineAt"), MAX_RESPONSE_SECONDS)
            result = execute_in_workspace(session, body.get("input"), deadline)
            return 200, result, "json"
        if path == "/v1/command" and method == "POST":
            session = session_for(body.get("session"))
            command_input = {key: value for key, value in body.items() if key != "session"}
            timeout_value = command_input.get("timeoutMs", int(MAX_COMMAND_TIMEOUT_SECONDS * 1_000))
            if isinstance(timeout_value, bool) or not isinstance(timeout_value, (int, float)):
                raise WorkerError(400, "timeoutMs must be a number.")
            deadline_value = body.get("deadlineAt", time.time() * 1_000 + float(timeout_value))
            deadline = deadline_seconds(deadline_value, MAX_RESPONSE_SECONDS)
            return 200, execute_command(session, command_input, deadline), "json"
        if path == "/v1/isolated" and method == "POST":
            deadline = deadline_seconds(body.get("deadlineAt"), CALL_TIMEOUT_SECONDS)
            return 200, execute_isolated(body.get("source"), body.get("input"), body.get("environment", {}), deadline), "json"
        if path == "/v1/workspace/read" and method == "POST":
            session = session_for(body.get("session"))
            relative = safe_relative(body.get("path"))
            with execution_slot(time.time() + 30):
                return 200, read_bounded(session.workspace, relative), "bytes"
        if path == "/v1/workspace/write" and method == "PUT":
            # PUT uses a JSON envelope so the request remains easy to audit and
            # the body limit is still applied before decoding.
            session = session_for(body.get("session"))
            relative = safe_relative(body.get("path"))
            encoded = body.get("bytes")
            if not isinstance(encoded, str):
                raise WorkerError(400, "Workspace bytes are required.")
            try:
                data = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error) as error:
                raise WorkerError(400, "Workspace bytes are invalid.") from error
            replace = body.get("replace", body.get("overwrite", False))
            if not isinstance(replace, bool):
                raise WorkerError(400, "replace must be a boolean.")
            expected_sha256 = body.get("expectedSha256")
            if expected_sha256 is not None and not isinstance(expected_sha256, str):
                raise WorkerError(400, "expectedSha256 must be a SHA-256 hex digest.")
            with execution_slot(time.time() + 30):
                replaced = write_workspace_file(session.workspace, relative, data, replace=replace, expected_sha256=expected_sha256)
            return 200, {"written": True, "replaced": replaced, "sha256": hashlib.sha256(data).hexdigest()}, "json"
        if stream_write:
            session = session_for(self.headers.get("x-python-session"))
            relative = safe_relative(self.headers.get("x-workspace-path"))
            size = self.stream_size_header("x-workspace-size")
            content_length = self.stream_size_header("Content-Length")
            if content_length != size:
                raise WorkerError(400, "Content-Length must match x-workspace-size.")
            replace_header = self.headers.get("x-workspace-replace")
            if replace_header == "true":
                replace = True
            elif replace_header == "false":
                replace = False
            else:
                raise WorkerError(400, "x-workspace-replace must be true or false.")
            expected_sha256 = self.headers.get("x-workspace-expected-sha256")
            if expected_sha256 is not None and re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha256) is None:
                raise WorkerError(400, "expectedSha256 must be a SHA-256 hex digest.")
            with execution_slot(time.time() + MAX_RESPONSE_SECONDS):
                replaced, sha256 = write_workspace_stream(session.workspace, relative, self.rfile, size, replace=replace, expected_sha256=expected_sha256)
            return 200, {"written": True, "replaced": replaced, "size": size, "sha256": sha256}, "json"
        if path == "/v1/workspace/mkdir" and method == "POST":
            session = session_for(body.get("session"))
            relative = safe_relative(body.get("path"))
            if not relative.startswith("documents/"):
                raise WorkerError(400, "Only canonical document directories may be created.")
            with execution_slot(time.time() + 30):
                create_directory(session.workspace, relative)
            return 200, {"created": True}, "json"
        if path == "/v1/workspace/list" and method == "POST":
            session = session_for(body.get("session"))
            relative = safe_directory_relative(body.get("path", ""), allow_root=True)
            deadline = time.time() + WORKSPACE_OPERATION_TIMEOUT_SECONDS
            with execution_slot(deadline):
                return 200, {"items": list_workspace(session.workspace, relative, deadline)}, "json"
        if path == "/v1/workspace/search" and method == "POST":
            session = session_for(body.get("session"))
            relative = safe_directory_relative(body.get("root", body.get("path", "")), allow_root=True)
            query = body.get("query")
            case_sensitive = body.get("caseSensitive", False)
            deadline = time.time() + WORKSPACE_OPERATION_TIMEOUT_SECONDS
            with execution_slot(deadline):
                return 200, search_workspace(session.workspace, relative, query, deadline, case_sensitive), "json"
        if path == "/v1/workspace/delete" and method == "POST":
            if "session" in body or "path" in body:
                session = session_for(body.get("session"))
                relative = safe_relative(body.get("path"))
                with execution_slot(time.time() + WORKSPACE_OPERATION_TIMEOUT_SECONDS):
                    delete_workspace_entry(session.workspace, relative)
                return 200, {"deleted": True}, "json"
            workspace_id = body.get("workspaceId", body.get("conversationId"))
            key = workspace_key(body.get("ownerId"), workspace_id)
            with STATE_LOCK:
                tokens = TOKENS_BY_KEY.pop(key, set())
                for token in tokens:
                    SESSIONS_BY_TOKEN.pop(token, None)
            with execution_slot(time.time() + 10):
                shutil.rmtree(workspace_for(key), ignore_errors=True)
            return 200, {"deleted": True}, "json"
        raise WorkerError(404, "Python worker route not found.")

    def handle_request(self, method: str) -> None:
        path = urlsplit(self.path).path
        try:
            status, payload, kind = self.dispatch(method, path)
            if kind == "bytes":
                self.send_bytes(status, payload)
            else:
                self.send_json(status, payload)
        except WorkerError as error:
            self.send_json(error.status, {"error": str(error)})
        except Exception as error:
            sys.stderr.write(f"python-worker internal error: {type(error).__name__}\n")
            self.send_json(500, {"error": "Python worker failed to complete the request."})

    def do_GET(self) -> None:
        self.handle_request("GET")

    def do_POST(self) -> None:
        self.handle_request("POST")

    def do_PUT(self) -> None:
        self.handle_request("PUT")


class WorkerServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    server = WorkerServer((HOST, PORT), WorkerHandler)
    print(json.dumps({"event": "python-worker-started", "port": PORT, "cpuParallelism": 1, "maxConcurrentExecutions": 1}), flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
