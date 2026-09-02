import { useEffect, useRef, useState, type FormEvent } from "react";

type Character = {
  id: number;
  traits: string[];
  imageUrl: string;
  eliminated: boolean;
};
type Session = {
  id: string;
  theme: string | null;
  phase: string;
  characters: Character[];
  playerCharacter: number | null;
  currentQuestion: string | null;
  currentAnswer: "yes" | "no" | null;
  questionHistory: Array<{
    question: string;
    answer: "yes" | "no";
    askedBy: "player" | "llm";
  }>;
  gameOverReason?: string | null;
  existingAssets?: boolean;
  error?: string | null;
  generation?: { completed: number; total: number; message: string };
};
type ExistingTheme = { theme: string; characterCount: number };
type BackendSettings = {
  llmEndpoint: string;
  llmModel: string;
  llmApiKey: string;
  llmTimeout: string;
  imageEndpoint: string;
  imageModel: string;
  imageApiKey: string;
  imageTimeout: string;
};

const emptySettings: BackendSettings = {
  llmEndpoint: "",
  llmModel: "",
  llmApiKey: "",
  llmTimeout: "",
  imageEndpoint: "",
  imageModel: "",
  imageApiKey: "",
  imageTimeout: "",
};
const settingsStorageKey = "guess-llama-backend-settings";

