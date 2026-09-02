import "dotenv/config";
import cors from "cors";
import express from "express";
import multer from "multer";
import path from "node:path";
import { z } from "zod";
import { ensureImagesRoot, hasThemeAssets, imagesRoot, listExistingThemes, loadSavedGame, saveGameData, savedCharactersToCharacters, themeDirectory } from "./storage.js";
import { createSession, getSession, publicSession } from "./sessions.js";
import { answerCharacterQuestion, chooseEliminations, getCharacterFeatures, startCharacterQuestion } from "./llm.js";
import { downloadCustomImages, generateSessionImages, saveCustomImages } from "./images.js";
import type { BackendSettings, Character, GameSession } from "./types.js";

const app = express();
const customImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 24, fileSize: 15 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => callback(null, ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.mimetype)),
});
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
app.use(cors());
app.use(express.json());
app.get("/api/themes", async (_request, response) => response.json({ themes: await listExistingThemes() }));
app.use("/api/themes", express.static(imagesRoot));

const themeSchema = z.object({ theme: z.string().trim().min(1).max(100) });
const setupSchema = z.object({
  customItems: z.array(z.string().trim().max(100)).length(8).optional(),
}).default({});
const questionSchema = z.object({ question: z.string().trim().min(1).max(240) });
const answerSchema = z.object({ answer: z.enum(["yes", "no"]) });
const playerStateSchema = z.object({ eliminatedIds: z.array(z.number().int().positive()).max(24) });
const timeoutSchema = z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().int().min(1).max(86_400).optional());
const backendSettingsSchema = z.object({
  llmEndpoint: z.string().trim().max(500).optional(),
  llmModel: z.string().trim().max(200).optional(),
  llmApiKey: z.string().max(500).optional(),
  llmTimeout: timeoutSchema,
  imageEndpoint: z.string().trim().max(500).optional(),
  imageModel: z.string().trim().max(200).optional(),
  imageApiKey: z.string().max(500).optional(),
  imageTimeout: timeoutSchema,
}).optional();

function setting(value: string | undefined, fallback: string): string {
  return value?.trim() ? value.trim() : fallback;
}

function resolveBackendSettings(input: z.infer<typeof backendSettingsSchema>): BackendSettings {
  const llmApiKey = setting(input?.llmApiKey, process.env.GUESS_LLAMA_LLM_API_KEY ?? "");
  return {
    llmEndpoint: setting(input?.llmEndpoint, process.env.GUESS_LLAMA_LLM_SERVER ?? "http://localhost:9090"),
    llmModel: setting(input?.llmModel, process.env.GUESS_LLAMA_LLM_MODEL ?? "qwen3.5"),
    llmApiKey,
    llmTimeout: input?.llmTimeout ?? Number(process.env.GUESS_LLAMA_LLM_TIMEOUT ?? 14_400),
    imageEndpoint: setting(input?.imageEndpoint, process.env.GUESS_LLAMA_IMAGE_SERVER_URL ?? "localhost:1234"),
    imageModel: setting(input?.imageModel, process.env.GUESS_LLAMA_IMAGE_SERVER_MODEL ?? "black-forest-labs/flux.2-klein-4b"),
    imageApiKey: setting(input?.imageApiKey, process.env.GUESS_LLAMA_IMAGE_SERVER_API_KEY ?? llmApiKey),
    imageTimeout: input?.imageTimeout ?? Number(process.env.GUESS_LLAMA_IMAGE_TIMEOUT ?? 900),
  };
}

function assignPlayers(session: { characters: Character[]; playerCharacter: number | null; llmCharacter: number | null; llmEliminatedIds: number[]; llmConversation: GameSession["llmConversation"]; gameOverReason: string | null }) {
  session.playerCharacter = Math.floor(Math.random() * session.characters.length);
  session.characters[session.playerCharacter].eliminated = true;
  do {
    session.llmCharacter = Math.floor(Math.random() * session.characters.length);
  } while (session.llmCharacter === session.playerCharacter && session.characters.length > 1);
  session.llmEliminatedIds = [];
  session.llmConversation = null;
  session.gameOverReason = null;
}

app.post("/api/games", async (request, response) => {
  const parsed = themeSchema.and(z.object({ settings: backendSettingsSchema })).safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "A theme between 1 and 100 characters is required." });
    return;
  }

  const session = createSession(resolveBackendSettings(parsed.data.settings));
  session.theme = parsed.data.theme;
  session.formattedThemeName = parsed.data.theme.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/ +/g, "_");
  session.phase = "preparing";
  response.status(201).json({ ...publicSession(session), existingAssets: await hasThemeAssets(session.theme) });
});

app.get("/api/games/:id", (request, response) => {
  const session = getSession(request.params.id);
  if (!session) {
    response.status(404).json({ error: "Game session not found." });
    return;
  }
  response.json(publicSession(session));
});

