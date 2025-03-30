# OpenAI Podcast Transcription MCP Server

A MCP server that provides podcast RSS feed parsing, episode listing, and audio transcription capabilities using OpenAI's Whisper API.

## Installation

### Setup

1. Clone the repository:
```bash
git clone git@github.com:dingkwang/podcast-transcriber-mcp.git
cd podcast-transcriber-mcp
```

2. Install dependencies:
```bash
npm install
```

3. Build the server:
```bash
npm run build
```

4. Set up your OpenAI API key in your environment variables.

5. For Claude add this to your cluade mcp config file:

```json
{
  "mcpServers": {
    "podcast-transcriber": {
      "command": "node",
      "args": [
        "/path/to/podcast-transcriber-mcp/build/index.js"
      ],
      "env": {
        "OPENAI_API_KEY": "",
        "OPENAI_BASE_URL": "", // Optional
        "OPENAI_MODEL": "" // Optional
      }
    }
  }
}
```

Replace `/path/to/podcast-transcriber-mcp` with the actual path where you cloned the repository.

## Features

### Tools
- `fetch_rss_feed` - Fetch and parse a podcast RSS feed
  - Takes feed_url as a required parameter
  
- `list_episodes` - List episodes from a previously fetched RSS feed
  - Optional parameters:
    - limit: Number of episodes to return (default: all)
    - offset: Number of episodes to skip (default: 0)
    
- `transcribe_audio` - Download and transcribe a podcast episode using OpenAI's API
  - Takes either:
    - filepath: Path to an existing audio file OR
    - episode_url: URL of a podcast episode to download and transcribe
  - Optional parameters:
    - save_to_file: Boolean to save transcription to a file
    - language: ISO-639-1 language code (e.g., "en", "es")
    - full_transcription: Boolean to transcribe the entire episode (true) or just the first minute (false)
    - max_chunk_size: Maximum size of each chunk in MB for full transcription (default: 20MB)

## Example Usage

### Using podcast_assistant.py

The easiest way to interact with the podcast transcriber is to use the included Python script `podcast_assistant.py`. This script provides a convenient command-line interface for working with podcasts.

#### Requirements

- Python 3.10
- OpenAI API key set as an environment variable: `OPENAI_API_KEY`

### Python Environment Setup

You can set up your Python environment using `uv`, a fast Python package installer and resolver:

```bash
# Initialize a Python environment using uv
uv venv
```

#### Running the Assistant

```bash
# Run the assistant with a specific podcast RSS feed using uv
uv run examples/podcast_assistant.py --rss-feed "https://anchor.fm/s/ef6e2aa4/podcast/rss"

# Alternatively, you can use Python directly
pip install openai-agents
python examples/podcast_assistant.py --rss-feed "https://anchor.fm/s/ef6e2aa4/podcast/rss"
```

#### Interactive Commands

Once the assistant is running, you can use these commands:

```
> help
Available commands:
- fetch [RSS feed URL]: Load a podcast feed
- list: Show recent podcast episodes
- summarize [episode number]: Transcribe and summarize an episode
- find [topic]: Search for episodes about a specific topic
- which episode(s) [topic/description]: Find episodes matching a description
```

#### Example Interaction

```
> list
Recent episodes:
1. Episode 450: Interview with The Rock (May 20, 2024)
2. Episode 449: Wrestling Stories with Mick Foley (May 13, 2024)
3. Episode 448: Training Secrets Revealed (May 6, 2024)
...

> which episodes talk about wrestling history
Searching for episodes about "wrestling history"...
Found 3 relevant episodes:
1. Episode 405: The Golden Era of Wrestling (Feb 10, 2024)
2. Episode 327: Evolution of the WWE (Oct 15, 2023)
3. Episode 298: Wrestling's Greatest Moments (Aug 2, 2023)

> transcript 1
Transcribing Episode 405: The Golden Era of Wrestling...
[Summary will appear here]
```

## Transcription Notes

- By default, OpenAI's Whisper API only transcribes approximately the first 60 seconds of audio.
- Setting `full_transcription: true` enables our chunking mechanism which:
  1. Splits the audio file into chunks (default 20MB each)
  2. Transcribes each chunk separately
  3. Combines the results into a complete transcript
- The `max_chunk_size` parameter allows you to adjust the size of each chunk (in MB)
- Smaller chunks may improve reliability but require more API calls

## Finding Podcast RSS Feeds

To use this transcription tool, you'll need the RSS feed URL of the podcast you want to transcribe. If you don't know the RSS feed URL for your favorite podcast, you can use the free tool provided by Castos:

1. Visit [Castos RSS Feed Finder](https://castos.com/tools/find-podcast-rss-feed/)
2. Enter the name of the podcast or the host's name in the search box
3. Click "Search" to find the podcast RSS feed
4. Copy the RSS feed URL and use it with this tool

This service searches a directory of over 4 million podcasts and provides you with the direct RSS feed link that you can use with the `fetch` command in our tool.

## License

This MCP server is licensed under the MIT License. This means you are free to use, modify, and distribute the software, subject to the terms and conditions of the MIT License. For more details, please see the LICENSE file in the project repository.
