import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAvatarManifest, AvatarBundle } from "../src/live2d/avatar-bundle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mizukiManifestPath = path.resolve(__dirname, "../../live2d/mizuki/avatar.manifest.json");

describe("AvatarBundle (虚拟形象包与语义动作映射)", () => {
  it("正确加载并校验 Mizuki 官方形象包 manifest", () => {
    const raw = JSON.parse(readFileSync(mizukiManifestPath, "utf-8"));
    const bundle = parseAvatarManifest(raw, "https://pet.local/live2d/mizuki/");

    expect(bundle.manifest.id).toBe("mizuki");
    expect(bundle.manifest.engine).toBe("live2d-v3");
    expect(bundle.entrypointUrl).toBe("https://pet.local/live2d/mizuki/mizuki.model3.json");

    // 校验语义动作映射
    const happyMotions = bundle.getMotions("happy");
    expect(happyMotions).toContain("w-cute-glad01");
    expect(bundle.pickMotion("happy")).toBeDefined();

    // 校验组合姿态
    const greetPoses = bundle.getPoses("greet");
    expect(greetPoses.length).toBeGreaterThan(0);
    expect(greetPoses[0].motion).toBe("w-normal-greeting01");
    expect(greetPoses[0].expression).toBe("face_wink_01");

    const pickedPose = bundle.pickPose("greet");
    expect(pickedPose).toBeDefined();
  });

  it("支持任意第三方自定义形象包（如 3D VRM 形象）声明与解析", () => {
    const vrmManifest = {
      schemaVersion: "1.0.0" as const,
      id: "custom-vrm-chan",
      name: "VRM Chan",
      version: "1.2.0",
      engine: "vrm-v1" as const,
      entrypoint: "avatar.vrm",
      semanticMotions: {
        greet: ["wave_hands_clip", "bow_clip"],
        happy: ["jump_celebrate_clip"],
      },
      poses: {
        greet: [{ motion: "wave_hands_clip", expression: "blink" }],
      },
    };

    const bundle = new AvatarBundle(vrmManifest, "https://models.local/vrm/");
    expect(bundle.manifest.engine).toBe("vrm-v1");
    expect(bundle.entrypointUrl).toBe("https://models.local/vrm/avatar.vrm");
    expect(bundle.getMotions("greet")).toEqual(["wave_hands_clip", "bow_clip"]);
    expect(bundle.pickMotion("happy")).toBe("jump_celebrate_clip");
  });
});
