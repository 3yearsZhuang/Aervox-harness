import { describe, expect, it } from "vitest";
import {
  ContentParserRegistry,
  MockOcrParserProvider,
  type ContentParserPort,
  type ParseContentRequest,
  type ParseContentResult,
} from "@aervox/host-runtime-test/modules/knowledge/content/parser-port";

describe("Content Parser SPI (CAP-012/025)", () => {
  it("routes parsing to custom registered parser based on supported media types", async () => {
    const registry = new ContentParserRegistry();

    expect(registry.listParsers()).toEqual([]);
    expect(registry.getParser("ocr.mock")).toBeUndefined();
    expect(registry.findParserForMediaType("image/png")).toBeUndefined();
    // Mock use is an explicit isolated test input, never a production fallback.
    registry.register(new MockOcrParserProvider());

    // Register a custom parser (e.g., custom formula/LaTeX parser)
    let customParseInvoked = false;
    const customMathParser: ContentParserPort = {
      id: "parser.custom-latex",
      name: "Custom LaTeX Formula OCR",
      supportedMediaTypes: ["image/x-formula", "application/x-latex"],
      supports(mediaType) {
        return this.supportedMediaTypes.includes(mediaType);
      },
      async parse(_tenant, request: ParseContentRequest): Promise<ParseContentResult> {
        customParseInvoked = true;
        return {
          text: "\\int_0^1 x^2 dx = \\frac{1}{3}",
          confidence: 0.99,
          metadata: { engine: "custom-latex", objectKey: request.attachment.objectKey },
        };
      },
    };

    registry.register(customMathParser);
    expect(registry.getParser("parser.custom-latex")).toBe(customMathParser);

    // Finding parser for formula returns custom parser
    const resolved = registry.findParserForMediaType("image/x-formula");
    expect(resolved).toBe(customMathParser);

    const dummyAttachment = {
      id: "att_test",
      objectKey: "test.png",
      mediaType: "image/x-formula",
      size: 1024,
      scanStatus: "clean" as const,
      sourceLicense: "CC0",
      purpose: "question" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await resolved!.parse(
      { workspaceId: "local", subjectUserId: "local" },
      { attachment: dummyAttachment },
    );

    expect(customParseInvoked).toBe(true);
    expect(result.text).toBe("\\int_0^1 x^2 dx = \\frac{1}{3}");
    expect(result.confidence).toBe(0.99);

    // Standard image/jpeg still routes to default mock parser
    const standardResolved = registry.findParserForMediaType("image/jpeg");
    expect(standardResolved?.id).toBe("ocr.mock");
    expect(registry.findParserForMediaType("text/plain")).toBeUndefined();
  });
});
