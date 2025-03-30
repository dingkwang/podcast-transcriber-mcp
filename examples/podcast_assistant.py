import argparse
import asyncio
import os
import shutil
from pathlib import Path

from agents import Agent, Runner, trace
from agents.mcp import MCPServerStdio


class PodcastAssistant:

    def __init__(self, mcp_server):
        self.mcp_server = mcp_server
        self.base_instructions = """
            You are a helpful podcast assistant that can:
            1. Fetch and browse podcast RSS feeds
            2. Search for episodes by topic
            3. Transcribe and summarize podcast episodes
            
            When asked to find episodes about a specific topic, search through episode titles 
            and descriptions to find relevant matches. Provide a numbered list of relevant episodes.
            
            When asked to summarize an episode:
            1. First find the episode in the feed to get its audio URL
            2. Transcribe the episode directly using the transcribe_audio tool
               - Use the episode's audio URL in the episode_url parameter
               - Set full_transcription=true and max_chunk_size=20
            3. Provide a detailed summary of the key points, insights, and takeaways
            
            Important: The transcribe_audio tool now handles downloading automatically, 
            so you don't need to download the episode separately. Just pass the episode's 
            audio URL directly to the transcribe_audio tool.
            
            Always be conversational and helpful. Maintain context of the conversation.
            """
        self.agent = self._create_agent()
        self.feed_url = None
        self.episodes = None
        self.temp_dir = None
        self.podcast_title = None

    def _create_agent(self, with_feed=None):
        """Create a new agent with updated instructions"""
        instructions = self.base_instructions

        if with_feed:
            instructions += f"""
            
            Current podcast RSS feed: {with_feed}
            Remember to use this feed URL for all operations unless explicitly told to use a different one.
            """
            if self.podcast_title:
                instructions += f"This is the '{self.podcast_title}' podcast."

        return Agent(
            name="Podcast Discovery Assistant",
            instructions=instructions,
            mcp_servers=[self.mcp_server],
        )

    async def start(self, feed_url=None):
        if feed_url:
            self.feed_url = feed_url
            await self._fetch_feed(feed_url)

    async def _fetch_feed(self, feed_url):
        """Fetch the podcast RSS feed and save the data"""
        print(f"Fetching RSS feed: {feed_url}")
        result = await Runner.run(
            starting_agent=self.agent,
            input=
            f"Fetch the podcast RSS feed at {feed_url} and list the 10 most recent episodes. Format the list with numbers, titles and durations."
        )

        # Store the feed URL
        self.feed_url = feed_url

        # Try to extract podcast title from response
        try:
            response_text = result.final_output
            if "Title:" in response_text:
                title_line = [
                    line for line in response_text.split('\n')
                    if "Title:" in line
                ]
                if title_line:
                    self.podcast_title = title_line[0].split(
                        "Title:")[1].strip()
                    print(f"Podcast title: {self.podcast_title}")
        except Exception:
            # Just ignore if we can't extract the title
            pass

        # Update the agent with the new feed URL
        self.agent = self._create_agent(with_feed=feed_url)

        print(result.final_output)

    async def find_episodes_by_topic(self, topic):
        """Find episodes related to a specific topic"""
        if not self.feed_url:
            print(
                "No podcast feed loaded. Please provide an RSS feed URL first."
            )
            return

        print(f"Searching for episodes about: {topic}")
        result = await Runner.run(
            starting_agent=self.agent,
            input=
            f"Using the podcast feed {self.feed_url}, find episodes that discuss {topic}. Provide a numbered list of relevant episodes with their titles and a brief description."
        )
        print(result.final_output)

    async def summarize_episode(self, episode_number):
        """Transcribe and summarize the specified episode"""
        if not self.feed_url:
            print(
                "No podcast feed loaded. Please provide an RSS feed URL first."
            )
            return

        print(f"Summarizing episode {episode_number}...")
        result = await Runner.run(starting_agent=self.agent,
                                  input=f"""
            For episode {episode_number} from the podcast feed {self.feed_url}:
            1. First, find the episode in the feed to get its audio URL
            2. Transcribe the episode using the transcribe_audio tool
               - Pass the episode's audio URL directly to the tool (episode_url parameter)
               - Use full_transcription=true and max_chunk_size=20
            3. Provide a comprehensive summary of the episode content
            """)
        print("\nEpisode Summary:\n")
        print(result.final_output)

    async def process_command(self, command):
        """Process a user command"""
        if command.lower().startswith("feed "):
            # Handle setting the RSS feed
            feed_url = command[5:].strip()
            await self._fetch_feed(feed_url)

        elif command.lower().startswith("find "):
            # Handle finding episodes by topic
            topic = command[5:].strip()
            await self.find_episodes_by_topic(topic)

        elif command.lower().startswith("summarize "):
            # Handle summarizing an episode
            try:
                episode_number = int(command[10:].strip())
                await self.summarize_episode(episode_number)
            except ValueError:
                print("Please specify a valid episode number to summarize.")

        elif command.lower() == "help":
            # Display help information
            print("\nCommands:")
            print("  feed [URL]      - Set the podcast RSS feed URL")
            print("  find [topic]    - Find episodes about a specific topic")
            print("  summarize [N]   - Summarize episode number N")
            print("  exit            - Exit the assistant")
            print("  help            - Show this help message")

            if self.feed_url:
                print(f"\nCurrent podcast feed: {self.feed_url}")
                if self.podcast_title:
                    print(f"Podcast title: {self.podcast_title}")

        elif command.lower() == "exit":
            # Exit the assistant
            return False

        elif command.lower().startswith("which episode") or command.lower(
        ).startswith("which eposide"):
            # Special handling for "which episode" questions
            topic = command.lower().replace("which episode",
                                            "").replace("which eposide",
                                                        "").strip()
            if topic.startswith("is about "):
                topic = topic[9:].strip()
            if topic.startswith("about "):
                topic = topic[6:].strip()

            if topic:
                await self.find_episodes_by_topic(topic)
            else:
                print("Please specify a topic to search for.")

        else:
            # Handle as a general query
            context = ""
            if self.feed_url:
                context = f"Using the podcast feed {self.feed_url}: "

            result = await Runner.run(starting_agent=self.agent,
                                      input=f"{context}{command}")
            print(result.final_output)

        return True

    def cleanup(self):
        """Clean up resources when done"""
        if self.temp_dir:
            self._cleanup_temp_dir()


