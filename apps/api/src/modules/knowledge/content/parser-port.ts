/**
 * Aervox｜思隅 @aervox/api — 多模态内容与 OCR 解析 Provider Port (CAP-012/025)
 *
 * 规范化图像、试卷与文档的解析/OCR 扩展接口，替代硬编码桩逻辑。
 */
import type { LocalContext, AttachmentModel } from "@aervox/repositories";
import { OCR_CONFIDENCE_THRESHOLD } from "@aervox/contracts";

export interface ParseContentRequest {
  attachment: AttachmentModel;
  filePath?: string;
  buffer?: Buffer;
}

export interface ParseContentResult {
  text: string;
  confidence: number; // 0.0 - 1.0
  metadata?: Record<string, unknown>;
}

export interface ContentParserPort {
  readonly id: string;
  readonly name: string;
  readonly supportedMediaTypes: string[];

  supports(mediaType: string): boolean;
  parse(tenant: LocalContext, request: ParseContentRequest): Promise<ParseContentResult>;
}

/** 默认离线 Mock OCR 解析器（基准与集成测试兜底） */
export class MockOcrParserProvider implements ContentParserPort {
  readonly id = "ocr.mock";
  readonly name = "Mock OCR Parser";
  readonly supportedMediaTypes = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "application/pdf",
  ];

  supports(mediaType: string): boolean {
    return this.supportedMediaTypes.includes(mediaType);
  }

  async parse(_tenant: LocalContext, _request: ParseContentRequest): Promise<ParseContentResult> {
    const confidence = 0.5 + Math.random() * 0.45;
    const text = confidence >= OCR_CONFIDENCE_THRESHOLD
      ? "1. 已知函数 f(x) = 2x + 3，求 f(5) 的值。\n2. 解方程：3x - 7 = 14。"
      : "[解析置信度低，内容可能不完整]";
    return {
      text,
      confidence: Math.round(confidence * 100) / 100,
      metadata: { engine: "mock" },
    };
  }
}

/** 注册与解析调度器 */
export class ContentParserRegistry {
  private readonly parsers = new Map<string, ContentParserPort>();
  private defaultParserId?: string;

  constructor(initialParsers: ContentParserPort[] = [new MockOcrParserProvider()]) {
    for (const parser of initialParsers) {
      this.register(parser);
    }
  }

  register(parser: ContentParserPort, isDefault = false): void {
    this.parsers.set(parser.id, parser);
    if (isDefault || !this.defaultParserId) {
      this.defaultParserId = parser.id;
    }
  }

  getParser(id: string): ContentParserPort | undefined {
    return this.parsers.get(id);
  }

  findParserForMediaType(mediaType: string): ContentParserPort | undefined {
    for (const parser of this.parsers.values()) {
      if (parser.supports(mediaType)) {
        return parser;
      }
    }
    return this.defaultParserId ? this.parsers.get(this.defaultParserId) : undefined;
  }

  listParsers(): ContentParserPort[] {
    return [...this.parsers.values()];
  }
}
