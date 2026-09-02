import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { themeDirectory } from "./storage.js";
import { NUM_CHARACTERS, type BackendSettings, type GameSession } from "./types.js";

function endpoint(imageServer: string): string {
  let base = imageServer.replace(/\/+$/, "");
  if (!base.includes("://")) base = `http://${base}`;
  if (base.endsWith("/api")) return `${base}/v1/chat/completions`;
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function imageDataUrl(payload: unknown): string | null {
  const response = payload as { choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }>; content?: unknown } }> };
  const message = response.choices?.[0]?.message;
  const directImage = message?.images?.[0]?.image_url?.url;
  if (directImage?.startsWith("data:image/")) return directImage;
  if (Array.isArray(message?.content)) {
    const item = message.content.find((part): part is { type: string; image_url?: { url?: string } } =>
      typeof part === "object" && part !== null && "type" in part && (part as { type?: unknown }).type === "image_url",
    );
    const contentImage = item?.image_url?.url;
    if (contentImage?.startsWith("data:image/")) return contentImage;
  }
  return null;
}

async function generateImage(settings: BackendSettings, prompt: string, theme: string, characterId: number): Promise<void> {
  if (!settings.imageApiKey) throw new Error("Image generation requires an image API key.");
  const response = await fetch(endpoint(settings.imageEndpoint), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.imageApiKey}` },
    body: JSON.stringify({
      model: settings.imageModel,
      messages: [{ role: "user", content: prompt }],
      modalities: ["image"],
      image_config: { aspect_ratio: "1:1", image_size: "1K" },
    }),
    signal: AbortSignal.timeout(settings.imageTimeout * 1_000),
  });
  if (!response.ok) throw new Error(`Image request failed with HTTP ${response.status}.`);
  const dataUrl = imageDataUrl(await response.json());
  if (!dataUrl) throw new Error("Image response did not contain a base64 data URL.");
  const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
  await writeFile(path.join(themeDirectory(theme), `character_${characterId}.png`), Buffer.from(encoded, "base64"));
}

const MAX_CUSTOM_IMAGE_BYTES = 15 * 1024 * 1024;
const allowedImageTypes = new Map([
  ["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"], ["image/gif", "gif"],
]);

function imageExtension(contentType: string | null, fallback: string): string {
  return allowedImageTypes.get(contentType?.split(";", 1)[0].toLowerCase() ?? "") ?? fallback;
}

export async function saveCustomImages(
  theme: string,
  sources: Array<{ data: Buffer; contentType: string | null; extension?: string }>,
): Promise<string[]> {
  if (sources.length !== NUM_CHARACTERS) throw new Error(`Exactly ${NUM_CHARACTERS} images are required.`);
  const directory = themeDirectory(theme);
  await mkdir(directory, { recursive: true });
  const filenames: string[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    if (source.data.length === 0 || source.data.length > MAX_CUSTOM_IMAGE_BYTES) {
      throw new Error("Each image must be between 1 byte and 15 MB.");
    }
    const extension = imageExtension(source.contentType, source.extension ?? "jpg");
    const filename = `character_${index + 1}.${extension}`;
    await writeFile(path.join(directory, filename), source.data);
    filenames.push(filename);
  }
  return filenames;
}

export async function downloadCustomImages(theme: string, urls: string[]): Promise<string[]> {
  if (urls.length !== NUM_CHARACTERS) throw new Error(`Exactly ${NUM_CHARACTERS} image URLs are required.`);
  const sources = [];
  for (const rawUrl of urls) {
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new Error("Each image URL must be valid."); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Image URLs must use HTTP or HTTPS.");
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Could not download image (HTTP ${response.status}).`);
    const contentType = response.headers.get("content-type");
    if (!allowedImageTypes.has(contentType?.split(";", 1)[0].toLowerCase() ?? "")) throw new Error("Downloaded files must be PNG, JPEG, WebP, or GIF images.");
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_CUSTOM_IMAGE_BYTES) throw new Error("Each image must not exceed 15 MB.");
    const data = Buffer.from(await response.arrayBuffer());
    sources.push({ data, contentType });
  }
  return saveCustomImages(theme, sources);
}

export async function generateSessionImages(session: GameSession): Promise<void> {
  session.phase = "image-generation";
  session.generation = { completed: 0, total: NUM_CHARACTERS, message: "Starting image generation..." };
  try {
    for (const character of session.characters) {
      session.generation.message = `Generating image ${character.id} of ${NUM_CHARACTERS}...`;
      await generateImage(session.backendSettings, character.prompt, session.theme!, character.id);
      session.generation.completed = character.id;
    }
    session.generation.message = "Image generation complete.";
    session.phase = "playing";
  } catch (error) {
    session.error = error instanceof Error ? error.message : "Image generation failed.";
    session.phase = "error";
  }
}
