"""
Web bridge for the GitHub Repository Explorer UI.

Architecture (unchanged):

    Browser UI  ->  MCP Client (this file)  ->  MCP Server (github_server.py)
                                                   ->  GitHub REST API

The browser never talks to GitHub. It calls the small JSON endpoints below,
and every endpoint is answered by calling a tool on the MCP server through a
real MCP client session (the same stdio transport used by github_client.py).

Run with:  python web_app.py   ->   http://127.0.0.1:8000
"""

import re
import sys
import time
import logging
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from starlette.applications import Starlette
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

logger = logging.getLogger("github-explorer")
logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")

# GitHub naming rules (loose): letters, digits, '-', '_', '.'
OWNER_PATTERN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
REPO_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")

# How often the "GitHub API Connected" indicator is allowed to re-probe GitHub
HEALTH_CACHE_SECONDS = 60
HEALTH_PROBE_REPO = ("octocat", "Hello-World")


# --------------------------------------------------
# MCP client lifecycle
# --------------------------------------------------

class MCPBridge:
    """Owns the single MCP client session used by every request."""

    def __init__(self):
        self.session: ClientSession | None = None
        self.tool_names: list[str] = []
        self.github_state = {"ok": None, "reason": None, "checked_at": 0.0}

    async def call(self, tool: str, arguments: dict) -> tuple[str, bool]:
        """Call an MCP tool. Returns (text, is_error)."""
        result = await self.session.call_tool(tool, arguments=arguments)
        text = "\n".join(
            part.text for part in result.content if hasattr(part, "text")
        )
        is_error = bool(
            getattr(result, "is_error", False) or getattr(result, "isError", False)
        )
        return text, is_error


bridge = MCPBridge()


@asynccontextmanager
async def lifespan(app):
    """Start the MCP server as a subprocess and keep a client session open."""
    server_params = StdioServerParameters(
        command=sys.executable,
        args=[str(BASE_DIR / "github_server.py")],
        cwd=str(BASE_DIR),
    )

    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            bridge.session = session
            bridge.tool_names = [t.name for t in (await session.list_tools()).tools]
            logger.info("MCP connected. Tools: %s", ", ".join(bridge.tool_names))
            yield

    bridge.session = None


# --------------------------------------------------
# Parsing helpers (MCP tools return formatted text)
# --------------------------------------------------

def api_error(code: str, message: str, status: int) -> JSONResponse:
    """Friendly error payload. Technical details stay in the server log."""
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


def classify_tool_error(text: str, is_error: bool, context: str) -> JSONResponse | None:
    """
    Turn an MCP tool's error output into a friendly JSON error.
    Returns None when the text is a normal (non-error) result.
    """
    match = re.match(r"GitHub API error: (\d+)", text)

    if match:
        status = int(match.group(1))
        logger.warning("GitHub API error %s while loading %s: %s", status, context, text[:300])
        if status == 404:
            return api_error(
                "not_found",
                "We couldn't find that. Please check the owner and repository name.",
                404
            )

        if status == 401:
            bridge.github_state.update(
                ok=False,
                reason="auth",
                checked_at=time.time()
            )

            return api_error(
                "auth",
                "This repository may be private. This application supports public GitHub repositories only.",
                401
            )

        if status == 429:
            return api_error(
                "rate_limit",
                "GitHub rate limit reached. Please wait a few minutes and try again.",
                429
            )

        if status == 403:
            return api_error(
                "forbidden",
                "GitHub denied access to this resource.",
                403
            )

    if is_error:
        logger.warning("MCP tool error while loading %s: %s", context, text[:300])
        return api_error("tool", "The MCP server couldn't complete that request.", 502)

    return None


def validate_target(owner: str, repo: str) -> JSONResponse | None:
    if not owner or not repo:
        return api_error("invalid", "Please enter both an owner and a repository name.", 400)
    if not OWNER_PATTERN.match(owner) or not REPO_PATTERN.match(repo) or repo in (".", ".."):
        return api_error("invalid", "That owner or repository name doesn't look valid.", 400)
    return None


def clean_path(raw: str) -> str | None:
    """Normalise a repo-relative path. Returns None if it looks unsafe."""
    path = raw.strip().strip("/")
    if any(part in ("..", ".") for part in path.split("/") if part):
        return None
    return path


def parse_repository(text: str) -> dict | None:
    pattern = re.compile(
        r"Repository: (?P<full_name>.+?)\n"
        r"Description: (?P<description>.*?)\n"
        r"Stars: (?P<stars>\d+)\n"
        r"Forks: (?P<forks>\d+)\n"
        r"Open Issues: (?P<open_issues>\d+)\n"
        r"Language: (?P<language>.*?)\n"
        r"Default Branch: (?P<default_branch>.+?)\n"
        r"URL: (?P<url>\S+)",
        re.DOTALL,
    )
    match = pattern.match(text)
    if not match:
        return None

    data = match.groupdict()
    for key in ("stars", "forks", "open_issues"):
        data[key] = int(data[key])
    # The server prints Python's None for missing values
    data["description"] = None if data["description"] == "None" else data["description"]
    data["language"] = None if data["language"] == "None" else data["language"]
    data["owner"], data["name"] = data["full_name"].split("/", 1)
    return data


