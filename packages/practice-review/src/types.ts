export type KnowledgeItem = {
    name: string;
    correctCount: number;
    wrongCount: number;
    correctStreak: number;
    mastery: number;
    nextReviewAt: Date;
};