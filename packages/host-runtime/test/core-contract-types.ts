/** Host-owned compatibility proof for the independently versioned Core (ADR-021). */
import type {
  AskUserQuestionAnswerItem as ContractsAnswerItem,
  AskUserQuestionIntent as ContractsIntent,
  AskUserQuestionItem as ContractsItem,
  AskUserQuestionOption as ContractsOption,
} from '@aervox/contracts';
import type {
  AskUserQuestionAnswerItem,
  AskUserQuestionIntent,
  AskUserQuestionItem,
  AskUserQuestionOption,
} from '@aervox/core';

type Assert<T extends true> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;

// Wire defaults may narrow the host's payload; Core must still consume every value.
export type QuestionItemCompatible = Assert<Assignable<ContractsItem, AskUserQuestionItem>>;
export type QuestionOptionCompatible = Assert<Assignable<ContractsOption, AskUserQuestionOption>>;
export type QuestionIntentCompatible = Assert<Assignable<ContractsIntent, AskUserQuestionIntent>>;
export type AnswerItemCompatible = Assert<Assignable<ContractsAnswerItem, AskUserQuestionAnswerItem>>;
export type AnswerItemReverseCompatible = Assert<Assignable<AskUserQuestionAnswerItem, ContractsAnswerItem>>;
export type QuestionArrayCompatible = Assert<Assignable<ContractsItem[], AskUserQuestionItem[]>>;
export type AnswerArrayCompatible = Assert<Assignable<ContractsAnswerItem[], AskUserQuestionAnswerItem[]>>;
