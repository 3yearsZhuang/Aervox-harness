import { buildApp, createDefaultVoiceProviders } from "./app.js";

const app = buildApp({ logger: true, voiceProviders: createDefaultVoiceProviders() });
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
