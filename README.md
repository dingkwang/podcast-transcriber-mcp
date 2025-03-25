# OpenAI Speech-to-Text transcriptions MCP Server

A MCP server that provides audio transcription capabilities using OpenAI's API.

## Installation

### Setup

1. Clone the repository:
```bash
git clone https://github.com/Ichigo3766/audio-transcriber-mcp.git
cd audio-transcriber-mcp
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

5. Add the server configuration to your environment:

```json
{
  "mcpServers": {
    "audio-transcriber": {
      "command": "node",
      "args": [
        "/path/to/audio-transcriber-mcp/build/index.js"
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

Replace `/path/to/audio-transcriber-mcp` with the actual path where you cloned the repository.

## Features

### Tools
- `transcribe_audio` - Transcribe audio files using OpenAI's API
  - Takes filepath as a required parameter
  - Optional parameters:
    - save_to_file: Boolean to save transcription to a file
    - language: ISO-639-1 language code (e.g., "en", "es")

## License

[MIT]
