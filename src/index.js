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
import Parser from 'rss-parser';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import os from 'os';
import { Readable } from 'stream';
import { PassThrough } from 'stream';
import { createReadStream, statSync } from 'fs';

// Get the current file path
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize OpenAI client with configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "whisper-1";

if (!OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY environment variable is required');
}

const config = {
  apiKey: OPENAI_API_KEY
};

if (OPENAI_BASE_URL) {
  config.baseURL = OPENAI_BASE_URL;
}

const openai = new OpenAI(config);

// RSS parser
const parser = new Parser({
  customFields: {
    item: [
      ['itunes:duration', 'duration'],
      ['itunes:episode', 'episode'],
      ['itunes:season', 'season'],
      ['itunes:episodeType', 'episodeType'],
      ['itunes:subtitle', 'subtitle'],
      ['itunes:summary', 'summary'],
      ['enclosure', 'enclosure'],
    ]
  }
});

// Store the parsed feed
let cachedFeed = null;

const isValidTranscribeArgs = (args) =>
  typeof args === 'object' &&
  args !== null &&
  (
    // Either filepath OR episode_url must be provided
    (typeof args.filepath === 'string') ||
    (typeof args.episode_url === 'string')
  ) &&
  (args.save_to_file === undefined || 
   typeof args.save_to_file === 'boolean' || 
   typeof args.save_to_file === 'string') &&
  (args.language === undefined || typeof args.language === 'string') &&
  (args.max_chunk_size === undefined || typeof args.max_chunk_size === 'number') &&
  (args.full_transcription === undefined || typeof args.full_transcription === 'boolean');

const isValidFetchRssArgs = (args) =>
  typeof args === 'object' &&
  args !== null &&
  typeof args.feed_url === 'string';

const isValidListEpisodesArgs = (args) =>
  typeof args === 'object' &&
  args !== null &&
  (args.limit === undefined || typeof args.limit === 'number') &&
  (args.offset === undefined || typeof args.offset === 'number');

