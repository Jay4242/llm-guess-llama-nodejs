export const NUM_CHARACTERS = 24;

export type BackendSettings = {
  llmEndpoint: string;
  llmModel: string;
  llmApiKey: string;
  llmTimeout: number;
  imageEndpoint: string;
  imageModel: string;
  imageApiKey: string;
  imageTimeout: number;
};

export type GamePhase =
  | "theme-selection"
  | "preparing"
  | "awaiting-regeneration-choice"
  | "image-generation"
  | "playing"
  | "awaiting-player-answer"
  | "llm-processing"
  | "player-wins"
  | "llm-wins"
  | "error";

export type Character = {
  id: number;
  traits: string[];
  prompt: string;
  imageUrl: string;
  imageFilename: string;
  eliminated: boolean;
};

export type GameSession = {
  id: string;
  phase: GamePhase;
  theme: string | null;
  formattedThemeName: string | null;
  features: string[];
  characters: Character[];
  playerCharacter: number | null;
  llmCharacter: number | null;
  llmEliminatedIds: number[];
  currentQuestion: string | null;
  currentAnswer: "yes" | "no" | null;
  llmConversation: import("./llm.js").ChatMessage[] | null;
  questionHistory: Array<{ question: string; answer: "yes" | "no"; askedBy: "player" | "llm" }>;
  generation: { completed: number; total: number; message: string };
  error: string | null;
  gameOverReason: string | null;
  backendSettings: BackendSettings;
};

export type PublicGameSession = Omit<GameSession, "llmCharacter" | "llmEliminatedIds" | "llmConversation" | "backendSettings"> & {
  llmCharacter?: never;
};
