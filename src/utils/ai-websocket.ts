import WebSocket from 'ws';
import { EventEmitter } from 'events';
import consola from 'consola';

const logger = consola.withTag('ai-websocket');

// Message types from the agent
export interface ToolProgressMessage {
  type: 'tool_progress';
  tool: string;
  message: string;
}

export interface AskUserMessage {
  type: 'ask_user';
  requestId: string;
  question: string;
  options?: string[];
  allowText?: boolean;
  timeout?: number;
}

export interface TextDeltaMessage {
  type: 'text_delta';
  text: string;
}

export interface CompleteMessage {
  type: 'complete';
  text: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type AgentMessage =
  | ToolProgressMessage
  | AskUserMessage
  | TextDeltaMessage
  | CompleteMessage
  | ErrorMessage;

// Message types to the agent
export interface ChatMessage {
  type: 'chat';
  message: string;
  sessionId: string;
}

export interface UserResponseMessage {
  type: 'user_response';
  requestId: string;
  response: string;
}

export type ClientMessage = ChatMessage | UserResponseMessage;

// Events emitted by the WebSocket client
export interface AIWebSocketEvents {
  tool_progress: (message: ToolProgressMessage) => void;
  ask_user: (message: AskUserMessage) => void;
  text_delta: (message: TextDeltaMessage) => void;
  complete: (message: CompleteMessage) => void;
  error: (message: ErrorMessage) => void;
  connected: () => void;
  disconnected: () => void;
}

export class AIWebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private sessionId: string;

  constructor(baseUrl: string, sessionId: string) {
    super();
    // Convert http(s) to ws(s)
    const wsUrl = baseUrl.replace(/^http/, 'ws');
    // Extract user ID from session ID for agent routing
    const match = sessionId.match(/^discord-(\d+)/);
    const agentId = match ? match[1] : sessionId;
    // Use partyserver URL pattern: /parties/{class}/{name}
    // The class name is lowercase version of the agent class
    this.url = `${wsUrl}/parties/egdataagent/${encodeURIComponent(agentId || 'default')}?sessionId=${encodeURIComponent(sessionId)}`;
    this.sessionId = sessionId;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.on('open', () => {
          logger.info(`WebSocket connected: ${this.sessionId}`);
          this.emit('connected');
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString()) as AgentMessage;
            this.handleMessage(message);
          } catch (error) {
            logger.error('Failed to parse WebSocket message:', error);
          }
        });

        this.ws.on('close', () => {
          logger.info(`WebSocket disconnected: ${this.sessionId}`);
          this.emit('disconnected');
          this.ws = null;
        });

        this.ws.on('error', (error) => {
          logger.error('WebSocket error:', error);
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private handleMessage(message: AgentMessage): void {
    switch (message.type) {
      case 'tool_progress':
        this.emit('tool_progress', message);
        break;
      case 'ask_user':
        this.emit('ask_user', message);
        break;
      case 'text_delta':
        this.emit('text_delta', message);
        break;
      case 'complete':
        this.emit('complete', message);
        break;
      case 'error':
        this.emit('error', message);
        break;
    }
  }

  send(message: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      logger.warn('WebSocket not connected, cannot send message');
    }
  }

  sendChat(message: string): void {
    this.send({
      type: 'chat',
      message,
      sessionId: this.sessionId,
    });
  }

  sendUserResponse(requestId: string, response: string): void {
    this.send({
      type: 'user_response',
      requestId,
      response,
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

// Manage active WebSocket connections per session
const activeConnections = new Map<string, AIWebSocketClient>();

export function getOrCreateConnection(baseUrl: string, sessionId: string): AIWebSocketClient {
  let client = activeConnections.get(sessionId);
  if (!client || !client.isConnected) {
    client = new AIWebSocketClient(baseUrl, sessionId);
    activeConnections.set(sessionId, client);
  }
  return client;
}

export function removeConnection(sessionId: string): void {
  const client = activeConnections.get(sessionId);
  if (client) {
    client.disconnect();
    activeConnections.delete(sessionId);
  }
}