def parse_file_list(text: str) -> list[dict]:
    """Parse blocks like 'Folder: src\\nPath: src' into [{name, path, type}]."""
    items = []
    for match in re.finditer(r"^(Folder|File): (.+)\nPath: (.+)$", text, re.MULTILINE):
        kind, name, path = match.groups()
        items.append({
            "name": name,
            "path": path,
            "type": "dir" if kind == "Folder" else "file",
        })

    # Folders first, then files, each alphabetical
    items.sort(key=lambda item: (item["type"] != "dir", item["name"].lower()))
    return items


def parse_file_content(text: str) -> dict | None:
    match = re.match(r"File: (.+)\nSize: (\d+) bytes\n\n", text)
    if not match:
        return None
    path, size = match.group(1), int(match.group(2))
    return {
        "path": path,
        "name": path.rsplit("/", 1)[-1],
        "size": size,
        "content": text[match.end():],
    }


# --------------------------------------------------
# API endpoints
# --------------------------------------------------

async def api_status(request):
    """MCP + GitHub connectivity for the header indicators."""
    mcp_connected = bridge.session is not None
    state = bridge.github_state

    # Cheap, cached probe so "GitHub API Connected" reflects reality
    if mcp_connected and time.time() - state["checked_at"] > HEALTH_CACHE_SECONDS:
        owner, repo = HEALTH_PROBE_REPO
        try:
            text, is_error = await bridge.call("get_repository", {"owner": owner, "repo": repo})
            if text.startswith("Repository:"):
                state.update(ok=True, reason=None)
            elif "rate limit" in text.lower():
                state.update(ok=False, reason="rate_limit")
            elif text.startswith("GitHub API error: 401"):
                state.update(ok=False, reason="auth")
            else:
                state.update(ok=False, reason="error")
        except Exception:
            logger.exception("GitHub health probe failed")
            state.update(ok=False, reason="error")
        state["checked_at"] = time.time()

    return JSONResponse({
        "mcp": {"connected": mcp_connected, "tools": bridge.tool_names},
        "github": {"connected": bool(state["ok"]), "reason": state["reason"]},
    })


async def api_repository(request):
    owner = request.query_params.get("owner", "").strip()
    repo = request.query_params.get("repo", "").strip()

    if invalid := validate_target(owner, repo):
        return invalid

    text, is_error = await bridge.call("get_repository", {"owner": owner, "repo": repo})

    if failure := classify_tool_error(text, is_error, f"{owner}/{repo}"):
        return failure

    data = parse_repository(text)
    if data is None:
        logger.error("Could not parse get_repository output: %s", text[:300])
        return api_error("parse", "Received an unexpected response for this repository.", 502)

    bridge.github_state.update(ok=True, reason=None, checked_at=time.time())
    return JSONResponse(data)


async def api_files(request):
    owner = request.query_params.get("owner", "").strip()
    repo = request.query_params.get("repo", "").strip()
    path = clean_path(request.query_params.get("path", ""))

    if invalid := validate_target(owner, repo):
        return invalid
    if path is None:
        return api_error("invalid", "That path doesn't look valid.", 400)

    text, is_error = await bridge.call(
        "list_files", {"owner": owner, "repo": repo, "path": path}
    )

    if failure := classify_tool_error(text, is_error, f"files of {owner}/{repo}/{path}"):
        return failure

    return JSONResponse({"path": path, "items": parse_file_list(text)})


async def api_file(request):
    owner = request.query_params.get("owner", "").strip()
    repo = request.query_params.get("repo", "").strip()
    path = clean_path(request.query_params.get("path", ""))

    if invalid := validate_target(owner, repo):
        return invalid
    if not path:
        return api_error("invalid", "Please choose a file to view.", 400)

    text, is_error = await bridge.call(
        "get_file_content", {"owner": owner, "repo": repo, "path": path}
    )

    if failure := classify_tool_error(text, is_error, f"file {owner}/{repo}/{path}"):
        # get_file_content raises (isError) if the path turns out to be a folder
        return failure

    data = parse_file_content(text)
    if data is None:
        # Messages produced by get_file_content for files it cannot display
        if text.startswith("Could not decode"):
            return api_error("binary", "This looks like a binary file, so it can't be previewed as text.", 415)
        if text.startswith("Unsupported file encoding"):
            return api_error("too_large", "This file is too large to preview.", 413)
        if text.startswith("The specified path is not a file"):
            return api_error("not_file", "That path is a folder, not a file.", 400)
        logger.error("Could not parse get_file_content output: %s", text[:300])
        return api_error("parse", "Received an unexpected response for this file.", 502)

    bridge.github_state.update(ok=True, reason=None, checked_at=time.time())
    return JSONResponse(data)


async def index(request):
    return FileResponse(STATIC_DIR / "index.html")


async def not_ready(request, exc):
    return api_error("mcp", "The MCP server is unavailable. Please restart the application.", 503)


app = Starlette(
    lifespan=lifespan,
    routes=[
        Route("/", index),
        Route("/api/status", api_status),
        Route("/api/repository", api_repository),
        Route("/api/files", api_files),
        Route("/api/file", api_file),
        Mount("/static", StaticFiles(directory=STATIC_DIR), name="static"),
    ],
    # Any unexpected failure (e.g. MCP subprocess died) becomes a friendly 503
    exception_handlers={Exception: not_ready},
)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
