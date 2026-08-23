/**
 * 生成 openapi.json 到包根目录（供 CI/外部工具消费）。
 * 直接消费 tsc 编译产物 dist/openapi.js，避免 .js→.ts 解析问题与 tsx 的 zod 双实例问题。
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openApiDocument } from "../dist/openapi.js";

const out = fileURLToPath(new URL("../openapi.json", import.meta.url));
writeFileSync(out, `${JSON.stringify(openApiDocument, null, 2)}\n`, "utf8");
console.log(`[contracts] wrote ${out}`);