async def interactive_mode(mcp_server, initial_feed=None):
    """Run the podcast assistant in interactive mode"""
    assistant = PodcastAssistant(mcp_server)

    print("\n===== Podcast Assistant =====")
    print("Type 'help' for available commands or 'exit' to quit")

    if initial_feed:
        await assistant.start(initial_feed)

    try:
        keep_running = True
        while keep_running:
            command = input("\nWhat would you like to do? > ")
            with trace(workflow_name="Podcast Assistant"):
                keep_running = await assistant.process_command(command)
    finally:
        assistant.cleanup()


async def main():
    # Parse command line arguments
    parser = argparse.ArgumentParser(
        description="Interactive Podcast Assistant")
    parser.add_argument("--rss-feed",
                        type=str,
                        help="Provide a RSS feed URL. Search for your favorite podcasts on https://castos.com/tools/find-podcast-rss-feed",
                        required=True,
                        default="https://anchor.fm/s/ef6e2aa4/podcast/rss")
    args = parser.parse_args()

    # Ensure the podcast-transcriber-mcp exists
    mcp_path = Path(".")

    # Connect to the podcast-transcriber-mcp server
    async with MCPServerStdio(
        cache_tools_list=True,
        params={
            "command": "node",
            "args": [str(mcp_path.joinpath("src/index.js").resolve())],
            "env": {
                "OPENAI_API_KEY": os.environ.get("OPENAI_API_KEY", ""),
            }
        },
    ) as server:
        await interactive_mode(server, args.rss_feed)


if __name__ == "__main__":
    # Check for required dependencies
    if not shutil.which("node"):
        raise RuntimeError(
            "Node.js is not installed. Please install Node.js to run this script."
        )

    # Check for OPENAI_API_KEY
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY environment variable is not set. "
                           "Please set it to your OpenAI API key.")

    # Run the main function
    asyncio.run(main())
