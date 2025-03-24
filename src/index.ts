#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

// Initialize OpenAI client with configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "whisper-1";

if (!OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY environment variable is required');
}

const config: { apiKey: string; baseURL?: string } = {
  apiKey: OPENAI_API_KEY
};

if (OPENAI_BASE_URL) {
  config.baseURL = OPENAI_BASE_URL;
}

const openai = new OpenAI(config);

interface TranscribeArgs {
  filepath: string;
  save_to_file?: boolean | string;
  language?: string;
}

const isValidTranscribeArgs = (args: any): args is TranscribeArgs =>
  typeof args === 'object' &&
  args !== null &&
  typeof args.filepath === 'string' &&
  (args.save_to_file === undefined || 
   typeof args.save_to_file === 'boolean' || 
   typeof args.save_to_file === 'string') &&
  (args.language === undefined || typeof args.language === 'string');

class AudioTranscriberServer {
  private server: Server;
  
  constructor() {
    this.server = new Server(
      {
        name: 'audio-transcriber',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );
    
    this.setupToolHandlers();
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }
  
  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'transcribe_audio',
          description: 'Transcribe an audio file using OpenAI Whisper API',
          inputSchema: {
            type: 'object',
            properties: {
              filepath: {
                type: 'string',
                description: 'Absolute path to the audio file',
              },
              save_to_file: {
                type: 'boolean',
                description: 'Whether to save the transcription to a file next to the audio file',
              },
              language: {
                type: 'string',
                description: 'Language of the audio in ISO-639-1 format (e.g. "en", "es"). Default is "en".',
              },
            },
            required: ['filepath'],
          },
        },
      ],
    }));
    
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'transcribe_audio') {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
      }
      
      if (!isValidTranscribeArgs(request.params.arguments)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Invalid transcribe arguments'
        );
      }
      
      let fileStream = null;
      
      try {
        const { filepath, save_to_file, language = "en" } = request.params.arguments;
        
        // Normalize and decode path properly
        const decodedPath = decodeURIComponent(filepath.replace(/\\/g, '').trim());
        
        console.error(`[DEBUG] Requested file path: ${decodedPath}`);
        
        // Verify file exists
        if (!fs.existsSync(decodedPath)) {
          throw new Error(`Audio file not found: ${decodedPath}`);
        }
        
        // Check if file is readable
        try {
          await promisify(fs.access)(decodedPath, fs.constants.R_OK);
        } catch (err) {
          throw new Error(`Audio file not readable: ${decodedPath}`);
        }
        
        console.error(`[DEBUG] File exists and is readable: ${decodedPath}`);
        
        // Create transcription
        console.error(`[DEBUG] Sending transcription request to OpenAI API`);
        fileStream = fs.createReadStream(decodedPath);
        
        const response = await openai.audio.transcriptions.create({
          file: fileStream,
          model: OPENAI_MODEL,
          language: language
        });
        
        // Close the file stream immediately after use
        fileStream.destroy();
        fileStream = null;
        
        const transcription = response.text;
        console.error(`[DEBUG] Transcription completed successfully`);
        
        // Handle save_to_file parameter
        const shouldSaveToFile = typeof save_to_file === 'string'
          ? save_to_file.toLowerCase() === 'true'
          : Boolean(save_to_file);
          
        if (shouldSaveToFile) {
          const audioDir = path.dirname(decodedPath);
          const audioName = path.basename(decodedPath, path.extname(decodedPath));
          const transcriptionPath = path.join(audioDir, `${audioName}.txt`);
          
          console.error(`[DEBUG] Saving transcription to: ${transcriptionPath}`);
          await promisify(fs.writeFile)(transcriptionPath, transcription);
          console.error(`[DEBUG] File saved successfully`);
        }
        
        return {
          content: [
            {
              type: 'text',
              text: transcription,
            },
          ],
        };
      } catch (error: any) {
        console.error('[ERROR] Transcription failed:', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error transcribing audio: ${error?.message || String(error)}`,
            },
          ],
          isError: true,
        };
      } finally {
        // Ensure file stream is closed even if there's an error
        if (fileStream) {
          try {
            fileStream.destroy();
            console.error("[DEBUG] File stream closed");
          } catch (err) {
            console.error("[ERROR] Failed to close file stream:", err);
          }
        }
      }
    });
  }
  
  async run() {
    try {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('[INFO] Audio Transcriber MCP server running on stdio');
    } catch (err) {
      console.error('[FATAL] Failed to start server:', err);
      process.exit(1);
    }
  }
}

// Handle global unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle global uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  // Give the error logs time to flush before exiting
  setTimeout(() => process.exit(1), 500);
});

const server = new AudioTranscriberServer();
server.run().catch(err => {
  console.error('[FATAL] Server initialization failed:', err);
  process.exit(1);
});