app.post("/api/games/:id/load", async (request, response) => {
  const session = getSession(request.params.id);
  if (!session || !session.theme) {
    response.status(404).json({ error: "Game session not found." });
    return;
  }
  const saved = await loadSavedGame(session.theme);
  if (!saved) {
    response.status(404).json({ error: "No reusable game data exists for this theme." });
    return;
  }
  session.features = saved.features;
  session.characters = savedCharactersToCharacters(session.theme, saved.characters);
   assignPlayers(session);
  session.phase = "playing";
  response.json(publicSession(session));
});

app.post("/api/games/:id/setup", customImageUpload.array("images", 24), async (request, response) => {
  const session = getSession(String(request.params.id));
  if (!session || !session.theme) {
    response.status(404).json({ error: "Game session not found." });
    return;
  }
   let customImageUrls: string[] | undefined;
   if (typeof request.body.imageUrls === "string") {
     try {
       const parsedUrls: unknown = JSON.parse(request.body.imageUrls);
       if (Array.isArray(parsedUrls) && parsedUrls.every((url): url is string => typeof url === "string")) customImageUrls = parsedUrls;
     } catch { customImageUrls = undefined; }
   }
   let submittedItems = request.body.customItems;
   if (typeof submittedItems === "string") {
     try { submittedItems = JSON.parse(submittedItems); } catch { submittedItems = undefined; }
   }
   const setup = setupSchema.safeParse({ ...request.body, customItems: submittedItems });
  if (!setup.success) {
    response.status(400).json({ error: "Provide exactly eight character items." });
    return;
  }
   try {
     session.phase = "preparing";
    const uploadedFiles = (request.files as Express.Multer.File[] | undefined) ?? [];
    const hasUploadedImages = uploadedFiles.length > 0;
    if (hasUploadedImages && customImageUrls) throw new Error("Choose either image files or image URLs, not both.");
    if (hasUploadedImages && uploadedFiles.length !== 24) throw new Error("Select exactly 24 image files.");
    if (customImageUrls && (customImageUrls.length !== 24 || customImageUrls.some((url) => typeof url !== "string" || !url.trim()))) throw new Error("Provide exactly 24 image URLs.");
    const customFilenames = hasUploadedImages
      ? await saveCustomImages(session.theme, uploadedFiles.map((file) => ({ data: file.buffer, contentType: file.mimetype, extension: path.extname(file.originalname).slice(1) })))
      : customImageUrls
        ? await downloadCustomImages(session.theme, customImageUrls.map((url) => url.trim()))
        : null;
    let selectedPairs: string[][];
    if (customFilenames) {
      session.features = [];
      selectedPairs = Array.from({ length: 24 }, () => []);
    } else {
      session.generation.message = "Asking the LLM for character features...";
      const submittedItems = setup.data.customItems ?? [];
      const enteredItems = submittedItems.filter(Boolean);
      const normalizedItems = enteredItems.map((item) => item.toLocaleLowerCase());
      if (new Set(normalizedItems).size !== enteredItems.length) {
        response.status(400).json({ error: "Each character item must be unique." });
        return;
      }
      session.features = enteredItems.length === 8
        ? enteredItems
        : await getCharacterFeatures(session.backendSettings, session.theme, enteredItems);
      if (session.features.length !== 8) throw new Error("The character feature list did not contain eight unique items.");
      const pairs = session.features.flatMap((first, firstIndex) =>
        session.features.slice(firstIndex + 1).map((second) => [first, second]),
      );
      if (pairs.length < 24) throw new Error("The LLM did not provide enough unique features.");
      for (let index = pairs.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [pairs[index], pairs[swapIndex]] = [pairs[swapIndex], pairs[index]];
      }
      selectedPairs = pairs.slice(0, 24);
    }
    session.characters = selectedPairs.map((traits, index) => ({
      id: index + 1,
      traits,
      prompt: `A ${session.theme}, ${traits[0]}, ${traits[1]}`,
       imageFilename: customFilenames?.[index] ?? `character_${index + 1}.png`,
       imageUrl: `/api/themes/${encodeURIComponent(session.formattedThemeName!)}/${encodeURIComponent(customFilenames?.[index] ?? `character_${index + 1}.png`)}`,
      eliminated: false,
    }));
   assignPlayers(session);
    await saveGameData(session.theme, session.features, session.characters);
     if (customFilenames) {
       session.generation = { completed: 24, total: 24, message: "Custom character images are ready." };
       session.phase = "playing";
     } else {
       session.phase = "image-generation";
       session.generation = { completed: 0, total: 24, message: "Character data ready. Image generation is next." };
       void generateSessionImages(session);
     }
    response.status(202).json(publicSession(session));
  } catch (error) {
    session.phase = "error";
    session.error = error instanceof Error ? error.message : "Game setup failed.";
    response.status(502).json({ error: session.error });
  }
});

