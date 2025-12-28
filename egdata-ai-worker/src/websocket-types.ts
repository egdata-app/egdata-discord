// WebSocket message types for HITL (Human-in-the-Loop) communication

// =============================================================================
// Client → Agent Messages
// =============================================================================

export interface ChatMessage {
	type: "chat";
	message: string;
	sessionId: string;
}

export interface UserResponseMessage {
	type: "user_response";
	requestId: string;
	response: string; // "yes", "no", or free text
}

export type ClientMessage = ChatMessage | UserResponseMessage;

// =============================================================================
// Agent → Client Messages
// =============================================================================

export interface ToolProgressMessage {
	type: "tool_progress";
	tool: string;
	message: string;
}

export interface AskUserMessage {
	type: "ask_user";
	requestId: string;
	question: string;
	/** If provided, show as buttons. Otherwise yes/no by default */
	options?: string[];
	/** If true, allow free text input in addition to/instead of buttons */
	allowText?: boolean;
	/** Timeout in ms before defaulting (optional) */
	timeout?: number;
}

export interface TextDeltaMessage {
	type: "text_delta";
	text: string;
}

export interface CompleteMessage {
	type: "complete";
	text: string;
}

export interface ErrorMessage {
	type: "error";
	message: string;
}

export type AgentMessage =
	| ToolProgressMessage
	| AskUserMessage
	| TextDeltaMessage
	| CompleteMessage
	| ErrorMessage;

// =============================================================================
// Ask User Tool Types
// =============================================================================

export interface PendingQuestion {
	requestId: string;
	question: string;
	options?: string[];
	allowText?: boolean;
	resolve: (response: string) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}
