import type { KnowledgeItem, ReviewItem } from "./types.js";

export function updateAfterAnswer(
    item: KnowledgeItem,
    isCorrect: boolean
) {
    if (isCorrect) {
        item.correctCount++;
        item.correctStreak++;
        item.mastery = Math.min(item.mastery + 0.1, 1);
    } else {
        item.wrongCount++;
        item.correctStreak = 0;
        item.mastery = Math.max(item.mastery - 0.1, 0);
    }
}

function getReviewIntervalDays(
    isCorrect: boolean,
    correctStreak: number
): number {
    if (!isCorrect) {
        return 1;
    }

    if(correctStreak === 0) {
        return 1;
    }

    if (correctStreak === 1) {
        return 2;
    }

    if (correctStreak === 2) {
        return 4;
    }

    if (correctStreak === 3) {
        return 8;
    }

    return 15;
}

export function createReviewItem(
    item: KnowledgeItem,
    isCorrect: boolean
): ReviewItem {
    const intervalDays = getReviewIntervalDays(
        isCorrect,
        item.correctStreak
    );

    const dueAt = new Date(
        Date.now() + intervalDays * 24 * 60 * 60 * 1000
    );

    return {
        knowledgeId: item.id,
        dueAt: dueAt,
        intervalDays: intervalDays,
        schedulerVersion: "mvp-v1"
    };
}