import os
import base64
import requests
from dotenv import load_dotenv
from mcp.server.mcpserver import MCPServer

# Load environment variables
load_dotenv()

GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")
GITHUB_API_URL = "https://api.github.com"

# Create MCP server
server = MCPServer(name="GitHub Repository Server")


# --------------------------------------------------
# GitHub API helper
# --------------------------------------------------

def github_request(endpoint, params=None):
    """
    Send a GET request to the GitHub REST API.
    """

    url = GITHUB_API_URL + endpoint

    headers = {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github+json"
    }

    response = requests.get(
        url,
        headers=headers,
        params=params,
        timeout=30
    )

    if response.status_code != 200:
        return {
            "error": True,
            "status_code": response.status_code,
            "message": response.text
        }

    return response.json()


# --------------------------------------------------
# Tool 1: Get repository information
# --------------------------------------------------

@server.tool()
async def get_repository(owner: str, repo: str) -> str:
    """
    Get basic information about a GitHub repository.
    """

    data = github_request(
        f"/repos/{owner}/{repo}"
    )

    if data.get("error"):
        return (
            f"GitHub API error: {data['status_code']}\n"
            f"{data['message']}"
        )

    return (
        f"Repository: {data['full_name']}\n"
        f"Description: {data['description']}\n"
        f"Stars: {data['stargazers_count']}\n"
        f"Forks: {data['forks_count']}\n"
        f"Open Issues: {data['open_issues_count']}\n"
        f"Language: {data['language']}\n"
        f"Default Branch: {data['default_branch']}\n"
        f"URL: {data['html_url']}"
    )


# --------------------------------------------------
# Tool 2: List repository files
# --------------------------------------------------

@server.tool()
async def list_files(
    owner: str,
    repo: str,
    path: str = ""
) -> str:
    """
    List files and folders in a GitHub repository.
    A path can optionally be provided to explore a specific folder.
    """

    endpoint = f"/repos/{owner}/{repo}/contents"

    if path:
        endpoint += f"/{path}"

    data = github_request(endpoint)

    if isinstance(data, dict) and data.get("error"):
        return (
            f"GitHub API error: {data['status_code']}\n"
            f"{data['message']}"
        )

    # If the path points to a single file
    if isinstance(data, dict):
        return (
            f"Name: {data['name']}\n"
            f"Type: {data['type']}\n"
            f"Path: {data['path']}\n"
            f"URL: {data['html_url']}"
        )

    output = []

    for item in data:

        if item["type"] == "dir":
            item_type = "Folder"
        else:
            item_type = "File"

        output.append(
            f"{item_type}: {item['name']}\n"
            f"Path: {item['path']}"
        )

    if not output:
        return "No files or folders found."

    return "\n\n".join(output)


# --------------------------------------------------
# Tool 3: Get file content
# --------------------------------------------------

@server.tool()
async def get_file_content(
    owner: str,
    repo: str,
    path: str
) -> str:
    """
    Get the contents of a file from a GitHub repository.
    """

    endpoint = f"/repos/{owner}/{repo}/contents/{path}"

    data = github_request(endpoint)

    if isinstance(data, dict) and data.get("error"):
        return (
            f"GitHub API error: {data['status_code']}\n"
            f"{data['message']}"
        )

    if data.get("type") != "file":
        return "The specified path is not a file."

    if data.get("encoding") != "base64":
        return "Unsupported file encoding."

    try:
        content = base64.b64decode(
            data["content"]
        ).decode("utf-8")

        return (
            f"File: {data['path']}\n"
            f"Size: {data['size']} bytes\n\n"
            f"{content}"
        )

    except Exception as e:
        return f"Could not decode file content: {str(e)}"


# --------------------------------------------------
# Start MCP server
# --------------------------------------------------

if __name__ == "__main__":
    server.run()