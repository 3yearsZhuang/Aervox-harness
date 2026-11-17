import { expect, it } from "vitest";
import { buildOpenApiDocument } from "../src/index.js";

it("describes local question fields in the shared practice OpenAPI components", () => {
  const schemas = buildOpenApiDocument().components!.schemas!;
  const question = schemas.PracticeQuestion!;
  expect(question).not.toHaveProperty("$ref");
  if ("$ref" in question) throw new Error("PracticeQuestion must be a concrete component");
  expect(question.required).toEqual(["id", "prompt", "status", "createdAt", "updatedAt"]);
  expect(Object.keys(question.properties!)).toEqual(["id", "sourceArtifactId", "knowledgeId", "prompt", "answerSpec", "status", "createdAt", "updatedAt"]);
  for (const name of ["CreatePracticeSessionResponse", "PracticeSessionResumeResponse"]) {
    const session = schemas[name]!;
    expect(session).toHaveProperty("properties.items.items.properties", question.properties);
    expect(session).toHaveProperty("properties.items.items.required", question.required);
  }
});
