# Guess Llama

<img width="1905" height="1489" alt="Screenshot" src="https://github.com/user-attachments/assets/8eed8b2d-29bc-4d8e-aa9d-d58630ab4074" />



Guess Llama is a web-based guessing game inspired by Guess Who. It uses a
Node.js server and a React/Vite browser client. The server manages game
sessions, stores game assets, and communicates with configurable
OpenAI-compatible language-model and image-generation endpoints.

Provider credentials entered in the browser are used only for the associated
game session and are not included in public game responses. Do not commit API
keys or other secrets to the repository.

## Requirements

- Node.js with npm
- An OpenAI-compatible language-model endpoint
- An image-generation endpoint that supports the image request format used by
  the application, when generated character art is desired

The application can also use a local set of 24 images instead of generating
art.

## Development

Install dependencies and start the development server:

```bash
npm install
npm run dev
```

Open the client at `http://localhost:5173`. The API server listens on
`http://localhost:3000`, and the Vite development server proxies `/api`
requests to it.

## Configuration

Copy `.env.example` to `.env.local` and fill in the endpoint, model, and API
key values appropriate for your language-model and image-generation services.
Keep `.env.local` private; it is excluded from version control.

The available environment variables are:

```dotenv
GUESS_LLAMA_LLM_SERVER=
GUESS_LLAMA_LLM_API_KEY=
GUESS_LLAMA_LLM_MODEL=
GUESS_LLAMA_LLM_TIMEOUT=
GUESS_LLAMA_IMAGE_SERVER_URL=
GUESS_LLAMA_IMAGE_SERVER_MODEL=
GUESS_LLAMA_IMAGE_SERVER_API_KEY=
GUESS_LLAMA_IMAGE_TIMEOUT=
```

The landing page's **Settings** option can configure the same language-model
and image-generation settings for a particular browser. Browser settings are
stored in local storage and take priority over environment variables when a
new game is created. Leaving a setting blank uses the corresponding server
configuration.

The default request timeouts are four hours for language-model requests and
15 minutes for image generation. Timeout values are specified in seconds.

## Custom Domain

For local-network testing or a custom development hostname, configure the
hostname to resolve to the machine running the application. This can be done
through local DNS, a router, or an entry in the client machine's hosts file.

Add the hostname to `server.allowedHosts` in `vite.config.ts`:

```ts
server: {
  host: "0.0.0.0",
  allowedHosts: ["your-hostname.example"],
  proxy: {
    "/api": "http://localhost:3000",
  },
},
```

Then open the client using the configured hostname and Vite port:

```text
http://your-hostname.example:5173
```

When exposing the application beyond a trusted local network, use HTTPS and
put the application behind a properly configured reverse proxy. Do not expose
API keys in client-side code or commit them to the repository.

## Images And Saved Games

During setup, choose one of the following image sources:

- Generated character art from the configured image endpoint.
- Exactly 24 PNG, JPEG, WebP, or GIF files uploaded from the browser.
- Exactly 24 HTTP(S) image URLs downloaded by the server.

Generated images and saved game data are stored under:

```text
images/<theme>/
```

Compatible `game_data.json` files can be reused for existing themes. The
application creates the `images/` directory automatically when it starts.

## Checks And Build

Run the type checks:

```bash
npm run check
```

Build the server and browser client:

```bash
npm run build
```

The development command runs both the API and Vite client. `npm start` runs
the compiled Node.js API server after a build; deploy the compiled client
through a web server or configure the hosting environment to serve the Vite
output as appropriate.

## Project Layout

```text
server/       Node.js API, sessions, storage, and backend integrations
client/       React/Vite browser client
images/       Generated or user-provided game assets
```
