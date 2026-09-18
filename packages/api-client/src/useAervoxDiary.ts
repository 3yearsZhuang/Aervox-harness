/**
 * Aervox｜思隅 @aervox/api-client — 日记 API 封装
 *
 * 每日按需生成/取回、按日期查询、历史回看列表；桌面与 Web 共用一份。
 */
import { getTransport } from './transport';
import type {
  Diary as DiaryDto,
  DiaryGenerateTodayOutput as GenerateTodayResultDto,
} from '@aervox/contracts';

export type { DiaryDto, GenerateTodayResultDto };


export function useAervoxDiary() {
  const transport = getTransport();

  /** 每日取回/生成：当日已有 → existing 幂等返回；无 → 生成新建；rewrite=true 时改写 */
  const generateToday = async (input: { rewrite?: boolean; focus?: string } = {}): Promise<GenerateTodayResultDto> => {
    return transport.request<GenerateTodayResultDto>('POST', '/v1/diaries/generate-today', {
      rewrite: input.rewrite,
      focus: input.focus,
    });
  };

  /** 按日期查询单篇日记（不存在时后端返回 404 → 抛错） */
  const getDiaryByDate = async (localDate: string): Promise<DiaryDto> => {
    return transport.request<DiaryDto>('GET', `/v1/diaries?localDate=${encodeURIComponent(localDate)}`);
  };

  /** 历史回看：按日期倒序返回最近 limit 篇 */
  const listDiaries = async (limit = 30): Promise<DiaryDto[]> => {
    const res = await transport.request<{ items: DiaryDto[] }>('GET', `/v1/diaries?limit=${limit}`);
    return res.items ?? [];
  };

  return { generateToday, getDiaryByDate, listDiaries };
}