class PodcastTranscriberServer {
  constructor() {
    this.server = new Server(
      {
        name: 'podcast-transcriber',
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
  
  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'fetch_rss_feed',
          description: 'Fetch and parse a podcast RSS feed',
          inputSchema: {
            type: 'object',
            properties: {
              feed_url: {
                type: 'string',
                description: 'URL of the podcast RSS feed',
              },
            },
            required: ['feed_url'],
          },
        },
        {
          name: 'list_episodes',
          description: 'List episodes from the previously fetched RSS feed',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Maximum number of episodes to return',
              },
              offset: {
                type: 'number',
                description: 'Number of episodes to skip',
              },
            },
            required: [],
          },
        },
        {
          name: 'transcribe_audio',
          description: 'Download and transcribe a podcast episode using OpenAI Whisper API',
          inputSchema: {
            type: 'object',
            properties: {
              filepath: {
                type: 'string',
                description: 'Absolute path to an existing audio file. Use this OR episode_url.',
              },
              episode_url: {
                type: 'string',
                description: 'URL of the podcast episode to download and transcribe. Use this OR filepath.',
              },
              save_to_file: {
                type: 'boolean',
                description: 'Whether to save the transcription to a file next to the audio file',
              },
              language: {
                type: 'string',
                description: 'Language of the audio in ISO-639-1 format (e.g. "en", "es"). Default is "en".',
              },
              full_transcription: {
                type: 'boolean',
                description: 'Whether to transcribe the entire audio file (true) or just the first minute (false). Default is false.',
              },
              max_chunk_size: {
                type: 'number',
                description: 'Maximum size of each chunk in MB when splitting audio for full transcription. Default is 20 (20MB).',
              },
            },
          },
        },
      ],
    }));
    
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      
      try {
        switch (toolName) {
          case 'fetch_rss_feed':
            return await this.handleFetchRssFeed(request.params.arguments);
          case 'list_episodes':
            return await this.handleListEpisodes(request.params.arguments);
          case 'transcribe_audio':
            return await this.handleTranscribeAudio(request.params.arguments);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${toolName}`
            );
        }
      } catch (error) {
        console.error(`[ERROR] ${toolName} failed:`, error);
        return {
          content: [
            {
              type: 'text',
              text: `Error in ${toolName}: ${error?.message || String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }
  
  async handleFetchRssFeed(args) {
    if (!isValidFetchRssArgs(args)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Invalid fetch_rss_feed arguments'
      );
    }
    
    const { feed_url } = args;
    console.error(`[DEBUG] Fetching RSS feed from: ${feed_url}`);
    
    try {
      cachedFeed = await parser.parseURL(feed_url);
      const podcastInfo = {
        title: cachedFeed.title,
        description: cachedFeed.description,
        link: cachedFeed.link,
        lastBuildDate: cachedFeed.lastBuildDate,
        episodes_count: cachedFeed.items.length,
      };
      
      console.error(`[DEBUG] Successfully fetched ${cachedFeed.items.length} episodes from ${cachedFeed.title}`);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(podcastInfo, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error('[ERROR] Failed to fetch RSS feed:', error);
      throw new Error(`Failed to fetch RSS feed: ${error.message || error}`);
    }
  }
  
  async handleListEpisodes(args) {
    if (!isValidListEpisodesArgs(args)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Invalid list_episodes arguments'
      );
    }
    
    if (!cachedFeed) {
      throw new Error('No RSS feed has been fetched. Please use fetch_rss_feed first.');
    }
    
    const { limit, offset = 0 } = args;
    let episodes = cachedFeed.items.slice(offset);
    
    if (limit) {
      episodes = episodes.slice(0, limit);
    }
    
    const episodesList = episodes.map((item, index) => {
      const enclosure = item.enclosure || {};
      return {
        index: index + offset,
        title: item.title,
        pubDate: item.pubDate,
        duration: item.duration || 'unknown',
        audio_url: enclosure.url || '',
        fileSize: enclosure.length ? `${Math.round(enclosure.length / (1024 * 1024))} MB` : 'unknown',
      };
    });
    
    console.error(`[DEBUG] Returning ${episodesList.length} episodes`);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(episodesList, null, 2),
        },
      ],
    };
  }
  
  // Helper function to download an episode
  async downloadEpisode(episode_url, tempDir) {
    console.error(`[DEBUG] Downloading episode from: ${episode_url}`);
    
    try {
      // Create a simple timestamp-based filename with extension
      const timestamp = Date.now();
      const fileName = `episode_${timestamp}.mp3`;
      
      const filePath = path.join(tempDir, fileName);
      
      console.error(`[DEBUG] Saving to: ${filePath}`);
      
      const response = await axios({
        method: 'GET',
        url: episode_url,
        responseType: 'stream',
      });
      
      const writer = fs.createWriteStream(filePath);
      
      response.data.pipe(writer);
      
      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          console.error(`[DEBUG] Successfully downloaded episode to ${filePath}`);
          resolve(filePath);
        });
        
        writer.on('error', (err) => {
          console.error('[ERROR] Failed to download episode:', err);
          reject(new Error(`Failed to download episode: ${err.message}`));
        });
      });
    } catch (error) {
      console.error('[ERROR] Failed to download episode:', error);
      throw new Error(`Failed to download episode: ${error.message || error}`);
    }
  }
  
  // Helper function to create a temporary directory for audio chunks
  async createTempDir() {
    const tempDir = path.join(os.tmpdir(), `podcast-transcriber-${Date.now()}`);
    await promisify(fs.mkdir)(tempDir, { recursive: true });
    return tempDir;
  }
  
  // Helper function to clean up temporary files
  async cleanupTempDir(tempDir) {
    try {
      await promisify(fs.rm)(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.error('[ERROR] Failed to clean up temporary directory:', error);
    }
  }
  
  // Helper function to get file size in bytes
  getFileSize(filePath) {
    try {
      const stats = statSync(filePath);
      return stats.size;
    } catch (error) {
      console.error('[ERROR] Failed to get file size:', error);
      throw new Error(`Failed to get file size: ${error.message}`);
    }
  }
  
  // Helper function to create byte-range stream
  createByteRangeStream(filePath, start, end) {
    return createReadStream(filePath, { start, end });
  }
  
  // Helper function to split a file into chunks of specified size
  async splitFileIntoChunks(filePath, tempDir, maxChunkSizeBytes) {
    try {
      const fileSize = this.getFileSize(filePath);
      const numChunks = Math.ceil(fileSize / maxChunkSizeBytes);
      const chunks = [];
      
      console.error(`[DEBUG] File size: ${fileSize} bytes, splitting into ${numChunks} chunks of max ${maxChunkSizeBytes} bytes each`);
      
      for (let i = 0; i < numChunks; i++) {
        const startByte = i * maxChunkSizeBytes;
        const endByte = Math.min((i + 1) * maxChunkSizeBytes - 1, fileSize - 1);
        const chunkPath = path.join(tempDir, `chunk_${i}${path.extname(filePath)}`);
        
        // Create a write stream for the chunk
        const writeStream = fs.createWriteStream(chunkPath);
        
        // Create a read stream for the specific byte range
        const readStream = this.createByteRangeStream(filePath, startByte, endByte);
        
        // Pipe the data from read stream to write stream
        await new Promise((resolve, reject) => {
          readStream.pipe(writeStream);
          writeStream.on('finish', resolve);
          writeStream.on('error', reject);
        });
        
        chunks.push({
          path: chunkPath,
          startByte,
          endByte
        });
      }
      
      return { chunks, totalSize: fileSize };
    } catch (error) {
      console.error('[ERROR] Failed to split file:', error);
      throw new Error(`Failed to split file: ${error.message}`);
    }
  }
  
  // Helper function to transcribe a single chunk
  async transcribeChunk(chunkPath, language) {
    let fileStream = null;
    
    try {
      console.error(`[DEBUG] Transcribing chunk: ${chunkPath}`);
      
      fileStream = fs.createReadStream(chunkPath);
      
      const response = await openai.audio.transcriptions.create({
        file: fileStream,
        model: OPENAI_MODEL,
        language: language,
      });
      
      fileStream.destroy();
      fileStream = null;
      
      return response.text;
    } catch (error) {
      console.error(`[ERROR] Failed to transcribe chunk ${chunkPath}:`, error);
      if (fileStream) fileStream.destroy();
      throw error;
    }
  }
  
  // Main transcription handler
  async handleTranscribeAudio(args) {
    if (!isValidTranscribeArgs(args)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Invalid transcribe_audio arguments'
      );
    }
    
    let fileStream = null;
    let tempDir = null;
    let audioFilePath = null;
    let downloadedFile = false;
    
    try {
      const { 
        filepath, 
        episode_url,
        save_to_file, 
        language = "en", 
        full_transcription = false,
        max_chunk_size = 20  // Default 20MB per chunk
      } = args;
      
      // Create a temporary directory for downloaded files and chunks
      tempDir = await this.createTempDir();
      
      // Determine the audio file to process
      if (filepath) {
        // Use the provided filepath
        audioFilePath = filepath;
        console.error(`[DEBUG] Using provided audio file: ${audioFilePath}`);
      } else if (episode_url) {
        // Download the episode
        console.error(`[DEBUG] Transcription: downloading episode from URL: ${episode_url}`);
        audioFilePath = await this.downloadEpisode(episode_url, tempDir);
        downloadedFile = true;
      } else {
        throw new Error("Either filepath or episode_url must be provided");
      }
      
      // Ensure the path is properly formatted and normalized
      const normalizedPath = path.normalize(audioFilePath);
      
      console.error(`[DEBUG] Processing audio file: ${normalizedPath}`);
      
      // Verify file exists
      if (!fs.existsSync(normalizedPath)) {
        throw new Error(`Audio file not found: ${normalizedPath}`);
      }
      
      // Check if file is readable
      try {
        await promisify(fs.access)(normalizedPath, fs.constants.R_OK);
      } catch (err) {
        throw new Error(`Audio file not readable: ${normalizedPath}`);
      }
      
      console.error(`[DEBUG] File exists and is readable: ${normalizedPath}`);
      
      // Determine whether to do full transcription or just the first minute
      if (full_transcription) {
        console.error(`[DEBUG] Starting full transcription process with chunking`);
        
        // Convert max_chunk_size from MB to bytes
        const maxChunkSizeBytes = max_chunk_size * 1024 * 1024;
        
        // Split audio into chunks based on size (not duration)
        const { chunks, totalSize } = await this.splitFileIntoChunks(
          normalizedPath, 
          tempDir, 
          maxChunkSizeBytes
        );
        
        console.error(`[DEBUG] Audio split into ${chunks.length} chunks`);
        
        // Transcribe each chunk
        let fullTranscription = "";
        
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          console.error(`[DEBUG] Transcribing chunk ${i+1}/${chunks.length} (bytes ${chunk.startByte}-${chunk.endByte})`);
          
          try {
            const chunkTranscription = await this.transcribeChunk(chunk.path, language);
            fullTranscription += chunkTranscription + " ";
          } catch (error) {
            console.error(`[WARNING] Failed to transcribe chunk ${i+1}, continuing with next chunk:`, error);
          }
        }
        
        console.error(`[DEBUG] Full transcription completed (${totalSize} bytes of audio)`);
        
        // Save transcription if requested
        if (save_to_file) {
          // If we downloaded the file, save next to the original in the temp dir
          // Otherwise save next to the original file
          const audioDir = downloadedFile ? tempDir : path.dirname(normalizedPath);
          const audioName = path.basename(normalizedPath, path.extname(normalizedPath));
          const transcriptionPath = path.join(audioDir, `${audioName}.txt`);
          
          console.error(`[DEBUG] Saving transcription to: ${transcriptionPath}`);
          await promisify(fs.writeFile)(transcriptionPath, fullTranscription);
          console.error(`[DEBUG] File saved successfully`);
        }
        
        return {
          content: [
            {
              type: 'text',
              text: fullTranscription,
            },
          ],
        };
      } else {
        // Just transcribe directly with Whisper (will only do ~60 seconds)
        console.error(`[DEBUG] Starting single-pass transcription (first ~60 seconds only)`);
        console.error(`[DEBUG] Sending transcription request to OpenAI API`);
        
        fileStream = fs.createReadStream(normalizedPath);
        
        const response = await openai.audio.transcriptions.create({
          file: fileStream,
          model: OPENAI_MODEL,
          language: language
        });
        
        // Close the file stream immediately after use
        fileStream.destroy();
        fileStream = null;
        
        const transcription = response.text;
        console.error(`[DEBUG] Transcription completed successfully (first ~60 seconds only)`);
        
        // Handle save_to_file parameter
        const shouldSaveToFile = typeof save_to_file === 'string'
          ? save_to_file.toLowerCase() === 'true'
          : Boolean(save_to_file);
          
        if (shouldSaveToFile) {
          // If we downloaded the file, save next to the original in the temp dir
          // Otherwise save next to the original file
          const audioDir = downloadedFile ? tempDir : path.dirname(normalizedPath);
          const audioName = path.basename(normalizedPath, path.extname(normalizedPath));
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
      }
    } catch (error) {
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
      
      // Clean up temporary directory if it exists
      // if (tempDir) {
      //   try {
      //     await this.cleanupTempDir(tempDir);
      //   } catch (err) {
      //     console.error("[ERROR] Failed to clean up temporary directory:", err);
      //   }
      // }
    }
  }
  
  async run() {
    try {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('[INFO] Podcast Transcriber MCP server running on stdio');
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

const server = new PodcastTranscriberServer();
server.run().catch(err => {
  console.error('[FATAL] Server initialization failed:', err);
  process.exit(1);
}); 