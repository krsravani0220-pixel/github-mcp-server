# GitHub MCP Server

A Model Context Protocol (MCP) server that connects to the GitHub REST API and allows an MCP client to explore GitHub repositories.

## Project Overview

This project demonstrates how MCP can be used to connect an AI application/client with a third-party service such as GitHub.

The MCP server communicates with the GitHub REST API and exposes repository exploration capabilities as MCP tools.

## Architecture

User
↓
MCP Client
↓
GitHub MCP Server
↓
GitHub REST API
↓
GitHub Repository

## MCP Tools

### 1. get_repository()

Retrieves basic information about a GitHub repository.

Returns:
- Repository name
- Description
- Stars
- Forks
- Open issues
- Programming language
- Default branch
- Repository URL

### 2. list_files()

Lists files and folders in a GitHub repository.

It can also explore a specific folder path.

### 3. get_file_content()

Retrieves the contents of a file from a GitHub repository.

The GitHub API returns file content in Base64 format, which the server decodes before returning it to the MCP client.

### 4. search_code()

Searches for code within a GitHub repository and returns matching files and paths.

## Technologies Used

- Python
- Model Context Protocol (MCP)
- GitHub REST API
- Requests
- python-dotenv

## Web UI

A lightweight web interface sits on top of the existing MCP client/server. The browser never calls GitHub directly: every request goes through a real MCP client session.

```text
Browser UI
↓
web_app.py  (MCP client over stdio)
↓
github_server.py  (MCP server)
↓
GitHub REST API
```

### Run it

```bash
pip install -r requirements.txt
```

Add your token to `.env`:

```text
GITHUB_TOKEN=your_github_token
```

Start the app and open http://127.0.0.1:8000:

```bash
python web_app.py
```

The original command-line client still works: `python github_client.py`.

### Features

- Repository overview: description, stars, forks, open issues, language, default branch and URL
- Lazy-loading file tree: click a folder to expand it, click a file to open it
- Code viewer with line numbers, file size, line count and a copy button
- Live "MCP Connected" and "GitHub API Connected" status indicators
- Loading, empty and error states (not found, authentication, rate limit, API errors)
- Shareable links such as `/?owner=microsoft&repo=vscode`
- Responsive layout for desktop, laptop, tablet and mobile

### How the UI maps to MCP tools

| UI endpoint | MCP tool |
| --- | --- |
| `GET /api/repository?owner=&repo=` | `get_repository` |
| `GET /api/files?owner=&repo=&path=` | `list_files` |
| `GET /api/file?owner=&repo=&path=` | `get_file_content` |
| `GET /api/status` | MCP session state (plus a cached `get_repository` probe) |

The MCP tools return formatted text, so `web_app.py` parses that text into JSON for the browser and turns tool errors into short, friendly messages. Technical details stay in the server log.

## Project Structure

```text
github-mcp-server/
│
├── .env
├── .gitignore
├── requirements.txt
├── github_server.py      # MCP server (GitHub tools)
├── github_client.py      # Command-line MCP client
├── web_app.py            # Web bridge: MCP client + JSON API for the UI
└── static/
    ├── index.html
    ├── styles.css
    └── app.js
```