app.post("/api/games/:id/question", async (request, response) => {
  const session = getSession(request.params.id);
  const parsed = questionSchema.safeParse(request.body);
  if (!session || session.phase !== "playing" || session.llmCharacter === null || !session.theme) {
    response.status(404).json({ error: "This game is not ready for questions." });
    return;
  }
  if (!parsed.success) {
    response.status(400).json({ error: "Ask a yes/no question (up to 240 characters)." });
    return;
  }
  try {
    const hiddenCharacter = session.characters[session.llmCharacter];
     const imagePath = path.join(themeDirectory(session.theme), hiddenCharacter.imageFilename);
     const answer = await answerCharacterQuestion(session.backendSettings, session.theme, parsed.data.question, imagePath);
    session.currentQuestion = parsed.data.question;
    session.currentAnswer = answer;
    session.questionHistory.unshift({ question: parsed.data.question, answer, askedBy: "player" });
    response.json(publicSession(session));
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : "The LLM could not answer." });
  }
});

app.post("/api/games/:id/llm-round", async (request, response) => {
  const session = getSession(request.params.id);
  const parsed = playerStateSchema.safeParse(request.body);
  if (!session || session.phase !== "playing" || session.llmCharacter === null || session.playerCharacter === null || !session.theme) {
    response.status(404).json({ error: "This game is not ready for an LLM round." });
    return;
  }
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid player character state." });
    return;
  }
  session.characters.forEach((character) => { character.eliminated = parsed.data.eliminatedIds.includes(character.id); });
  const llmId = session.characters[session.llmCharacter].id;
  const playerCandidates = session.characters.filter((character) => !character.eliminated && character.id !== session.characters[session.playerCharacter!].id);
  if (session.characters[session.llmCharacter].eliminated) {
    session.phase = "llm-wins";
    session.gameOverReason = "You eliminated the LLM's character.";
    response.json(publicSession(session));
    return;
  }
  if (playerCandidates.length === 1 && playerCandidates[0].id === llmId) {
    session.phase = "player-wins";
    session.gameOverReason = "You narrowed the board down to the LLM's character.";
    response.json(publicSession(session));
    return;
  }
  const llmCandidates = session.characters.filter((character) => character.id !== llmId && !session.llmEliminatedIds.includes(character.id));
  if (llmCandidates.length === 1 && llmCandidates[0].id === session.characters[session.playerCharacter].id) {
    session.phase = "llm-wins";
    session.gameOverReason = "The LLM narrowed the board down to your character.";
    response.json(publicSession(session));
    return;
  }
  session.phase = "llm-processing";
  try {
    const images = session.characters
      .filter((character) => character.id !== session.characters[session.llmCharacter!].id && !session.llmEliminatedIds.includes(character.id))
       .map((character) => ({ id: character.id, path: path.join(themeDirectory(session.theme!), character.imageFilename) }));
     const questionRound = await startCharacterQuestion(session.backendSettings, session.theme, images);
    session.currentQuestion = questionRound.question;
    session.llmConversation = questionRound.messages;
    session.currentAnswer = null;
    session.phase = "awaiting-player-answer";
    response.json(publicSession(session));
  } catch (error) {
    session.phase = "playing";
    response.status(502).json({ error: error instanceof Error ? error.message : "The LLM could not generate a question." });
  }
});

app.post("/api/games/:id/llm-answer", async (request, response) => {
  const session = getSession(request.params.id);
  const parsed = answerSchema.safeParse(request.body);
  if (!session || session.phase !== "awaiting-player-answer" || session.llmCharacter === null || !session.theme || !session.currentQuestion || !session.llmConversation) {
    response.status(404).json({ error: "No LLM question is waiting for an answer." });
    return;
  }
  if (!parsed.success) {
    response.status(400).json({ error: "Answer yes or no." });
    return;
  }
  session.phase = "llm-processing";
  session.currentAnswer = parsed.data.answer;
  try {
    const availableIds = session.characters
      .filter((character) => character.id !== session.characters[session.llmCharacter!].id && !session.llmEliminatedIds.includes(character.id))
      .map((character) => character.id);
     const eliminated = await chooseEliminations(session.backendSettings, session.llmConversation, parsed.data.answer, availableIds);
    session.llmEliminatedIds.push(...eliminated.filter((id) => !session.llmEliminatedIds.includes(id)));
    session.questionHistory.unshift({ question: session.currentQuestion, answer: parsed.data.answer, askedBy: "llm" });
    if (eliminated.includes(session.characters[session.playerCharacter!].id)) {
      session.phase = "player-wins";
      session.gameOverReason = "The LLM eliminated your character.";
    } else {
      const llmCandidates = session.characters.filter((character) => character.id !== session.characters[session.llmCharacter!].id && !session.llmEliminatedIds.includes(character.id));
      if (llmCandidates.length === 1 && llmCandidates[0].id === session.characters[session.playerCharacter!].id) {
        session.phase = "llm-wins";
        session.gameOverReason = "The LLM narrowed the board down to your character.";
      } else {
        session.phase = "playing";
      }
    }
    session.llmConversation = null;
    response.json(publicSession(session));
  } catch (error) {
    session.phase = "awaiting-player-answer";
    response.status(502).json({ error: error instanceof Error ? error.message : "The LLM could not process the answer." });
  }
});

app.get("/api/health", (_request, response) => response.json({ ok: true }));

await ensureImagesRoot();
app.listen(port, host, () => console.log(`Guess Llama web server listening on http://${host}:${port}`));
