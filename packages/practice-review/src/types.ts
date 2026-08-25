export type KnowledgeItem = {
    id: string;
    name: string;

    correctCount: number;
    wrongCount: number;
    correctStreak: number;

    mastery: number;
};

export type ReviewItem = {
    knowledgeId: string;

    dueAt: Date;
    intervalDays: number;

    schedulerVersion: 1;
};
