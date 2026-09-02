import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Character } from "./types.js";

export type SavedGameData = {
  theme: string;
  features: string[];
  characters: Array<{ id: number; traits: string[]; prompt: string; imageFilename?: string }>;
};

export type ExistingTheme = {
  theme: string;
  characterCount: number;
};

export const imagesRoot = path.resolve(process.env.GUESS_LLAMA_IMAGES_DIR ?? "images");

export function formatThemeName(theme: string): string {
  return theme
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/ +/g, "_");
}

export function themeDirectory(theme: string): string {
  return path.join(imagesRoot, formatThemeName(theme));
}

export function imageUrl(theme: string, filename: string): string {
  return `/api/themes/${encodeURIComponent(formatThemeName(theme))}/${encodeURIComponent(filename)}`;
}

export async function loadSavedGame(theme: string): Promise<SavedGameData | null> {
  const filename = path.join(themeDirectory(theme), "game_data.json");
  try {
    const raw = JSON.parse(await readFile(filename, "utf8")) as SavedGameData;
    if (!raw.theme || !Array.isArray(raw.features) || !Array.isArray(raw.characters)) return null;
    if (raw.characters.length !== 24) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function hasThemeAssets(theme: string): Promise<boolean> {
  try {
    const entries = await readdir(themeDirectory(theme));
    return entries.includes("game_data.json") || entries.some((entry) => entry.endsWith(".png"));
  } catch {
    return false;
  }
}

export async function listExistingThemes(): Promise<ExistingTheme[]> {
  try {
    const entries = await readdir(imagesRoot, { withFileTypes: true });
    const themes = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const saved = await loadSavedGame(entry.name);
          return saved ? { theme: saved.theme, characterCount: saved.characters.length } : null;
        }),
    );
    return themes.filter((theme): theme is ExistingTheme => theme !== null).sort((a, b) => a.theme.localeCompare(b.theme));
  } catch {
    return [];
  }
}

export async function imageExists(theme: string, characterId: number): Promise<boolean> {
  try {
    await stat(path.join(themeDirectory(theme), `character_${characterId}.png`));
    return true;
  } catch {
    return false;
  }
}

export function savedCharactersToCharacters(theme: string, characters: SavedGameData["characters"]): Character[] {
  return characters.map((character) => ({
    ...character,
    imageFilename: character.imageFilename ?? `character_${character.id}.png`,
    imageUrl: imageUrl(theme, character.imageFilename ?? `character_${character.id}.png`),
    eliminated: false,
  }));
}

export async function ensureImagesRoot(): Promise<void> {
  await mkdir(imagesRoot, { recursive: true });
}

export async function saveGameData(theme: string, features: string[], characters: Character[]): Promise<void> {
  const directory = themeDirectory(theme);
  await mkdir(directory, { recursive: true });
  const data: SavedGameData = {
    theme,
    features,
    characters: characters.map(({ id, traits, prompt, imageFilename }) => ({ id, traits, prompt, imageFilename })),
  };
  await writeFile(path.join(directory, "game_data.json"), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
