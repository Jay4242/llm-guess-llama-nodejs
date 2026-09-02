import { readFile } from "node:fs/promises";
import path from "node:path";
import { Agent } from "undici";
import type { BackendSettings } from "./types.js";

// Local vision models can take longer than Undici's five-minute header/body defaults.
// The AbortSignal below still provides the overall request limit.
const llmDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export type MessageContent = string | Array<
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
>;

export type ChatMessage = {
  role: "user" | "assistant";
  content: MessageContent;
};

function imageMimeType(imagePath: string): string {
  const extension = path.extname(imagePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "image/png";
}

function endpoint(llmServer: string): string {
  const base = llmServer.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

async function requestCompletion(settings: BackendSettings, messages: ChatMessage[], temperature: number): Promise<string> {
  let response: Response;
  try {
    response = await fetch(endpoint(settings.llmEndpoint), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(settings.llmApiKey ? { Authorization: `Bearer ${settings.llmApiKey}` } : {}),
        },
      body: JSON.stringify({ model: settings.llmModel, temperature, messages }),
        signal: AbortSignal.timeout(settings.llmTimeout * 1_000),
        dispatcher: llmDispatcher,
      } as RequestInit & { dispatcher: Agent });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "connection failed";
    throw new Error(`Could not reach LLM server at ${endpoint(settings.llmEndpoint)}: ${reason}`);
  }
  if (!response.ok) throw new Error(`LLM request failed with HTTP ${response.status}.`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const responseContent = payload.choices?.[0]?.message?.content;
  if (!responseContent) throw new Error("LLM response did not contain message content.");
  return responseContent.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export function getCompletion(settings: BackendSettings, prompt: string, temperature = 0.7): Promise<string> {
  return requestCompletion(settings, [{ role: "user", content: prompt }], temperature);
}

function parseJsonArray(response: string): string[] {
  const match = response.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("LLM response did not contain a JSON array.");
  const parsed: unknown = JSON.parse(match[0]);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("LLM response contained an invalid string array.");
  }
  return parsed.map((item) => item.trim()).filter(Boolean);
}

function parseAnswer(response: string): "yes" | "no" {
  const jsonResponse = response.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonResponse);
  } catch {
    throw new Error("LLM did not return a valid JSON answer.");
  }

  const answer = typeof parsed === "object" && parsed !== null && "answer" in parsed
    ? (parsed as { answer?: unknown }).answer
    : undefined;
  if (typeof answer !== "string" || !["yes", "no"].includes(answer.toLowerCase().trim())) {
    throw new Error("LLM JSON response did not contain an answer of yes or no.");
  }
  return answer.toLowerCase().trim() as "yes" | "no";
}

function parseQuestion(response: string): string {
  const jsonResponse = response.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonResponse);
  } catch {
    throw new Error("LLM did not return a valid JSON question.");
  }

  const question = typeof parsed === "object" && parsed !== null && "question" in parsed
    ? (parsed as { question?: unknown }).question
    : undefined;
  if (typeof question !== "string" || !question.trim()) {
    throw new Error("LLM JSON response did not contain a question.");
  }
  return question.trim();
}

export async function getCharacterFeatures(settings: BackendSettings, theme: string, selectedFeatures: string[] = []): Promise<string[]> {
  const missingCount = 8 - selectedFeatures.length;
  const playerChoiceInstruction = selectedFeatures.length > 0
    ? `The player chose these items and they must be included exactly as written: ${JSON.stringify(selectedFeatures)}. ` +
      `Suggest exactly ${missingCount} additional items; do not repeat any player-chosen item.`
    : "Suggest at least 8 items. This is the same as a normal generated cast with no player-selected items.";
  const response = await getCompletion(settings,
    `Given the theme "${theme}", suggest ${selectedFeatures.length > 0 ? `exactly ${missingCount}` : "at least 8"} distinct short, visible features that could be used ` +
      `to differentiate characters in a Guess Who game. These features should be ` +
      `physical attributes or accessories that the ${theme} does NOT normally have. ` +
      `For example, if the theme is "cat", good features would be "a hat", "glasses", ` +
      `or "a bow tie". Avoid verbs like "wearing", "has", or "is holding". Bad ` +
      `features would be "whiskers", "a tail", or "fur", because the subject normally has ` +
      `these. ${playerChoiceInstruction} Return only a JSON array of strings containing the suggested additional features and nothing else.`,
    1,
  );
  const features = parseJsonArray(response);
  const combined: string[] = [];
  for (const feature of [...selectedFeatures, ...features]) {
    if (!combined.some((existing) => existing.toLocaleLowerCase() === feature.toLocaleLowerCase())) {
      combined.push(feature);
    }
  }
  if (combined.length < 8) throw new Error("LLM did not provide eight unique character features.");
  return combined.slice(0, 8);
}