export function App() {
  const [theme, setTheme] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [llmBusy, setLlmBusy] = useState(false);
  const [existingThemes, setExistingThemes] = useState<ExistingTheme[]>([]);
  const [selectedExistingTheme, setSelectedExistingTheme] = useState<string | null>(null);
  const [settings, setSettings] = useState<BackendSettings>(emptySettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [zoomedCharacterId, setZoomedCharacterId] = useState<number | null>(null);
  const zoomButtonRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const lastZoomedCharacterId = useRef<number | null>(null);
  const [customItems, setCustomItems] = useState<string[]>([]);
  const [imageMode, setImageMode] = useState<"generated" | "files" | "urls">("generated");
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [imageUrls, setImageUrls] = useState("");

  useEffect(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(settingsStorageKey) ?? "null",
      ) as Partial<BackendSettings> | null;
      if (saved) setSettings({ ...emptySettings, ...saved });
    } catch {
      /* Ignore malformed browser state and use server defaults. */
    }
    fetch("/api/themes")
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((data: { themes: ExistingTheme[] }) =>
        setExistingThemes(data.themes),
      )
      .catch(() => setExistingThemes([]));
  }, []);

  useEffect(() => {
    if (!session || session.phase !== "image-generation") return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/games/${session.id}`);
      if (response.ok) setSession(await response.json());
    }, 1500);
    return () => window.clearInterval(timer);
  }, [session?.id, session?.phase]);

  useEffect(() => {
    if (zoomedCharacterId === null) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoomedCharacterId(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
    };
  }, [zoomedCharacterId]);

  useEffect(() => {
    if (zoomedCharacterId !== null) {
      lastZoomedCharacterId.current = zoomedCharacterId;
      return;
    }
    const characterId = lastZoomedCharacterId.current;
    if (characterId !== null) {
      window.requestAnimationFrame(() => zoomButtonRefs.current[characterId]?.focus());
      lastZoomedCharacterId.current = null;
    }
  }, [zoomedCharacterId]);

  async function startGame(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme, settings }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (selectedExistingTheme === theme) {
        const loadResponse = await fetch(`/api/games/${data.id}/load`, {
          method: "POST",
        });
        const loadedData = await loadResponse.json();
        if (!loadResponse.ok) throw new Error(loadedData.error);
        setSession(loadedData);
      } else {
        setSession(data);
      }
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to create game.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function reuseAssets() {
    if (!session) return;
    setBusy(true);
    const response = await fetch(`/api/games/${session.id}/load`, {
      method: "POST",
    });
    const data = await response.json();
    if (!response.ok) setError(data.error);
    else setSession(data);
    setBusy(false);
  }

  function openCustomItems() {
    setCustomItems(Array.from({ length: 8 }, () => ""));
    setImageMode("generated");
    setImageFiles([]);
    setImageUrls("");
  }

  async function generateSetup(askLlmToFill: boolean) {
    if (!session) return;
    setBusy(true);
    setError("");
    try {
       const customUrls = imageUrls.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
       const body = imageMode === "generated"
         ? JSON.stringify({ customItems: askLlmToFill ? customItems : customItems.map((item) => item.trim()) })
         : (() => {
           const form = new FormData();
             if (customItems.length > 0) form.set("customItems", JSON.stringify(askLlmToFill ? customItems : customItems.map((item) => item.trim())));
             if (imageMode === "urls") form.set("imageUrls", JSON.stringify(customUrls));
             else imageFiles.forEach((file) => form.append("images", file));
             return form;
           })();
       const response = await fetch(`/api/games/${session.id}/setup`, {
         method: "POST",
         ...(imageMode === "generated" ? { headers: { "Content-Type": "application/json" } } : {}),
         body,
      });
      const data = await response.json();
      if (!response.ok) setError(data.error ?? "Unable to prepare game.");
      else setSession(data);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to prepare game.");
    } finally {
      setBusy(false);
    }
  }

  async function askQuestion(event: FormEvent) {
    event.preventDefault();
    if (!session || !question.trim()) return;
    setAsking(true);
    setError("");
    try {
      const response = await fetch(`/api/games/${session.id}/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setSession(data);
      setQuestion("");
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to ask the LLM.",
      );
    } finally {
      setAsking(false);
    }
  }

  function toggleCharacter(id: number) {
    if (
      !session ||
      session.phase !== "playing" ||
      id === (session.playerCharacter ?? -1) + 1
    )
      return;
    setSession({
      ...session,
      characters: session.characters.map((character) =>
        character.id === id
          ? { ...character, eliminated: !character.eliminated }
          : character,
      ),
    });
  }

  async function startLlmRound() {
    if (!session) return;
    setLlmBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/games/${session.id}/llm-round`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eliminatedIds: session.characters
            .filter((character) => character.eliminated)
            .map((character) => character.id),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setSession(data);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to start the LLM round.",
      );
    } finally {
      setLlmBusy(false);
    }
  }

  async function answerLlm(answer: "yes" | "no") {
    if (!session) return;
    setLlmBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/games/${session.id}/llm-answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setSession(data);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to submit the answer.",
      );
    } finally {
      setLlmBusy(false);
    }
  }

  if (session?.phase === "player-wins" || session?.phase === "llm-wins")
    return (
      <main className="app-shell setup-screen">
        <header>
          <span className="eyebrow">GAME OVER / {session.theme}</span>
          <h1>{session.phase === "player-wins" ? "You win." : "LLM wins."}</h1>
        </header>
        <section className="setup-card">
          <span className="eyebrow">FINAL RESULT</span>
          <h2>{session.gameOverReason}</h2>
        </section>
      </main>
    );

  if (
    session?.phase === "playing" ||
    session?.phase === "llm-processing" ||
    session?.phase === "awaiting-player-answer"
  ) {
    const playerId = (session.playerCharacter ?? -1) + 1;
    const waiting = session.phase === "llm-processing";
    const zoomedCharacter = session.characters.find(
      (character) => character.id === zoomedCharacterId,
    );
    return (
      <main className="app-shell">
        <header>
          <span className="eyebrow">GUESS LLAMA / LIVE GAME</span>
          <h1>{session.theme}</h1>
        </header>
        <section className="game-layout">
          <div className="board">
            <div className="board-heading">
              <div>
                <span className="eyebrow">
                  {session.phase === "awaiting-player-answer"
                    ? "LLM TURN"
                    : "YOUR TURN"}
                </span>
                <h2>
                  {session.phase === "awaiting-player-answer"
                    ? "Answer the LLM's question."
                    : "Ask about the hidden character."}
                </h2>
                <p className="board-help">
                  {session.phase === "awaiting-player-answer"
                    ? "Your character is shown below. Answer yes or no so the LLM can narrow its board."
                    : "Ask a yes-or-no question, then cross out characters that no longer fit."}
                </p>
              </div>
              <span className="status-pill">
                {
                  session.characters.filter(
                    (character) => !character.eliminated,
                  ).length
                }{" "}
                IN PLAY
              </span>
            </div>
            <div className="character-grid">
              {session.characters.map((character) => (
                <article
                  className={`character-card${character.eliminated ? " eliminated" : ""}${character.id === playerId ? " own-character" : ""}`}
                  key={character.id}
                >
                  <button
                    className="character-card-action"
                    type="button"
                    onClick={() => toggleCharacter(character.id)}
                    aria-label={`Toggle Character ${character.id}`}
                  >
                    <div className="image-frame">
                      <img
                        src={character.imageUrl}
                        alt={`Character ${character.id}`}
                      />
                      <span className="card-number">
                        #{String(character.id).padStart(2, "0")}
                      </span>
                      {character.id === playerId && (
                        <span className="own-label">YOU</span>
                      )}
                      {character.eliminated && character.id !== playerId && (
                        <span className="crossed-out">OUT</span>
                      )}
                    </div>
                    <div className="card-copy">
                      <strong>Character {character.id}</strong>
                      {character.traits.length > 0 && (
                        <span>{character.traits.join(" / ")}</span>
                      )}
                    </div>
                  </button>
                  <button
                    className="zoom-control"
                    type="button"
                    ref={(element) => {
                      zoomButtonRefs.current[character.id] = element;
                    }}
                    onClick={() => setZoomedCharacterId(character.id)}
                    aria-label={`View Character ${character.id} image`}
                  >
                    View
                  </button>
                </article>
              ))}
            </div>
          </div>
          <aside className="question-panel">
            {session.phase === "awaiting-player-answer" ? (
              <>
                <span className="eyebrow">THE LLM ASKS</span>
                <h2>{session.currentQuestion}</h2>
                <p>
                  Your character is marked <strong>YOU</strong> on the board.
                  Answer the question:
                </p>
                <div className="answer-actions">
                  <button
                    type="button"
                    disabled={llmBusy}
                    onClick={() => answerLlm("yes")}
                  >
                    Yes <span>-&gt;</span>
                  </button>
                  <button
                    type="button"
                    disabled={llmBusy}
                    onClick={() => answerLlm("no")}
                  >
                    No <span>-&gt;</span>
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="eyebrow">QUESTION THE LLM</span>
                <h2>What do you want to know?</h2>
                <p>
                  The LLM is hiding one character. Ask about its appearance to
                  narrow the board.
                </p>
                <form onSubmit={askQuestion}>
                  <textarea
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    placeholder="Does it have small ears?"
                    maxLength={240}
                    disabled={waiting}
                  />
                  <button
                    type="submit"
                    disabled={asking || waiting || !question.trim()}
                  >
                    {asking ? "Waiting for answer..." : "Ask the LLM"}
                    <span>-&gt;</span>
                  </button>
                </form>
                <button
                  className="llm-round-button"
                  type="button"
                  onClick={startLlmRound}
                  disabled={llmBusy || waiting}
                >
                  {waiting ? "LLM is thinking..." : "Start LLM's turn"}
                  <span>-&gt;</span>
                </button>
              </>
            )}
            {error && <p className="error">{error}</p>}
            {session.questionHistory.length > 0 && (
              <div className="answer-log">
                <span className="eyebrow">ANSWER LOG</span>
                {session.questionHistory.map((item, index) => (
                  <div
                    className="answer-item"
                    key={`${item.question}-${index}`}
                  >
                    <span className={`answer-source ${item.askedBy}`}>
                      {item.askedBy === "llm" ? "LLM ASKED" : "YOU ASKED"}
                    </span>
                    <span className="answer-question">{item.question}</span>
                    <strong className={`answer-result ${item.answer}`}>
                      ANSWER: {item.answer.toUpperCase()}
                    </strong>
                  </div>
                ))}
              </div>
            )}
          </aside>
        </section>
        {zoomedCharacter && (
          <div
            className="character-preview-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setZoomedCharacterId(null);
            }}
          >
            <section
              className="character-preview-panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby="character-preview-title"
            >
              <div className="character-preview-heading">
                <div>
                  <span className="eyebrow">CHARACTER PREVIEW</span>
                  <h2 id="character-preview-title">
                    Character {zoomedCharacter.id}
                  </h2>
                </div>
                <button
                  type="button"
                  className="close-button"
                  onClick={() => setZoomedCharacterId(null)}
                  aria-label="Close character preview"
                >
                  x
                </button>
              </div>
              <img
                className="character-preview-image"
                src={zoomedCharacter.imageUrl}
                alt={`Character ${zoomedCharacter.id}`}
              />
              {zoomedCharacter.traits.length > 0 && (
                <p className="character-preview-traits">
                  {zoomedCharacter.traits.join(" / ")}
                </p>
              )}
            </section>
          </div>
        )}
      </main>
    );
  }

  if (session && session.phase !== "theme-selection")
    return (
      <main className="app-shell setup-screen">
        <header>
          <span className="eyebrow">SETUP / {session.theme}</span>
          <h1>
            Preparing
            <br />
            your cast.
          </h1>
        </header>
        <section className="setup-card">
          <span className="eyebrow">CURRENT STEP</span>
          {session.phase === "preparing" && customItems.length === 0 ? (
            <>
              <h2>Choose your images</h2>
              <p>
                {session.existingAssets
                  ? "This world already has generated character data."
                  : "Choose generated art or bring your own character images."}
              </p>
              {imageSourcePicker()}
              <div className="setup-actions">
                {session.existingAssets && (
                  <button type="button" onClick={reuseAssets} disabled={busy}>
                    Reuse saved cast
                  </button>
                )}
                {imageMode === "generated" ? (
                  <button type="button" onClick={openCustomItems} disabled={busy}>
                    Continue to character details <span>-&gt;</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void generateSetup(false)}
                    disabled={busy || (imageMode === "files" && imageFiles.length !== 24) || (imageMode === "urls" && imageUrls.split(/\r?\n/).map((url) => url.trim()).filter(Boolean).length !== 24)}
                  >
                    {busy
                      ? imageMode === "files"
                        ? "Uploading files..."
                        : "Downloading URLs..."
                      : imageMode === "files"
                        ? "Use these 24 files"
                        : "Use these 24 URLs"} <span>-&gt;</span>
                  </button>
                )}
              </div>
              {error && <p className="error">{error}</p>}
            </>
          ) : session.phase === "preparing" && customItems.length === 8 ? (
             <form className="custom-items-form" onSubmit={(event) => { event.preventDefault(); void generateSetup(false); }}>
              <span className="eyebrow">OPTIONAL CHARACTER DETAILS</span>
              <h2>Choose eight items.</h2>
              <p>
                Add visible accessories or features to guide the character images. Leave any blank and the LLM can invent the rest.
              </p>
              <div className="custom-items-grid">
                {customItems.map((item, index) => (
                  <label key={index}>
                    Item {index + 1}
                    <input
                      value={item}
                      maxLength={100}
                      placeholder={index === 0 ? "e.g. a striped scarf" : "Optional"}
                      onChange={(event) => setCustomItems((current) => current.map((value, itemIndex) => itemIndex === index ? event.target.value : value))}
                    />
                  </label>
                ))}
              </div>
              <div className="setup-actions">
                <button type="submit" disabled={busy || customItems.some((item) => !item.trim()) || (imageMode === "files" && imageFiles.length !== 24) || (imageMode === "urls" && imageUrls.split(/\r?\n/).map((url) => url.trim()).filter(Boolean).length !== 24)}>
                  Use these eight <span>-&gt;</span>
                </button>
                <button type="button" onClick={() => void generateSetup(true)} disabled={busy || customItems.every((item) => item.trim())}>
                  {busy ? "Asking the LLM..." : "Fill missing items with LLM"} <span>-&gt;</span>
                </button>
              </div>
              {error && <p className="error">{error}</p>}
            </form>
          ) : (
            <>
              <h2>
                {session.phase === "error"
                  ? "Something went wrong"
                  : "Preparing your cast"}
              </h2>
              <p>{session.error ?? "The LLM is preparing your characters."}</p>
              {session.phase === "image-generation" && (
                <>
                  <div className="progress-track">
                    <span
                      style={{
                        width: `${((session.generation?.completed ?? 0) / (session.generation?.total || 24)) * 100}%`,
                      }}
                    />
                  </div>
                  <small>{session.generation?.message}</small>
                </>
              )}
            </>
          )}
        </section>
      </main>
    );
  const updateSetting = (key: keyof BackendSettings, value: string) =>
    setSettings((current) => ({ ...current, [key]: value }));
  function saveSettings() {
    localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
    setSettingsOpen(false);
  }
  function imageSourcePicker() {
    return (
      <div className="image-source-picker">
        <span className="eyebrow">CHARACTER IMAGES</span>
        <p>Choose how the 24 character images should be supplied.</p>
        <div className="image-source-actions">
          {(["generated", "files", "urls"] as const).map((mode) => (
            <button type="button" className={imageMode === mode ? "selected" : ""} key={mode} onClick={() => setImageMode(mode)}>
              {mode === "generated" ? "Generate images" : mode === "files" ? "Choose 24 files" : "Choose 24 URLs"}
            </button>
          ))}
        </div>
        {imageMode === "files" && (
          <label className="file-picker">
            Select image files in character order
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => setImageFiles(Array.from(event.target.files ?? []))} />
            <small>{imageFiles.length} of 24 selected</small>
          </label>
        )}
        {imageMode === "urls" && (
          <label>
            Image URLs, one per line
            <textarea value={imageUrls} onChange={(event) => setImageUrls(event.target.value)} placeholder="https://example.com/character-01.jpg" rows={6} />
            <small>{imageUrls.split(/\r?\n/).map((url) => url.trim()).filter(Boolean).length} of 24 URLs entered</small>
          </label>
        )}
      </div>
    );
  }
  return (
    <main className="landing">
      <button
        className="settings-button"
        type="button"
        onClick={() => setSettingsOpen(true)}
      >
        Settings <span>+</span>
      </button>
      <div className="hero-copy">
        <span className="eyebrow">AN AI-POWERED GUESSING GAME</span>
        <h1>
          Guess
          <br />
          <em>LLaMa</em>
        </h1>
        <p>
          Build a cast of strange characters, then narrow the field one
          yes-or-no question at a time.
        </p>
      </div>
      <div className="landing-content">
        <form className="theme-panel" onSubmit={startGame}>
          <label htmlFor="theme">Choose a world</label>
          <input
            id="theme"
            value={theme}
            onChange={(event) => {
              setTheme(event.target.value);
              setSelectedExistingTheme(null);
            }}
            placeholder="e.g. deep sea creatures"
            maxLength={100}
            autoFocus
          />
          {existingThemes.length > 0 && (
            <div className="saved-worlds" aria-label="Saved worlds">
              <span className="eyebrow">SAVED WORLDS</span>
              <div className="saved-world-grid">
                {existingThemes.map((existing) => (
                  <button
                    className={selectedExistingTheme === existing.theme ? "selected" : ""}
                    type="button"
                    key={existing.theme}
                    onClick={() => {
                      setTheme(existing.theme);
                      setSelectedExistingTheme(existing.theme);
                    }}
                  >
                    <strong>{existing.theme}</strong>
                    <span>{existing.characterCount}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <button disabled={busy || !theme.trim()}>
            {busy
              ? "Opening game..."
              : selectedExistingTheme === theme
                ? `Play ${theme}`
                : "Create game"}
            <span>-&gt;</span>
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      </div>
      <footer>
        <span>24 CHARACTERS</span>
        <span>VISION LLM</span>
        <span>GENERATIVE ART</span>
      </footer>
      {settingsOpen && (
        <div
          className="settings-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
          }}
        >
          <section
            className="settings-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="settings-heading">
              <div>
                <span className="eyebrow">CONNECTIONS</span>
                <h2 id="settings-title">Backend settings</h2>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={() => setSettingsOpen(false)}
                aria-label="Close settings"
              >
                x
              </button>
            </div>
            <p className="settings-help">
              These browser settings take priority over `.env`. Leave a field
              blank to use the server default.
            </p>
            <fieldset>
              <legend>LLM backend</legend>
              <label>
                Endpoint
                <input
                  value={settings.llmEndpoint}
                  onChange={(event) =>
                    updateSetting("llmEndpoint", event.target.value)
                  }
                  placeholder="http://localhost:9090"
                />
              </label>
              <label>
                Model
                <input
                  value={settings.llmModel}
                  onChange={(event) =>
                    updateSetting("llmModel", event.target.value)
                  }
                  placeholder="qwen3.5"
                />
              </label>
              <label>
                API key
                <input
                  type="password"
                  value={settings.llmApiKey}
                  onChange={(event) =>
                    updateSetting("llmApiKey", event.target.value)
                  }
                  placeholder="Optional"
                  autoComplete="off"
                />
              </label>
              <label>
                Request timeout (seconds)
                <input
                  type="number"
                  min="1"
                  max="86400"
                  value={settings.llmTimeout}
                  onChange={(event) =>
                    updateSetting("llmTimeout", event.target.value)
                  }
                  placeholder="14400"
                />
              </label>
            </fieldset>
            <fieldset>
              <legend>Image backend</legend>
              <label>
                Endpoint
                <input
                  value={settings.imageEndpoint}
                  onChange={(event) =>
                    updateSetting("imageEndpoint", event.target.value)
                  }
                  placeholder="https://openrouter.ai/api"
                />
              </label>
              <label>
                Model
                <input
                  value={settings.imageModel}
                  onChange={(event) =>
                    updateSetting("imageModel", event.target.value)
                  }
                  placeholder="black-forest-labs/flux.2-klein-4b"
                />
              </label>
              <label>
                API key
                <input
                  type="password"
                  value={settings.imageApiKey}
                  onChange={(event) =>
                    updateSetting("imageApiKey", event.target.value)
                  }
                  placeholder="Optional, falls back to LLM key"
                  autoComplete="off"
                />
              </label>
              <label>
                Generation timeout (seconds)
                <input
                  type="number"
                  min="1"
                  max="86400"
                  value={settings.imageTimeout}
                  onChange={(event) =>
                    updateSetting("imageTimeout", event.target.value)
                  }
                  placeholder="900"
                />
              </label>
            </fieldset>
            <div className="settings-actions">
              <button
                type="button"
                onClick={() => {
                  setSettings(emptySettings);
                  localStorage.removeItem(settingsStorageKey);
                }}
              >
                Clear
              </button>
              <button type="button" onClick={saveSettings}>
                Save settings <span>-&gt;</span>
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
