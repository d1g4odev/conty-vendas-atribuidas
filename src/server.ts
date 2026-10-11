import { readFile } from "node:fs/promises";
import { buildApp } from "./app.ts";
import { creatorsSchema } from "./schemas.ts";

const creatorsFile = process.env.CREATORS_FILE ?? new URL("../data/creators.json", import.meta.url);
const creators = creatorsSchema.parse(JSON.parse(await readFile(creatorsFile, "utf8")));

const app = buildApp({ creators, logger: true });
await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? "0.0.0.0" });