export async function answerCharacterQuestion(
  settings: BackendSettings,
  theme: string,
  question: string,
  imagePath: string,
): Promise<"yes" | "no"> {
  const imageBase64 = (await readFile(imagePath)).toString("base64");
  const response = await requestCompletion(settings,
    [{
      role: "user",
      content: [
        {
          type: "text",
          text: `You are answering a player's Guess Who question for the theme "${theme}". ` +
            `I am showing only the secret character image. The player asked: "${question}". ` +
            "Answer based only on what is visible in the image.",
        },
        { type: "image_url", image_url: { url: `data:${imageMimeType(imagePath)};base64,${imageBase64}` } },
        { type: "text", text: 'Return only valid JSON in this exact format: {"answer":"yes"} or {"answer":"no"}.' },
      ],
    }],
    0.1,
  );
  return parseAnswer(response);
}

async function visionMessages(
  imagePaths: Array<{ id: number; path: string }>,
  prompt: string,
): Promise<ChatMessage[]> {
  const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
  ];
  for (const image of imagePaths) {
    const imageBase64 = (await readFile(image.path)).toString("base64");
    content.push({ type: "text", text: `This image is Character ${image.id}.` });
    content.push({ type: "image_url", image_url: { url: `data:${imageMimeType(image.path)};base64,${imageBase64}` } });
  }
  content.push({ type: "text", text: prompt });
  return [{ role: "user", content }];
}

export type CharacterQuestionRound = {
  question: string;
  messages: ChatMessage[];
};

export async function startCharacterQuestion(
  settings: BackendSettings,
  theme: string,
  imagePaths: Array<{ id: number; path: string }>,
): Promise<CharacterQuestionRound> {
  const messages = await visionMessages(
    imagePaths,
    `You are playing Guess Who for the theme "${theme}". These are all characters still possible for the player, excluding your own character. ` +
      "Ask one yes/no question about a single visible trait that will help identify the player's character. Do not ask about identity or character number. " +
      'Return only valid JSON in this exact format: {"question":"Does the character have glasses?"}. The question must be a single sentence with no explanation.',
  );
  const response = await requestCompletion(settings, messages, 0.7);
  return { question: parseQuestion(response), messages: [...messages, { role: "assistant", content: response }] };
}

export async function chooseEliminations(
  settings: BackendSettings,
  messages: ChatMessage[],
  answer: "yes" | "no",
  availableIds: number[],
): Promise<number[]> {
  const response = await requestCompletion(settings, [
    ...messages,
    {
      role: "user",
      content: `The player answered "${answer}". Use the labeled character images to determine which characters contradict your question. ` +
        "Your own character is not included. Eliminate every contradictory character and do not eliminate characters that remain possible. " +
        "Return only a valid JSON array of character numbers to eliminate, for example [2, 7, 11]. Return [] if none should be eliminated.",
    },
  ], 0.7);
  const match = response.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("LLM did not return a JSON elimination list.");
  const parsed: unknown = JSON.parse(match[0]);
  if (!Array.isArray(parsed) || parsed.some((id) => !Number.isInteger(id))) {
    throw new Error("LLM returned an invalid elimination list.");
  }
  const available = new Set(availableIds);
  return [...new Set(parsed as number[])].filter((id) => available.has(id));
}
