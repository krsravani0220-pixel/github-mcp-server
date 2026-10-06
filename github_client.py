import asyncio

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main():

    # --------------------------------
    # Start MCP server
    # --------------------------------

    server_params = StdioServerParameters(
        command="python",
        args=["github_server.py"]
    )

    # --------------------------------
    # Connect to MCP server
    # --------------------------------

    async with stdio_client(server_params) as (read, write):

        async with ClientSession(read, write) as session:

            await session.initialize()

            print("\n================================")
            print("GITHUB MCP CLIENT CONNECTED ✅")
            print("================================")

            # --------------------------------
            # Show available MCP tools
            # --------------------------------

            tools = await session.list_tools()

            print("\nAvailable MCP tools:")

            for tool in tools.tools:
                print(f" - {tool.name}:")
                print(f"   {tool.description}")

            # --------------------------------
            # Get repository details
            # --------------------------------

            owner = input(
                "\nEnter GitHub username/owner: "
            )

            repo = input(
                "Enter repository name: "
            )

            result = await session.call_tool(
                "get_repository",
                arguments={
                    "owner": owner,
                    "repo": repo
                }
            )

            print("\n================================")
            print("GITHUB REPOSITORY INFORMATION")
            print("================================")

            for content in result.content:
                if hasattr(content, "text"):
                    print(content.text)

            # --------------------------------
            # List repository files
            # --------------------------------

            choice = input(
                "\nDo you want to list repository files? (y/n): "
            )

            if choice.lower() == "y":

                result = await session.call_tool(
                    "list_files",
                    arguments={
                        "owner": owner,
                        "repo": repo
                    }
                )

                print("\n================================")
                print("REPOSITORY FILES")
                print("================================")

                for content in result.content:
                    if hasattr(content, "text"):
                        print(content.text)

            # --------------------------------
            # Read a file
            # --------------------------------

            choice = input(
                "\nDo you want to read a file? (y/n): "
            )

            if choice.lower() == "y":

                path = input(
                    "Enter file path (example: README.md): "
                )

                result = await session.call_tool(
                    "get_file_content",
                    arguments={
                        "owner": owner,
                        "repo": repo,
                        "path": path
                    }
                )

                print("\n================================")
                print("FILE CONTENT")
                print("================================")

                for content in result.content:
                    if hasattr(content, "text"):
                        print(content.text)


# --------------------------------
# Run client
# --------------------------------

if __name__ == "__main__":
    asyncio.run(main())