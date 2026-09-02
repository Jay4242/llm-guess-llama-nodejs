import { randomUUID } from "node:crypto";
import type { BackendSettings, GameSession, PublicGameSession } from "./types.js";

const sessions = new Map<string, GameSession>();

export function createSession(backendSettings: BackendSettings): GameSession {
  const session: GameSession = {
    id: randomUUID(),
    phase: "theme-selection",
    theme: null,
    formattedThemeName: null,
    features: [],
    characters: [],
    playerCharacter: null,
    llmCharacter: null,
    llmEliminatedIds: [],
    currentQuestion: null,
    currentAnswer: null,
    llmConversation: null,
    questionHistory: [],
    generation: { completed: 0, total: 24, message: "" },
    error: null,
    gameOverReason: null,
    backendSettings,
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): GameSession | undefined {
  return sessions.get(id);
}

export function publicSession(session: GameSession): PublicGameSession {
  const { llmCharacter: _secret, llmEliminatedIds: _llmState, ...safeSession } = session;
  return safeSession;
}
