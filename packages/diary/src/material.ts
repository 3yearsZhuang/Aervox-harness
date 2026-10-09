import type { DiaryMaterial } from "@aervox/contracts";
export type { DiaryMaterial, DiaryMaterialMessage, DiaryMaterialMemory, DiaryMaterialPort } from "@aervox/contracts";

/** 当日素材总数（打点/输出用） */
export function diaryMaterialCount(material: DiaryMaterial): number {
  return (
    material.messages.length +
    material.memories.length +
    material.goals.length +
    (material.attemptsToday.total > 0 ? 1 : 0)
  );
}
